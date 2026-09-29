import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fizgig.utils.capabilities import (
    _available_ram_gb,
    wait_for_gpu_handoff,
    wait_for_ram_recovery,
)


class AvailableRamTests(unittest.TestCase):
    def test_reports_available_and_total_ram(self):
        psutil = SimpleNamespace(virtual_memory=lambda: SimpleNamespace(
            available=24_000_000_000, total=64_000_000_000
        ))
        with patch.dict(sys.modules, {"psutil": psutil}):
            self.assertEqual(_available_ram_gb(), (24.0, 64.0))

    def test_unavailable_ram_measurement_is_unknown(self):
        psutil = SimpleNamespace(virtual_memory=Mock(side_effect=OSError("unavailable")))
        with patch.dict(sys.modules, {"psutil": psutil}):
            self.assertEqual(_available_ram_gb(), (None, None))


class HandoffTests(unittest.TestCase):
    @patch("fizgig.utils.capabilities.time.sleep")
    @patch("fizgig.utils.capabilities._available_gpu_memory_gb")
    def test_gpu_handoff_completes_after_recovery(self, measure, sleep):
        measure.side_effect = [(4.0, 24.0), (20.0, 24.0)]

        wait_for_gpu_handoff(timeout_seconds=10)

        self.assertEqual(measure.call_count, 2)
        sleep.assert_called_once()

    @patch("fizgig.utils.capabilities.time.sleep")
    @patch("fizgig.utils.capabilities._available_ram_gb")
    def test_ram_recovery_completes_after_recovery(self, measure, sleep):
        measure.side_effect = [(4.0, 64.0), (32.0, 64.0)]

        wait_for_ram_recovery(timeout_seconds=10)

        self.assertEqual(measure.call_count, 2)
        sleep.assert_called_once()

    @patch("fizgig.utils.capabilities.time.sleep")
    @patch("fizgig.utils.capabilities._available_gpu_memory_gb", return_value=None)
    def test_unavailable_gpu_measurement_does_not_wait(self, measure, sleep):
        wait_for_gpu_handoff(timeout_seconds=0)

        measure.assert_called_once()
        sleep.assert_not_called()

    @patch("fizgig.utils.capabilities.time.sleep")
    @patch("fizgig.utils.capabilities._available_ram_gb", return_value=(None, None))
    def test_unavailable_ram_measurement_does_not_wait(self, measure, sleep):
        wait_for_ram_recovery(timeout_seconds=0)

        measure.assert_called_once()
        sleep.assert_not_called()

    @patch("fizgig.utils.capabilities.time.sleep")
    @patch("fizgig.utils.capabilities._available_gpu_memory_gb", return_value=(1.0, 24.0))
    def test_gpu_handoff_times_out(self, measure, sleep):
        with self.assertRaisesRegex(TimeoutError, "GPU capacity did not recover"):
            wait_for_gpu_handoff(timeout_seconds=0)

        measure.assert_called_once()
        sleep.assert_not_called()

    @patch("fizgig.utils.capabilities.time.sleep")
    @patch("fizgig.utils.capabilities._available_ram_gb", return_value=(1.0, 64.0))
    def test_ram_recovery_times_out(self, measure, sleep):
        with self.assertRaisesRegex(TimeoutError, "RAM capacity did not recover"):
            wait_for_ram_recovery(timeout_seconds=0)

        measure.assert_called_once()
        sleep.assert_not_called()

    @patch("fizgig.utils.capabilities.subprocess.run")
    def test_gpu_measurement_uses_driver_without_cuda(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "20480, 24576\n", "")

        wait_for_gpu_handoff(timeout_seconds=0)

        self.assertEqual(run.call_args.args[0][0], "nvidia-smi")

    @patch("fizgig.utils.capabilities.subprocess.run", side_effect=FileNotFoundError)
    def test_missing_gpu_tool_does_not_block_startup(self, run):
        wait_for_gpu_handoff(timeout_seconds=0)

        run.assert_called_once()


if __name__ == "__main__":
    unittest.main()
