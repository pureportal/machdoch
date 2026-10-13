from pathlib import Path
from contextlib import ExitStack
import json
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import torch
import safetensors.torch as safe_torch
from safetensors.torch import save_file

import media_diffusers_worker as worker


class KreaCheckpointLoadingTests(unittest.TestCase):
    def test_krea_fractional_guidance_encodes_negative_prompts_and_rejects_withheld_outputs(self):
        from PIL import Image

        class Pipeline:
            def __init__(self):
                self.scheduler = SimpleNamespace(config={})
                self.arguments = None
                self.blocked = False

            def __call__(self, guidance_scale=3.5, negative_prompt=None, **arguments):
                self.arguments = {**arguments, "guidance_scale": guidance_scale,
                                  "negative_prompt": negative_prompt}
                return SimpleNamespace(images=[Image.new("RGB", (512, 512), "red")],
                                       nsfw_content_detected=[self.blocked])

        embeddings = torch.arange(12).reshape(2, 2, 3)
        masks = torch.ones(2, 2)
        cpu = torch.device("cpu")
        for architecture in ("krea-2-raw", "krea-2"):
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                checkpoint = root / "checkpoint.safetensors"
                checkpoint.touch()
                (root / "images").mkdir()
                request = {"schemaVersion": 5, "model": {
                    "id": "test:krea", "architecture": architecture, "packageKind": "single-file",
                    "path": str(checkpoint), "configPath": str(root), "revision": "test", "digest": "a" * 64,
                }, "prompt": "A red teapot", "negativePrompt": "blurry", "outputCount": 1,
                    "outputFormat": "png", "modelPolicy": "quality", "aspectRatio": "1:1", "seed": 42,
                    "outputDirectory": str(root / "images"), "modelCacheDirectory": str(root / "cache"),
                    "sampling": {"guidanceScale": 0.5, "width": 512, "height": 512, "numInferenceSteps": 40}}
                encode = Mock(return_value=(embeddings, masks))
                pipeline = Pipeline()
                with ExitStack() as patches:
                    for name, value in {
                        "_runtime": (torch, SimpleNamespace()), "_device": ("cpu", "CPU", None),
                        "_configure_amd_convolution_backend": "test", "_load_pipeline": pipeline,
                        "_krea_runtime_paths": (root, root),
                        "_load_image_conditioning": SimpleNamespace(encode_krea_prompts=encode),
                        "_configure_large_image_vae_decode": {"device": "cuda"},
                        "_apply_addons": ("A red teapot", "blurry", [], [], [], []),
                        "_configure_krea_offload": {}, "_package_versions": {}, "_progress": None,
                        "_validate_generated_pixels": None,
                    }.items():
                        patches.enter_context(patch.object(worker, name, return_value=value))
                    patches.enter_context(patch.object(torch.cuda, "current_device", return_value=0))
                    patches.enter_context(patch.object(torch, "device", return_value=cpu))
                    result = worker.generate(request)
                    pipeline.blocked = True
                    withheld_directory = root / "withheld"
                    withheld_directory.mkdir()
                    request["outputDirectory"] = str(withheld_directory)
                    with self.assertRaisesRegex(worker.WorkerError, "model withheld an image"):
                        worker.generate(request)
                    self.assertEqual(list(withheld_directory.iterdir()), [])
                self.assertEqual(encode.call_args.args[2], ["A red teapot", "blurry"])
                self.assertEqual(pipeline.arguments["guidance_scale"], 0.5)
                self.assertTrue(torch.equal(pipeline.arguments["negative_prompt_embeds"], embeddings[1:]))
                self.assertTrue(torch.equal(pipeline.arguments["negative_prompt_embeds_mask"], masks[1:]))
                self.assertEqual(result["outputs"][0]["seed"], 42)

    def test_auto_uses_cpu_groups_on_a_host_with_sufficient_memory(self):
        def transformer():
            model = torch.nn.Module()
            model.img_in = torch.nn.Linear(2, 2, bias=False)
            return model

        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.safetensors"
            expected = torch.tensor([[1.0, -2.0], [3.0, 4.0]], dtype=torch.bfloat16)
            save_file({"first.weight": expected}, str(checkpoint))
            model = worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)
            pipeline = SimpleNamespace(transformer=model, enable_group_offload=Mock())
            cpu = torch.device("cpu")
            with patch.object(torch.cuda, "current_device", return_value=0), \
                    patch.object(worker, "_physical_memory_bytes", return_value=64 * 1024**3), \
                    patch.object(torch, "device", return_value=cpu):
                evidence = worker._configure_krea_offload(pipeline, torch, {"path": str(checkpoint), "digest": "b" * 64}, [], "auto", Path(temporary) / "cache")
            checkpoint.unlink()
            self.assertEqual(evidence["offloadType"], "block-level-cpu")
            self.assertEqual(evidence["effectiveMemoryProfile"], "balanced")
            pipeline.enable_group_offload.assert_called_once()
            self.assertEqual(pipeline.enable_group_offload.call_args.kwargs["num_blocks_per_group"], 1)
            self.assertFalse(hasattr(model.img_in.weight, "_machdoch_krea_source"))
            torch.testing.assert_close(model.img_in(expected), expected @ expected.T)

    def test_small_hosts_use_disk_groups_without_relying_on_free_gpu_memory(self):
        for memory in (None, 32 * 1024**3):
            with self.subTest(physical_memory=memory), tempfile.TemporaryDirectory() as temporary:
                model = torch.nn.Linear(2, 2)
                def offload(**arguments):
                    save_file({"weight": model.weight}, str(Path(arguments["offload_to_disk_path"]) / "group_fixture.safetensors"))
                pipeline = SimpleNamespace(transformer=model, enable_group_offload=offload)
                with patch.object(worker, "_physical_memory_bytes", return_value=memory), \
                        patch.object(worker.tempfile, "gettempdir", return_value=temporary), \
                        patch.object(worker, "_install_windows_krea_disk_offload_fixes", return_value=False), \
                        patch.object(torch.cuda, "current_device", return_value=0), \
                        patch.object(torch.cuda, "mem_get_info") as memory_info:
                    evidence = worker._configure_krea_offload(pipeline, torch, {"digest": "c" * 64}, [], "auto", Path(temporary) / "cache")
                memory_info.assert_not_called()
                self.assertEqual(evidence["offloadType"], "block-level-disk")

    def test_undeclared_integer_quantization_is_rejected_before_reading_weights(self):
        from fizgig.utils.safetensors import MemoryEfficientSafeOpen

        def transformer():
            model = torch.nn.Module()
            model.img_in = torch.nn.Linear(2, 2, bias=False)
            return model

        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.safetensors"
            save_file({"first.weight": torch.ones(2, 2, dtype=torch.int8)}, str(checkpoint))
            with patch.object(MemoryEfficientSafeOpen, "get_tensor", side_effect=AssertionError("weight read")):
                with self.assertRaisesRegex(worker.WorkerError, "no scale metadata"):
                    worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)

    def test_declared_int8_row_scales_work_with_a_real_lora_adapter(self):
        from peft import LoraConfig, inject_adapter_in_model

        def transformer():
            model = torch.nn.Module()
            model.img_in = torch.nn.Linear(2, 2, bias=False)
            return model

        configuration = {"format": "int8_tensorwise", "orig_dtype": "torch.bfloat16"}
        marker = torch.tensor(list(json.dumps({**configuration, "per_row": True}).encode()), dtype=torch.uint8)
        weights = torch.tensor([[3, -2], [4, 5]], dtype=torch.int8)
        scales = torch.tensor([[0.1371], [0.7134]], dtype=torch.float32)
        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "int8.safetensors"
            save_file({"first.weight": weights, "first.weight_scale": scales, "first.comfy_quant": marker}, str(checkpoint), metadata={"_quantization_metadata": json.dumps({"layers": {"first": configuration}})})
            model = worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)
            inject_adapter_in_model(LoraConfig(r=1, lora_alpha=1, target_modules=["img_in"]), model, adapter_name="style")
            worker._materialize_krea_transformer(model)
            checkpoint.unlink()
            adapter = model.img_in
            with torch.no_grad():
                adapter.lora_A["style"].weight.copy_(torch.tensor([[0.25, -0.5]]))
                adapter.lora_B["style"].weight.copy_(torch.tensor([[0.5], [-0.25]]))
            inputs = torch.tensor([[0.5, 1.0]], dtype=torch.bfloat16)
            expected_weight = (weights.float() * scales).to(torch.bfloat16)
            expected = torch.nn.functional.linear(inputs, expected_weight)
            delta = torch.nn.functional.linear(torch.nn.functional.linear(inputs.float(), adapter.lora_A["style"].weight), adapter.lora_B["style"].weight)
            self.assertEqual(adapter.base_layer.weight.dtype, torch.int8)
            self.assertTrue(torch.equal(adapter(inputs), (expected.float() + delta).to(torch.bfloat16)))

    def test_int8_rejects_invalid_scales_and_rotation_metadata(self):
        def transformer():
            model = torch.nn.Module()
            model.img_in = torch.nn.Linear(2, 2, bias=False)
            return model

        for scale, extra, expected in [
            (torch.ones(1, 2), {}, "invalid weight scale"),
            (torch.tensor([[1.0], [float("nan")]]), {}, "invalid weight scale"),
            (torch.tensor([[1.0], [0.0]]), {}, "invalid weight scale"),
            (torch.ones(2, 1, dtype=torch.bfloat16), {}, "invalid weight scale"),
            (torch.ones(2, 1), {"convrot": True}, "unsupported quantization transforms"),
            (torch.ones(2, 1), {"params": {"convrot": True}}, "unsupported quantization transforms"),
            (torch.ones(2, 1), {"format": "asym_w4a8_int8"}, "unsupported quantization"),
        ]:
            with self.subTest(extra=extra, scale=scale), tempfile.TemporaryDirectory() as temporary:
                checkpoint = Path(temporary) / "invalid.safetensors"
                configuration = {"format": "int8_tensorwise", **extra}
                save_file({"first.weight": torch.ones(2, 2, dtype=torch.int8), "first.weight_scale": scale}, str(checkpoint), metadata={"_quantization_metadata": json.dumps({"layers": {"first": configuration}})})
                with self.assertRaisesRegex(worker.WorkerError, expected):
                    worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)

    def test_single_file_krea_raw_keeps_classifier_free_guidance_enabled(self):
        for architecture, distilled in [("krea-2-raw", False), ("krea-2-turbo", True)]:
            with self.subTest(architecture=architecture), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                constructor = Mock(return_value=SimpleNamespace(vae=Mock()))
                diffusers = SimpleNamespace(AutoencoderKLQwenImage=SimpleNamespace(from_pretrained=Mock()), FlowMatchEulerDiscreteScheduler=Mock(), Krea2Pipeline=constructor)
                with patch.object(worker, "_krea_runtime_paths", return_value=(root, root)), patch.object(worker, "_load_krea_transformer", return_value=Mock()), patch.object(torch.cuda, "is_bf16_supported", return_value=True), patch.object(torch.cuda, "current_device", return_value=0), patch.object(torch.version, "hip", "test"):
                    worker._load_krea_pipeline(diffusers, torch, {"architecture": architecture, "configPath": str(root)}, root / "weights.safetensors")
                self.assertEqual(constructor.call_args.kwargs["is_distilled"], distilled)

    def test_published_fp8_metadata_preserves_full_precision_matrix_multiplication(self):
        from media_krea_quantization import dequantized_linear_forward

        def transformer():
            model = torch.nn.Module()
            model.img_in = torch.nn.Linear(2, 2, bias=False)
            return model

        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "official.safetensors"
            weights = torch.tensor([[1.0, -2.0], [3.0, 4.0]])
            save_file({"first.weight": weights.to(torch.float8_e4m3fn), "first.weight_scale": torch.tensor(0.5)}, str(checkpoint), metadata={"_quantization_metadata": json.dumps({"layers": {"first": {"format": "float8_e4m3fn", "full_precision_matrix_mult": True}}})})
            model = worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)
            worker._materialize_krea_transformer(model)
            self.assertIs(model.img_in.forward.__func__, dequantized_linear_forward)
            inputs = torch.tensor([[0.5, 1.0]], dtype=torch.bfloat16)
            expected = torch.nn.functional.linear(inputs, weights.to(torch.bfloat16) * 0.5)
            self.assertTrue(torch.equal(model.img_in(inputs), expected))

    def test_diffusers_loads_owned_tensors_without_mapping_the_checkpoint(self):
        from diffusers.models.model_loading_utils import load_state_dict

        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.safetensors"
            expected = torch.tensor([[1.0, -2.0]], dtype=torch.float16)
            save_file({"weight": expected}, str(checkpoint))
            with patch.object(safe_torch, "load_file", safe_torch.load_file), \
                    patch.object(worker.os, "name", "nt"), \
                    patch("safetensors.safe_open", side_effect=AssertionError("whole-file mapping")), \
                    patch("numpy.memmap", side_effect=AssertionError("tensor mapping")):
                worker._runtime()
                tensors = load_state_dict(checkpoint)
            checkpoint.unlink()
            self.assertTrue(torch.equal(tensors["weight"], expected))

    def test_disk_offload_reads_own_their_memory(self):
        from diffusers.hooks.group_offloading import ModuleGroup

        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "group.safetensors"
            expected = torch.tensor([1.0, -2.0], dtype=torch.bfloat16)
            save_file({"weight": expected}, str(checkpoint))
            with patch.object(worker.os, "name", "nt"), \
                    patch.object(safe_torch, "load_file", safe_torch.load_file), \
                    patch.object(ModuleGroup, "_offload_to_disk", ModuleGroup._offload_to_disk), \
                    patch("safetensors.safe_open", side_effect=AssertionError("whole-file mapping")), \
                    patch("numpy.memmap", side_effect=AssertionError("tensor mapping")):
                self.assertTrue(worker._install_windows_krea_disk_offload_fixes(torch))
                tensors = safe_torch.load_file(str(checkpoint), device="cpu")
            checkpoint.unlink()
            self.assertTrue(torch.equal(tensors["weight"], expected))

    def test_checkpoint_reads_own_their_memory_and_preserve_quantization(self):
        def transformer():
            model = torch.nn.Module()
            model.img_in = torch.nn.Linear(2, 2, bias=False)
            return model

        weights = torch.tensor([[1.0, -2.0], [3.0, 4.0]])
        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.safetensors"
            for dtype in (torch.bfloat16, torch.float8_e4m3fn):
                with self.subTest(dtype=dtype):
                    tensors = {"first.weight": weights.to(dtype)}
                    if dtype == torch.float8_e4m3fn:
                        tensors["first.weight_scale"] = torch.tensor(0.5)
                        tensors["first.comfy_quant"] = torch.tensor(
                            list(json.dumps({"format": "float8_e4m3fn"}).encode()),
                            dtype=torch.uint8,
                        )
                    save_file(tensors, str(checkpoint))
                    with patch("safetensors.safe_open", side_effect=AssertionError("whole-file mapping")), \
                            patch("numpy.memmap", side_effect=AssertionError("tensor mapping")):
                        model = worker._load_krea_transformer(
                            SimpleNamespace(Krea2Transformer2DModel=transformer),
                            torch,
                            checkpoint,
                        )
                        self.assertEqual(model.img_in.weight.numel(), 0)
                        worker._materialize_krea_transformer(model)
                    checkpoint.unlink()
                    self.assertEqual(model.img_in.weight.dtype, dtype)
                    self.assertTrue(torch.equal(model.img_in.weight.float(), weights))
                    if dtype == torch.float8_e4m3fn:
                        self.assertEqual(model.img_in._machdoch_weight_scale.item(), 0.5)
                        self.assertIs(model.img_in.forward.__func__, worker._krea_scaled_fp8_linear_forward)
                    else:
                        expected = weights @ weights.T
                        self.assertTrue(torch.equal(model.img_in(weights.to(torch.bfloat16)).float(), expected))

    def test_disk_offload_materializes_one_block_at_a_time_and_reuses_saved_weights(self):
        from diffusers.hooks.group_offloading import ModuleGroup
        from fizgig.utils.safetensors import MemoryEfficientSafeOpen

        def transformer():
            model = torch.nn.Module()
            model.transformer_blocks = torch.nn.ModuleList()
            for _ in range(2):
                block = torch.nn.Module()
                block.attn = torch.nn.Module()
                block.attn.to_q = torch.nn.Linear(2, 2, bias=False)
                model.transformer_blocks.append(block)
            return model

        def groups(model, directory):
            return [ModuleGroup(
                modules=[block], offload_device=torch.device("cpu"), onload_device=torch.device("cpu"),
                offload_leader=block, onload_leader=block, offload_to_disk_path=str(directory),
                group_id=f"block-{index}",
            ) for index, block in enumerate(model.transformer_blocks)]

        weights = {f"blocks.{index}.attn.wq.weight": torch.full((2, 2), index + 1.0, dtype=torch.bfloat16)
                   for index in range(2)}
        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.safetensors"
            save_file(weights, str(checkpoint))
            with patch.object(safe_torch, "load_file", safe_torch.load_file), \
                    patch.object(ModuleGroup, "_offload_to_disk", ModuleGroup._offload_to_disk), \
                    patch.object(torch.accelerator, "current_accelerator", return_value=torch.device("cpu")):
                with patch.object(worker.os, "name", "nt"):
                    self.assertTrue(worker._install_windows_krea_disk_offload_fixes(torch))
                with patch.object(MemoryEfficientSafeOpen, "get_tensor", side_effect=AssertionError("eager weight read")):
                    model = worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)
                offload_groups = groups(model, Path(temporary) / "offload")
                original_read = MemoryEfficientSafeOpen.get_tensor
                with patch.object(MemoryEfficientSafeOpen, "get_tensor", autospec=True, side_effect=original_read) as reader:
                    for index, group in enumerate(offload_groups):
                        reader.reset_mock()
                        group.offload_()
                        self.assertEqual([call.args[1] for call in reader.call_args_list], [f"blocks.{index}.attn.wq.weight"])
                        self.assertTrue(all(parameter.numel() == 0 for parameter in model.parameters()))
                with patch.object(MemoryEfficientSafeOpen, "get_tensor", side_effect=AssertionError("cached checkpoint read")):
                    cached = worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)
                    cached_groups = groups(cached, Path(temporary) / "offload")
                    for group in cached_groups:
                        group.offload_()
                checkpoint.unlink()
                for group in cached_groups:
                    group.onload_()
                for index, block in enumerate(cached.transformer_blocks):
                    self.assertTrue(torch.equal(block.attn.to_q.weight, weights[f"blocks.{index}.attn.wq.weight"]))

    def test_lora_adapters_preserve_deferred_base_weights(self):
        from peft import LoraConfig, inject_adapter_in_model

        def transformer():
            model = torch.nn.Module()
            model.img_in = torch.nn.Linear(2, 2, bias=False)
            return model

        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.safetensors"
            expected = torch.tensor([[1.0, -2.0], [3.0, 4.0]], dtype=torch.bfloat16)
            save_file({"first.weight": expected}, str(checkpoint))
            model = worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)
            inject_adapter_in_model(LoraConfig(r=1, target_modules=["img_in"]), model, adapter_name="test")
            worker._materialize_krea_transformer(model)
            checkpoint.unlink()
            self.assertTrue(torch.equal(model.img_in.base_layer.weight, expected))
            self.assertTrue(torch.equal(model.img_in(expected).detach(), expected @ expected.T))

    def test_native_disk_offload_receives_materialized_weights(self):
        def transformer():
            model = torch.nn.Module()
            model.img_in = torch.nn.Linear(2, 2, bias=False)
            return model

        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.safetensors"
            expected = torch.tensor([[1.0, -2.0], [3.0, 4.0]], dtype=torch.bfloat16)
            save_file({"first.weight": expected}, str(checkpoint))
            model = worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)
            observed = []

            def enable_group_offload(**arguments):
                observed.append(model.img_in.weight.detach().clone())
                save_file({"weight": model.img_in.weight}, str(Path(arguments["offload_to_disk_path"]) / "group_ab.safetensors"))

            pipeline = SimpleNamespace(transformer=model, enable_group_offload=enable_group_offload)
            with patch.object(worker, "_install_windows_krea_disk_offload_fixes", return_value=False), \
                    patch.object(torch.cuda, "current_device", return_value=0):
                worker._configure_krea_offload(
                    pipeline, torch, {"path": str(checkpoint), "digest": "a" * 64}, [], "memory-saver",
                    Path(temporary) / "cache",
                )
            self.assertEqual(len(observed), 1)
            self.assertTrue(torch.equal(observed[0], expected))
            self.assertFalse(hasattr(model.img_in.weight, "_machdoch_krea_source"))

    def test_flattened_modulation_rejects_incompatible_shapes_before_reading_weights(self):
        from fizgig.utils.safetensors import MemoryEfficientSafeOpen

        def transformer():
            model = torch.nn.Module()
            model.final_layer = torch.nn.Module()
            model.final_layer.scale_shift_table = torch.nn.Parameter(torch.empty(2, 6144))
            return model

        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "checkpoint.safetensors"
            save_file({"last.modulation.lin": torch.zeros(12289, dtype=torch.bfloat16)}, str(checkpoint))
            with patch.object(MemoryEfficientSafeOpen, "get_tensor", side_effect=AssertionError("weight read")):
                with self.assertRaisesRegex(worker.WorkerError, "incompatible shape"):
                    worker._load_krea_transformer(SimpleNamespace(Krea2Transformer2DModel=transformer), torch, checkpoint)


if __name__ == "__main__":
    unittest.main()
