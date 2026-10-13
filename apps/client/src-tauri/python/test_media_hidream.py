import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import media_hidream


class HiDreamTests(unittest.TestCase):
    def test_quantized_components_are_staged_on_cpu_before_loading_the_next(self):
        events = []
        classes = {}
        for name in ("transformer", "text_encoder_3", "text_encoder_4"):
            component = SimpleNamespace(to=lambda device, name=name: events.append((name, device)))

            def load_component(*args, name=name, component=component, **kwargs):
                events.append((name, "load"))
                return component

            classes[name] = SimpleNamespace(from_pretrained=Mock(side_effect=load_component))
        pipeline_class = SimpleNamespace(from_pretrained=Mock(return_value="pipeline"))
        diffusers = SimpleNamespace(HiDreamImageTransformer2DModel=classes["transformer"], HiDreamImagePipeline=pipeline_class)
        with tempfile.TemporaryDirectory() as temporary, patch.object(media_hidream, "T5EncoderModel", classes["text_encoder_3"]), patch.object(media_hidream, "LlamaForCausalLM", classes["text_encoder_4"]), patch.object(media_hidream.torch.cuda, "is_available", return_value=True), patch.object(media_hidream.torch.cuda, "current_device", return_value=0), patch.object(media_hidream.torch.cuda, "empty_cache") as release:
            root = Path(temporary)
            for name in classes:
                (root / name).mkdir()
                (root / name / "config.json").write_text(json.dumps({"quantization_config": {"quant_method": "bitsandbytes"}}))
            result = media_hidream.load_pipeline(diffusers, root, "bf16")
            self.assertEqual(result, "pipeline")
            self.assertEqual(events, [(name, operation) for name in classes for operation in ("load", "cpu")])
            self.assertEqual(release.call_count, 3)
            for name, factory in classes.items():
                factory.from_pretrained.assert_called_once_with(str(root / name), dtype="bf16", local_files_only=True, use_safetensors=True, trust_remote_code=False, device_map={"": 0})
            self.assertEqual(set(pipeline_class.from_pretrained.call_args.kwargs) & set(classes), set(classes))

    def test_quantized_packages_fail_before_loading_without_a_gpu(self):
        factory = Mock()
        diffusers = SimpleNamespace(HiDreamImageTransformer2DModel=factory)
        with tempfile.TemporaryDirectory() as temporary, patch.object(media_hidream.torch.cuda, "is_available", return_value=False):
            root = Path(temporary)
            (root / "transformer").mkdir()
            (root / "transformer/config.json").write_text(json.dumps({"quantization_config": {"quant_method": "bitsandbytes"}}))
            with self.assertRaisesRegex(ValueError, "supported GPU"):
                media_hidream.load_pipeline(diffusers, root, "bf16")
            factory.from_pretrained.assert_not_called()


if __name__ == "__main__":
    unittest.main()
