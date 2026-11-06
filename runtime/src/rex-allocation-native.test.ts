import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fakeRex } from "./rex-allocation.test.support.js";
const binary = process.env.DECK_TEST_BINARY;
const fixture = fileURLToPath(new URL("./rex-allocation.test.fixture.js", import.meta.url));
const args = (directory: string) => ["serve", "--stdio", "--mock", "--directory", directory, "--workspace", directory, "--runtime", fixture];
const env = (mode?: string) => ({ ...process.env, OPENAI_API_KEY: "must-not-reach-rex", BASH_ENV: "/must-not-execute", REX_SERVER: "wrong-ambient-target", ...(mode ? { DECK_REX_MODE: mode } : {}) });
for (const mode of [undefined, "offline", "wrong_server", "bad_client", "uncertain", "failed", "malformed", "wrong_block", "changed_server", "flood", "cancel"]) test(`native Rex allocation ${mode ?? "success"}: stable receipt, explicit scopes, no fallback/replacement`, { skip: !binary, timeout: 25_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-rex-native-"));
  try {
    assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0); await fakeRex(directory, mode);
    const child = spawnSync(binary!, args(directory), { env: env(mode), encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim()) as { taskId: string; result: { status: string } };
    const created = await readFile(join(directory, "created"), "utf8").catch(() => "");
    assert.equal(created, ["offline", "wrong_server", "bad_client", "uncertain"].includes(mode ?? "") ? "" : "create\n");
    if (mode === "cancel") {
      const receipt = JSON.parse(await readFile(join(directory, "worker", "operations", `${result.taskId}.json`), "utf8")) as { result: { code: string } };
      assert.equal(receipt.result.code, "effect_uncertain"); assert.equal(await readFile(join(directory, "fair.txt"), "utf8"), "file I/O proceeds");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const point of ["admitted", "creating", "result", "startup", "applied"]) test(`SIGKILL Rex ${point}: Pi/native recovery never repeats a retained creation`, { skip: !binary, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-rex-crash-"));
  assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0); const mode = point === "creating" ? "lost_ack" : undefined;
  const rex = await fakeRex(directory, mode);
  const child = spawn(binary!, args(directory), { env: { ...env(mode), DECK_REX_POINT: point } }); const closed = once(child, "close");
  let errors = ""; child.stderr.on("data", (chunk) => { errors += String(chunk); }); child.stdout.resume();
  try {
    let checkpoint: { pid: number; taskId: string } | undefined;
    for (let i = 0; i < 800; i++) { try { checkpoint = JSON.parse(await readFile(join(directory, "checkpoint.checkpoint"), "utf8")) as typeof checkpoint; break; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); } }
    assert.ok(checkpoint, errors);
    if (point === "creating") {
      for (let i = 0; i < 500; i++) { if (await readFile(join(directory, "created"), "utf8").catch(() => "")) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
      assert.equal(await readFile(join(directory, "created"), "utf8"), "create\n");
    }
    process.kill(checkpoint.pid, "SIGKILL"); assert.notEqual((await closed)[0], 0);
    if (point !== "admitted") await writeFile(rex, `#!${process.execPath}\nthrow new Error('Must not call Rex after retained creation');\n`, { mode: 0o700 });
    const recovery = spawnSync(binary!, args(directory), { env: env(mode), encoding: "utf8", timeout: 15_000 });
    assert.equal(recovery.status, 0, recovery.stderr);
    const value = JSON.parse(recovery.stdout.trim()) as { taskId: string; calls: number; result: { status: string }; startup: { observation: string } };
    assert.equal(value.taskId, checkpoint.taskId); assert.equal(value.calls, point === "applied" ? 0 : 1); assert.equal(value.result.status, point === "creating" ? "uncertain" : "allocated");
    assert.equal(await readFile(join(directory, "created"), "utf8"), "create\n");
    assert.equal(value.startup.observation, point === "startup" ? "matched" : "not_observed");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
