import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { ChatDoc, DeckRuntime, type Input } from "./deck.js";
import { validBrief, validForm } from "./task-brief.js";
import { validHosts } from "./host-inventory.js";
import { validRequest, TuiSession } from "./tui-session.js";
import { validMutationArgs, validMutationAck } from "./mutation-contracts.js";
import { validNativeRequest, validNativeResult } from "./native-contracts.js";
import { groupedTasks } from "./task-groups.js";
import { DraftStore } from "./drafts.js";
import { RoutedFiles } from "./remote-files.js";
import type { PipeFiles, FileResult } from "./host-files.js";
import { dispatch } from "./ipc.js";
const local = "a".repeat(32), worker = "b".repeat(32);
function setup() {
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  return { faux, options: { models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: local, cwd: "/saved" }, environment: () => undefined, hostFiles: {
    call: async () => { throw new Error("No native effect expected"); },
    registeredHosts: async () => [{ machineId: worker, kind: "worker" as const, rex: false, connection: "offline" as const }],
  } } };
}
const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((p: any) => p.type === "text" ? p.text : "").join("");
const inputs = async (runtime: DeckRuntime, id: string) => (await runtime.history(id, { limit: 100 })).items.filter(e => e.kind === "deck.input").map(e => e.data as Input);

test("Phase 1 shared semantic corpus and UTF-8 bounds", async () => {
  const cases = JSON.parse(await readFile(new URL("../../src/phase1.test.json", import.meta.url), "utf8"));
  const checks: Record<string, (v: unknown) => boolean> = { form: validForm, brief: validBrief, hosts: validHosts, request: validRequest, nativeRequest: validNativeRequest, nativeResult: v => validNativeResult("link_status", v) };
  for (const c of cases) assert.equal(c.kind === "briefAck" ? validMutationAck({ command: "create_task_brief", args: c.args }, c.value) : checks[c.kind]!(c.value), c.valid, JSON.stringify(c));
  const args = { requestId: "brief", title: "Title", machineId: local, cwd: "/", problem: "" };
  assert.equal(validMutationArgs("create_task_brief", args), true);
  assert.equal(validMutationArgs("create_task_brief", { ...args, problem: undefined }), false);
  assert.equal(validMutationAck({ command: "create_task", args: { ...args, problem: { ignored: true } } }, { chatId: "1" }), true);
  assert.equal(validForm({ title: "😀".repeat(50), problem: "😀".repeat(512), description: "😀".repeat(2048) }), true);
  for (const form of [{ title: "😀".repeat(51) }, { title: "x", problem: "😀".repeat(513) }, { title: "x", description: "😀".repeat(2049) }, { title: "x", problem: "\ud800" }]) assert.equal(validForm(form), false);
  assert.deepEqual(groupedTasks([{ chatId: "1" }, { chatId: "3" }, { chatId: "7", parentChatId: "1" }, { chatId: "9", parentChatId: "2" }]).map(r => r.chatId), ["1", "7", "9", "3"]);
});

test("host observation timeout retains one correlation and consumes late replies without cached health", { timeout: 10_000 }, async () => {
  const files = new RoutedFiles(local, {} as PipeFiles, { hubId: "hub", hosts: [] });
  const calls: string[] = []; let release!: (v: FileResult) => void;
  const pending = new Promise<FileResult>(r => release = r);
  // Test-only pipe substitute: production routes still come exclusively from inherited descriptors.
  (files as unknown as { remotes: Map<string, { call: (...args: any[]) => Promise<FileResult> }> }).remotes.set(worker, { call: async (_binding, id, operation, args) => {
    calls.push(id); assert.equal(operation, "link_status"); assert.deepEqual(args, {});
    return calls.length === 1 ? pending : { ok: true, code: "link_status", output: "offline" };
  } });
  try {
    assert.equal((await files.registeredHosts())[0]!.connection, "unknown");
    assert.equal((await files.registeredHosts())[0]!.connection, "unknown"); assert.equal(calls.length, 1);
    release({ ok: true, code: "link_status", output: "connected" }); await new Promise(r => setImmediate(r));
    assert.equal((await files.registeredHosts())[0]!.connection, "offline"); assert.equal(calls.length, 2);
    assert.ok(BigInt(calls[0]!) >= 1n << 63n); assert.notEqual(calls[0], calls[1]);
  } finally { release({ ok: false, code: "offline", output: "closed" }); }
});

