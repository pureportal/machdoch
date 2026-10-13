from __future__ import annotations

from contextlib import ExitStack
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import weakref

from PIL import Image

import media_diffusers_worker as worker
from media_model_memory import ModelPipelineCache, GPU_MEMORY_ERROR, is_gpu_out_of_memory, memory_snapshot, retention_seconds
from media_model_server import serve


def fake_torch():
    cuda = mock.Mock()
    cuda.mem_get_info.return_value = (12 * 1024**3, 16 * 1024**3)
    cuda.memory_allocated.return_value = 128
    cuda.memory_reserved.return_value = 256
    cuda.current_device.return_value = 0
    return SimpleNamespace(cuda=cuda, Generator=mock.Mock(), version=SimpleNamespace(hip=None),
                           device=mock.Mock(side_effect=lambda kind, index=None: (kind, index)))


class Pipeline:
    def __init__(self):
        self.enable_model_cpu_offload = mock.Mock()
        self.components = {}
        self.vae = SimpleNamespace(dtype="float16")
        self.scheduler = SimpleNamespace(config={})
        self._execution_device = "cuda"
        self.prompts = []

    def __call__(self, prompt, width, height, num_inference_steps, generator, num_images_per_prompt, guidance_scale=7.5, negative_prompt=None):
        self.prompts.append((prompt, negative_prompt))
        return SimpleNamespace(images=[Image.new("RGB", (width, height), "orange")])


