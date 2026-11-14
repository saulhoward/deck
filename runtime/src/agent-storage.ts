// Client-only startup drafts. Immutable stages, never a queue or transcript.
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { privateJson, privateOwner } from "./launcher-client.js";
import { validRexBootstrapRecord, validRexBootstrapIndex, validRexUuid, type RexBootstrapRecord, type RexBootstrapIndex } from "./generated/contracts.js";
import { validResolvedTarget } from "./rex-open-contracts.js";
export function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
export async function privateDirectory(path: string, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path); privateOwner(info);
  if (!info.isDirectory()) throw new Error("Invalid private startup directory");
}
export function bootstrapPath(root: string, id: string): string {
  if (!validRexUuid(id) || !isAbsolute(root) || root.includes("\0") || Buffer.byteLength(root) > 4096) throw new Error("Invalid bootstrap identity/root");
  return join(root, "startups", id);
}
export async function bootstrapRecord(clientRoot: string, id: string, currentProcess = true): Promise<RexBootstrapRecord> {
  const root = bootstrapPath(clientRoot, id);
  await privateDirectory(clientRoot); await privateDirectory(join(clientRoot, "startups")); await privateDirectory(root);
  const record = await privateJson(join(root, "record.json"), 16 * 1024);
  if (!validRexBootstrapRecord(record) || record.id !== id || record.draftRoot !== clientRoot || !validResolvedTarget(record.target) || !record.cwd.startsWith("/") || record.cwd.includes("\0") || !record.client.startsWith("/") || !record.draftRoot.startsWith("/")) throw new Error("Invalid native bootstrap record");
  if (currentProcess && (!record.binding || record.binding.pid !== process.ppid || record.binding.blockId !== process.env.REX_BLOCK)) throw new Error("Bootstrap is not this managed terminal");
  return record;
}
export async function startupIndexes(root: string, hubId: string, machineId: string): Promise<RexBootstrapIndex[]> {
  const directory = join(root, "startups");
  try { await privateDirectory(directory); } catch (error) { if (missing(error)) return []; throw error; }
  const names = (await readdir(directory)).filter(name => name.endsWith(".json") && validRexUuid(name.slice(0, -5)));
  if (names.length > 1000) throw new Error("Too many startup drafts; inspect private client storage");
  const result: RexBootstrapIndex[] = [];
  for (const name of names) {
    const value = await privateJson(join(directory, name), 4096).catch(error => { if (missing(error)) return undefined; throw error; });
    if (value === undefined) continue;
    if (!validRexBootstrapIndex(value) || value.id !== name.slice(0, -5)) throw new Error("Invalid startup index");
    if (value.hubId === hubId && value.machineId === machineId) result.push(value);
  }
  return result;
}
export async function finishStartup(record: Pick<RexBootstrapRecord, "id" | "hubId" | "machineId" | "draftRoot">): Promise<void> {
  const directory = join(record.draftRoot, "startups"), path = join(directory, `${record.id}.json`);
  try { await privateDirectory(directory); } catch (error) { if (missing(error)) return; throw error; }
  const index = await privateJson(path, 4096).catch(error => { if (missing(error)) return undefined; throw error; });
  if (index === undefined) return;
  if (!validRexBootstrapIndex(index) || index.id !== record.id || index.hubId !== record.hubId || index.machineId !== record.machineId) throw new Error("Startup index changed; retained");
  await rm(path);
  const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
export class StartupFiles {
  constructor(readonly directory: string) {}
  async read(name: string): Promise<unknown | undefined> {
    await privateDirectory(this.directory);
    try { return await privateJson(join(this.directory, name), 64 * 1024); } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  async publish(name: string, value: unknown): Promise<void> {
    await privateDirectory(this.directory);
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > 64 * 1024) throw new Error("Startup draft exceeds bounds");
    const tmp = join(this.directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      try { await link(tmp, join(this.directory, name)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (JSON.stringify(await this.read(name)) !== bytes) throw new Error("Startup draft identity conflict; original retained");
      }
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(tmp, { force: true }); }
  }
  async claim(name: string): Promise<boolean> {
    // This is an attempt fence, not an execution/completion receipt. A crash
    // after publication leaves the ordinary input draft for explicit recovery.
    const file = await open(join(this.directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw error;
    });
    if (!file) return false;
    try { await file.writeFile("{\"attempted\":true}"); await file.sync(); } finally { await file.close(); }
    const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
    return true;
  }
}
