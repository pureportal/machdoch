import unittest

import torch

from media_chunked_convolution import chunk_large_convolutions


class BandedConvolutionTests(unittest.TestCase):
    def test_bands_match_whole_convolutions_without_seams(self):
        torch.manual_seed(0)
        for convolution in (
            torch.nn.Conv2d(6, 8, 3, padding=1),
            torch.nn.Conv2d(6, 6, 5, padding=2, groups=3, bias=False),
            torch.nn.Conv2d(6, 4, (3, 5), padding=(0, 2)),
        ):
            with self.subTest(convolution=convolution):
                states = torch.randn(2, 6, 37, 23)
                expected = convolution(states)
                self.assertEqual(chunk_large_convolutions(convolution, budget=4096), 1)
                torch.testing.assert_close(convolution(states), expected)

    def test_strided_pointwise_and_small_inputs_keep_the_whole_convolution(self):
        model = torch.nn.Sequential(torch.nn.Conv2d(4, 4, 3, stride=2, padding=1), torch.nn.Conv2d(4, 4, 1),
                                    torch.nn.Conv2d(4, 4, 3, padding="same"))
        self.assertEqual(chunk_large_convolutions(model, budget=1), 0)
        small = torch.nn.Conv2d(4, 4, 3, padding=1)
        chunk_large_convolutions(small)
        states = torch.randn(1, 4, 8, 8)
        self.assertTrue(torch.equal(small(states), torch.nn.functional.conv2d(states, small.weight, small.bias, padding=1)))


if __name__ == "__main__":
    unittest.main()
