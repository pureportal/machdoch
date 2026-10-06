import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from prepare_speech_native_licenses import legal_files, verify_native_licenses


class NativeLicenseTests(unittest.TestCase):
    def test_rejects_archive_paths_outside_package(self):
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode="w") as archive:
            item = tarfile.TarInfo("package/../../LICENSE")
            item.size = 3
            archive.addfile(item, io.BytesIO(b"MIT"))
        data.seek(0)
        with tarfile.open(fileobj=data) as archive:
            with self.assertRaisesRegex(ValueError, "archive path"):
                legal_files(archive)

    def test_rejects_missing_dependencies_and_changed_notices(self):
        with tempfile.TemporaryDirectory(prefix="machdoch-native-licenses-") as directory:
            root = Path(directory)
            (root / "LICENSE").write_text("Original grant", encoding="utf-8")
            file = {"path": "LICENSE", "sha256": hashlib.sha256((root / "LICENSE").read_bytes()).hexdigest()}
            source = {"name": "example", "version": "1", "sha256": "source"}
            component = {"name": "example", "version": "1", "sourceSha256": "source", "files": [file], "dependencies": [{"name": "library", "version": "1"}]}
            inventory = {"components": [component], "crates": [{"name": "different", "version": "1", "files": [file]}]}
            path = root / "python-native.json"
            path.write_text(json.dumps(inventory), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "dependency is missing"):
                verify_native_licenses(root, [source])
            inventory["crates"][0]["name"] = "library"
            path.write_text(json.dumps(inventory), encoding="utf-8")
            verify_native_licenses(root, [source])
            (root / "LICENSE").write_text("Altered grant", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "integrity check failed"):
                verify_native_licenses(root, [source])


if __name__ == "__main__":
    unittest.main()
