from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location("media_worker", Path(__file__).with_name("media_diffusers_worker.py"))
WORKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(WORKER)


class RuntimeReadinessTests(unittest.TestCase):
    def versions(self):
        versions = {name: accepted[0] for name, accepted in WORKER.ACCEPTED_PACKAGE_VERSIONS.items()}
        bundle = WORKER.RUNTIME_MANIFEST["accelerators"]["amd"]
        versions.update({name: bundle[name] for name in ("torch", "torchvision")})
        return versions

    def test_missing_and_incompatible_dependencies_do_not_enable_models(self):
        versions = self.versions()
        versions.update({"diffusers": None, "accelerate": None, "peft": None, "imageio-ffmpeg": None,
                         "torch": "2.2.2", "transformers": "4.57.6", "sentencepiece": "0.2.1",
                         "protobuf": "7.34.1", "safetensors": "0.7.0", "pillow": "11.3.0"})
        with mock.patch.object(WORKER, "_package_versions", return_value=versions), mock.patch.object(WORKER, "_runtime") as runtime:
            result = WORKER.probe(verify_operations=True)
        self.assertFalse(result["ready"])
        self.assertIn("missing diffusers", result["diagnostic"])
        self.assertIn("torch=2.2.2", result["diagnostic"])
        runtime.assert_not_called()

    def test_mismatched_torchvision_bundle_is_not_ready(self):
        versions = self.versions()
        versions["torchvision"] = WORKER.RUNTIME_MANIFEST["accelerators"]["cpu"]["torchvision"]
        with mock.patch.object(WORKER, "_package_versions", return_value=versions):
            result = WORKER.probe(verify_operations=True)
        self.assertFalse(result["ready"])
        self.assertIn("same accelerator bundle", result["diagnostic"])

    def test_pinned_versions_are_insufficient_when_execution_fails(self):
        with mock.patch.object(WORKER, "_package_versions", return_value=self.versions()), \
             mock.patch.object(WORKER, "_runtime", return_value=(object(), object())), \
             mock.patch.object(WORKER, "_device", return_value=("cuda", "Test GPU", 16 * 1024**3)), \
             mock.patch.object(WORKER, "_verify_runtime_operations", side_effect=RuntimeError("kernel failed")):
            result = WORKER.probe(verify_operations=True)
        self.assertFalse(result["ready"])
        self.assertIn("kernel failed", result["diagnostic"])

    def test_gpu_bundle_cannot_silently_enable_cpu_execution(self):
        with mock.patch.object(WORKER, "_package_versions", return_value=self.versions()), \
             mock.patch.object(WORKER, "_runtime", return_value=(object(), object())), \
             mock.patch.object(WORKER, "_device", return_value=("cpu", "CPU", None)):
            result = WORKER.probe(verify_operations=True)
        self.assertFalse(result["ready"])
        self.assertIn("graphics driver", result["diagnostic"])

    def test_success_requires_the_operation_checks(self):
        with mock.patch.object(WORKER, "_package_versions", return_value=self.versions()), \
             mock.patch.object(WORKER, "_runtime", return_value=(object(), object())), \
             mock.patch.object(WORKER, "_device", return_value=("cuda", "Test GPU", 16 * 1024**3)), \
             mock.patch.object(WORKER, "_verify_runtime_operations") as operations:
            result = WORKER.probe(verify_operations=True)
        self.assertTrue(result["ready"])
        self.assertIn("vp9-alpha", result["capabilities"])
        operations.assert_called_once()


if __name__ == "__main__":
    unittest.main()
