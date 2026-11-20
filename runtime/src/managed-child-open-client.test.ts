import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachedRequest } from "./attachment-contracts.js";
import { hubCommand, HubCallError } from "./hub-client.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { HubError } from "./responses.js";
import { taskCommand, taskScope } from "./task-client.js";

const hubId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const create = { parentChatId: "2", requestId: "saved-child", title: "Child", problem: " exact\n" };
const open = { chatId: "2", childId: "3", requestId, port: 52800 };
const ack = { parentChatId: "2", childId: "3", ack: { version: 1, chatId: "3", requestId, taskId: "9", status: "admitted", completion: "not_waited", bestEffort: true } };

test("launcher attachments admit only own-parent create/open with no target overrides or general terminal authority", () => {
  const request = (command: string, args: object, hub: unknown = hubId) => JSON.stringify({ version: 1, id: "scope", hubId: hub, command, args });
  for (const [command, args] of [["create_managed_child", create], ["open_managed_child", open]] as const) {
    const body = request(command, args);
    assert.ok(attachedRequest(body, "2", hubId));
    for (const chatId of ["1", "3", "9007199254740992"]) assert.equal(attachedRequest(body, chatId, hubId), undefined);
    assert.equal(attachedRequest(body, "2", requestId), undefined);
    assert.equal(attachedRequest(JSON.stringify({ version: 1, id: "scope", command, args }), "2", hubId), undefined);
    assert.equal(attachedRequest(request(command, args, null), "2", hubId), undefined);
    for (const override of [{ machineId: "a".repeat(32) }, { cwd: "/other" }, { target: {} }, { sessionId: `session:${hubId}` }]) {
      assert.equal(attachedRequest(request(command, { ...args, ...override }), "2", hubId), undefined);
    }
  }
  for (const [command, args] of [
    ["create_managed_child", { ...create, parentChatId: "1", chatId: "2" }],
    ["open_managed_child", { ...open, chatId: "1", parentChatId: "2" }],
    ["rex_open", { chatId: "2", requestId, port: 52800 }],
    ["create_task", { requestId, title: "Other", machineId: "worker", cwd: "/other", chatId: "2" }],
    ["list_hosts", {}],
  ] as const) assert.equal(attachedRequest(request(command, args), "2", hubId), undefined);
});

test("task socket uses parentChatId only for managed creation and retains the pinned parent on child open", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-child-scope-"));
  await chmod(root, 0o700);
  const path = join(root, "client.sock");
  const scope = taskScope(hubId, "2", requestId, `block:${requestId}`);
  const requests: { command: string; args: unknown }[] = [];
  const server = socketServer(socket => {
    const decoder = new FrameDecoder(); socket.pipe(decoder);
    decoder.once("data", frame => {
      assert.deepEqual(frame.scope, scope);
      const request = JSON.parse(frame.body); requests.push(request);
      socket.end(encodeFrame({ version: 1, id: request.id, ok: true, result: request.command === "create_managed_child" ? { parentChatId: "2", chatId: "3", brief: { problem: create.problem } } : ack }));
    });
  });
  server.listen(path); await once(server, "listening");
  try {
    await taskCommand(path, scope, "create_managed_child", create, hubId);
    assert.deepEqual(await taskCommand(path, scope, "open_managed_child", open, hubId), ack);
    assert.deepEqual(requests.map(r => r.args), [create, open]);
    for (const [command, args] of [
      ["create_managed_child", { ...create, parentChatId: "1" }],
      ["create_managed_child", { ...create, parentChatId: "3" }],
      ["create_managed_child", { ...create, machineId: "a".repeat(32) }],
      ["open_managed_child", { ...open, chatId: "1" }],
      ["open_managed_child", { ...open, chatId: "3", childId: "4" }],
      ["open_managed_child", { ...open, cwd: "/override" }],
    ] as const) await assert.rejects(taskCommand(path, scope, command, args, hubId), (error: unknown) => {
      assert.ok(error instanceof HubCallError); assert.equal(error.policy.outcome, "not_sent"); return true;
    });
    assert.equal(requests.length, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test("child-open HTTP errors and corrupt ACKs require terminal inspection and are never replayed", async () => {
  let mode = "ok", count = 0;
  const server = httpServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString()); count++;
    assert.equal(request.command, "open_managed_child"); assert.deepEqual(request.args, open); assert.equal(request.hubId, hubId);
    if (mode === "lost") { res.destroy(); return; }
    if (mode === "http") { res.writeHead(503); res.end("PRIVATE"); return; }
    if (mode === "remote") { res.end(JSON.stringify({ version: 1, id: request.id, ok: false, error: { code: "conflict", message: "Inspect terminal" } })); return; }
    const result = structuredClone(ack);
    if (mode === "wrong-parent") result.parentChatId = "1";
    if (mode === "wrong-child") result.ack.chatId = "2";
    if (mode === "wrong-request") result.ack.requestId = hubId;
    if (mode === "unsafe-task") result.ack.taskId = "9007199254740992";
    res.end(JSON.stringify({ version: 1, id: mode === "wrong-id" ? "other" : request.id, ok: true, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    assert.deepEqual(await hubCommand(address.port, "open_managed_child", open, hubId), ack);
    for (mode of ["lost", "http", "remote", "wrong-parent", "wrong-child", "wrong-request", "unsafe-task", "wrong-id"]) {
      const before = count;
      await assert.rejects(hubCommand(address.port, "open_managed_child", open, hubId), (error: unknown) => {
        assert.ok(error instanceof HubCallError || error instanceof HubError);
        assert.deepEqual(error.policy, { outcome: "unconfirmed", action: "inspect_terminal", preserveDrafts: true, automaticMutationRetry: false });
        assert.doesNotMatch(error.message, /PRIVATE/); return true;
      });
      assert.equal(count, before + 1);
    }
    const before = count;
    for (const hub of [undefined, "hub", ""]) await assert.rejects(hubCommand(address.port, "open_managed_child", open, hub), (error: unknown) => {
      assert.ok(error instanceof HubCallError); assert.equal(error.policy.outcome, "not_sent"); return true;
    });
    assert.equal(count, before);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
