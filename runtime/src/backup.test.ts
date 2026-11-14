import assert from "node:assert/strict";
import { chmod, lstat, mkdir, open, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { BackupError, makeBackup, RESTORE_MARKER, restoreBackup } from "./backup.js";
const CONFIG = JSON.stringify({ version: 1, machine_id: "a".repeat(32) });
async function state(root: string) {
  await mkdir(root, { mode: 0o700 }); await writeFile(join(root, "config.json"), CONFIG, { mode: 0o600 });
}
async function staged(root: string) {
  await mkdir(root, { mode: 0o700 }); await writeFile(join(root, "writer.lock"), "", { mode: 0o600 }); await writeFile(join(root, RESTORE_MARKER), "incomplete", { mode: 0o600 });
}
async function archive(root: string) {
  const source = join(root, "state"); await state(source);
  const out = join(root, "backup"); await makeBackup(source, out); return { source, out };
}

test("offline backup incorporates WAL via SQLite, preserves receipts/config, excludes credentials by default and restores privately", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-backup-")); const source = join(root, "state"); await state(source);
  const db = new DatabaseSync(join(source, "session.sqlite"));
  try {
    db.exec("PRAGMA page_size=65536; PRAGMA journal_mode=WAL; CREATE TABLE fixture (value TEXT)");
    const value = "WAL_ONLY_VALUE_" + "x".repeat(200_000); db.prepare("INSERT INTO fixture VALUES (?)").run(value);
    await mkdir(join(source, "worker", "operations"), { recursive: true, mode: 0o700 });
    const receipt = '{"hash":"stable","result":null}'; await writeFile(join(source, "worker", "operations", "42.json"), receipt, { mode: 0o600 });
    await writeFile(join(source, "worker", "operations", "43.json.tmp"), "unpublished receipt", { mode: 0o600 });
    await writeFile(join(source, "auth.json"), "PRIVATE_FAKE_CREDENTIAL", { mode: 0o600 });
    await writeFile(join(source, "serve-test.log"), "PRIVATE_LOG", { mode: 0o600 });
    const registration = JSON.stringify({ version: 1, hubId: "00000000-0000-4000-8000-000000000001", hosts: [] });
    await writeFile(join(source, "rex-workers.json"), registration, { mode: 0o600 });
    await writeFile(join(source, `.${"a".repeat(32)}.tmp`), "unpublished registration", { mode: 0o600 });
    await mkdir(join(source, "client"), { mode: 0o700 });
    await writeFile(join(source, "client", "draft"), "PRIVATE_CLIENT_STATE", { mode: 0o600 });
    const before = await readFile(join(source, "session.sqlite")); const wal = await readFile(join(source, "session.sqlite-wal"));
    const backup = join(root, "backup"); assert.equal((await makeBackup(source, backup)).credentials, false);
    assert.deepEqual(await readFile(join(source, "session.sqlite")), before); assert.deepEqual(await readFile(join(source, "session.sqlite-wal")), wal);
    const files = await readdir(join(backup, "files")); assert.ok(!files.includes("auth.json")); assert.ok(!files.some((path) => path.endsWith("-wal") || path.endsWith("-shm")));
    assert.equal((await lstat(backup)).mode & 0o777, 0o700); assert.equal((await lstat(join(backup, "manifest.json"))).mode & 0o777, 0o600);
    const restored = join(root, "restored"); await staged(restored); await restoreBackup(backup, restored);
    await assert.rejects(lstat(join(restored, RESTORE_MARKER)), { code: "ENOENT" });
    assert.equal(await readFile(join(restored, "config.json"), "utf8"), CONFIG);
    assert.equal(await readFile(join(restored, "rex-workers.json"), "utf8"), registration);
    await assert.rejects(lstat(join(restored, "client")), { code: "ENOENT" });
    assert.ok(!files.some(name => name.endsWith(".tmp")));
    assert.equal(await readFile(join(source, "client", "draft"), "utf8"), "PRIVATE_CLIENT_STATE");
    assert.equal(await readFile(join(restored, "worker", "operations", "42.json"), "utf8"), receipt);
    assert.deepEqual(await readdir(join(restored, "worker", "operations")), ["42.json"]);
    const recovered = new DatabaseSync(join(restored, "session.sqlite"), { readOnly: true });
    try { assert.equal(recovered.prepare("SELECT value FROM fixture").get()!.value, value); } finally { recovered.close(); }
    for (const name of ["config.json", "session.sqlite", "worker/operations/42.json", "rex-workers.json"]) assert.equal((await lstat(join(restored, name))).mode & 0o777, 0o600);
    const withAuth = join(root, "with-auth"); await makeBackup(source, withAuth, true);
    const authRestore = join(root, "auth-restored"); await staged(authRestore); await restoreBackup(withAuth, authRestore);
    assert.equal(await readFile(join(authRestore, "auth.json"), "utf8"), "PRIVATE_FAKE_CREDENTIAL"); assert.equal((await lstat(join(authRestore, "auth.json"))).mode & 0o777, 0o600);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("backups refuse existing/overlapping outputs, unknown state data and incomplete/unsafe source roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-backup-refusal-"));
  try {
    const { source, out } = await archive(root); const manifest = await readFile(join(out, "manifest.json"));
    await assert.rejects(makeBackup(source, out)); assert.deepEqual(await readFile(join(out, "manifest.json")), manifest);
    await assert.rejects(makeBackup(source, join(source, "nested")), BackupError);
    await writeFile(join(source, "future-state"), "not yet understood", { mode: 0o600 }); await assert.rejects(makeBackup(source, join(root, "new")), BackupError); await rm(join(source, "future-state"));
    await writeFile(join(source, RESTORE_MARKER), "incomplete", { mode: 0o600 }); await assert.rejects(makeBackup(source, join(root, "incomplete")), BackupError); await rm(join(source, RESTORE_MARKER));
    await chmod(source, 0o755); await assert.rejects(makeBackup(source, join(root, "unsafe")), BackupError); await chmod(source, 0o700);
    await symlink(source, join(root, "alias")); await assert.rejects(makeBackup(join(root, "alias"), join(root, "aliased")), BackupError);
    await symlink(root, join(source, "client")); await assert.rejects(makeBackup(source, join(root, "client-symlink")), BackupError); await rm(join(source, "client"));
    await writeFile(join(source, "rex-workers.json"), "{}", { mode: 0o644 }); await assert.rejects(makeBackup(source, join(root, "public-registry")), BackupError); await rm(join(source, "rex-workers.json"));
    const existing = join(root, "existing"); await state(existing); await assert.rejects(restoreBackup(out, existing), BackupError);
    assert.equal(await readFile(join(existing, "config.json"), "utf8"), CONFIG);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mutation of ["version", "path", "duplicate", "hash", "size", "count", "missing-manifest", "credentials", "extra", "symlink", "directory", "corrupt-db"] as const) {
  test(`invalid backup ${mutation} never publishes a restored state`, async () => {
    const root = await mkdtemp(join(tmpdir(), "deck-backup-invalid-"));
    try {
      const { out } = await archive(root);
      const path = join(out, "manifest.json"); const manifest = JSON.parse(await readFile(path, "utf8"));
      if (mutation === "version") manifest.version = 2;
      if (mutation === "path") manifest.files[0].path = "../outside";
      if (mutation === "duplicate") manifest.files.push(manifest.files[0]);
      if (mutation === "hash") manifest.files[0].sha256 = "f".repeat(64);
      if (mutation === "size") manifest.files[0].size = 513 * 1024 * 1024;
      if (mutation === "count") manifest.files = Array.from({ length: 10_001 }, () => manifest.files[0]);
      if (mutation === "credentials") { manifest.credentials = false; manifest.files.push({ path: "auth.json", size: 1, sha256: "a".repeat(64) }); }
      if (mutation === "extra") await writeFile(join(out, "files", "unknown"), "extra", { mode: 0o600 });
      if (mutation === "symlink") { await rm(join(out, "files", "config.json")); await symlink(join(root, "state", "config.json"), join(out, "files", "config.json")); }
      if (mutation === "directory") { await rm(join(out, "files", "config.json")); await mkdir(join(out, "files", "config.json")); }
      if (mutation === "corrupt-db") {
        const { createHash } = await import("node:crypto"); const bytes = Buffer.from("not sqlite");
        await writeFile(join(out, "files", "session.sqlite"), bytes, { mode: 0o600 });
        manifest.files.push({ path: "session.sqlite", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      await writeFile(path, JSON.stringify(manifest)); if (mutation === "missing-manifest") await rm(path);
      const restored = join(root, "restored"); await staged(restored);
      await assert.rejects(restoreBackup(out, restored)); assert.ok(await lstat(join(restored, RESTORE_MARKER)));
      await assert.rejects(lstat(join(restored, "config.json")), { code: "ENOENT" });
      assert.equal(await readFile(join(root, "state", "config.json"), "utf8"), CONFIG); await assert.rejects(lstat(join(root, "outside")), { code: "ENOENT" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("oversized files fail before copying and no completion manifest is published", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-backup-bounds-"));
  try {
    const source = join(root, "state"); await state(source); await mkdir(join(source, "worker", "operations"), { recursive: true, mode: 0o700 });
    const file = await open(join(source, "worker", "operations", "1.json"), "wx", 0o600);
    try { await file.truncate(513 * 1024 * 1024); } finally { await file.close(); }
    const output = join(root, "backup"); await assert.rejects(makeBackup(source, output), BackupError);
    await assert.rejects(lstat(join(output, "manifest.json")), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("symlinked receipts and credential files are never followed; excluded credentials are not read", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-backup-links-"));
  try {
    const source = join(root, "state"); await state(source); const privatePath = join(root, "private"); await writeFile(privatePath, "PRIVATE", { mode: 0o600 });
    await symlink(privatePath, join(source, "auth.json"));
    await makeBackup(source, join(root, "without-auth")); await assert.rejects(makeBackup(source, join(root, "with-auth"), true));
    await mkdir(join(source, "worker", "operations"), { recursive: true, mode: 0o700 }); await symlink(privatePath, join(source, "worker", "operations", "1.json"));
    await assert.rejects(makeBackup(source, join(root, "receipt-link")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
