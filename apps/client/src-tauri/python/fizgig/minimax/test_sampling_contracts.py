import unittest

from fizgig.minimax.sampling import sampling_geometry


class MiniMaxH3SamplingGeometryTests(unittest.TestCase):
    def test_aligned_dimensions_preserve_requested_geometry(self):
        latent_height, latent_width = sampling_geometry(width=768, height=512)

        self.assertEqual((latent_height, latent_width), (32, 48))
        self.assertEqual((latent_height * 16, latent_width * 16), (512, 768))

    def test_misaligned_dimensions_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "multiples of 32px.*width=513"):
            sampling_geometry(width=513, height=512)

    def test_undersized_dimensions_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "at least 32px.*zero-sized latent grid"):
            sampling_geometry(width=16, height=512)


if __name__ == "__main__":
    unittest.main()
