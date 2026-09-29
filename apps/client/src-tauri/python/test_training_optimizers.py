import unittest
from unittest.mock import patch

import torch

from fizgig.training.optimizers import available_optimizers, create_optimizer


class OptimizerSelectionTests(unittest.TestCase):
    def test_catalog_excludes_unavailable_automagic3(self):
        self.assertNotIn("automagic3", available_optimizers())
        self.assertIn("adamw", available_optimizers())

    def test_explicit_automagic3_request_fails_before_construction(self):
        parameter = torch.nn.Parameter(torch.ones(1))
        with patch("fizgig.training.optimizers.torch.optim.AdamW") as adamw:
            for name in ("automagic3", "Automagic3"):
                with self.subTest(name=name), self.assertRaisesRegex(
                    ValueError, "unknown optimizer.*[Aa]utomagic3"
                ):
                    create_optimizer(name, [parameter], 1e-4)
        adamw.assert_not_called()

    def test_adamw_selection_keeps_requested_rate_and_args(self):
        parameter = torch.nn.Parameter(torch.ones(1))
        with patch("fizgig.training.optimizers.torch.cuda.is_available", return_value=False):
            optimizer, label = create_optimizer(
                "adamw", [parameter], 2e-4, "weight_decay=0.05", eps_floor_8bit=True
            )
        self.assertIsInstance(optimizer, torch.optim.AdamW)
        self.assertEqual(label, "adamw(weight_decay=0.05)")
        self.assertEqual(optimizer.param_groups[0]["lr"], 2e-4)
        self.assertEqual(optimizer.param_groups[0]["weight_decay"], 0.05)
        self.assertEqual(optimizer.param_groups[0]["eps"], 1e-8)

    def test_8bit_selection_keeps_eps_floor_and_fallback(self):
        parameter = torch.nn.Parameter(torch.ones(1))
        with patch("fizgig.training.optimizers._bnb") as bnb:
            optimizer, label = create_optimizer(
                "adamw8bit", [parameter], 1e-4, eps_floor_8bit=True
            )
        self.assertIs(optimizer, bnb.return_value.return_value)
        self.assertEqual(label, "adamw8bit")
        bnb.assert_called_once_with("AdamW8bit")
        self.assertEqual(bnb.return_value.call_args.kwargs, {"lr": 1e-4, "eps": 1e-6})

        with patch("fizgig.training.optimizers._bnb", side_effect=ImportError("missing")):
            optimizer, label = create_optimizer("adamw8bit", [parameter], 1e-4)
        self.assertIsInstance(optimizer, torch.optim.AdamW)
        self.assertEqual(label, "adamw (fallback)")


if __name__ == "__main__":
    unittest.main()
