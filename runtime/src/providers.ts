import { createModels } from "@earendil-works/pi-ai/models";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { FileCredentials } from "./credentials.js";
import { DeckError } from "./deck.js";
import { Login } from "./login.js";

export type ProviderMode = "--mock" | "--chatgpt" | "--api-key";
export function providers(mode: ProviderMode, credentialPath: string, machineId: string, modelId?: string) {
  const credentials = new FileCredentials(credentialPath);
  const check = (credential: Credential | undefined) => {
    if (credential && mode !== "--mock" && credential.type !== (mode === "--chatgpt" ? "oauth" : "api_key")) throw new Error("Stored credential conflicts with selected auth mode");
    return credential;
  };
  // Enforce mode on request/recovery auth too, not just new admissions. Otherwise a
  // pending Pi run could bypass the admission guard after a restart.
  const scoped: CredentialStore = {
    read: async (id, options) => check(await credentials.read(id, options)),
    list: (options) => credentials.list(options),
    modify: (id, fn, options) => credentials.modify(id, async (current) => check(await fn(check(current))), options),
    delete: (id, options) => credentials.delete(id, options),
  };
  const models = createModels({ credentials: scoped, authContext: {
    env: async (name) => mode === "--api-key" ? process.env[name] : undefined,
    fileExists: async () => false,
  } });
  if (mode === "--mock") {
    if (modelId) throw new DeckError("invalid", "--model cannot be combined with --mock");
    const faux = fauxProvider(); models.setProvider(faux.provider);
    const respond: FauxResponseFactory = () => { faux.appendResponses([respond]); return fauxAssistantMessage("Deck prototype response (mock provider; no inference performed)."); };
    faux.setResponses([respond]);
    return { models, model: { provider: faux.getModel().provider, modelId: faux.getModel().id }, login: undefined, guard: async () => {} };
  }
  models.setProvider(openaiProvider());
  const id = modelId || "gpt-6-sol";
  if (!models.getModel("openai", id)) throw new DeckError("invalid", "Unknown OpenAI model in pinned Pi catalog");
  return {
    models, model: { provider: "openai", modelId: id },
    login: mode === "--chatgpt" ? new Login(models, machineId) : undefined,
    guard: async () => {
      const credential = await credentials.read("openai");
      if (mode === "--chatgpt" && credential?.type !== "oauth") throw new DeckError("auth_required", "Sign in with deck login; API-key fallback is disabled");
      if (mode === "--api-key" && (credential?.type === "oauth" || (!credential?.key && !process.env.OPENAI_API_KEY))) throw new DeckError("auth_required", "Explicit API-key mode requires an API key and no stored OAuth credential");
    },
  };
}
