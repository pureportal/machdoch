import unittest

import torch

from fizgig.minimax.sampling import _er_sde_update, sample_schedule


class MiniMaxH3SamplingTests(unittest.TestCase):
    def test_beta57_has_ten_descending_evaluations(self):
        sigmas = sample_schedule(11, shift=6.0, mode="beta57")

        self.assertEqual(len(sigmas), 11)
        self.assertEqual(sigmas[0], 1.0)
        self.assertEqual(sigmas[-1], 0.0)
        self.assertTrue(all(current > following for current, following in zip(sigmas, sigmas[1:])))
        self.assertAlmostEqual(sigmas[5], 0.772954, places=6)

    def test_er_sde_keeps_joint_streams_finite_and_reaches_terminal_denoised_state(self):
        sigmas = sample_schedule(11, shift=6.0, mode="beta57")
        position = 1.0 - 1e-4
        sigmas[0] = 6.0 * position / (1.0 + 5.0 * position)
        generator = torch.Generator(device="cpu").manual_seed(57)
        video = torch.randn((1, 24), generator=generator)
        audio = torch.randn((1, 16), generator=generator)
        previous_video = previous_audio = None
        video_derivative = audio_derivative = None

        for index, (sigma, next_sigma) in enumerate(zip(sigmas, sigmas[1:])):
            video_denoised = torch.full_like(video, 0.25)
            audio_denoised = torch.full_like(audio, -0.5)
            previous_sigma = sigmas[index - 1] if index else None
            second_previous_sigma = sigmas[index - 2] if index > 1 else None
            video, video_derivative = _er_sde_update(
                video, video_denoised, previous_video, video_derivative,
                sigma, next_sigma, previous_sigma, second_previous_sigma, generator,
            )
            audio, audio_derivative = _er_sde_update(
                audio, audio_denoised, previous_audio, audio_derivative,
                sigma, next_sigma, previous_sigma, second_previous_sigma, generator,
            )
            self.assertTrue(torch.isfinite(video).all())
            self.assertTrue(torch.isfinite(audio).all())
            previous_video = video_denoised
            previous_audio = audio_denoised

        torch.testing.assert_close(video, torch.full_like(video, 0.25))
        torch.testing.assert_close(audio, torch.full_like(audio, -0.5))


if __name__ == "__main__":
    unittest.main()
