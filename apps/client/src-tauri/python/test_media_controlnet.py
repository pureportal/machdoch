import unittest
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from media_controlnet import canny_image
from media_workflow_worker import composite_masks, image_mask


class ControlImageTests(unittest.TestCase):
    def test_canny_retains_canvas_and_localizes_edges(self):
        source = Image.new("RGB", (96, 64), "black")
        ImageDraw.Draw(source).rectangle((24, 16, 71, 47), fill="white")
        edges = np.asarray(canny_image(source, 100, 200))
        self.assertEqual(edges.shape, (64, 96, 3))
        self.assertGreater(np.count_nonzero(edges[:, :, 0]), 100)
        self.assertFalse(edges[22:42, 30:65].any())
        self.assertFalse(edges[:10].any())
        np.testing.assert_array_equal(edges[:, :, 0], edges[:, :, 2])
        np.testing.assert_array_equal(np.asarray(source)[32, 48], [255, 255, 255])

    def test_canny_rejects_reversed_or_noninteger_thresholds(self):
        for low, high in [
            (200, 100),
            (100, 100),
            (-1, 200),
            (100, 256),
            (True, 200),
            (0.5, 200),
        ]:
            with self.subTest(low=low, high=high), self.assertRaises(ValueError):
                canny_image(Image.new("RGB", (32, 32)), low, high)

    def test_soft_masks_preserve_partial_selection_and_saturate(self):
        first = Image.fromarray(np.array([[0, 128, 255]], dtype=np.uint8))
        second = Image.fromarray(np.array([[255, 128, 128]], dtype=np.uint8))
        for operation, expected in [
            ("add", [255, 255, 255]),
            ("subtract", [0, 0, 127]),
            ("multiply", [0, 64, 128]),
        ]:
            with self.subTest(operation=operation):
                np.testing.assert_array_equal(
                    np.asarray(composite_masks(first, second, operation)), [expected]
                )
        with self.assertRaisesRegex(ValueError, "matching dimensions"):
            composite_masks(first, Image.new("L", (2, 2)), "add")

    def test_alpha_and_color_channel_masks_can_be_inverted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source.png"
            Image.fromarray(
                np.array([[[10, 20, 30, 64], [100, 110, 120, 255]]], dtype=np.uint8)
            ).save(path)
            request = {
                "imagePath": str(path),
                "outputDirectory": directory,
                "channel": "alpha",
                "invert": True,
            }
            image_mask(request)
            with Image.open(Path(directory) / "output.png") as result:
                np.testing.assert_array_equal(np.asarray(result), [[191, 0]])
            image_mask({**request, "channel": "green", "invert": False})
            with Image.open(Path(directory) / "output.png") as result:
                np.testing.assert_array_equal(np.asarray(result), [[20, 110]])


if __name__ == "__main__":
    unittest.main()
