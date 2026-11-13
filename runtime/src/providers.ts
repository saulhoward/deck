import { createModels } from "@earendil-works/pi-ai/models";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { fauxProvider, fauxAssistantMessage, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { FileCredentials } from "./credentials.js";
import { DeckError } from "./deck.js";
import { Login } from "./login.js";

export type ProviderMode = "--mock" | "--chatgpt" | "--api-key";
export const authenticationRequired = "OpenAI authentication required. Run: deck login openai";
export function environmentKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.OPENAI_API_KEY;
  if (key === undefined || key === "") return undefined;
  if (key.length > 16384 || /[\x00-\x20\x7f]/.test(key) || key.startsWith("op://")) throw new DeckError("auth_required", "Invalid or unresolved OPENAI_API_KEY; no OAuth fallback attempted");
  return key;
}
export function oauthLogin(credentials: CredentialStore, machineId: string) {
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(openaiProvider());
  return new Login(models, machineId);
}

// Selection happens once under the native writer lock, before Harness.open.
// API-key resolution does not access the network; OAuth can refresh here. Failure
// never changes billing/authentication modes or resumes unauthenticated work.
export async function startupProviders(mode: ProviderMode | "--auto", path: string, machineId: string, modelId?: string) {
  const selected = mode === "--auto" ? (environmentKey() ? "--api-key" : "--chatgpt") : mode;
  const provider = providers(selected, path, machineId, modelId);
  if (selected !== "--mock") {
    await provider.guard();
    try { if (!(await provider.models.getAuth("openai", { signal: AbortSignal.timeout(30_000) }))?.auth.apiKey) throw new Error("No OpenAI authentication resolved"); }
    catch { throw new DeckError("auth_required", authenticationRequired + "; credential refresh failed; no authentication fallback attempted"); }
  }
  return { ...provider, mode: selected };
}

export function providers(mode: ProviderMode, credentialPath: string, machineId: string, modelId?: string) {
  const credentials = new FileCredentials(credentialPath);
  const key = mode === "--api-key" ? environmentKey() : undefined;
  const check = (credential: Credential | undefined) => {
    if (credential && credential.type !== "oauth") throw new DeckError("auth_required", authenticationRequired + "; stored API keys are not used");
    return credential;
  };
  // Never let a stored OAuth record override the selected environment API key,
  // or let refresh failures fall through to a later ambient key. Login uses a
  // separate models instance but the SAME serialized credential store.
  const scoped: CredentialStore = mode === "--chatgpt" ? {
    read: async (id, options) => check(await credentials.read(id, options)),
    list: (options) => credentials.list(options),
    modify: (id, fn, options) => credentials.modify(id, async current => check(await fn(check(current))), options),
    delete: (id, options) => credentials.delete(id, options),
  } : {
    read: async () => undefined, list: async () => [],
    modify: async () => { throw new Error("Runtime API-key credentials are read-only"); },
    delete: async () => { throw new Error("Runtime API-key credentials are read-only"); },
  };
  const models = createModels({ credentials: scoped, authContext: {
    env: async name => mode === "--api-key" && name === "OPENAI_API_KEY" ? key : undefined,
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
    login: oauthLogin(credentials, machineId),
    guard: async () => {
      if (mode === "--api-key") {
        if (!key) throw new DeckError("auth_required", authenticationRequired);
      } else if (check(await credentials.read("openai"))?.type !== "oauth") throw new DeckError("auth_required", authenticationRequired);
    },
  };
}
