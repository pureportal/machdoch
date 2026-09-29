import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from fizgig.minimax import trainer


class Network:
    def __init__(self, weights, fail_on_calls=()):
        self.weights = weights
        self.fail_on_calls = fail_on_calls
        self.calls = 0

    def save_weights(self, path, dtype, metadata):
        self.calls += 1
        Path(path).write_text(self.weights, encoding="utf-8")
        if self.calls in self.fail_on_calls:
            raise OSError("injected weight save failure")


class MiniMaxTrainingStateSaveTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output_dir = Path(self.directory.name)
        self.optimizer = SimpleNamespace(state_dict=lambda: {"step": 5})
        self.save = trainer._save_training_state
        self.state_dir = self.output_dir / "run-000003-state"
        self.save(str(self.output_dir), "run", Network("old"), self.optimizer,
                  epoch=3, global_step=5, dtype="float32")

    def assert_old_state_preserved(self):
        self.assertEqual((self.state_dir / "lora.safetensors").read_text(), "old")
        self.assertTrue((self.state_dir / "optimizer.pt").is_file())
        self.assertTrue((self.state_dir / "rng.pt").is_file())
        self.assertTrue((self.state_dir / "training_state.json").is_file())
        self.assertEqual([path.name for path in self.output_dir.iterdir()],
                         [self.state_dir.name])

    def test_first_attempt_failure_keeps_old_state_until_retry_succeeds(self):
        network = Network("new", fail_on_calls=(1,))

        def before_retry(seconds):
            self.assertEqual(seconds, 5)
            self.assertEqual((self.state_dir / "lora.safetensors").read_text(), "old")
            self.assertEqual([path.name for path in self.output_dir.iterdir()
                              if path.name.endswith("-state")], [self.state_dir.name])

        with mock.patch.object(time, "sleep", side_effect=before_retry):
            result = self.save(str(self.output_dir), "run", network, self.optimizer,
                               epoch=3, global_step=6, dtype="float32")

        self.assertEqual(result, str(self.state_dir))
        self.assertEqual(network.calls, 2)
        self.assertEqual((self.state_dir / "lora.safetensors").read_text(), "new")
        self.assertEqual([path.name for path in self.output_dir.iterdir()],
                         [self.state_dir.name])

    def test_retry_failure_keeps_complete_old_state(self):
        network = Network("partial", fail_on_calls=(1, 2))
        with mock.patch.object(time, "sleep"):
            with self.assertRaisesRegex(OSError, "injected weight save failure"):
                self.save(str(self.output_dir), "run", network, self.optimizer,
                          epoch=3, global_step=6, dtype="float32")
        self.assertEqual(network.calls, 2)
        self.assert_old_state_preserved()

    def test_successful_repeat_save_replaces_complete_state(self):
        self.save(str(self.output_dir), "run", Network("new"), self.optimizer,
                  epoch=3, global_step=6, dtype="float32")
        self.assertEqual((self.state_dir / "lora.safetensors").read_text(), "new")
        self.assertIn('"global_step": 6',
                      (self.state_dir / "training_state.json").read_text())
        self.assertEqual([path.name for path in self.output_dir.iterdir()],
                         [self.state_dir.name])

    def test_publication_failure_restores_old_state(self):
        replace = os.replace
        failures = 0

        def fail_publication(source, destination):
            nonlocal failures
            if "-staging-" in source and destination == str(self.state_dir):
                failures += 1
                raise OSError("injected publication failure")
            replace(source, destination)

        with mock.patch.object(os, "replace", side_effect=fail_publication), \
                mock.patch.object(time, "sleep"):
            with self.assertRaisesRegex(OSError, "injected publication failure"):
                self.save(str(self.output_dir), "run", Network("new"), self.optimizer,
                          epoch=3, global_step=6, dtype="float32")
        self.assertEqual(failures, 2)
        self.assert_old_state_preserved()


if __name__ == "__main__":
    unittest.main()
