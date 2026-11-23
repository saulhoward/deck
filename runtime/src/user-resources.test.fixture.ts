// Test-only driver for the actual native worker's inherited IPC descriptors.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import { ChatDoc, DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { INSTRUCTION_BYTES, type InstructionImportResult } from "./instruction-import.js";
import { IMPLEMENTATION, model, ORIGINAL, provider, within } from "./instructions.test.support.js";
import type { TaskId } from "@earendil-works/pi-durable";

const args = process.argv.slice(2), root = process.env.DECK_USER_RESOURCES_TEST_ROOT!;
assert.ok(root && root.startsWith("/"));
// These checks precede every fixture filesystem mutation.
assert.equal(process.env.HOME, join(root, "home"));
assert.equal(process.env.DECK_NODE, process.execPath);
assert.equal(process.env.DECK_RUNTIME_ROOT, fileURLToPath(new URL("../../", import.meta.url)));
assert.equal(args[2], join(root, "workspace"));
assert.equal(dirname(args[0]!), join(root, "state"));
const home = process.env.HOME!, codex = join(home, ".codex"), agents = join(codex, "AGENTS.md"), targets = join(root, "targets");
const binding = { machineId: args[1]!, cwd: args[2]! };
const files = new PipeFiles(Number(args[6]), Number(args[7]), Number(args[8]));
const first = "PERSONAL_RELATIVE_BODY 🌍\n", second = "PERSONAL_ABSOLUTE_BODY é\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const success = (output: string) => ({ ok: true, output, code: "ok", exitCode: null, truncated: false });
let sequence = 1_000_000;
const read = (id = String(++sequence)) => within(files.call(binding, id, "user_agents_md", {}));
const link = async (target: string) => { await rm(agents, { force: true }); await symlink(target, agents); };
const rejected = async (code = "read_failed") => {
  const result = await read(); assert.equal(result.ok, false); assert.equal(result.code, code);
  assert.doesNotMatch(result.output, /PERSONAL_|WORKSPACE_DECOY/);
  assert.ok(Buffer.byteLength(result.output) < 256);
};

const config = join(home, ".config"), deck = join(config, "deck"), skills = join(deck, "skills");
const catalog = (id = String(++sequence)) => within(files.call(binding, id, "skill_catalog", {}));
const skillRead = (path: string, id = String(++sequence)) => within(files.call(binding, id, "skill_read", { path }));
const linkSkills = async (target: string) => { await rm(skills, { force: true }); await symlink(target, skills); };
const seedSkill = async (library: string, name: string, label: string, extraHeader = "") => {
  const header = `name: ${name}\ndescription: ${label} description 🌍\n${extraHeader}`;
  const body = `${label}_SKILL_BODY 🌍\n`, reference = `${label}_REFERENCE é\n`;
  await mkdir(join(library, name, "refs"), { recursive: true });
  await writeFile(join(library, name, "SKILL.md"), `---\n${header}---\n${body}`);
  await writeFile(join(library, name, "refs/example.md"), reference);
  return { name, header, body, reference };
};
const refused = (result: Awaited<ReturnType<typeof skillRead>>, code = "read_failed") => {
  assert.equal(result.ok, false, result.output); assert.equal(result.code, code);
  assert.equal(result.truncated, false);
  assert.doesNotMatch(result.output, /_SKILL_BODY|_REFERENCE|WORKSPACE_DECOY/);
  assert.ok(!result.output.includes(root));
  assert.ok(Buffer.byteLength(result.output) < 256);
};
const expectLibrary = async (data: Awaited<ReturnType<typeof seedSkill>>) => {
  assert.deepEqual(await catalog(), success(JSON.stringify([{ name: data.name, header: data.header }])));
  assert.deepEqual(await skillRead(data.name), success(JSON.stringify({ name: data.name, header: data.header, text: data.body })));
  assert.deepEqual(await skillRead(`${data.name}/refs/example.md`), success(JSON.stringify({ name: data.name, header: data.header, text: data.reference })));
};

