import copy
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(shutil.which("pwsh"), "Requires PowerShell")
class ReferenceProcessOwnershipTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="media ownership ")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.root = "D:\\Models\\machdoch\\verification\\image-engines"
        self.python = "C:\\managed runtime\\python.exe"
        self.processes = [
            self.process(10, 1, "pwsh.exe", f'pwsh -File run-media-reference-queue.ps1 -VerificationRoot "{self.root}"', 0),
            self.process(11, 10, "python.exe", "python verify_media_reference_batches.py", 1),
            self.process(12, 11, "python.exe", "venv launcher", 2),
            self.process(13, 12, "python.exe", f'python verify_media_reference_sweep.py --output-root "{self.root}/sweep"', 3),
        ]
        self.queues = [copy.deepcopy(self.processes[0])]

    def process(self, identity, parent, name, command, minute):
        return {"ProcessId": identity, "ParentProcessId": parent, "Name": name,
                "CommandLine": command, "CreationDate": f"2026-10-12T19:{minute:02d}:00Z",
                "ExecutablePath": self.python if name == "python.exe" else "C:\\pwsh.exe"}

    def query(self):
        processes = self.directory / "processes.json"
        queues = self.directory / "queues.json"
        processes.write_text(json.dumps(self.processes), encoding="utf-8")
        queues.write_text(json.dumps(self.queues), encoding="utf-8")
        helper = Path(__file__).resolve().parents[2] / "scripts" / "media-reference-processes.ps1"
        script = self.directory / "query.ps1"
        script.write_text(
            "param($Helper, $Processes, $Queues, $Root, $Python)\n"
            "$ErrorActionPreference = 'Stop'\n"
            ". $Helper\n"
            "$live = @(Get-Content -LiteralPath $Processes -Raw | ConvertFrom-Json)\n"
            "$selected = @(Get-Content -LiteralPath $Queues -Raw | ConvertFrom-Json)\n"
            "foreach ($process in @($live) + @($selected)) { $process.CreationDate = [datetime]$process.CreationDate }\n"
            "$owned = Get-OwnedMediaReferenceProcesses -Processes $live -QueueProcesses $selected -VerificationPath $Root -PythonPath $Python\n"
            "@{ queues = @($owned.queues | ForEach-Object ProcessId); workers = @($owned.workers | ForEach-Object ProcessId) } | ConvertTo-Json -Compress\n",
            encoding="utf-8",
        )
        result = subprocess.run([shutil.which("pwsh"), "-NoProfile", "-File", str(script),
                                 str(helper), str(processes), str(queues), self.root, self.python],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_follows_the_owned_launcher_chain_with_mixed_path_separators(self):
        self.assertEqual(self.query(), {"queues": [10], "workers": [13]})

    def test_excludes_a_sibling_worker_in_the_same_verification_root(self):
        self.processes.append(self.process(14, 1, "python.exe", self.processes[3]["CommandLine"], 4))
        self.assertEqual(self.query()["workers"], [13])

    def test_rejects_a_reused_queue_identifier(self):
        self.processes[0]["CreationDate"] = "2026-10-12T19:05:00Z"
        self.assertEqual(self.query(), {"queues": [], "workers": []})

    def test_rejects_a_parent_created_after_its_child(self):
        self.processes[2]["CreationDate"] = "2026-10-12T19:05:00Z"
        self.assertEqual(self.query()["workers"], [])

    def test_rejects_a_different_interpreter(self):
        self.processes[3]["ExecutablePath"] = "C:\\other runtime\\python.exe"
        self.assertEqual(self.query()["workers"], [])

    def test_rejects_a_similarly_named_root(self):
        self.processes[0]["CommandLine"] = self.processes[0]["CommandLine"].replace(self.root, self.root + "-other")
        self.assertEqual(self.query(), {"queues": [], "workers": []})

    def test_rejects_a_similarly_named_script(self):
        self.processes[3]["CommandLine"] = self.processes[3]["CommandLine"].replace("sweep.py", "sweep.py.other")
        self.assertEqual(self.query()["workers"], [])

    def test_parent_cycle_terminates_without_accepting_the_worker(self):
        self.processes[1]["ParentProcessId"] = 12
        self.processes[1]["CreationDate"] = self.processes[2]["CreationDate"]
        self.assertEqual(self.query()["workers"], [])

    def test_a_missing_queue_is_terminal_for_ownership(self):
        self.processes = self.processes[1:]
        self.assertEqual(self.query(), {"queues": [], "workers": []})


if __name__ == "__main__":
    unittest.main()