class ModelMemoryTests(unittest.TestCase):
    def test_image_stream_offload_requires_room_for_pinned_weight_copies(self):
        parameter = SimpleNamespace(numel=lambda: 20 * 1024**3, element_size=lambda: 1)
        pipeline = SimpleNamespace(
            components={"transformer": SimpleNamespace(parameters=lambda: [parameter])},
            enable_group_offload=mock.Mock(),
        )
        for memory, expected in ((32 * 1024**3, False), (64 * 1024**3, True), (None, False)):
            with self.subTest(memory=memory), mock.patch.object(worker, "_physical_memory_bytes", return_value=memory):
                worker._configure_image_group_offload(pipeline, fake_torch())
            options = pipeline.enable_group_offload.call_args.kwargs
            self.assertEqual(options["use_stream"], expected)
            self.assertEqual(options["record_stream"], expected)
            self.assertEqual(options["non_blocking"], expected)

    def test_image_stream_budget_counts_shared_parameters_once(self):
        parameter = SimpleNamespace(numel=lambda: 20 * 1024**3, element_size=lambda: 1)
        component = SimpleNamespace(parameters=lambda: [parameter])
        pipeline = SimpleNamespace(components={"encoder": component, "decoder": component}, enable_group_offload=mock.Mock())
        with mock.patch.object(worker, "_physical_memory_bytes", return_value=48 * 1024**3):
            worker._configure_image_group_offload(pipeline, fake_torch())
        self.assertTrue(pipeline.enable_group_offload.call_args.kwargs["use_stream"])

    def test_retention_tracks_cold_load_cost_with_bounded_idle_window(self):
        self.assertEqual(retention_seconds(1), 120)
        self.assertEqual(retention_seconds(45), 180)
        self.assertEqual(retention_seconds(90), 360)
        self.assertEqual(retention_seconds(1000), 600)

    def test_reuses_identical_configuration_and_drops_replaced_model_references(self):
        torch = fake_torch()
        cache = ModelPipelineCache(torch, "cuda")
        self.assertIsNone(cache.acquire({"model": "first"}))
        pipeline = Pipeline()
        reference = weakref.ref(pipeline)
        cache.store({"pipeline": pipeline})
        del pipeline
        self.assertIs(cache.acquire({"model": "first"})["pipeline"], reference())
        self.assertIsNone(cache.acquire({"model": "second"}))
        self.assertIsNone(reference())
        torch.cuda.synchronize.assert_called()
        torch.cuda.empty_cache.assert_called()

    def test_memory_pressure_releases_cached_model_before_admission(self):
        torch = fake_torch()
        cache = ModelPipelineCache(torch, "cuda")
        cache.acquire({"model": "first"})
        pipeline = Pipeline()
        reference = weakref.ref(pipeline)
        cache.store({"pipeline": pipeline})
        del pipeline
        torch.cuda.mem_get_info.return_value = (0, 16 * 1024**3)
        with self.assertRaisesRegex(RuntimeError, "GPU out of memory"):
            cache.acquire({"model": "first"})
        self.assertIsNone(reference())
        self.assertIsNone(cache.value)

    def test_pressure_recovery_allows_new_load_without_retrying_inference(self):
        torch = fake_torch()
        cache = ModelPipelineCache(torch, "cuda")
        cache.acquire({"model": "first"})
        cache.store({"pipeline": Pipeline()})
        torch.cuda.mem_get_info.side_effect = [(0, 16 * 1024**3), (8 * 1024**3, 16 * 1024**3)]
        self.assertIsNone(cache.acquire({"model": "first"}))

    def test_mps_uses_recommended_budget_and_releases_allocator(self):
        torch = SimpleNamespace(mps=mock.Mock())
        torch.mps.recommended_max_memory.return_value = 8 * 1024**3
        torch.mps.driver_allocated_memory.return_value = 8 * 1024**3
        torch.mps.current_allocated_memory.return_value = 4 * 1024**3
        self.assertTrue(memory_snapshot(torch, "mps")["pressure"])
        ModelPipelineCache(torch, "mps").clear()
        torch.mps.synchronize.assert_called_once()
        torch.mps.empty_cache.assert_called_once()

    def test_repeated_generation_loads_once_without_reusing_prompt_or_output(self):
        torch = fake_torch()
        cache = ModelPipelineCache(torch, "cuda")
        pipeline = Pipeline()
        request = {
            "schemaVersion": worker.SCHEMA_VERSION, "model": {"architecture": "stable-diffusion-1", "digest": "first"},
            "prompt": "first prompt", "negativePrompt": "", "outputCount": 1,
            "outputFormat": "png", "modelPolicy": "fast", "seed": 1, "aspectRatio": "1:1",
        }
        addons = [{"kind": "textual-inversion", "token": "style_token", "placement": "both"}]
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            stack.enter_context(mock.patch.object(worker, "_runtime", return_value=(torch, mock.Mock())))
            stack.enter_context(mock.patch.object(worker, "_device", return_value=("cuda", "Test GPU", 16 * 1024**3)))
            stack.enter_context(mock.patch.object(worker, "_progress"))
            loader = stack.enter_context(mock.patch.object(worker, "_load_pipeline", return_value=pipeline))
            stack.enter_context(mock.patch.object(worker, "_configure_large_image_vae_decode", return_value={"device": "pipeline"}))
            apply = stack.enter_context(mock.patch.object(worker, "_apply_addons", return_value=("first prompt, style_token", "style_token", addons, [], [], [])))
            stack.enter_context(mock.patch.object(worker, "_verify_embedding_prompt_tokens"))
            stack.enter_context(mock.patch.object(worker, "_package_versions", return_value={}))
            conditioning = stack.enter_context(mock.patch("media_sd_conditioning.encode_sd_prompt_pair", return_value={}))
            first = Path(directory) / "first"
            second = Path(directory) / "second"
            third = Path(directory) / "third"
            first.mkdir()
            second.mkdir()
            third.mkdir()
            worker.generate({**request, "outputDirectory": str(first)}, cache)
            response = worker.generate({**request, "prompt": "second prompt", "seed": 2, "sampling": {"width": 768, "height": 512, "sampler": "euler"}, "outputDirectory": str(second)}, cache)
            self.assertEqual(loader.call_count, 1)
            self.assertEqual(apply.call_count, 1)
            self.assertEqual(pipeline.enable_model_cpu_offload.call_count, 1)
            self.assertEqual(pipeline.prompts, [("first prompt, style_token", "style_token"), ("second prompt, style_token", "style_token")])
            self.assertEqual(conditioning.call_args_list, [
                mock.call(pipeline, "first prompt, style_token", "style_token", "cuda"),
                mock.call(pipeline, "second prompt, style_token", "style_token", "cuda"),
            ])
            self.assertEqual(response["outputs"][0]["seed"], 2)
            self.assertEqual((response["outputs"][0]["width"], response["outputs"][0]["height"]), (768, 512))
            self.assertTrue((first / "output-0000.png").is_file())
            self.assertTrue((second / "output-0000.png").is_file())
            worker.generate({**request, "sampling": {"width": 1280, "height": 640}, "outputDirectory": str(third)}, cache)
            self.assertEqual(loader.call_count, 2)
            cache.clear()

    def test_server_releases_models_on_error_and_end_of_input(self):
        for command, failure in ((command, failure) for command in ("generate", "generate-video")
                                 for failure in (None, RuntimeError("HIP out of memory"), ValueError("broken generation"))):
            with self.subTest(command=command, failure=failure):
                torch = fake_torch()
                references = []

                def generate(request, cache):
                    cache.acquire({"model": "test"})
                    pipeline = Pipeline()
                    references.append(weakref.ref(pipeline))
                    cache.store({"pipeline": pipeline})
                    if failure is not None:
                        raise failure
                    return {"schemaVersion": worker.SCHEMA_VERSION}

                runtime = SimpleNamespace(_runtime=lambda: (torch, None), _device=lambda torch: ("cuda", "GPU", 16 * 1024**3),
                                          generate=generate, generate_video=generate, PROCESS_STARTED_AT=0)
                stdin = SimpleNamespace(buffer=io.BytesIO((json.dumps({"command": command, "request": {}}) + "\n").encode()))
                stdout = io.StringIO()
                with mock.patch("sys.stdin", stdin), mock.patch("sys.stdout", stdout), mock.patch("sys.stderr", io.StringIO()):
                    code = serve(runtime)
                self.assertEqual(code, 0 if failure is None else 2)
                if failure is not None:
                    failure.__traceback__ = None
                import gc
                gc.collect()
                self.assertIsNone(references[0]())
                torch.cuda.empty_cache.assert_called()
                if is_gpu_out_of_memory(failure or Exception()):
                    self.assertEqual(json.loads(stdout.getvalue())["error"], GPU_MEMORY_ERROR)

    def test_flux_variants_offload_blocks_before_generation_on_a_16_gib_gpu(self):
        for architecture in ("flux-1",):
            with self.subTest(architecture=architecture), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                torch = fake_torch()
                pipeline = Pipeline()
                pipeline.enable_group_offload = mock.Mock()
                parameter = SimpleNamespace(numel=lambda: 20 * 1024**3, element_size=lambda: 1)
                pipeline.components = {"transformer": SimpleNamespace(parameters=lambda: [parameter])}
                stack.enter_context(mock.patch.object(worker, "_physical_memory_bytes", return_value=32 * 1024**3))
                stack.enter_context(mock.patch.object(worker, "_runtime", return_value=(torch, mock.Mock())))
                stack.enter_context(mock.patch.object(worker, "_device", return_value=("cuda", "Test GPU", 16 * 1024**3)))
                stack.enter_context(mock.patch.object(worker, "_progress"))
                stack.enter_context(mock.patch.object(worker, "_load_pipeline", return_value=pipeline))
                stack.enter_context(mock.patch.object(worker, "_configure_large_image_vae_decode", return_value={"device": "pipeline"}))
                stack.enter_context(mock.patch.object(worker, "_package_versions", return_value={}))
                request = {
                    "schemaVersion": worker.SCHEMA_VERSION,
                    "model": {"architecture": architecture, "digest": "flux"},
                    "prompt": "A ceramic teapot", "negativePrompt": "", "outputCount": 1,
                    "outputFormat": "png", "modelPolicy": "quality", "seed": 1,
                    "aspectRatio": "1:1", "outputDirectory": directory,
                }
                response = worker.generate(request)
                pipeline.enable_model_cpu_offload.assert_not_called()
                pipeline.enable_group_offload.assert_called_once_with(
                    onload_device=torch.device("cuda", 0), offload_device=torch.device("cpu"),
                    offload_type="block_level", num_blocks_per_group=1,
                    non_blocking=False, use_stream=False, record_stream=False, low_cpu_mem_usage=False,
                )
                self.assertEqual(response["outputs"][0]["seed"], 1)

    def test_quantized_flux_components_offload_as_complete_models(self):
        for architecture in ("flux-1-dev", "flux-1-schnell"):
            with self.subTest(architecture=architecture), tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
                torch = fake_torch()
                pipeline = Pipeline()
                pipeline.enable_group_offload = mock.Mock()
                stack.enter_context(mock.patch.object(worker, "_runtime", return_value=(torch, mock.Mock())))
                stack.enter_context(mock.patch.object(worker, "_device", return_value=("cuda", "Test GPU", 16 * 1024**3)))
                stack.enter_context(mock.patch.object(worker, "_progress"))
                stack.enter_context(mock.patch.object(worker, "_load_pipeline", return_value=pipeline))
                stack.enter_context(mock.patch.object(worker, "_configure_large_image_vae_decode", return_value={"device": "pipeline"}))
                stack.enter_context(mock.patch.object(worker, "_package_versions", return_value={}))
                response = worker.generate({"schemaVersion": worker.SCHEMA_VERSION, "model": {"architecture": architecture, "digest": "flux"}, "prompt": "A ceramic teapot", "negativePrompt": "", "outputCount": 1, "outputFormat": "png", "modelPolicy": "quality", "seed": 1, "aspectRatio": "1:1", "outputDirectory": directory})
                pipeline.enable_group_offload.assert_not_called()
                pipeline.enable_model_cpu_offload.assert_called_once_with(gpu_id=0, device="cuda")
                self.assertEqual(response["outputs"][0]["seed"], 1)

    def test_oom_detection_does_not_classify_unrelated_words(self):
        for diagnostic in ("CUDA out of memory", "HIP out of memory", "MPS backend out of memory", "hipErrorOutOfMemory"):
            self.assertTrue(is_gpu_out_of_memory(RuntimeError(diagnostic)))
        self.assertFalse(is_gpu_out_of_memory(ValueError("Choose a room image")))


if __name__ == "__main__":
    unittest.main()
