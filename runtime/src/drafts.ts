// Local unacknowledged request cache, never an execution queue or transcript store.
import { briefFields } from "./task-brief.js";
import type { TaskBrief } from "./generated/contracts.js";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, opendir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Draft = { kind: "input"; chatId: string; requestId: string; text: string; mode: "steer" } |
  ({ kind: "task"; chatId: string; requestId: string; title: string; machineId: string; cwd: string } & TaskBrief) |
  { kind: "instructions"; chatId: string; requestId: string; machineId: string; cwd: string };
type Saved = { version: 1; hubId: string; createdAt: number; request: Draft };
export type DraftSummary = { kind: Draft["kind"]; chatId: string; requestId: string; createdAt: number };
const maxBytes = 1024 * 1024;
const requestId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved draft");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200_000) throw new Error("Invalid saved draft");
  return value;
}
function validate(value: unknown): Draft {
  const data = object(value);
  const chatId = text(data.chatId); const id = text(data.requestId);
  if (!/^[1-9]\d*$/.test(chatId) || !Number.isSafeInteger(Number(chatId)) || !requestId.test(id)) throw new Error("Invalid saved draft identity");
  if (data.kind === "input" && data.mode === "steer") return { kind: "input", chatId, requestId: id, text: text(data.text), mode: "steer" };
  if (data.kind === "task" || data.kind === "instructions") {
    const cwd = text(data.cwd); if (!isAbsolute(cwd)) throw new Error("Invalid saved draft cwd");
    if (data.kind === "instructions") return { kind: "instructions", chatId, requestId: id, machineId: text(data.machineId), cwd };
    return { kind: "task", chatId, requestId: id, title: text(data.title), machineId: text(data.machineId), cwd, ...briefFields(data as TaskBrief) };
  }
  throw new Error("Unsupported saved draft");
}
function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
function privateFile(info: { mode: number; uid: number }) {
  if (info.mode & 0o077 || (process.getuid && info.uid !== process.getuid())) throw new Error("Client draft storage must be private and owned by this user");
}

export class DraftStore {
  readonly directory: string;
  private readonly root: string;
  constructor(readonly hubId: string, root?: string) {
    if (!hubId || hubId.length > 200) throw new Error("Hub lacks draft identity; restart the updated hub");
    root ??= process.env.DECK_CLIENT_STATE_DIRECTORY ?? (process.platform === "darwin" ? join(homedir(), "Library/Application Support/deck/client") : join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "deck/client"));
    if (!isAbsolute(root)) throw new Error("Client state directory must be absolute");
    this.root = root;
    this.directory = join(root, "drafts", createHash("sha256").update(hubId).digest("hex"));
  }
  private path(id: string) {
    if (!requestId.test(id)) throw new Error("Invalid draft request ID");
    return join(this.directory, `${id}.json`);
  }
  private async prepare(create: boolean) {
    for (const path of [this.root, join(this.root, "drafts"), this.directory]) {
      if (create) await mkdir(path, { recursive: true, mode: 0o700 });
      try {
        const info = await lstat(path); privateFile(info);
        if (!info.isDirectory()) throw new Error("Draft storage must be a directory, not a symlink");
      } catch (error) { if (!create && missing(error)) return false; throw error; }
    }
    return true;
  }
  async load(id: string): Promise<Saved> {
    await this.prepare(false);
    const file = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat(); privateFile(info);
      if (!info.isFile() || info.size > maxBytes) throw new Error("Invalid saved draft file");
      const bytes = Buffer.alloc(info.size + 1); let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > info.size) throw new Error("Saved draft changed while reading");
      let data: Record<string, unknown>;
      try { data = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)))); } catch { throw new Error("Invalid saved draft JSON; inspect local draft storage"); }
      if (data.version !== 1 || data.hubId !== this.hubId || !Number.isSafeInteger(data.createdAt) || Number(data.createdAt) < 0) throw new Error("Incompatible saved draft");
      const request = validate(data.request);
      if (request.requestId !== id) throw new Error("Saved draft filename/identity mismatch");
      return { version: 1, hubId: this.hubId, createdAt: Number(data.createdAt), request };
    } finally { await file.close(); }
  }
  async save(request: Draft) {
    request = validate(request); await this.prepare(true);
    const data = JSON.stringify({ version: 1, hubId: this.hubId, createdAt: Date.now(), request });
    if (Buffer.byteLength(data) > maxBytes) throw new Error("Draft exceeds local size limit; request was not sent");
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
      // Exclusive atomic publication: another client can never overwrite this identity.
      try { await link(temporary, this.path(request.requestId)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (JSON.stringify((await this.load(request.requestId)).request) !== JSON.stringify(request)) throw new Error("Draft request ID conflicts with an existing request");
      }
    } finally { await rm(temporary, { force: true }); }
  }
  async remove(id: string) {
    if (!await this.prepare(false)) return;
    await rm(this.path(id), { force: true });
  }
  async list(): Promise<DraftSummary[]> {
    if (!await this.prepare(false)) return [];
    const summaries: DraftSummary[] = [];
    for await (const file of await opendir(this.directory)) {
      if (!file.name.endsWith(".json")) continue;
      if (summaries.length >= 1000) throw new Error("Too many saved drafts; inspect client draft storage");
      const id = file.name.slice(0, -5);
      try {
        const saved = await this.load(id);
        summaries.push({ kind: saved.request.kind, chatId: String(Number(saved.request.chatId)), requestId: id, createdAt: saved.createdAt });
      } catch (error) { if (!missing(error)) throw error; } // Another client may have acknowledged it.
    }
    return summaries.sort((a, b) => a.createdAt - b.createdAt || a.requestId.localeCompare(b.requestId));
  }
}
