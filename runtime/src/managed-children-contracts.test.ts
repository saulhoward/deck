import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validManagedChildren } from "./view-contracts.js";
import { validReply } from "./tui-session.js";
import { validSubagentViewArgs } from "./subagent-view-contracts.js";

const item = { chatId: "3", title: "Own problem", status: { state: "working", settledTaskId: "9" } };
const children = { chatId: "2", items: [item], hasMore: false };
test("managed child guard rejects JS-only invalid samples and pins its own parent independently", () => {
  const before = structuredClone(children);
  assert.equal(validManagedChildren(children), true);
  assert.equal(validManagedChildren(children, "2"), true);
  assert.equal(validManagedChildren(children, "1"), false);
  assert.equal(validManagedChildren({ ...children, chatId: "9007199254740992", items: [] }), false);
  for (const title of ["\ud800", "\udfff", "ok\ud800end"]) assert.equal(validManagedChildren({ ...children, items: [{ ...item, title }] }), false);
  for (const items of [new Array(1), [undefined], [item, , item]]) assert.equal(validManagedChildren({ ...children, items }), false);
  assert.deepEqual(children, before);
});

test("managed samples are unavailable in captured inspection and never extend closed inspection options", async () => {
  const { bases } = JSON.parse(await readFile(new URL("../../src/contracts.test.json", import.meta.url), "utf8"));
  for (const clientMode of ["hub", "task"]) {
    for (const parent of ["1", "2", "4"]) {
      const response = { version: 1, id: "1", ok: true, snapshot: { ...bases.TuiSnapshot, clientMode, chatId: "2", hubChatId: "1", kind: "task", children: { ...children, chatId: parent, items: [{ ...item, chatId: "5" }] } } };
      assert.equal(validReply(response, "1", "hub", "2"), parent === "2");
      assert.equal(validReply(response, "1", "hub"), parent === "2");
    }
    const response = { version: 1, id: "1", ok: true, snapshot: { ...bases.TuiSnapshot, clientMode, chatId: "3", hubChatId: "1", kind: "subagent", inspectParentChatId: "2", children: { chatId: "3", items: [], hasMore: false } } };
    assert.equal(validReply(response, "1", "hub", "3"), false);
    delete response.snapshot.children;
    assert.equal(validReply(response, "1", "hub", "3"), true);
  }
  for (const operation of ["history", "activity"]) {
    const args = { chatId: "2", childId: "3", operation, options: { includeSubagents: true } };
    assert.equal(validSubagentViewArgs(args), true);
    for (const includeChildren of [true, false]) assert.equal(validSubagentViewArgs({ ...args, options: { ...args.options, includeChildren } }), false);
  }
});

test("includeChildren does not broaden the existing self-scoped read allowlist", async () => {
  const { attachedRequest } = await import("./attachment-contracts.js");
  for (const command of ["history", "activity"]) {
    const body = (chatId: string) => JSON.stringify({ version: 1, id: "1", hubId: "hub", command, args: { chatId, includeChildren: true } });
    assert.ok(attachedRequest(body("2"), "2", "hub"));
    for (const foreign of ["1", "3"]) assert.equal(attachedRequest(body(foreign), "2", "hub"), undefined);
  }
  assert.equal(attachedRequest(JSON.stringify({ version: 1, id: "1", hubId: "hub", command: "list_chats", args: { chatId: "2", includeChildren: true } }), "2", "hub"), undefined);
});
