import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const binary = process.env.DECK_TEST_BINARY;
const command = "__message-viewer";
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error("viewer condition not observed");
}
async function exists(path: string): Promise<boolean> { return stat(path).then(() => true, () => false); }
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "deck-viewer-test-"));
  const root = join(parent, `deck-message-${randomBytes(16).toString("hex")}`);
  await mkdir(root, { mode: 0o700 });
  const path = join(root, "control.json"), message = join(root, "message.md");
  const control = { version: 1, cwd: parent, argv: ["/usr/bin/true"] };
  await writeFile(path, JSON.stringify(control), { mode: 0o600 });
  await writeFile(message, "retained text", { mode: 0o600 });
  return { parent, root, path, message, control };
}

test("native message viewer helper outlives launcher, keeps full export until exit, and never edits canonical text", { skip: !binary, timeout: 15_000 }, async () => {
  const f = await fixture();
  let pid: number | undefined;
  try {
    const source = join(f.parent, "canonical.md"), report = join(f.parent, "report.json"), gate = join(f.parent, "exit");
    const content = "full retained text\n".repeat(2000) + "\n$(touch INJECTED); `id` <script>literal</script>\n";
    await writeFile(source, content);
    await writeFile(f.message, content);
    const program = join(f.parent, "fake viewer.mjs");
    await writeFile(program, `import fs from 'node:fs';
const file = process.argv.at(-1);
fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),content:fs.readFileSync(file,'utf8'),secret:process.env.OPENAI_API_KEY,injection:process.env.NODE_OPTIONS}));
fs.writeFileSync(file, 'edited export only');
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); process.exit(0); } }, 20);
`);
    const args = [program, "--wait", "two words", "$HOME;$(touch INJECTED)", ""];
    await writeFile(f.path, JSON.stringify({ ...f.control, argv: [process.execPath, ...args] }));
    // Model a Rex server-owned launch: the creating client exits without owning
    // the helper process group. No user Rex sessions or real viewers are touched.
    const launcher = spawnSync(process.execPath, ["--input-type=module", "-e", `
import {spawn} from 'node:child_process';
const child = spawn(${JSON.stringify(binary)}, ${JSON.stringify([command, f.path])}, {detached:true,stdio:'ignore',env:{...process.env,OPENAI_API_KEY:'PRIVATE',NODE_OPTIONS:'--no-warnings'}});
console.log(child.pid); child.unref();
`], { encoding: "utf8", timeout: 5000 });
    assert.equal(launcher.status, 0, launcher.stderr);
    pid = Number(launcher.stdout.trim()); assert.ok(pid > 0);
    await until(() => exists(report));
    const observed = JSON.parse(await readFile(report, "utf8"));
    assert.deepEqual(observed.args, [...args.slice(1), f.message]);
    // macOS /var is a symlink; compare canonical cwd rather than its spelling.
    const { realpath } = await import("node:fs/promises");
    assert.equal(observed.cwd, await realpath(f.parent));
    assert.equal(observed.content, content);
    assert.equal(observed.secret, undefined); assert.equal(observed.injection, undefined);
    assert.equal(await readFile(source, "utf8"), content);
    assert.equal(await readFile(f.message, "utf8"), "edited export only");
    assert.equal((await stat(f.root)).mode & 0o777, 0o700);
    assert.equal((await stat(f.message)).mode & 0o777, 0o600);
    // A duplicate helper must neither launch again nor remove the live file.
    const duplicate = spawnSync(binary!, [command, f.path], { encoding: "utf8", timeout: 3000 });
    assert.equal(duplicate.status, 1); assert.ok(await exists(f.message));
    assert.doesNotMatch(duplicate.stderr, /PRIVATE|INJECTED/);
    await writeFile(gate, "exit");
    await until(async () => !await exists(f.root));
    pid = undefined;
    assert.equal(await readFile(source, "utf8"), content);
    assert.equal(await exists(join(f.parent, "INJECTED")), false);
  } finally {
    if (pid) { try { process.kill(-pid, "SIGKILL"); } catch {} }
    await rm(f.parent, { recursive: true, force: true });
  }
});

