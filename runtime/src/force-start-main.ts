import { fstatSync, lstatSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CompatibilityError } from "./compatibility.js";
import { DeckError } from "./deck-error.js";
import { discardUnfinished } from "./force-start.js";

// The parent keeps exclusive ownership through this helper, registry publication
// and launch. No credential lookup, runtime callbacks, model, network or native pipes.
async function main() {
  const [root, descriptor, expected, ...extra] = process.argv.slice(2);
  const fd = Number(descriptor);
  if (!root || !isAbsolute(root) || expected === undefined || extra.length || !Number.isSafeInteger(fd) || fd < 3) throw new Error("Invalid launcher");
  const dir = lstatSync(root);
  // Pi's SQLite files use the process umask; like backup/upgrade, rely on the
  // private enclosing directory rather than chmod'ing the operator's database.
  if (!dir.isDirectory() || dir.uid !== process.getuid!() || (dir.mode & 0o077)) throw new DeckError("invalid", "Force-start requires a private, owner-only state directory; nothing discarded");
  const held = fstatSync(fd, { bigint: true }), named = lstatSync(join(root, "writer.lock"), { bigint: true });
  if (!named.isFile() || named.nlink !== 1n || named.dev !== held.dev || named.ino !== held.ino) throw new Error("Invalid writer lock");
  const path = join(root, "session.sqlite");
  const mainFile = lstatSync(path, { throwIfNoEntry: false });
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const info = suffix ? lstatSync(path + suffix, { throwIfNoEntry: false }) : mainFile;
    if (info && (!mainFile || !info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!())) throw new Error("Unsafe SQLite path");
  }
  if (!mainFile) {
    if (expected) throw new DeckError("conflict", "Missing store for registered hub; nothing discarded");
    process.stderr.write("deck: --force: no stored work to discard\n");
    return;
  }
  const db = await openNodeSqliteDatabase(path);
  // The worker registry is a separate, fsynced file. Sync the discard WAL
  // commit before Zig may release a fence; don't rely on a later checkpoint.
  try { await db.exec("PRAGMA synchronous = FULL"); } catch (error) { await db.close(); throw error; }
  const storage = await SqliteStorage.open(db);
  try {
    const { tasks, submissions } = await discardUnfinished(storage, expected || undefined);
    process.stderr.write(`deck: --force: settled ${tasks} unfinished tasks and discarded ${submissions} pending submissions; external effects are not undone\n`);
  } finally { await storage.close(context); }
}
main().catch((error: unknown) => {
  process.stderr.write(`deck: ${error instanceof DeckError || error instanceof CompatibilityError ? error.message : "force-start maintenance failed or unconfirmed; inspect the offline store"}\n`);
  process.exitCode = 1;
});
