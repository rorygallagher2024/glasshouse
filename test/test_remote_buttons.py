"""Exercise the real worker loop with disconnected/nonblocking evdev fds."""
import errno
import importlib.util
import pathlib
import struct
import io
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "remote_buttons", pathlib.Path(__file__).parents[1] / "server/lib/remotebuttons.py")
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def exercise(self, result):
        worker.running = True
        watches = []

        def select(fds, *_):
            watches.append(list(fds))
            if len(watches) == 1:
                return [10], [], []
            worker.running = False
            return [], [], []

        with patch.object(worker.os.path, "exists", side_effect=lambda p: p == "/dev/input/event0"), \
             patch.object(worker.os, "open", return_value=10), \
             patch.object(worker.os, "close") as close, \
             patch.object(worker.os, "read", side_effect=result if isinstance(result, Exception) else None, return_value=result), \
             patch.object(worker.sys.stdin, "fileno", return_value=20), \
             patch.object(worker.select, "select", side_effect=select), \
             patch.object(worker.time, "time", return_value=100):
            worker.main()
        return watches, close

    def test_unplugged_device_is_removed_before_select_repeats(self):
        watches, close = self.exercise(OSError(errno.ENODEV, "disconnected"))
        self.assertEqual(watches, [[10, 20], [20]])
        close.assert_called_once_with(10)

    def test_eof_is_removed_before_select_repeats(self):
        watches, close = self.exercise(b"")
        self.assertEqual(watches, [[10, 20], [20]])
        close.assert_called_once_with(10)

    def test_would_block_does_not_discard_a_healthy_device(self):
        watches, close = self.exercise(OSError(errno.EAGAIN, "try later"))
        self.assertEqual(watches, [[10, 20], [10, 20]])
        close.assert_called_once_with(10)

    def test_disconnected_remote_reopens_after_backoff_and_emits_buttons(self):
        worker.running = True
        watches = []
        now = [100]

        def select(fds, *_):
            watches.append(list(fds))
            if len(watches) == 1:
                return [10], [], []
            if len(watches) == 2:
                now[0] = 106
                return [], [], []
            worker.running = False
            return [11], [], []

        with patch.object(worker.os.path, "exists", side_effect=lambda p: p == "/dev/input/event0"), \
             patch.object(worker.os, "open", side_effect=[10, 11]) as op, \
             patch.object(worker.os, "close") as close, \
             patch.object(worker.os, "read", side_effect=[OSError(errno.ENODEV, "disconnected"), struct.pack("IIHHi", 0, 0, 1, 398, 1)]), \
             patch.object(worker.sys.stdin, "fileno", return_value=20), \
             patch.object(worker.sys, "stdout", new_callable=io.StringIO) as output, \
             patch.object(worker.select, "select", side_effect=select), \
             patch.object(worker.time, "time", side_effect=lambda: now[0]):
            worker.main()
            self.assertEqual(output.getvalue(), "red 398\n")
        self.assertEqual(watches, [[10, 20], [20], [11, 20]])
        self.assertEqual(op.call_count, 2)
        self.assertEqual([c.args[0] for c in close.call_args_list], [10, 11])

    def test_pointer_movement_is_reported_at_most_once_a_second(self):
        worker.running = True
        reads = [
            struct.pack("IIHHi", 0, 0, 2, 0, 8) + struct.pack("IIHHi", 0, 0, 2, 1, 4),
            struct.pack("IIHHi", 0, 0, 2, 0, 8),
            struct.pack("IIHHi", 0, 0, 2, 0, 8),
        ]
        times = [100, 100, 100.4, 101.2]
        calls = []

        def select(fds, *_):
            calls.append(1)
            if len(calls) > len(reads):
                worker.running = False
                return [], [], []
            return [10], [], []

        def now():
            return times[min(len(calls), len(times) - 1)]

        with patch.object(worker.os.path, "exists", side_effect=lambda p: p == "/dev/input/event0"), \
             patch.object(worker.os, "open", return_value=10), \
             patch.object(worker.os, "close"), \
             patch.object(worker.os, "read", side_effect=reads), \
             patch.object(worker.sys.stdin, "fileno", return_value=20), \
             patch.object(worker.sys, "stdout", new_callable=io.StringIO) as output, \
             patch.object(worker.select, "select", side_effect=select), \
             patch.object(worker.time, "time", side_effect=now):
            worker.main()
            self.assertEqual(output.getvalue(), "pointer\npointer\n",
                             "the first movement, then the next more than a second later")


if __name__ == "__main__":
    unittest.main()
