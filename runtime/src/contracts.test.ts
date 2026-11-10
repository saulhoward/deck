import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as contracts from "./generated/contracts.js";

type Fixture = { name: string; schema: string; valid: boolean; value?: unknown; set?: Record<string, unknown>; remove?: string[]; repeat?: { field: string; text: string; count: number }; repeatItems?: number; repeatField?: string };
test("schema-derived TypeScript validators consume the shared positive and negative corpus", async () => {
  const fixtures = JSON.parse(await readFile(new URL("../../src/contracts.test.json", import.meta.url), "utf8")) as { bases: Record<string, unknown>; cases: Fixture[] };
  for (const fixture of fixtures.cases) {
    const value: unknown = structuredClone(Object.hasOwn(fixture, "value") ? fixture.value : fixtures.bases[fixture.schema]);
    const record = value as Record<string, unknown>;
    if (fixture.set) Object.assign(record, fixture.set);
    for (const field of fixture.remove ?? []) delete record[field];
    if (fixture.repeat) record[fixture.repeat.field] = fixture.repeat.text.repeat(fixture.repeat.count);
    if (fixture.repeatItems !== undefined) { const field = fixture.repeatField ?? "items"; record[field] = Array.from({ length: fixture.repeatItems }, () => structuredClone((record[field] as unknown[])[0])); }
    const valid = contracts[`valid${fixture.schema}` as keyof typeof contracts];
    assert.equal(typeof valid, "function");
    assert.equal(valid(value), fixture.valid, fixture.name);
    if (fixture.valid) assert.equal(valid(JSON.parse(JSON.stringify(value))), true, `round trip: ${fixture.name}`);
  }
});

test("invalid JS-only strings/numbers and malformed JSON never become typed contracts", () => {
  for (const id of ["\ud800", "\udfff", undefined, false]) assert.equal(contracts.validRequestEnvelope({ version: 1, id, command: "status" }), false);
  for (const version of [NaN, Infinity, -Infinity, 1.5]) assert.equal(contracts.validRequestEnvelope({ version, id: "id", command: "status" }), false);
  for (const version of ["1", "1.0", "1e0"]) assert.equal(contracts.validRequestEnvelope(JSON.parse(`{"version":${version},"id":"id","command":"status"}`)), true);
  assert.throws(() => JSON.parse("{"));
});
