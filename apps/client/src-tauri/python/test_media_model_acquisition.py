import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from media_wan_loading import load_wan_transformer, wan_model_paths
from media_svg_model import extract_svg, generate


class ModelAcquisitionTests(unittest.TestCase):
    def test_single_checkpoint_uses_offline_components_without_base_transformer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            checkpoint = root / "custom.safetensors"
            checkpoint.touch()
            config = root / "config"
            for name in ["model_index.json", "transformer/config.json", "text_encoder/model.safetensors.index.json", "vae/diffusion_pytorch_model.safetensors", "scheduler/scheduler_config.json"]:
                path = config / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.touch()
            model = {"packageKind": "single-file", "path": str(checkpoint), "configPath": str(config)}
            self.assertEqual(wan_model_paths(model), (config, checkpoint))
            transformer = Mock()
            load_wan_transformer(SimpleNamespace(WanTransformer3DModel=transformer), SimpleNamespace(bfloat16="bf16"), config, checkpoint)
            transformer.from_pretrained.assert_not_called()
            transformer.from_single_file.assert_called_once_with(str(checkpoint), config=str(config / "transformer"), torch_dtype="bf16", local_files_only=True, low_cpu_mem_usage=True)
            (config / "vae/diffusion_pytorch_model.safetensors").unlink()
            with self.assertRaisesRegex(ValueError, "incomplete"):
                wan_model_paths(model)

    def test_directory_uses_native_diffusers_loader(self):
        transformer = Mock()
        load_wan_transformer(SimpleNamespace(WanTransformer3DModel=transformer), SimpleNamespace(bfloat16="bf16"), Path("model"), None)
        transformer.from_single_file.assert_not_called()
        self.assertTrue(transformer.from_pretrained.call_args.kwargs["local_files_only"])

    def test_missing_checkpoint_components_and_unsupported_packages_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = Path(directory) / "model.safetensors"
            checkpoint.touch()
            with self.assertRaisesRegex(ValueError, "components are missing"):
                wan_model_paths({"path": str(checkpoint), "packageKind": "single-file"})
            with self.assertRaisesRegex(ValueError, "Unsupported"):
                wan_model_paths({"path": str(checkpoint), "packageKind": "gguf"})

    def test_svg_generation_extracts_document_and_rejects_truncated_outputs(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>'
        self.assertEqual(extract_svg("```svg\n" + svg + "\n```"), svg)
        with self.assertRaisesRegex(ValueError, "no complete SVG"):
            extract_svg("<svg><circle")

    def test_svg_candidate_limit_is_validated_before_loading_weights(self):
        for count in (0, 7, True, "2"):
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, "one and six"):
                generate({"candidateCount": count}, Mock())


if __name__ == "__main__":
    unittest.main()
