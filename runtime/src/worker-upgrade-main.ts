import { closeSync, fstatSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { upgrade, UpgradeError } from "./worker-upgrade.js";
import { CompatibilityError } from "./compatibility.js";
const [mode, state, from, output, descriptor, client, implementation] = process.argv.slice(2);
let lock: number | undefined;
try {
  if (!state || from === undefined || output === undefined || !descriptor || !/^[0-9]+$/.test(descriptor) || Number(descriptor) < 3 || !client || !implementation || !["prepare", "approve", "apply"].includes(mode ?? "")) throw new UpgradeError();
  lock = Number(descriptor);
  const inherited = fstatSync(lock), expected = lstatSync(join(state, "writer.lock"));
  if (!inherited.isFile() || !expected.isFile() || inherited.dev !== expected.dev || inherited.ino !== expected.ino) throw new UpgradeError();
  await upgrade({ mode: mode as "prepare" | "approve" | "apply", state, from, output, client, implementation });
  process.stdout.write(mode === "prepare" ? "Worker upgrade plan prepared; pins unchanged. Keep services stopped; approve this private plan on the hub.\n" : mode === "approve" ? "Hub registration committed. Keep services stopped until worker apply succeeds; retry this same plan if acknowledgement was lost.\n" : "Worker transition committed; identity, session and receipts retained. Restart the hub and worker with their approved packages. No work was replayed.\n");
} catch (error) {
  process.stderr.write(`deck: worker upgrade failed/unconfirmed: ${error instanceof UpgradeError ? error.message : error instanceof CompatibilityError ? "hub work is not drained; use the original implementation to settle all tasks/submissions" : "check private artifacts, canonical idle hub state and supported formats"}. Keep services stopped; retry the same artifact, not a pin reset.\n`);
  process.exitCode = 1;
} finally { if (lock !== undefined) { try { closeSync(lock); } catch { /* Process teardown also closes it. */ } } }
