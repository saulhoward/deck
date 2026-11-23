import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const binary = process.env.DECK_TEST_BINARY;
const fixture = fileURLToPath(new URL("./user-resources.test.fixture.js", import.meta.url));
const cases = {
  links: "AGENTS.md relative/absolute/chained personal symlinks, empty and exact byte limit; same native ID retains bytes after retarget",
  refusals: "AGENTS.md invalid targets refuse promptly; .codex and inner skill files remain nofollow, skills root may link",
  "skills-links": "skills root relative/absolute/chained links outside HOME; catalog/manifest/reference receipts survive retarget; empty directory",
  "skills-refusals": "skills missing/broken/loop/file/FIFO roots, strict parent and inner nofollow boundaries, invalid paths",
  "skills-tools": "Pi loadSkill/loadHubSkill use the linked native library: metadata only, explicit scope-gated loads and disabled filters",
  import: "AGENTS.md symlink reaches Pi only after explicit import; retained receipts and failed refresh preserve the prompt snapshot",
};
for (const [mode, description] of Object.entries(cases)) test(`native user resources: ${description}`, { skip: !binary, timeout: 40_000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "deck-user-resources-native-")));
  const home = join(root, "home"), state = join(root, "state"), workspace = join(root, "workspace");
  // Never read the operator's personal resources or an installed runtime. Even
  // links outside HOME point into this test's private temporary directory.
  const env = { ...process.env, HOME: home, DECK_NODE: process.execPath, DECK_RUNTIME_ROOT: fileURLToPath(new URL("../../", import.meta.url)), DECK_USER_RESOURCES_TEST_ROOT: root, DECK_USER_RESOURCES_TEST_MODE: mode };
  try {
    await mkdir(home); await mkdir(workspace);
    const initialized = spawnSync(binary!, ["init", "--directory", state], { env, encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" });
    assert.equal(initialized.status, 0, initialized.stderr);
    const child = spawn(binary!, ["serve", "--stdio", "--mock", "--directory", state, "--workspace", workspace, "--runtime", fixture], { env, detached: true });
    const closed = once(child, "close"); let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", chunk => { stdout = (stdout + String(chunk)).slice(-8192); });
    child.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-8192); });
    // A FIFO regression must not hang the suite or strand a native reader.
    // Kill only this test-owned process group, including its runtime child.
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 30_000);
    try {
      const [code] = await closed;
      assert.equal(timedOut, false, `Native user resource fixture timed out: ${stderr}`);
      assert.equal(code, 0, stderr);
      assert.equal(stdout.trim(), `verified ${mode}`);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) kill();
      await closed;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
