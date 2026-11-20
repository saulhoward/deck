import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { DeckRuntime, type RuntimeOptions } from "./deck.js";
import { model, provider, IMPLEMENTATION } from "./instructions.test.support.js";

const hub = "a".repeat(32), worker = "b".repeat(32);
test("Pi discovers metadata on demand, routes skill bodies/references to the named host and records only successful loads per chat", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-skills-")), db = join(root, "pi.sqlite");
  const { models, faux } = provider();
  const calls: [string, string, string | undefined][] = [];
  const options: RuntimeOptions = {
    models, model, implementation: IMPLEMENTATION, binding: { machineId: hub, cwd: "/hub" }, environment: () => { throw new Error("No filesystem fallback"); },
    hostFiles: { call: async (binding, _id, op, args) => {
      calls.push([binding.machineId, op, args.path]);
      assert.equal(binding.cwd, binding.machineId === hub ? "/" : "/assigned");
      const meta = { name: "report", header: "name: report\ndescription: >-\n  Summarize\n  results.\n" };
      if (op === "skill_catalog") return { ok: true, output: JSON.stringify([meta, { ...meta, name: "mismatch" }, { ...meta, header: meta.header + "disable-model-invocation: true\n" }]) };
      assert.equal(op, "skill_read");
      if (args.path === "missing") return { ok: false, code: "not_found", output: "not found" };
      return { ok: true, output: JSON.stringify({ ...meta, text: `${binding.machineId === hub ? "HUB" : "WORKER"}_${args.path === "report" ? "BODY" : "EXAMPLE"}` }) };
    } },
  };
  let runtime = await DeckRuntime.open(db, options);
  try {
    const chat = await runtime.createTask("Read a report", { machineId: worker, cwd: "/assigned" });
    const id = String(chat.id), main = String(runtime.main.id);
    assert.equal((await runtime.toolInventory(id)).loadedSkills, undefined);
    let seq = 0;
    const invoke = async (tool: string, args: Record<string, string>, error = false) => {
      let output: string | undefined, isError: boolean | undefined;
      faux.setResponses([request => {
        assert.match(getCurrentSystemPrompt(request.messages), /assigned machine/);
        return fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
      }, request => {
        const result = request.messages.filter(m => m.role === "toolResult").at(-1)!;
        isError = result.isError === true;
        output = result.content.map(p => p.type === "text" ? p.text : "").join("");
        return fauxAssistantMessage("Acknowledged");
      }]);
      assert.equal((await (await runtime.admit(id, { requestId: `skill-${++seq}`, text: "Use the selected loader", mode: "followUp" })).wait(context)).status, "done");
      assert.equal(isError, error, output); assert.ok(output); return output;
    };
    assert.deepEqual(calls, []);
    assert.deepEqual(JSON.parse(await invoke("loadSkill", {})), { scope: "local", machineId: worker, skills: [{ name: "report", description: "Summarize results." }] });
    await invoke("loadSkill", { name: "report", resource: "refs/example" }, true);
    assert.deepEqual(calls, [[worker, "skill_catalog", undefined]]);
    await invoke("loadSkill", { name: "missing" }, true);
    assert.equal((await runtime.toolInventory(id)).loadedSkills, undefined);
    assert.match(await invoke("loadSkill", { name: "report" }), /WORKER_BODY/);
    assert.match(await invoke("loadSkill", { name: "report", resource: "refs/example" }), /WORKER_EXAMPLE/);
    await invoke("loadHubSkill", { name: "report", resource: "refs/example" }, true);
    await invoke("loadSkill", { name: "report", resource: "../secret" }, true);
    assert.match(await invoke("loadHubSkill", { name: "report" }), /HUB_BODY/);
    assert.match(await invoke("loadSkill", { name: "report" }), /WORKER_BODY/);
    assert.deepEqual(calls.slice(1), [[worker, "skill_read", "missing"], [worker, "skill_read", "report"], [worker, "skill_read", "report/refs/example"], [hub, "skill_read", "report"], [worker, "skill_read", "report"]]);
    await runtime.close(); runtime = await DeckRuntime.open(db, options);
    const inventory = await runtime.toolInventory(id);
    assert.deepEqual(inventory.loadedSkills, [{ scope: "local", name: "report" }, { scope: "hub", name: "report" }]);
    assert.doesNotMatch(JSON.stringify(inventory), /_BODY|_EXAMPLE|Summarize/);
    assert.equal((await runtime.toolInventory(main)).loadedSkills, undefined);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
