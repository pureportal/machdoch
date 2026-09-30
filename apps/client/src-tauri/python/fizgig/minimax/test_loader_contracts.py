import unittest

from fizgig.minimax.loader import (
    quantized_weight_scale_shapes,
    validate_dit_checkpoint_tensors,
)


class MiniMaxH3CheckpointContractTests(unittest.TestCase):
    def setUp(self):
        self.expected = {
            "blocks.0.attn.qkv_proj.weight": (24, 8),
            "rope.inv_freq": (16,),
        }

    def test_complete_compatible_checkpoint_is_accepted(self):
        validate_dit_checkpoint_tensors(self.expected, dict(self.expected))

    def test_missing_required_tensor_is_rejected(self):
        checkpoint = {"rope.inv_freq": (16,)}

        with self.assertRaisesRegex(ValueError, "missing.*qkv_proj.weight"):
            validate_dit_checkpoint_tensors(self.expected, checkpoint)

    def test_incompatible_required_tensor_shape_is_rejected(self):
        checkpoint = dict(self.expected)
        checkpoint["blocks.0.attn.qkv_proj.weight"] = (8, 24)

        with self.assertRaisesRegex(ValueError, "incompatible shape.*expected"):
            validate_dit_checkpoint_tensors(self.expected, checkpoint)

    def test_missing_quantized_weight_scale_is_rejected(self):
        expected = dict(self.expected)
        expected.update(quantized_weight_scale_shapes(
            expected,
            {"blocks.0.attn.qkv_proj": {"format": "int8_tensorwise"}},
        ))

        checkpoint = dict(self.expected)

        with self.assertRaisesRegex(ValueError, "missing.*weight_scale"):
            validate_dit_checkpoint_tensors(expected, checkpoint)

    def test_incompatible_quantized_weight_scale_shape_is_rejected(self):
        expected = dict(self.expected)
        expected.update(quantized_weight_scale_shapes(
            expected,
            {"blocks.0.attn.qkv_proj": {"format": "int8_tensorwise"}},
        ))
        checkpoint = dict(expected)
        checkpoint["blocks.0.attn.qkv_proj.weight_scale"] = (24,)

        with self.assertRaisesRegex(ValueError, "weight_scale.*incompatible shape"):
            validate_dit_checkpoint_tensors(expected, checkpoint)


if __name__ == "__main__":
    unittest.main()
