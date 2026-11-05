import { closeSync, fstatSync, statSync } from "node:fs";
import { join } from "node:path";
import { makeBackup, restoreBackup } from "./backup.js";
const [mode, state, artifact, descriptor, credentials] = process.argv.slice(2);
let lock: number | undefined;
try {
  if (!state || !artifact || !descriptor || !/^\d+$/.test(descriptor) || Number(descriptor) < 3 || !["backup", "restore"].includes(mode ?? "") || !["include", "exclude"].includes(credentials ?? "")) throw new Error();
  lock = Number(descriptor);
  const inherited = fstatSync(lock); const expected = statSync(join(state, "writer.lock"));
  if (inherited.dev !== expected.dev || inherited.ino !== expected.ino || !inherited.isFile()) throw new Error();
  if (mode === "backup") {
    const result = await makeBackup(state, artifact, credentials === "include");
    process.stdout.write(`Backup complete; stored credentials ${result.credentials ? "included" : "not included"}. Backup contents are private sensitive data.\n`);
  } else {
    await restoreBackup(artifact, state);
    process.stdout.write("Restore complete; no work resumed. Unfinished work still requires its original implementation.\n");
  }
} catch {
  process.stderr.write("deck: backup/restore failed; check privacy, format, space and destination. Incomplete destinations were not activated.\n");
  process.exitCode = 1;
} finally { if (lock !== undefined) { try { closeSync(lock); } catch { /* Process teardown also closes it. */ } } }
