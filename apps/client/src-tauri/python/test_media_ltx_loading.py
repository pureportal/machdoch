from __future__ import annotations

import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import torch
from safetensors.torch import save_file

from media_ltx_loading import load_checkpoint_timesteps, load_checkpoint_vae


class LtxCheckpointVaeTests(unittest.TestCase):
    def test_uses_exact_trained_timesteps_and_rejects_invalid_schedules(self) -> None:
        trained = [1.0, 0.9937, 0.9875, 0.9812, 0.975, 0.9094, 0.725, 0.4219]
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "ltx.safetensors"
            save_file({"weight": torch.ones(1)}, str(checkpoint), metadata={
                "config": json.dumps({"allowed_inference_steps": trained}),
            })
            self.assertEqual(load_checkpoint_timesteps(checkpoint), [step * 1000 for step in trained])
            for schedule in [None, trained[:-1], trained[::-1], [*trained[:-1], 0.0]]:
                with self.subTest(schedule=schedule):
                    save_file({"weight": torch.ones(1)}, str(checkpoint), metadata={
                        "config": json.dumps({"allowed_inference_steps": schedule}),
                    })
                    with self.assertRaisesRegex(ValueError, "invalid distilled timesteps"):
                        load_checkpoint_timesteps(checkpoint)

    def test_loads_checkpoint_normalization_and_timestep_decoder_without_transformer(self) -> None:
        state = {
            "vae.encoder.conv_out.conv.weight": torch.zeros(1, 2048, 1, 1, 1),
            "vae.per_channel_statistics.mean-of-means": torch.arange(128).float(),
            "vae.per_channel_statistics.std-of-means": torch.arange(128).float() + 1,
            "vae.decoder.last_time_embedder.timestep_embedder.linear_1.weight": torch.ones(1, 1),
            "model.diffusion_model.proj_out.weight": torch.ones(1, 1),
        }
        vae = mock.Mock()
        factory = mock.Mock(return_value=vae)
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "ltx.safetensors"
            save_file(state, str(checkpoint), metadata={
                "config": json.dumps({"vae": {"timestep_conditioning": True}}),
            })
            actual = load_checkpoint_vae(SimpleNamespace(
                AutoencoderKLLTXVideo=SimpleNamespace(from_config=factory),
            ), checkpoint, torch.bfloat16)
        self.assertIs(actual, vae)
        config = factory.call_args.args[0]
        self.assertTrue(config["timestep_conditioning"])
        self.assertEqual(config["layers_per_block"], (4, 6, 6, 2, 2))
        loaded = vae.load_state_dict.call_args.args[0]
        self.assertNotIn("proj_out.weight", loaded)
        torch.testing.assert_close(loaded["latents_mean"], state["vae.per_channel_statistics.mean-of-means"])
        torch.testing.assert_close(loaded["latents_std"], state["vae.per_channel_statistics.std-of-means"])
        self.assertIn("decoder.time_embedder.timestep_embedder.linear_1.weight", loaded)
        self.assertEqual(vae.load_state_dict.call_args.kwargs, {"strict": True, "assign": True})
        vae.to.assert_called_once_with(dtype=torch.bfloat16)

    def test_rejects_checkpoint_without_timestep_conditioning(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "old.safetensors"
            save_file({"vae.weight": torch.ones(1)}, str(checkpoint), metadata={
                "config": json.dumps({"vae": {"timestep_conditioning": False}}),
            })
            with self.assertRaisesRegex(ValueError, "timestep-conditioned"):
                load_checkpoint_vae(SimpleNamespace(), checkpoint, torch.bfloat16)


if __name__ == "__main__":
    unittest.main()
