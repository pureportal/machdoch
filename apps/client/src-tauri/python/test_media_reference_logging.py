from contextlib import redirect_stderr, redirect_stdout
import io
import json
import logging
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import verify_media_reference_sweep as verification


class ReferenceLoggingTests(unittest.TestCase):
    def test_failed_smoke_check_stops_later_cases_and_keeps_failure_evidence(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            template = root / "template.json"
            template.write_text(json.dumps({"model": {"id": "smoke-fixture", "architecture": "stable-diffusion-xl"}, "addons": []}), encoding="utf-8")
            prompt = root / "prompt.txt"
            prompt.write_text("A ceramic teapot", encoding="utf-8")
            cases = root / "cases.json"
            cases.write_text(json.dumps([{"id": number, "promptFile": str(prompt), "modelName": "Smoke fixture", "originalPrompt": False, "aspectRatio": "1:1", "seed": 1, "sampling": {}} for number in (1, 2)]), encoding="utf-8")
            output = root / "batch"
            with (
                redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()),
                mock.patch.object(verification.worker, "_runtime", return_value=(SimpleNamespace(), SimpleNamespace())),
                mock.patch.object(verification.worker, "_device", return_value=("cpu", "CPU", None)),
                mock.patch.object(verification.worker, "generate", side_effect=RuntimeError("decoder device mismatch")) as generate,
                mock.patch.object(verification, "ModelPipelineCache"),
            ):
                self.assertFalse(verification.verify(template, cases, output, "1", False, stop_on_failure=True))
            generate.assert_called_once()
            result = json.loads((output / "results.json").read_text())
            self.assertFalse(result["passed"])
            self.assertEqual(len(result["models"]), 1)
            self.assertEqual(result["models"][0]["error"], "RuntimeError: decoder device mismatch")
            self.assertFalse((output / "02-stable-diffusion-xl-reference-2").exists())

    def test_resident_batches_route_library_messages_to_the_current_render_log(self):
        logger = logging.getLogger("diffusers")
        previous_handlers = logger.handlers[:]
        previous_level, previous_propagate = logger.level, logger.propagate
        streams = [
            (handler, handler.stream)
            for item in logging.root.manager.loggerDict.values()
            if isinstance(item, logging.Logger)
            for handler in item.handlers
            if isinstance(handler, logging.StreamHandler)
        ]
        logger.handlers = []
        logger.setLevel(logging.WARNING)
        logger.propagate = False
        capture = io.StringIO()

        def runtime():
            if not logger.handlers:
                logger.addHandler(logging.StreamHandler(sys.stderr))
            return SimpleNamespace(), SimpleNamespace()

        def generate(request, cache):
            logger.warning("Model diagnostic: %s", request["prompt"])
            return {}

        try:
            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                template = root / "template.json"
                template.write_text(json.dumps({"model": {"id": "logging-fixture", "architecture": "stable-diffusion-xl"}, "addons": []}), encoding="utf-8")
                with (
                    redirect_stderr(capture), redirect_stdout(io.StringIO()),
                    mock.patch.object(verification.worker, "_runtime", side_effect=runtime),
                    mock.patch.object(verification.worker, "_device", return_value=("cpu", "CPU", None)),
                    mock.patch.object(verification.worker, "generate", side_effect=generate),
                    mock.patch.object(verification, "ModelPipelineCache"),
                    mock.patch.object(verification, "release_allocator"),
                    mock.patch.object(verification, "validate_response", return_value={"passed": True}),
                ):
                    for number, label in enumerate(("first engine", "second engine")):
                        prompt = root / f"prompt-{number}.txt"
                        prompt.write_text(label, encoding="utf-8")
                        cases = root / f"cases-{number}.json"
                        cases.write_text(json.dumps([{"id": 1, "promptFile": str(prompt), "modelName": label, "originalPrompt": False, "aspectRatio": "1:1", "seed": 1, "sampling": {}}]), encoding="utf-8")
                        output = root / f"batch-{number}"
                        self.assertTrue(verification.verify(template, cases, output, "1", False))
                        log = output / "01-stable-diffusion-xl-reference-1/worker.log"
                        self.assertIn("Model diagnostic: " + label, log.read_text(encoding="utf-8"))
                    self.assertNotIn("Logging error", capture.getvalue())
        finally:
            created = logger.handlers[:]
            logger.handlers = previous_handlers
            logger.setLevel(previous_level)
            logger.propagate = previous_propagate
            for handler, stream in streams:
                handler.setStream(stream)
            for handler in created:
                handler.close()


if __name__ == "__main__":
    unittest.main()
