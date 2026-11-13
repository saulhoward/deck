import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSecretReferences, secretReferences, hubEnvironment } from "./auth-bootstrap.js";
import { environmentKey, startupProviders } from "./providers.js";
import { FileCredentials } from "./credentials.js";

test("1Password mappings accept only bounded literal secret references, never plaintext or injection variables", () => {
  assert.deepEqual(secretReferences('# references only\nOPENAI_API_KEY="op://deck/local-openai-key/credential"\n'), { OPENAI_API_KEY: "op://deck/local-openai-key/credential" });
  assert.equal(secretReferences("OPENAI_API_KEY='op://vault/item/section/field'").OPENAI_API_KEY, "op://vault/item/section/field");
  assert.deepEqual(secretReferences("# mapping disabled\n"), {});
  for (const text of ["OPENAI_API_KEY=secret", "PATH=op://v/i/f", "NODE_OPTIONS=op://v/i/f", "OPENAI_API_KEY=op://$VAULT/i/f", "OPENAI_API_KEY=op://v/i/$(cmd)", "OPENAI_API_KEY=op://v/i/f\nOPENAI_API_KEY=op://v/i/g", 'OPENAI_API_KEY="op://v/i/f', "OPENAI_API_KEY=op://v/i", "OPENAI_API_KEY=op://v/i/f\0", "OPENAI_API_KEY=op://v/i/" + "x".repeat(4096)]) assert.throws(() => secretReferences(text));
  assert.deepEqual(hubEnvironment({ OPENAI_API_KEY: "fake", OP_SESSION_account: "private", OP_SERVICE_ACCOUNT_TOKEN: "private", OP_CONNECT_TOKEN: "private", HOME: "/home", OTHER: undefined }), { OPENAI_API_KEY: "fake", HOME: "/home" });
});

test("reference file is optional, private, owned, bounded and no-follow; secrets are never rewritten", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-op-refs-")); const path = join(root, ".env");
  try {
    assert.equal(await readSecretReferences(path), undefined);
    const text = 'OPENAI_API_KEY="op://deck/local-openai-key/credential"\n';
    await writeFile(path, text, { mode: 0o600 }); assert.equal((await readSecretReferences(path))!.OPENAI_API_KEY, "op://deck/local-openai-key/credential");
    assert.equal(await readFile(path, "utf8"), text);
    await chmod(path, 0o644); await assert.rejects(readSecretReferences(path)); await chmod(path, 0o600);
    await symlink(path, join(root, "link")); await assert.rejects(readSecretReferences(join(root, "link")));
    await assert.rejects(readSecretReferences(root));
    await writeFile(path, "#".repeat(16385)); await assert.rejects(readSecretReferences(path));
    await writeFile(path, Buffer.from([255])); await assert.rejects(readSecretReferences(path));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("default startup prefers and freezes an environment key, ignores stored OAuth, and does not persist keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-auth-selection-")); const path = join(root, "auth.json");
  const previous = process.env.OPENAI_API_KEY;
  try {
    const store = new FileCredentials(path);
    await store.modify("openai", async () => ({ type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0 }));
    const original = await readFile(path);
    process.env.OPENAI_API_KEY = "fake-env-key";
    const provider = await startupProviders("--auto", path, "machine");
    assert.equal(provider.mode, "--api-key"); assert.ok(provider.login);
    assert.equal((await provider.models.getAuth("openai"))?.auth.apiKey, "fake-env-key");
    process.env.OPENAI_API_KEY = "changed-key";
    assert.equal((await provider.models.getAuth("openai"))?.auth.apiKey, "fake-env-key");
    assert.deepEqual(await readFile(path), original);
    const fresh = join(root, "absent-auth.json"); await startupProviders("--auto", fresh, "machine");
    await assert.rejects(readFile(fresh), { code: "ENOENT" });
    await writeFile(path, "corrupt"); await startupProviders("--auto", path, "machine"); // API key never reads the OAuth store.
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; await rm(root, { recursive: true, force: true }); }
});

test("default startup refuses missing/unresolved credentials, and OAuth selection cannot start reading later API keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "deck-auth-missing-")); const path = join(root, "auth.json");
  const previous = process.env.OPENAI_API_KEY;
  try {
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(startupProviders("--auto", path, "machine"), /deck login openai/);
    assert.equal(environmentKey({}), undefined); assert.equal(environmentKey({ OPENAI_API_KEY: "" }), undefined);
    for (const value of ["op://v/i/f", " ", "key\n", "x".repeat(16385)]) assert.throws(() => environmentKey({ OPENAI_API_KEY: value }));
    const store = new FileCredentials(path);
    await store.modify("openai", async () => ({ type: "oauth", access: "saved-oauth-access", refresh: "saved-refresh", expires: Date.now() + 3600000 }));
    const provider = await startupProviders("--auto", path, "machine");
    assert.equal(provider.mode, "--chatgpt");
    process.env.OPENAI_API_KEY = "must-not-fallback";
    await store.delete("openai");
    await assert.rejects(provider.guard(), /deck login openai/);
    assert.equal(await provider.models.getAuth("openai"), undefined);
    const mock = await startupProviders("--mock", path, "machine"); assert.equal(mock.mode, "--mock");
    process.env.OPENAI_API_KEY = "op://unresolved/item/field";
    await assert.rejects(startupProviders("--auto", path, "machine"), /no OAuth fallback/);
  } finally { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; await rm(root, { recursive: true, force: true }); }
});
