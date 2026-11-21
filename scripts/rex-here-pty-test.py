#!/usr/bin/env python3
"""Read-only native here adoption, with owned PTYs/processes and a fake Rex.

Runs on macOS and Linux: python3 scripts/rex-here-pty-test.py
No installed Rex server is contacted. Never kills a non-owned process/group.
"""
import copy
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
UUID = "00000000-0000-4000-8000-000000000001"
SID, WID, BID = (prefix + ":" + UUID for prefix in ("session", "window", "block"))
MACHINE = "a" * 32


def write(path, value):
    path.write_text(json.dumps(value))
    path.chmod(0o600)


FAKE = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(__file__).parent
s = json.loads((root / 'state').read_text())
a = sys.argv[1:]
with (root / 'calls').open('a') as f: f.write(json.dumps(a) + '\n')
assert a[:4] == ['--autostart=false', '--timeout', '2s', '--server']
assert a[4] == s['server']
a = a[5:]
variant = s.get('variant', '')
status = dict(endpoint=s['server'], host_id=s['uuid'], instance_id=s['uuid'], api_revision=14, you=dict(transport='unix'), account='fixture')
if variant == 'server': status['instance_id'] = '00000000-0000-4000-8000-000000000002'
block = dict(block_id=s['bid'], window_id=s['wid'], host_id=s['uuid'], flavor='com.superlogical.terminal.shell', placement='placed')
if variant == 'window': block['window_id'] = 'window:00000000-0000-4000-8000-000000000002'
if variant == 'host': block['host_id'] = '00000000-0000-4000-8000-000000000002'
if variant == 'flavor': block['flavor'] = 'not-a-terminal'
if variant == 'detached': block['placement'] = 'detached'
if a == ['server', 'status', '--json'] or a == ['whoami', '--json']: out = status
elif a[:2] == ['api', 'call']:
    arg = json.loads(a[3]); assert arg['session_id'] == s['sid']
    if 'block_id' in arg: assert arg['block_id'] == s['bid']
    if a[2] == 'session.describe_block': out = dict(block=block)
    elif a[2] == 'session.view': out = dict(session_id=s['sid'], revision=1, windows=[dict(window_id=s['wid'], layers=[dict(blocks=[block])])])
    elif a[2] == 'session.list_blocks': out = dict(blocks=[block])
    elif a[2] == 'com.superlogical.terminal.process':
        client = int(Path(s['pidfile']).read_text())
        child = s.get('foreign', s['root']) if variant == 'foreign' else s['root']
        uid = os.getuid() + (1 if variant == 'uid' else 0)
        out = dict(child=dict(pid=child, user_id=uid), foreground=dict(pid=client, user_id=os.getuid()), last_exit=None)
    else: raise AssertionError(a)