async function skillLinks() {
  await mkdir(deck, { recursive: true });
  const one = join(targets, "library-one"), two = join(targets, "library-two");
  const first = await seedSkill(one, "demo", "First"), second = await seedSkill(two, "demo", "Second");
  // All library targets are outside the private HOME, never the operator's.
  await linkSkills("../../../targets/library-one");
  await expectLibrary(first);
  const requests = [
    { operation: "skill_catalog", args: {} },
    { operation: "skill_read", args: { path: "demo" } },
    { operation: "skill_read", args: { path: "demo/refs/example.md" } },
  ];
  const retained = [];
  for (const request of requests) {
    const id = String(++sequence);
    const result = await within(files.call(binding, id, request.operation, request.args));
    assert.equal(result.ok, true);
    const receipt = join(root, "state/worker/operations", `${id}.json`), bytes = await readFile(receipt, "utf8");
    assert.deepEqual(JSON.parse(bytes), { hash: sha(JSON.stringify({ version: 1, id, ...binding, ...request })), result });
    retained.push({ id, request, result, receipt, bytes });
  }
  await linkSkills(two);
  for (const { id, request, result, receipt, bytes } of retained) {
    assert.deepEqual(await within(files.call(binding, id, request.operation, request.args)), result, `${request.operation} must retain captured bytes after retarget`);
    assert.equal(await readFile(receipt, "utf8"), bytes, "Retry must not rewrite the retained receipt");
  }
  await expectLibrary(second); // New IDs see the newly selected absolute root.
  await symlink("library-one", join(targets, "chain-end"));
  await symlink(join(targets, "chain-end"), join(targets, "chain-start"));
  await linkSkills("../../../targets/chain-start");
  await expectLibrary(first); // An OS-bounded chain mixes relative and absolute links.
  await mkdir(join(targets, "empty-library")); await linkSkills(join(targets, "empty-library"));
  assert.deepEqual(await catalog(), success("[]"));
  refused(await skillRead("demo"), "not_found");
  refused(await skillRead("demo/refs/example.md"), "not_found");
}

async function skillRefusals() {
  const missing = async () => {
    // Missing catalogs retain the existing empty-list semantics, even when a
    // broken root link is the missing component. Explicit reads still fail.
    assert.deepEqual(await catalog(), success("[]"));
    refused(await skillRead("demo"), "not_found");
    refused(await skillRead("demo/refs/example.md"), "not_found");
  };
  await missing(); await mkdir(config); await missing(); await mkdir(deck); await missing();
  await linkSkills("../../../targets/missing-library"); await missing();
  const badRoot = async () => {
    refused(await catalog()); refused(await skillRead("demo")); refused(await skillRead("demo/refs/example.md"));
  };
  await symlink("loop-b", join(targets, "loop-a")); await symlink("loop-a", join(targets, "loop-b"));
  await linkSkills(join(targets, "loop-a")); await badRoot();
  await writeFile(join(targets, "not-a-directory"), "PRIVATE_SKILL_BODY");
  await linkSkills(join(targets, "not-a-directory")); await badRoot();
  const fifo = join(targets, "skills-fifo");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 2000 }); assert.equal(made.status, 0, made.stderr);
  await linkSkills(fifo); await badRoot(); // No writer: per-call and process-group guards catch blocking opens.

  const library = join(targets, "library"), data = await seedSkill(library, "demo", "Boundary");
  await linkSkills(library); await expectLibrary(data);
  // The exception applies to 'skills', never to either fixed parent.
  for (const parent of [config, deck]) {
    const moved = `${parent}-real`;
    await rename(parent, moved); await symlink(moved, parent);
    await badRoot();
    await rm(parent); await rename(moved, parent);
    await expectLibrary(data);
  }
  await symlink(join(library, "demo"), join(library, "linked-skill"));
  refused(await skillRead("linked-skill")); refused(await skillRead("linked-skill/refs/example.md"));
  await symlink("refs", join(library, "demo/linked-refs"));
  await symlink("refs/example.md", join(library, "demo/linked-reference.md"));
  refused(await skillRead("demo/linked-refs/example.md")); refused(await skillRead("demo/linked-reference.md"));
  // A symlinked manifest cannot be discovered or used to authorize references.
  const linked = join(library, "linked-manifest"); await mkdir(linked);
  await writeFile(join(targets, "linked-manifest.md"), "---\nname: linked-manifest\ndescription: Do not follow\n---\nPRIVATE_SKILL_BODY");
  await symlink(join(targets, "linked-manifest.md"), join(linked, "SKILL.md"));
  await writeFile(join(linked, "reference.md"), "PRIVATE_REFERENCE");
  refused(await skillRead("linked-manifest")); refused(await skillRead("linked-manifest/reference.md"));
  await expectLibrary(data); // Catalog omits linked skill directories and manifests.
  // These are rejected by PipeFiles' shared wire validator before any IPC send;
  // native-contracts tests separately exercise the native ingress validator.
  for (const path of ["demo/../secret", "demo/.hidden", "demo/refs/.hidden", "demo/.hidden/example.md", "demo//refs/example.md", "/demo", "demo/", "demo/refs/../../secret"]) {
    await assert.rejects(skillRead(path), /invalid: invalid native request; no operation sent/);
  }
  await expectLibrary(data); // Refusals did not poison the pipe or valid library.
}

