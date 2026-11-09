import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { DeckRuntime } from "./deck.js";
import { validAdmitArgs, validInstructionImportAck, validPiId } from "./generated/contracts.js";
import { serveIpc } from "./ipc.js";
import { validMutationAck, validMutationArgs, validSafePiId } from "./mutation-contracts.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
import { responseFrame, responseResult } from "./responses.js";

const args = {
  admit: { chatId: "2", requestId: "original-input", text: "Original input", mode: "followUp" },
  create_task: { requestId: "original-create", title: "Original task", machineId: "offline-original", cwd: "/original" },
  import_instructions: { chatId: "2", requestId: "original-import", machineId: "offline-original", cwd: "/original" },
};
const acks = { admit: { submissionId: "9" }, create_task: { chatId: "3" }, import_instructions: { chatId: "2", requestId: "original-import", taskId: "9", admitted: true, completion: "not_waited" } };
const commands = ["admit", "create_task", "import_instructions"] as const;

test("generated mutation arguments retain safe-ID/legacy UTF-16 semantic caps without pretending to validate authority", () => {
  for (const command of commands) assert.equal(validMutationArgs(command, args[command]), true);
  assert.equal(validPiId("9007199254740992"), true); assert.equal(validSafePiId("9007199254740992"), false);
  for (const id of ["0", 2, "2\n", "02", "2e0", "9007199254740992"]) assert.equal(validMutationArgs("admit", { ...args.admit, chatId: id }), false);
  const unicode = { ...args.admit, requestId: "🤖".repeat(101) };
  assert.equal(validAdmitArgs(unicode), true); assert.equal(validMutationArgs("admit", unicode), false);
  const text = { ...args.admit, text: "🤖".repeat(100001) };
  assert.equal(validAdmitArgs(text), true); assert.equal(validMutationArgs("admit", text), false);
  assert.equal(validMutationArgs("admit", { ...args.admit, text: "\ud800" }), false);
  // Nonblank input, cwd coherence, ownership, online worker and admission remain
  // runtime checks, not inferred from shape. Legacy extensions are never copied.
  assert.equal(validMutationArgs("admit", { ...args.admit, text: "   ", origin: { kind: "forged" } }), true);
  assert.equal(validMutationArgs("create_task", { ...args.create_task, cwd: "relative", ignored: true }), true);
  assert.equal(validMutationArgs("import_instructions", { ...args.import_instructions, path: "other.md" }), false);
});

test("command ACKs need generated shape, lossless safe IDs and exact import identity, not just a valid envelope", () => {
  for (const command of commands) {
    const context = { command, args: args[command] }, result = acks[command];
    assert.equal(validMutationAck(context, result), true);
    assert.deepEqual(responseResult({ version: 1, id: "transport", ok: true, result }, "transport", context), result);
    const field = command === "admit" ? "submissionId" : command === "create_task" ? "chatId" : "taskId";
    for (const id of ["0", 9, "9\n", "09", "9e0", "9007199254740992", null]) {
      const invalid = { ...result, [field]: id };
      assert.equal(validMutationAck(context, invalid), false);
      assert.throws(() => responseResult({ version: 1, id: "transport", ok: true, result: invalid }, "transport", context), /Invalid acknowledgement/);
      const frame = responseFrame({ version: 1, id: "transport", ok: true, result: invalid }, context);
      assert.equal(JSON.parse(frame.subarray(4).toString()).error.code, "invalid_response");
    }
    assert.equal(validMutationAck(context, { ...result, private: "PRIVATE" }), false);
  }
  for (const change of [{ chatId: "3" }, { requestId: "other-import" }]) {
    const result = { ...acks.import_instructions, ...change };
    assert.equal(validInstructionImportAck(result), true);
    assert.equal(validMutationAck({ command: "import_instructions", args: args.import_instructions }, result), false);
  }
});

test("IPC refuses invalid mutation args before dispatch and invalid post-commit ACKs without redispatch or diagnostics", async () => {
  const calls: unknown[][] = [];
  let invalidAck = false;
  const runtime = {
    admit: async (...values: unknown[]) => { calls.push(values); return { id: invalidAck ? 0 : 9 }; },
    createTask: async (...values: unknown[]) => { calls.push(values); return { id: invalidAck ? "PRIVATE_BAD_ID" : 3 }; },
    importInstructions: async (...values: unknown[]) => { calls.push(values); return invalidAck ? 9007199254740992 : 9; },
  } as unknown as DeckRuntime;
  const input = new PassThrough(), output = new PassThrough(), decoder = output.pipe(new FrameDecoder()); const frames = decoder[Symbol.asyncIterator]();
  const serving = serveIpc(runtime, input, output); let count = 0;
  const command = async (command: string, args: unknown) => {
    const id = String(++count); input.write(encodeFrame({ version: 1, id, command, args }));
    const value = (await frames.next()).value as { id: string; ok: boolean; result: unknown; error: { code: string } };
    assert.equal(value.id, id); assert.doesNotMatch(JSON.stringify(value), /PRIVATE_BAD_ID/); return value;
  };
  try {
    for (const name of commands) for (const invalid of [null, [], {}, { ...args[name], requestId: 123 }, { ...args[name], requestId: "x".repeat(201) }]) {
      const response = await command(name, invalid); assert.equal(response.ok, false); assert.equal(response.error.code, "invalid");
    }
    assert.equal(calls.length, 0);
    const extras = { ...args.admit, origin: { kind: "forged" }, ignored: "PRIVATE" };
    assert.deepEqual((await command("admit", extras)).result, acks.admit);
    assert.deepEqual(calls[0], ["2", { requestId: "original-input", text: "Original input", mode: "followUp" }]);
    assert.deepEqual((await command("create_task", { ...args.create_task, ignored: "PRIVATE" })).result, acks.create_task);
    assert.deepEqual(calls[1], ["Original task", { machineId: "offline-original", cwd: "/original" }, "original-create"]);
    assert.deepEqual((await command("import_instructions", args.import_instructions)).result, acks.import_instructions);
    invalidAck = true;
    for (const name of commands) {
      const before: number = calls.length; const response = await command(name, args[name]);
      assert.equal(calls.length, before + 1); assert.equal(response.ok, false); assert.equal(response.error.code, "invalid_response");
    }
  } finally { input.end(); await serving; decoder.destroy(); output.destroy(); }
});