test("brief creation is exact, idempotent, idle, centrally retained and legacy compatible", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-brief-")), { faux, options } = setup();
  let runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  const brief = { problem: "  Problem 日本語\n", description: "Description 😀\n".repeat(100) };
  try {
    const old = await runtime.createTask("Old", options.binding, "old");
    const oldUnicode = await runtime.createTask("😀".repeat(100), options.binding, "old-unicode");
    assert.equal((await runtime.legacyCreatedTask("😀".repeat(100), options.binding, "old-unicode"))?.id, oldUnicode.id);
    assert.equal(await runtime.legacyCreatedTask("😀".repeat(100), options.binding, "not-created"), undefined);
    const task = await runtime.createTask("Title", { machineId: worker, cwd: "/remote path" }, "new", undefined, brief);
    assert.equal((await runtime.createTask("Old", options.binding, "old")).id, old.id);
    assert.equal((await runtime.createTask("Title", { machineId: worker, cwd: "/remote path" }, "new", undefined, brief)).id, task.id);
    await assert.rejects(runtime.createTask("Title", { machineId: worker, cwd: "/remote path" }, "new", undefined, { ...brief, problem: brief.problem.trim() }), { code: "conflict" });
    await assert.rejects(runtime.createTask("Old", options.binding, "old", undefined, { problem: "" }), { code: "conflict" });
    assert.deepEqual((await runtime.harness.snapshot(ChatDoc, task.id, context))?.brief, brief);
    assert.match((await task.agent(context)).instructions!, /Problem 日本語/);
    assert.equal((await runtime.history(String(task.id))).items.length, 0); assert.equal(faux.state.callCount, 0);
    const listing = await runtime.listChats({ includeObservations: true });
    assert.equal(listing.items.find(i => i.chatId === String(task.id))?.activity, "idle");
    assert.equal(listing.items.find(i => i.chatId === String(task.id))?.rexState, "unallocated");
    assert.deepEqual((await dispatch(runtime, { command: "status", args: { chatId: String(task.id) } }) as any).binding.brief, brief);
    assert.deepEqual(await dispatch(runtime, { command: "create_task_brief", args: { title: "Title", machineId: worker, cwd: "/remote path", requestId: "new", ...brief } }), { chatId: String(task.id), brief });
    assert.deepEqual(await dispatch(runtime, { command: "create_task", args: { title: "Old", ...options.binding, requestId: "old", problem: { stillIgnored: true } } }), { chatId: String(old.id) });
    await runtime.close(); runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
    assert.equal((await runtime.createTask("Title", { machineId: worker, cwd: "/remote path" }, "new", undefined, brief)).id, task.id);
    assert.equal((await runtime.listChats()).items.length, 4);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("hub model explicitly chooses registered host and brief, then task reports once with stable reply provenance", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-exchange-")), { faux, options } = setup();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options); let taskId = "";
  try {
    const route: FauxResponseFactory = async request => {
      const user = text(request.messages.filter(m => m.role === "user").at(-1));
      const last = request.messages.filter(m => m.role === "toolResult").at(-1);
      if (user.endsWith("\nREPORT")) return fauxAssistantMessage("Report received, no automatic relay");
      if (user.endsWith("\nWORK")) return last?.toolName === "hub_message" ? fauxAssistantMessage("Reported") : fauxAssistantMessage(fauxToolCall("hub_message", { text: "REPORT" }), { stopReason: "toolUse" });
      if (!last) return fauxAssistantMessage(fauxToolCall("task_create", { title: "One task", problem: "Problem", description: "Saved brief", machineId: worker, cwd: "/remote" }), { stopReason: "toolUse" });
      assert.equal(last.isError, false, text(last));
      if (last.toolName === "task_create") {
        taskId = JSON.parse(text(last)).chatId;
        assert.equal((await runtime.history(taskId)).items.length, 0);
        return fauxAssistantMessage(fauxToolCall("task_message", { chatId: taskId, text: "WORK" }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Work admitted, not an answer");
    };
    faux.setResponses(Array.from({ length: 15 }, () => route));
    const first = await runtime.admit(String(runtime.main.id), { requestId: "human-start", text: "START", mode: "followUp" });
    await first.wait(context); await (await runtime.chat(taskId)).waitForIdle(context); await runtime.main.waitForIdle(context);
    const taskInputs = await inputs(runtime, taskId), hubInputs = await inputs(runtime, String(runtime.main.id));
    assert.equal(taskInputs.length, 1); assert.equal(hubInputs.length, 2);
    const sent = taskInputs[0]!, report = hubInputs.find(i => i.text === "REPORT")!;
    assert.equal(sent.origin?.chain?.hop, 1); assert.equal(report.origin?.chain?.hop, 2);
    assert.equal(report.origin?.chatId, taskId); assert.equal(report.origin?.chain?.rootRequestId, "human-start");
    assert.equal(report.origin?.chain?.replyToRequestId, sent.requestId); assert.equal(report.origin?.chain?.replyToChatId, taskId);
    const before = hubInputs.length;
    await runtime.admit(String(runtime.main.id), report); // Explicit exact retry of an admitted input.
    assert.equal((await inputs(runtime, String(runtime.main.id))).length, before);
    await assert.rejects(runtime.admit(String(runtime.main.id), { ...report, origin: { ...report.origin!, chatId: String(runtime.main.id) } }), { code: "conflict" });
    assert.equal((await runtime.listChats()).items.length, 2);
    assert.equal((await runtime.harness.snapshot(ChatDoc, (await runtime.chat(taskId)).id, context))?.machineId, worker);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("scripted hub/task acknowledgement loop stops at eight hops, and human input is an explicit reset", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-loop-")), { faux, options } = setup();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  try {
    const task = await runtime.createTask("Loop", options.binding), id = String(task.id);
    const route: FauxResponseFactory = request => {
      const last = request.messages.at(-1)!;
      if (last.role === "toolResult") return fauxAssistantMessage(last.isError ? "Loop budget refused" : "Sent once");
      const user = text(request.messages.filter(m => m.role === "user").at(-1));
      return fauxAssistantMessage(user.endsWith("\nTO_TASK") ? fauxToolCall("hub_message", { text: "TO_HUB" }) : fauxToolCall("task_message", { chatId: id, text: "TO_TASK" }), { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 60 }, () => route));
    await runtime.admit(String(runtime.main.id), { requestId: "loop-human", text: "START", mode: "followUp" });
    // Read-only readiness polling; no message is retried or automatically relayed by Deck.
    for (let n = 0; n < 500; n++) {
      const all = [...await inputs(runtime, id), ...await inputs(runtime, String(runtime.main.id))];
      if (all.length === 9 && !(await runtime.activity(id)).busy && !(await runtime.activity(String(runtime.main.id))).busy) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const all = [...await inputs(runtime, id), ...await inputs(runtime, String(runtime.main.id))];
    assert.equal(all.length, 9); assert.deepEqual(all.filter(i => i.origin).map(i => i.origin!.chain!.hop).sort((a,b) => a-b), [1,2,3,4,5,6,7,8]);
    const errors = (await runtime.history(String(runtime.main.id), { limit: 100 })).items.flatMap(e => e.model ?? []).filter(m => m.role === "toolResult" && m.isError);
    assert.ok(errors.some(m => text(m).includes("hop limit")));
    faux.setResponses([fauxAssistantMessage(fauxToolCall("hub_message", { text: "RESET_REPORT" }), { stopReason: "toolUse" }), fauxAssistantMessage("Fresh human turn"), fauxAssistantMessage("Reset report received")]);
    assert.equal((await (await runtime.admit(id, { requestId: "fresh-human", text: "Human reset", mode: "followUp" })).wait(context)).status, "done");
    await runtime.main.waitForIdle(context);
    const reset = (await inputs(runtime, String(runtime.main.id))).find(i => i.text === "RESET_REPORT")!;
    assert.equal(reset.origin?.chain?.hop, 1); assert.equal(reset.origin?.chain?.rootRequestId, "fresh-human");
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("later human input cannot reset a tool's captured cutoff, and lower-hop messages cannot reduce the budget", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-cutoff-")), { faux, options } = setup();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => enter = r), released = new Promise<void>(r => release = r);
  try {
    const task = await runtime.createTask("Cutoff", options.binding), id = String(task.id);
    const origin = { kind: "task-tool" as const, chatId: String(runtime.main.id), taskId: "100", chain: { rootChatId: String(runtime.main.id), rootRequestId: "old-human", hop: 8, replyToChatId: String(runtime.main.id), replyToRequestId: "old-message" } };
    const route: FauxResponseFactory = async request => {
      const last = request.messages.at(-1)!;
      if (last.role === "toolResult") return fauxAssistantMessage(last.isError ? "Budget blocked" : "Sent");
      const user = text(request.messages.filter(m => m.role === "user").at(-1));
      if (user.endsWith("\nMAX")) { enter(); await released; return fauxAssistantMessage(fauxToolCall("hub_message", { text: "MUST_NOT_SEND" }), { stopReason: "toolUse" }); }
      if (user === "NEW HUMAN") return fauxAssistantMessage(fauxToolCall("hub_message", { text: "HUMAN_ALLOWED" }), { stopReason: "toolUse" });
      return fauxAssistantMessage("Received");
    };
    faux.setResponses(Array.from({ length: 20 }, () => route));
    const initial = await runtime.admit(id, { requestId: "at-limit", text: "MAX", mode: "followUp", origin });
    await entered;
    const fresh = await runtime.admit(id, { requestId: "new-human", text: "NEW HUMAN", mode: "followUp" });
    release(); await initial.wait(context); await fresh.wait(context); await runtime.main.waitForIdle(context);
    const hubInputs = await inputs(runtime, String(runtime.main.id));
    assert.equal(hubInputs.some(i => i.text === "MUST_NOT_SEND"), false);
    assert.equal(hubInputs.find(i => i.text === "HUMAN_ALLOWED")?.origin?.chain?.hop, 1);
    // Reintroduce a high-hop input after that reset, then a lower-hop agent
    // message. Only another actual human input may reset this high-water mark.
    faux.setResponses([fauxAssistantMessage("Observed high hop")]);
    await (await runtime.admit(id, { requestId: "high", text: "HIGH", mode: "followUp", origin })).wait(context);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("hub_message", { text: "LOWER_MUST_NOT_RESET" }), { stopReason: "toolUse" }), fauxAssistantMessage("Blocked")]);
    await (await runtime.admit(id, { requestId: "lower", text: "LOW", mode: "followUp", origin: { ...origin, chain: { ...origin.chain, hop: 1 } } })).wait(context);
    assert.equal((await inputs(runtime, String(runtime.main.id))).some(i => i.text === "LOWER_MUST_NOT_RESET"), false);
    const { chain: ignored, ...legacyOrigin } = origin;
    faux.setResponses([fauxAssistantMessage(fauxToolCall("hub_message", { text: "LEGACY_MUST_NOT_SEND" }), { stopReason: "toolUse" }), request => {
      assert.match(text(request.messages.at(-1)), /provenance unavailable/i); return fauxAssistantMessage("Legacy forwarding refused");
    }]);
    assert.equal((await (await runtime.admit(id, { requestId: "unbudgeted", text: "Legacy input", mode: "followUp", origin: legacyOrigin })).wait(context)).status, "done");
    // A raw Pi user entry lacks Deck's human/agent provenance and must not
    // inherit a previous human reset just because its model role is user.
    faux.setResponses([fauxAssistantMessage("Observed actual human")]);
    await (await runtime.admit(id, { requestId: "before-raw", text: "Actual human", mode: "followUp" })).wait(context);
    faux.setResponses([fauxAssistantMessage(fauxToolCall("hub_message", { text: "RAW_MUST_NOT_SEND" }), { stopReason: "toolUse" }), request => {
      assert.match(text(request.messages.at(-1)), /provenance unavailable/i); return fauxAssistantMessage("Raw forwarding refused");
    }]);
    assert.equal((await (await task.submit({ type: "input", content: "Unprovenanced Pi input" }, context)).wait(context)).status, "done");
    assert.equal((await inputs(runtime, String(runtime.main.id))).some(i => ["LEGACY_MUST_NOT_SEND", "RAW_MUST_NOT_SEND"].includes(i.text)), false);
  } finally { release(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("host selection is hub-only and explicit registration is not enrollment or reassignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-host-authority-")), { faux, options } = setup();
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), options);
  try {
    const task = await runtime.createTask("Caller", options.binding);
    for (const [chat, args] of [[task, { title: "Other host", machineId: worker, cwd: "/remote" }], [runtime.main, { title: "Unregistered", machineId: "c".repeat(32), cwd: "/remote" }]] as const) {
      faux.setResponses([fauxAssistantMessage(fauxToolCall("task_create", args), { stopReason: "toolUse" }), request => { assert.equal(request.messages.filter(m => m.role === "toolResult").at(-1)?.isError, true); return fauxAssistantMessage("Refused"); }]);
      assert.equal((await (await runtime.admit(String(chat.id), { requestId: args.title, text: "Try", mode: "followUp" })).wait(context)).status, "done");
    }
    assert.equal((await runtime.listChats()).items.length, 2);
    assert.equal((await runtime.harness.snapshot(ChatDoc, task.id, context))?.machineId, local);
    assert.deepEqual((await runtime.hosts()).items.map(i => i.machineId), [local, worker]);
    const before = (await inputs(runtime, String(runtime.main.id))).length;
    await runtime.harness.commit(async tx => { (await tx.doc(ChatDoc, runtime.main.id)).kind = "task"; }, context); // Labels cannot turn the canonical hub into a task target.
    faux.setResponses([fauxAssistantMessage(fauxToolCall("task_message", { chatId: String(runtime.main.id), text: "NOT_A_TASK_TARGET" }), { stopReason: "toolUse" }), request => {
      assert.equal(request.messages.at(-1)?.role, "toolResult"); assert.match(text(request.messages.at(-1)), /not main/i); return fauxAssistantMessage("Canonical hub refused");
    }]);
    assert.equal((await (await runtime.admit(String(task.id), { requestId: "canonical-hub", text: "Try misleading label", mode: "followUp" })).wait(context)).status, "done");
    assert.equal((await inputs(runtime, String(runtime.main.id))).length, before);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const mode of ["report", "legacy"]) test(`SIGKILL after ${mode} admission recovers the original provenance/receipt without input replay`, { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-message-recovery-")), path = join(directory, "pi.sqlite");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./phase1-recovery.test.fixture.js", import.meta.url)), path, mode]);
  const closed = once(child, "close"); let errors = ""; child.stdout.resume(); child.stderr.on("data", c => errors += String(c));
  let runtime: DeckRuntime | undefined;
  try {
    let checkpoint: { target: string; sender: string; submissionId: string; input: Input } | undefined;
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      try { checkpoint = JSON.parse(await readFile(`${path}.checkpoint`, "utf8")); break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Fixture exited: ${errors}`);
      await new Promise(r => setTimeout(r, 10));
    }
    assert.ok(checkpoint, errors); child.kill("SIGKILL"); await closed;
    const { faux, options } = setup(); faux.setResponses(Array.from({ length: 5 }, () => () => fauxAssistantMessage("Recovered")));
    runtime = await DeckRuntime.open(path, { ...options, admissionGuard: async () => { throw new Error("No new admission allowed during recovery"); } });
    await runtime.main.waitForIdle(context); await (await runtime.chat(checkpoint.sender)).waitForIdle(context); await (await runtime.chat(checkpoint.target)).waitForIdle(context);
    const recorded = (await inputs(runtime, checkpoint.target)).filter(i => i.requestId === checkpoint!.input.requestId);
    assert.equal(recorded.length, 1); assert.deepEqual(recorded[0]!.origin, checkpoint.input.origin);
    assert.equal((await runtime.admit(checkpoint.target, checkpoint.input)).id.toString(), checkpoint.submissionId);
    if (mode === "report") assert.equal(recorded[0]!.origin?.chain?.hop, 1); else assert.equal(recorded[0]!.origin?.chain, undefined);
    const results = [...(await runtime.history(String(runtime.main.id), { limit: 100 })).items, ...(await runtime.history(checkpoint.sender, { limit: 100 })).items].flatMap(e => e.model ?? []).filter(m => m.role === "toolResult" && m.toolName === (mode === "legacy" ? "task_message" : "hub_message"));
    assert.ok(results.some(m => m.role === "toolResult" && !m.isError && JSON.parse(text(m)).submissionId === checkpoint!.submissionId));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    await runtime?.close(); await rm(directory, { recursive: true, force: true });
  }
});

test("TUI form lost creation ACK keeps exact brief and identity; retry clears before separate Rex open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-form-")); const calls: { name: string; args: any }[] = [];
  let lose = true;
  const status = { hubGuard: 1, rexOpen: 1, taskBrief: 1, hostInventory: 1, hubId: "hub", mainChatId: "1", chatId: "1", tools: "native", binding: { machineId: local, cwd: "/saved" } };
  const session = new TuiSession(async (name, args) => {
    calls.push({ name, args });
    if (name === "status") return status;
    if (name === "history") return { items: [] };
    if (name === "list_hosts") return { sampledAtMs: 1, items: [{ machineId: worker, kind: "worker", rex: true, connection: "offline" }] };
    if (name === "create_task_brief") { if (lose) { lose = false; throw new Error("ACK lost"); } return { chatId: "9", brief: { problem: args.problem, description: args.description } }; }
    if (name === "rex_open") { assert.deepEqual(await new DraftStore("hub", directory).list(), []); throw new Error("Open lost"); }
    throw new Error(name);
  }, undefined, undefined, directory);
  try {
    const form = { title: "Exact title", machineId: worker, cwd: "/space path", problem: "  exact\n", description: "😀".repeat(300) };
    await assert.rejects(session.handle({ version: 1, id: "1", action: "create", taskForm: form }), /ACK lost/);
    const store = new DraftStore("hub", directory), saved = (await store.list())[0]!;
    assert.deepEqual((await store.load(saved.requestId)).request, { kind: "task", chatId: "1", requestId: saved.requestId, ...form });
    await assert.rejects(session.handle({ version: 1, id: "2", action: "create", taskForm: { title: "Other" } }), /Resolve saved/);
    await session.handle({ version: 1, id: "3", action: "retry" });
    const creates = calls.filter(c => c.name === "create_task_brief"); assert.equal(creates.length, 2); assert.deepEqual(creates[0]!.args, creates[1]!.args);
    assert.equal(calls.filter(c => c.name === "rex_open").length, 1); assert.equal(calls.filter(c => c.name === "admit").length, 0);
    assert.deepEqual(await store.list(), []);
    status.taskBrief = 0;
    const old = new TuiSession(async name => name === "status" ? status : { items: [] }, undefined, undefined, directory);
    await assert.rejects(old.handle({ version: 1, id: "4", action: "create", taskForm: { title: "No silent loss", problem: "required" } }), /lacks task briefs/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
