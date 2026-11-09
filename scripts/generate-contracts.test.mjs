import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import test from "node:test";
import { compileSchema, patternTokens } from "./generate-contracts.mjs";

const schema = JSON.parse(readFileSync(new URL("../contracts/wire.schema.json", import.meta.url), "utf8"));
test("contract generation is deterministic and independent of object identity", () => {
  const first = compileSchema(schema); const second = compileSchema(structuredClone(schema));
  assert.deepEqual(second, first);
  assert.match(first.ts, /export type RequestEnvelope/);
  assert.match(first.zig, /pub fn parseRexAllocationPlan/);
});

test("unsupported schemas fail generation instead of dropping constraints", () => {
  const mutations = [
    (s) => { s.$schema = "future"; },
    (s) => { s.$ref = "https://example.invalid/remote"; },
    (s) => { s.$defs.TransportId.format = "uuid"; },
    (s) => { s.$defs.TransportId.minLength = -1; },
    (s) => { s.$defs.TransportId.maxLength = 0; },
    (s) => { s.$defs.TransportId.type = "array"; },
    (s) => { s.$defs.RequestEnvelope.additionalProperties = {}; },
    (s) => { s.$defs.RequestEnvelope.required.push("absent"); },
    (s) => { s.$defs.TransportId.$ref = "#/$defs/ChatId"; },
    (s) => { s.$defs.ChatId = { $ref: "#/$defs/ChatId" }; },
    (s) => { s.$defs.ChatId = { $ref: "#/$defs/Missing" }; },
    (s) => { s.$defs.ChatId = { enum: ["1", "2"] }; },
    (s) => { s.$defs.ChatId = { type: "integer", minimum: 0, maximum: 9007199254740992 }; },
    (s) => { s.$defs.NullableRexUuid.anyOf[1].type = "boolean"; },
  ];
  for (const mutation of mutations) {
    const copy = structuredClone(schema); mutation(copy);
    assert.throws(() => compileSchema(copy), /^Error: Contract schema:/);
  }
});

test("object oneOf requires a provably disjoint required scalar discriminator", () => {
  const output = compileSchema(schema);
  assert.match(output.ts, /export type ResponseEnvelope = SuccessResponse \| ErrorResponse/);
  assert.match(output.zig, /pub const ResponseEnvelope = union\(enum\)/);
  assert.match(output.zig, /pub fn jsonParseFromValue/);
  for (const mutation of [
    (s) => { s.$defs.ErrorResponse.properties.ok.const = true; },
    (s) => { s.$defs.ErrorResponse.required = s.$defs.ErrorResponse.required.filter((key) => key !== "ok"); },
    (s) => { s.$defs.ErrorResponse.properties.ok = { type: "boolean" }; },
    (s) => { s.$defs.ResponseEnvelope.oneOf.push({ type: "null" }); },
    (s) => { s.$defs.ResponseEnvelope.oneOf.length = 1; },
    (s) => { s.$defs.ResponseEnvelope.oneOf = Array(9).fill({ $ref: "#/$defs/SuccessResponse" }); },
    (s) => { s.$defs.ResponseEnvelope.oneOf[0] = { $ref: "#/$defs/ResponseEnvelope" }; },
  ]) { const copy = structuredClone(schema); mutation(copy); assert.throws(() => compileSchema(copy), /^Error: Contract schema:/); }
});

test("identifier string enums generate native enums and closed executable guards", () => {
  const output = compileSchema(schema);
  assert.match(output.ts, /export type RexPresenceState = "unavailable" \| "identity_changed"/);
  assert.match(output.zig, /pub const RexPresenceState = enum/);
  assert.match(output.ts, /export type AdmissionMode = "steer" \| "followUp"/);
  assert.match(output.zig, /@"followUp"/);
  for (const values of [[], ["pending", "pending"], ["pending", 1], ["bad-value"], ["pending\n"]]) {
    const copy = structuredClone(schema); copy.$defs.RexPresenceState.enum = values;
    assert.throws(() => compileSchema(copy), /^Error: Contract schema:/);
  }
});

