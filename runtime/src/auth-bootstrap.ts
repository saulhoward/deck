// Pre-lock client-only bootstrap. No Harness, credential store, or secret output.
import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";

// Deliberately smaller than general dotenv: configuration cannot set PATH,
// NODE_OPTIONS, authentication-mode overrides, shell expansions or plaintext keys.
export function secretReferences(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith("#")) continue;
    const match = /^OPENAI_API_KEY\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+))$/.exec(line);
    const value = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!value || result.OPENAI_API_KEY || value.length > 4096 || !/^op:\/\/[^/]+\/[^/]+\/(?:[^/]+\/)?[^/]+$/.test(value) || /[\x00-\x1f\x7f$`\\]/.test(value)) throw new Error("Invalid 1Password reference configuration");
    result.OPENAI_API_KEY = value;
  }
  return result;
}
export async function readSecretReferences(path: string): Promise<Record<string, string> | undefined> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("1Password reference file unavailable"); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) || info.size > 16384) throw new Error("1Password reference file must be a private owned regular file (at most 16 KiB)");
    const bytes = Buffer.alloc(16385); let used = 0;
    while (used < bytes.length) { const { bytesRead } = await file.read(bytes, used, bytes.length - used, null); if (!bytesRead) break; used += bytesRead; }
    if (used > 16384) throw new Error("1Password reference file too large");
    return secretReferences(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)));
  } finally { await file.close(); }
}
export function hubEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !/^OP_(?:SESSION|SERVICE_ACCOUNT_TOKEN$|CONNECT_TOKEN$)/.test(entry[0])));
}
async function opExecutable(): Promise<string> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = resolve(directory, "op");
    try { await access(path, constants.X_OK); return path; } catch { /* Next explicit PATH entry. */ }
  }
  throw new Error("1Password CLI unavailable; install op and authenticate before starting Deck");
}
export async function bootstrap(args: string[]): Promise<never> {
  const [stage, executable, ...serveArgs] = args;
  if (!executable || !isAbsolute(executable) || serveArgs[0] !== "serve" || !["resolve", "handoff"].includes(stage ?? "") || serveArgs.includes("--credentials-resolved")) throw new Error("Invalid credential bootstrap");
  if (stage === "resolve") {
    const refs = await readSecretReferences(join(homedir(), ".config", "deck", ".env"));
    if (refs?.OPENAI_API_KEY) {
      // Pass the validated snapshot as reference-valued environment variables.
      // op run supports these natively. It must not reread a mutable dotenv file
      // with arbitrary variable names. No secret value is placed in argv.
      const op = await opExecutable();
      process.execve!(op, [op, "run", "--no-masking", "--", process.execPath, process.argv[1]!, "handoff", executable, ...serveArgs], { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), ...refs });
      throw new Error("1Password launch failed; no fallback attempted");
    }
  }
  if (stage === "handoff" && (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY.startsWith("op://"))) throw new Error("1Password did not resolve the required key; no fallback attempted");
  // This internal flag only prevents recursion; it grants no authority. Runtime
  // authentication is still checked before any store can resume.
  process.execve!(executable, [executable, ...serveArgs, "--credentials-resolved"], hubEnvironment(process.env));
  throw new Error("Hub launch failed");
}
