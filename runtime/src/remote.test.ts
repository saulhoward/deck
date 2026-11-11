import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validHello, validPeer, validRegistry } from "./remote-contracts.js";
import { validRemoteCheckSnapshot } from "./generated/contracts.js";

const fixtures = JSON.parse(await readFile(new URL("../../src/remote.test.json", import.meta.url), "utf8"));
test("shared remote contracts preserve exact identities and explicit roles", () => {
  for (const fixture of fixtures.cases) {
    const value = structuredClone(fixtures.bases[fixture.kind]);
    if (fixture.path) {
      let target = value;
      for (const key of fixture.path.slice(0, -1)) target = target[key];
      const last = fixture.path.at(-1);
      if (fixture.remove) delete target[last]; else target[last] = fixture.value;
    }
    const check = fixture.kind === "peer" ? validPeer : fixture.kind === "registry" ? validRegistry : validHello;
    assert.equal(check(value), fixture.valid, fixture.name);
  }
});
const binary = process.env.DECK_TEST_BINARY;
for (const mode of ["matched", "legacy_absent", "legacy_absent_wrong_peer", "bad_flag", "null_node", "local_stopped", "local_needs_auth", "local_malformed", "local_timeout", "local_flood", "wrong_peer", "wrong_user", "wrong_address", "unauthorized", "expired", "bad_json", "duplicate_node", "flood", "stderr", "timeout", "bad_registry", "public_registry", "symlink_registry", "loopback", "dns"]) {
  test(`native remote-check ${mode}: fail-closed, read-only, no ambient routing`, { skip: !binary, timeout: 12_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "deck-remote-check-"));
    const registry = structuredClone(fixtures.bases.registry); registry.hosts[0].peer.userId = "1";
    const config = join(directory, "registry.json"); const cli = join(directory, "tailscale"); const log = join(directory, "calls.json");
    const body: any = { Node: { StableID: "nTestPeer1", User: 1, Addresses: ["100.64.0.1/32"], MachineAuthorized: true, KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 1 }, CapMap: { private: ["PRIVATE_DAEMON_BODY"] } };
    const success = mode === "matched" || mode === "legacy_absent";
    const status = { BackendState: mode === "local_stopped" ? "Stopped" : mode === "local_needs_auth" ? "NeedsMachineAuth" : "Running", Self: { ID: "nLocalPeer", UserID: 1, TailscaleIPs: ["100.64.0.254"] } };
    if (mode.startsWith("legacy_absent")) delete body.Node.MachineAuthorized;
    if (mode === "bad_flag") body.Node.MachineAuthorized = "true";
    if (mode === "wrong_peer" || mode === "legacy_absent_wrong_peer") body.Node.StableID = "nOther";
    if (mode === "wrong_user") body.Node.User = body.UserProfile.ID = 2;
    if (mode === "wrong_address") body.Node.Addresses = ["100.64.0.2/32"];
    if (mode === "unauthorized") body.Node.MachineAuthorized = false;
    if (mode === "expired") body.Node.KeyExpiry = "2000-01-01T00:00:00Z";
    if (mode === "null_node") body.Node = null;
    if (mode === "bad_registry") registry.hosts.push(structuredClone(registry.hosts[0]));
    const payload = mode === "bad_json" ? "{bad" : mode === "duplicate_node" ? JSON.stringify(body).replace('"Node":', '"Node":{},"Node":') : JSON.stringify(body);
    await writeFile(config, JSON.stringify(registry), { mode: 0o600 });
    if (mode === "public_registry") await chmod(config, 0o644);
    const link = join(directory, "registry-link.json"); if (mode === "symlink_registry") await symlink(config, link);
    await writeFile(cli, `#!${process.execPath}\nconst fs=require('node:fs');const assert=require('node:assert/strict');
const args=process.argv.slice(2);
for(const name of ['TS_AUTHKEY','TS_SOCKET','TAILSCALE_USE_WIP_CODE','OPENAI_API_KEY','DECK_RUNTIME_ROOT','NODE_OPTIONS','REX_SERVER'])assert.equal(process.env[name],undefined);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(args[0]==='status') {
  assert.deepEqual(args,['status','--json','--peers=false']);
  ${mode === "local_timeout" ? "setInterval(()=>{},100);" : mode === "local_flood" ? "process.stdout.write('X'.repeat(100000));" : `process.stdout.write(${JSON.stringify(mode === "local_malformed" ? "{bad" : JSON.stringify(status))});`}
} else {
  assert.deepEqual(args,['whois','--json','100.64.0.1:52800']);
  ${mode === "timeout" ? "setInterval(()=>{},100);" : mode === "stderr" ? `process.stderr.write(${JSON.stringify(payload)});` : mode === "flood" ? "process.stdout.write('X'.repeat(100000));" : `process.stdout.write(${JSON.stringify(payload)});`}
}
`, { mode: 0o700 });
    const child = spawn(resolve(binary!), ["remote-check", "--registry", mode === "symlink_registry" ? link : config, "--machine", registry.hosts[0].machineId, "--tailscale", cli, "--peer", mode === "loopback" ? "127.0.0.1:52800" : mode === "dns" ? "example.ts.net:52800" : "100.64.0.1:52800"], {
      env: { ...process.env, TS_AUTHKEY: "not-a-real-key", TS_SOCKET: "/untrusted/socket", TAILSCALE_USE_WIP_CODE: "1", OPENAI_API_KEY: "not-a-real-key", REX_SERVER: "untrusted" },
    });
    const closed = once(child, "close"); let output = ""; let error = "";
    child.stdout.on("data", (b) => { output += b; }); child.stderr.on("data", (b) => { error += b; }); child.stdin.end();
    try {
      const [code] = await closed;
      assert.equal(code, success ? 0 : 1, error);
      assert.doesNotMatch(output + error, /PRIVATE_DAEMON_BODY|CapMap|not-a-real-key|untrusted/);
      if (success) {
        const snapshot = JSON.parse(output); assert.ok(validRemoteCheckSnapshot(snapshot));
        assert.deepEqual(snapshot, { version: 1, hubId: "test-hub", machineId: registry.hosts[0].machineId, registered: true, client: true, worker: true, connection: "not_checked" });
      } else assert.equal(output, "");
      const names = await readdir(directory);
      assert.equal(names.includes("calls.json"), !["bad_registry", "public_registry", "symlink_registry", "loopback", "dns"].includes(mode));
      if (names.includes("calls.json")) {
        const calls = (await readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        assert.deepEqual(calls, [["status", "--json", "--peers=false"], ...(mode.startsWith("local_") ? [] : [["whois", "--json", "100.64.0.1:52800"]])]);
      }
      assert.ok(names.every((name) => ["registry.json", "registry-link.json", "calls.json", "tailscale"].includes(name)));
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; await rm(directory, { recursive: true, force: true }); }
  });
}
