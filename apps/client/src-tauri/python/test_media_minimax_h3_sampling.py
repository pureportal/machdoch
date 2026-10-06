import unittest

import torch

from fizgig.minimax.model import ForwardAborted, MiniMaxH3Config, MiniMaxH3DiT
from fizgig.minimax.sampling import PreviewAborted, sample_image, sample_schedule


class MiniMaxH3SamplingTests(unittest.TestCase):
    def test_turbo_schedule_matches_eight_evaluation_shifted_grid(self):
        sigmas = sample_schedule(9, shift=6.0, mode="reference")

        self.assertEqual(len(sigmas), 9)
        for index, sigma in enumerate(sigmas):
            position = (8 - index) / 8
            self.assertAlmostEqual(sigma, 6 * position / (1 + 5 * position))


class MiniMaxH3SamplingCallbackTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(11)
        self.model = MiniMaxH3DiT(MiniMaxH3Config(
            hidden_size=48, num_layers=1, token_refiner_num_layers=1,
            num_attention_heads=3, attention_head_dim=16, ffn_hidden_size=64,
            text_dim=24, timestep_input_dim=16, time_embed_hidden_size=32,
            time_embed_dim=24, rope_inv_freq_len=2,
        )).eval()
        self.model.pack_audio_rows = True
        self.forward_calls = []
        self.model.register_forward_pre_hook(lambda module, args: self.forward_calls.append(1))
        self.references = [torch.randn(1, 24, 2, 4, 4), torch.randn(1, 32, 2, 5)]
        self.original_references = [reference.clone() for reference in self.references]
        self.text = torch.randn(1, 3, 24)

    def sample(self, **callbacks):
        return sample_image(
            self.model, self.text, width=64, height=64, num_frames=22,
            steps=4, shift=6.0, schedule_mode="reference", sampler="euler",
            device="cpu", dtype=torch.float32, ref_latents=self.references,
            return_audio=True, **callbacks,
        )

    def tearDown(self):
        for actual, original in zip(self.references, self.original_references):
            torch.testing.assert_close(actual, original, rtol=0, atol=0)

    def test_progress_transport_failure_stops_before_another_forward(self):
        failure = BrokenPipeError("Progress transport closed")

        def progress(step, total, latent):
            raise failure

        with self.assertRaises(BrokenPipeError) as caught:
            self.sample(on_denoised=progress)
        self.assertIs(caught.exception, failure)
        self.assertEqual(len(self.forward_calls), 1)

    def test_progress_cancellation_stops_before_another_forward(self):
        def progress(step, total, latent):
            raise PreviewAborted("Generation cancelled")

        with self.assertRaisesRegex(PreviewAborted, "Generation cancelled"):
            self.sample(on_denoised=progress)
        self.assertEqual(len(self.forward_calls), 1)

    def test_cancel_poll_failure_stops_before_another_forward(self):
        failure = OSError("Cancellation channel closed")

        def cancel(elapsed, step, total):
            raise failure

        with self.assertRaises(OSError) as caught:
            self.sample(on_slow_step=cancel, slow_step_s=-1)
        self.assertIs(caught.exception, failure)
        self.assertEqual(len(self.forward_calls), 1)

    def test_cancel_poll_exception_uses_the_normal_abort_contract(self):
        def cancel(elapsed, step, total):
            raise ForwardAborted("Cancelled between steps")

        with self.assertRaises(PreviewAborted) as caught:
            self.sample(on_slow_step=cancel, slow_step_s=-1)
        self.assertIsInstance(caught.exception.__cause__, ForwardAborted)
        self.assertEqual(len(self.forward_calls), 1)

    def test_cancel_poll_return_value_still_stops_sampling(self):
        with self.assertRaises(PreviewAborted):
            self.sample(on_slow_step=lambda elapsed, step, total: True, slow_step_s=-1)
        self.assertEqual(len(self.forward_calls), 1)

    def test_successful_callbacks_preserve_joint_outputs_and_step_numbers(self):
        progress, polls = [], []
        video, audio = self.sample(
            on_denoised=lambda step, total, latent: progress.append((step, total)),
            on_slow_step=lambda elapsed, step, total: polls.append((step, total)),
            slow_step_s=-1,
        )
        self.assertEqual(progress, [(1, 3), (2, 3), (3, 3)])
        self.assertEqual(polls, progress)
        self.assertEqual(len(self.forward_calls), 3)
        self.assertEqual(tuple(video.shape), (1, 24, 7, 4, 4))
        self.assertEqual(audio.shape[-1], 32)
        self.assertTrue(torch.isfinite(video).all())
        self.assertTrue(torch.isfinite(audio).all())
        expected_video, expected_audio = self.sample()
        torch.testing.assert_close(video, expected_video, rtol=0, atol=0)
        torch.testing.assert_close(audio, expected_audio, rtol=0, atol=0)


if __name__ == "__main__":
    unittest.main()
