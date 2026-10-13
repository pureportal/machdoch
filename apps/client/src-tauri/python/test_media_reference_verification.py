import copy
import json
from pathlib import Path
import tempfile
import unittest

from PIL import Image

from media_reference_verification import completed_case, runtime_digest, save_results, validate_response


class ReferenceEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.directory = self.root / "01-reference-123"
        self.images = self.directory / "images"
        self.images.mkdir(parents=True)
        image = Image.new("RGB", (32, 32), "white")
        image.putpixel((16, 16), (0, 0, 0))
        image.save(self.images / "output.png")
        self.request = {
            "schemaVersion": 5, "prompt": "A painted landscape", "negativePrompt": "",
            "modelPolicy": "quality", "aspectRatio": "1:1", "seed": 42,
            "model": {"id": "model", "architecture": "model", "digest": "weights"},
            "sampling": {"sampler": "flow-euler", "numInferenceSteps": 8},
            "outputDirectory": str(self.images),
        }
        self.response = {
            **self.request,
            "sampler": "flow-euler", "numInferenceSteps": 8,
            "outputs": [{"seed": 42, "width": 32, "height": 32, "fileName": "output.png"}],
            "workerVersion": "test", "deviceLabel": "test", "schedulerClass": "test",
        }
        self.record = {
            **validate_response(self.request, self.response),
            "referenceId": 123, "directory": str(self.directory),
            "runtimeSha256": "runtime",
        }
        (self.directory / "request.json").write_text(json.dumps(self.request), encoding="utf-8")
        (self.directory / "response.json").write_text(json.dumps(self.response), encoding="utf-8")

    def reuse(self, request=None, record=None, capture_latents=False):
        return completed_case([record or self.record], 123, request or self.request,
                              "runtime", capture_latents, self.root)

    def test_reuses_only_intact_matching_evidence(self):
        self.assertEqual(self.reuse(), self.record)

    def test_changed_prompt_sampling_or_weights_requires_a_new_attempt(self):
        changes = [{"prompt": "Another scene"}, {"sampling": {"sampler": "euler", "numInferenceSteps": 8}},
                   {"model": {"id": "model", "architecture": "model", "digest": "new weights"}}]
        for change in changes:
            with self.subTest(change=change):
                self.assertIsNone(self.reuse({**self.request, **change}))

    def test_changed_runtime_and_failed_runs_are_not_reused(self):
        for change in ({"runtimeSha256": "another"}, {"passed": False}):
            with self.subTest(change=change):
                self.assertIsNone(self.reuse(record={**self.record, **change}))

    def test_evidence_without_complete_runtime_provenance_is_not_reused(self):
        record = {key: value for key, value in self.record.items() if key != "runtimeSha256"}
        self.assertIsNone(self.reuse(record=record))

    def test_runtime_digest_tracks_helpers_configs_and_tensor_reader(self):
        runtime = self.root / "runtime"
        reader = runtime / "fizgig" / "utils"
        reader.mkdir(parents=True)
        files = [runtime / "media_diffusers_worker.py", runtime / "media_image_addons.py",
                 runtime / "media_image_conditioning.py", reader / "safetensors.py",
                 runtime / "open_media_models.json", runtime / "image_sampling_profiles.json",
                 runtime / "media_diffusers_requirements.txt"]
        for path in files:
            path.write_text("original", encoding="utf-8")
        original = runtime_digest(runtime)
        for path in files:
            with self.subTest(path=path.name):
                path.write_text("changed", encoding="utf-8")
                self.assertNotEqual(runtime_digest(runtime), original)
                path.write_text("original", encoding="utf-8")
                self.assertEqual(runtime_digest(runtime), original)
        (runtime / "test_example.py").write_text("test only", encoding="utf-8")
        self.assertEqual(runtime_digest(runtime), original)

    def test_missing_latent_capture_requires_a_new_attempt(self):
        self.assertIsNone(self.reuse(capture_latents=True))

    def test_corrupted_image_is_rejected(self):
        Image.new("RGB", (32, 32), "red").save(self.images / "output.png")
        with self.assertRaisesRegex(ValueError, "blank"):
            self.reuse()

    def test_changed_nonblank_pixels_are_rejected_by_digest(self):
        image = Image.open(self.images / "output.png")
        image.putpixel((0, 0), (25, 30, 40))
        image.save(self.images / "output.png")
        image.close()
        with self.assertRaisesRegex(ValueError, "no longer matches"):
            self.reuse()

    def test_evidence_outside_batch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            self.reuse(record={**self.record, "directory": str(self.root.parent)})

    def test_requested_canvas_must_match_actual_output(self):
        request = {**self.request, "sampling": {**self.request["sampling"], "width": 64, "height": 32}}
        with self.assertRaisesRegex(ValueError, "unexpected width"):
            validate_response(request, self.response)

    def test_response_changes_are_rejected(self):
        for field, value in (("sampler", "euler"), ("prompt", "changed"), ("numInferenceSteps", 10)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                validate_response(self.request, {**self.response, field: value})
        for field, value in (("seed", 12), ("width", 64), ("fileName", "../other.png"),
                             ("fileName", "..\\other.png")):
            response = copy.deepcopy(self.response)
            response["outputs"][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                validate_response(self.request, response)

    def test_results_replace_the_complete_document(self):
        path = self.root / "results.json"
        save_results(path, {"passed": False})
        save_results(path, {"passed": True, "models": [self.record]})
        self.assertTrue(json.loads(path.read_text(encoding="utf-8"))["passed"])
        self.assertFalse(path.with_suffix(".json.tmp").exists())


if __name__ == "__main__":
    unittest.main()
