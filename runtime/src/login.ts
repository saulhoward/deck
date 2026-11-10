import { randomUUID } from "node:crypto";
import type { Models } from "@earendil-works/pi-ai";
import type { LoginEvent, LoginPrompt } from "./generated/contracts.js";
import { validLoginArgs, validLoginSnapshot } from "./status-login-contracts.js";
import { projectLoginEvent, projectLoginPrompt } from "./login-view.js";
import { DeckError } from "./deck.js";

// One transient provider interaction, not another durable conversation or inbox.
export class Login {
  private controller: AbortController | undefined;
  private job: Promise<void> | undefined;
  private state: { id: string; status: "pending" | "done" | "failed" | "cancelled"; events: LoginEvent[]; prompt?: LoginPrompt } | undefined;
  private reply: ((answer: string) => void) | undefined;
  constructor(private readonly models: Models, private readonly machineId: string) {}
  start(requestId: string) {
    if (!validLoginArgs("login_start", { requestId })) throw new DeckError("invalid", "Invalid login arguments");
    if (this.state?.id === requestId) return this.snapshot();
    if (this.state?.status === "pending") throw new DeckError("conflict", "Another login is in progress");
    const controller = this.controller = new AbortController();
    const state = this.state = { id: requestId, status: "pending", events: [] } as NonNullable<Login["state"]>;
    const timer = setTimeout(() => controller.abort(), 10 * 60_000);
    this.job = this.models.login("openai", "oauth", {
      signal: controller.signal,
      notify: (event) => { state.events.push(projectLoginEvent(event)); if (state.events.length > 16) state.events.shift(); },
      prompt: (prompt) => new Promise<string>((resolve, reject) => {
        const id = randomUUID();
        state.prompt = projectLoginPrompt(id, prompt);
        const signal = prompt.signal ?? controller.signal;
        const cleanup = () => { signal.removeEventListener("abort", abort); if (state.prompt?.id === id) delete state.prompt; this.reply = undefined; };
        const abort = () => { cleanup(); reject(new Error("Login prompt cancelled")); };
        this.reply = (answer) => { cleanup(); resolve(answer); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }),
    }, { getDeviceId: () => this.machineId.replace(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/i, "$1-$2-$3-$4-$5"), agentName: "Deck" }).then(() => { state.status = "done"; }, () => { state.status = controller.signal.aborted ? "cancelled" : "failed"; }).finally(() => { clearTimeout(timer); delete state.prompt; this.reply = undefined; });
    return this.snapshot();
  }
  snapshot() {
    const state = this.state;
    const view = state ? { id: state.id, status: state.status, events: state.events, ...(state.status === "pending" && state.prompt ? { prompt: state.prompt } : {}) } : { status: "idle" };
    if (!validLoginSnapshot(view)) throw new DeckError("invalid_response", "Invalid login snapshot");
    return structuredClone(view);
  }
  answer(loginId: string, promptId: string, answer: string) {
    if (!validLoginArgs("login_reply", { loginId, promptId, answer })) throw new DeckError("invalid", "Invalid login arguments");
    if (this.state?.id !== loginId || this.state.prompt?.id !== promptId || !this.reply) throw new DeckError("conflict", "Login prompt is no longer active");
    this.reply(answer); return { accepted: true };
  }
  async cancel(loginId: string) {
    if (!validLoginArgs("login_cancel", { loginId })) throw new DeckError("invalid", "Invalid login arguments");
    if (this.state?.id !== loginId) throw new DeckError("conflict", "Login interaction was replaced");
    await this.close(); return { cancelled: true };
  }
  async close() { this.controller?.abort(); await this.job; }
}
