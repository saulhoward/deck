import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validActivity, validLiveArgs, validSubagents } from "./view-contracts.js";
import { validReply } from "./tui-session.js";

const child = { chatId: "3", title: "Helper", status: { state: "working", settledTaskId: "9" } };
const subagents = { chatId: "2", items: [child], hasMore: false };

test("standalone subagent guard binds optional parent scope and rejects JS-only malformed data without rewriting", () => {
  const before = structuredClone(subagents);
  assert.equal(validSubagents(subagents), true);
  assert.equal(validSubagents(subagents, "2"), true);
  assert.equal(validSubagents(subagents, "1"), false);
  assert.equal(validSubagents({ ...subagents, chatId: "9007199254740992", items: [] }), false);
  for (const title of ["\ud800", "\udfff", "ok\ud800end"]) {
    assert.equal(validSubagents({ ...subagents, items: [{ ...child, title }] }), false);
  }
  for (const items of [new Array(1), [undefined], [child, , child]]) {
    assert.equal(validSubagents({ ...subagents, items }), false);
  }
  assert.deepEqual(subagents, before);
});

test("shared subagent semantics also fence runtime renderer replies, including unpinned and selected task scopes", async () => {
  const { bases } = JSON.parse(await readFile(new URL("../../src/contracts.test.json", import.meta.url), "utf8"));
  const fixtures = JSON.parse(await readFile(new URL("../../src/views.test.json", import.meta.url), "utf8"));
  for (const fixture of fixtures) {
    const field = fixture.name.startsWith("children ") ? "children" : "subagents";
    if (!fixture.name.startsWith(`${field} `)) continue;
    const args = fixture.args ?? {};
    if (!validLiveArgs(args) || (args.chatId !== undefined && args.chatId !== fixture.result.chatId)) continue;
    const snapshot = { ...bases.TuiSnapshot, chatId: fixture.result.chatId };
    if (Object.hasOwn(fixture.result, field)) snapshot[field] = fixture.result[field];
    const response = { version: 1, id: "1", ok: true, snapshot };
    const before = JSON.stringify(response);
    assert.equal(validActivity(fixture.result), fixture.valid, fixture.name);
    assert.equal(validReply(response, "1", "hub"), fixture.valid, `unpinned: ${fixture.name}`);
    assert.equal(validReply(response, "1", "hub", snapshot.chatId), fixture.valid, `pinned: ${fixture.name}`);
    assert.equal(JSON.stringify(response), before);
  }
  for (const clientMode of ["hub", "task"]) {
    for (const parent of ["1", "2", "4"]) {
      const response = { version: 1, id: "1", ok: true, snapshot: {
        ...bases.TuiSnapshot, clientMode, chatId: "2", hubChatId: "1",
        subagents: { ...subagents, chatId: parent, items: [{ ...child, chatId: "5" }] },
      } };
      assert.equal(validReply(response, "1", "hub", "2"), parent === "2");
      assert.equal(validReply(response, "1", "hub"), parent === "2");
    }
  }
});
