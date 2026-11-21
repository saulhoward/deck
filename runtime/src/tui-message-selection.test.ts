import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { clientEnv } from "./client.test.env.js";
import { DraftStore } from "./drafts.js";
import { hubCommand } from "./hub-client.js";
import { TuiSession, validReply, validRequest } from "./tui-session.js";
import type { HistoryEntry, MessageContentPage, TuiRequest } from "./generated/contracts.js";

const binary = process.env.DECK_TEST_BINARY;
const selection = "SELECT MESSAGE";
const esc = "\x1b", previous = "\x10", next = "\x0e";
const wheelUp = "\x1b[<64;4;6M", wheelDown = "\x1b[<65;4;6M";
// SGR coordinates are one-based. Send reports in separate steps so a press,
// motion and release each cross the real parser/event loop, not one write.
const mouse = (button: number, x: number, y: number, release = false) => `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;
const user = (id: number, text: string): HistoryEntry => ({ id, kind: "deck.input", data: { text } });
const assistant = (id: number, text: string): HistoryEntry => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "text", text }] }] });
const hidden = (id: number): HistoryEntry => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }] }] });
const lines = (label: string, count: number) => Array.from({ length: count }, (_, i) => `${label} line ${String(i + 1).padStart(2, "0")}`).join("\n");

type Request = { command: string; args: Record<string, any> };
type Step = { keys: string } | { wait: string } | { capture: string } | { resize: [number, number] } | { sleep: number } | { checkpoint: string };
// Color runs are [start column, exclusive end, foreground, background]. Keeping
// attributes and the terminal cursor catches regressions a text-only capture misses.
type ColorRun = [number, number, string, string];
type AttributeRun = [number, number, boolean, boolean]; // start, exclusive end, bold, italic
type Screen = { text: string; colors: ColorRun[][]; attributes: AttributeRun[][]; cursor: { x: number; y: number; hidden: boolean } };
type Capture = { restored: boolean; output: string; screens: Record<string, Screen> };

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), "PTY checkpoint condition was not observed");
}

async function fixture(retained: HistoryEntry[], pageSize = 80, content = new Map<string, string>()) {
  const local = await clientEnv(), requests: Request[] = [], pages: MessageContentPage[] = [], failures: unknown[] = [];
  const checkpoints = new Map<string, () => void | Promise<void>>();
  const hooks: { forward?: () => Promise<void> } = {};
  const activity = { chatId: "1", busy: false, queued: 0, tools: [], omittedTools: 0, compactions: 0, compactionFailed: false };
  const progress = { version: 1, chatId: "1", provisional: true };
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET") {
        const check = checkpoints.get(decodeURIComponent(request.url!.slice(1)));
        assert.ok(check, `Unknown checkpoint ${request.url}`); await check(); response.end("ok"); return;
      }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const value = JSON.parse(Buffer.concat(chunks).toString()); requests.push(value);
      const { id, command, args } = value; let result;
      if (command === "status") result = { hubId: "tui-message-selection", hubGuard: 1, mainChatId: "1", chatId: "1", model: { provider: "mock", modelId: "echo" }, tools: "offline" };
      else if (command === "history") {
        assert.equal(args.chatId, "1");
        if (args.after !== undefined) await hooks.forward?.();
        const eligible = retained.filter(entry => (args.before === undefined || entry.id < Number(args.before)) && (args.after === undefined || entry.id > Number(args.after))).slice();
        if (args.after === undefined) eligible.reverse();
        const items = eligible.slice(0, Math.min(args.limit, pageSize));
        result = { items, ...(items.length < eligible.length ? { next: String(items.at(-1)!.id) } : {}), activity, progress };
      } else if (command === "activity") result = activity;
      else if (command === "progress") result = progress;
      else if (command === "admit") result = { submissionId: "9" };
      else if (command === "message_content") {
        assert.deepEqual(Object.keys(args).sort(), ["chatId", "entryId", "offset"]);
        assert.equal(args.chatId, "1"); assert.equal(typeof args.entryId, "string");
        const text = content.get(args.entryId); assert.notEqual(text, undefined, "Only an exact retained message may be exported");
        const bytes = Buffer.from(text!); assert.ok(bytes.length <= 16777216);
        assert.ok(Number.isSafeInteger(args.offset) && args.offset >= 0 && args.offset < bytes.length);
        let end = Math.min(bytes.length, args.offset + 32768);
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        const page: MessageContentPage = { chatId: "1", entryId: args.entryId, offset: args.offset, totalBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), text: bytes.subarray(args.offset, end).toString(), ...(end < bytes.length ? { next: end } : {}) };
        assert.ok(page.text.isWellFormed()); assert.ok(Buffer.byteLength(page.text) <= 32768);
        pages.push(page); result = page;
      } else assert.fail(`Unexpected command/effect: ${command}`);
      response.end(JSON.stringify({ version: 1, id, ok: true, result }));
    } catch (error) { failures.push(error); response.statusCode = 500; response.end("fixture failure"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { local, port: address.port, requests, pages, failures, checkpoints, hooks, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await local.close(); } };
}

// Reuse the real driver's synchronization, teardown and TTY-restoration checks.
// Extend ONLY its capture assignment in memory; do not change the shared driver
// (whose legacy text captures intentionally strip SGR). pyte needs semicolon SGR.
const captureDriver = String.raw`
import os, sys
path = sys.argv.pop(1)
sys.path.insert(0, os.path.dirname(path))
source = open(path, encoding="utf-8").read()
assignment = 'screens[step["capture"]] = rendered()'
assert source.count(assignment) == 1, "PTY driver capture contract changed"
def selection_capture():
    screen = SilentScreen(cols, rows)
    data = re.sub(rb"\x1b\[([0-9:;]*)m", lambda m: b"\x1b[" + m.group(1).replace(b"::", b":").replace(b":", b";") + b"m", committed_output(bytes(output)))
    pyte.ByteStream(screen).feed(data)
    colors, attributes = [], []
    for y in range(rows):
        runs, styles = [], []
        for x in range(cols):
            cell = screen.buffer[y][x]
            if runs and runs[-1][2:] == [cell.fg, cell.bg]:
                runs[-1][1] = x + 1
            else:
                runs.append([x, x + 1, cell.fg, cell.bg])
            if styles and styles[-1][2:] == [cell.bold, cell.italics]:
                styles[-1][1] = x + 1
            else:
                styles.append([x, x + 1, cell.bold, cell.italics])
        colors.append(runs)
        attributes.append(styles)
    return {"text": rendered(), "colors": colors, "attributes": attributes, "cursor": {"x": screen.cursor.x, "y": screen.cursor.y, "hidden": screen.cursor.hidden}}
