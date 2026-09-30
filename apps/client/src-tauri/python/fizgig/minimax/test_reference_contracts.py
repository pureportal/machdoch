import unittest

from fizgig.minimax.reference import reference_canvas


class ReferenceCanvasTests(unittest.TestCase):
    def test_already_aligned_references_remain_unchanged(self):
        for mode in ("match", "max"):
            with self.subTest(mode=mode):
                self.assertEqual(reference_canvas(64, 96, 64, 96, mode), (64, 96))

    def test_alignment_rounds_upward_boundaries_down_in_each_mode(self):
        cases = (
            ("match", 48, 96, 48, 96, (32, 96)),
            ("max", 2090, 2064, 4096, 4096, (2048, 2048)),
        )

        for mode, ref_width, ref_height, gen_width, gen_height, expected in cases:
            with self.subTest(mode=mode):
                target_width, target_height = reference_canvas(
                    ref_width, ref_height, gen_width, gen_height, mode
                )

                self.assertEqual((target_width, target_height), expected)
                self.assertLessEqual(target_width, ref_width)
                self.assertLessEqual(target_height, ref_height)

    def test_references_without_a_valid_down_only_canvas_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "at least 32px after scaling"):
            reference_canvas(16, 96, 16, 96)


if __name__ == "__main__":
    unittest.main()
