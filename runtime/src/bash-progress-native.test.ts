import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const binary = process.env.DECK_TEST_BINARY;
const fixture = fileURLToPath(new URL("./bash-progress.test.fixture.js", import.meta.url));
for (const fault of [false, true]) test(fault ? "full native progress pipe cannot block shell draining/cancellation" : "actual Pi/native bash exposes sampled tails, separate final results and retained replay", { skip: !binary, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-bash-progress-"));
  try {
    assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0);
    const result = spawnSync(binary!, ["serve", "--stdio", "--mock", "--directory", directory, "--workspace", directory, "--runtime", fixture], {
      encoding: "utf8", timeout: 25_000, env: { ...process.env, ...(fault ? { DECK_BASH_PROGRESS_FAULT: "1" } : {}) },
    });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, fault ? /did not block native cancellation/ : /native Pi bash progress/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SIGKILL after a visible bash sample recovers an interrupted tool without rerunning effects or presenting it as live", { skip: !binary, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-bash-progress-crash-"));
  assert.equal(spawnSync(binary!, ["init", "--directory", directory]).status, 0);
  const checkpoint = join(directory, "checkpoint.json");
  const args = ["serve", "--stdio", "--mock", "--directory", directory, "--workspace", directory, "--runtime", fixture];
  const child = spawn(binary!, args, { env: { ...process.env, DECK_BASH_PROGRESS_CRASH: checkpoint } });
  const closed = once(child, "close"); let errors = ""; child.stderr.on("data", (chunk) => { errors += String(chunk); }); child.stdout.resume();
  try {
    let pid: number | undefined;
    for (let i = 0; i < 1000; i++) {
      try { pid = (JSON.parse(await readFile(checkpoint, "utf8")) as { pid: number }).pid; break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
    }
    assert.ok(pid, errors); process.kill(pid, "SIGKILL");
    assert.notEqual((await closed)[0], 0);
    const recovered = spawnSync(binary!, args, { encoding: "utf8", timeout: 15_000, env: { ...process.env, DECK_BASH_PROGRESS_RECOVER: "1" } });
    assert.equal(recovered.status, 0, recovered.stderr); assert.match(recovered.stdout, /interrupted preview did not replay native bash/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed;
    await rm(directory, { recursive: true, force: true });
  }
});
