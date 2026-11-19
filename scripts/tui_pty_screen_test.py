"""Byte-fragment and rendered-cell tests for the PTY screen projection."""
import sys
import unittest

import pyte

sys.dont_write_bytecode = True
from tui_pty_screen import committed_output

SET = b"\x1b[?2026h"
RESET = b"\x1b[?2026l"


def display(data):
    screen = pyte.Screen(30, 4)
    pyte.ByteStream(screen).feed(committed_output(data))
    return screen.display


class SynchronizedScreenTests(unittest.TestCase):
    def test_unframed_text_queries_and_other_modes_remain_visible(self):
        for data in [b"plain text", b"\x1b[?2026$pquery", b"\x1b[?25ltext", RESET + b"text"]:
            self.assertEqual(committed_output(data), data)

    def test_partial_update_cannot_satisfy_new_text_or_leave_old_rows(self):
        old = SET + b"\x1b[Hline 1\x1b[3;1Hline 5" + RESET
        body = b"\x1b[Hline 14\x1b[3;1H\x1b[2K"
        complete = old + SET + body + RESET
        expected = display(old)
        # Previously pyte exposed line 14 before the erase of line 5 arrived.
        torn = old + SET + b"\x1b[Hline 14"
        self.assertEqual(display(torn), expected)
        self.assertIn("line 5", "\n".join(expected))
        self.assertNotIn("line 14", "\n".join(display(torn)))
        for end in range(len(old), len(complete)):
            with self.subTest(end=end):
                self.assertEqual(display(complete[:end]), expected)
        self.assertIn("line 14", "\n".join(display(complete)))
        self.assertNotIn("line 5", "\n".join(display(complete)))
        self.assertEqual(committed_output(complete), complete)

    def test_multibyte_text_and_reset_are_safe_at_every_byte_boundary(self):
        old = SET + b"\x1b[Hprevious" + RESET
        new = SET + "\x1b[H日本語 🌍\x1b[K".encode() + RESET
        for size in [1, 2, 7, 32, 65536]:
            received = old
            for start in range(0, len(new), size):
                received += new[start:start + size]
                expected = old + new if len(received) == len(old + new) else old
                self.assertEqual(display(received), display(expected))

    def test_repeated_sets_do_not_publish_an_unfinished_frame(self):
        old = SET + b"old" + RESET
        pending = old + SET + b"partial" + SET + b"still partial"
        self.assertEqual(committed_output(pending), old)
        self.assertEqual(committed_output(pending + RESET), pending + RESET)

    def test_completed_frames_are_visible_while_the_next_is_pending(self):
        first = SET + b"first" + RESET
        second = SET + b"second" + RESET
        self.assertEqual(committed_output(first + second + SET + b"third"), first + second)
        self.assertEqual(committed_output(SET + b"no reset"), b"")


if __name__ == "__main__":
    unittest.main()
