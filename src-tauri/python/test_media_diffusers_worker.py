from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np
from PIL import Image


WORKER_PATH = Path(__file__).with_name("media_diffusers_worker.py")
SPEC = importlib.util.spec_from_file_location("media_diffusers_worker", WORKER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Unable to load media_diffusers_worker.py")
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


class MediaDiffusersQualityTests(unittest.TestCase):
    def test_large_image_decode_enables_native_overlapping_vae_tiles(self) -> None:
        class FakeVae:
            def __init__(self) -> None:
                self.enabled = False

            def enable_tiling(self) -> None:
                self.enabled = True

        small = SimpleNamespace(vae=FakeVae())
        large = SimpleNamespace(vae=FakeVae())
        small_evidence = WORKER._configure_large_image_vae_decode(
            small,
            "stable-diffusion-xl",
            SimpleNamespace(version=SimpleNamespace(hip=None)),
            1_024,
            1_024,
        )
        large_evidence = WORKER._configure_large_image_vae_decode(
            large,
            "stable-diffusion-xl",
            SimpleNamespace(version=SimpleNamespace(hip=None)),
            1_408,
            768,
        )
        self.assertFalse(small.vae.enabled)
        self.assertEqual(small_evidence["mode"], "native-full-frame")
        self.assertTrue(large.vae.enabled)
        self.assertEqual(large_evidence["mode"], "native-overlap-tiled")
        self.assertEqual(large_evidence["device"], "pipeline")

    def test_flux2_klein_uses_its_distilled_four_step_trajectory(self) -> None:
        self.assertEqual(WORKER._steps("flux-2", "fast"), 4)
        self.assertEqual(WORKER._steps("flux-2", "balanced"), 4)
        self.assertEqual(WORKER._steps("flux-2", "quality"), 4)

    def test_krea_reference_quality_uses_the_verified_attention_bound(self) -> None:
        self.assertEqual(WORKER._dimensions("krea-2", "16:9", "fast"), (704, 384))
        self.assertEqual(
            WORKER._dimensions("krea-2", "16:9", "quality"),
            (1_056, 576),
        )
        self.assertEqual(
            WORKER._dimensions("flux-2", "16:9", "quality"),
            (1_408, 768),
        )

    def test_wan_endpoint_conditioning_uses_one_full_temporal_vae_encode(self) -> None:
        try:
            import torch
            import diffusers  # noqa: F401
        except ImportError:
            self.skipTest("WAN conditioning test requires the bundled torch runtime")

        class FakeVae:
            dtype = torch.float32
            config = SimpleNamespace(
                z_dim=16,
                latents_mean=[0.0] * 16,
                latents_std=[1.0] * 16,
            )

            def __init__(self) -> None:
                self.inputs: list[object] = []

            def encode(self, video: object) -> object:
                self.inputs.append(video.detach().clone())
                temporal_samples = video[:, :, ::4].mean(dim=(1, 3, 4))
                latents = temporal_samples[:, None, :, None, None].repeat(
                    1,
                    16,
                    1,
                    2,
                    2,
                )
                return SimpleNamespace(latents=latents)

        class FakePipeline:
            vae_scale_factor_temporal = 4
            vae_scale_factor_spatial = 8

            def __init__(self) -> None:
                self.vae = FakeVae()
                self.prepare_latents = lambda *args, **kwargs: None

        pipeline = FakePipeline()
        WORKER._enable_wan_last_frame_conditioning(pipeline, torch)
        first = torch.full((1, 3, 16, 16), -1.0)
        last = torch.full((1, 3, 16, 16), 1.0)
        latents, condition, mask = pipeline.prepare_latents(
            first,
            batch_size=1,
            num_channels_latents=16,
            height=16,
            width=16,
            num_frames=17,
            dtype=torch.float32,
            device=torch.device("cpu"),
            generator=torch.Generator().manual_seed(72526017),
            last_image=last,
        )

        self.assertEqual(tuple(latents.shape), (1, 16, 5, 2, 2))
        self.assertEqual(len(pipeline.vae.inputs), 1)
        encoded_video = pipeline.vae.inputs[0]
        self.assertEqual(tuple(encoded_video.shape), (1, 3, 17, 16, 16))
        torch.testing.assert_close(encoded_video[:, :, 0], first)
        torch.testing.assert_close(
            encoded_video[:, :, 1:-4],
            torch.zeros_like(encoded_video[:, :, 1:-4]),
        )
        torch.testing.assert_close(
            encoded_video[:, :, -4:],
            last.unsqueeze(2).repeat(1, 1, 4, 1, 1),
        )
        torch.testing.assert_close(
            condition[0, 0, :, 0, 0],
            torch.tensor([-1.0, 0.0, 0.0, 0.0, 1.0]),
        )
        self.assertTrue(torch.all(mask[:, :, 0] == 0))
        self.assertTrue(torch.all(mask[:, :, 1:-1] == 1))
        self.assertTrue(torch.all(mask[:, :, -1] == 0))
        self.assertEqual(
            pipeline._machdoch_wan_conditioning_mode,
            "first-last-temporal-context-lock-v3",
        )

    def test_chroma_validation_is_explicit_and_not_inferred_from_prompt_text(self) -> None:
        opaque_landscape = Image.new("RGB", (96, 64), (30, 60, 120))
        addons = [{"kind": "lora", "addonId": "addon:identity-edit"}]

        WORKER._validate_generated_pixels(
            opaque_landscape,
            addons,
            require_chroma_background=False,
        )
        with self.assertRaisesRegex(
            WORKER.WorkerError,
            "lost the requested chroma-green background",
        ):
            WORKER._validate_generated_pixels(
                opaque_landscape,
                addons,
                require_chroma_background=True,
            )

    def test_video_dimensions_cover_all_native_aspect_profiles(self) -> None:
        self.assertEqual(WORKER._video_dimensions("16:9", "quality-640"), (640, 352))
        self.assertEqual(WORKER._video_dimensions("9:16", "quality-768"), (432, 768))
        self.assertEqual(WORKER._video_dimensions("21:9", "preview-512"), (512, 224))
        for resolution in ("preview-512", "quality-640", "quality-768"):
            for aspect in ("1:1", "16:9", "9:16", "21:9"):
                width, height = WORKER._video_dimensions(aspect, resolution)
                self.assertEqual(width % 16, 0)
                self.assertEqual(height % 16, 0)

    def test_loop_assembly_preserves_one_way_and_exact_ping_pong(self) -> None:
        frames = [np.full((4, 4, 4), index, dtype=np.uint8) for index in range(3)]
        one_way = WORKER._assemble_video_frames(frames, "none")
        ping_pong = WORKER._assemble_video_frames(frames, "ping-pong")
        seamless = WORKER._assemble_video_frames(frames, "seamless")
        self.assertEqual(len(one_way), 3)
        self.assertEqual(len(seamless), 3)
        self.assertEqual(len(ping_pong), 5)
        np.testing.assert_array_equal(ping_pong[0], ping_pong[-1])

    def test_ground_suppression_removes_shadow_but_preserves_connected_foot(self) -> None:
        alphas = [np.zeros((64, 64), dtype=np.uint8) for _ in range(5)]
        for alpha in alphas:
            alpha[18:58, 28:36] = 255
        alphas[-1][57:60, 12:24] = 220
        alphas[-1][58:61, 28:36] = 255
        cleaned, evidence = WORKER._suppress_transient_ground_alpha(alphas)
        self.assertEqual(int(cleaned[-1][58:61, 12:24].max()), 0)
        self.assertEqual(int(cleaned[-1][58:61, 28:36].min()), 255)
        self.assertGreater(evidence["removedOpaqueComponents"], 0)

    def test_production_rekey_removes_persistent_detached_plate_markers(self) -> None:
        frames = []
        for _ in range(5):
            pixels = np.zeros((64, 64, 4), dtype=np.uint8)
            pixels[..., 1] = 255
            pixels[..., 3] = 255
            pixels[14:58, 26:39, :3] = (110, 30, 35)
            pixels[5:8, 5:8, :3] = (220, 20, 20)
            pixels[44:47, 52:55, :3] = (30, 80, 220)
            pixels[24:27, 43:46, :3] = (20, 220, 240)
            frames.append(pixels)

        refined, evidence = WORKER._matte_video_frames(frames, "production")

        self.assertEqual(int(refined[2][5:8, 5:8, 3].max()), 0)
        self.assertEqual(int(refined[2][44:47, 52:55, 3].max()), 0)
        self.assertEqual(int(refined[2][24:27, 43:46, 3].max()), 0)
        self.assertGreater(int(refined[2][20:50, 28:37, 3].min()), 240)
        self.assertGreaterEqual(
            evidence["primarySubjectIsolation"]["removedPixels"],
            80,
        )

    def test_primary_subject_isolation_removes_shadowed_studio_plate(self) -> None:
        alpha = np.zeros((96, 96), dtype=np.uint8)
        alpha[16:88, 36:61] = 255
        alpha[13:91, 33:64] = np.maximum(alpha[13:91, 33:64], 96)
        # Large contamination touches the screen border and would previously
        # survive the 2%-of-subject detached-component exemption.
        alpha[:30, :42] = 232
        alpha[80:96, :34] = 180

        isolated, evidence = WORKER._isolate_primary_alpha_subject(alpha)
        cleaned, cleanup = WORKER._cleanup_alpha_components(isolated)

        self.assertTrue(evidence["applied"])
        self.assertEqual(int(cleaned[:20, :20].max()), 0)
        self.assertEqual(int(cleaned[88:96, :24].max()), 0)
        self.assertEqual(int(cleaned[32:80, 40:57].min()), 255)
        self.assertGreater(evidence["removedPixels"], 500)
        self.assertGreaterEqual(cleanup["removedComponents"], 0)

    def test_conditioning_framing_preserves_subject_across_ultrawide_ratio(self) -> None:
        pixels = np.zeros((400, 240, 4), dtype=np.uint8)
        pixels[..., 1] = 255
        pixels[..., 3] = 255
        pixels[20:380, 90:150, :3] = (120, 35, 45)
        pixels[60:65, 12:17, :3] = (220, 20, 20)
        with tempfile.TemporaryDirectory(prefix="machdoch-framing-") as temporary:
            source = Path(temporary) / "portrait-key.png"
            Image.fromarray(pixels).save(source)
            framed, evidence = WORKER._prepare_video_conditioning_frame(
                source,
                512,
                224,
                True,
            )

        self.assertEqual(framed.size, (512, 224))
        self.assertEqual(evidence["mode"], "subject-aware-fit")
        self.assertTrue(evidence["subjectDetected"])
        self.assertFalse(evidence["stretched"])
        self.assertFalse(evidence["croppedSubject"])
        self.assertTrue(evidence["plateDebrisExcluded"])
        self.assertGreaterEqual(evidence["topMargin"], 12)
        self.assertGreaterEqual(evidence["bottomMargin"], 12)
        self.assertGreater(evidence["leftMargin"], 200)
        self.assertGreater(evidence["rightMargin"], 200)

    def test_opaque_webm_round_trip_does_not_index_an_alpha_channel(self) -> None:
        frames = []
        for index in range(3):
            pixels = np.zeros((64, 96, 3), dtype=np.uint8)
            pixels[..., 0] = 30 + index * 20
            pixels[16:48, 24 + index : 56 + index, 1] = 220
            frames.append(Image.fromarray(pixels))
        with tempfile.TemporaryDirectory(prefix="machdoch-opaque-webm-") as temporary:
            destination, evidence, composite = WORKER._encode_video_webm(
                frames,
                Path(temporary),
                8,
                None,
                transparent_background=False,
                loop_mode="none",
                matte_quality="production",
                encoding_quality="lossless",
            )
            self.assertTrue(destination.is_file())
            self.assertIsNone(composite)
            self.assertFalse(evidence["hasAlpha"])
            self.assertEqual(evidence["decodedFrameCount"], 3)
            self.assertEqual(evidence["decodedAlphaMinimum"], 255)
            self.assertEqual(evidence["decodedAlphaMaximum"], 255)
            self.assertEqual(evidence["decodedAlphaLoopEndpointMae"], 0.0)


if __name__ == "__main__":
    unittest.main()
