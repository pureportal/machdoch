import unittest

from fizgig.minimax.reference import reference_canvas


class ReferenceCanvasTests(unittest.TestCase):
    def test_already_aligned_references_remain_unchanged(self):
        self.assertEqual(reference_canvas(64, 96, 64, 96), (64, 96))

    def test_canvas_matches_generation_area_and_rounds_down(self):
        self.assertEqual(reference_canvas(48, 96, 48, 96), (32, 96))
        self.assertEqual(reference_canvas(2048, 2048, 512, 512), (512, 512))

    def test_small_references_are_never_upscaled(self):
        self.assertEqual(reference_canvas(64, 64, 1024, 1024), (64, 64))

    def test_references_without_a_valid_down_only_canvas_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "at least 32px after scaling"):
            reference_canvas(16, 96, 16, 96)


if __name__ == "__main__":
    unittest.main()