exec(compile(source.replace(assignment, 'screens[step["capture"]] = selection_capture()'), path, "exec"))
`;

async function pty(f: Awaited<ReturnType<typeof fixture>>, steps: Step[], env: NodeJS.ProcessEnv = f.local.env): Promise<Capture> {
  const driver = fileURLToPath(new URL("../../scripts/tui-pty-test.py", import.meta.url));
  const child = spawn("python3", ["-c", captureDriver, driver, resolve(binary!), "agent", "--tui", "--port", String(f.port)], { env: { ...env, DECK_NODE: process.execPath, DECK_TEST_CHECKPOINT_PORT: String(f.port) } });
  const closed = once(child, "close"); let output = "", errors = "";
  child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { errors += String(chunk); });
  child.stdin.end(JSON.stringify(steps));
  try {
    assert.equal((await closed)[0], 0, errors);
    assert.deepEqual(f.failures, []);
    const result: Capture = JSON.parse(output); assert.equal(result.restored, true); return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await closed;
  }
}
function noOrangeFill(screen: Screen) {
  assert.ok(screen.colors.every(runs => runs.every(run => run[3] !== "ffc799")), "Selection must never paint an orange background");
}
function selected(screen: Screen, expected: RegExp) {
  assert.match(screen.text, /SELECT MESSAGE/); assert.equal(screen.cursor.hidden, true, "Selected history must hide the prompt cursor");
  noOrangeFill(screen);
  const rows = screen.text.split("\n");
  const highlighted = screen.colors.flatMap((runs, y) => runs[0]?.[2] === "ffc799" ? [y] : []);
  assert.ok(highlighted.length > 0, "Selection must have an orange left border, not just a mode label");
  assert.deepEqual(highlighted, Array.from({ length: highlighted.length }, (_, i) => highlighted[0]! + i), "Every owned row, including intervening blank rows, needs a border");
  assert.deepEqual(rows.flatMap((row, y) => row.startsWith("│") ? [y] : []), highlighted, "The border glyph and orange foreground must identify exactly the same rows");
  for (const y of highlighted) {
    const [border, ...content] = screen.colors[y]!;
    assert.deepEqual(border!.slice(0, 3), [0, 1, "ffc799"], `Row ${y} must have exactly one orange column at the left edge`);
    assert.equal(rows[y]![0], "│");
    assert.ok(content.every(run => run[2] !== "000000"), `Selected row ${y} must not have black foreground`);
    assert.ok(content.every(run => run[2] === "ffffff"), `Selected row ${y} text and speaker must stay white, not orange`);
  }
  assert.match(highlighted.map(y => rows[y]).join("\n"), expected);
  return highlighted;
}
function unselected(screen: Screen) {
  assert.doesNotMatch(screen.text, /SELECT MESSAGE/);
  assert.equal(screen.cursor.hidden, false, "Input cursor must return after selection ends");
  noOrangeFill(screen);
  assert.ok(screen.text.split("\n").every(row => !row.startsWith("│")), "No stale selection border glyphs");
  assert.ok(screen.colors.every(runs => runs[0]?.[2] !== "ffc799"), "No stale orange left border");
}
function chat(screen: Screen) {
  const rows = screen.text.split("\n"), rule = rows.findIndex(row => row.startsWith("─"));
  // Esc removes only the border. Preserve every other column and every row so
  // viewport/wrapping assertions still detect shifted or replaced content.
  assert.ok(rule > 0); return rows.slice(0, rule - 1).map(row => row.replace(/^│/, " "));
}
function sameChatPaint(before: Screen, after: Screen) {
  assert.deepEqual(chat(after), chat(before), "Selection must not change content coordinates or wrapping");
  const backgrounds = (screen: Screen) => screen.colors.slice(0, chat(screen).length).map(runs => runs.flatMap(([start, end, , background]) => Array<string>(end - start).fill(background)));
  assert.deepEqual(backgrounds(after), backgrounds(before), "Selection must preserve user blue, assistant base and Markdown code backgrounds in every column");
  assert.deepEqual(after.attributes.slice(0, chat(after).length), before.attributes.slice(0, chat(before).length), "Selection must preserve Markdown bold and italic attributes");
}
function readOnlyRequests(f: Awaited<ReturnType<typeof fixture>>, allowAdmit = false) {
  assert.ok(f.requests.every(request => ["status", "history", "activity", "progress", "message_content", ...(allowAdmit ? ["admit"] : [])].includes(request.command)), "Selection/viewing must never mutate a chat, task, draft or Rex allocation");
}

test("TUI adapter: full-message chunks are scoped transient replies, preserving historical cursor and exact saved draft even on invalid replies", async () => {
  const text = "retained multibyte 🧪 text\n".repeat(3000), retained = [user(7, text), assistant(21, "Latest answer")];
  const original = JSON.stringify(retained), f = await fixture(retained, 1, new Map([["7", text]]));
  try {
    const store = new DraftStore("tui-message-selection", f.local.env.DECK_CLIENT_STATE_DIRECTORY);
    const draft = { kind: "input" as const, chatId: "1", requestId: randomUUID(), text: "  exact saved draft 🧪\n  trailing  \n", mode: "steer" as const };
    await store.save(draft);
    const path = join(store.directory, `${draft.requestId}.json`), savedBytes = await readFile(path);
    let corruption: Partial<MessageContentPage> | undefined;
    const session = new TuiSession(async (command, args, expected) => {
      const result = await hubCommand(f.port, command, args, expected);
      return command === "message_content" && corruption ? { ...(result as MessageContentPage), ...corruption } : result;
    }, undefined, undefined, f.local.env.DECK_CLIENT_STATE_DIRECTORY);
    let id = 0;
    const act = (action: TuiRequest["action"], args: Partial<TuiRequest> = {}) => session.handle({ version: 1, id: String(++id), action, ...args });
    await act("poll");
    const before = await act("older"); assert.equal(before.historical, true); assert.equal(before.entries[0]!.id, 7);
    assert.equal(before.draft!.text, draft.text); assert.equal(before.draft!.saved, true);
    assert.ok(Buffer.byteLength(before.entries[0]!.text) <= 8192);
    let offset = 0, complete = "";
    for (;;) {
      const snapshot = await act("messageContent", { entryId: "7", offset });
      const { messageContent: page, ...viewport } = snapshot; assert.ok(page);
      assert.deepEqual(viewport, before, "Export must not replace the historical page, activity, notice or draft");
      assert.equal(f.requests.at(-1)!.command, "message_content"); assert.deepEqual(f.requests.at(-1)!.args, { chatId: "1", entryId: "7", offset });
      const reply = { version: 1, id: "reply", ok: true, snapshot };
      const valid = (entryId: string, expectedOffset: number, action: TuiRequest["action"] = "messageContent") => validReply(reply, "reply", "tui-message-selection", "1", action, undefined, undefined, "hub", "1", undefined, entryId, expectedOffset);
      assert.equal(valid("7", offset), true); assert.equal(valid("21", offset), false); assert.equal(valid("7", offset + 1), false); assert.equal(valid("7", offset, "poll"), false);
      complete += page.text;
      if (page.next === undefined) break;
      offset = page.next;
    }
    assert.equal(complete, text); assert.ok(f.pages.length >= 3);
    assert.deepEqual(await act("poll", { hold: true }), before, "Chunk data must not persist into ordinary snapshots");
    const exactRequest = { version: 1, id: "request", action: "messageContent", entryId: "7", offset: 0 };
    assert.equal(validRequest(exactRequest), true);
    for (const patch of [{ chatId: "2" }, { entryId: "0" }, { offset: -1 }, { text: "latest fallback" }]) assert.equal(validRequest({ ...exactRequest, ...patch }), false);
    for (const patch of [{ chatId: "2" }, { entryId: "21" }, { offset: 1 }, { next: 0 }, { totalBytes: 16777217 }, { sha256: "not-a-digest" }]) {
      corruption = patch;
      await assert.rejects(act("messageContent", { entryId: "7", offset: 0 }), /Invalid full-message content/);
      assert.deepEqual(await act("poll", { hold: true }), before, "Invalid content must not disturb the viewport or draft");
    }
    assert.deepEqual(await readFile(path), savedBytes); assert.deepEqual((await store.load(draft.requestId)).request, draft);
    assert.equal(JSON.stringify(retained), original); assert.deepEqual(f.failures, []); readOnlyRequests(f);
  } finally { await f.close(); }
});

test("real PTY: Ctrl-P only in Normal mode; selection borders owned rows with white text and unchanged backgrounds, layout and prompt", { skip: !binary, timeout: 25_000 }, async () => {
  const wrapped = "wrapped content ".repeat(8);
  const retained = [user(7, "FIRST retained user"), assistant(21, `SECOND **bold** answer\n\n${wrapped}\n\n- Markdown bullet\n- Other *italic* bullet\n\n\`\`\`ts\nconst answer = 42;\n\`\`\``), user(35, "THIRD newest message")];
  const original = JSON.stringify(retained), f = await fixture(retained);
  const prompt = "  Preserve exact draft 🧪\nsecond line  ";
  try {
    const { screens } = await pty(f, [
      { wait: "THIRD newest message" }, { keys: paste(prompt) }, { wait: "second line" },
      { keys: previous }, { capture: "insert" }, // Ctrl-P must not select while editing.
      { keys: esc }, { capture: "normal" }, { keys: previous }, { wait: selection }, { capture: "newest" },
      { keys: previous }, { capture: "answer" },
      { keys: "iXYZ\r\x13" }, { keys: paste("MUST_NOT_REPLACE_PROMPT") }, { capture: "ignored" },
      { keys: next }, { capture: "backToNewest" }, { keys: next }, { sleep: 0.2 }, { capture: "input" },
      { keys: "A!" }, { keys: "\r" }, { wait: "Input admitted" }, { keys: esc }, { keys: ":q\r" },
    ]);
    unselected(screens.insert!); unselected(screens.normal!);
    const newestRows = selected(screens.newest!, /THIRD newest message/);
    const normalRows = chat(screens.normal!), newestText = normalRows.findIndex(row => row.includes("THIRD newest message"));
    assert.ok(newestText > 0);
    assert.deepEqual(newestRows, [newestText - 1, newestText, newestText + 1], "User top/bottom padding must have the same border as the text row, without selecting the following gap");
    for (const y of newestRows) assert.ok(screens.newest!.colors[y]!.every(run => run[3] === "182030"), "The entire selected user panel must retain its blue background");
    const rows = selected(screens.answer!, /SECOND bold answer/);
    const answerStart = normalRows.findIndex(row => row.includes("SECOND bold answer"));
    assert.ok(answerStart >= 0);
    assert.deepEqual(rows, Array.from({ length: newestText - 1 - answerStart }, (_, i) => answerStart + i), "All Markdown lines and owned spacing, including the final blank row, need borders");
    assert.match(rows.map(y => screens.answer!.text.split("\n")[y]).join("\n"), /Markdown bullet/);
    const codeRow = normalRows.findIndex(row => row.includes("const answer = 42;"));
    assert.ok(rows.includes(codeRow));
    assert.ok(screens.normal!.colors[codeRow]!.some(run => run[3] === "202020"), "Fixture must exercise a distinct Markdown code background");
    assert.ok(normalRows.filter(row => row.includes("wrapped content")).length >= 2, "Fixture must exercise wrapped message coordinates");
    for (const [word, attribute] of [["bold", 2], ["italic", 3]] as const) {
      const y = normalRows.findIndex(row => row.includes(word)), x = normalRows[y]!.indexOf(word);
      const run = screens.normal!.attributes[y]!.find(([start, end]) => start <= x && end >= x + word.length);
      assert.equal(run?.[attribute], true, `Fixture must render Markdown ${word} before selecting`);
    }
    for (const name of ["newest", "answer", "ignored", "backToNewest", "input"]) sameChatPaint(screens.normal!, screens[name]!);
    selected(screens.ignored!, /SECOND bold answer/); assert.doesNotMatch(screens.ignored!.text, /MUST_NOT_REPLACE_PROMPT|XYZ|Input admitted/);
    selected(screens.backToNewest!, /THIRD newest message/); unselected(screens.input!);
    assert.deepEqual(f.requests.filter(r => r.command === "admit").map(r => r.args.text), [prompt + "!"]);
    assert.equal(JSON.stringify(retained), original); readOnlyRequests(f, true);
  } finally { await f.close(); }
});

