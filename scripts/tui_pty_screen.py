"""Test-only projection of Vaxis synchronized output for pyte.

PTY read boundaries are not render boundaries. pyte does not implement DEC
synchronized output (mode 2026), so don't let a wait/capture observe a partial
update. Keep the raw capture untouched for protocol/restoration assertions.
"""
import re

_SYNC = re.compile(rb"\x1b\[\?2026([hl])")


def committed_output(data):
    """Return bytes before any unfinished synchronized update.

    Reparse the bounded capture so UTF-8 and control sequences may be split at
    any byte. Repeated SETs are idempotent, not nested updates. A missing RESET
    stays uncommitted; a test deadline must fail rather than bless a torn view.
    """
    pending = None
    for match in _SYNC.finditer(data):
        if match[1] == b"h":
            if pending is None:
                pending = match.start()
        else:
            pending = None
    return data if pending is None else data[:pending]
