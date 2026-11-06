import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CHANGED, ORIGINAL, within } from "./instructions.test.support.js";
const binary = process.env.DECK_TEST_BINARY;
const fixture = fileURLToPath(new URL("./instruction-import.test.fixture.js", import.meta.url));

for (const point of ["admitted", "read", "applied"] as const) test(`native import SIGKILL after ${point}: same Pi task and ${point === "admitted" ? "first issued read captures current bytes" : point === "read" ? "retained worker bytes, not changed source" : "no new read after atomic application"}`, { skip: !binary, timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-import-native-")); const state = join(root, "state"); const marker = join(root, "probe");
  assert.equal(spawnSync(binary!, ["init", "--directory", state]).status, 0);
  await writeFile(join(root, "AGENTS.md"), ORIGINAL);
  const args = ["serve", "--stdio", "--mock", "--directory", state, "--workspace", root, "--runtime", fixture];
  const supervisor = spawn(binary!, args, { env: { ...process.env, DECK_IMPORT_TEST_POINT: point, DECK_IMPORT_TEST_CHECKPOINT: marker } });
  supervisor.stdout.resume(); let errors = ""; supervisor.stderr.on("data", (chunk) => { errors = (errors + String(chunk)).slice(-8192); });
  const closed = once(supervisor, "close"); let writer: number | undefined;
  try {
    const checkpoint = await within((async () => {
      for (;;) {
        try { return JSON.parse(await readFile(`${marker}.checkpoint`, "utf8")) as { pid: number; taskId: string }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (supervisor.exitCode !== null) throw new Error(`Fixture exited: ${errors}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    })());
    writer = checkpoint.pid; process.kill(writer, "SIGKILL"); writer = undefined;
    await within(closed); assert.notEqual(supervisor.exitCode, 0);
    const journal = join(state, "worker", "operations");
    if (point !== "admitted") assert.equal(JSON.parse(await readFile(join(journal, `${checkpoint.taskId}.json`), "utf8")).result.output, ORIGINAL);
    await writeFile(join(root, "AGENTS.md"), CHANGED);
    const expected = point === "admitted" ? CHANGED : ORIGINAL;
    const recovered = spawnSync(binary!, args, { encoding: "utf8", timeout: 10_000, env: { ...process.env, DECK_IMPORT_TEST_EXPECTED: expected } });
    assert.equal(recovered.status, 0, recovered.stderr);
    const output = JSON.parse(recovered.stdout);
    assert.equal(output.taskId, checkpoint.taskId); assert.equal(output.reads, point === "applied" ? 0 : 1); assert.equal(output.calls, 1);
    assert.equal(output.result.source.sha256, createHash("sha256").update(expected).digest("hex"));
    assert.equal(output.result.source.cwd, await realpath(root)); assert.equal(output.result.source.path, "AGENTS.md");
    assert.deepEqual((await readdir(journal)).filter((name) => name.endsWith(".json")), [`${checkpoint.taskId}.json`]);
  } finally {
    if (writer) { try { process.kill(writer, "SIGKILL"); } catch { /* Already exited. */ } }
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    await within(closed); await rm(root, { recursive: true, force: true });
  }
});

test("native import refuses missing/non-UTF8/oversized/offline/uncertain sources without inference, fallback or replacing prior instructions", { skip: !binary, timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-import-errors-"));
  try {
    for (const kind of ["missing", "utf8", "large", "offline", "uncertain"] as const) {
      const state = join(root, kind);
      assert.equal(spawnSync(binary!, ["init", "--directory", state]).status, 0);
      const file = join(state, "AGENTS.md");
      if (kind !== "missing") await writeFile(file, kind === "utf8" ? Buffer.from([0xff, 0xfe]) : kind === "large" ? "a".repeat(32 * 1024 + 1) : "MUST_NOT_BE_USED");
      const reason = kind === "offline" ? "offline" : kind === "uncertain" ? "effect_uncertain" : kind === "large" ? "too_large" : "read_failed";
      const result = spawnSync(binary!, ["serve", "--stdio", "--mock", "--directory", state, "--workspace", state, "--runtime", fixture], {
        encoding: "utf8", timeout: 10_000, env: { ...process.env, DECK_IMPORT_TEST_FAILURE: reason, ...(kind === "offline" ? { DECK_IMPORT_TEST_OFFLINE: "1" } : {}), ...(kind === "uncertain" ? { DECK_IMPORT_TEST_UNCERTAIN: "1" } : {}) },
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout); assert.equal(output.calls, 0); assert.equal(output.reads, 1);
      if (kind === "uncertain") assert.equal(JSON.parse(await readFile(join(state, "worker", "operations", `${output.taskId}.json`), "utf8")).result, null);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
