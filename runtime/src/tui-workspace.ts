// Display-only local observation. No git process, hooks, credentials or changes.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
async function smallFile(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096) throw new Error("Not a bounded git metadata file");
    const bytes = Buffer.alloc(4097); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error("Git metadata grew");
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead)).trim();
  } finally { await file.close(); }
}
export async function localGitBranch(cwd: string): Promise<string | undefined> {
  try {
    let directory = cwd, git = "", stat;
    for (let depth = 0; depth < 32; depth++) {
      git = join(directory, ".git");
      try { stat = await lstat(git); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parent = dirname(directory); if (parent === directory) return undefined; directory = parent;
    }
    if (!stat || stat.isSymbolicLink()) return undefined;
    if (!stat.isDirectory()) {
      const pointer = await smallFile(git);
      if (!pointer.startsWith("gitdir: ") || /[\r\n\0]/.test(pointer)) return undefined;
      git = resolve(directory, pointer.slice(8));
    }
    const head = await smallFile(join(git, "HEAD"));
    const branch = head.startsWith("ref: refs/heads/") ? head.slice(16) : /^[a-f\d]{40,64}$/.test(head) ? `detached ${head.slice(0, 8)}` : undefined;
    return branch && branch.length <= 160 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(branch) ? branch : undefined;
  } catch { return undefined; }
}
