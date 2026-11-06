// An inert terminal child, not a Pi runtime. Only reports our scratch invocation.
import { appendFile, readFile, writeFile } from "node:fs/promises";
const [record, release, ...args] = process.argv.slice(2);
if (!record || !release) throw new Error("Missing scratch paths");
await appendFile(`${record}.starts`, "start\n");
await writeFile(record, JSON.stringify({ pid: process.pid, cwd: process.cwd(), args,
  // Never dump an environment: Rex/auth/provider variables can hold secrets.
  block: process.env.REX_BLOCK ?? null, session: process.env.REX_SESSION ?? null,
  hasProviderKey: process.env.OPENAI_API_KEY !== undefined,
}));
console.log("deck rex scratch child ready");
while (await readFile(release, "utf8").catch(() => "") !== "exit") await new Promise((resolve) => setTimeout(resolve, 25));
process.exitCode = 7;
