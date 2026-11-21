import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DraftStore, type Draft } from "./drafts.js";
import { clientEnv } from "./client.test.env.js";
import { LauncherDrafts } from "./launcher-drafts.js";
import { taskCreationArgs, taskCreationCommand } from "./task-brief.js";

test("ordinary and launcher drafts use the same user data root, not the old platform state root", t => {
  const check = (root: string) => {
    assert.ok(new DraftStore("hub").directory.startsWith(join(root, "drafts") + "/"));
    assert.ok(new LauncherDrafts({ hubId: "hub", machineId: "machine" }).directory.startsWith(join(root, "launcher-drafts") + "/"));
  };
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: "/example", XDG_STATE_HOME: "/old" };
  delete env.DECK_CLIENT_STATE_DIRECTORY;
  t.mock.property(process, "env", env);
  check("/example/.local/share/deck/client");
  process.env.DECK_CLIENT_STATE_DIRECTORY = "/explicit"; check("/explicit");
});

test("draft cache publishes private immutable records, isolates hub identities and tolerates concurrent identical saves", async () => {
  const local = await clientEnv();
  try {
    const store = new DraftStore("hub-a", local.env.DECK_CLIENT_STATE_DIRECTORY);
    const other = new DraftStore("hub-b", local.env.DECK_CLIENT_STATE_DIRECTORY);
    const request: Draft = { kind: "input", chatId: "2", requestId: randomUUID(), text: "private text", mode: "steer" };
    await Promise.all([store.save(request), store.save(request)]);
    const path = join(store.directory, `${request.requestId}.json`);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(store.directory)).mode & 0o777, 0o700);
    assert.deepEqual((await store.load(request.requestId)).request, request);
    await assert.rejects(store.save({ ...request, text: "different" }), /conflicts/);
    assert.deepEqual(await other.list(), []);
    assert.equal((await store.list()).length, 1);
    assert.doesNotMatch(JSON.stringify(await store.list()), /private text/);
    await store.remove(request.requestId); await store.remove(request.requestId);
    assert.deepEqual(await store.list(), []);
    const task: Draft = { kind: "task", chatId: "2", requestId: randomUUID(), title: "Task", machineId: "offline-original", cwd: "/original" };
    await store.save(task);
    assert.deepEqual((await store.load(task.requestId)).request, task);
    const instructions: Draft = { kind: "instructions", chatId: "2", requestId: randomUUID(), machineId: "original-worker", cwd: "/original" };
    await store.save(instructions); assert.deepEqual((await store.load(instructions.requestId)).request, instructions);
    await assert.rejects(store.save({ ...instructions, cwd: "/changed" }), /conflicts/);
    assert.doesNotMatch(JSON.stringify(await store.list()), /original-worker|\/original/);
  } finally { await local.close(); }
});

test("draft cache rejects incompatible/corrupt/insecure files and symlinks without interpreting content", async () => {
  const local = await clientEnv();
  try {
    const store = new DraftStore("hub", local.env.DECK_CLIENT_STATE_DIRECTORY);
    const request: Draft = { kind: "input", chatId: "1", requestId: randomUUID(), text: "secret sentinel", mode: "steer" };
    await store.save(request);
    const path = join(store.directory, `${request.requestId}.json`);
    const saved = await readFile(path, "utf8");
    await chmod(path, 0o644); await assert.rejects(store.load(request.requestId), /private/); await chmod(path, 0o600);
    await writeFile(path, "secret sentinel malformed"); await assert.rejects(store.load(request.requestId), /Invalid saved draft JSON/);
    await writeFile(path, saved.replace('"version":1', '"version":2')); await assert.rejects(store.load(request.requestId), /Incompatible/);
    await writeFile(path, saved.replace('"hubId":"hub"', '"hubId":"other"')); await assert.rejects(store.load(request.requestId), /Incompatible/);
    await unlink(path); await symlink("/etc/passwd", path); await assert.rejects(store.load(request.requestId));
    await assert.rejects(store.load("../escape"), /Invalid draft request ID/);
    await store.remove(request.requestId);
    assert.deepEqual(await store.list(), []);
  } finally { await local.close(); }
});

test("problem-only managed draft round-trips normalized opaque data without title, binding or caller/file mutation", async () => {
  const local = await clientEnv();
  try {
    const store = new DraftStore("auto-hub", local.env.DECK_CLIENT_STATE_DIRECTORY);
    const request = Object.freeze({ kind: "task" as const, chatId: "2", requestId: randomUUID(), managedParentChatId: "2", problem: "  exact 日本語 🧪\n  ", description: "" as const });
    const withOpaqueFields = Object.freeze({ ...request, presentation: { title: "Not a title", machineId: "Not a binding" }, agentName: "Do not infer a title" });
    await Promise.all([store.save(withOpaqueFields), store.save(request)]);
    const path = join(store.directory, `${request.requestId}.json`), bytes = await readFile(path), saved = await store.load(request.requestId);
    assert.deepEqual(saved.request, request); assert.deepEqual(JSON.parse(bytes.toString()).request, request);
    assert.equal(Object.hasOwn(saved.request, "title"), false); assert.equal(Object.hasOwn(saved.request, "machineId"), false); assert.equal(Object.hasOwn(saved.request, "cwd"), false);
    assert.equal(withOpaqueFields.agentName, "Do not infer a title"); assert.equal(withOpaqueFields.presentation.title, "Not a title");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await store.list(), [{ kind: "task", chatId: "2", requestId: request.requestId, createdAt: saved.createdAt }]);
    assert.doesNotMatch(JSON.stringify(await store.list()), /exact|日本語|Not a title|managedParentChatId/);
    await store.save(request); assert.deepEqual(await readFile(path), bytes, "identical save cannot update timestamp or normalize the existing file");
    for (const changed of [{ ...request, problem: request.problem.trim() }, { ...request, managedParentChatId: "3" }, { ...request, title: "Explicit title is a different mode" }]) {
      await assert.rejects(store.save(changed), /conflicts/); assert.deepEqual(await readFile(path), bytes);
    }
    // Loading an older record with decorative unknown fields projects a fresh
    // normalized request; it must not rewrite those original persisted bytes.
    const decorated = JSON.stringify({ ...saved, request: withOpaqueFields }); await writeFile(path, decorated);
    assert.deepEqual((await store.load(request.requestId)).request, request);
    await store.save(request); assert.equal(await readFile(path, "utf8"), decorated);
  } finally { await local.close(); }
});