test("real PTY: mouse selects a retained message from Insert; resize and selected scrolling keep selection, Esc keeps viewport", { skip: !binary, timeout: 25_000 }, async () => {
  const f = await fixture([user(7, lines("FIRST", 16)), assistant(21, lines("SECOND", 16)), user(35, lines("THIRD", 16))]);
  const prompt = "mouse draft  ";
  try {
    const { screens } = await pty(f, [
      { wait: "THIRD line 16" }, { keys: prompt }, { keys: wheelUp.repeat(3) }, { wait: "Scrolled up" }, { capture: "ordinaryScroll" },
      { keys: "still editable" }, { wait: "mouse draft  still editable" }, { capture: "edited" },
      // Click the first visible retained row, including its left gutter. A
      // press alone must not hide/lock the editor or select a retained ID.
      { keys: mouse(0, 1, 1) }, { capture: "pressed" },
      { keys: mouse(0, 1, 1, true) }, { wait: selection }, { capture: "clicked" },
      { resize: [40, 90] }, { capture: "resized" }, { keys: wheelUp }, { capture: "selectedScroll" },
      { keys: esc }, { capture: "escaped" },
      { keys: "A!" }, { keys: "\r" }, { wait: "Input admitted" }, { keys: esc }, { keys: ":q\r" },
    ]);
    unselected(screens.ordinaryScroll!); unselected(screens.edited!); unselected(screens.pressed!);
    sameChatPaint(screens.edited!, screens.pressed!);
    assert.deepEqual(screens.pressed!.cursor, screens.edited!.cursor, "Press must leave the editable prompt cursor untouched");
    const clickedLabel = chat(screens.edited!)[0]!.match(/(FIRST|SECOND|THIRD) line/)?.[1];
    assert.ok(clickedLabel, "The click must hit a known retained message row");
    for (const name of ["clicked", "resized", "selectedScroll"]) {
      const highlighted = selected(screens[name]!, new RegExp(clickedLabel));
      const labels = highlighted.flatMap(y => screens[name]!.text.split("\n")[y]!.match(/(?:FIRST|SECOND|THIRD) line/g) ?? []);
      assert.ok(labels.every(label => label === `${clickedLabel} line`), "Selection must stay on the clicked canonical message, not its old screen coordinates");
    }
    assert.notDeepEqual(chat(screens.selectedScroll!), chat(screens.resized!), "Wheel scrolling still moves selected history");
    unselected(screens.escaped!); assert.deepEqual(chat(screens.escaped!), chat(screens.selectedScroll!), "Esc must not jump to the latest messages");
    assert.deepEqual(f.requests.filter(r => r.command === "admit").map(r => r.args.text), [prompt + "still editable!"]);
    readOnlyRequests(f, true);
  } finally { await f.close(); }
});

