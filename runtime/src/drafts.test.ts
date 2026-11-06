import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DraftStore, type Draft } from "./drafts.js";
import { clientEnv } from "./client.test.env.js";

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
