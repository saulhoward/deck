import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { encodeFrame, FrameDecoder } from "./protocol.js";

const binary = process.env.DECK_TEST_BINARY;
test("Zig init/supervisor: private state, IPC, reopen and inherited lock after supervisor death", { skip: !binary, timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-supervisor-"));
  const state = join(directory, "new-state");
  const invoke = (...args: string[]) => spawnSync(binary!, [...args, "--directory", state], { encoding: "utf8" });
  const launch = () => spawn(binary!, ["serve", "--stdio", "--mock", "--directory", state, "--runtime", resolve("runtime/dist/main.js")], { stdio: ["pipe", "pipe", "pipe"] });
  let writer: ReturnType<typeof launch> | undefined;
  try {
    assert.equal(invoke("init").status, 0);
    const config = await readFile(join(state, "config.json"), "utf8");
    assert.equal(invoke("init").status, 0);
    assert.equal(await readFile(join(state, "config.json"), "utf8"), config);
    assert.equal((await stat(state)).mode & 0o777, 0o700);
    assert.equal((await stat(join(state, "config.json"))).mode & 0o777, 0o600);
    writer = launch();
    const frames = writer.stdout.pipe(new FrameDecoder());
    const values = frames[Symbol.asyncIterator]();
    const rawRequest = async (id: string, command: string, args = {}) => {
      writer!.stdin.write(encodeFrame({ version: 1, id, command, args }));
      const frame = await values.next();
      assert.equal(frame.value.id, id);
      return frame.value;
    };
    const request = async (id: string, command: string, args = {}) => {
      const frame = await rawRequest(id, command, args);
      assert.equal(frame.ok, true);
      return frame.result;
    };
    const status = await request("status", "status");
    const chatId = status.mainChatId;
    const first = await request("a", "admit", { chatId, requestId: "durable-1", mode: "followUp", text: "Hello" });
    const retry = await request("b", "admit", { chatId, requestId: "durable-1", mode: "followUp", text: "Hello" });
    assert.equal(first.submissionId, retry.submissionId);
    const conflict = await rawRequest("conflict", "admit", { chatId, requestId: "durable-1", mode: "followUp", text: "Different" });
    assert.equal(conflict.ok, false); assert.equal(conflict.error.code, "conflict");
    const invalid = await rawRequest("invalid", "admit", { chatId, requestId: "new", mode: "bad", text: "Hello" });
    assert.equal(invalid.error.code, "invalid");
    assert.equal((await rawRequest("unknown", "unknown")).error.code, "invalid");
    const blocked = invoke("serve", "--stdio", "--mock");
    assert.notEqual(blocked.status, 0); assert.match(blocked.stderr, /running writer/);
    const exited = once(writer, "exit");
    writer.kill("SIGKILL");
    await exited;
    // Node still owns the inherited lock even though Zig is gone.
    const stillBlocked = invoke("serve", "--stdio", "--mock");
    assert.notEqual(stillBlocked.status, 0); assert.match(stillBlocked.stderr, /running writer/);
    writer.stdin.end();
    // EOF closes the writer; stdout closes only when that orphan child has exited.
    while (!(await values.next()).done) { /* drain */ }
    writer = launch();
    const reopened = writer.stdout.pipe(new FrameDecoder())[Symbol.asyncIterator]();
    writer.stdin.write(encodeFrame({ version: 1, id: "reopen", command: "status" }));
    assert.equal((await reopened.next()).value.result.mainChatId, chatId);
    const closed = once(writer, "close"); writer.stdin.end();
    const [code] = await closed; assert.equal(code, 0);
  } finally {
    writer?.stdin.end();
    await rm(directory, { recursive: true, force: true });
  }
});
