// Opt-in native-test child: one hub store, inherited real FIFO routes, and an
// explicit private Rex server. Never uses an operator daemon or tailnet bypass.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DeckRuntime } from "./deck.js";
import { PipeFiles } from "./host-files.js";
import { parseRoutes, RoutedFiles } from "./remote-files.js";
import { serveWorkerClients } from "./remote-clients.js";
import { launcherTarget,launcherCommand } from "./launcher-client.js";
import { model, provider, IMPLEMENTATION } from "./instructions.test.support.js";
const [mode, root, routesJson] = process.argv.slice(2) as [string, string, string];
const local = "c".repeat(32); const binary = process.env.DECK_TEST_BINARY!;
const { models, faux } = provider(); faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("REMOTE_RELAY_REPLY")));
const localFiles = { call: async () => { throw new Error("No local effects allowed"); }, close: async () => {} } as unknown as PipeFiles;
const routes = mode === "run" ? parseRoutes(routesJson, local, []) : undefined;
const files = routes ? new RoutedFiles(local, localFiles, routes) : localFiles;
const runtime = await DeckRuntime.open(join(root, "pi.sqlite"), { models, model, implementation: IMPLEMENTATION, binding: { machineId: local, cwd: root }, environment: () => undefined, hostFiles: files, rexClient: binary, ...(routes ? { expectedHubId: routes.hubId } : {}) });
const clients = (routes?.hosts ?? []).map(h => serveWorkerClients(runtime, h.machineId, h.rexClient!, h.clientReadFd!, h.clientWriteFd!, h.launcher === true));
if (mode === "init") { console.log(runtime.hubId); await runtime.close(); }
else {
  let stopping = false;
  const limit = setTimeout(() => { stopping = true; }, 30_000); limit.unref();
  process.once("SIGTERM", () => { stopping = true; });
  const rexBinary = process.env.DECK_TEST_REX!; assert.ok(rexBinary.startsWith("/") && binary.startsWith("/"));
  const rexRoot = join(root, "rex"); await mkdir(rexRoot); const endpoint = `unix://${rexRoot}/server.sock`;
  const config = join(root, "empty.lua"); await writeFile(config, "", { mode: 0o600 });
  const env = { HOME: root, PATH: "/usr/bin:/bin", TMPDIR: root, XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), TERM: "xterm-256color", LANG: "en_US.UTF-8", DECK_NODE: process.execPath, DECK_RUNTIME_ROOT: resolve("."), DECK_CLIENT_STATE_DIRECTORY: join(root, "drafts") };
  const rex = (...args: string[]): Promise<string> => new Promise((yes, no) => execFile(rexBinary, ["--autostart=false", "--timeout", "2s", "--server", endpoint, ...args], { env, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? no(new Error(`Private Rex ${args[0]} failed`)) : yes(stdout)));
  const json = async (...args: string[]) => JSON.parse(await rex(...args));
  const until = async <T>(fn: () => Promise<T>, check: (value: T) => boolean): Promise<T> => {
    const deadline = performance.now() + 7000;
    while (performance.now() < deadline) { if (stopping) throw new Error("Fixture stopping"); const value = await fn(); if (check(value)) return value; await new Promise(r => setTimeout(r, 30)); }
    throw new Error("Private relay/Rex condition missing");
  };
  const server = spawn(rexBinary, ["server", "run", "--listen", endpoint, "--state-dir", join(root, "rex-state"), "--config", config, "--restore=false", "--max-sessions", "4", "--max-blocks", "8", "--max-windows", "4"], { env, stdio: ["ignore", "ignore", "pipe"] });
  server.on("error", () => { stopping = true; });
  server.stderr!.resume(); const sessions = new Set<string>();
  try {
    await until(() => access(`${rexRoot}/server.sock`).then(() => true, () => false), Boolean);
    const status = await json("server", "status", "--json"); assert.ok([8, 10, 14].includes(status.api_revision));
    process.stderr.write(`deck test: isolated Rex API ${status.api_revision}; no tailnet\n`);
    assert.equal(status.you.transport, "unix"); assert.equal(status.tailscale.state, "disabled"); assert.equal(status.session_count, 0);
    const host = routes!.hosts[0]!;
    const chat = await runtime.createTask("relay acceptance", { machineId: host.machineId, cwd: root }); const chatId = String(chat.id);
    const open = async (first = false) => {
      const result = await runtime.openTerminal({ chatId, requestId: randomUUID(), port: 52800, ...(first ? { target: { executable: rexBinary, server: endpoint, hostId: status.host_id, instanceId: status.instance_id } } : {}) });
      await runtime.harness.waitForTask(Number(result.taskId) as TaskId, context);
      const saved = await runtime.terminalStatus(chatId); assert.equal(saved.status, "allocated"); assert.ok(saved.binding); sessions.add(saved.binding.sessionId);
      await until(() => runtime.terminalStartup(chatId), value => value.observation === "matched"); return saved.binding;
    };
    const first = await open(true);
    const capture = (b = first) => rex("capture", "--session", b.sessionId, "--block", b.blockId, "--trim", "--unwrap");
    const processState = (b = first) => json("block", "call", "process", "--session", b.sessionId, "--block", b.blockId);
    const send = (text: string, b = first) => rex("send", "--session", b.sessionId, "--block", b.blockId, text);
    await until(() => capture(), text => text.includes("Rex startup registered"));
    const pid = (await processState()).child.pid;
    // Insert is initial; the current UI has no mode/idle banner. Startup
    // registration plus canonical admission, not footer labels, is evidence.
    await send("REMOTE_RELAY_INPUT\x13");
    const history = await until(() => runtime.history(chatId), value => JSON.stringify(value).includes("REMOTE_RELAY_REPLY"));
    assert.match(JSON.stringify(history), /REMOTE_RELAY_INPUT/); assert.doesNotMatch(JSON.stringify(await runtime.history(String(runtime.main.id))), /REMOTE_RELAY_INPUT/);
    await writeFile(join(root, "disconnect"), "");
    await until(() => capture(), text => text.includes("unavailable worker client") || text.includes("STALE"));
    assert.equal((await processState()).child.pid, pid); await writeFile(join(root, "can-reconnect"), "");
    await until(() => access(join(root, "reconnected")).then(() => true, () => false), Boolean);
    await until(() => capture(), text => !text.includes("STALE") && text.includes("REMOTE_RELAY_REPLY"));
    assert.equal((await processState()).child.pid, pid); assert.deepEqual(await runtime.history(chatId), history);
    await rex("send-key", "--session", first.sessionId, "--block", first.blockId, "Escape");
    await new Promise(resolve => setTimeout(resolve, 100)); // Separate Esc and colon, not Alt-:.
    await send(":q"); await until(() => capture(), text => text.includes(":q")); await send("\r");
    await until(() => processState(), value => value.last_exit?.exit_code === 0);
    const second = await open(); assert.equal(second.sessionId, first.sessionId); assert.notEqual(second.blockId, first.blockId);
    await until(() => capture(second), text => text.includes("REMOTE_RELAY_INPUT"));
    assert.deepEqual(await runtime.history(chatId), history); assert.equal((await runtime.listChats()).items.length, 2);
    // The bootstrap CLI has no task allocation scope. Its narrow permission is
    // independently approved on both native peers; normal startup remains mandatory.
    assert.equal(host.launcher,true);
    await mkdir(join(root,"bin"));
    const quote=(s:string)=>"'"+s.replaceAll("'","'\\''")+"'";
    await writeFile(join(root,"bin/rex"),`#!/bin/sh\nexec ${quote(rexBinary)} --server ${quote(endpoint)} "$@"\n`,{mode:0o700});
    await writeFile(join(root,"worker/worker.json"),JSON.stringify({version:1,machineId:host.machineId,hubId:runtime.hubId,hubAddress:"100.64.0.1:52901",hubPeer:{nodeId:"nFixture",userId:"1"},rexClient:host.rexClient,launcher:true}),{mode:0o600});
    const cli=(args:string[]):Promise<string>=>new Promise((yes,no)=>execFile(binary,["agent","--launch-from",join(root,"worker"),...args],{env,timeout:10000,maxBuffer:1024*1024},(error,stdout,stderr)=>error?no(new Error(`Launcher CLI failed: ${stderr}`)):yes(stdout)));
    const output=await cli(["--new",JSON.stringify({title:"launcher acceptance",cwd:root,problem:"",description:"exact launcher brief"}),"--confirm"]);
    const created=JSON.parse(output.split("\n")[0]!);assert.equal(created.machineId,host.machineId);assert.deepEqual(created.brief,{problem:"",description:"exact launcher brief"});
    const ack=JSON.parse(output.split("\n")[1]!).ack;await runtime.harness.waitForTask(Number(ack.taskId) as TaskId,context);
    const launched=await runtime.terminalStatus(created.chatId);assert.equal(launched.status,"allocated");assert.ok(launched.binding);sessions.add(launched.binding.sessionId);
    await until(()=>runtime.terminalStartup(created.chatId),v=>v.observation==="matched");await until(()=>capture(launched.binding!),s=>s.includes("Rex startup registered"));
    assert.deepEqual((await runtime.toolProfiles(created.chatId)).profiles,[]);
    await send("REMOTE_LAUNCHER_INPUT\x13",launched.binding);
    await until(()=>runtime.history(created.chatId),v=>JSON.stringify(v).includes("REMOTE_RELAY_REPLY"));
    assert.equal(JSON.parse(await cli(["--inspect",created.chatId])).status.binding.machineId,host.machineId);
    assert.deepEqual(JSON.parse(await cli(["--drafts"])),[]);
    const launcher=await launcherTarget(join(root,"worker"));
    await assert.rejects(launcherCommand(launcher,{version:1,id:randomUUID(),command:"launch_inspect",args:{chatId:String(runtime.main.id)}}),/unavailable/);
    assert.equal((await runtime.listChats()).items.length,3);
    console.log("verified native relay/Rex acceptance passed");
  } finally {
    for (const id of sessions) await rex("session", "kill", id).catch(() => {});
    if (server.pid && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "close"); server.kill("SIGTERM"); const kill = setTimeout(() => server.kill("SIGKILL"), 3000);
      try { await stopped; } finally { clearTimeout(kill); }
    }
    for (const client of clients) client.close(); await runtime.close(); await files.close(); clearTimeout(limit);
  }
}
