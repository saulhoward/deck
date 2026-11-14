// Offline administrative artifacts, never another live store or a Pi adapter.
// Call only while the launcher and this process share the state's writer lock.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

const MAX_FILES = 10_000;
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST = 2 * 1024 * 1024;
export const RESTORE_MARKER = ".restore-incomplete";
type FileRecord = { path: string; size: number; sha256: string };
type Manifest = { format: "deck-offline-backup"; version: 1; credentials: boolean; files: FileRecord[] };
export class BackupError extends Error { constructor() { super("Invalid, unsupported, insecure or oversized backup/state"); } }
function check(ok: unknown): asserts ok { if (!ok) throw new BackupError(); }
function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function owner(info: { uid: number; mode: number }, privateMode = false) {
  check(info.uid === process.getuid!() && !(info.mode & (privateMode ? 0o077 : 0o022)));
}
async function directory(path: string, privateMode = false) {
  const info = await lstat(path); check(info.isDirectory() && !info.isSymbolicLink()); owner(info, privateMode);
}
async function file(path: string, privateMode = false) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const info = await handle.stat(); check(info.isFile()); owner(info, privateMode); return { handle, size: info.size }; }
  catch (error) { await handle.close(); throw error; }
}
async function small(path: string, limit: number) {
  const { handle, size } = await file(path, true);
  try {
    check(size <= limit); const bytes = Buffer.alloc(limit + 1); let used = 0;
    while (used < bytes.length) { const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null); if (!bytesRead) break; used += bytesRead; }
    check(used === size && used <= limit); return bytes.subarray(0, used);
  } finally { await handle.close(); }
}
async function names(path: string) {
  const entries: string[] = [];
  for await (const entry of await opendir(path)) { entries.push(entry.name); check(entries.length <= MAX_FILES + 32); }
  return entries.sort();
}
function config(bytes: Buffer) {
  check(bytes.length <= 16 * 1024);
  const value = JSON.parse(bytes.toString("utf8")) as { version?: unknown; machine_id?: unknown };
  check(value && value.version === 1 && typeof value.machine_id === "string" && /^[\da-fA-F]{32}$/.test(value.machine_id));
}
function allowed(path: string) { return ["config.json", "session.sqlite", "auth.json", "rex-workers.json"].includes(path) || /^worker\/operations\/(?:\d{1,20}\.json|mcp-[0-9a-f]{64}\.stale)$/.test(path); }
async function absent(path: string) {
  try { await lstat(path); } catch (error) { if (missing(error)) return; throw error; }
  throw new BackupError();
}
async function target(source: string, destination: string) {
  const from = await realpath(source);
  const out = join(await realpath(dirname(resolve(destination))), basename(resolve(destination)));
  check(from !== out && !out.startsWith(from + sep) && !from.startsWith(out + sep));
  await absent(out); return out;
}
async function contents(root: string, state: boolean): Promise<string[]> {
  const paths: string[] = [];
  for (const name of await names(root)) {
    if (["config.json", "session.sqlite", "auth.json", "rex-workers.json"].includes(name)) paths.push(name);
    else if (state && name === "client") {
      // Client drafts/startup metadata and detached worker states are separate
      // recovery domains. Do not traverse, copy or stop them with the hub.
      await directory(join(root, name), true);
    } else if (name === "worker") {
      await directory(join(root, name));
      for (const child of await names(join(root, name))) check(child === "operations");
      const operations = join(root, name, "operations");
      try { await directory(operations); } catch (error) { if (missing(error)) continue; throw error; }
      for (const operation of await names(operations)) {
        if (state && /^(?:\d{1,20}\.json\.tmp|\d{1,20}\.json\.[0-9a-f]{32}\.mcp-tmp)$/.test(operation)) continue; // Unpublished temporary name; any linked acceptance remains at the numeric receipt path.
        check(/^(?:\d{1,20}\.json|mcp-[0-9a-f]{64}\.stale)$/.test(operation)); paths.push(`worker/operations/${operation}`);
        check(paths.length <= MAX_FILES);
      }
    } else {
      check(state && (["writer.lock", "session.sqlite-wal", "session.sqlite-shm", "config.json.tmp", ".DS_Store"].includes(name) || /^serve-[\w-]+\.log$/.test(name) || /^auth\.json\.[\da-f-]+\.tmp$/.test(name) || /^\.[0-9a-f]{32}\.tmp$/.test(name)));
      const info = await lstat(join(root, name)); check(info.isFile() && !info.isSymbolicLink()); owner(info);
    }
  }
  check(paths.includes("config.json") && paths.length <= MAX_FILES); return paths.sort();
}
async function copy(source: string, destination: string | undefined, path: string, budget: { used: number }, name = path, expected?: FileRecord): Promise<FileRecord> {
  const { handle, size } = await file(join(source, path), path === "auth.json" || path === "rex-workers.json");
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    check(size <= MAX_BYTES - budget.used && (!expected || expected.size === size));
    if (path === "rex-workers.json") check(size <= 64 * 1024);
    if (destination) {
      if (path.startsWith("worker/")) await mkdir(join(destination, "worker", "operations"), { recursive: true, mode: 0o700 });
      output = await open(join(destination, name), "wx", 0o600);
    }
    const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024); let count = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      count += bytesRead; check(count <= size && count <= MAX_BYTES - budget.used);
      const bytes = buffer.subarray(0, bytesRead); hash.update(bytes); if (output) await output.writeFile(bytes);
    }
    check(count === size); const sha256 = hash.digest("hex"); check(!expected || expected.sha256 === sha256);
    budget.used += count; await output?.sync();
    return { path, size: count, sha256 };
  } finally { await handle.close(); await output?.close(); }
}
function quickCheck(path: string, portable = false) {
  const db = new DatabaseSync(path, { readOnly: !portable, allowExtension: false });
  try {
    // Only the new artifact is normalized: it must not depend on WAL/SHM files.
    if (portable) check(db.prepare("PRAGMA journal_mode=DELETE").get()!.journal_mode === "delete");
    check(db.prepare("PRAGMA journal_mode").get()!.journal_mode === "delete");
    const rows = db.prepare("PRAGMA quick_check").all(); check(rows.length === 1 && rows[0]!.quick_check === "ok");
  }
  finally { db.close(); }
}
function parseManifest(bytes: Buffer): Manifest {
  const manifest = JSON.parse(bytes.toString("utf8")) as Manifest;
  check(manifest && manifest.format === "deck-offline-backup" && manifest.version === 1 && typeof manifest.credentials === "boolean" && Array.isArray(manifest.files) && manifest.files.length <= MAX_FILES);
  check(Object.keys(manifest).sort().join() === "credentials,files,format,version");
  const seen = new Set<string>(); let total = 0;
  for (const record of manifest.files) {
    check(record && Object.keys(record).sort().join() === "path,sha256,size" && typeof record.path === "string" && allowed(record.path) && !seen.has(record.path));
    check(Number.isSafeInteger(record.size) && record.size >= 0 && typeof record.sha256 === "string" && /^[\da-f]{64}$/.test(record.sha256));
    seen.add(record.path); total += record.size; check(total <= MAX_BYTES);
  }
  check(seen.has("config.json") && seen.has("auth.json") === manifest.credentials); return manifest;
}

