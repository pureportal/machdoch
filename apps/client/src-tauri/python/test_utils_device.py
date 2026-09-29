import os
import unittest
from unittest.mock import patch

from fizgig.utils import device


class SimulatedVramTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        os.environ.pop("FIZGIG_SIM_VRAM_GB", None)

        self.memory_info = patch.object(
            device.torch.cuda,
            "mem_get_info",
            return_value=(20_000_000_000, 24_000_000_000),
        )
        self.memory_info_mock = self.memory_info.start()
        self.addCleanup(self.memory_info.stop)

        self.cuda_available = patch.object(device.torch.cuda, "is_available", return_value=True)
        self.cuda_available_mock = self.cuda_available.start()
        self.addCleanup(self.cuda_available.stop)

        self.allocator_cap = patch.object(device.torch.cuda, "set_per_process_memory_fraction")
        self.allocator_cap_mock = self.allocator_cap.start()
        self.addCleanup(self.allocator_cap.stop)

    def test_valid_budget_controls_planning_and_allocator(self):
        os.environ["FIZGIG_SIM_VRAM_GB"] = "16"

        self.assertAlmostEqual(device.plannable_free_vram(), 11.92)
        device.apply_sim_vram_cap()

        self.allocator_cap_mock.assert_called_once()
        fraction, index = self.allocator_cap_mock.call_args.args
        self.assertAlmostEqual(fraction, 15.92 / 24)
        self.assertEqual(index, 0)

    def test_absent_budget_keeps_physical_free_memory_and_does_not_cap(self):
        self.assertEqual(device.plannable_free_vram(), 20.0)
        device.apply_sim_vram_cap()

        self.memory_info_mock.assert_called_once_with(0)
        self.cuda_available_mock.assert_not_called()
        self.allocator_cap_mock.assert_not_called()

    def test_invalid_budgets_do_not_change_planning_or_allocator(self):
        for value in ("0", "-1", "nan", "inf", "-inf", "1e309", "not-a-number"):
            with self.subTest(value=value):
                os.environ["FIZGIG_SIM_VRAM_GB"] = value
                self.memory_info_mock.reset_mock()
                self.allocator_cap_mock.reset_mock()

                self.assertEqual(device.plannable_free_vram(), 20.0)
                device.apply_sim_vram_cap()

                self.memory_info_mock.assert_called_once_with(0)
                self.allocator_cap_mock.assert_not_called()

    def test_budget_above_physical_total_retains_physical_limit(self):
        os.environ["FIZGIG_SIM_VRAM_GB"] = "32"

        self.assertEqual(device.plannable_free_vram(), 20.0)
        device.apply_sim_vram_cap()

        self.allocator_cap_mock.assert_called_once_with(1.0, 0)


if __name__ == "__main__":
    unittest.main()
