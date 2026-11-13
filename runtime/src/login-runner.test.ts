import assert from "node:assert/strict";
import { mkdtemp, open, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { FileCredentials } from "./credentials.js";
import { Login } from "./login.js";
import { runLogin } from "./login-runner.js";
const machine = "a".repeat(32);

test("offline OAuth login saves only credentials without a hub, Pi store, API-key fallback or op lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-offline-login-")); const lock = await open(join(root, "writer.lock"), "w", 0o600);
  try {
    await new FileCredentials(join(root, "auth.json")).modify("openai", async () => ({ type: "api_key", key: "legacy-fake-key" }));
    let environmentReads = 0;
    await runLogin(["offline", root, machine, String(lock.fd), "52800"], {
      command: async () => { throw new Error("Must not contact a hub"); },
      makeLogin: (credentials, id) => {
        const models = createModels({ credentials, authContext: { env: async () => { environmentReads++; return "must-not-use"; }, fileExists: async () => false } });
        const faux = fauxProvider();
        models.setProvider({ ...faux.provider, id: "openai", auth: { oauth: {
          name: "test", toAuth: async () => ({}), refresh: async credential => credential,
          login: async interaction => {
            assert.equal(await interaction.prompt({ type: "manual_code", message: "Enter test code", signal: interaction.signal }), "fake-code");
            return { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3600000 };
          },
        } } });
        return new Login(models, id);
      },
      client: async command => {
        await command("login_start", { requestId: "offline-test" });
        let snapshot: any;
        for (let i = 0; i < 100; i++) { snapshot = await command("login_status"); if (snapshot.prompt) break; await new Promise(r => setTimeout(r, 1)); }
        assert.ok(snapshot.prompt); assert.doesNotMatch(JSON.stringify(snapshot), /fake-access|fake-refresh/);
        await command("login_reply", { loginId: "offline-test", promptId: snapshot.prompt.id, answer: "fake-code" });
        for (let i = 0; i < 100; i++) { snapshot = await command("login_status"); if (snapshot.status === "done") break; await new Promise(r => setTimeout(r, 1)); }
        assert.equal(snapshot.status, "done");
        await assert.rejects(command("admit"), /Invalid offline/);
      },
    });
    assert.equal(environmentReads, 0); assert.equal(process.env.PI_OAUTH_CALLBACK_HOST, "127.0.0.1");
    assert.equal((await new FileCredentials(join(root, "auth.json")).read("openai"))?.type, "oauth");
    assert.deepEqual((await readdir(root)).sort(), ["auth.json", "writer.lock"]);
  } finally { await lock.close(); await rm(root, { recursive: true, force: true }); }
});

test("online login pins the native state machine and observed hub; loss or wrong identity never falls back offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-online-login-"));
  try {
    const calls: { command: string; hubId?: string }[] = [];
    const status = { hubId: "hub", mainChatId: "1", chatId: "1", machineId: machine, hubGuard: 1, tools: "offline" };
    const dependencies = {
      command: async (_port: number, command: string, _args?: Record<string, unknown>, hubId?: string) => {
        calls.push({ command, ...(hubId ? { hubId } : {}) }); return command === "status" ? status : { accepted: true };
      },
      makeLogin: () => { throw new Error("No offline writer permitted"); },
      client: async (command: (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>) => { await command("login_start", { requestId: "online-test" }); },
    };
    await runLogin(["online", root, machine, "-1", "52800"], dependencies);
    assert.deepEqual(calls, [{ command: "status" }, { command: "login_start", hubId: "hub" }]);
    status.machineId = "b".repeat(32); calls.length = 0;
    await assert.rejects(runLogin(["online", root, machine, "-1", "52800"], dependencies), /Wrong or incompatible/);
    assert.deepEqual(calls, [{ command: "status" }]);
    await assert.rejects(runLogin(["online", root, machine, "-1", "52800"], { ...dependencies, command: async () => { throw new Error("lost"); } }), /lost/);
    await assert.rejects(readFile(join(root, "auth.json")), { code: "ENOENT" });
    await assert.rejects(runLogin(["offline", root, machine, "-1", "52800"], dependencies), /writer lock/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