async function skillTools() {
  await mkdir(deck, { recursive: true });
  const library = join(targets, "pi-library");
  const data = await seedSkill(library, "demo", "Pipeline");
  await seedSkill(library, "disabled", "Disabled", "disable-model-invocation: true\n");
  await seedSkill(library, "mismatch", "Mismatched");
  await writeFile(join(library, "mismatch/SKILL.md"), "---\nname: different\ndescription: Wrong directory name\n---\nMISMATCH_SKILL_BODY");
  await linkSkills("../../../targets/pi-library");
  const { faux, models } = provider();
  const calls: { cwd: string; operation: string; path: string | undefined }[] = [];
  const options = {
    models, model, implementation: IMPLEMENTATION, binding,
    environment: () => { throw new Error("No hub-local fallback"); },
    hostFiles: { call: async (...request: Parameters<PipeFiles["call"]>) => {
      assert.equal(request[0].machineId, binding.machineId);
      assert.ok(request[0].cwd === binding.cwd || request[0].cwd === "/");
      assert.ok(request[2] === "skill_catalog" || request[2] === "skill_read");
      calls.push({ cwd: request[0].cwd, operation: request[2], path: request[3].path });
      return files.call(...request); // Real inherited worker IPC, never a mock read.
    } },
  };
  let runtime = await DeckRuntime.open(args[0]!, options);
  try {
    const chat = String((await runtime.createTask("Explicit skill pipeline", binding)).id), main = String(runtime.main.id);
    assert.equal(faux.state.callCount, 0); assert.deepEqual(calls, []);
    assert.equal((await runtime.toolInventory(chat)).loadedSkills, undefined);
    let baselineChecked = false;
    faux.setResponses([request => {
      assert.doesNotMatch(getCurrentSystemPrompt(request.messages), /Pipeline description|_SKILL_BODY|_REFERENCE/);
      baselineChecked = true;
      return fauxAssistantMessage("No implicit resource reads");
    }]);
    assert.equal((await within((await runtime.admit(chat, { requestId: "before-tools", text: "Do not load any resources", mode: "followUp" })).wait(context))).status, "done");
    assert.equal(baselineChecked, true); assert.equal(faux.state.callCount, 1);
    assert.deepEqual(calls, []);
    let turn = 0;
    const invoke = async (tool: "loadSkill" | "loadHubSkill", parameters: Record<string, string>, error = false) => {
      let output: string | undefined, isError: boolean | undefined;
      const before = faux.state.callCount;
      faux.setResponses([request => {
        assert.match(getCurrentSystemPrompt(request.messages), /assigned machine/);
        return fauxAssistantMessage(fauxToolCall(tool, parameters), { stopReason: "toolUse" });
      }, request => {
        const result = request.messages.filter(message => message.role === "toolResult").at(-1)!;
        assert.ok(result);
        output = result.content.map(part => part.type === "text" ? part.text : "").join("");
        isError = result.isError === true;
        return fauxAssistantMessage("Explicit tool result checked");
      }]);
      assert.equal((await within((await runtime.admit(chat, { requestId: `skill-${++turn}`, text: "Use exactly the selected loader", mode: "followUp" })).wait(context))).status, "done");
      assert.equal(faux.state.callCount, before + 2, "Only the explicitly scripted faux inference sequence runs");
      assert.equal(isError, error, output); assert.ok(output); return output;
    };
    const expected: { cwd: string; operation: string; path: string | undefined }[] = [];
    const recorded = (cwd: string, path?: string) => {
      expected.push({ cwd, operation: path === undefined ? "skill_catalog" : "skill_read", path });
      assert.deepEqual(calls, expected);
    };
    for (const [tool, scope, cwd] of [["loadSkill", "local", binding.cwd], ["loadHubSkill", "hub", "/"]] as const) {
      const discovery = await invoke(tool, {});
      assert.deepEqual(JSON.parse(discovery), { scope, machineId: binding.machineId, skills: [{ name: "demo", description: "Pipeline description 🌍" }] });
      assert.doesNotMatch(discovery, /_SKILL_BODY|_REFERENCE|disabled|mismatch|header/);
      recorded(cwd);
      assert.match(await invoke(tool, { name: "demo", resource: "refs/example.md" }, true), /Load the skill/);
      assert.deepEqual(calls, expected, "Discovery does not authorize reference reads");
      for (const name of ["disabled", "mismatch", "missing"]) {
        const output = await invoke(tool, { name }, true); recorded(cwd, name);
        assert.match(output, name === "missing" ? /skill not found; no fallback/ : /Skill unavailable, disabled, or invalid/);
        assert.doesNotMatch(output, /_SKILL_BODY|_REFERENCE/);
        assert.equal((await runtime.toolInventory(chat)).loadedSkills, undefined);
      }
    }
    const loaded = (scope: string, resource: string, text: string) => `${scope} · ${binding.machineId} · ~/.config/deck/skills/demo/${resource}\n\n${text}`;
    assert.equal(await invoke("loadSkill", { name: "demo" }), loaded("local", "SKILL.md", data.body)); recorded(binding.cwd, "demo");
    assert.deepEqual((await runtime.toolInventory(chat)).loadedSkills, [{ scope: "local", name: "demo" }]);
    assert.equal(await invoke("loadSkill", { name: "demo", resource: "refs/example.md" }), loaded("local", "refs/example.md", data.reference)); recorded(binding.cwd, "demo/refs/example.md");
    assert.match(await invoke("loadHubSkill", { name: "demo", resource: "refs/example.md" }, true), /Load the skill with loadHubSkill/);
    assert.deepEqual(calls, expected, "Even on one machine, loading local must not authorize hub references");
    assert.equal(await invoke("loadHubSkill", { name: "demo" }), loaded("hub", "SKILL.md", data.body)); recorded("/", "demo");
    assert.equal(await invoke("loadHubSkill", { name: "demo", resource: "refs/example.md" }), loaded("hub", "refs/example.md", data.reference)); recorded("/", "demo/refs/example.md");
    for (const tool of ["loadSkill", "loadHubSkill"] as const) {
      for (const resource of ["../secret", ".hidden", "refs/../../secret"]) {
        assert.match(await invoke(tool, { name: "demo", resource }, true), /Invalid skill name or relative resource path/);
      }
      await invoke(tool, { name: "disabled", resource: "refs/example.md" }, true);
    }
    assert.deepEqual(calls, expected, "Invalid and unloaded paths must not reach native reads");
    assert.equal(await invoke("loadSkill", { name: "demo" }), loaded("local", "SKILL.md", data.body)); recorded(binding.cwd, "demo");
    await runtime.close(); runtime = await DeckRuntime.open(args[0]!, options);
    const inventory = await runtime.toolInventory(chat);
    assert.deepEqual(inventory.loadedSkills, [{ scope: "local", name: "demo" }, { scope: "hub", name: "demo" }]);
    assert.doesNotMatch(JSON.stringify(inventory), /_SKILL_BODY|_REFERENCE|Pipeline description|disabled|mismatch/);
    assert.equal((await runtime.toolInventory(main)).loadedSkills, undefined);
    assert.deepEqual(calls, expected, "Inventory and reopen must not reread the library");
  } finally { await runtime.close(); }
}