// These are application mouse reports, not a GUI clipboard test. Terminals can
// reserve modified drags (usually Shift-drag) for their native selection/copy.
for (const alreadySelected of [false, true]) test(`real PTY: cancelled content gestures preserve ${alreadySelected ? "another selected retained ID" : "the editable prompt without selecting history"}`, { skip: !binary, timeout: 30_000 }, async () => {
  // Leave one older page available: an accidental press-selection of TARGET
  // would also start a read, even if a later event removed its painted border.
  const retained = [hidden(3), assistant(7, "TARGET retained content to drag across"), user(21, "ANCHOR other retained message")];
  const original = JSON.stringify(retained), f = await fixture(retained, 2);
  const prompt = "  mouse gesture draft 🧪\nkeep trailing spaces  ";
  const older = () => f.requests.filter(r => r.command === "history" && r.args.before !== undefined);
  f.checkpoints.set("no-prefetch", () => {
    assert.deepEqual(older(), [], "Presses and cancelled gestures must not prefetch history");
    assert.equal(f.requests.filter(r => r.command === "message_content").length, 0);
  });
  f.checkpoints.set("completed-prefetch", async () => { await until(() => older().length === 1); });
  // At 100 columns the body begins at column 11 (one-based); row 1 is
  // TARGET's actual text, not its gutter, padding, or the prompt below.
  const press = mouse(0, 15, 1), release = mouse(0, 15, 1, true);
  const gestures: [string, string[]][] = [
    ["stray-release", [release]],
    ["drag-away", [press, mouse(32, 30, 1), mouse(0, 30, 1, true)]],
    ["drag-return", [press, mouse(32, 30, 1), mouse(32, 15, 1), release]],
    ["same-cell-motion", [press, mouse(32, 15, 1), release]],
    ["release-elsewhere", [press, mouse(0, 16, 1, true)]],
    ["release-in-prompt", [press, mouse(0, 15, 36, true), release]],
  ];
  for (const [modifier, bits] of [["shift", 4], ["alt", 8], ["ctrl", 16]] as const) {
    gestures.push([`${modifier}-press`, [mouse(bits, 15, 1), release]]);
    // An ignored modified release must also disarm the candidate; the next
    // unmodified release cannot resurrect it as a completed click.
    gestures.push([`${modifier}-release`, [press, mouse(bits, 15, 1, true), release]]);
  }
  try {
    const steps: Step[] = [{ wait: "ANCHOR other retained message" }, { keys: paste(prompt) }, { wait: "keep trailing spaces" }];
    if (alreadySelected) steps.push({ keys: esc }, { keys: previous }, { wait: selection });
    steps.push({ capture: "before" });
    const unchanged: string[] = [];
    for (const [name, reports] of gestures) for (const [i, keys] of reports.entries()) {
      const capture = `${name}-${i}`;
      // Never combine a gesture in one write: inspect press and motion states
      // as well as release, so temporary selection/prompt locking also fails.
      steps.push({ keys }, { capture }); unchanged.push(capture);
    }
    steps.push(
      { checkpoint: "no-prefetch" },
      { keys: press }, { capture: "completedPress" }, { checkpoint: "no-prefetch" },
      { keys: release }, { wait: selection }, { checkpoint: "completed-prefetch" }, { capture: "clicked" },
      { keys: esc }, { capture: "returned" },
      { keys: "A!" }, { keys: "\r" }, { wait: "Input admitted" }, { keys: esc }, { keys: ":q\r" },
    );
    unchanged.push("completedPress");
    const { screens } = await pty(f, steps);
    assert.equal(chat(screens.before!)[0]!.slice(10, 16), "TARGET", "Gesture coordinates must hit the retained message's content");
    const expectedRows = alreadySelected ? selected(screens.before!, /ANCHOR other retained message/) : undefined;
    if (!alreadySelected) unselected(screens.before!);
    for (const name of unchanged) {
      const screen = screens[name]!;
      if (alreadySelected) assert.deepEqual(selected(screen, /ANCHOR other retained message/), expectedRows, `${name} must preserve the previously selected entry, not select TARGET`);
      else {
        unselected(screen);
        assert.deepEqual(screen.cursor, screens.before!.cursor, `${name} must not move or hide the editable prompt cursor`);
      }
      sameChatPaint(screens.before!, screen);
      assert.match(screen.text, /mouse gesture draft 🧪/); assert.match(screen.text, /keep trailing spaces/);
    }
    selected(screens.clicked!, /TARGET retained content/); unselected(screens.returned!);
    assert.deepEqual(older().map(r => r.args.before), ["7"], "Only the completed click may prefetch the oldest message's preceding page");
    assert.deepEqual(f.requests.filter(r => r.command === "admit").map(r => r.args.text), [prompt + "!"]);
    assert.equal(JSON.stringify(retained), original); readOnlyRequests(f, true);
  } finally { await f.close(); }
});

