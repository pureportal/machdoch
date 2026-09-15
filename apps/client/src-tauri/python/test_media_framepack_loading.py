import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys

import torch
from transformers import LlamaConfig, LlamaModel

from media_framepack_loading import load_prompt_encoder


class FramePackPromptLoadingTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(72526043)
        self.encoder = (
            LlamaModel(
                LlamaConfig(
                    vocab_size=96,
                    hidden_size=32,
                    intermediate_size=64,
                    num_hidden_layers=2,
                    num_attention_heads=4,
                    num_key_value_heads=2,
                    max_position_embeddings=128,
                    rope_theta=500000.0,
                )
            )
            .half()
            .eval()
        )

    def test_streamed_shards_preserve_all_parameters_and_prompt_encoding(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.encoder.save_pretrained(directory, max_shard_size="20KB")
            loaded = load_prompt_encoder(directory, torch)
            expected = self.encoder.bfloat16()
            self.assertFalse(loaded.training)
            for name, tensor in loaded.state_dict().items():
                self.assertEqual(tensor.dtype, torch.bfloat16)
                self.assertTrue(torch.equal(tensor, expected.state_dict()[name]), name)
            with torch.inference_mode():
                tokens = torch.tensor([[1, 22, 31, 2]])
                torch.testing.assert_close(
                    loaded(tokens).last_hidden_state, expected(tokens).last_hidden_state
                )

    def test_missing_weights_and_unsafe_shard_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.encoder.save_pretrained(directory, max_shard_size="20KB")
            path = directory / "model.safetensors.index.json"
            original = json.loads(path.read_text())
            missing = json.loads(path.read_text())
            missing["weight_map"].pop(next(iter(missing["weight_map"])))
            path.write_text(json.dumps(missing))
            with self.assertRaisesRegex(ValueError, "model configuration"):
                load_prompt_encoder(directory, torch)
            original["weight_map"][
                next(iter(original["weight_map"]))
            ] = "../outside.safetensors"
            path.write_text(json.dumps(original))
            with self.assertRaisesRegex(ValueError, "invalid shard"):
                load_prompt_encoder(directory, torch)

    def test_worker_can_load_the_companion_in_an_isolated_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.encoder.save_pretrained(
                directory / "text_encoder", max_shard_size="20KB"
            )
            worker = Path(__file__).with_name("media_diffusers_worker.py")
            script = directory / "load.py"
            script.write_text(
                "import importlib.util, sys, torch\n"
                "from pathlib import Path\n"
                "spec = importlib.util.spec_from_file_location('worker', sys.argv[1])\n"
                "worker = importlib.util.module_from_spec(spec)\n"
                "spec.loader.exec_module(worker)\n"
                "model = worker._load_framepack_prompt_encoder(Path(sys.argv[2]), torch)\n"
                "assert model(torch.tensor([[1, 2]])).last_hidden_state.shape == (1, 2, 32)\n"
            )
            result = subprocess.run(
                [sys.executable, "-I", str(script), str(worker), str(directory)],
                capture_output=True,
                text=True,
                timeout=90,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
