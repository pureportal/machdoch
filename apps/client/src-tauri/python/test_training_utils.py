import tempfile
import unittest
from pathlib import Path

from fizgig.training.train_utils import LossRecorder, prune_state_dirs, validate_output_name


class LossRecorderTests(unittest.TestCase):
    def test_moving_average_uses_recent_losses(self):
        recorder = LossRecorder(window_size=2)
        self.assertEqual(recorder.moving_average, 0.0)
        recorder.add(epoch=0, step=0, loss=2)
        recorder.add(epoch=0, step=1, loss=4)
        self.assertEqual(recorder.moving_average, 3.0)
        recorder.add(epoch=1, step=0, loss=8)
        self.assertEqual(recorder.moving_average, 6.0)

    def test_invalid_window_and_loss_are_rejected_without_changing_average(self):
        for size in (0, -1, True, 1.5):
            with self.subTest(size=size), self.assertRaises(ValueError):
                LossRecorder(window_size=size)
        recorder = LossRecorder()
        recorder.add(epoch=0, step=0, loss=2)
        for loss in (float("nan"), float("inf"), -float("inf")):
            with self.subTest(loss=loss), self.assertRaises(ValueError):
                recorder.add(epoch=0, step=1, loss=loss)
            self.assertEqual(recorder.moving_average, 2.0)


class OutputNameTests(unittest.TestCase):
    def test_regular_names_are_accepted(self):
        for name in ("run", "my run.2", "模型_01"):
            with self.subTest(name=name):
                validate_output_name(name)

    def test_unsafe_names_are_rejected(self):
        for name in ("", " ", ".", "..", "../other", "a\\b", "a:b", "bad?name",
                     "name.", "name ", "a\x00b", "a\nb", "CON", "com1.txt"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                validate_output_name(name)


class StatePruningTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.output_dir = Path(self.directory.name)

    def state(self, name, *, complete=True):
        path = self.output_dir / name
        path.mkdir()
        (path / "lora.safetensors").touch()
        (path / "optimizer.pt").touch()
        if complete:
            (path / "training_state.json").write_text("{}", encoding="utf-8")
        return path

    def test_keeps_latest_completed_states_and_other_entries(self):
        oldest = self.state("run-000001-state")
        middle = self.state("run-000003-state")
        newest = self.state("run-000010-state")
        incomplete = self.state("run-000000-state", complete=False)
        other_run = self.state("run-extra-000002-state")
        malformed = self.state("run-10-state")
        staging = self.state(".run-000004-state-staging-123")
        unrelated_file = self.output_dir / "run-000002-state"
        unrelated_file.touch()

        prune_state_dirs(self.output_dir, "run", 2)

        self.assertFalse(oldest.exists())
        for path in (middle, newest, incomplete, other_run, malformed, staging,
                     unrelated_file):
            self.assertTrue(path.exists(), path.name)

    def test_zero_retention_removes_completed_states_only(self):
        complete = self.state("run-000001-state")
        incomplete = self.state("run-000002-state", complete=False)
        prune_state_dirs(self.output_dir, "run", 0)
        self.assertFalse(complete.exists())
        self.assertTrue(incomplete.exists())

    def test_missing_required_files_are_not_pruned(self):
        incomplete = self.state("run-000001-state")
        (incomplete / "optimizer.pt").unlink()
        complete = self.state("run-000002-state")
        prune_state_dirs(self.output_dir, "run", 0)
        self.assertTrue(incomplete.exists())
        self.assertFalse(complete.exists())

    def test_output_name_is_matched_literally(self):
        matching = self.state("run.v1-000001-state")
        other = self.state("runXv1-000001-state")
        prune_state_dirs(self.output_dir, "run.v1", 0)
        self.assertFalse(matching.exists())
        self.assertTrue(other.exists())

    def test_symlinked_state_directory_is_not_pruned(self):
        target = self.state("target-000001-state")
        link = self.output_dir / "run-000001-state"
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlinks unavailable: {error}")
        prune_state_dirs(self.output_dir, "run", 0)
        self.assertTrue(link.is_symlink())
        self.assertTrue(target.exists())

    def test_invalid_retention_does_not_remove_any_states(self):
        state = self.state("run-000001-state")
        for count in (-1, True, 1.5):
            with self.subTest(count=count), self.assertRaises(ValueError):
                prune_state_dirs(self.output_dir, "run", count)
            self.assertTrue(state.exists())

    def test_invalid_output_name_does_not_remove_any_states(self):
        state = self.state("run-000001-state")
        with self.assertRaises(ValueError):
            prune_state_dirs(self.output_dir, "../run", 0)
        self.assertTrue(state.exists())


if __name__ == "__main__":
    unittest.main()