test("real PTY: selecting oldest prefetches sparse canonical pages and Ctrl-P/N traverses cached messages without skipping IDs", { skip: !binary, timeout: 30_000 }, async () => {
  const retained = Array.from({ length: 16 }, (_, i) => hidden((i + 1) * 7));
  retained[0] = user(7, lines("ARCHIVE FIRST", 14)); retained[1] = assistant(14, lines("ARCHIVE SECOND", 14));
  retained[12] = user(91, lines("LIVE OLDEST", 12)); retained[14] = assistant(105, lines("LIVE MIDDLE", 10)); retained[15] = user(112, lines("LIVE NEWEST", 10));
  const original = JSON.stringify(retained), f = await fixture(retained, 4);
  const older = () => f.requests.filter(r => r.command === "history" && r.args.before !== undefined);
  f.checkpoints.set("prefetched", async () => { await until(() => older().length === 3); });
  f.checkpoints.set("no-extra-pages", () => { assert.deepEqual(older().map(r => r.args.before), ["91", "63", "35"]); });
  try {
    const { screens } = await pty(f, [
      { wait: "LIVE NEWEST line 10" }, { keys: "sparse draft" }, { keys: esc },
      { keys: previous }, { capture: "newest" }, { keys: previous }, { capture: "middle" },
      { keys: previous }, { checkpoint: "prefetched" }, { sleep: 0.15 }, { capture: "oldestPrefetched" },
      { keys: previous }, { wait: "ARCHIVE SECOND line" }, { capture: "archiveSecond" },
      { keys: previous }, { wait: "ARCHIVE FIRST line" }, { capture: "archiveFirst" },
      { keys: previous }, { resize: [40, 90] }, { sleep: 0.15 }, { checkpoint: "no-extra-pages" }, { capture: "atStart" },
      { keys: next }, { capture: "forwardSecond" }, { keys: next }, { capture: "forwardOldest" },
      { keys: next }, { capture: "forwardMiddle" }, { keys: next }, { capture: "forwardNewest" },
      { keys: next }, { sleep: 0.2 }, { capture: "input" }, { keys: "A!" }, { keys: "\r" }, { wait: "Input admitted" }, { keys: esc }, { keys: ":q\r" },
    ]);
    for (const [name, label] of Object.entries({ newest: "LIVE NEWEST", middle: "LIVE MIDDLE", oldestPrefetched: "LIVE OLDEST", archiveSecond: "ARCHIVE SECOND", archiveFirst: "ARCHIVE FIRST", atStart: "ARCHIVE FIRST", forwardSecond: "ARCHIVE SECOND", forwardOldest: "LIVE OLDEST", forwardMiddle: "LIVE MIDDLE", forwardNewest: "LIVE NEWEST" })) selected(screens[name]!, new RegExp(label));
    unselected(screens.input!); assert.deepEqual(chat(screens.input!), chat(screens.forwardNewest!));
    assert.deepEqual(older().map(r => r.args.before), ["91", "63", "35"]);
    assert.deepEqual(f.requests.filter(r => r.command === "admit").map(r => r.args.text), ["sparse draft!"]);
    assert.equal(JSON.stringify(retained), original); assert.doesNotMatch(JSON.stringify(screens), /PRIVATE_REASONING/); readOnlyRequests(f, true);
  } finally { await f.close(); }
});

