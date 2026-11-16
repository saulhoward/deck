// Offline, operator-approved automatic-worker transition. No Harness, RPC,
// effect execution, process signalling, pin repair, or automatic rollback.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, mkdtemp, rm, link, unlink, rename } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { backup, DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { requireIdleStorage } from "./compatibility.js";
import { validRexClient, validRexRegistration } from "./remote-contracts.js";
import { validMachineIdentity, validNativeReceipt, validMcpReceipt, validRexWorkerConnection, validRexWorkerRegistry, validRexWorkerUpgrade, type RexWorkerConnection, type RexWorkerRegistry, type RexWorkerUpgrade, type RexWorkerRegistration } from "./generated/contracts.js";
const MAX_BYTES = 512 * 1024 * 1024;
export class UpgradeError extends Error { constructor(message = "Invalid, changed, unsupported or unsafe upgrade state") { super(message); } }
function check(ok: unknown, message?: string): asserts ok { if (!ok) throw new UpgradeError(message); }
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
// Structural comparison is independent of JSON member ordering, but never
// changes receipt bytes or their request hashes.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function owner(info: { uid: number; mode: number }) { check(info.uid === process.getuid!() && !(info.mode & 0o077)); }
async function directory(path: string) {
  check(isAbsolute(path)); const info = await lstat(path); check(info.isDirectory() && !info.isSymbolicLink()); owner(info);
  check(await realpath(path) === resolve(path), "Use canonical state/artifact directories, without symlink ancestors");
}
async function read(path: string, limit = 64 * 1024): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat(); check(info.isFile() && info.size <= limit); owner(info);
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count < bytes.length) { const { bytesRead } = await file.read(bytes, count, bytes.length - count, null); if (!bytesRead) break; count += bytesRead; }
    check(count === info.size && count <= limit); return bytes.subarray(0, count);
  } finally { await file.close(); }
}
async function absent(path: string) {
  try { await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new UpgradeError("Incomplete restore/state cannot be upgraded");
}
async function syncDirectory(path: string) { const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { await file.sync(); } finally { await file.close(); } }
// Retry after lost ACK is idempotent. Never overwrite another artifact. Metadata
// replacement uses atomic rename, then parent fsync; fsync failure is unconfirmed.
async function publish(path: string, value: unknown, replace = false) {
  await directory(dirname(path)); const bytes = Buffer.from(JSON.stringify(value)); check(bytes.length <= 64 * 1024);
  if (!replace) {
    try { check(equal(JSON.parse((await read(path)).toString()), value), "Output exists with different contents"); await syncDirectory(dirname(path)); return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const temporary = join(dirname(path), `.${randomUUID().replaceAll("-", "")}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes); await file.sync();
    if (replace) await rename(temporary, path); else await link(temporary, path);
    await syncDirectory(dirname(path));
  } finally { await file.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}
async function config(state: string) {
  await directory(state); await absent(join(state, ".restore-incomplete"));
  const bytes = await read(join(state, "config.json"), 16384); const parsed = JSON.parse(bytes.toString()) as { version?: unknown; machine_id?: unknown };
  check(parsed.version === 1 && validMachineIdentity(parsed.machine_id)); return { machine: parsed.machine_id, digest: hash(bytes) };
}
async function connection(state: string): Promise<RexWorkerConnection> {
  const value: unknown = JSON.parse((await read(join(state, "rex-connection.json"), 16384)).toString());
  check(validRexWorkerConnection(value) && validRexClient(value.rexClient));
  check(value.hubId && value.sessionId && !value.pendingSession, "Enrollment/session ownership is unconfirmed; no upgrade permitted"); return value;
}
// Validate supported retained formats and hash exact bytes under writer exclusion.
// Accepted-without-result remains uncertain; it is neither converted nor removed.
async function receipts(state: string) {
  const root = join(state, "operations"); await directory(root);
  const names: string[] = [];
  for await (const entry of await opendir(root)) { check(entry.isFile() && /^(?:[0-9]{1,20}\.json(?:\.tmp|\.[a-f0-9]{32}\.mcp-tmp)?|mcp-[a-f0-9]{64}\.stale)$/.test(entry.name)); names.push(entry.name); check(names.length <= 10_000); }
  let total = 0; const manifest: [string, number, string][] = [];
  for (const name of names.sort()) {
    const bytes = await read(join(root, name), 256 * 1024); total += bytes.length; check(total <= MAX_BYTES);
    if (/^[0-9]+\.json$/.test(name)) { const value: unknown = JSON.parse(bytes.toString()); check(validNativeReceipt(value) || validMcpReceipt(value), "Unsupported retained receipt format"); }
    manifest.push([name, bytes.length, hash(bytes)]);
  }
  return hash(canonical(manifest));
}
function validatePlan(value: unknown): asserts value is RexWorkerUpgrade {
  check(validRexWorkerUpgrade(value));
  check(validRexClient(value.client) && validRexClient(value.before.rexClient) && value.before.hubId && value.before.sessionId && !value.before.pendingSession);
  check(value.client.socket === value.before.rexClient.socket, "Worker socket ownership cannot migrate");
  check(value.implementation !== value.before.implementation || value.client.executable !== value.before.rexClient.executable, "Worker already uses this implementation/client");
}
async function artifact(path: string) { await directory(dirname(path)); const value: unknown = JSON.parse((await read(path)).toString()); validatePlan(value); return value; }
function replacement(plan: RexWorkerUpgrade): RexWorkerConnection { return { ...plan.before, implementation: plan.implementation, rexClient: plan.client }; }
function matches(registration: RexWorkerRegistration, plan: RexWorkerUpgrade, after: boolean) {
  const c = after ? replacement(plan) : plan.before;
  return registration.hubId === c.hubId && registration.machineId === plan.machineId && registration.implementation === c.implementation && equal(registration.rexClient, c.rexClient) && registration.capabilities.join(",") === "files,bash,rex,launcher";
}
// Source database is SQLite read-only. Run public Pi storage reads against a
// disposable snapshot only: even adapter schema initialization cannot alter the
// original store. Never open a Harness or normalize/restart execution tasks.
export async function checkHubIdle(state: string, hubId: string): Promise<void> {
  const path = join(state, "session.sqlite"); const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // Pi creates SQLite files using the process umask; the already-checked
    // owner-only state directory supplies their privacy. Do not chmod a store.
    const info = await file.stat(); check(info.isFile() && info.size <= MAX_BYTES && info.uid === process.getuid!());
  } finally { await file.close(); }
  const temporary = await mkdtemp(join(tmpdir(), "deck-upgrade-check-"));
  try {
    const snapshot = join(temporary, "session.sqlite");
    const source = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      const size = Number(source.prepare("PRAGMA page_size").get()!.page_size); check(size >= 512 && size <= 65536);
      await backup(source, snapshot, { rate: 64, progress: ({ totalPages }) => check(totalPages * size <= MAX_BYTES) });
    } finally { source.close(); }
    const storage = await openNodeSqliteStorage(snapshot);
    try {
      const identity = await storage.findDocument({ kind: "deck.identity", scope: { kind: "session" } }, "current", context);
      const saved = identity ? await storage.document(identity.id, "current", context) : undefined;
      check(saved?.version === 1 && saved.value.id === hubId, "Canonical hub identity differs from the worker plan");
      await requireIdleStorage(storage);
    } finally { await storage.close(context); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export type UpgradeOptions = { mode: "prepare" | "approve" | "apply"; state: string; from: string; output: string; client: string; implementation: string };
// Native launcher owns the real writer lock for this entire call. Exported for
// disposable-state testing only; no online caller may invoke it.
export async function upgrade(options: UpgradeOptions): Promise<void> {
  const { mode, state, from, output, client, implementation } = options;
  const identity = await config(state);
  if (output) { check(isAbsolute(output) && output !== state && !output.startsWith(state + sep), "Keep transfer artifacts outside the service state"); await directory(dirname(output)); }
  if (mode === "prepare") {
    check(/^[a-f0-9]{64}$/.test(implementation));
    const before = await connection(state);
    const plan: RexWorkerUpgrade = { version: 1, kind: "prepared", id: randomUUID(), machineId: identity.machine, configHash: identity.digest, receiptsHash: await receipts(state), before, implementation, client: { executable: client, socket: before.rexClient.socket } };
    validatePlan(plan);
    // Preparing again must use its existing id when all evidence is unchanged.
    try { const saved = await artifact(output); check(saved.kind === "prepared" && equal({ ...plan, id: saved.id }, saved), "Existing plan differs; inspect it, do not overwrite it"); await syncDirectory(dirname(output)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await publish(output, plan); }
    return;
  }
  const plan = await artifact(from);
  if (mode === "approve") {
    check(plan.kind === "prepared" && plan.machineId !== identity.machine && from !== output);
    try { check(equal(await artifact(output), { ...plan, kind: "approved" }), "Approval output already belongs to another transition"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const path = join(state, "rex-workers.json");
    const value: unknown = JSON.parse((await read(path)).toString());
    check(validRexWorkerRegistry(value) && value.hubId === plan.before.hubId && value.hosts.every(validRexRegistration));
    const registry: RexWorkerRegistry = value;
    check(new Set(registry.hosts.map(host => host.machineId)).size === registry.hosts.length && registry.hosts.every(host => host.hubId === registry.hubId && host.machineId !== identity.machine));
    const index = registry.hosts.findIndex(host => host.machineId === plan.machineId); const current = registry.hosts[index]; check(current);
    const already = current.upgradeId === plan.id;
    if (already) check(current.upgradeHash === hash(canonical(plan)), "Transition ID reused with different preparation evidence");
    check(matches(current, plan, already), "Hub registration no longer matches this exact transition");
    await checkHubIdle(state, plan.before.hubId!);
    if (!already) {
      // Returning to an earlier path is not an implicit revocation of existing
      // allocations. Its pin becomes current; all other prior clients remain.
      const previousClients = [current.rexClient, ...(current.previousClients ?? [])].filter((entry, i, all) => entry.executable !== plan.client.executable && all.findIndex(other => equal(other, entry)) === i);
      const next = { ...current, implementation: plan.implementation, rexClient: plan.client, previousClients, upgradeId: plan.id, upgradeHash: hash(canonical(plan)) };
      check(validRexRegistration(next), "Historical client limit/contract exceeded; no authority was discarded");
      registry.hosts[index] = next;
      await publish(path, registry, true);
    } else await syncDirectory(state);
    // Publication order is deliberate. A lost approval is regenerated only if
    // the registry contains this exact transition. No automatic rollback.
    await publish(output, { ...plan, kind: "approved" });
    return;
  }
  check(mode === "apply" && plan.kind === "approved");
  check(plan.machineId === identity.machine && plan.configHash === identity.digest && plan.receiptsHash === await receipts(state), "Worker identity/receipts changed since preparation");
  check(plan.implementation === implementation && plan.client.executable === client, "Run apply using the exact prepared replacement package");
  const current = await connection(state), next = replacement(plan);
  check(equal(current, plan.before) || equal(current, next), "Worker connection changed since preparation");
  if (!equal(current, next)) await publish(join(state, "rex-connection.json"), next, true);
  else await syncDirectory(state);
}
