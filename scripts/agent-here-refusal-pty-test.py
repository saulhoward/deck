#!/usr/bin/env python3
"""Run one expected-refusal CLI in an owned PTY; never contacts Rex itself."""
import errno
import json
import os
import pty
import select
import signal
import sys
import time

pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
output = bytearray()
exited = False
try:
    deadline = time.monotonic() + 12
    while time.monotonic() < deadline:
        if select.select([fd], [], [], .02)[0]:
            try:
                output.extend(os.read(fd, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        assert len(output) < 1024 * 1024, "unbounded refusal output"
        child, status = os.waitpid(pid, os.WNOHANG)
        if child:
            exited = True
            print(json.dumps(dict(exitCode=os.waitstatus_to_exitcode(status), output=output.decode(errors='replace'))))
            break
    else:
        raise AssertionError("refusal timed out: " + output.decode(errors='replace'))
finally:
    if not exited:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(fd)
