import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineTask } from "@earendil-works/pi-durable";
import { fingerprintImplementation } from "./compatibility.js";
import { DeckRuntime } from "./deck.js";
import { encodeFrame } from "./protocol.js";
const binary = process.env.DECK_TEST_BINARY;
test("native launcher fingerprints actual code and reports incompatible unfinished work; restoring code permits startup", { skip: !binary, timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "deck-native-compat-")); const root = join(directory, "runtime-root"); const state = join(directory, "state");
  try {
    await mkdir(root); await cp(resolve("package.json"), join(root, "package.json"));
    await mkdir(join(root, "runtime"));
    await cp(resolve("runtime/dist"), join(root, "runtime/dist"), { recursive: true, filter: (path) => !basename(path).includes(".test.") });
    await symlink(resolve("node_modules"), join(root, "node_modules"), "dir");
    assert.equal(spawnSync(binary!, ["init", "--directory", state]).status, 0);
    const config = JSON.parse(await readFile(join(state, "config.json"), "utf8")) as { machine_id: string };
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
    const implementation = await fingerprintImplementation({ root, native: binary!, entry: join(root, "runtime/dist/main.js"), mode: "--mock" });
    const runtime = await DeckRuntime.open(join(state, "session.sqlite"), {
      models, model: { provider: "faux", modelId: "faux-1" }, implementation,
      binding: { machineId: config.machine_id, cwd: await realpath(directory) }, environment: () => undefined,
      hostFiles: { call: async () => { throw new Error("No effects expected"); } },
    });
    try {
      const pending = defineTask<{}, { phase: "parked" }, null>({ name: "test.uninstalled", version: 1, initial: () => ({ phase: "parked" }), phases: { parked: async () => {} }, abort: async () => {} });
      await runtime.main.commit((tx) => tx.createTask(pending, {}, { ownership: { kind: "conversation" } }), context);
    } finally { await runtime.close(); }
    const module = join(root, "runtime/dist/deck.js"); const original = await readFile(module, "utf8");
    await writeFile(module, `${original}\n// A different implementation, despite unchanged package version.\n`);
    const launch = () => spawnSync(binary!, ["serve", "--stdio", "--mock", "--directory", state, "--workspace", directory, "--runtime", join(root, "runtime/dist/main.js")], {
      input: encodeFrame({ version: 1, id: "status", command: "status" }), timeout: 10_000,
    });
    const changed = launch(); assert.notEqual(changed.status, 0); assert.equal(changed.signal, null);
    assert.match(changed.stderr.toString(), /Unfinished work requires the original Deck implementation/);
    assert.equal(changed.stdout.length, 0);
    await writeFile(module, original);
    const restored = launch(); assert.equal(restored.status, 0, restored.stderr.toString());
    const response = JSON.parse(restored.stdout.subarray(4).toString()) as { ok: boolean; result: { implementation: string; activity: { tasks: unknown[] } } };
    assert.equal(response.ok, true); assert.equal(response.result.implementation, runtime.implementation); assert.equal(response.result.activity.tasks.length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