else: raise AssertionError(a) # In particular, NEVER new/run/move/spawn.
print(json.dumps(out))
'''


class Terminal:
    def __init__(self, work, binary, name, base, state, *, variant='', env=None, mode='capture'):
        self.work, self.binary = work, binary
        self.output = work / (name + '.record')
        self.done = work / (name + '.done')
        self.gate = work / (name + '.gate')
        self.input = work / (name + '.base')
        write(self.input, base)
        self.log = b''
        environment = dict(os.environ, REX_SESSION=SID, REX_BLOCK=BID)
        for key, value in (env or {}).items():
            if value is None: environment.pop(key, None)
            else: environment[key] = value
        # Two shells intentionally survive the Deck child: shell/nix-wrapper
        # ancestry must work without claiming the shell itself as the client.
        inner = shlex.join([str(binary), mode, str(self.input), str(self.output)])
        inner += '; echo done > ' + shlex.quote(str(self.done)) + '; read finish'
        outer = 'while [ ! -f ' + shlex.quote(str(self.gate)) + ' ]; do sleep .02; done; '
        outer += shlex.join(['/bin/sh', '-c', inner]) + '; read finish'
        pid, fd = pty.fork()
        if pid == 0:
            os.execve('/bin/sh', ['/bin/sh', '-c', outer], environment)
        self.pid, self.fd = pid, fd
        state.update(root=pid, pidfile=str(self.output) + '.pid', variant=variant)
        write(work / 'state', state)
        self.gate.touch()

    def await_result(self, success):
        end = time.monotonic() + 15
        while time.monotonic() < end:
            if self.output.exists():
                if self.output.stat().st_size:
                    assert success, self.output.read_text()
                    return json.loads(self.output.read_text())
            if self.done.exists():
                self.drain()
                assert not success, self.log.decode(errors='replace')
                return None
            self.drain()
            time.sleep(.02)
        raise AssertionError(('fixture timed out', self.log))

    def drain(self):
        if select.select([self.fd], [], [], 0)[0]:
            try: self.log += os.read(self.fd, 65536)
            except OSError: pass

    def detach(self):
        os.write(self.fd, b'\n')
        end = time.monotonic() + 5
        while not self.done.exists() and time.monotonic() < end: time.sleep(.02)
        assert self.done.exists(), self.log
        os.kill(self.pid, 0) # Root shell survived, not evidence the client did.

    def close(self):
        try:
            # A fixture foreground job can have its own owned child group.
            pidfile = Path(str(self.output) + '.pid')
            if pidfile.exists() and not self.done.exists():
                child = int(pidfile.read_text())
                if child > 1 and os.getpgid(child) == child:
                    os.killpg(child, signal.SIGKILL)
        except ProcessLookupError: pass
        try:
            # forkpty created this specific child's session/process group.
            assert self.pid > 1 and os.getpgid(self.pid) == self.pid
            os.killpg(self.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        self.drain()
        os.close(self.fd) # Darwin can defer PTY teardown while the master is held.
        end = time.monotonic() + 5
        while os.waitpid(self.pid, os.WNOHANG)[0] == 0:
            if time.monotonic() >= end: raise AssertionError('owned PTY child did not exit')
            time.sleep(.02)


def main():
    with tempfile.TemporaryDirectory(prefix='deck-here-') as tmp:
        work = Path(tmp).resolve()
        binary = work / 'fixture'
        subprocess.run(['zig', 'build-exe', str(ROOT / 'src/rex_here_fixture.zig'), '-lc', '-femit-bin=' + str(binary)], cwd=ROOT, check=True)
        fake = work / 'rex'
        fake.write_text(FAKE)
        fake.chmod(0o700)
        state = dict(uuid=UUID, sid=SID, wid=WID, bid=BID, server='unix://' + str(work / 'rex.sock'))
        (work / 'saved-chat-cwd').mkdir(mode=0o700)
        base = dict(version=1, id=UUID, hubId=UUID, machineId=MACHINE, cwd=str(work / 'saved-chat-cwd'), client='/approved/nix-wrapper', draftRoot=str(work), port=52800,
                    target=dict(executable=str(fake), server=state['server'], hostId=UUID, instanceId=UUID))
        counter = 0

        def invoke(mode, value, expected=None, error=None):
            nonlocal counter
            counter += 1
            inp, out = work / f'in-{counter}', work / f'out-{counter}'
            write(inp, value)
            p = subprocess.run([str(binary), mode, str(inp), str(out)], capture_output=True, timeout=15)
            if error:
                assert p.returncode != 0 and error.encode() in p.stderr, (p.returncode, p.stdout, p.stderr)
                return
            assert p.returncode == 0, (p.stdout, p.stderr)
            text = out.read_text()
            if expected: assert text == expected, text
            return text

        terminal = Terminal(work, binary, 'good', base, state)
        try:
            record = terminal.await_result(True)
            here = record['here']
            assert record['cwd'] == str(work / 'saved-chat-cwd')
            assert record['client'] == '/approved/nix-wrapper'
            assert here['process']['executable'] == str(binary)
            assert here['process']['pid'] != here['terminal']['pid'] == terminal.pid
            assert record['binding']['pid'] == int(Path(state['pidfile']).read_text())
            assert here['process']['tty'] == here['terminal']['tty']
            invoke('verify', record, 'running')
            # A same-PID forged old birth is definite old-client absence, never
            # evidence that the currently recycled PID is our client.
            changed = copy.deepcopy(record); changed['here']['process']['start'] = 'old-birth'
            invoke('verify', changed, 'exited')
            for field, value in [('executable', '/forged'), ('tty', '/dev/foreign'), ('ppid', 0), ('pgid', 2147483647)]:
                changed = copy.deepcopy(record); changed['here']['process'][field] = value
                invoke('verify', changed, error='ProcessConflict')
            # Private record + mode pin are required for adoption and inspection.
            start = work / 'startups' / UUID
            start.mkdir(parents=True, mode=0o700)
            (work / 'startups').chmod(0o700)
            write(start / 'record.json', record)
            claim = dict(id=UUID, root=str(work), blockId=BID, kind='here')
            plan = dict(executable=str(fake), server=state['server'], hostId=UUID, instanceId=UUID, client=base['client'], clientState=str(work), port=52800, hubId=UUID, chatId='42', allocationId=UUID, label='here', bootstrap=claim)
            changed = copy.deepcopy(plan); del changed['bootstrap']['kind']
            invoke('adopt', changed, error='InvalidBootstrap')
            changed = copy.deepcopy(plan); changed['chatId'] = '43'
            invoke('adopt', changed, error='InvalidBootstrap')
            scope = dict(server=state['server'], hostId=UUID, instanceId=UUID, sessionId=SID, windowId=WID, blockId=BID)
            query = dict(executable=str(fake), scope=scope, bootstrap=claim)
            assert json.loads(invoke('inspect', query))['state'] == 'conflict' # Unclaimed.
            assert json.loads(invoke('adopt', plan))['blockId'] == BID
            assert json.loads(invoke('inspect', query))['state'] == 'running'
            changed = copy.deepcopy(query); del changed['bootstrap']['kind']
            assert json.loads(invoke('inspect', changed))['state'] == 'conflict'
            record = json.loads((start / 'record.json').read_text())
            changed = copy.deepcopy(query); changed['bootstrap']['blockId'] = 'block:00000000-0000-4000-8000-000000000002'
            assert json.loads(invoke('inspect', changed))['state'] == 'conflict'
            # Scope / server changes cannot downgrade proof to absence.
            state['variant'] = 'server'; write(work / 'state', state)
            invoke('verify', record, error='RexIdentityChanged')
            assert json.loads(invoke('inspect', query))['state'] == 'identity_changed'
            state['variant'] = ''; write(work / 'state', state)
            terminal.detach()
            invoke('verify', record, 'exited')
            observed = json.loads(invoke('inspect', query))
            assert observed['state'] == 'client_exited' and observed['exitCode'] is None
            # An ordinary query continues to report the surviving root shell.
            ordinary = dict(executable=str(fake), scope=scope)
            assert json.loads(invoke('inspect', ordinary))['state'] == 'running'
            state['variant'] = 'detached'; write(work / 'state', state)
            assert json.loads(invoke('inspect', query))['state'] == 'conflict'
            state['variant'] = ''; write(work / 'state', state)
            (start / 'record.json').chmod(0o644)
            assert json.loads(invoke('inspect', query))['state'] == 'inconclusive'
        finally:
            terminal.close()

        terminal = Terminal(work, binary, 'foreground-job', base, state, mode='capture_job')
        try:
            record = terminal.await_result(True)
            assert record['here']['process']['pgid'] != record['here']['terminal']['pgid']
            invoke('verify', record, 'running')
            terminal.detach()
            invoke('verify', record, 'exited')
        finally: terminal.close()

        # Actual PTY foreground/background refusal and environment hint attacks.
        cases = [({}, 'capture_background', ''), ({'REX_SESSION': None}, 'capture', ''),
                 ({'REX_BLOCK': 'block:short'}, 'capture', ''),
                 ({'REX_SESSION': 'session:00000000-0000-4000-8000-000000000002'}, 'capture', ''),
                 ({}, 'capture', 'server'), ({}, 'capture', 'host'), ({}, 'capture', 'flavor'),
                 ({}, 'capture', 'detached'), ({}, 'capture', 'uid')]
        for i, (env, mode, variant) in enumerate(cases):
            terminal = Terminal(work, binary, f'refuse-{i}', base, state, env=env, mode=mode, variant=variant)
            try: terminal.await_result(False)
            finally: terminal.close()

        # A real, same-UID process on another owned PTY is never a Rex root.
        foreign_pid, foreign_fd = pty.fork()
        if foreign_pid == 0: os.execv('/bin/sleep', ['/bin/sleep', '60'])
        try:
            state['foreign'] = foreign_pid
            terminal = Terminal(work, binary, 'foreign-tty', base, state, variant='foreign')
            try: terminal.await_result(False)
            finally: terminal.close()
        finally:
            os.kill(foreign_pid, signal.SIGKILL)
            os.waitpid(foreign_pid, 0)
            os.close(foreign_fd)
        calls = [json.loads(line)[5:] for line in (work / 'calls').read_text().splitlines()]
        assert calls and all(c[0] in ('server', 'whoami', 'api') for c in calls), calls
        assert not any(c[0] in ('new', 'run', 'move', 'spawn') for c in calls)
        print(f'Native here PTY fixtures passed ({len(calls)} read-only fake Rex calls).')


if __name__ == '__main__': main()
