import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


@unittest.skipUnless(sys.platform == "win32" and shutil.which("pwsh"), "Requires Windows PowerShell")
class ReferenceQueueTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="machdoch reference queue ")
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.scripts = self.workspace / "apps" / "client" / "scripts"
        self.scripts.mkdir(parents=True)
        self.script = self.scripts / "run-media-reference-queue.ps1"
        shutil.copyfile(Path(__file__).resolve().parents[2] / "scripts" / self.script.name, self.script)
        self.checks = self.workspace / "docs" / "validation" / "image-engines" / "current-checks"
        self.checks.mkdir(parents=True)
        self.verification = self.workspace / "model store" / "verification"
        self.verification.mkdir(parents=True)
        self.manifest = self.verification / "reference batches.json"
        self.manifest.write_text(json.dumps({"exitCode": 0}), encoding="utf-8")
        self.status = self.checks / "reference-queue-current-status.json"
        self.status.write_text(json.dumps({"state": "waiting", "processId": -1}), encoding="utf-8")
        runner = self.workspace / "apps" / "client" / "src-tauri" / "python" / "verify_media_reference_batches.py"
        runner.parent.mkdir(parents=True)
        runner.write_text(
            "import argparse, json, pathlib, sys\n"
            "parser = argparse.ArgumentParser()\n"
            "parser.add_argument('--batches', required=True)\n"
            "parser.add_argument('--results', required=True)\n"
            "parser.add_argument('--hip-device', required=True)\n"
            "args = parser.parse_args()\n"
            "data = json.loads(pathlib.Path(args.batches).read_text())\n"
            "pathlib.Path(args.results).write_text(json.dumps(vars(args)))\n"
            "sys.exit(data['exitCode'])\n",
            encoding="utf-8",
        )
        for name in ("build-media-image-comparisons.mjs", "audit-media-image-verification.mjs", "verify-media-image-comparisons.mjs"):
            (self.scripts / name).write_text("console.log(JSON.stringify(process.argv.slice(2)));\n", encoding="utf-8")

    def run_queue(self):
        return subprocess.run(
            [shutil.which("pwsh"), "-NoProfile", "-File", str(self.script),
             "-PythonExecutable", sys.executable, "-VerificationRoot", str(self.verification),
             "-ModelRoot", str(self.verification.parent), "-BatchesPath", str(self.manifest)],
            capture_output=True, text=True, timeout=60,
        )

    def read_status(self):
        return json.loads(self.status.read_text(encoding="utf-8-sig"))

    def test_restart_replaces_stale_status_and_preserves_paths_with_spaces(self):
        retained = self.verification / "existing evidence.json"
        retained.write_text("retained", encoding="utf-8")
        result = self.run_queue()
        self.assertEqual(result.returncode, 0, result.stderr)
        status = self.read_status()
        self.assertEqual(status["state"], "finished")
        self.assertEqual(status["manifest"], str(self.manifest))
        self.assertEqual(len(status["operations"]), 3)
        self.assertEqual(retained.read_text(), "retained")
        generation = json.loads((self.verification / "reference-queue-current-results.json").read_text())
        self.assertEqual(generation["batches"], str(self.manifest))
        gallery_arguments = json.loads((self.checks / "build-media-image-comparisons.mjs-queue-current.stdout.log").read_text(encoding="utf-8-sig"))
        self.assertEqual(gallery_arguments[0], str(self.verification))

    def test_generation_failure_keeps_evidence_checks_and_returns_failure(self):
        self.manifest.write_text(json.dumps({"exitCode": 9}), encoding="utf-8")
        result = self.run_queue()
        self.assertNotEqual(result.returncode, 0)
        status = self.read_status()
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["generationExitCode"], 9)
        self.assertEqual(len(status["operations"]), 3)
        self.assertIn("Reference generation failed", status["error"])

    def test_gallery_failure_stops_following_checks_and_records_failure(self):
        (self.scripts / "build-media-image-comparisons.mjs").write_text("process.exit(7);\n", encoding="utf-8")
        result = self.run_queue()
        self.assertNotEqual(result.returncode, 0)
        status = self.read_status()
        self.assertEqual(status["state"], "failed")
        self.assertEqual(status["operations"], [{"script": "build-media-image-comparisons.mjs", "exitCode": 7}])

    def test_live_lock_rejects_duplicate_queue_without_replacing_status(self):
        original = self.status.read_bytes()
        with (self.checks / "reference-queue.lock").open("w"):
            result = self.run_queue()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.status.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
