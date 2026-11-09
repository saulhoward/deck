import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { DeckRuntime } from "./deck.js";
import { validRexStartupAck } from "./generated/contracts.js";
import { serveIpc } from "./ipc.js";
import { within } from "./instructions.test.support.js";
import { validMutationAck, validMutationArgs } from "./mutation-contracts.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { responseFrame, responseResult } from "./responses.js";

const allocation = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
const startup = { chatId: "2", allocationId: allocation, blockId: `block:${allocation}` };
const ack = { version: 1, ...startup, taskId: "9", registered: true, observation: "unbound", historical: true, live: "not_checked" };

test("generated administrative ACKs preserve requested-vs-drained and historical-vs-live distinctions", () => {
  const stop = { command: "stop", args: { chatId: "2", legacyExtension: true } };
  assert.equal(validMutationArgs("stop", stop.args), true); assert.equal(validMutationAck(stop, { requested: true }), true);
  for (const value of [{}, { requested: false }, { requested: 1 }, { requested: true, drained: true }]) {
    assert.equal(validMutationAck(stop, value), false);
    assert.throws(() => responseResult({ version: 1, id: "stop", ok: true, result: value }, "stop", stop), /outcome unconfirmed/);
  }
  const request = { command: "rex_startup", hubId: "hub", args: startup };
  assert.equal(validMutationArgs("rex_startup", startup), true); assert.equal(validMutationAck(request, ack), true);
  for (const args of [{ ...startup, label: "not-provenance" }, { ...startup, chatId: "9007199254740992" }, { ...startup, allocationId: `${allocation}\n` }, { ...startup, blockId: "block:short" }]) assert.equal(validMutationArgs("rex_startup", args), false);
  for (const hubId of [undefined, "", 7, "x".repeat(201), "🤖".repeat(101), "\ud800"]) assert.equal(validMutationAck({ ...request, hubId }, ack), false);
  for (const change of [{ chatId: "3" }, { allocationId: other }, { blockId: `block:${other}` }]) {
    const value = { ...ack, ...change }; assert.equal(validRexStartupAck(value), true); assert.equal(validMutationAck(request, value), false);
  }
  for (const change of [{ taskId: "9007199254740992" }, { taskId: 9 }, { historical: false }, { live: "running" }, { observation: "conflict" }, { private: "PRIVATE" }]) {
    const value = { ...ack, ...change }; assert.equal(validMutationAck(request, value), false);
    assert.throws(() => responseResult({ version: 1, id: "startup", ok: true, result: value }, "startup", request), /Invalid Rex startup acknowledgement; no input sent/);
    const frame = responseFrame({ version: 1, id: "startup", ok: true, result: value }, request);
    assert.equal(JSON.parse(frame.subarray(4).toString()).error.code, "invalid_response"); assert.doesNotMatch(frame.toString(), /PRIVATE/);
  }
});

test("IPC validates admin args before mutation, stop ACK does not wait for drain, and startup post-commit failure never retries", async () => {
  const lookups: string[] = []; let stops = 0, registrations = 0, recorded: unknown;
  let release!: () => void; const draining = new Promise<void>((resolve) => { release = resolve; }); let drained = false;
  let invalidAck = false;
  const runtime = {
    hubId: "hub",
    chat: async (id: string) => { lookups.push(id); return { abort: async () => { stops++; await draining; drained = true; } }; },
    registerTerminalStartup: async (...args: unknown[]) => { registrations++; recorded = args; return invalidAck ? { ...ack, private: "PRIVATE" } : ack; },
  } as unknown as DeckRuntime;
  const input = new PassThrough(), output = new PassThrough(), decoder = output.pipe(new FrameDecoder()); const frames = decoder[Symbol.asyncIterator](); const serving = serveIpc(runtime, input, output); let count = 0;
  const command = async (command: string, args: unknown, hubId?: string) => {
    const id = String(++count); input.write(encodeFrame({ version: 1, id, command, args, ...(hubId === undefined ? {} : { hubId }) }));
    const response = (await within(frames.next())).value as { id: string; ok: boolean; result: unknown; error: { code: string } }; assert.equal(response.id, id); return response;
  };
  try {
    for (const args of [{}, { chatId: 2 }, { chatId: "2\n" }, { chatId: "9007199254740992" }]) assert.equal((await command("stop", args)).error.code, "invalid");
    assert.equal(stops, 0); assert.deepEqual(lookups, []);
    assert.deepEqual((await command("stop", { chatId: "2", ignored: "PRIVATE" })).result, { requested: true });
    assert.equal(stops, 1); assert.equal(drained, false); assert.deepEqual(lookups, ["2"]);
    for (const args of [{}, { ...startup, label: "not-provenance" }, { ...startup, blockId: "block:short" }]) assert.equal((await command("rex_startup", args, "hub")).error.code, "invalid");
    assert.equal((await command("rex_startup", startup)).error.code, "invalid");
    assert.equal((await command("rex_startup", startup, "another-hub")).error.code, "conflict"); assert.equal(registrations, 0);
    assert.deepEqual((await command("rex_startup", startup, "hub")).result, ack); assert.deepEqual(recorded, ["2", allocation, startup.blockId]);
    invalidAck = true;
    const response = await command("rex_startup", startup, "hub");
    assert.equal(response.error.code, "invalid_response"); assert.equal(registrations, 2); assert.deepEqual(recorded, ["2", allocation, startup.blockId]); assert.doesNotMatch(JSON.stringify(response), /PRIVATE/);
    assert.equal(stops, 1); assert.equal(drained, false);
  } finally { release(); input.end(); await serving; decoder.destroy(); output.destroy(); }
  assert.equal(drained, true); assert.equal(stops, 1); // EOF did not request another stop.
});
