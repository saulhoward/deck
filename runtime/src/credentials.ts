import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import type { Credential, CredentialStore, AuthOperationOptions } from "@earendil-works/pi-ai";

// The hub's inherited writer lock supplies cross-process exclusion. Every access is
// serialized here, including refresh callbacks. Never use outside that lock's lifetime.
export class FileCredentials implements CredentialStore {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string) {}
  private serial<T>(options: AuthOperationOptions | undefined, fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => { options?.signal?.throwIfAborted(); return fn(); });
    this.tail = result.catch(() => {}); return result;
  }
  private async load(): Promise<Record<string, Credential>> {
    let raw: string;
    try {
      const info = await stat(this.path);
      if (info.mode & 0o077) throw new Error("Credential file must be private");
      if (info.size > 1024 * 1024) throw new Error("Credential file exceeds size limit");
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Object.create(null) as Record<string, Credential>;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid credential store");
    for (const entry of Object.values(value)) {
      if (!entry || typeof entry !== "object" || !("type" in entry) || (entry.type !== "api_key" && entry.type !== "oauth")) throw new Error("Invalid credential record");
      if (entry.type === "oauth" && (!("access" in entry) || typeof entry.access !== "string" || !("refresh" in entry) || typeof entry.refresh !== "string" || !("expires" in entry) || typeof entry.expires !== "number")) throw new Error("Invalid OAuth credential");
    }
    return Object.assign(Object.create(null), value) as Record<string, Credential>;
  }
  private async save(value: Record<string, Credential>) {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, this.path);
    } finally { await rm(temporary, { force: true }); }
  }
  read(providerId: string, options?: AuthOperationOptions) {
    return this.serial(options, async () => (await this.load())[providerId]);
  }
  list(options?: AuthOperationOptions) {
    return this.serial(options, async () => Object.entries(await this.load()).map(([providerId, value]) => ({ providerId, type: value.type })));
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    return this.serial(options, async () => {
      const data = await this.load(); const updated = await fn(data[providerId]);
      options?.signal?.throwIfAborted();
      if (updated !== undefined) { Object.defineProperty(data, providerId, { value: updated, enumerable: true, configurable: true, writable: true }); await this.save(data); }
      return updated ?? data[providerId];
    });
  }
  delete(providerId: string, options?: AuthOperationOptions) {
    return this.serial(options, async () => { const data = await this.load(); delete data[providerId]; await this.save(data); });
  }
}