for (const key of ["v", "l"] as const) test(`real PTY: selected ${key} reads the full multi-chunk message before missing-viewer error; redraw never retries or edits prompt`, { skip: !binary, timeout: 30_000 }, async () => {
  const text = "Full preview row 🧪\n".repeat(4000) + "END_FULL_ONLY_NOT_IN_PREVIEW";
  const retained = [user(7, "Earlier retained input"), assistant(21, text)];
  const original = JSON.stringify(retained), f = await fixture(retained, 80, new Map([["21", text]]));
  const prompt = "  viewer draft 🧪\nkeep trailing spaces  ";
  try {
    // Never discover a real nvim, Leaf or Rex executable from the developer's PATH.
    // Keep only the dependencies used by the actual PTY/client bridge.
    const bin = join(f.local.env.DECK_CLIENT_STATE_DIRECTORY!, "bin"); await mkdir(bin);
    const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }); assert.equal(python.status, 0, python.stderr);
    await symlink(python.stdout.trim(), join(bin, "python3")); await symlink(process.execPath, join(bin, "node")); await symlink(resolve(binary!), join(bin, "deck"));
    const exports = join(f.local.env.DECK_CLIENT_STATE_DIRECTORY!, "exports"); await mkdir(exports);
    const env: NodeJS.ProcessEnv = { ...f.local.env, PATH: bin, TMPDIR: exports };
    delete env.EDITOR; delete env.REX_SESSION; delete env.REX_BLOCK; delete env.REX_SERVER;
    let completedRequests = 0;
    f.checkpoints.set("downloaded", () => {
      completedRequests = f.requests.filter(r => r.command === "message_content").length;
      assert.ok(completedRequests >= 3); assert.equal(f.pages.map(p => p.text).join(""), text);
    });
    f.checkpoints.set("no-retry", () => { assert.equal(f.requests.filter(r => r.command === "message_content").length, completedRequests); });
    const error = key === "v" ? "nvim is unavailable on PATH" : "Leaf is unavailable on PATH";
    const result = await pty(f, [
      { wait: "Full preview row" }, { keys: paste(prompt) }, { keys: esc }, { keys: previous }, { wait: selection }, { capture: "selected" },
      { keys: key }, { wait: error }, { checkpoint: "downloaded" }, { capture: "error" },
      { resize: [40, 90] }, { keys: wheelUp }, { keys: wheelDown }, { sleep: 1.2 }, { checkpoint: "no-retry" }, { capture: "redrawn" },
      { keys: esc }, { capture: "input" }, { keys: "A!" }, { keys: "\r" }, { wait: "Input admitted" }, { keys: esc }, { keys: ":q\r" },
    ], env);
    selected(result.screens.selected!, /Full preview row/); selected(result.screens.error!, /Full preview row/); selected(result.screens.redrawn!, /Full preview row/); unselected(result.screens.input!);
    assert.doesNotMatch(result.screens.selected!.text, /END_FULL_ONLY_NOT_IN_PREVIEW/);
    const requests = f.requests.filter(r => r.command === "message_content");
    let offset = 0;
    for (const [i, page] of f.pages.entries()) {
      assert.deepEqual(requests[i]!.args, { chatId: "1", entryId: "21", offset });
      assert.equal(page.totalBytes, Buffer.byteLength(text)); assert.equal(page.sha256, createHash("sha256").update(text).digest("hex"));
      offset += Buffer.byteLength(page.text); assert.equal(page.next, offset < Buffer.byteLength(text) ? offset : undefined);
    }
    assert.equal(offset, Buffer.byteLength(text)); assert.ok(offset > 8192);
    assert.deepEqual(f.requests.filter(r => r.command === "admit").map(r => r.args.text), [prompt + "!"]);
    assert.deepEqual(await readdir(exports), [], "Failed viewer preflight must not create a private export");
    assert.equal(JSON.stringify(retained), original); readOnlyRequests(f, true);
    const terminal = Buffer.from(result.output, "base64").toString();
    assert.ok(terminal.split("\x1b[?1049h").length >= 3, "Viewer read pauses and then re-enters the real application");
  } finally { await f.close(); }
});

