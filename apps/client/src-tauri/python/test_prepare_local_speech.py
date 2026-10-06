from pathlib import Path
import tempfile
import unittest

from prepare_local_speech import remove_development_files


class SpeechRuntimePackagingTests(unittest.TestCase):
    def test_preserves_runtime_code_and_legal_files_while_removing_development_artifacts(self):
        with tempfile.TemporaryDirectory(prefix="machdoch-speech-packaging-") as directory:
            runtime = Path(directory)
            folder = runtime / "torch" / "include"
            folder.mkdir(parents=True)
            retained = [runtime / "python.exe", runtime / "torch.dll", folder / "LICENSE.h", folder / "COPYING", runtime / "model.py"]
            removed = [runtime / "torch.lib", runtime / "torch.pdb", folder / "model.h", runtime / "model.pyc"]
            for path in retained + removed:
                path.write_bytes(b"fixture")
            remove_development_files(runtime)
            self.assertTrue(all(path.read_bytes() == b"fixture" for path in retained))
            self.assertTrue(all(not path.exists() for path in removed))

    def test_rejects_deleting_a_link_to_a_file_outside_the_runtime(self):
        with tempfile.TemporaryDirectory(prefix="machdoch-speech-packaging-") as directory:
            root = Path(directory)
            runtime = root / "runtime"
            runtime.mkdir()
            outside = root / "outside.lib"
            outside.write_bytes(b"fixture")
            try:
                (runtime / "linked.lib").symlink_to(outside)
            except OSError as error:
                self.skipTest(str(error))
            with self.assertRaisesRegex(ValueError, "outside"):
                remove_development_files(runtime)
            self.assertEqual(outside.read_bytes(), b"fixture")


if __name__ == "__main__":
    unittest.main()
