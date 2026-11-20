import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validClientRequest } from "./command-contracts.js";
import { validDiscoveryPage } from "./discovery-contracts.js";
import { validStatusLoginReply } from "./status-login-contracts.js";
import { validMutationAck, type ReplyContext } from "./mutation-contracts.js";
import { validLaunchResponse } from "./launcher-contracts.js";
import { responseFrame, responseResult } from "./responses.js";
import { validForm } from "./task-brief.js";
import type { LauncherRequest, ResponseEnvelope } from "./generated/contracts.js";

type Fixture = { name: string; kind: string; request: ReplyContext; reply: ResponseEnvelope; value: Record<string, unknown>; valid: boolean };
const fixtures = JSON.parse(await readFile(new URL("../../src/managed_children.test.json", import.meta.url), "utf8")) as Fixture[];

test("managed child shared request, ACK correlation, metadata and form contracts", () => {
  for (const f of fixtures) {
    switch (f.kind) {
      case "request": assert.equal(validClientRequest(f.request), f.valid, f.name); break;
      case "reply": {
        if (f.valid) assert.deepEqual(responseResult(f.reply, "managed", f.request), f.reply.ok ? f.reply.result : undefined, f.name);
        else assert.throws(() => responseResult(f.reply, "managed", f.request), f.name);
        // Server serialization independently refuses an invalid ACK without
        // publishing private data or suggesting that the mutation rolled back.
        if (f.reply.id === "managed") {
          const encoded = JSON.parse(responseFrame(f.reply, f.request).subarray(4).toString());
          assert.equal(encoded.ok, f.valid, f.name);
          if (!f.valid) { assert.equal(encoded.error.code, "invalid_response"); assert.doesNotMatch(JSON.stringify(encoded), /PRIVATE/); }
        }
        break;
      }
      case "metadata": {
        assert.equal(validDiscoveryPage({ items: [f.value] }), f.valid, `discovery: ${f.name}`);
        const { chatId, ...binding } = f.value;
        assert.equal(validStatusLoginReply({ command: "status", args: { chatId }, hubId: "hub" }, { hubId: "hub", mainChatId: "1", chatId, tools: "offline", managedChildren: 1, binding }), f.valid, `status: ${f.name}`);
        break;
      }
      case "form": assert.equal(validForm(f.value), f.valid, f.name); break;
      default: assert.fail(`Unknown fixture: ${f.kind}`);
    }
  }
});

test("managed child acknowledgement needs a pinned identity even outside the composed reply guard", () => {
  const args = { requestId: "saved", parentChatId: "2", title: "Child" };
  const ack = { chatId: "3", parentChatId: "2", brief: {} };
  assert.equal(validMutationAck({ command: "create_managed_child", args }, ack), false);
  assert.equal(validMutationAck({ command: "create_managed_child", args, hubId: "hub" }, ack), true);
});

test("launcher task navigation links must be safe and precede their child", () => {
  const hubId = "00000000-0000-4000-8000-000000000001", machineId = "a".repeat(32);
  const request: LauncherRequest = { version: 1, id: hubId, command: "launch_list", args: {} };
  for (const parent of [undefined, "1", "2", "3", "4", "0", "9007199254740992"]) {
    const item = { chatId: "3", title: "Child", cwd: "/saved", ...(parent === undefined ? {} : { managedParentChatId: parent }) };
    const reply: unknown = { version: 1, id: request.id, ok: true, result: { hubId, machineId, items: [item] } };
    assert.equal(validLaunchResponse(reply, request, hubId, machineId), parent === undefined || parent === "1" || parent === "2", String(parent));
  }
});
