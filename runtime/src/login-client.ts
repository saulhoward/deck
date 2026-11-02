import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

export async function loginClient(command: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const requestId = randomUUID();
  await command("login_start", { requestId });
  const editor = createInterface({ input: process.stdin, output: process.stdout });
  const displayed = new Set<string>();
  let pending: { id: string; abort: AbortController } | undefined;
  let cancelled = false; let completed = false;
  const cancel = () => { cancelled = true; pending?.abort.abort(); };
  process.once("SIGINT", cancel);
  editor.once("SIGINT", cancel);
  editor.once("close", cancel);
  try {
    while (!cancelled) {
      const state = await command("login_status");
      if (state.id !== requestId) throw new Error("Login interaction was replaced");
      if (Array.isArray(state.events)) for (const event of state.events) {
        const key = JSON.stringify(event);
        if (!displayed.has(key)) {
          // JSON escaping avoids interpreting provider-supplied control sequences.
          process.stdout.write(`${key}\n`); displayed.add(key);
        }
      }
      if (state.status === "done") { completed = true; process.stdout.write("ChatGPT sign-in saved on the hub.\n"); return; }
      if (state.status !== "pending") throw new Error("Sign-in failed or cancelled; no API-key fallback was attempted");
      const prompt = state.prompt as { id: string; message: string; type: string; options?: unknown[] } | undefined;
      if (pending && pending.id !== prompt?.id) { pending.abort.abort(); pending = undefined; }
      if (prompt && !pending) {
        if (prompt.type === "secret") throw new Error("Secret-entry prompts are unsupported by this client");
        const abort = new AbortController(); pending = { id: prompt.id, abort };
        process.stdout.write(`${JSON.stringify(prompt.message)}${prompt.options ? ` ${JSON.stringify(prompt.options)}` : ""}\n`);
        void editor.question("> ", { signal: abort.signal }).then(async (answer) => {
          if (!abort.signal.aborted) await command("login_reply", { loginId: requestId, promptId: prompt.id, answer });
        }).catch(() => { /* Callback may have won the prompt race; poll authoritative state. */ }).finally(() => {
          if (pending?.id === prompt.id) pending = undefined;
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error("Sign-in cancelled");
  } finally {
    pending?.abort.abort(); editor.close(); process.off("SIGINT", cancel);
    if (!completed) await command("login_cancel", { loginId: requestId }).catch(() => {});
  }
}