test("real PTY: Ctrl-N crosses manual older and held-live boundaries without skipping intermediate messages", { skip: !binary, timeout: 30_000 }, async () => {
  const retained = Array.from({ length: 6 }, (_, i) => user((i + 1) * 10, `FORWARD ${(i + 1) * 10} message`));
  const f = await fixture(retained, 2), prompt = "forward draft  ";
  f.checkpoints.set("append", () => { retained.push(user(70, "FORWARD 70 message"), user(80, "FORWARD 80 message")); });
  try {
    const { screens } = await pty(f, [
      { wait: "FORWARD 60 message" }, { keys: prompt }, { keys: esc }, { keys: ":older\r" }, { wait: "FORWARD 40 message" },
      { keys: previous }, { capture: "40" },
      { keys: next }, { wait: "FORWARD 50 message" }, { capture: "50" }, { keys: next }, { capture: "60" },
      { checkpoint: "append" }, { sleep: 0.7 }, { capture: "held" },
      { keys: next }, { wait: "FORWARD 70 message" }, { capture: "70" }, { keys: next }, { capture: "80" },
      { keys: next }, { sleep: 0.2 }, { capture: "end" },
      { keys: "A!" }, { keys: "\r" }, { wait: "Input admitted" }, { keys: esc }, { keys: ":q\r" },
    ]);
    for (const id of [40, 50, 60, 70, 80]) selected(screens[String(id)]!, new RegExp(`FORWARD ${id} message`));
    selected(screens.held!, /FORWARD 60 message/); assert.doesNotMatch(screens.held!.text, /FORWARD 70/);
    unselected(screens.end!);
    assert.deepEqual(f.requests.filter(r => r.command === "history" && r.args.after !== undefined).map(r => r.args.after), ["40", "60", "80"]);
    assert.deepEqual(f.requests.filter(r => r.command === "admit").map(r => r.args.text), [prompt + "!"]);
    readOnlyRequests(f, true);
  } finally { await f.close(); }
});

