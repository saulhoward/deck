import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { validLoginSnapshot, validStatusLoginReply } from "./status-login-contracts.js";
import { HubError } from "./responses.js";
import { failurePolicy } from "./command-policy.js";

export function loginJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export async function loginClient(command: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const requestId = randomUUID();
  const started = await command("login_start", { requestId });
  if (!validStatusLoginReply({ command: "login_start", args: { requestId } }, started)) throw new Error("Invalid login start response; outcome unconfirmed");
  const editor = createInterface({ input: process.stdin, output: process.stdout });
  const displayed = new Set<string>();
  let pending: { id: string; abort: AbortController } | undefined;
  let cancelled = false; let completed = false; let failure: Error | undefined;
  const cancel = () => { cancelled = true; pending?.abort.abort(); };
  process.once("SIGINT", cancel);
  editor.once("SIGINT", cancel);
  editor.once("close", cancel);
  try {
    while (!cancelled) {
      if (failure) throw failure;
      const state = await command("login_status");
      if (!validLoginSnapshot(state)) throw new Error("Invalid login status response; observation unchanged");
      if (!("id" in state) || state.id !== requestId) throw new Error("Login interaction was replaced");
      if (failure) throw failure;
      const current = new Set<string>();
      for (const event of state.events) {
        const key = loginJson(event); current.add(key);
        if (!displayed.has(key)) {
          // JSON escaping avoids interpreting provider-supplied control sequences.
          process.stdout.write(`${key}\n`); displayed.add(key);
        }
      }
      displayed.clear(); for (const key of current) displayed.add(key); // At most the latest 16 event keys, not a transcript.
      if (state.status === "done") { completed = true; process.stdout.write("ChatGPT sign-in saved on the hub.\n"); return; }
      if (state.status !== "pending") throw new Error("Sign-in failed or cancelled; no API-key fallback was attempted");
      const prompt = state.prompt;
      if (pending && pending.id !== prompt?.id) { pending.abort.abort(); pending = undefined; }
      if (prompt && !pending) {
        if (prompt.type === "secret") throw new Error("Secret-entry prompts are unsupported by this client");
        const abort = new AbortController(); pending = { id: prompt.id, abort };
        process.stdout.write(`${loginJson(prompt.message)}${prompt.type === "select" ? ` ${loginJson(prompt.options)}` : ""}\n`);
        void editor.question("> ", { signal: abort.signal }).then(async (answer) => {
          if (!abort.signal.aborted) {
            const args = { loginId: requestId, promptId: prompt.id, answer };
            const reply = await command("login_reply", args);
            if (!validStatusLoginReply({ command: "login_reply", args }, reply)) throw new Error("Invalid login reply acknowledgement");
          }
        }).catch((error) => {
          // A callback may win the prompt race. Other failures leave the answer
          // unconfirmed: never replay it or report that credentials were saved.
          if (!abort.signal.aborted && !(error instanceof HubError && failurePolicy("login_reply", error.code, "remote").action === "poll_login")) failure = new Error("Login reply outcome unconfirmed; no automatic retry");
        }).finally(() => {
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