test("bounded homogeneous arrays require supported items/limits and reject unsupported constraints", () => {
  for (const change of [
    { maxItems: undefined }, { maxItems: -1 }, { maxItems: 4097 }, { maxItems: 1.5 },
    { minItems: -1 }, { minItems: 101 }, { minItems: 0.5 },
    { items: undefined }, { items: false }, { items: [] }, { items: { $ref: "#/$defs/ChatListItems" } },
    { uniqueItems: true }, { prefixItems: [] }, { contains: {} },
  ]) {
    const copy = structuredClone(schema); Object.assign(copy.$defs.ChatListItems, change);
    // Undefined is not valid authored JSON: remove it to exercise missing keys.
    const encoded = JSON.parse(JSON.stringify(copy));
    assert.throws(() => compileSchema(encoded), /^Error: Contract schema:/);
  }
});

test("array minimum/maximum, nullable elements and absent nonnullable optional codecs execute in both languages", async () => {
  const probe = {
    $schema: schema.$schema, $id: "https://deck.invalid/compiler-array-test", $ref: "#/$defs/BoundedArray",
    $defs: {
      BoundedArray: { type: "array", items: { anyOf: [{ type: "integer", minimum: -2, maximum: 2 }, { type: "null" }] }, minItems: 1, maxItems: 3 },
      Wrapper: { type: "object", properties: { values: { $ref: "#/$defs/BoundedArray" }, legacy: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: [], additionalProperties: false },
    },
  };
  const output = compileSchema(probe);
  const javascript = ts.transpileModule(output.ts, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
  const guards = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
  for (const value of [[1], [null, 2, -2]]) assert.equal(guards.validBoundedArray(value), true);
  for (const value of [[], [1, 2, 1, 2], [3], [1.5], ["1"], new Array(2)]) assert.equal(guards.validBoundedArray(value), false);
  assert.equal(guards.validWrapper({}), true); assert.equal(guards.validWrapper({ values: null }), false);
  const directory = mkdtempSync(join(tmpdir(), "deck-array-compiler-"));
  try {
    writeFileSync(join(directory, "contracts.zig"), output.zig);
    writeFileSync(join(directory, "probe.zig"), `const std = @import("std"); const c = @import("contracts.zig");
      test "bounded array and optional field projections" {
        const a = std.testing.allocator;
        for ([_][]const u8{"[1]", "[null,2,-2]"}) |encoded| {
          const parsed = try c.parseBoundedArray(a, encoded); defer parsed.deinit();
          const bytes = try std.json.Stringify.valueAlloc(a, parsed.value, .{}); defer a.free(bytes);
          const again = try c.parseBoundedArray(a, bytes); defer again.deinit();
        }
        for ([_][]const u8{"[]", "[1,2,1,2]", "[3]", "[1.5]", "[\\\"1\\\"]"}) |encoded| {
          try std.testing.expectError(error.InvalidContract, c.parseBoundedArray(a, encoded));
        }
        const parsed = try c.parseWrapper(a, "{}"); defer parsed.deinit();
        const bytes = try std.json.Stringify.valueAlloc(a, parsed.value, .{}); defer a.free(bytes);
        try std.testing.expectEqualStrings("{\\\"legacy\\\":null}", bytes);
        const again = try c.parseWrapper(a, bytes); defer again.deinit();
        try std.testing.expectError(error.InvalidContract, c.parseWrapper(a, "{\\\"values\\\":null}"));
      }`);
    execFileSync("zig", ["test", "probe.zig"], { cwd: directory, stdio: "pipe", timeout: 60_000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("pattern subset is anchored, bounded and unambiguous in both languages", () => {
  assert.deepEqual(patternTokens("^[a-c]{2}x[0-9]{0,2}$(?![\\s\\S])"), [
    { chars: "abc", min: 2, max: 2 }, { chars: "x", min: 1, max: 1 }, { chars: "0123456789", min: 0, max: 2 },
  ]);
  for (const pattern of ["uuid", "^x$", "^.*$(?![\\s\\S])", "^[a-z]{0,2}x$(?![\\s\\S])", "^[^x]$(?![\\s\\S])", "^x{4097}$(?![\\s\\S])", "^[z-a]$(?![\\s\\S])"]) assert.throws(() => patternTokens(pattern));
});