test("native viewer helper strictly rejects untrusted control files without cleanup or effects", { skip: !binary, timeout: 15_000 }, async () => {
  for (const mode of ["public-control", "public-directory", "symlink-control", "symlink-directory", "hardlink-control", "oversize-control", "oversize-message", "symlink-message", "bad-version", "unknown-field", "relative-program", "too-many-args", "wrong-directory"] as const) {
    const f = await fixture();
    try {
      let path = f.path;
      switch (mode) {
        case "public-control": await chmod(f.path, 0o644); break;
        case "public-directory": await chmod(f.root, 0o755); break;
        case "symlink-control": await rm(f.path); await symlink(f.message, f.path); break;
        case "symlink-directory": {
          const alias = join(f.parent, `deck-message-${"a".repeat(32)}`); await symlink(f.root, alias); path = join(alias, "control.json"); break;
        }
        case "hardlink-control": await link(f.path, join(f.parent, "other.json")); break;
        case "oversize-control": await truncate(f.path, 32769); break;
        case "oversize-message": await truncate(f.message, 16 * 1024 * 1024 + 1); break;
        case "symlink-message": await rm(f.message); await symlink(f.path, f.message); break;
        case "bad-version": await writeFile(f.path, JSON.stringify({ ...f.control, version: 2 })); break;
        case "unknown-field": await writeFile(f.path, JSON.stringify({ ...f.control, cleanup: f.parent })); break;
        case "relative-program": await writeFile(f.path, JSON.stringify({ ...f.control, argv: ["true"] })); break;
        case "too-many-args": await writeFile(f.path, JSON.stringify({ ...f.control, argv: Array(33).fill("/usr/bin/true") })); break;
        case "wrong-directory": path = join(f.parent, "control.json"); await writeFile(path, JSON.stringify(f.control), { mode: 0o600 }); break;
      }
      const child = spawnSync(binary!, [command, path], { encoding: "utf8", timeout: 3000 });
      assert.equal(child.status, 1, mode + child.stderr);
      assert.ok(await exists(f.root), mode);
      assert.ok(await exists(f.message), mode);
      assert.doesNotMatch(child.stderr, /retained text|argv|SECRET/);
    } finally { await rm(f.parent, { recursive: true, force: true }); }
  }
});

