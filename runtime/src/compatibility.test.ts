import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineDoc, defineDocFamily, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { bindImplementation, checkCompatibility, CompatibilityError, fingerprintImplementation, ImplementationDoc } from "./compatibility.js";
import { DeckRuntime } from "./deck.js";
const A = "a".repeat(64), B = "b".repeat(64);
function setup() {
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  return { faux, options: { models, model: { provider: "faux", modelId: "faux-1" }, binding: { machineId: "host", cwd: "/saved" }, environment: () => undefined, implementation: A, hostFiles: { call: async () => { throw new Error("No effects expected"); } } } };
}

test("implementation fingerprint covers actual runtime/dependency/lazy asset/Node/native bytes, not paths or test/dev files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-fingerprint-"));
  const root = join(directory, "original"); const moved = join(directory, "moved");
  const put = async (path: string, text: string) => { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); };
  try {
    await put("package.json", JSON.stringify({ dependencies: { a: "1" }, devDependencies: { dev: "1" } }));
    await put("runtime/dist/main.js", "export const main=1;"); await put("runtime/dist/helper.test.js", "test-only");
    await put("node", "NODE"); await put("native", "NATIVE"); await put("entry.js", "ENTRY");
    await put("node_modules/a/package.json", JSON.stringify({ name: "a", version: "1", dependencies: { b: "1" }, optionalDependencies: { absent: "1" } }));
    await put("node_modules/a/lazy.js", "LAZY");
    await put("node_modules/b/package.json", JSON.stringify({ name: "b", version: "1", peerDependencies: { a: "1" } })); // Cycle.
    await put("node_modules/b/index.js", "B"); await put("node_modules/dev/index.js", "DEV");
    const fingerprint = () => fingerprintImplementation({ root, node: join(root, "node"), native: join(root, "native"), entry: join(root, "entry.js"), mode: "--mock" });
    const original = await fingerprint(); assert.match(original, /^[a-f0-9]{64}$/);
    assert.equal(await fingerprint(), original);
    await cp(root, moved, { recursive: true });
    assert.equal(await fingerprintImplementation({ root: moved, node: join(moved, "node"), native: join(moved, "native"), entry: join(moved, "entry.js"), mode: "--mock" }), original);
    await put("runtime/dist/helper.test.js", "Changed test"); await put("node_modules/dev/index.js", "Changed dev");
    assert.equal(await fingerprint(), original);
    for (const path of ["runtime/dist/main.js", "node_modules/a/lazy.js", "node_modules/b/index.js", "node", "native", "entry.js"]) {
      const saved = await readFile(join(root, path), "utf8"); await put(path, saved + "CHANGED");
      assert.notEqual(await fingerprint(), original, path); await put(path, saved);
    }
    assert.notEqual(await fingerprintImplementation({ root, node: join(root, "node"), native: join(root, "native"), entry: join(root, "entry.js"), mode: "--api-key" }), original);
    assert.notEqual(bindImplementation(original, true), bindImplementation(original, false));
    await put("node_modules/a/package.json", JSON.stringify({ dependencies: { required_missing: "1" } }));
    await assert.rejects(fingerprint(), /Missing implementation dependency/);
    await put("node_modules/a/package.json", JSON.stringify({ name: "a", version: "1", dependencies: { b: "1" } }));
    await symlink(join(root, "native"), join(root, "node_modules/a/unsafe-link"));
    await assert.rejects(fingerprint(), /Unsupported implementation file type/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("idle upgrades retain identity, bindings, creation/admission receipts and immutable older capture bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-upgrade-")); const path = join(directory, "pi.sqlite"); const { faux, options } = setup();
  let runtime = await DeckRuntime.open(path, options);
  try {
    const id = String(runtime.main.id); const request = { requestId: "settled", text: "Original input", mode: "followUp" as const };
    faux.setResponses([fauxAssistantMessage("Done")]); const first = await runtime.admit(id, request); await first.wait(context);
    const capture = (await runtime.history(id)).items.find((entry) => entry.kind === "deck.input")!.data;
    const task = await runtime.createTask("Original task", options.binding, "creation"); const hubId = runtime.hubId;
    const oldImplementation = runtime.implementation; await runtime.close();
    runtime = await DeckRuntime.open(path, { ...options, implementation: B, admissionGuard: async () => { throw new Error("Auth unavailable"); } });
    assert.equal(runtime.hubId, hubId); assert.notEqual(runtime.implementation, oldImplementation);
    assert.equal((await runtime.harness.snapshot(ImplementationDoc, context))!.digest, runtime.implementation);
    assert.equal((await runtime.admit(id, request)).id, first.id);
    assert.equal((await runtime.createTask("Original task", options.binding, "creation")).id, task.id);
    assert.deepEqual((await runtime.history(id)).items.find((entry) => entry.kind === "deck.input")!.data, capture);
    assert.equal(faux.state.callCount, 1);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("global parked/background work blocks upgrade even when main activity is idle; original build can drain it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-upgrade-busy-")); const path = join(directory, "pi.sqlite"); const { faux, options } = setup();
  const pending = defineTask<{}, { phase: "parked" }, null>({ name: "test.uninstalled", version: 1, initial: () => ({ phase: "parked" }), phases: { parked: async () => {} }, abort: async () => {} });
  let runtime = await DeckRuntime.open(path, options);
  try {
    const taskChat = await runtime.createTask("Offline work", { machineId: "offline", cwd: "/offline" });
    const taskId = await taskChat.commit((tx) => tx.createTask(pending, {}, { ownership: { kind: "conversation" }, background: true }), context);
    assert.equal((await runtime.activity(String(runtime.main.id))).busy, false);
    const stamp = runtime.implementation; await runtime.close();
    await assert.rejects(DeckRuntime.open(path, { ...options, implementation: B }), (error: unknown) => error instanceof CompatibilityError && !error.message.includes("Offline work"));
    runtime = await DeckRuntime.open(path, options);
    assert.equal((await runtime.harness.snapshot(ImplementationDoc, context))!.digest, stamp);
    assert.ok((await runtime.harness.inspect(context)).tasks.some((task) => task.record.id === taskId));
    await runtime.harness.abortTask(taskId, context); await runtime.harness.waitForTask(taskId, context);
    await runtime.close(); runtime = await DeckRuntime.open(path, { ...options, implementation: B });
    assert.notEqual(runtime.implementation, stamp); assert.equal(faux.state.callCount, 0);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unversioned queued/placed input and write submissions block adoption without creating a stamp", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-legacy-upgrade-")); const { options } = setup();
  try {
    for (const type of ["input", "write"] as const) for (const status of ["queued", "placed"] as const) {
      if (type === "write" && status === "placed") continue;
      const path = join(directory, `${type}-${status}.sqlite`);
      const harness = await Harness.open(await openNodeSqliteStorage(path), { models: options.models, registry: createRegistry() }, context);
      const root = await harness.root(context);
      await root.commit(async (tx) => {
        if (status === "placed") {
          const entry = await tx.appendEntry(root.id, { kind: "test.input", model: [{ role: "user", content: "PRIVATE_PENDING", timestamp: 0 }] });
          await tx.createSubmission({ conversationId: root.id, type: "input", status: "placed", entry: entry.id });
        } else await tx.createSubmission({ conversationId: root.id, type, status: "queued" });
      }, context);
      await harness.close(context);
      await assert.rejects(DeckRuntime.open(path, options), CompatibilityError);
      const storage = await openNodeSqliteStorage(path);
      try {
        assert.equal(await storage.findDocument({ kind: "deck.implementation", scope: { kind: "session" } }, "current", context), undefined);
        assert.equal((await storage.scanSubmissions({ status }, 10, undefined, context)).items.length, 1);
      } finally { await storage.close(context); }
    }
    const idlePath = join(directory, "idle.sqlite");
    const idle = await DeckRuntime.open(idlePath, options); await idle.close(); // Empty stores adopt normally.
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new reservations refuse code drift across an idle upgrade, then repair under their original implementation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-capture-code-")); const path = join(directory, "pi.sqlite"); const { faux, options } = setup();
  let runtime = await DeckRuntime.open(path, options);
  try {
    const id = String(runtime.main.id); const request = { requestId: "reserved", text: "Input", mode: "followUp" as const };
    const chat = runtime.chat.bind(runtime);
    runtime.chat = async (id) => { const conversation = await chat(id); conversation.submit = async () => { throw new Error("Before submission"); }; return conversation; };
    await assert.rejects(runtime.admit(id, request), /Before submission/); runtime.chat = chat;
    await runtime.close(); runtime = await DeckRuntime.open(path, { ...options, implementation: B });
    await assert.rejects(runtime.admit(id, request), { code: "settings_changed" });
    assert.equal((await runtime.history(id)).items.length, 0); assert.equal(faux.state.callCount, 0);
    await runtime.close(); runtime = await DeckRuntime.open(path, options);
    faux.setResponses([fauxAssistantMessage("Repaired")]); await (await runtime.admit(id, request)).wait(context);
    assert.equal(faux.state.callCount, 1);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy version-2 reservation repairs keep their original weaker capture without inventing code provenance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-legacy-capture-")); const path = join(directory, "pi.sqlite"); const { faux, options } = setup();
  let runtime = await DeckRuntime.open(path, options);
  try {
    const id = String(runtime.main.id); const request = { requestId: "v2", text: "Input", mode: "followUp" as const };
    const chat = runtime.chat.bind(runtime);
    runtime.chat = async (id) => { const conversation = await chat(id); conversation.submit = async () => { throw new Error("Before submission"); }; return conversation; };
    await assert.rejects(runtime.admit(id, request), /Before submission/); runtime.chat = chat;
    const Legacy = defineDocFamily<{ hash: string; capture: string }, { hash: string; capture: string }>({ kind: "deck.admission", version: 1, scope: "conversation", history: "latest", fork: "initial", family: true, initial: (seed) => seed, checkpointWhen: () => true });
    const bytes = await runtime.main.commit(async (tx) => {
      const reservation = await tx.doc(Legacy, runtime.main.id, request.requestId, { hash: "unused", capture: "unused" });
      const capture = JSON.parse(reservation.capture) as Record<string, unknown>;
      capture.version = 2; delete capture.implementation; reservation.capture = JSON.stringify(capture); return reservation.capture;
    }, context);
    await runtime.close(); runtime = await DeckRuntime.open(path, { ...options, implementation: B });
    faux.setResponses([fauxAssistantMessage("Legacy repaired")]); await (await runtime.admit(id, request)).wait(context);
    assert.equal(((await runtime.history(id)).items.find((entry) => entry.kind === "deck.input")!.data as { capture: string }).capture, bytes);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unknown stamp formats reject downgrade even while idle, without normalizing their contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-stamp-format-")); const path = join(directory, "pi.sqlite"); const { options } = setup();
  const storage = await openNodeSqliteStorage(path);
  const harness = await Harness.open(storage, { models: options.models, registry: createRegistry() }, context);
  try { await harness.commit(async (tx) => { (await tx.doc(ImplementationDoc)).digest = "PRIVATE_MALFORMED_STAMP"; }, context); }
  finally { await harness.close(context); }
  try {
    const reopened = await openNodeSqliteStorage(path);
    try { await assert.rejects(checkCompatibility(reopened, A), (error: unknown) => error instanceof CompatibilityError && !error.message.includes("PRIVATE_MALFORMED_STAMP")); }
    finally { await reopened.close(context); }
    const futureStorage = await openNodeSqliteStorage(join(directory, "future.sqlite"));
    const future = await Harness.open(futureStorage, { models: options.models, registry: createRegistry() }, context);
    const Future = defineDoc<{ digest: string }>({ kind: "deck.implementation", version: 2, scope: "session", initial: () => ({ digest: A }), checkpointWhen: () => true });
    await future.commit((tx) => tx.doc(Future), context); await future.close(context);
    const futureRead = await openNodeSqliteStorage(join(directory, "future.sqlite"));
    try { await assert.rejects(checkCompatibility(futureRead, A), /Unsupported Deck implementation stamp/); }
    finally { await futureRead.close(context); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
