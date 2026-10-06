import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


RUNNER = Path(__file__).with_name("media_training.py")


class LocalKreaTrainingTests(unittest.TestCase):
    def run_job(self, trainer_source: str, four_bit: bool = False, precision: str = "bf16", warmup_steps: int = 0) -> tuple[subprocess.CompletedProcess[str], dict]:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shutil.copy2(RUNNER, root / RUNNER.name)
            (root / "train_dreambooth_lora_krea2.py").write_text(trainer_source, encoding="utf-8")
            job = root / "job"
            (job / "dataset").mkdir(parents=True)
            spec = {
                "architecture": "krea-2",
                "model": {"path": str(root / "raw")},
                "trigger_phrase": "sks person",
                "resolution": 768,
                "rank": 32,
                "learning_rate": 0.0003,
                "steps": 1000,
                "attention_only": True,
                "four_bit": four_bit,
                "resume": False,
                "seed": 42,
                "options": {"method": "lora", "precision": precision, "optimizer": "adamw",
                            "trainablePrecision": "float32", "batchSize": 1,
                            "gradientAccumulation": 1, "lrScheduler": "constant",
                            "warmupSteps": warmup_steps, "weightDecay": 0.01, "maxGradNorm": 1,
                            "checkpointInterval": 250, "checkpointRetention": 2,
                            "gradientCheckpointing": True},
            }
            (job / "job.json").write_text(json.dumps(spec), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-I", "-B", "-Xutf8", str(root / RUNNER.name), str(job)],
                capture_output=True,
                text=True,
                timeout=120,
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
assert arguments[arguments.index('--seed') + 1] == '42'
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

    def test_float32_and_warmup_use_the_upstream_arguments(self):
        source = """
import argparse, pathlib
parser = argparse.ArgumentParser()
parser.add_argument('--mixed_precision', choices=['no', 'fp16', 'bf16'])
parser.add_argument('--output_dir')
parser.add_argument('--lr_scheduler', choices=['constant', 'constant_with_warmup'])
parser.add_argument('--lr_warmup_steps', type=int)
arguments, remaining = parser.parse_known_args()
assert arguments.mixed_precision == 'no'
assert arguments.lr_scheduler == 'constant_with_warmup'
assert arguments.lr_warmup_steps == 2
output = pathlib.Path(arguments.output_dir)
output.mkdir(parents=True)
(output / 'pytorch_lora_weights.safetensors').write_bytes(b'test')
"""
        result, status = self.run_job(source, precision="float32", warmup_steps=2)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(status["state"], "completed")

    def test_invalid_trainer_arguments_have_a_readable_error(self):
        result, status = self.run_job("raise SystemExit(2)")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(status["message"], "The local trainer rejected its settings.")


if __name__ == "__main__":
    unittest.main()
