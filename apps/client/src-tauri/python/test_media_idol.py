import struct
import tempfile
from pathlib import Path
import unittest

import torch

from idol.conditioning import dinov3_state_dict
from idol.gaussian import PLY_PROPERTIES, Gaussian
from media_idol import require_visible_object, validate_request
from media_splat_render import framing, orbit_camera, render


def gaussian(count: int, opacity: float = 0.9) -> Gaussian:
    splat = Gaussian.__new__(Gaussian)
    generator = torch.Generator().manual_seed(3)
    splat.xyz = (torch.rand(count, 3, generator=generator) - 0.5) * 0.6
    splat.features_dc = torch.rand(count, 1, 3, generator=generator)
    splat.scaling = torch.full((count, 3), 0.02)
    splat.rotation = torch.tensor([[1.0, 0.0, 0.0, 0.0]]).repeat(count, 1)
    splat.opacity = torch.full((count, 1), opacity)
    return splat


class IdolTests(unittest.TestCase):
    def request(self):
        return {
            "schemaVersion": 5, "model": {"architecture": "idol", "packageKind": "idol-directory"},
            "inputKind": "synthetic", "seed": 42, "numInferenceSteps": 50, "guidanceScale": 3.0,
            "timeShift": 3.0, "gaussianCount": 262_144, "minOpacity": 0.0,
        }

    def test_invalid_requests_are_rejected_before_loading(self):
        self.assertEqual(validate_request(self.request(), 5)["gaussianCount"], 262_144)
        for key, values in {
            "schemaVersion": [4, None], "inputKind": ["photo", None],
            "gaussianCount": [32_767, 1_048_577, 262_145, True], "numInferenceSteps": [3, 101, 1.5],
            "guidanceScale": [-0.1, 10.1, float("nan")], "timeShift": [0.9, 6.1], "minOpacity": [-0.1, 0.6],
            "seed": [-1, 9_007_199_254_740_992, True],
            "model": [{"architecture": "intro-svg", "packageKind": "idol-directory"}, None],
        }.items():
            for value in values:
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    validate_request({**self.request(), key: value}, 5)

    def test_ply_is_binary_3dgs_with_y_down_positions(self):
        splat = gaussian(4)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "object.ply"
            splat.save_ply(path)
            data = path.read_bytes()
        header, body = data.split(b"end_header\n", 1)
        lines = header.decode("ascii").splitlines()
        self.assertEqual(lines[:3], ["ply", "format binary_little_endian 1.0", "element vertex 4"])
        self.assertEqual(lines[3:], [f"property float {name}" for name in PLY_PROPERTIES])
        self.assertEqual(len(body), 4 * 17 * 4)
        first = struct.unpack("<17f", body[:68])
        x, y, z = splat.xyz[0].tolist()
        self.assertAlmostEqual(first[0], x, places=6)
        self.assertAlmostEqual(first[1], -z, places=6)
        self.assertAlmostEqual(first[2], y, places=6)

    def test_cleanup_keeps_only_visible_gaussians(self):
        splat = gaussian(6)
        splat.opacity[:3] = 0.01
        kept = splat.keep(splat.opacity[:, 0] >= 0.05)
        self.assertEqual(len(kept), 3)
        self.assertTrue(torch.equal(kept.xyz, splat.xyz[3:]))

    def test_empty_objects_are_rejected(self):
        require_visible_object(gaussian(64))
        with self.assertRaisesRegex(ValueError, "empty object"):
            require_visible_object(gaussian(64, opacity=0.003))

    def test_preview_render_covers_the_object(self):
        splat = gaussian(4096)
        center, radius = framing(splat, torch)
        image = render(splat, torch, orbit_camera(0.6, 0.3, 30.0, center, radius), 96)
        self.assertEqual(image.shape, (96, 96, 4))
        coverage = (image[..., 3] > 0).mean()
        self.assertGreater(coverage, 0.15)
        self.assertLess(coverage, 0.95)
        self.assertEqual(image[0, 0, 3], 0)

    def test_dinov3_checkpoint_is_renamed_and_qkv_is_split(self):
        hidden, layers = 8, 2
        weights = {
            "cls_token": torch.randn(1, 1, hidden), "reg_token": torch.randn(1, 4, hidden),
            "patch_embed.proj.weight": torch.randn(hidden, 3, 2, 2), "patch_embed.proj.bias": torch.randn(hidden),
            "norm.weight": torch.randn(hidden), "norm.bias": torch.randn(hidden),
        }
        for layer in range(layers):
            prefix = f"blocks.{layer}."
            for name, shape in {
                "norm1.weight": (hidden,), "norm1.bias": (hidden,), "norm2.weight": (hidden,), "norm2.bias": (hidden,),
                "attn.qkv.weight": (3 * hidden, hidden), "attn.proj.weight": (hidden, hidden), "attn.proj.bias": (hidden,),
                "gamma_1": (hidden,), "gamma_2": (hidden,), "mlp.fc1_g.weight": (4 * hidden, hidden),
                "mlp.fc1_g.bias": (4 * hidden,), "mlp.fc1_x.weight": (4 * hidden, hidden), "mlp.fc1_x.bias": (4 * hidden,),
                "mlp.fc2.weight": (hidden, 4 * hidden), "mlp.fc2.bias": (hidden,),
            }.items():
                weights[prefix + name] = torch.randn(*shape)
        converted = dinov3_state_dict(weights, layers)
        qkv = weights["blocks.1.attn.qkv.weight"]
        self.assertTrue(torch.equal(converted["model.layer.1.attention.q_proj.weight"], qkv[:hidden]))
        self.assertTrue(torch.equal(converted["model.layer.1.attention.k_proj.weight"], qkv[hidden:2 * hidden]))
        self.assertTrue(torch.equal(converted["model.layer.1.attention.v_proj.weight"], qkv[2 * hidden:]))
        self.assertTrue(torch.equal(converted["model.layer.0.mlp.gate_proj.weight"], weights["blocks.0.mlp.fc1_g.weight"]))
        self.assertTrue(torch.equal(converted["model.layer.0.layer_scale2.lambda1"], weights["blocks.0.gamma_2"]))
        self.assertFalse(converted["model.layer.0.attention.q_proj.bias"].any())
        self.assertEqual(len(converted), 7 + 19 * layers)
        with self.assertRaises(ValueError):
            dinov3_state_dict({key: value for key, value in weights.items() if key != "norm.bias"}, layers)


if __name__ == "__main__":
    unittest.main()