test("problem-only draft validation rejects missing/blank/oversized/ill-formed problem, description/title/binding overrides and unsafe parent before publication", async () => {
  const local = await clientEnv();
  try {
    const store = new DraftStore("auto-invalid", local.env.DECK_CLIENT_STATE_DIRECTORY);
    const good = { kind: "task", chatId: "2", requestId: randomUUID(), managedParentChatId: "2", problem: "Own problem", description: "" };
    const invalid = [
      ...[undefined, null, "", " \t\n\u3000\ufeff", 1, "x".repeat(2049), "🧪".repeat(512) + "x", "\ud800", "x\udfff"].map(problem => ({ ...good, problem })),
      ...[undefined, null, " ", "Override instructions"].map(description => ({ ...good, description })),
      ...[null, "", " \u3000"].map(title => ({ ...good, title })),
      ...[{ machineId: "a" }, { cwd: "/workspace" }, { machineId: "a", cwd: "/workspace" }].map(binding => ({ ...good, ...binding })),
      ...[undefined, null, "", "0", "-1", "02", "2.0", "9007199254740992", "../2", 2].map(managedParentChatId => ({ ...good, managedParentChatId })),
    ];
    for (const request of invalid) { await assert.rejects(store.save(request as Draft)); assert.deepEqual(await store.list(), []); }
    const boundary: Draft = { ...good, kind: "task", problem: "🧪".repeat(512), description: "" }; await store.save(boundary);
    const path = join(store.directory, `${good.requestId}.json`), original = await readFile(path), saved = JSON.parse(original.toString());
    for (const request of invalid) {
      await assert.rejects(store.save(request as Draft)); assert.deepEqual(await readFile(path), original, "invalid save cannot overwrite a valid identity");
      await writeFile(path, JSON.stringify({ ...saved, request })); await assert.rejects(store.load(good.requestId));
      await writeFile(path, original);
    }
    assert.deepEqual((await store.load(good.requestId)).request, boundary);
  } finally { await local.close(); }
});

test("legacy explicit task and managed drafts retain saved titles, exact optional brief fields, request args and immutable bytes", async () => {
  const local = await clientEnv();
  try {
    const store = new DraftStore("legacy-hub", local.env.DECK_CLIENT_STATE_DIRECTORY);
    const requests: Draft[] = [
      { kind: "task", chatId: "1", requestId: randomUUID(), title: "Original ordinary title", machineId: "offline-original", cwd: "/saved" },
      { kind: "task", chatId: "2", requestId: randomUUID(), title: "Original managed title", managedParentChatId: "2" },
      { kind: "task", chatId: "2", requestId: randomUUID(), title: "Original empty brief", managedParentChatId: "2", problem: "", description: "" },
      { kind: "task", chatId: "2", requestId: randomUUID(), title: "Original detailed brief", managedParentChatId: "2", problem: "  exact problem  ", description: "  exact description\n" },
    ];
    for (const request of requests) {
      await store.save(request); const path = join(store.directory, `${request.requestId}.json`), bytes = await readFile(path);
      const restored = (await new DraftStore("legacy-hub", local.env.DECK_CLIENT_STATE_DIRECTORY).load(request.requestId)).request;
      assert.deepEqual(restored, request); await store.save(restored); assert.deepEqual(await readFile(path), bytes);
      assert.equal(restored.kind, "task"); if (restored.kind !== "task") assert.fail("task expected");
      assert.equal(Object.hasOwn(restored, "title"), true);
      if (request.kind !== "task") assert.fail("task expected");
      assert.equal(taskCreationCommand(restored), request.managedParentChatId === undefined ? "create_task" : "create_managed_child");
      assert.deepEqual(taskCreationArgs(restored), { requestId: request.requestId, title: request.title,
        ...(request.managedParentChatId === undefined ? { machineId: request.machineId, cwd: request.cwd } : { parentChatId: request.managedParentChatId }),
        ...(request.problem === undefined ? {} : { problem: request.problem }), ...(request.description === undefined ? {} : { description: request.description }) });
      await assert.rejects(store.save({ kind: "task", chatId: request.chatId, requestId: request.requestId, managedParentChatId: "2", problem: "Own problem", description: "" }), /conflicts/);
      assert.deepEqual(await readFile(path), bytes);
    }
  } finally { await local.close(); }
});
