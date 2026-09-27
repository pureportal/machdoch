import unittest

from fizgig.minimax.sampling import sample_schedule


class MiniMaxH3SamplingTests(unittest.TestCase):
    def test_turbo_schedule_matches_eight_evaluation_shifted_grid(self):
        sigmas = sample_schedule(9, shift=6.0, mode="reference")

        self.assertEqual(len(sigmas), 9)
        for index, sigma in enumerate(sigmas):
            position = (8 - index) / 8
            self.assertAlmostEqual(sigma, 6 * position / (1 + 5 * position))


if __name__ == "__main__":
    unittest.main()
