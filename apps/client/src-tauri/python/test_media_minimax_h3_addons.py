import tempfile
import unittest
from pathlib import Path

from media_diffusers_worker import WorkerError, _minimax_h3_style_addon


class MiniMaxH3AddonTests(unittest.TestCase):
    def test_accepts_one_style_lora_and_reports_its_applied_strength(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "style.safetensors"
            path.write_bytes(b"style")
            addon = {
                "kind": "lora",
                "addonId": "anime-style",
                "enabled": True,
                "path": str(path),
                "digest": "a" * 64,
                "targetComponents": ["denoiser"],
                "loraProfile": {
                    "dialect": "diffusers-peft",
                    "algorithm": "lora",
                    "networkAlphaCount": 0,
                },
                "modelStrength": 0.7,
                "textEncoderStrength": None,
                "denoisingSchedule": None,
            }
            selected_path, strength, evidence = _minimax_h3_style_addon({"addons": [addon]})
            self.assertEqual(selected_path, path)
            self.assertEqual(strength, 0.7)
            self.assertEqual(evidence[0]["loadedComponents"], ["denoiser"])
            self.assertEqual(evidence[0]["modelStrength"], 0.7)

            with self.assertRaisesRegex(WorkerError, "one style LoRA"):
                _minimax_h3_style_addon({"addons": [addon, addon]})
            with self.assertRaisesRegex(WorkerError, "entire clip"):
                _minimax_h3_style_addon({"addons": [{**addon, "denoisingSchedule": {"start": 0, "end": 1}}]})


if __name__ == "__main__":
    unittest.main()