test("real PTY: Ctrl-N reloads every evicted newer page instead of jumping to latest", { skip: !binary, timeout: 30_000 }, async () => {
  const retained = Array.from({ length: 20 }, (_, i) => user(i + 1, `EVICT ${String(i + 1).padStart(2, "0")} message`));
  const f = await fixture(retained, 1);
  try {
    const steps: Step[] = [{ wait: "EVICT 20 message" }, { keys: "eviction draft" }, { keys: esc }, { keys: previous }, { sleep: 0.15 }];
    for (let i = 19; i >= 1; i--) steps.push({ keys: previous }, { sleep: 0.15 });
    steps.push({ capture: "first" });
    for (let i = 2; i <= 20; i++) steps.push({ keys: next }, { sleep: 0.15 }, { capture: String(i) });
    steps.push({ keys: next }, { sleep: 0.2 }, { capture: "end" }, { keys: ":q!\r" });
    const { screens } = await pty(f, steps);
    selected(screens.first!, /EVICT 01 message/);
    for (let i = 2; i <= 20; i++) selected(screens[String(i)]!, new RegExp(`EVICT ${String(i).padStart(2, "0")} message`));
    unselected(screens.end!);
    assert.deepEqual(f.requests.filter(r => r.command === "history" && r.args.after !== undefined).map(r => r.args.after), ["17", "18", "19", "20"]);
    assert.match(screens.end!.text, /eviction draft/); readOnlyRequests(f);
  } finally { await f.close(); }
});

test("real PTY: sparse forward continuation stays selected at its budget and resumes at the saved raw cursor", { skip: !binary, timeout: 20_000 }, async () => {
  const retained = [user(1, "SPARSE FIRST message")], f = await fixture(retained, 1);
  f.checkpoints.set("append", () => { retained.push(...Array.from({ length: 7 }, (_, i) => hidden(i + 2)), user(9, "SPARSE NEXT message")); });
  try {
    const { screens } = await pty(f, [
      { wait: "SPARSE FIRST message" }, { keys: "sparse forward draft" }, { keys: esc }, { keys: previous }, { checkpoint: "append" },
      { keys: next }, { wait: "More newer history" }, { capture: "budget" }, { sleep: 0.6 },
      { keys: next }, { wait: "SPARSE NEXT message" }, { capture: "found" }, { keys: esc }, { keys: ":q!\r" },
    ]);
    selected(screens.budget!, /SPARSE FIRST message/); selected(screens.found!, /SPARSE NEXT message/);
    assert.deepEqual(f.requests.filter(r => r.command === "history" && r.args.after !== undefined).map(r => r.args.after), ["1", "2", "3", "4", "5", "6", "7", "8"]);
    assert.doesNotMatch(JSON.stringify(screens), /PRIVATE_REASONING/); assert.match(screens.found!.text, /sparse forward draft/); readOnlyRequests(f);
  } finally { await f.close(); }
});

test("real PTY: Esc cancels an in-flight forward read without later viewport or prompt replacement", { skip: !binary, timeout: 20_000 }, async () => {
  const retained = [user(1, "CANCEL ORIGINAL message")], f = await fixture(retained, 1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.hooks.forward = () => gate;
  f.checkpoints.set("append", () => { retained.push(user(2, "CANCEL NEW message")); });
  f.checkpoints.set("pending", async () => { await until(() => f.requests.some(r => r.command === "history" && r.args.after === "1")); });
  f.checkpoints.set("release", () => release());
  try {
    const { screens } = await pty(f, [
      { wait: "CANCEL ORIGINAL message" }, { keys: "cancel draft  " }, { keys: esc }, { keys: previous }, { checkpoint: "append" },
      { keys: next }, { checkpoint: "pending" }, { capture: "pending" },
      { keys: esc }, { capture: "escaped" }, { checkpoint: "release" }, { sleep: 1.5 }, { capture: "late" }, { keys: ":q!\r" },
    ]);
    selected(screens.pending!, /CANCEL ORIGINAL message/);
    for (const name of ["escaped", "late"]) {
      unselected(screens[name]!); assert.deepEqual(chat(screens[name]!), chat(screens.pending!));
      assert.doesNotMatch(screens[name]!.text, /CANCEL NEW message/); assert.match(screens[name]!.text, /cancel draft/);
    }
    readOnlyRequests(f);
  } finally { release(); await f.close(); }
});
