import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fakeRex } from "./rex-allocation.test.support.js";
const binary = process.env.DECK_TEST_BINARY;
const fixture = fileURLToPath(new URL("./rex-reconciliation.test.fixture.js", import.meta.url));
const args = (root: string) => ["serve", "--stdio", "--mock", "--directory", root, "--workspace", root, "--runtime", fixture];
const env = () => ({ ...process.env, DECK_TEST_BINARY: binary, OPENAI_API_KEY: "PRIVATE_CREDENTIAL", REX_SERVER: "wrong-ambient-endpoint" });
for (const mode of [undefined, "missing", "accepted", "conflict", "malformed", "wrong-scope", "flood", "symlink"]) test(`native receipt reconciliation ${mode ?? "retained creation"}: never dispatch the embedded allocation`, { skip: !binary, timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-reconcile-native-"));
  try {
    assert.equal(spawnSync(binary!, ["init", "--directory", root]).status, 0); await fakeRex(root);
    const child = spawnSync(binary!, args(root), { env: { ...env(), ...(mode ? { DECK_RECONCILE_MODE: mode } : {}) }, encoding: "utf8", timeout: 15_000 });
    assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout);
    assert.equal(result.reads, 1); assert.equal(result.result.status, mode ? "unresolved" : "reconciled");
  } finally { await rm(root, { recursive: true, force: true }); }
});
for (const point of ["admitted", "read", "applied"]) test(`SIGKILL reconciliation ${point}: stable Pi intent and no allocation replay`, { skip: !binary, timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-reconcile-crash-"));
  assert.equal(spawnSync(binary!, ["init", "--directory", root]).status, 0); await fakeRex(root);
  const child = spawn(binary!, args(root), { env: { ...env(), DECK_RECONCILE_POINT: point } }); const closed = once(child, "close"); let errors = "";
  child.stdout.resume(); child.stderr.on("data", (chunk) => { errors += String(chunk); });
  try {
    let checkpoint: { pid: number; taskId: string } | undefined;
    for (let i = 0; i < 800; i++) { try { checkpoint = JSON.parse(await readFile(join(root, "checkpoint.checkpoint"), "utf8")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
    assert.ok(checkpoint, errors); process.kill(checkpoint.pid, "SIGKILL"); assert.notEqual((await closed)[0], 0);
    const recovery = spawnSync(binary!, args(root), { env: env(), encoding: "utf8", timeout: 15_000 }); assert.equal(recovery.status, 0, recovery.stderr);
    const result = JSON.parse(recovery.stdout); assert.equal(result.taskId, checkpoint.taskId); assert.equal(result.reads, point === "applied" ? 0 : 1);
    assert.equal(result.result.status, "reconciled"); assert.equal(await readFile(join(root, "created"), "utf8"), "create\n");
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; await rm(root, { recursive: true, force: true }); }
});
