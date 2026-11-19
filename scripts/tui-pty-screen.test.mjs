import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Python and pyte are terminal-shard dependencies, not production deps.
test("PTY screen projection respects synchronized output at every byte boundary", { timeout: 10000 }, async () => {
  const { stdout, stderr } = await promisify(execFile)("python3", [fileURLToPath(new URL("./tui_pty_screen_test.py", import.meta.url))], { timeout: 8000 });
  assert.equal(stdout, "");
  // execFile rejects a failing suite. Check discovery, not unittest's
  // possibly colorized success banner (Nix can set FORCE_COLOR).
  assert.match(stderr, /Ran 5 tests/);
});
