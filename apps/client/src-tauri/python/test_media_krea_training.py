import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


RUNNER = Path(__file__).with_name("media_krea_training.py")


class LocalKreaTrainingTests(unittest.TestCase):
    def run_job(self, trainer_source: str, four_bit: bool = False) -> tuple[subprocess.CompletedProcess[str], dict]:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copy2(RUNNER, root / RUNNER.name)
            (root / "train_dreambooth_lora_krea2.py").write_text(trainer_source, encoding="utf-8")
            job = root / "job"
            (job / "dataset").mkdir(parents=True)
            spec = {
                "raw_model_path": str(root / "raw"),
                "trigger_phrase": "sks person",
                "precision": "bf16",
                "resolution": 768,
                "rank": 32,
                "learning_rate": 0.0003,
                "steps": 1000,
                "checkpoint_interval": 250,
                "attention_only": True,
                "four_bit": four_bit,
                "resume": False,
            }
            (job / "job.json").write_text(json.dumps(spec), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-Xutf8", str(root / RUNNER.name), str(job)],
                capture_output=True,
                text=True,
                timeout=30,
            )
            status = json.loads((job / "status.json").read_text(encoding="utf-8"))
            return result, status

    def test_completed_job_uses_local_dataset_and_no_hub_push(self):
        source = """
import pathlib, sys
arguments = sys.argv
assert '--dataset_name' in arguments
assert '--caption_column' in arguments
assert '--offload' in arguments
assert '--cache_latents' in arguments
assert '--skip_final_inference' in arguments
assert '--skip_final_validation' not in arguments
assert '--lora_layers' in arguments
assert '--bnb_quantization_config_path' in arguments
assert '--push_to_hub' not in arguments
output = pathlib.Path(arguments[arguments.index('--output_dir') + 1])
output.mkdir(parents=True)
(output / 'pytorch_lora_weights.safetensors').write_bytes(b'test')
"""
        result, status = self.run_job(source, four_bit=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(status["state"], "completed")

    def test_failed_job_records_error(self):
        result, status = self.run_job("raise RuntimeError('local model missing')")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(status, {"state": "failed", "message": "local model missing"})

    def test_invalid_trainer_arguments_have_a_readable_error(self):
        result, status = self.run_job("raise SystemExit(2)")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(status["message"], "The local trainer rejected its settings.")


if __name__ == "__main__":
    unittest.main()
