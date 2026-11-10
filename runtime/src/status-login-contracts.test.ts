import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";
import { validStatusLoginArgs, validStatusLoginReply } from "./status-login-contracts.js";
import { projectLoginEvent, projectLoginPrompt } from "./login-view.js";
import { loginJson } from "./login-client.js";
import { responseFrame, responseResult } from "./responses.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { serveIpc } from "./ipc.js";
import { Login } from "./login.js";
const fixtures = JSON.parse(await readFile(new URL("../../src/status_login.test.json", import.meta.url), "utf8")) as { name: string; command: string; args?: unknown; hubId?: string; result: unknown; valid: boolean }[];

test("status/login shared fixtures validate serialized egress and client ingress", () => {
  for (const fixture of fixtures) {
    assert.equal(validStatusLoginReply(fixture, fixture.result), fixture.valid, fixture.name);
    const frame = responseFrame({ version: 1, id: "test", ok: true, result: fixture.result }, fixture);
    const reply = JSON.parse(frame.subarray(4).toString()); assert.equal(reply.ok, fixture.valid, fixture.name);
    if (fixture.valid) assert.deepEqual(responseResult(reply, "test", fixture), fixture.result);
    else {
      assert.equal(reply.error.code, "invalid_response"); assert.doesNotMatch(JSON.stringify(reply), /PRIVATE/);
      assert.throws(() => responseResult({ version: 1, id: "test", ok: true, result: fixture.result }, "test", fixture));
    }
  }
  for (const name of ["login_start", "login_reply", "login_cancel"]) {
    const args = { requestId: "🌍".repeat(100001), loginId: "🌍".repeat(100001), promptId: "p", answer: "a" };
    assert.equal(validStatusLoginArgs(name, args), false);
  }
  assert.equal(validStatusLoginArgs("login_reply", { loginId: "l", promptId: "p", answer: "🌍".repeat(100000) }), true);
  assert.equal(validStatusLoginArgs("login_reply", { loginId: "l", promptId: "p", answer: "\ud800" }), false);
  const request = { command: "login_reply", args: { loginId: "l", promptId: "p", answer: "a" } };
  const changed = { accepted: true, toJSON: () => ({ accepted: true, access: "PRIVATE" }) };
  const frame = responseFrame({ version: 1, id: "test", ok: true, result: changed }, request);
  assert.equal(JSON.parse(frame.subarray(4).toString()).error.code, "invalid_response");
});

test("login adapter whitelists provider fields, rejects malformed payloads, and escapes terminal controls", () => {
  const event = { type: "info" as const, message: "Allowed", access: "PRIVATE", links: [{ url: "https://example.invalid", label: "Login", refresh: "PRIVATE" }] };
  assert.deepEqual(projectLoginEvent(event), { type: "info", message: "Allowed", links: [{ url: "https://example.invalid", label: "Login" }] });
  const prompt = { type: "select" as const, message: "Choose", access: "PRIVATE", options: [{ id: "a", label: "One", description: "Public", token: "PRIVATE" }] };
  assert.deepEqual(projectLoginPrompt("p", prompt), { id: "p", type: "select", message: "Choose", options: [{ id: "a", label: "One", description: "Public" }] });
  assert.throws(() => projectLoginPrompt("p", { ...prompt, options: [...prompt.options, ...prompt.options] }));
  assert.throws(() => projectLoginEvent({ type: "progress", message: "x".repeat(200001) }));
  assert.throws(() => projectLoginEvent({ type: "info", message: "\ud800" }));
  const rendered = loginJson({ message: "\u001b]52;c;PRIVATE\u0007\u007f\u009b" });
  assert.doesNotMatch(rendered, /[\x00-\x1f\x7f-\x9f]/); assert.match(rendered, /\\u009b/);
});

test("status/login IPC validates before dispatch, projects metadata without rewriting it and preserves opaque Pi views", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-control-")); const { models } = provider();
  const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, binding: { machineId: "offline-worker", cwd: "/saved" }, implementation: IMPLEMENTATION, environment: () => undefined });
  const login = new Login(models, "machine"); let starts = 0;
  login.start = () => { starts++; return { status: "pending", id: "request", events: [], private: "PRIVATE" } as any; };
  try {
    const task = await runtime.createTask("Task", { machineId: "offline-worker", cwd: "/saved" });
    await task.commit(async (tx) => { Object.assign(await tx.doc(ChatDoc, task.id), { private: "PRIVATE" }); }, context);
    const requests = [
      { id: "main", command: "status", args: null },
      { id: "selected", command: "status", args: { chatId: String(task.id) } },
      { id: "bad-status", command: "status", args: { chatId: "9007199254740992" } },
      { id: "bad-start", command: "login_start", args: { requestId: null } },
      { id: "bad-reply", command: "login_reply", args: { loginId: "request", promptId: "p", answer: "" } },
      { id: "after-start", command: "login_start", args: { requestId: "request" } },
    ];
    const input = new PassThrough(), output = new PassThrough(); const replies: any[] = [];
    output.pipe(new FrameDecoder()).on("data", (reply) => replies.push(reply));
    input.end(Buffer.concat(requests.map((request) => encodeFrame({ version: 1, ...request }))));
    await serveIpc(runtime, input, output, login);
    assert.equal(replies.length, requests.length); assert.equal(starts, 1);
    for (const request of requests) {
      const reply = replies.find((value) => value.id === request.id);
      if (["main", "selected"].includes(request.id)) {
        assert.ok(reply.ok); assert.ok(validStatusLoginReply(request, reply.result));
        assert.equal(reply.result.implementation, runtime.implementation);
        assert.deepEqual(reply.result.activity, await runtime.harness.inspect(context));
      } else assert.equal(reply.error.code, request.id === "after-start" ? "invalid_response" : "invalid");
    }
    assert.doesNotMatch(JSON.stringify(replies), /PRIVATE/);
    assert.equal((await runtime.harness.snapshot(ChatDoc, task.id, context) as any).private, "PRIVATE");
    assert.deepEqual((await runtime.history(String(task.id))).items, []);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
