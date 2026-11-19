import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Included by npm test and the Nix package's scripts/*.test.mjs run. Python and
// pyte are existing dev-shell/package test dependencies, not production deps.
test("PTY screen projection respects synchronized output at every byte boundary", { timeout: 10000 }, async () => {
  const { stdout, stderr } = await promisify(execFile)("python3", [fileURLToPath(new URL("./tui_pty_screen_test.py", import.meta.url))], { timeout: 8000 });
  assert.equal(stdout, "");
  assert.match(stderr, /Ran 5 tests/);
  assert.match(stderr, /\bOK\b/);
});
