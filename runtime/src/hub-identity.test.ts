import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DeckRuntime } from "./deck.js";
import { DraftStore } from "./drafts.js";
import { serveIpc } from "./ipc.js";
import { FrameDecoder, encodeFrame } from "./protocol.js";
import { clientEnv } from "./client.test.env.js";
import { IMPLEMENTATION, model, provider } from "./instructions.test.support.js";

test("expected hub guard rejects reads, admissions and stop before dispatch; legacy envelopes remain accepted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-hub-guard-")); const { models } = provider(); let admissions = 0;
  const runtime = await DeckRuntime.open(join(directory, "pi.sqlite"), { models, model, binding: { machineId: "host", cwd: "/saved" }, implementation: IMPLEMENTATION, environment: () => undefined, admissionGuard: async () => { admissions++; } });
  const input = new PassThrough(); const output = new PassThrough(); const decoder = output.pipe(new FrameDecoder()); const frames = decoder[Symbol.asyncIterator](); const serving = serveIpc(runtime, input, output);
  const request = async (command: string, hubId?: unknown, args = {}) => { input.write(encodeFrame({ version: 1, id: "guard", command, args, ...(hubId === undefined ? {} : { hubId }) })); return (await frames.next()).value as { ok: boolean; result: { hubGuard: number }; error: { code: string } }; };
  try {
    assert.equal((await request("status")).result.hubGuard, 1);
    for (const command of ["status", "history", "admit", "create_task", "import_instructions", "stop", "login_start"]) {
      const result = await request(command, "wrong-hub", { chatId: String(runtime.main.id) }); assert.equal(result.ok, false); assert.equal(result.error.code, "conflict");
    }
    for (const value of [0, "", "x".repeat(201)]) assert.equal((await request("status", value)).error.code, "invalid");
    assert.equal((await request("status", runtime.hubId)).ok, true); assert.equal(admissions, 0); assert.equal((await runtime.listChats()).items.length, 1);
  } finally { input.end(); await serving; decoder.destroy(); output.destroy(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

async function until(check: () => boolean) { for (let i = 0; i < 500; i++) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("Expected client hub guard not observed"); }
for (const guard of [false, true]) test(`pinned client rejects initial ${guard ? "wrong hub" : "missing guard capability"} without sending input`, async () => {
  let writes = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; hubId: string };
    assert.equal(value.hubId, "expected"); if (value.command !== "status") writes++;
    response.end(JSON.stringify({ version: 1, id: value.id, ok: true, result: { hubId: guard ? "different" : "expected", ...(guard ? { hubGuard: 1 } : {}), mainChatId: "1", chatId: "1", tools: "offline" } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const local = await clientEnv();
  try {
    const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port), "--hub-id", "expected", "--message", "MUST_NOT_SEND"], { env: local.env });
    let errors = ""; client.stderr.on("data", (chunk) => { errors += String(chunk); }); client.stdout.resume(); client.stdin.end();
    assert.equal((await once(client, "close"))[0], 1); assert.match(errors, guard ? /Invalid status\/login response/ : /Expected hub identity\/guard unavailable/); assert.equal(writes, 0);
    assert.deepEqual(await new DraftStore("expected", local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []);
  } finally { await local.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("a client pins its discovered hub across port replacement and retains the original saved draft on refusal", async () => {
  let current = "hub-A"; let writes = 0; let rejected = false; let ready = false;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks).toString()) as { id: string; command: string; hubId?: string; args: Record<string, unknown> };
    if (value.command === "admit") { assert.equal(value.hubId, "hub-A"); rejected = true; }
    if (value.hubId && value.hubId !== current) { response.end(JSON.stringify({ version: 1, id: value.id, ok: false, error: { code: "conflict", message: "Hub identity changed; no command applied" } })); return; }
    if (value.command === "status") response.end(JSON.stringify({ version: 1, id: value.id, ok: true, result: { hubId: current, hubGuard: 1, mainChatId: "1", chatId: "1", provider: "faux", model: { provider: "faux", modelId: "faux-1" }, tools: "native-files + bash", binding: { machineId: "worker", cwd: "/saved" } } }));
    else if (value.command === "history") { ready = true; response.end(JSON.stringify({ version: 1, id: value.id, ok: true, result: { items: [] } })); }
    else { writes++; response.end(JSON.stringify({ version: 1, id: value.id, ok: true, result: { submissionId: "2" } })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const local = await clientEnv();
  const client = spawn(process.execPath, [fileURLToPath(new URL("./client.js", import.meta.url)), "--port", String(address.port)], { env: local.env }); const closed = once(client, "close");
  let errors = ""; client.stderr.on("data", (chunk) => { errors += String(chunk); }); client.stdout.resume();
  try {
    await until(() => ready); current = "hub-B"; client.stdin.write("PINNED_INPUT\n"); await until(() => rejected && errors.includes("Hub identity changed"));
    const store = new DraftStore("hub-A", local.env.DECK_CLIENT_STATE_DIRECTORY); const saved = await store.list(); assert.equal(saved.length, 1);
    const draft = (await store.load(saved[0]!.requestId)).request; assert.equal(draft.kind, "input"); if (draft.kind === "input") assert.equal(draft.text, "PINNED_INPUT");
    assert.deepEqual(await new DraftStore("hub-B", local.env.DECK_CLIENT_STATE_DIRECTORY).list(), []); assert.equal(writes, 0);
    client.stdin.end("/exit\n"); assert.equal((await closed)[0], 0);
  } finally { if (client.exitCode === null && client.signalCode === null) client.kill(); await closed; await local.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
