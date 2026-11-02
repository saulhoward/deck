import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { DeckRuntime } from "./deck.js";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { FileCredentials } from "./credentials.js";
import { Login } from "./login.js";
import { providers } from "./providers.js";

async function fixture(fn: (store: FileCredentials, path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "deck-auth-"));
  const path = join(directory, "auth.json");
  try { await fn(new FileCredentials(path), path); } finally { await rm(directory, { recursive: true, force: true }); }
}
const token = (expires = Date.now() + 3600_000) => ({ type: "oauth" as const, access: "private-access", refresh: "private-refresh", expires });

test("private atomic credential writes serialize and callback failures preserve prior data", async () => {
  await fixture(async (store, path) => {
    assert.equal(await store.read("openai"), undefined);
    await store.modify("openai", async () => token());
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await Promise.all(Array.from({ length: 10 }, () => store.modify("openai", async (current) => ({ ...token(), count: Number((current as { count?: number }).count ?? 0) + 1 }))));
    const updated = await store.read("openai");
    assert.ok(updated?.type === "oauth"); assert.equal(updated.count, 10);
    const before = await readFile(path, "utf8");
    await assert.rejects(store.modify("openai", async () => { throw new Error("Simulated refresh failure"); }));
    assert.equal(await readFile(path, "utf8"), before);
    assert.deepEqual(await store.list(), [{ providerId: "openai", type: "oauth" }]);
    await store.delete("openai"); assert.equal(await store.read("openai"), undefined);
    await writeFile(path, "corrupt", { mode: 0o600 });
    await assert.rejects(store.read("openai"));
  });
});

test("Pi serializes OAuth refresh; failed OAuth never falls back to a configured API key", async () => {
  await fixture(async (store) => {
    const models = createModels({ credentials: store }); const faux = fauxProvider();
    let refreshes = 0; let apiKeyReads = 0; let fail = false;
    models.setProvider({ ...faux.provider, id: "openai", auth: {
      apiKey: { name: "paid key", resolve: async () => { apiKeyReads++; return { auth: { apiKey: "must-not-use" } }; } },
      oauth: { name: "test subscription", login: async () => token(), toAuth: async (credential) => ({ apiKey: credential.access }), refresh: async () => { refreshes++; if (fail) throw new Error("Expired grant"); return token(); } },
    } });
    await store.modify("openai", async () => token(0));
    await Promise.all([models.getAuth("openai"), models.getAuth("openai")]);
    assert.equal(refreshes, 1); assert.equal(apiKeyReads, 0);
    await store.modify("openai", async () => token(0)); fail = true;
    await assert.rejects(models.getAuth("openai"));
    assert.equal(apiKeyReads, 0); assert.equal((await store.read("openai"))?.type, "oauth");
  });
});

test("hub login supports prompt reply, duplicate start, cancellation and never exposes credentials", async () => {
  await fixture(async (store) => {
    const models = createModels({ credentials: store }); const faux = fauxProvider();
    models.setProvider({ ...faux.provider, id: "openai", auth: { oauth: {
      name: "test", toAuth: async () => ({}), refresh: async (credential) => credential,
      login: async (interaction) => {
        interaction.notify({ type: "info", message: "Test sign-in" });
        assert.equal(await interaction.prompt({ type: "manual_code", message: "Code", signal: interaction.signal }), "answer");
        return token();
      },
    } } });
    const login = new Login(models, "0123456789abcdef0123456789abcdef");
    try {
      login.start("request-one"); login.start("request-one");
      assert.throws(() => login.start("other"), { code: "conflict" });
      let state = login.snapshot();
      for (let i = 0; i < 100 && !("prompt" in state && state.prompt); i++) { await new Promise((resolve) => setTimeout(resolve, 1)); state = login.snapshot(); }
      assert.ok("prompt" in state && state.prompt);
      login.answer("request-one", state.prompt.id, "answer");
      for (let i = 0; i < 100 && login.snapshot().status === "pending"; i++) await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(login.snapshot().status, "done"); assert.equal((await store.read("openai"))?.type, "oauth");
      assert.doesNotMatch(JSON.stringify(login.snapshot()), /private-access|private-refresh/);
      login.start("request-two"); await login.cancel("request-two");
      assert.equal(login.snapshot().status, "cancelled");
    } finally { await login.close(); }
  });
});

test("real-provider runtime saves concrete models and refuses unconfigured admission without network calls", async () => {
  await fixture(async (_store, path) => {
    const database = join(dirname(path), "session.sqlite");
    const openRuntime = async (modelId: string) => {
      const provider = providers("--chatgpt", path, "machine", modelId);
      return DeckRuntime.open(database, { models: provider.models, model: provider.model, admissionGuard: provider.guard, validateSavedModels: true, binding: { machineId: "machine", cwd: dirname(path) }, environment: () => undefined });
    };
    let runtime = await openRuntime("gpt-4o-mini");
    try {
      await assert.rejects(runtime.admit(String(runtime.main.id), { requestId: "no-login", text: "Do not send", mode: "followUp" }), { code: "auth_required" });
      assert.equal((await runtime.history(String(runtime.main.id))).items.length, 0);
      await runtime.close();
      runtime = await openRuntime("gpt-6-sol");
      assert.deepEqual((await runtime.main.agent(context)).model, { provider: "openai", modelId: "gpt-4o-mini" });
      await runtime.close();
      const mock = providers("--mock", path, "machine");
      await assert.rejects(DeckRuntime.open(database, { models: mock.models, model: mock.model, validateSavedModels: true, binding: { machineId: "machine", cwd: dirname(path) }, environment: () => undefined }), { code: "invalid" });
    } finally { await runtime.close(); }
  });
});

test("default ChatGPT guard rejects API credentials; explicit key mode rejects stored OAuth", async () => {
  await fixture(async (store, path) => {
    const chatgpt = providers("--chatgpt", path, "machine");
    await assert.rejects(chatgpt.guard(), { code: "auth_required" });
    await store.modify("openai", async () => ({ type: "api_key", key: "paid" }));
    await assert.rejects(chatgpt.guard(), { code: "auth_required" });
    await assert.rejects(chatgpt.models.getAuth("openai"));
    await store.modify("openai", async () => token());
    await chatgpt.guard();
    const keyMode = providers("--api-key", path, "machine");
    await assert.rejects(keyMode.guard(), { code: "auth_required" });
    await assert.rejects(keyMode.models.getAuth("openai"));
    assert.throws(() => providers("--chatgpt", path, "machine", "not-a-model"), { code: "invalid" });
  });
});
