from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

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
            "first-last-temporal-context-lock-v5",
        )

    def test_wan_circular_denoising_shifts_latents_and_timestep_together(self) -> None:
        try:
            import torch
        except ImportError:
            self.skipTest("WAN circular denoising test requires torch")

        class FakeTransformer:
            def __init__(self) -> None:
                self.calls: list[tuple[object, object]] = []

            def forward(
                self,
                hidden_states: object,
                timestep: object,
                *args: object,
                **kwargs: object,
            ) -> tuple[object]:
                self.calls.append((hidden_states.clone(), timestep.clone()))
                return (hidden_states,)

        pipeline = SimpleNamespace(
            transformer=FakeTransformer(),
        )
        WORKER._enable_wan_circular_denoising(pipeline, torch)
        pipeline._machdoch_wan_loop_shift_index = 2
        hidden_states = torch.arange(5.0).reshape(1, 1, 5, 1, 1)
        timestep = torch.arange(10.0).reshape(1, 10)

        output = pipeline.transformer.forward(
            hidden_states,
            timestep,
            return_dict=False,
        )

        shifted_hidden_states, shifted_timestep = pipeline.transformer.calls[0]
        torch.testing.assert_close(
            shifted_hidden_states.flatten(),
            torch.tensor([2.0, 3.0, 4.0, 0.0, 1.0]),
        )
        torch.testing.assert_close(
            shifted_timestep,
            torch.tensor([[4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 0.0, 1.0, 2.0, 3.0]]),
        )
        torch.testing.assert_close(output[0], hidden_states)

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

    def test_ltx_video_dimensions_avoid_implicit_padding(self) -> None:
        self.assertEqual(
            WORKER._video_dimensions("16:9", "quality-768", "ltx-video"),
            (768, 448),
        )
        self.assertEqual(
            WORKER._video_dimensions("9:16", "quality-768", "ltx-video"),
            (448, 768),
        )
        for resolution in ("preview-512", "quality-640", "quality-768"):
            for aspect in ("1:1", "16:9", "9:16", "21:9"):
                width, height = WORKER._video_dimensions(
                    aspect,
                    resolution,
                    "ltx-video",
                )
                self.assertEqual(width % 32, 0)
                self.assertEqual(height % 32, 0)

    def test_hunyuan_video_15_dimensions_follow_official_aspect_buckets(self) -> None:
        expected = {
            ("preview-512", "16:9"): (672, 384),
            ("quality-640", "9:16"): (480, 832),
            ("quality-640", "21:9"): (944, 416),
            ("quality-768", "9:16"): (576, 1_008),
            ("quality-768", "21:9"): (1_152, 496),
        }
        for (resolution, aspect), dimensions in expected.items():
            self.assertEqual(
                WORKER._video_dimensions(
                    aspect,
                    resolution,
                    "hunyuan-video-1.5-i2v",
                ),
                dimensions,
            )
        for resolution in ("preview-512", "quality-640", "quality-768"):
            for aspect in ("1:1", "16:9", "9:16", "21:9"):
                width, height = WORKER._video_dimensions(
                    aspect,
                    resolution,
                    "hunyuan-video-1.5-i2v",
                )
                self.assertEqual(width % 16, 0)
                self.assertEqual(height % 16, 0)

    def test_ltx_multiscale_dimensions_follow_official_two_thirds_pass(self) -> None:
        self.assertEqual(
            WORKER._ltx_multiscale_dimensions(640, 352),
            (416, 224, 832, 448),
        )
        self.assertEqual(
            WORKER._ltx_multiscale_dimensions(768, 448),
            (512, 288, 1_024, 576),
        )

    def test_ltx_variant_selects_only_packaged_fp8_checkpoints(self) -> None:
        root = Path("C:/models/ltx-video-0.9.8")
        checkpoint, config, variant = WORKER._ltx_checkpoint(
            {"id": "local:ltx-video-0.9.8-13b-distilled-fp8"},
            root,
        )
        self.assertEqual(
            checkpoint.name,
            "ltxv-13b-0.9.8-distilled-fp8.safetensors",
        )
        self.assertEqual(config, "transformer-13b")
        self.assertEqual(variant, "13b-distilled-fp8")
        checkpoint, config, variant = WORKER._ltx_checkpoint(
            {"id": "local:ltx-video-0.9.8-2b-distilled-fp8"},
            root,
        )
        self.assertEqual(
            checkpoint.name,
            "ltxv-2b-0.9.8-distilled-fp8.safetensors",
        )
        self.assertEqual(config, "transformer")
        self.assertEqual(variant, "2b-distilled-fp8")
        with self.assertRaisesRegex(WORKER.WorkerError, "2B or 13B"):
            WORKER._ltx_checkpoint({"id": "local:ltx-video-auto"}, root)

    def test_framepack_fp8_keeps_precision_critical_parameters_in_bfloat16(self) -> None:
        for name in (
            "x_embedder.proj.weight",
            "clean_x_embedder.proj_2x.weight",
            "context_embedder.proj_in.weight",
            "transformer_blocks.0.norm1.weight",
            "proj_out.weight",
        ):
            self.assertTrue(WORKER._framepack_parameter_uses_compute_dtype(name))
        self.assertFalse(
            WORKER._framepack_parameter_uses_compute_dtype(
                "transformer_blocks.0.attn.to_q.weight"
            )
        )

    def test_framepack_full_section_is_sampled_without_synthesizing_frames(self) -> None:
        frames = list(range(37))
        selected = WORKER._framepack_requested_frames(frames, 17)
        self.assertEqual(len(selected), 17)
        self.assertEqual(selected[0], 0)
        self.assertEqual(selected[-1], 36)
        self.assertEqual(selected, sorted(set(selected)))
        self.assertIs(WORKER._framepack_requested_frames(frames, 37), frames)
        with self.assertRaisesRegex(WORKER.WorkerError, "fewer decoded frames"):
            WORKER._framepack_requested_frames(frames[:16], 17)

    def test_indexed_checkpoint_files_rejects_parent_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            index = root / "transformer" / "model.index.json"
            index.parent.mkdir()
            index.write_text(
                '{"weight_map":{"weight":"../outside.safetensors"}}',
                encoding="utf-8",
            )
            with self.assertRaisesRegex(WORKER.WorkerError, "unsafe"):
                WORKER._indexed_checkpoint_files(
                    root,
                    "transformer/model.index.json",
                )

    def test_framepack_fp8_cache_requires_complete_source_identity(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "transformer"
            cache = root / "runtime" / "framepack-transformer-fp8-v1"
            source.mkdir()
            cache.mkdir(parents=True)
            index = {"weight_map": {"weight": "model.safetensors"}}
            source_index = source / "diffusion_pytorch_model.safetensors.index.json"
            source_index.write_text(json.dumps(index), encoding="utf-8")
            (cache / "diffusion_pytorch_model.safetensors.index.json").write_text(
                json.dumps(index),
                encoding="utf-8",
            )
            checkpoint = cache / "model.safetensors"
            checkpoint.write_bytes(b"verified-cache")
            (cache / "complete.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "sourceIndexSha256": WORKER._sha256_file(source_index),
                        "files": {"model.safetensors": checkpoint.stat().st_size},
                    }
                ),
                encoding="utf-8",
            )
            validated = WORKER._validated_framepack_fp8_cache(root)
            self.assertIsNotNone(validated)
            self.assertEqual(validated[1], [checkpoint])
            source_index.write_text('{"weight_map":{}}', encoding="utf-8")
            self.assertIsNone(WORKER._validated_framepack_fp8_cache(root))

    def test_video_auto_memory_profile_adapts_to_ram_and_vram(self) -> None:
        gib = 1_024**3
        self.assertEqual(
            WORKER._select_video_memory_profile("auto", 16 * gib, 8 * gib),
            "memory-saver",
        )
        self.assertEqual(
            WORKER._select_video_memory_profile("auto", 32 * gib, 16 * gib),
            "balanced",
        )
        self.assertEqual(
            WORKER._select_video_memory_profile("auto", 48 * gib, 16 * gib),
            "balanced",
        )
        self.assertEqual(
            WORKER._select_video_memory_profile("auto", 32 * gib, 24 * gib),
            "balanced",
        )
        self.assertEqual(
            WORKER._select_video_memory_profile("auto", 64 * gib, 24 * gib),
            "balanced",
        )
        self.assertEqual(
            WORKER._select_video_memory_profile("auto", 64 * gib, 48 * gib),
            "maximum-speed",
        )
        self.assertEqual(
            WORKER._select_video_memory_profile("memory-saver", 64 * gib, 24 * gib),
            "memory-saver",
        )

    def test_video_offload_group_size_uses_available_vram(self) -> None:
        gib = 1_024**3
        self.assertEqual(
            WORKER._video_offload_group_size(8 * gib),
            1,
        )
        self.assertEqual(
            WORKER._video_offload_group_size(12 * gib),
            2,
        )
        self.assertEqual(
            WORKER._video_offload_group_size(15 * gib),
            4,
        )
        self.assertEqual(
            WORKER._video_offload_group_size(23 * gib),
            8,
        )
        self.assertEqual(
            WORKER._video_offload_group_size(24 * gib, "memory-saver"),
            1,
        )
        self.assertEqual(
            WORKER._video_offload_group_size(None),
            1,
        )

    def test_framepack_vae_tiles_bound_decode_memory_on_smaller_gpus(self) -> None:
        gib = 1_024**3
        bounded = WORKER._framepack_vae_tile_configuration(16 * gib)
        self.assertEqual(bounded["tile_sample_min_height"], 64)
        self.assertEqual(bounded["tile_sample_min_width"], 64)
        self.assertEqual(bounded["tile_sample_min_num_frames"], 8)
        self.assertLess(
            bounded["tile_sample_stride_height"],
            bounded["tile_sample_min_height"],
        )
        self.assertEqual(
            WORKER._framepack_vae_tile_configuration(None),
            bounded,
        )

        roomy = WORKER._framepack_vae_tile_configuration(24 * gib)
        self.assertEqual(roomy["tile_sample_min_height"], 256)
        self.assertEqual(roomy["tile_sample_min_num_frames"], 16)

    def test_hunyuan_video_15_vae_tiles_adapt_to_vram(self) -> None:
        gib = 1_024**3
        bounded = WORKER._hunyuan_video_15_vae_tile_configuration(16 * gib)
        self.assertEqual(bounded["tile_sample_min_height"], 128)
        self.assertEqual(bounded["tile_latent_min_height"], 8)
        roomy = WORKER._hunyuan_video_15_vae_tile_configuration(24 * gib)
        self.assertEqual(roomy["tile_sample_min_height"], 256)
        self.assertEqual(roomy["tile_latent_min_height"], 16)

    def test_hunyuan_video_15_storage_adapts_to_host_and_device_memory(
        self,
    ) -> None:
        gib = 1_024**3
        self.assertTrue(
            WORKER._hunyuan_video_15_uses_bfloat16_storage(
                16 * gib,
                32 * gib,
            )
        )
        self.assertFalse(
            WORKER._hunyuan_video_15_uses_bfloat16_storage(
                14 * gib,
                32 * gib,
            )
        )
        self.assertFalse(
            WORKER._hunyuan_video_15_uses_bfloat16_storage(
                16 * gib,
                32 * gib,
                "memory-saver",
            )
        )
        self.assertTrue(
            WORKER._hunyuan_video_15_uses_bfloat16_storage(
                24 * gib,
                48 * gib,
            )
        )
        self.assertTrue(
            WORKER._hunyuan_video_15_parameter_uses_compute_dtype(
                "transformer_blocks.0.norm1.linear.weight"
            )
        )
        self.assertFalse(
            WORKER._hunyuan_video_15_parameter_uses_compute_dtype(
                "transformer_blocks.0.attn.to_q.weight"
            )
        )

    def test_framepack_direct_vae_decode_does_not_retain_autograd_tiles(self) -> None:
        try:
            import torch
        except ImportError:
            self.skipTest("FramePack decode test requires the bundled torch runtime")

        class FakeVae:
            dtype = torch.float32
            config = SimpleNamespace(scaling_factor=1.0)

            def __init__(self) -> None:
                self.inference_mode_enabled = False

            def to(self, _device: object) -> "FakeVae":
                return self

            def decode(
                self,
                latents: object,
                return_dict: bool,
            ) -> tuple[object]:
                self.inference_mode_enabled = torch.is_inference_mode_enabled()
                self.assert_return_dict = return_dict
                return (latents,)

        class FakeVideoProcessor:
            def postprocess_video(
                self,
                decoded: object,
                output_type: str,
            ) -> list[list[object]]:
                self.decoded = decoded
                self.output_type = output_type
                return [["frame-0", "frame-1"]]

        vae = FakeVae()
        processor = FakeVideoProcessor()
        frames = WORKER._decode_framepack_video(
            torch,
            vae,
            processor,
            torch.ones((1, 1, 1, 1, 1)),
            torch.device("cpu"),
        )

        self.assertTrue(vae.inference_mode_enabled)
        self.assertFalse(vae.assert_return_dict)
        self.assertEqual(processor.output_type, "pil")
        self.assertEqual(frames, ["frame-0", "frame-1"])

    def test_framepack_prompt_encoding_does_not_retain_autograd_graphs(self) -> None:
        try:
            import torch
        except ImportError:
            self.skipTest("FramePack prompt test requires the bundled torch runtime")

        class FakeEncoder:
            def __init__(self) -> None:
                self.inference_mode_enabled = False

            def encode_prompt(self, **_kwargs: object) -> tuple[object, object, object]:
                self.inference_mode_enabled = torch.is_inference_mode_enabled()
                value = torch.ones((1, 2), requires_grad=True) * 2
                return value, value.clone(), value.clone()

        encoder = FakeEncoder()
        prompt_embeddings, pooled_embeddings, attention_mask = (
            WORKER._encode_framepack_prompt(
                encoder,
                torch,
                "A useful prompt",
                torch.device("cpu"),
                torch.float32,
            )
        )

        self.assertTrue(encoder.inference_mode_enabled)
        self.assertFalse(prompt_embeddings.requires_grad)
        self.assertFalse(pooled_embeddings.requires_grad)
        self.assertFalse(attention_mask.requires_grad)

    def test_hunyuan_video_15_prompt_encoding_does_not_retain_autograd_graphs(
        self,
    ) -> None:
        try:
            import torch
        except ImportError:
            self.skipTest("HunyuanVideo prompt test requires the bundled torch runtime")

        class FakePipeline:
            inference_mode_enabled = False

            @classmethod
            def _get_mllm_prompt_embeds(
                cls,
                **_kwargs: object,
            ) -> tuple[object, object]:
                cls.inference_mode_enabled = torch.is_inference_mode_enabled()
                value = torch.ones((1, 2), requires_grad=True) * 2
                return value, value.clone()

            @staticmethod
            def _get_byt5_prompt_embeds(
                **_kwargs: object,
            ) -> tuple[object, object]:
                value = torch.ones((1, 2), requires_grad=True) * 2
                return value, value.clone()

        tensors = WORKER._encode_hunyuan_video_15_prompt(
            FakePipeline,
            torch,
            "A useful motion prompt",
            torch.device("cpu"),
            None,
            None,
            None,
            None,
        )

        self.assertTrue(FakePipeline.inference_mode_enabled)
        self.assertEqual(len(tensors), 4)
        self.assertTrue(all(not tensor.requires_grad for tensor in tensors))

    def test_hunyuan_video_15_prompt_subprocess_retries_a_native_exit(self) -> None:
        completed = SimpleNamespace(
            stdout="",
            stderr="native process terminated",
            returncode=-1_073_741_819,
        )
        with mock.patch.object(
            WORKER.subprocess,
            "run",
            return_value=completed,
        ) as run:
            with self.assertRaisesRegex(
                WORKER.WorkerError,
                r"exit code -1073741819.*native process terminated",
            ):
                WORKER._encode_hunyuan_video_15_prompt_embeddings(
                    Path("unused"),
                    "A useful motion prompt",
                )

        self.assertEqual(run.call_count, 2)

    def test_hunyuan_video_15_denoiser_retries_a_transient_miopen_failure(
        self,
    ) -> None:
        completed = SimpleNamespace(
            stdout=json.dumps(
                {
                    "error": (
                        "Local Diffusers worker failed: RuntimeError: "
                        "miopenStatusUnknownError"
                    )
                }
            ),
            stderr="MIOpen Error: transient convolution failure",
            returncode=3,
        )
        with mock.patch.object(
            WORKER.subprocess,
            "run",
            return_value=completed,
        ) as run:
            with self.assertRaisesRegex(
                WORKER.WorkerError,
                "miopenStatusUnknownError",
            ):
                WORKER._generate_hunyuan_video_15_latents(
                    {},
                    "A useful motion prompt",
                    Path("unused.png"),
                    640,
                    640,
                    640,
                    25,
                    8,
                    7,
                    False,
                    "auto",
                )

        self.assertEqual(run.call_count, 2)

    def test_hunyuan_video_15_denoiser_does_not_retry_a_permanent_bad_response(
        self,
    ) -> None:
        completed = SimpleNamespace(
            stdout="not-json",
            stderr="permanent denoiser configuration failure",
            returncode=3,
        )
        with mock.patch.object(
            WORKER.subprocess,
            "run",
            return_value=completed,
        ) as run:
            with self.assertRaisesRegex(
                WORKER.WorkerError,
                "returned an invalid response",
            ):
                WORKER._generate_hunyuan_video_15_latents(
                    {},
                    "A useful motion prompt",
                    Path("unused.png"),
                    640,
                    640,
                    640,
                    25,
                    8,
                    7,
                    False,
                    "auto",
                )

        self.assertEqual(run.call_count, 1)

    def test_cpu_video_memory_evidence_is_explicitly_process_isolated(self) -> None:
        evidence = WORKER._start_video_memory_observation(
            SimpleNamespace(),
            "cpu",
        )
        self.assertEqual(
            evidence["processIsolation"],
            "one-generation-per-process",
        )
        self.assertIsNone(evidence["peakAllocatedBytes"])
        self.assertEqual(
            WORKER._finish_video_memory_observation(
                SimpleNamespace(),
                "cpu",
                evidence,
            ),
            evidence,
        )

    def test_loop_assembly_omits_duplicate_cyclic_endpoints(self) -> None:
        frames = [np.full((4, 4, 4), index, dtype=np.uint8) for index in range(3)]
        one_way = WORKER._assemble_video_frames(frames, "none")
        ping_pong = WORKER._assemble_video_frames(frames, "ping-pong")
        seamless = WORKER._assemble_video_frames(frames, "seamless")
        self.assertEqual(len(one_way), 3)
        self.assertEqual(
            [int(frame[0, 0, 0]) for frame in seamless],
            [0, 1],
        )
        self.assertEqual(len(ping_pong), 4)
        self.assertEqual(
            [int(frame[0, 0, 0]) for frame in ping_pong],
            [0, 1, 2, 1],
        )
        self.assertFalse(np.array_equal(ping_pong[0], ping_pong[-1]))
        self.assertEqual(
            WORKER._loop_transition_evidence(ping_pong),
            {
                "boundaryMae": 1.0,
                "referenceMae": 1.0,
                "continuityRatio": 1.0,
            },
        )

    def test_duplicate_frame_evidence_reports_holds_and_closure_duplicates(self) -> None:
        first = np.zeros((4, 4, 3), dtype=np.uint8)
        second = np.ones((4, 4, 3), dtype=np.uint8)

        evidence = WORKER._duplicate_frame_evidence(
            [first, second, second.copy(), first.copy()]
        )

        self.assertEqual(evidence["exactAdjacentDuplicateCount"], 1)
        self.assertEqual(evidence["exactAdjacentDuplicateTransitions"], [2])
        self.assertTrue(evidence["duplicateClosureFrame"])

    def test_cadence_gate_rejects_sparse_frame_stretching(self) -> None:
        values = (0, 10, 20, 30, 31, 40, 50, 60, 50, 40, 30, 29, 20, 10)
        frames = [
            np.full((4, 4, 3), value, dtype=np.uint8) for value in values
        ]

        evidence = WORKER._cadence_evidence(frames)

        self.assertGreaterEqual(
            evidence["lowTransitionFraction"],
            WORKER.MAX_DECODED_LOOP_LOW_TRANSITION_FRACTION,
        )
        self.assertGreaterEqual(
            evidence["normalizedJerkMean"],
            WORKER.MAX_DECODED_LOOP_NORMALIZED_JERK,
        )
        with self.assertRaisesRegex(
            WORKER.WorkerError,
            "near-hold transitions",
        ):
            WORKER._require_decoded_loop_cadence(evidence, "Test")

    def test_seamless_encoder_rejects_an_exact_internal_hold(self) -> None:
        frames = [
            Image.fromarray(np.full((16, 16, 3), value, dtype=np.uint8))
            for value in (0, 1, 1, 0)
        ]
        with tempfile.TemporaryDirectory(
            prefix="machdoch-duplicate-loop-"
        ) as temporary:
            with self.assertRaisesRegex(
                WORKER.WorkerError,
                "exact duplicate frame",
            ):
                WORKER._encode_video_webm(
                    frames,
                    Path(temporary),
                    8,
                    None,
                    transparent_background=False,
                    loop_mode="seamless",
                    matte_quality="production",
                    encoding_quality="lossless",
                )

    def test_framepack_denoiser_timeout_scales_with_requested_workload(self) -> None:
        self.assertEqual(
            WORKER._framepack_denoiser_timeout_seconds(640, 640, 25, 16),
            2 * 60 * 60,
        )
        self.assertEqual(
            WORKER._framepack_denoiser_timeout_seconds(768, 768, 37, 12),
            11_509,
        )
        self.assertEqual(
            WORKER._framepack_denoiser_timeout_seconds(768, 768, 129, 50),
            8 * 60 * 60,
        )

    def test_ping_pong_feathers_a_small_conditioned_endpoint_outlier(self) -> None:
        frames = [
            np.full((4, 4, 4), value, dtype=np.uint8)
            for value in (0, 4, 5, 6, 7)
        ]

        ping_pong = WORKER._assemble_video_frames(frames, "ping-pong")

        self.assertEqual(
            [int(frame[0, 0, 0]) for frame in ping_pong],
            [0, 2, 4, 6, 7, 6, 4, 2],
        )
        self.assertLessEqual(
            WORKER._loop_transition_evidence(ping_pong)["continuityRatio"],
            WORKER.MAX_DECODED_LOOP_CONTINUITY_RATIO,
        )
        self.assertFalse(np.array_equal(ping_pong[0], ping_pong[-1]))

    def test_ping_pong_repeats_feathering_for_a_quiet_clip(self) -> None:
        frames = [
            np.full((4, 4, 4), value, dtype=np.uint8)
            for value in (0, *range(6, 42))
        ]

        ping_pong = WORKER._assemble_video_frames(frames, "ping-pong")

        self.assertEqual(len(ping_pong), len(frames) * 2 - 2)
        self.assertLessEqual(
            WORKER._loop_transition_evidence(ping_pong)["continuityRatio"],
            WORKER.MAX_DECODED_LOOP_CONTINUITY_RATIO,
        )
        self.assertFalse(np.array_equal(ping_pong[0], ping_pong[-1]))

    def test_ping_pong_feathering_never_creates_a_duplicate_closure(self) -> None:
        frames = [np.zeros((8, 8, 4), dtype=np.uint8)]
        current = np.ones((8, 8, 4), dtype=np.uint8)
        frames.append(current.copy())
        for index in range(35):
            current = current.copy()
            current[index // 8, index % 8, 0] += 1
            frames.append(current)

        ping_pong = WORKER._assemble_video_frames(frames, "ping-pong")

        self.assertFalse(np.array_equal(ping_pong[0], ping_pong[-1]))
        self.assertEqual(ping_pong[-1][0, 0, 0], 1)

    def test_ping_pong_does_not_hide_a_large_endpoint_jump(self) -> None:
        frames = [
            np.full((4, 4, 4), value, dtype=np.uint8)
            for value in (0, 100, 110, 120, 130)
        ]

        ping_pong = WORKER._assemble_video_frames(frames, "ping-pong")

        self.assertEqual(
            [int(frame[0, 0, 0]) for frame in ping_pong],
            [0, 100, 110, 120, 130, 120, 110, 100],
        )
        self.assertGreater(
            WORKER._loop_transition_evidence(ping_pong)["continuityRatio"],
            WORKER.MAX_DECODED_LOOP_CONTINUITY_RATIO,
        )

    def test_framepack_selects_one_semantic_prompt_per_generated_section(
        self,
    ) -> None:
        observed = []

        def forward(*args, **kwargs):
            observed.append(int(kwargs["encoder_hidden_states"][0, 0, 0]))
            return (np.zeros((1,), dtype=np.float32),)

        transformer = SimpleNamespace(forward=forward)
        prompts = np.asarray([10, 20, 30], dtype=np.float32).reshape(3, 1, 1)
        pooled = np.asarray([11, 21, 31], dtype=np.float32).reshape(3, 1)
        masks = np.ones((3, 1), dtype=np.float32)

        state = WORKER._enable_framepack_section_prompt_conditioning(
            transformer,
            prompts,
            pooled,
            masks,
            2,
        )
        for _ in range(6):
            transformer.forward()

        self.assertEqual(observed, [10, 10, 20, 20, 30, 30])
        self.assertEqual(state["transformerCalls"], 6)
        self.assertEqual(state["usedSectionIndices"], [0, 1, 2])
        self.assertEqual(WORKER._framepack_generation_section_count(33), 1)
        self.assertEqual(WORKER._framepack_generation_section_count(49), 2)
        self.assertEqual(WORKER._framepack_generation_section_count(129), 4)

    def test_hunyuan_soft_loop_cue_scales_the_last_condition_only(self) -> None:
        original_condition = np.zeros((1, 16, 5, 2, 2), dtype=np.float32)
        original_condition[:, :, 0] = 8.0
        original_mask = np.zeros((1, 1, 5, 2, 2), dtype=np.float32)
        original_mask[:, :, 0] = 1.0
        pipeline = SimpleNamespace(
            prepare_cond_latents_and_mask=lambda *args, **kwargs: (
                original_condition,
                original_mask,
            )
        )

        WORKER._enable_hunyuan_video_15_soft_loop_endpoint_conditioning(
            pipeline,
            0.375,
            3,
        )
        condition, mask = pipeline.prepare_cond_latents_and_mask()

        np.testing.assert_array_equal(
            condition[0, 0, :, 0, 0],
            np.asarray([8.0, 0.0, 1.0, 2.0, 3.0], dtype=np.float32),
        )
        np.testing.assert_array_equal(
            mask[0, 0, :, 0, 0],
            np.asarray([1.0, 0.0, 0.125, 0.25, 0.375], dtype=np.float32),
        )
        self.assertTrue(np.all(original_condition[:, :, -1] == 0.0))
        self.assertTrue(np.all(original_mask[:, :, -1] == 0.0))

    def test_hunyuan_video_15_rejects_fake_seamless_conditioning(self) -> None:
        with mock.patch.object(
            WORKER,
            "_absolute_existing_path",
            side_effect=[Path("first.png"), Path("last.png")],
        ), mock.patch.object(
            WORKER,
            "_fresh_output_directory",
            return_value=Path("output"),
        ), mock.patch.object(
            WORKER,
            "_video_dimensions",
            return_value=(640, 640),
        ), mock.patch.object(
            WORKER,
            "_runtime",
            return_value=(SimpleNamespace(), SimpleNamespace()),
        ), mock.patch.object(
            WORKER,
            "_device",
            return_value=("cuda", "test-gpu", 16 * 1024**3),
        ), mock.patch.object(
            WORKER,
            "_sha256_file",
            return_value="same",
        ), mock.patch.object(
            WORKER,
            "_prepare_video_conditioning_frame",
            return_value=(object(), {}),
        ):
            with self.assertRaisesRegex(
                WORKER.WorkerError,
                "cannot natively condition a closing frame",
            ):
                WORKER.generate_video(
                    {
                        "schemaVersion": WORKER.SCHEMA_VERSION,
                        "model": {
                            "architecture": "hunyuan-video-1.5-i2v",
                        },
                        "prompt": "subtle motion",
                        "firstFramePath": "first.png",
                        "lastFramePath": "last.png",
                        "outputDirectory": "output",
                        "aspectRatio": "1:1",
                        "resolution": "quality-640",
                        "numFrames": 17,
                        "numInferenceSteps": 8,
                        "fps": 16,
                        "loopMode": "seamless",
                        "transparentBackground": False,
                        "matteQuality": "production",
                        "encodingQuality": "lossless",
                        "guidanceScale": 1,
                        "seed": 7,
                    }
                )

    def test_loop_evidence_detects_low_motion_boundary_drift(self) -> None:
        frames = []
        current = np.zeros((100, 100), dtype=np.uint8)
        for index in range(10):
            if index > 0:
                current = current.copy()
                current.flat[index] = 1
            frames.append(current)

        evidence = WORKER._loop_transition_evidence(frames)

        self.assertAlmostEqual(evidence["boundaryMae"], 0.0009)
        self.assertAlmostEqual(evidence["referenceMae"], 0.0001)
        self.assertAlmostEqual(evidence["continuityRatio"], 9.0)

    def test_rgb_loop_evidence_does_not_mix_in_alpha_motion(self) -> None:
        frames = [
            np.full((4, 4, 4), (value, value, value, alpha), dtype=np.uint8)
            for value, alpha in ((0, 0), (1, 255), (2, 0))
        ]

        self.assertEqual(
            WORKER._rgb_loop_transition_evidence(frames),
            {
                "boundaryMae": 2.0,
                "referenceMae": 1.0,
                "continuityRatio": 2.0,
            },
        )
        self.assertNotEqual(
            WORKER._loop_transition_evidence(frames),
            WORKER._rgb_loop_transition_evidence(frames),
        )

    def test_decoded_loop_quality_gate_uses_the_visible_continuity_target(
        self,
    ) -> None:
        WORKER._require_decoded_loop_continuity(
            {
                "boundaryMae": 1.25,
                "referenceMae": 1.0,
                "continuityRatio": 1.25,
            },
            "test video",
        )
        with self.assertRaisesRegex(
            WORKER.WorkerError,
            r"1\.251x.*quality limit is 1\.25x",
        ):
            WORKER._require_decoded_loop_continuity(
                {
                    "boundaryMae": 1.251,
                    "referenceMae": 1.0,
                    "continuityRatio": 1.251,
                },
                "test video",
            )

    def test_vp9_delivery_uses_full_range_444_only_for_opaque_lossless(
        self,
    ) -> None:
        self.assertEqual(
            WORKER._vp9_delivery_pixel_format("lossless", alpha=False),
            ("yuv444p", "full"),
        )
        self.assertEqual(
            WORKER._vp9_delivery_pixel_format("production", alpha=False),
            ("yuv420p", "limited"),
        )
        self.assertEqual(
            WORKER._vp9_delivery_pixel_format("lossless", alpha=True),
            ("yuva420p", "limited"),
        )

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

    def test_component_cleanup_keeps_subject_with_faint_border_bridge(self) -> None:
        alpha = np.zeros((64, 64), dtype=np.uint8)
        alpha[12:52, 26:39] = 255
        alpha[51:64, 31:34] = 20
        alpha[6:9, 6:9] = 255

        cleaned, evidence = WORKER._cleanup_alpha_components(alpha)

        self.assertEqual(int(cleaned[16:48, 28:37].min()), 255)
        self.assertEqual(int(cleaned[6:9, 6:9].max()), 0)
        self.assertEqual(evidence["removedComponents"], 1)

    def test_primary_isolation_rejects_catastrophic_subject_crop(self) -> None:
        alpha = np.zeros((64, 64), dtype=np.uint8)
        alpha[12:58, 24:42] = 255
        alpha[57:64, 31:34] = 255
        alpha[4:14, 4:14] = 255

        isolated, isolation = WORKER._isolate_primary_alpha_subject(alpha)
        self.assertFalse(isolation["applied"])
        self.assertEqual(
            isolation["reason"],
            "candidate-retained-too-little-foreground",
        )
        self.assertTrue(np.array_equal(isolated, alpha))

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

    def test_opaque_conditioning_accepts_a_non_green_photo(self) -> None:
        pixels = np.zeros((96, 96, 3), dtype=np.uint8)
        pixels[..., 0] = 188
        pixels[..., 1] = 142
        pixels[..., 2] = 108
        pixels[24:80, 30:70] = (220, 185, 140)
        with tempfile.TemporaryDirectory(prefix="machdoch-opaque-conditioning-") as temporary:
            source = Path(temporary) / "studio-photo.png"
            Image.fromarray(pixels).save(source)
            framed, evidence = WORKER._prepare_video_conditioning_frame(
                source,
                160,
                96,
                False,
            )

        self.assertEqual(framed.size, (160, 96))
        self.assertEqual(evidence["mode"], "background-pad")
        self.assertFalse(evidence["subjectDetected"])
        self.assertFalse(evidence["croppedSubject"])
        self.assertEqual(evidence["placedWidth"], 96)
        self.assertEqual(evidence["placedHeight"], 96)
        self.assertEqual(evidence["leftMargin"], 32)
        self.assertEqual(evidence["rightMargin"], 32)

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
            self.assertEqual(evidence["width"], 96)
            self.assertEqual(evidence["height"], 64)
            self.assertEqual(evidence["decodedFrameCount"], 3)
            self.assertEqual(evidence["decodedAlphaMinimum"], 255)
            self.assertEqual(evidence["decodedAlphaMaximum"], 255)
            self.assertEqual(evidence["decodedAlphaLoopEndpointMae"], 0.0)
            self.assertEqual(evidence["frameCadence"], "source-passthrough")
            self.assertEqual(evidence["exactAdjacentDuplicateCount"], 0)
            self.assertEqual(evidence["decodedExactAdjacentDuplicateCount"], 0)
            self.assertFalse(evidence["duplicateClosureFrame"])
            self.assertFalse(evidence["decodedDuplicateClosureFrame"])
            self.assertEqual(evidence["pixelFormat"], "yuv444p")
            self.assertEqual(evidence["colorRange"], "full")
            self.assertLessEqual(
                evidence["decodedRgbEncodingMaximumError"],
                2,
            )
            self.assertLess(evidence["decodedRgbEncodingMae"], 0.5)

    def test_source_anchored_loop_runs_inside_the_studio_worker(self) -> None:
        with tempfile.TemporaryDirectory(
            prefix="machdoch-source-anchored-worker-"
        ) as temporary:
            root = Path(temporary)
            manifest = root / "manifest.json"
            manifest.write_text('{"schemaVersion": 1}\n', encoding="utf-8")
            output = root / "studio-output"
            output.mkdir()
            encoded_frames: list[Image.Image] = []

            def fake_build(_: Path, rig_directory: Path) -> dict[str, object]:
                frames_directory = rig_directory / "frames"
                frames_directory.mkdir(parents=True)
                for index, value in enumerate((20, 80, 140)):
                    pixels = np.full((12, 16, 3), value, dtype=np.uint8)
                    Image.fromarray(pixels).save(
                        frames_directory / f"frame-{index:04d}.png"
                    )
                return {
                    "schemaVersion": 1,
                    "frameCount": 3,
                    "fps": 12,
                    "frames": str(frames_directory),
                }

            def fake_encode(
                frames: list[Image.Image],
                destination_directory: Path,
                fps: int,
                _: object,
                **options: object,
            ) -> tuple[Path, dict[str, object], None]:
                encoded_frames.extend(frames)
                self.assertEqual(fps, 12)
                self.assertEqual(options["loop_mode"], "seamless")
                self.assertEqual(options["encoding_quality"], "lossless")
                destination = destination_directory / "output-0000.webm"
                destination.write_bytes(b"studio-source-anchored-test")
                return destination, {"width": 16, "height": 12}, None

            fake_builder = SimpleNamespace(SCHEMA_VERSION=1, build=fake_build)
            with mock.patch.object(
                WORKER, "_load_source_anchored_builder", return_value=fake_builder
            ), mock.patch.object(
                WORKER, "_encode_video_webm", side_effect=fake_encode
            ), mock.patch.object(
                WORKER, "_package_versions", return_value={"test": "1"}
            ):
                response = WORKER.render_source_anchored_loop(
                    {
                        "manifestPath": str(manifest.resolve()),
                        "outputDirectory": str(output.resolve()),
                        "encodingQuality": "lossless",
                    }
                )

            self.assertEqual(response["workerVersion"], WORKER.WORKER_VERSION)
            self.assertEqual(
                response["capability"], "source-anchored-articulated-loop"
            )
            self.assertEqual(response["rig"]["frameCount"], 3)
            self.assertEqual(len(encoded_frames), 4)
            np.testing.assert_array_equal(
                np.asarray(encoded_frames[0]), np.asarray(encoded_frames[-1])
            )
            self.assertFalse(
                np.array_equal(
                    np.asarray(encoded_frames[0]), np.asarray(encoded_frames[-2])
                )
            )
            self.assertTrue(Path(response["output"]["path"]).is_file())
            self.assertTrue(Path(response["runEvidencePath"]).is_file())


if __name__ == "__main__":
    unittest.main()
