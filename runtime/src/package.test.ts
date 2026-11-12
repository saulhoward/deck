import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const binary = process.env.DECK_PACKAGE_BINARY;
test("installed package runs hub, client, lazy provider imports and native tools outside the checkout without Node on PATH", { skip: !binary, timeout: 20_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), "deck-package-"));
  let state = join(scratch, "state");
  const env = { ...process.env, HOME: scratch, DECK_CLIENT_STATE_DIRECTORY: join(scratch, "client"), PATH: "/missing-tools", DECK_NODE: "/missing-node", DECK_RUNTIME_ROOT: "/missing-runtime" };
  const invoke = (args: string[], input?: string) => spawnSync(binary!, args, { cwd: scratch, env, encoding: "utf8", timeout: 10_000, ...(input === undefined ? {} : { input }) });
  let hub: ReturnType<typeof spawn> | undefined;
  try {
    assert.equal(invoke(["init", "--directory", state]).status, 0);
    const fixture = join(scratch, "native-smoke.mjs");
    await writeFile(fixture, `
      import assert from 'node:assert/strict';
      import { pathToFileURL } from 'node:url';
      const root = process.env.DECK_RUNTIME_ROOT;
      // Load the pinned provider SDK asset without authenticating or making requests.
      await import(pathToFileURL(root+'/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js'));
      const { PipeFiles } = await import(pathToFileURL(root+'/runtime/dist/host-files.js'));
      const args = process.argv.slice(2);
      const tools = new PipeFiles(Number(args[6]),Number(args[7]),Number(args[8]));
      const binding = {machineId:args[1],cwd:args[2]};
      try {
        assert.equal((await tools.call(binding,'100','write',{path:'packaged.txt',content:'installed tools work'})).ok,true);
        let sampled=false;
        // Only Bash builtins: PATH deliberately contains no sleep/coreutils.
        // Resume the stopped shell only after observing its pre-settlement sample.
        const bash = await tools.call(binding,'101','bash',{command:'printf "packaged-shell:%s" "$$"; kill -STOP "$$"',timeout:5},undefined,sample=>{const pid=/^packaged-shell:([1-9][0-9]*)$/.exec(sample.output)?.[1]; if(pid){sampled=true; process.kill(Number(pid),'SIGCONT');}});
        assert.equal(bash.ok,true); assert.match(bash.output,/packaged-shell/); assert.equal(sampled,true);
        assert.equal((await tools.call(binding,'102','write',{path:'AGENTS.md',content:'PACKAGED_PROJECT_INSTRUCTIONS'})).ok,true);
      // Seed more than one retained page through the packaged adapter, with no inference.
      const { BACKGROUND_CONTEXT: context } = await import(pathToFileURL(root+'/node_modules/@earendil-works/chord/dist/context/index.js'));
      const { DeckRuntime } = await import(pathToFileURL(root+'/runtime/dist/deck.js'));
      const { providers } = await import(pathToFileURL(root+'/runtime/dist/providers.js'));
      const { fauxAssistantMessage, fauxToolCall } = await import(pathToFileURL(root+'/node_modules/@earendil-works/pi-ai/dist/providers/faux.js'));
      const provider = providers('--mock',args[0]+'.unused-auth',args[1]);
      const runtime = await DeckRuntime.open(args[0], {models:provider.models,model:provider.model,binding,hostFiles:tools,environment:()=>{throw new Error('No local fallback');}});
      try {
        const imported=await runtime.importInstructions(String(runtime.main.id),'package-import');
        const settled=await runtime.harness.waitForTask(imported,context);
        assert.equal(settled.state.outcome.status,'completed'); assert.equal(settled.state.outcome.result.status,'applied');
        assert.equal(await runtime.importInstructions(String(runtime.main.id),'package-import'),imported);
        assert.equal((await runtime.instructionSource(String(runtime.main.id))).path,'AGENTS.md');
        const agent = await runtime.main.agent(context);
        for (const name of ['host_list','task_list','task_history','task_activity','task_create','task_message','hub_message','subagent']) assert.ok(agent.tools.some(tool => tool.name === name));
        await runtime.main.commit(async tx => {
          for (let i=0;i<110;i++) await tx.appendEntry(runtime.main.id,{kind:'deck.input',data:{text:'packaged retained '+i}});
          // Seed a paired tool exchange to check installed-client result rendering.
          await tx.appendEntry(runtime.main.id,{kind:'pi.assistant',model:[fauxAssistantMessage(fauxToolCall('bash',{command:'printf packaged-shell'},{id:'seeded-call'}),{stopReason:'toolUse'})]});
          await tx.appendEntry(runtime.main.id,{kind:'pi.tool-result',model:[{role:'toolResult',toolCallId:'seeded-call',toolName:'bash',content:[{type:'text',text:'seeded packaged tool result'}],isError:false,timestamp:Date.now(),details:{code:'ok',exitCode:0}}]});
        },context);
      } finally { await runtime.close(); }
      } finally { await tools.close(); }
    `);
    const native = invoke(["serve", "--stdio", "--mock", "--directory", state, "--runtime", fixture, "--workspace", scratch]);
    assert.equal(native.status, 0, native.stderr);
    assert.equal(await readFile(join(scratch, "packaged.txt"), "utf8"), "installed tools work");
    const snapshot = join(scratch, "backup");
    const backed = invoke(["backup", "--directory", state, "--output", snapshot]); assert.equal(backed.status, 0, backed.stderr);
    const restored = join(scratch, "restored");
    const recovery = invoke(["restore", "--from", snapshot, "--directory", restored]); assert.equal(recovery.status, 0, recovery.stderr);
    assert.match(recovery.stdout, /no work resumed/); state = restored; // Serve the restored canonical transcript/receipts below.
    const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
    const address = probe.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    hub = spawn(binary!, ["serve", "--mock", "--directory", state, "--workspace", scratch, "--port", String(port)], { cwd: scratch, env, stdio: ["pipe", "pipe", "pipe"] });
    let errors = ""; hub.stderr!.on("data", (chunk) => { errors += String(chunk); });
    const command = async (name: string, args = {}) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/command`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: 1, id: "smoke", command: name, args }), signal: AbortSignal.timeout(2000) });
      assert.equal(response.status, 200);
      const value = await response.json() as { ok: boolean; result: Record<string, unknown> };
      assert.equal(value.ok, true); return value.result;
    };
    let status: Record<string, unknown> | undefined;
    for (let i = 0; i < 100; i++) {
      try { status = await command("status"); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 30)); }
    }
    assert.ok(status, errors);
    assert.match(String(status.implementation), /^[a-f0-9]{64}$/);
    const checkpoint = await command("history", { chatId: status.mainChatId, limit: 1 });
    const checkpointId = String((checkpoint.items as Record<string, unknown>[])[0]!.id);
    const message = invoke(["agent", "--no-tui", "--port", String(port), "--message", "packaged chat"]);
    for (const bucket of await readdir(join(scratch, "client", "drafts"))) assert.deepEqual(await readdir(join(scratch, "client", "drafts", bucket)), []);
    assert.equal(message.status, 0, message.stderr); assert.match(message.stdout, /submissionId/);
    for (let i = 0; i < 100; i++) {
      if (JSON.stringify(await command("history", { chatId: status.mainChatId })).includes("no inference performed")) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const caughtUp = await command("history", { chatId: status.mainChatId, after: checkpointId, limit: 100, includeProgress: true });
    assert.equal((caughtUp.progress as Record<string, unknown>).provisional, true);
    const preview = await command("progress", { chatId: status.mainChatId });
    assert.equal(preview.version, 1); assert.equal(preview.chatId, status.mainChatId);
    assert.match(JSON.stringify(caughtUp), /packaged chat/); assert.match(JSON.stringify(caughtUp), /no inference performed/);
    assert.ok((caughtUp.items as Record<string, unknown>[]).every((entry) => Number(entry.id) > Number(checkpointId)));
    const binding = status.binding as Record<string, unknown>;
    const task = await command("create_task", { requestId: "packaged-task", title: "Packaged task", machineId: binding.machineId, cwd: binding.cwd });
    await writeFile(join(scratch, "AGENTS.md"), "PACKAGED_RELOADED_INSTRUCTIONS");
    const client = invoke(["agent", "--no-tui", "--port", String(port)], `/older\n/older\n/activity\n/tasks\n/select ${task.chatId}\n/status\n/main\n/instructions\n/instructions load\n/instructions\n/exit\n`);
    assert.equal(client.status, 0, client.stderr);
    assert.match(client.stdout, /you: packaged chat/); assert.match(client.stdout, /assistant: Deck prototype response/);
    assert.match(client.stdout, /seeded packaged tool result/); assert.match(client.stdout, /activity: /);
    assert.match(client.stdout, /you: packaged retained 0\n/); assert.match(client.stdout, /Beginning of retained history/);
    const importId = /Instruction import admitted: task ([1-9]\d*)\./.exec(client.stdout)?.[1]; assert.ok(importId, client.stderr);
    let applied = false;
    for (let i = 0; i < 100; i++) {
      const receipt = await command("instruction_status", { chatId: status.mainChatId, taskId: importId });
      if ((receipt.import as Record<string, unknown>).state === "terminal") {
        assert.equal(((receipt.import as Record<string, unknown>).result as Record<string, unknown>).status, "applied");
        assert.equal((receipt.source as Record<string, unknown>).sha256, createHash("sha256").update("PACKAGED_RELOADED_INSTRUCTIONS").digest("hex")); applied = true; break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(applied); assert.doesNotMatch(client.stdout, /PACKAGED_RELOADED_INSTRUCTIONS/);
    for (const bucket of await readdir(join(scratch, "client", "drafts"))) assert.deepEqual(await readdir(join(scratch, "client", "drafts", bucket)), []);
    assert.match(client.stdout, /Packaged task/); assert.match(client.stdout, new RegExp(`Selected chat ${task.chatId}`));
  } finally {
    if (hub && hub.exitCode === null && hub.signalCode === null) {
      const closed = once(hub, "close"); hub.kill("SIGTERM"); await closed;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