export async function makeBackup(sourcePath: string, destination: string, includeCredentials = false) {
  const source = resolve(sourcePath); await directory(source, true);
  await absent(join(source, RESTORE_MARKER));
  config(await small(join(source, "config.json"), 16 * 1024));
  const paths = await contents(source, true); const out = await target(source, destination);
  await mkdir(out, { mode: 0o700 }); const files = join(out, "files"); await mkdir(files, { mode: 0o700 });
  const manifest: Manifest = { format: "deck-offline-backup", version: 1, credentials: includeCredentials && paths.includes("auth.json"), files: [] };
  const budget = { used: 0 };
  for (const path of paths) {
    if (path === "auth.json" && !includeCredentials) continue;
    if (path === "session.sqlite") {
      // SQLite's backup API incorporates committed WAL pages without opening Pi,
      // resuming tasks, checkpointing the source or running a schema migration.
      const opened = await file(join(source, path)); await opened.handle.close(); check(opened.size <= MAX_BYTES - budget.used);
      const db = new DatabaseSync(join(source, path), { readOnly: true, allowExtension: false });
      try {
        const pageSize = Number(db.prepare("PRAGMA page_size").get()!.page_size);
        check(Number.isSafeInteger(pageSize) && pageSize >= 512 && pageSize <= 65536);
        await backup(db, join(files, path), { rate: 64, progress: ({ totalPages }) => { check(totalPages * pageSize <= MAX_BYTES - budget.used); } });
      } finally { db.close(); }
      await chmod(join(files, path), 0o600); quickCheck(join(files, path), true);
      const snapshot = await open(join(files, path), "r+");
      try { await snapshot.sync(); } finally { await snapshot.close(); }
      manifest.files.push(await copy(files, undefined, path, budget));
    } else manifest.files.push(await copy(source, files, path, budget));
  }
  const bytes = Buffer.from(JSON.stringify(manifest)); check(bytes.length <= MAX_MANIFEST);
  const temporary = join(out, ".manifest.tmp"); const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await link(temporary, join(out, "manifest.json")); await unlink(temporary);
  return { files: manifest.files.length, credentials: manifest.credentials };
}

export async function restoreBackup(backupPath: string, destination: string) {
  const source = resolve(backupPath); const out = resolve(destination);
  await directory(source, true); await directory(out, true);
  const from = await realpath(source); const to = await realpath(out);
  check(from !== to && !from.startsWith(to + sep) && !to.startsWith(from + sep));
  check((await names(out)).every((name) => ["writer.lock", RESTORE_MARKER].includes(name)));
  await small(join(out, RESTORE_MARKER), 1024);
  const manifest = parseManifest(await small(join(source, "manifest.json"), MAX_MANIFEST));
  const files = join(source, "files"); await directory(files, true);
  const paths = await contents(files, false);
  check(paths.join("\n") === manifest.files.map((record) => record.path).sort().join("\n"));
  config(await small(join(files, "config.json"), 16 * 1024));
  const budget = { used: 0 };
  for (const record of manifest.files) {
    await copy(files, out, record.path, budget, record.path === "config.json" ? ".restore-config" : record.path, record);
  }
  if (paths.includes("session.sqlite")) quickCheck(join(out, "session.sqlite"));
  // Publish config only after every payload file is verified/synced. Even an
  // older serve that does not know the marker cannot open a partial image.
  await link(join(out, ".restore-config"), join(out, "config.json"));
  await unlink(join(out, ".restore-config"));
  // Updated init/serve also reject any marker left by an interrupted restore.
  await unlink(join(out, RESTORE_MARKER));
  return { files: manifest.files.length, credentials: paths.includes("auth.json") };
}
