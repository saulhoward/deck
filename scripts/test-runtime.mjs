// Run after `npm run build`. New test files default to normal process isolation.
// Share one Node startup only among audited tests with no process-wide fixtures.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const dist = "runtime/dist";
const shared = new Set([
  "admin-contracts", "command-policy", "contracts", "discovery-contracts", "history-contracts",
  "mutation-contracts", "native-contracts", "protocol", "responses", "subagent-contracts", "view-contracts",
].map(name => `${dist}/${name}.test.js`));
const files = [
  ...readdirSync(dist).filter(f => f.endsWith(".test.js")).map(f => `${dist}/${f}`),
  ...readdirSync("scripts").filter(f => f.endsWith(".test.mjs")).map(f => `scripts/${f}`),
].sort();
// The real terminal suites dominate the forwarding fixtures. Keep them serial
// but independently schedulable by Nix/CI, without subdividing timed cases.
const terminal = new Set([
  "tui.test.js", "tui-tasks.test.js", "tui-history.test.js", "mcp-pi.test.js", "agent-startup.test.js",
].map(f => `${dist}/${f}`));
terminal.add("scripts/tui-pty-screen.test.mjs");
const suite = process.argv[2] ?? "all";
if (!["all", "integration", "terminal"].includes(suite)) throw new Error(`Unknown suite: ${suite}`);
const jobs = process.env.DECK_TEST_CONCURRENCY ?? "1";
if (!/^[1-9]\d*$/.test(jobs)) throw new Error("DECK_TEST_CONCURRENCY must be a positive integer");

function run(label, flags, tests) {
  console.error(`Running ${label} (${tests.length} files)`);
  const start = performance.now();
  const result = spawnSync(process.execPath, ["--test", ...flags, ...tests], { stdio: "inherit" });
  console.error(`${label}: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (suite !== "terminal") {
  run("shared-process contracts", ["--test-isolation=none"], [...shared]);
  run("isolated tests", [`--test-concurrency=${jobs}`], files.filter(f => !shared.has(f) && !terminal.has(f)));
}
if (suite !== "integration") run("terminal tests", ["--test-concurrency=1"], [...terminal]);
