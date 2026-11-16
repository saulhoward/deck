import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { validRexEnrollmentAck, type RexWorkerRegistration } from "./generated/contracts.js";
import { freeHubPort } from "./hub-port.test.support.js";
import { encodeFrame, FrameDecoder } from "./protocol.js";
const binary = process.env.DECK_TEST_BINARY;

test("automatic enrollment waits for runtime readiness without consuming the registration deadline", { skip: !binary, timeout: 25_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-rex-ready-")), state = join(root, "state"), gate = join(root, "ready"), observed = join(root, "registered");
  const hubId = randomUUID(), port = await freeHubPort(), sockets: Socket[] = [];
  let executable = binary!;
  // Nix wrappers pin the runtime root. Use the same native executable with an
  // isolated, gated private-runtime fixture; never a live store or Rex server.
  const wrapped = join(dirname(executable), ".deck-wrapped");
  if (await access(wrapped).then(() => true, () => false)) executable = wrapped;
  await mkdir(join(root, "runtime", "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(join(root, "runtime", "dist", "main.js"), `
    import { existsSync, appendFileSync } from "node:fs";
    import { serveAutomaticWorkerClients } from ${JSON.stringify(new URL("./remote-clients.js", import.meta.url).href)};
    import { encodeFrame, FrameDecoder } from ${JSON.stringify(new URL("./protocol.js", import.meta.url).href)};
    const args = process.argv.slice(2), machineId = args[1], routes = JSON.parse(args[12]), clients = [];
    // Read-only identity discovery stays available while automatic routing is
    // gated. The parent verifies the responding hub before any registration.
    process.stdin.pipe(new FrameDecoder()).on("data", request => {
      if (request.command !== "list_hosts") throw Error("Unexpected fixture command");
      process.stdout.write(encodeFrame({ version: 1, id: request.id, ok: true, result: {
        sampledAtMs: Date.now(), items: [{ machineId, kind: "local", rex: false, connection: "local" }]
      }}));
    });
    process.stdin.on("end", () => { for (const client of clients) client.close(); process.exit(0); });
    while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 20));
    for (const slot of routes.slots) clients.push(serveAutomaticWorkerClients({ hubId: ${JSON.stringify(hubId)} }, slot.clientReadFd, slot.clientWriteFd,
      registration => appendFileSync(${JSON.stringify(observed)}, registration.machineId + "\\n")));
  `);
  const hub = spawn(executable, ["serve", "--mock", "--directory", state, "--workspace", root, "--port", String(port)], {
    env: { ...process.env, DECK_RUNTIME_ROOT: root, DECK_NODE: process.execPath },
  });
  const closed = once(hub, "close"); let diagnostics = "";
  hub.stderr.on("data", chunk => { diagnostics += String(chunk); }); hub.stdout.resume();
  const enroll = async (registration: RexWorkerRegistration) => {
    const socket = createConnection({ host: "127.0.0.1", port: port + 1 }); sockets.push(socket);
    await once(socket, "connect");
    const decoder = socket.pipe(new FrameDecoder()); decoder.on("error", () => {});
    socket.on("error", error => decoder.destroy(error));
    const response = once(decoder, "data", { signal: AbortSignal.timeout(12_000) }).then(([value]) => value as unknown);
    void response.catch(() => {}); // The slow-start assertion precedes awaiting the reply.
    socket.write(encodeFrame(registration));
    return { socket, response };
  };
  try {
    for (let i = 0; !diagnostics.includes("hub listening"); i++) {
      assert.ok(i < 300 && hub.exitCode === null && hub.signalCode === null, diagnostics);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const config = JSON.parse(await readFile(join(state, "config.json"), "utf8")) as { machine_id: string };
    const reply = await fetch(`http://127.0.0.1:${port}/v1/command`, {
      method: "POST", body: JSON.stringify({ version: 1, id: "identity", command: "list_hosts", args: {} }), signal: AbortSignal.timeout(4000),
    }).then(response => response.json()) as { ok: boolean; result: { items: { machineId: string }[] } };
    assert.equal(reply.ok, true); assert.equal(reply.result.items[0]?.machineId, config.machine_id);
    const registration: RexWorkerRegistration = {
      version: 1, hubId, machineId: "a".repeat(32), implementation: "b".repeat(64), capabilities: ["files", "bash", "rex", "launcher"],
      rexClient: { executable, socket: join(root, "worker.sock") },
    };
    const first = await enroll(registration);
    // Deliberately exceed the existing five-second private handshake deadline:
    // this is startup waiting, not a registration whose acknowledgement is lost.
    await new Promise(resolve => setTimeout(resolve, 6000));
    assert.equal(first.socket.destroyed, false, "Enrollment disconnected while the runtime was still starting");
    assert.equal(await access(observed).then(() => true, () => false), false);
    assert.equal(await access(join(state, "rex-workers.json")).then(() => true, () => false), false);
    await writeFile(gate, "ready");
    const ack = await first.response;
    assert.ok(validRexEnrollmentAck(ack)); assert.equal(ack.hubId, hubId); assert.equal(ack.machineId, registration.machineId);
    first.socket.destroy();
    const registry = await readFile(join(state, "rex-workers.json"), "utf8");
    const saved = JSON.parse(registry) as { hubId: string; hosts: RexWorkerRegistration[] };
    assert.equal(saved.hubId, hubId); assert.deepEqual(saved.hosts, [registration]);
    const again = await enroll(registration);
    assert.deepEqual(await again.response, ack); again.socket.destroy();
    assert.equal(await readFile(join(state, "rex-workers.json"), "utf8"), registry);
    // A second slot must also have consumed its readiness record, not mistake
    // that record for the acknowledgement of a later registration.
    const second = await enroll({ ...registration, machineId: "c".repeat(32) });
    const other = await second.response;
    assert.ok(validRexEnrollmentAck(other)); assert.equal(other.machineId, "c".repeat(32)); second.socket.destroy();
    assert.equal(await readFile(observed, "utf8"), `${registration.machineId}\n${"c".repeat(32)}\n`);
  } catch (cause) {
    throw new Error(`Isolated enrollment failed: ${diagnostics.trim() || "no diagnostics"}`, { cause });
  } finally {
    for (const socket of sockets) socket.destroy();
    if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});
