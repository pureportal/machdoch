import unittest
from unittest.mock import patch

import torch

from fizgig.training.ema import EMAWeights


class EMAWeightSwapTests(unittest.TestCase):
    def setUp(self):
        self.network = torch.nn.ParameterList([
            torch.nn.Parameter(torch.tensor([1.0])),
            torch.nn.Parameter(torch.tensor([2.0])),
        ])
        self.ema = EMAWeights(self.network, decay=0.9)
        self.ema.shadow = [torch.tensor([11.0]), torch.tensor([22.0])]

    def test_failed_copy_restores_all_weights_and_clears_backup(self):
        original_copy = torch.Tensor.copy_
        copy_count = 0

        def fail_after_copy(tensor, source, *args, **kwargs):
            nonlocal copy_count
            copy_count += 1
            result = original_copy(tensor, source, *args, **kwargs)
            if copy_count == 2:
                raise RuntimeError("injected copy failure")
            return result

        with patch.object(torch.Tensor, "copy_", fail_after_copy):
            with self.assertRaisesRegex(RuntimeError, "injected copy failure"):
                self.ema.swap_in()

        self.assertEqual(copy_count, 4)
        self.assertEqual([p.item() for p in self.network], [1.0, 2.0])
        self.assertIsNone(self.ema._backup)

    def test_successful_swap_cycle_restores_raw_weights(self):
        self.ema.swap_in()
        self.assertEqual([p.item() for p in self.network], [11.0, 22.0])

        self.ema.swap_out()
        self.assertEqual([p.item() for p in self.network], [1.0, 2.0])
        self.assertIsNone(self.ema._backup)


class EMAResumeStateTests(unittest.TestCase):
    def setUp(self):
        network = torch.nn.ParameterList([
            torch.nn.Parameter(torch.tensor([1.0])),
            torch.nn.Parameter(torch.tensor([2.0, 3.0])),
        ])
        self.ema = EMAWeights(network, decay=0.9)
        self.ema.n = 5
        self.ema.shadow = [torch.tensor([11.0]), torch.tensor([22.0, 33.0])]
        self.original_shadow = tuple(self.ema.shadow)

    def assert_original_state(self):
        self.assertEqual(self.ema.n, 5)
        self.assertEqual([tensor.tolist() for tensor in self.ema.shadow],
                         [[11.0], [22.0, 33.0]])
        for current, original in zip(self.ema.shadow, self.original_shadow):
            self.assertIs(current, original)

    def test_valid_state_restores_count_and_all_shadow_tensors(self):
        self.ema.load_state_dict({
            "n": 12,
            "shadow": [torch.tensor([44.0]), torch.tensor([55.0, 66.0])],
        })

        self.assertEqual(self.ema.n, 12)
        self.assertEqual([tensor.tolist() for tensor in self.ema.shadow],
                         [[44.0], [55.0, 66.0]])

    def test_wrong_tensor_count_preserves_state(self):
        with self.assertRaisesRegex(ValueError, "EMA state has 1 tensors, network has 2"):
            self.ema.load_state_dict({"n": 12, "shadow": [torch.tensor([44.0])]})

        self.assert_original_state()

    def test_wrong_tensor_shape_preserves_state(self):
        with self.assertRaisesRegex(ValueError, "EMA state tensor 1 has shape \\(1, 2\\), expected \\(2,\\)"):
            self.ema.load_state_dict({
                "n": 12,
                "shadow": [torch.tensor([44.0]), torch.tensor([[55.0, 66.0]])],
            })

        self.assert_original_state()

    def test_non_tensor_shadow_preserves_state(self):
        with self.assertRaisesRegex(TypeError, "EMA state tensor 1 is not a tensor"):
            self.ema.load_state_dict({
                "n": 12,
                "shadow": [torch.tensor([44.0]), [55.0, 66.0]],
            })

        self.assert_original_state()


if __name__ == "__main__":
    unittest.main()
