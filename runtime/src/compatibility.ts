// Conservative startup compatibility, not code attestation or a settings snapshot.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineDoc, type Harness, type Storage } from "@earendil-works/pi-durable";

export const ImplementationDoc = defineDoc<{ digest: string }>({
  kind: "deck.implementation", version: 1, scope: "session",
  initial: () => ({ digest: "" }), checkpointWhen: () => true,
});
export class CompatibilityError extends Error {
  constructor(format = false) { super(format ? "Unsupported Deck implementation stamp; use the original build and a tested store migration. No work was resumed." : "Unfinished work requires the original Deck implementation; restart that build and resolve/drain work before upgrading. No work was resumed."); }
}
export function bindImplementation(code: string, nativeTools: boolean): string {
  if (!/^[a-f0-9]{64}$/.test(code)) throw new Error("Invalid implementation identity");
  return createHash("sha256").update(JSON.stringify({ version: 1, code, nativeTools })).digest("hex");
}

// Read only, BEFORE Harness.open can normalize running tasks/restart counters.
// Caller owns the writer lock and has exposed no admission handles. Public Pi
// storage reads are bounded; never write Pi tables or keep a second work list.
export async function checkCompatibility(storage: Storage, digest: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid implementation identity");
  const record = await storage.findDocument({ kind: ImplementationDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  if (record) {
    const saved = await storage.document(record.id, "current", context);
    if (!saved || saved.version !== 1 || typeof saved.value.digest !== "string" || !/^[a-f0-9]{64}$/.test(saved.value.digest)) throw new CompatibilityError(true);
    if (saved.value.digest === digest) return;
  }
  for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) {
    if ((await storage.scanTasks({ status }, 1, undefined, context)).items.length) throw new CompatibilityError();
  }
  for (const status of ["queued", "placed"] as const) {
    if ((await storage.scanSubmissions({ status }, 1, undefined, context)).items.length) throw new CompatibilityError();
  }
}
export async function stampImplementation(harness: Harness, digest: string): Promise<void> {
  await harness.commit(async (tx) => { (await tx.doc(ImplementationDoc)).digest = digest; }, context);
}

type PackageInfo = { name?: string; version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };
const applicationRoot = fileURLToPath(new URL("../../", import.meta.url));
let defaultCode: Promise<string> | undefined;
export function defaultImplementation(): Promise<string> { return defaultCode ??= fingerprintImplementation(); }

// Paths are not hashed: a byte-identical package can be relocated. Hash actual
// declared production/peer/optional dependency contents, including lazy assets,
// rather than treating a version string or lockfile as proof of installed bytes.
export async function fingerprintImplementation({ root = applicationRoot, node = process.execPath, native, entry, mode = "embedded" }: { root?: string; node?: string; native?: string; entry?: string; mode?: string } = {}): Promise<string> {
  let files = 0; let bytes = 0;
  const hashFile = async (path: string) => {
    const info = await stat(path);
    if (!info.isFile() || ++files > 20_000 || (bytes += info.size) > 512 * 1024 * 1024) throw new Error("Implementation exceeds fingerprint limits");
    const hash = createHash("sha256");
    if (info.size <= 1024 * 1024) hash.update(await readFile(path));
    else for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  };
  const hashTree = async (path: string, runtime = false) => {
    const hash = createHash("sha256");
    const walk = async (directory: string, relative: string): Promise<void> => {
      const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name !== "node_modules" && !(runtime && entry.name.includes(".test."))).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      // Bounded file concurrency, deterministic hashing order. Finish each batch
      // before walking directories, so nesting cannot multiply open handles.
      for (let index = 0; index < entries.length; index += 16) {
        const batch = entries.slice(index, index + 16);
        const digests = await Promise.all(batch.map((entry) => entry.isFile() ? hashFile(join(directory, entry.name)) : undefined));
        for (const [offset, entry] of batch.entries()) {
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory()) { hash.update(JSON.stringify(["directory", name])); await walk(join(directory, entry.name), name); }
          else if (entry.isFile()) hash.update(JSON.stringify(["file", name, digests[offset]]));
          else throw new Error("Unsupported implementation file type"); // No arbitrary asset-directory symlink traversal.
        }
      }
    };
    await walk(path, ""); return hash.digest("hex");
  };
  const manifest = async (path: string) => JSON.parse(await readFile(join(path, "package.json"), "utf8")) as PackageInfo;
  const locate = async (from: string, name: string) => {
    if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error("Invalid dependency name");
    for (let directory = from;; directory = dirname(directory)) {
      const candidate = join(directory, "node_modules", name);
      try { await stat(join(candidate, "package.json")); return await realpath(candidate); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (dirname(directory) === directory) return undefined;
    }
  };
  const seen = new Map<string, number>();
  const packages: { name: string; version: string; content: string; dependencies: [string, number | null][] }[] = [];
  const dependencies = async (path: string, info: PackageInfo): Promise<[string, number | null][]> => {
    const names = Object.keys({ ...info.dependencies, ...info.peerDependencies, ...info.optionalDependencies }).sort();
    const result: [string, number | null][] = [];
    for (const name of names) {
      const found = await locate(path, name);
      const optional = Object.hasOwn(info.optionalDependencies ?? {}, name) || (!Object.hasOwn(info.dependencies ?? {}, name) && info.peerDependenciesMeta?.[name]?.optional);
      if (!found && !optional) throw new Error("Missing implementation dependency");
      result.push([name, found ? await visit(found) : null]);
    }
    return result;
  };
  const visit = async (path: string): Promise<number> => {
    const previous = seen.get(path); if (previous !== undefined) return previous;
    if (seen.size >= 1000) throw new Error("Implementation exceeds package limit");
    const id = packages.length; seen.set(path, id);
    const info = await manifest(path);
    const record = { name: info.name ?? "", version: info.version ?? "", content: await hashTree(path), dependencies: [] as [string, number | null][] };
    packages.push(record); record.dependencies = await dependencies(path, info); return id;
  };
  root = await realpath(root);
  const roots = await dependencies(root, await manifest(root));
  return createHash("sha256").update(JSON.stringify({
    version: 1, mode, platform: process.platform, arch: process.arch, nodeVersion: process.version,
    node: await hashFile(node), native: native ? await hashFile(native) : null, entry: entry ? await hashFile(entry) : null,
    runtime: await hashTree(join(root, "runtime", "dist"), true), roots, packages,
  })).digest("hex");
}
