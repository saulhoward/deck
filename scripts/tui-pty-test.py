#!/usr/bin/env python3
"""Small real-PTY test driver, not production terminal infrastructure.
Reads an action list on stdin, runs only the supplied test client/loopback port.
"""
import base64
import errno
import fcntl
import json
import os
import pty
import pyte
import re
import select
import signal
import struct
import sys
import termios
import time

steps = json.load(sys.stdin)
ready_r, ready_w = os.pipe()
pid, master = pty.fork()
if pid == 0:
    os.close(ready_w)
    os.read(ready_r, 1)
    os.close(ready_r)
    os.execvpe(sys.argv[1], sys.argv[1:], dict(os.environ, TERM="xterm-256color"))
os.close(ready_r)
original = termios.tcgetattr(master)
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 800, 600))
os.write(ready_w, b"1")
os.close(ready_w)
output = bytearray()
rows, cols = 40, 100

class SilentScreen(pyte.Screen):
    # Intentionally emulate a legacy terminal that doesn't answer capability
    # queries. pyte 0.8's DSR callback doesn't accept private-mode queries.
    def report_device_status(self, *args, **kwargs):
        pass

    def report_device_attributes(self, *args, **kwargs):
        pass

def rendered():
    screen = SilentScreen(cols, rows)
    # Assertions concern text/cursor layout, not color. pyte 0.8 predates colon
    # SGR parameters. Reparse the bounded capture so chunk-split SGR/UTF-8 is safe.
    text_only = re.sub(rb"\x1b\[[0-9:;]*m", b"", bytes(output))
    pyte.ByteStream(screen).feed(text_only)
    return "\n".join(screen.display)

def program_status():
    reports = []
    for match in re.finditer(rb"\x1b\]7501;([^\x1b\x07]*)(?:\x07|\x1b\\)", bytes(output)):
        body = match.group(1)
        if body.startswith(b"?"):
            continue  # Vaxis's optional capability query, not a report.
        assert len(match.group(0)) <= 4096, "Oversized program status"
        record = dict(pair.split("=", 1) for pair in body.decode("ascii").split(":"))
        assert record["state"] in ["idle", "working", "done", "blocked", "error", "clear"]
        assert record["id"] == "deck", "Unscoped status may clear other programs"
        if record["state"] != "clear":
            assert record["app"] == "deck"
        for key, cap in [("title", 192), ("msg", 2048)]:
            if key in record:
                text = base64.b64decode(record[key], validate=True)
                assert len(text) <= cap
                record[key] = text.decode("utf-8")
                assert all(ord(c) >= 32 and not 127 <= ord(c) <= 159 for c in record[key])
        reports.append(record)
    return reports

status = None
exited = False

def pump(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        readers, _, _ = select.select([master], [], [], min(.02, max(0, end - time.monotonic())))
        if readers:
            try:
                data = os.read(master, 65536)
                if not data:
                    return
                output.extend(data)
                if len(output) > 4 * 1024 * 1024:
                    raise AssertionError("Unbounded terminal output")
            except OSError as error:
                if error.errno == errno.EIO:
                    return
                raise

try:
    for step in steps:
        if "wait" in step:
            target = step["wait"]
            end = time.monotonic() + 6
            while target not in rendered() and time.monotonic() < end:
                pump(.02)
            assert target in rendered(), "Missing %r: %s" % (target, rendered())
        elif "wait_status" in step:
            wanted = step["wait_status"]
            end = time.monotonic() + 6
            while time.monotonic() < end:
                reports = program_status()
                if reports and reports[-1]["state"] == wanted:
                    break
                pump(.02)
            else:
                raise AssertionError("Missing status %s: %r" % (wanted, program_status()))
        elif "keys" in step:
            os.write(master, step["keys"].encode())
            pump(.12)  # Disambiguate a literal Escape from Alt-prefixed keys.
        elif "sleep" in step:
            pump(step["sleep"])
        elif "resize" in step:
            rows, cols = step["resize"]
            fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 800, 600))
            os.kill(pid, signal.SIGWINCH)
            pump(.12)
        elif "signal" in step:
            os.kill(pid, getattr(signal, step["signal"]))
    end = time.monotonic() + 4
    while time.monotonic() < end:
        pump(.02)
        child, status = os.waitpid(pid, os.WNOHANG)
        if child:
            exited = True
            break
    else:
        raise AssertionError("Client did not detach promptly: %r" % output[-6000:])
    assert os.waitstatus_to_exitcode(status) == 0, repr(output[-6000:])
    assert termios.tcgetattr(master) == original, "TTY modes not restored"
    assert b"\x1b[?1049l" in output, "Alternate screen not restored"
    assert b"memory address" not in output and b"[gpa]" not in output, repr(output[-6000:])
    reports = program_status()
    assert reports and reports[-1] == {"state": "clear", "id": "deck"}, "Status not cleared on detach"
    assert b"\x1b[22;2t" in output and b"\x1b[23;2t" in output, "Window title not restored"
    print(json.dumps({"output": base64.b64encode(output).decode(), "restored": True, "programStatus": reports}))
finally:
    if not exited:
        try:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        except ProcessLookupError:
            pass
    os.close(master)