try {
  await mkdir(codex); await mkdir(targets);
  await writeFile(join(targets, "first"), first); await writeFile(join(targets, "second"), second);
  await writeFile(join(binding.cwd, "AGENTS.md"), "WORKSPACE_DECOY_MUST_NOT_BE_USED");
  const mode = process.env.DECK_USER_RESOURCES_TEST_MODE;
  if (mode === "links") {
    await writeFile(agents, "plain file"); assert.deepEqual(await read(), success("plain file"));
    await link("../../targets/first");
    const id = String(++sequence), captured = await read(id);
    assert.deepEqual(captured, success(first));
    const receipt = join(root, "state/worker/operations", `${id}.json`), retained = await readFile(receipt, "utf8");
    assert.deepEqual(JSON.parse(retained), {
      hash: sha(JSON.stringify({ version: 1, id, ...binding, operation: "user_agents_md", args: {} })), result: captured,
    });
    await link(join(targets, "second"));
    assert.deepEqual(await read(id), captured, "The same native operation ID must not follow the retargeted link");
    assert.equal(await readFile(receipt, "utf8"), retained);
    assert.deepEqual(await read(), success(second), "A new explicit read can capture the new absolute target");
    await symlink("second", join(targets, "chain")); await link("../../targets/chain");
    assert.deepEqual(await read(), success(second));
    const limit = "🌍".repeat(INSTRUCTION_BYTES / 4);
    await writeFile(join(targets, "limit"), limit); await link(join(targets, "limit"));
    assert.equal(Buffer.byteLength(limit), INSTRUCTION_BYTES);
    assert.deepEqual(await read(), success(limit));
    await writeFile(join(targets, "empty"), ""); await link(join(targets, "empty"));
    assert.deepEqual(await read(), success(""));
  } else if (mode === "refusals") {
    await rejected("not_found");
    await link("../../targets/missing"); await rejected("not_found");
    await link("AGENTS.md"); await rejected();
    await link(targets); await rejected();
    const fifo = join(targets, "fifo");
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 2000 }); assert.equal(made.status, 0, made.stderr);
    await link(fifo); await rejected(); // No writer: a blocking open would hang.
    for (const bytes of [Buffer.from("🌍".repeat(INSTRUCTION_BYTES / 4) + "x"), Buffer.from([0xff, 0xfe]), Buffer.from("PERSONAL_NUL\0BODY")]) {
      await writeFile(join(targets, "invalid"), bytes); await link(join(targets, "invalid")); await rejected();
    }
    // Allow only the final AGENTS.md link, not a symlinked .codex directory.
    await link(join(targets, "first"));
    await rename(codex, join(home, "moved-codex")); await symlink("moved-codex", codex); await rejected();
    const skills = join(home, ".config/deck/skills"), demo = join(skills, "demo");
    await mkdir(demo, { recursive: true });
    const manifest = "---\nname: demo\ndescription: Fixture\n---\nSKILL_BODY";
    await writeFile(join(demo, "SKILL.md"), manifest);
    await symlink(join(targets, "first"), join(demo, "reference"));
    const skill = (path: string) => within(files.call(binding, String(++sequence), "skill_read", { path }));
    assert.equal((await skill("demo")).ok, true);
    assert.equal((await skill("demo/reference")).ok, false);
    await writeFile(join(targets, "manifest"), manifest); await rm(join(demo, "SKILL.md")); await symlink(join(targets, "manifest"), join(demo, "SKILL.md"));
    assert.equal((await skill("demo")).ok, false);
    const catalog = await within(files.call(binding, String(++sequence), "skill_catalog", {}));
    assert.equal(catalog.ok, true); assert.deepEqual(JSON.parse(catalog.output), []);
    await rm(join(demo, "SKILL.md")); await writeFile(join(demo, "SKILL.md"), manifest);
    assert.equal((await skill("demo")).ok, true);
    await rename(skills, join(home, "moved-skills")); await symlink(join(home, "moved-skills"), skills);
    assert.equal((await skill("demo")).ok, true, "Only the fixed skills root opts into symlink following");
    assert.equal((await skill("demo/reference")).ok, false, "Root following must not relax inner file boundaries");
  } else if (mode === "skills-links") {
    await skillLinks();
  } else if (mode === "skills-refusals") {
    await skillRefusals();
  } else if (mode === "skills-tools") {
    await skillTools();
  } else if (mode === "import") {
    await link("../../targets/first");
    const { faux, models } = provider(); let reads = 0;
    const options = {
      models, model, implementation: IMPLEMENTATION, binding,
      environment: () => { throw new Error("No hub-local fallback"); },
      hostFiles: { call: async (...request: Parameters<PipeFiles["call"]>) => {
        reads++; assert.deepEqual(request[0], binding); assert.equal(request[2], "user_agents_md"); assert.deepEqual(request[3], {});
        return files.call(...request);
      } },
    };
    let runtime = await DeckRuntime.open(args[0]!, options);
    try {
      const chat = String(runtime.main.id);
      await runtime.configure(chat, { instructions: ORIGINAL });
      const prompt = async (id: string, personal?: string) => {
        faux.setResponses([request => {
          const text = getCurrentSystemPrompt(request.messages);
          assert.ok(text.includes(ORIGINAL));
          for (const body of [first, second]) assert.equal(text.includes(body), body === personal);
          assert.ok(!text.includes("WORKSPACE_DECOY_MUST_NOT_BE_USED"));
          return fauxAssistantMessage("Prompt checked");
        }]);
        assert.equal((await within((await runtime.admit(chat, { requestId: id, text: "Check context", mode: "followUp" })).wait(context))).status, "done");
      };
      const settled = async (id: TaskId<InstructionImportResult>) => {
        const task = await within(runtime.harness.waitForTask(id, context));
        assert.equal(task.state.outcome.status, "completed");
        if (task.state.outcome.status !== "completed") throw new Error("Import did not complete");
        return task.state.outcome.result;
      };
      const load = (id: string) => runtime.importInstructions(chat, id, undefined, binding, "user");
      const source = (text: string, taskId: TaskId) => ({ ...binding, path: "~/.codex/AGENTS.md", sha256: sha(text), bytes: Buffer.byteLength(text), taskId: String(taskId) });
      assert.equal((await runtime.toolInventory(chat)).agentsMdLoaded, undefined);
      await prompt("before-explicit-import"); assert.equal(reads, 0);
      const relative = await load("relative"), applied = await settled(relative);
      assert.deepEqual(applied, { status: "applied", source: source(first, relative) });
      assert.equal(reads, 1); assert.equal(faux.state.callCount, 1, "Import must not invoke inference");
      await link(join(targets, "second"));
      assert.equal(await load("relative"), relative); assert.deepEqual(await settled(relative), applied); assert.equal(reads, 1);
      assert.deepEqual(await read(String(relative)), success(first), "Native retained bytes agree with the Pi receipt after retarget");
      const absolute = await load("absolute"), refreshed = await settled(absolute);
      assert.deepEqual(refreshed, { status: "applied", source: source(second, absolute) }); assert.equal(reads, 2);
      await link(join(targets, "missing"));
      assert.deepEqual(await settled(await load("broken-refresh")), { status: "rejected", reason: "not_found" });
      await writeFile(join(targets, "invalid"), Buffer.from([0xff])); await link(join(targets, "invalid"));
      assert.deepEqual(await settled(await load("invalid-refresh")), { status: "rejected", reason: "read_failed" });
      assert.equal(reads, 4); assert.equal(faux.state.callCount, 1);
      assert.equal((await runtime.toolInventory(chat)).agentsMdLoaded, true);
      assert.equal((await runtime.harness.snapshot(ChatDoc, runtime.main.id, context))?.userAgentsMdHash, sha(second));
      assert.equal((await runtime.main.agent(context)).instructions, ORIGINAL);
      assert.equal(await runtime.instructionSource(chat), undefined, "Personal source must not replace project provenance");
      await runtime.close(); runtime = await DeckRuntime.open(args[0]!, options);
      assert.equal(await load("absolute"), absolute); assert.deepEqual(await settled(absolute), refreshed);
      await prompt("after-reopen-and-failed-refresh", second);
      assert.equal(reads, 4, "Reopen, receipt retry and model turns must not reread personal instructions");
    } finally { await runtime.close(); }
  } else assert.fail(`Unknown private fixture mode: ${mode}`);
  console.log(`verified ${mode}`);
} finally { await files.close(); }
