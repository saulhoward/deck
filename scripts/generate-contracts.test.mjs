import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  for (const values of [[], ["pending", "pending"], ["pending", 1], ["bad-value"], ["pending\n"]]) {
    const copy = structuredClone(schema); copy.$defs.RexPresenceState.enum = values;
    assert.throws(() => compileSchema(copy), /^Error: Contract schema:/);
  }
});

test("pattern subset is anchored, bounded and unambiguous in both languages", () => {
  assert.deepEqual(patternTokens("^[a-c]{2}x[0-9]{0,2}$(?![\\s\\S])"), [
    { chars: "abc", min: 2, max: 2 }, { chars: "x", min: 1, max: 1 }, { chars: "0123456789", min: 0, max: 2 },
  ]);
  for (const pattern of ["uuid", "^x$", "^.*$(?![\\s\\S])", "^[a-z]{0,2}x$(?![\\s\\S])", "^[^x]$(?![\\s\\S])", "^x{4097}$(?![\\s\\S])", "^[z-a]$(?![\\s\\S])"]) assert.throws(() => patternTokens(pattern));
});