test("native helper cleans only its two fixed files, including on viewer failure", { skip: !binary }, async () => {
  for (const fail of [false, true]) {
    const f = await fixture();
    try {
      const backup = join(f.root, "editor-backup"), outside = join(f.parent, "unrelated");
      await writeFile(outside, "untouched"); await symlink(outside, backup);
      await writeFile(f.path, JSON.stringify({ ...f.control, argv: [fail ? "/no/such/viewer" : "/usr/bin/true"] }));
      const child = spawn(binary!, [command, f.path], { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.resume();
      const [code] = await once(child, "close");
      assert.equal(code, fail ? 1 : 0);
      assert.equal(await exists(f.message), false); assert.equal(await exists(f.path), false);
      assert.equal(await readFile(backup, "utf8"), "untouched");
      assert.equal(await readFile(outside, "utf8"), "untouched");
    } finally { await rm(f.parent, { recursive: true, force: true }); }
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
  for (const target of ["group", "helper"] as const) {
    for (const behavior of ["default", "delayed", "ignore"] as const) {
      test(`native helper ${signal} to ${target}: ${behavior} viewer exits before cleanup`, { skip: !binary, timeout: 10_000 }, async () => {
        const f = await fixture();
        let viewerPid: number | undefined;
        let child: ReturnType<typeof spawn> | undefined;
        try {
          const ready = join(f.parent, "ready.json"), stopped = join(f.parent, "stopped.json"), finished = join(f.parent, "finished.json");
          const program = join(f.parent, "sleeping-viewer.mjs");
          await writeFile(program, `import fs from 'node:fs';
const snapshot = () => ({message:fs.readFileSync(process.argv.at(-1),'utf8'),control:fs.existsSync(${JSON.stringify(f.path)})});
let stopping = false;
if (${JSON.stringify(behavior)} !== 'default') process.on(${JSON.stringify(signal)}, () => {
  if (stopping) return;
  stopping = true;
  fs.writeFileSync(${JSON.stringify(stopped)}, JSON.stringify(snapshot()));
  if (${JSON.stringify(behavior)} === 'delayed') setTimeout(() => {
    fs.writeFileSync(${JSON.stringify(finished)}, JSON.stringify(snapshot()));
    process.exit(0);
  }, 300);
});
setInterval(() => {}, 1000);
fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid}));
`);
          await writeFile(f.path, JSON.stringify({ ...f.control, argv: [process.execPath, program] }));
          child = spawn(binary!, [command, f.path], { detached: true, stdio: ["ignore", "ignore", "pipe"] });
          let stderr = "";
          child.stderr!.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
          const closed = once(child, "close");
          await until(() => exists(ready));
          viewerPid = (JSON.parse(await readFile(ready, "utf8")) as { pid: number }).pid;
          // An interactive viewer must keep the helper's foreground group. This
          // fixture owns its detached group; no user Rex or parent TUI is touched.
          const group = spawnSync("ps", ["-o", "pgid=", "-p", String(viewerPid)], { encoding: "utf8" });
          assert.equal(group.status, 0, group.stderr);
          assert.equal(Number(group.stdout.trim()), child.pid);
          process.kill(target === "group" ? -child.pid! : child.pid!, signal);
          if (behavior !== "default") {
            await until(() => exists(stopped));
            assert.deepEqual(JSON.parse(await readFile(stopped, "utf8")), { message: "retained text", control: true });
            assert.ok(alive(viewerPid));
            assert.ok(await exists(f.message), "export must remain while viewer handles the signal");
            assert.ok(await exists(f.path));
          }
          const [code, killedBy] = await closed;
          assert.equal(code, 1, stderr); // A caught helper signal is not success.
          assert.equal(killedBy, null, "helper must handle, not die from, the signal");
          assert.equal(alive(viewerPid), false, "helper must reap viewer before exit/cleanup");
          viewerPid = undefined;
          assert.equal(await exists(f.message), false);
          assert.equal(await exists(f.path), false);
          assert.equal(await exists(f.root), false);
          if (behavior === "delayed") assert.deepEqual(JSON.parse(await readFile(finished, "utf8")), { message: "retained text", control: true });
          if (behavior === "ignore") assert.equal(await exists(finished), false, "non-cooperative viewer must be killed within the bounded wait");
          assert.doesNotMatch(stderr, /retained text|argv|sleeping-viewer/);
        } finally {
          if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
          if (viewerPid && alive(viewerPid)) { try { process.kill(viewerPid, "SIGKILL"); } catch {} }
          await rm(f.parent, { recursive: true, force: true });
        }
      });
    }
  }
}

// SIGKILL/crashes cannot execute a handler or defer. Do not claim automatic
// cleanup in that case, or delete an export merely because its helper died.
test("native helper SIGKILL leaves private files for manual cleanup after viewer exit", { skip: !binary, timeout: 10_000 }, async () => {
  const f = await fixture();
  let child: ReturnType<typeof spawn> | undefined;
  let viewerPid: number | undefined;
  try {
    const ready = join(f.parent, "ready"), program = join(f.parent, "sleeping-viewer.mjs");
    await writeFile(program, `import fs from 'node:fs'; setInterval(() => {}, 1000); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));`);
    await writeFile(f.path, JSON.stringify({ ...f.control, argv: [process.execPath, program] }));
    child = spawn(binary!, [command, f.path], { detached: true, stdio: "ignore" });
    const closed = once(child, "close");
    await until(() => exists(ready));
    viewerPid = Number(await readFile(ready, "utf8"));
    child.kill("SIGKILL");
    const [code, signal] = await closed;
    assert.equal(code, null); assert.equal(signal, "SIGKILL");
    assert.ok(alive(viewerPid));
    assert.equal(await readFile(f.message, "utf8"), "retained text");
    assert.ok(await exists(f.path));
    process.kill(viewerPid, "SIGKILL");
    await until(async () => {
      if (!alive(viewerPid!)) return true;
      // Minimal Linux container init processes may not reap this orphan. A
      // zombie is confirmed exited too; it cannot still use the private files.
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(viewerPid)], { encoding: "utf8" });
      return state.status === 0 && state.stdout.trim().startsWith("Z");
    });
    viewerPid = undefined;
    assert.ok(await exists(f.message)); assert.ok(await exists(f.path));
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    if (viewerPid && alive(viewerPid)) { try { process.kill(viewerPid, "SIGKILL"); } catch {} }
    await rm(f.parent, { recursive: true, force: true });
  }
});

// A real PTY, but only fake local processes: the helper and interactive viewer
// share a foreground group with a stand-in Rex/launcher. Relaying to killpg(0)
// would kill the launcher; isolating the viewer without tcsetpgrp would SIGTTIN.
for (const mode of ["helper-only TERM", "terminal Ctrl-C"] as const) test(`native viewer retains foreground input; ${mode} spares its parent group`, { skip: !binary, timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const ready = join(f.parent, "ready"), input = join(f.parent, "input.json"), program = join(f.parent, "interactive-viewer.mjs");
    await writeFile(program, `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
const buffer = Buffer.alloc(100);
const size = fs.readSync(0, buffer, 0, buffer.length, null);
fs.writeFileSync(${JSON.stringify(input)}, JSON.stringify({input:buffer.subarray(0,size).toString(),content:fs.readFileSync(process.argv.at(-1),'utf8')}));
setInterval(() => {}, 1000);
`);
    await writeFile(f.path, JSON.stringify({ ...f.control, argv: [process.execPath, program] }));
    const driver = spawnSync("python3", ["-c", `
import errno, os, pty, select, signal, subprocess, sys, time
binary, control, ready, received, mode = sys.argv[1:]
def until(check):
    end = time.monotonic() + 4
    while time.monotonic() < end:
        if check(): return
        time.sleep(.01)
    raise RuntimeError('PTY viewer condition not observed')
pid, fd = pty.fork()
if pid == 0:
    # Like an interactive shell, the launcher ignores Ctrl-C, not TERM. The
    # helper must install its own handler and the viewer must get normal INT.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    helper = subprocess.Popen([binary, '${command}', control])
    try:
        until(lambda: os.path.exists(ready))
        viewer = int(open(ready).read())
        assert os.getpgid(viewer) == os.getpgrp() == os.tcgetpgrp(0)
        print('INPUT_READY', flush=True)
        until(lambda: os.path.exists(received))
        if mode == 'terminal Ctrl-C': print('STOP_READY', flush=True)
        else: helper.send_signal(signal.SIGTERM)
        assert helper.wait(timeout=4) == 1
        try: os.kill(viewer, 0)
        except ProcessLookupError: pass
        else: raise RuntimeError('viewer survived helper')
        assert not os.path.exists(control)
        print('PARENT_SURVIVED', flush=True)
    finally:
        if helper.poll() is None: helper.kill(); helper.wait()
    sys.exit(0)
output = b''
sent = False
interrupted = False
status = None
try:
    end = time.monotonic() + 11
    while time.monotonic() < end:
        if select.select([fd], [], [], .02)[0]:
            try: chunk = os.read(fd, 65536)
            except OSError as err:
                if err.errno != errno.EIO: raise
                break
            if not chunk: break
            output += chunk
            if b'INPUT_READY' in output and not sent:
                os.write(fd, b'interactive input\\n')
                sent = True
            if b'STOP_READY' in output and not interrupted:
                os.write(fd, bytes([3]))
                interrupted = True
        waited, result = os.waitpid(pid, os.WNOHANG)
        if waited: status = result; break
    if status is None:
        waited, result = os.waitpid(pid, os.WNOHANG)
        if waited: status = result
    sys.stdout.buffer.write(output)
    assert b'PARENT_SURVIVED' in output, output
finally:
    if status is None:
        try: os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError: pass
        except PermissionError: os.kill(pid, signal.SIGKILL) # Darwin can reject an exited group.
        os.waitpid(pid, 0)
    os.close(fd)
`, binary!, f.path, ready, input, mode], { encoding: "utf8", timeout: 13_000 });
    assert.equal(driver.status, 0, driver.stdout + driver.stderr);
    assert.match(driver.stdout, /PARENT_SURVIVED/);
    assert.deepEqual(JSON.parse(await readFile(input, "utf8")), { input: "interactive input\n", content: "retained text" });
    assert.equal(await exists(f.root), false);
  } finally { await rm(f.parent, { recursive: true, force: true }); }
});
