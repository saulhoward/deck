import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validNativeRequest, validNativeReply, validCancellationId } from "./native-contracts.js";
const fixtures = JSON.parse(await readFile(new URL("../../src/native_contracts.test.json", import.meta.url), "utf8"));
const { bases } = JSON.parse(await readFile(new URL("../../src/contracts.test.json", import.meta.url), "utf8"));
test("native request/result/progress semantic fixtures agree with Zig", () => {
  for (const fixture of fixtures) {
    const request = { version: 1, id: "1", machineId: "worker", cwd: "/saved", operation: "read", args: { path: "x" }, ...fixture.set };
    if (fixture.planSchema) request.args = { plan: JSON.stringify(bases[fixture.planSchema]) };
    const reply = { version: 1, id: request.id, ...fixture.reply };
    if (fixture.repeat) (fixture.reply ? reply.progress : request.args)[fixture.repeat.field] = fixture.repeat.text.repeat(fixture.repeat.count);
    if (fixture.reply) {
      assert.ok(validNativeRequest(request), fixture.name);
      assert.equal(validNativeReply(request, reply), fixture.valid, fixture.name);
    } else assert.equal(validNativeRequest(request), fixture.valid, fixture.name);
  }
});
test("native contracts reject JS-only malformed values and bound binary cancellation identities", () => {
  const request = { version: 1 as const, id: "1", machineId: "worker", cwd: "/saved", operation: "read" as const, args: { path: "x" } };
  assert.ok(validNativeRequest(request));
  for (const path of ["\ud800", undefined, NaN]) assert.equal(validNativeRequest({ ...request, args: { path } }), false);
  for (const exitCode of [Infinity, NaN, 1.5, -1]) assert.equal(validNativeReply(request, { version: 1, id: "1", result: { ok: false, output: "", exitCode } }), false);
  assert.equal(validNativeReply(request, { version: 1, id: "1", result: { ok: true, output: "\ud800" } }), false);
  for (const id of ["1", "9007199254740991", "9223372036854775808", "18446744073709551615"]) assert.ok(validCancellationId(id));
  for (const id of ["0", "01", "-1", "1e0", "progress:1", "9007199254740992", "9223372036854775807", "18446744073709551616"]) assert.equal(validCancellationId(id), false);
});
