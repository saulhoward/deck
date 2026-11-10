import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { failurePolicy } from "./command-policy.js";
import { validCommandArgs, validClientRequest } from "./command-contracts.js";
import { HubError, responseResult } from "./responses.js";
const load = async (name: string) => JSON.parse(await readFile(new URL(`../../src/${name}.test.json`, import.meta.url), "utf8"));
const policies = await load("command_policy"), args = await load("command_args");
const { bases } = await load("contracts");
test("client failure policies agree with Zig, including unknown codes and commands", () => {
  for (const { command, code, source, outcome, action } of policies) {
    assert.deepEqual(failurePolicy(command, code, source), { outcome, action, preserveDrafts: true, automaticMutationRetry: false });
  }
  for (const command of ["admit", "create_task", "import_instructions", "rex_open", "stop", "login_start", "login_reply", "login_cancel", "rex_startup", "future_command"]) {
    for (const code of ["invalid", "offline", "busy", "auth_required", "conflict", "too_large", "invalid_response", "runtime_failed", "settings_changed", "future_error"]) {
      const request = { command, args: {} };
      assert.throws(() => responseResult({ version: 1, id: "t", ok: false, error: { code, message: "uncertain" } }, "t", request), (error: unknown) => {
        assert.ok(error instanceof HubError); assert.equal(error.code, code);
        assert.equal(error.policy.outcome, "unconfirmed"); assert.equal(error.policy.preserveDrafts, true); assert.equal(error.policy.automaticMutationRetry, false); return true;
      });
    }
  }
});
test("client command argument fixtures agree with Zig, including legacy UTF-16 budgets", () => {
  for (const fixture of args) {
    const value = structuredClone(fixture.schema ? bases[fixture.schema] : fixture.args);
    if (fixture.repeat) value[fixture.repeat.field] = fixture.repeat.text.repeat(fixture.repeat.count);
    assert.equal(validCommandArgs(fixture.command, value), fixture.valid, fixture.command);
  }
  assert.throws(() => responseResult({ version: 1, id: "t", ok: true, result: {} }, "t", { command: "future_command" }), /Invalid command acknowledgement/);
  const request = { version: 1, id: "t", command: "stop", args: { chatId: "1" } };
  assert.ok(validClientRequest(request));
  assert.ok(validClientRequest({ ...request, hubId: "hub" }));
  for (const hubId of [null, {}, "", "🌍".repeat(101)]) {
    assert.equal(validClientRequest({ ...request, hubId }), false);
    assert.throws(() => responseResult({ version: 1, id: "t", ok: true, result: { requested: true } }, "t", { ...request, hubId }), /Invalid command acknowledgement/);
  }
});
