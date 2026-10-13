import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import media_hunyuan_image3 as hunyuan


class HunyuanImage3Tests(unittest.TestCase):
    def test_scheduler_access_initializes_the_publishers_lazy_pipeline(self):
        original = object()

        class LazyPublisherModel:
            def __init__(self):
                self.vae = object()
                self._pipeline = None

            @property
            def pipeline(self):
                if self._pipeline is None:
                    self.scheduler = original
                    self._pipeline = SimpleNamespace(scheduler=self.scheduler)
                return self._pipeline

        model = LazyPublisherModel()
        pipeline = hunyuan.HunyuanImage3Pipeline(model)
        self.assertFalse(hasattr(model, "scheduler"))
        self.assertIs(pipeline.scheduler, original)
        replacement = object()
        pipeline.scheduler = replacement
        self.assertIs(model.scheduler, replacement)
        self.assertIs(model.pipeline.scheduler, replacement)

        fresh_model = LazyPublisherModel()
        fresh_pipeline = hunyuan.HunyuanImage3Pipeline(fresh_model)
        fresh_pipeline.scheduler = replacement
        self.assertIs(fresh_model.scheduler, replacement)
        self.assertIs(fresh_model.pipeline.scheduler, replacement)

    def test_loader_retains_publisher_expert_routing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model_root = root / "model"
            model_root.mkdir()
            (model_root / "config.json").write_text(json.dumps({
                "model_type": "hunyuan_image_3_moe", "model_version": "HunyuanImage-3.0",
                "moe_drop_tokens": False,
            }))
            (model_root / "model.safetensors.index.json").write_text(json.dumps({
                "metadata": {"total_size": 160 * 1024**3},
            }))
            model = SimpleNamespace(vae=object(), scheduler=object(), load_tokenizer=Mock())
            loader = Mock(return_value=model)
            runtime = SimpleNamespace(HunyuanImage3ForCausalMM=SimpleNamespace(from_pretrained=loader))
            with patch("torch.cuda.device_count", return_value=1), \
                    patch("torch.cuda.get_device_properties", return_value=SimpleNamespace(total_memory=256 * 1024**3)), \
                    patch.dict("sys.modules", {"hunyuan_image_3.modeling_hunyuan_image_3": runtime}):
                pipeline = hunyuan.HunyuanImage3Pipeline.from_pretrained(root, "bf16")
            self.assertIs(pipeline.model, model)
            self.assertNotIn("moe_drop_tokens", loader.call_args.kwargs)
            self.assertTrue(loader.call_args.kwargs["local_files_only"])
            model.load_tokenizer.assert_called_once_with(str(model_root))

    def test_native_call_preserves_dimensions_steps_guidance_and_seed(self):
        image = object()
        model = SimpleNamespace(vae=object(), scheduler=object(), pipeline=SimpleNamespace(), generate_image=Mock(return_value=("", [image])))
        pipeline = hunyuan.HunyuanImage3Pipeline(model)
        result = pipeline(prompt="A city", width=1344, height=768, num_inference_steps=50, guidance_scale=5, generator=SimpleNamespace(initial_seed=lambda: 17982165))
        self.assertEqual(result.images, [image])
        arguments = model.generate_image.call_args.kwargs
        self.assertEqual((arguments["image_size"], arguments["diff_infer_steps"], arguments["diff_guidance_scale"], arguments["seed"]), ((768, 1344), 50, 5, 17982165))
        scheduler = object()
        pipeline.scheduler = scheduler
        self.assertIs(model.scheduler, scheduler)
        self.assertIs(model.pipeline.scheduler, scheduler)

    def test_rejects_hunyuan_21_and_checks_memory_before_loading_weights(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = root / "model"
            model.mkdir()
            (model / "config.json").write_text(json.dumps({"model_type": "hunyuan_image_3_moe", "model_version": "HunyuanImage-2.1"}))
            with self.assertRaisesRegex(ValueError, "original HunyuanImage 3.0"):
                hunyuan.validate_package(root)
            (model / "config.json").write_text(json.dumps({"model_type": "hunyuan_image_3_moe", "model_version": "HunyuanImage-3.0"}))
            (model / "model.safetensors.index.json").write_text(json.dumps({"metadata": {"total_size": 160 * 1024**3}}))
            with patch("torch.cuda.device_count", return_value=1), patch("torch.cuda.get_device_properties", return_value=SimpleNamespace(total_memory=16 * 1024**3)):
                with self.assertRaisesRegex(ValueError, "GPU memory"):
                    hunyuan.HunyuanImage3Pipeline.from_pretrained(root, None)


if __name__ == "__main__":
    unittest.main()
