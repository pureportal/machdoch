from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import imageio_ffmpeg
import numpy as np
import torch

from media_h3_geometry import H3Geometry, latent_shape
from media_h3_sampling import decode
import media_diffusers_worker as worker
import media_h3_distillation as student_runtime
import media_open_models as models
import media_open_video as video


class StudentOutputTests(unittest.TestCase):
    def test_decoding_preserves_stereo_and_denormalizes_rgb_and_latents(self):
        class VideoVae(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.weight = torch.nn.Parameter(torch.zeros(1))
                self.config = SimpleNamespace(latents_mean=[2] * 24, latents_std=[3] * 24)

            def decode(self, latents):
                self.latents = latents
                return SimpleNamespace(sample=torch.zeros(1, 3, 5, 32, 32))

        class AudioVae(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.weight = torch.nn.Parameter(torch.zeros(1))
                self.config = SimpleNamespace(latents_mean=[1] * 32, latents_std=[2] * 32)

            def decode(self, latents):
                self.latents = latents
                return SimpleNamespace(sample=latents.mean(dim=(1, 2))[:, None, None].expand(2, 1, 1000))

        geometry = H3Geometry((1, 2, 2), 24, 32, 16)
        shape = latent_shape(32, 32, 5, geometry)
        vae, audio_vae = VideoVae(), AudioVae()
        audio = torch.cat((torch.full((1, shape["audio_latents"], 32), -1.0), torch.zeros(1, shape["audio_latents"], 32)), dim=1)
        frames, waveform, rate = decode(vae, audio_vae, torch.ones(shape["video_tokens"]), audio, shape, geometry, "cpu")
        self.assertTrue(torch.equal(vae.latents, torch.full((1, 24, 2, 2, 2), 5.0)))
        self.assertTrue(torch.equal(audio_vae.latents[0], torch.full((32, shape["audio_latents"]), -1.0)))
        self.assertTrue(torch.equal(audio_vae.latents[1], torch.ones(32, shape["audio_latents"])))
        self.assertEqual(frames.shape, (5, 32, 32, 3))
        self.assertEqual(frames.dtype, np.uint8)
        self.assertEqual(frames[0, 0, 0].tolist(), [124, 116, 104])
        self.assertEqual(tuple(waveform.shape), (1, 2, 1000))
        self.assertTrue((waveform[0, 0] == -1).all() and (waveform[0, 1] == 1).all())
        self.assertEqual(rate, 32000)

    def test_non_finite_decoder_outputs_fail_before_publication(self):
        geometry = H3Geometry((1, 2, 2), 24, 32, 16)
        shape = latent_shape(32, 32, 5, geometry)
        for invalid_modality in ("pixels", "audio"):
            with self.subTest(modality=invalid_modality):
                def vae(channels, sample):
                    return SimpleNamespace(config=SimpleNamespace(latents_mean=[0] * channels, latents_std=[1] * channels),
                        parameters=lambda: iter([torch.zeros(1)]), decode=lambda _: SimpleNamespace(sample=sample))
                pixels = torch.zeros(1, 3, 5, 32, 32)
                audio = torch.zeros(2, 1, 1000)
                (pixels if invalid_modality == "pixels" else audio).fill_(float("nan"))
                with self.assertRaisesRegex(ValueError, f"non-finite {invalid_modality}"):
                    decode(vae(24, pixels), vae(32, audio), torch.zeros(shape["video_tokens"]),
                        torch.zeros(shape["audio_tokens"]), shape, geometry, "cpu")

    def test_student_dispatch_encodes_and_verifies_real_video_and_audio_tracks(self):
        profile = models.PROFILES["minimax-h3-pdmd-2step"]
        with tempfile.TemporaryDirectory() as directory:
            request = dict(schemaVersion=1, model=dict(architecture=profile["architecture"], revision="synthetic", digest="synthetic"),
                prompt="A bird flies", numFrames=124, numInferenceSteps=2, guidanceScale=1, fps=24, seed=42,
                loopMode="none", aspectRatio="1:1", resolution="preview-512", width=128, height=128,
                outputDirectory=directory, matteQuality="production", encodingQuality="draft")
            time = torch.arange(round(124 / 24 * 32000)) / 32000
            waveform = torch.stack((torch.sin(time * 2 * torch.pi * 440), torch.sin(time * 2 * torch.pi * 660))).unsqueeze(0) * 0.1
            frames = np.full((124, 128, 128, 3), 96, dtype=np.uint8)
            runtime = SimpleNamespace(SCHEMA_VERSION=1, WORKER_VERSION="test", WorkerError=ValueError,
                _required_text=lambda data, key, maximum: data[key], _video_dimensions=worker._video_dimensions,
                _runtime=lambda: (torch, SimpleNamespace()), _device=lambda _: ("cpu", "Synthetic CPU", None),
                _configure_video_conv3d_backend=lambda *_: "cpu", _start_video_memory_observation=lambda *_: None,
                _fresh_output_directory=lambda path: Path(path), _progress=mock.Mock(),
                _encode_video_webm=worker._encode_video_webm,
                _finish_video_memory_observation=lambda *_: None, _package_versions=lambda: {})
            with mock.patch.object(student_runtime, "render", return_value=(frames, waveform, 32000, [])) as render:
                result = video.generate(request, runtime)
            self.assertEqual(render.call_args.args[1]["id"], profile["id"])
            self.assertEqual(result["numInferenceSteps"], 2)
            self.assertEqual(result["conditioningMode"], "native-text-to-video")
            self.assertEqual(result["addons"], [])
            destination = Path(directory, result["output"]["fileName"])
            decoded = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", str(destination),
                "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], capture_output=True,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            self.assertEqual(decoded.returncode, 0, decoded.stderr)
            self.assertFalse(destination.with_suffix(".wav").exists())
            for field, value, message in [("negativePrompt", "blur", "negative prompt"), ("addons", [{"addonId": "unrelated"}], "LoRAs")]:
                with mock.patch.object(student_runtime, "render") as rejected_render:
                    with self.assertRaisesRegex(ValueError, message):
                        video.generate({**request, field: value}, runtime)
                    rejected_render.assert_not_called()


if __name__ == "__main__":
    unittest.main()
