import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare_qwen_verification_package as packages


REQUIRED_ATTRIBUTION = (
    "Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT, Copyright (c) 2026 "
    "Hangzhou Tongyi Laboratory Technology Co., Ltd. All Rights Reserved."
)


class QwenPackageNoticeTests(unittest.TestCase):
    def prepare(self, architecture, license_text, publisher_notice=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        root = directory / "package"
        checkpoint = directory / "checkpoint.gguf"
        checkpoint.write_bytes(b"GGUF")
        repository, revision = packages.SOURCES[architecture]
        files = {
            "LICENSE": license_text.encode(),
            "model_index.json": json.dumps({"_class_name": "QwenImage21Pipeline"}).encode(),
            "transformer/config.json": b"{}",
        }
        if publisher_notice is not None:
            files["NOTICE"] = publisher_notice.encode()
        specification = {"sha": revision, "siblings": [
            {"rfilename": name, "size": len(content),
             "blobId": hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()}
            for name, content in files.items()
        ]}
        urls = {f"https://huggingface.co/{repository}/resolve/{revision}/{name}": content
                for name, content in files.items()}
        urls[f"https://huggingface.co/api/models/{repository}/revision/{revision}?blobs=true"] = json.dumps(specification).encode()
        with patch.object(packages.urllib.request, "urlopen", side_effect=lambda url, **options: io.BytesIO(urls[url])):
            with patch("sys.stdout", new=io.StringIO()):
                packages.prepare(root, checkpoint, architecture)
        return root, files

    def test_base_and_turbo_retain_attribution_and_modified_file_notice(self):
        for architecture in ("qwen-image-2.1", "qwen-image-2.1-turbo"):
            with self.subTest(architecture=architecture):
                root, original = self.prepare(architecture, REQUIRED_ATTRIBUTION)
                self.assertEqual((root / "NOTICE").read_text(), REQUIRED_ATTRIBUTION + "\n")
                self.assertEqual((root / "LICENSE").read_bytes(), original["LICENSE"])
                index = json.loads((root / "model_index.json").read_text())
                self.assertIn("Machdoch added", index["_machdoch_modifications"])
                self.assertEqual(index["machdoch_quantization"]["transformer"]["format"], "gguf")
                manifest = json.loads((root / "source-manifest.json").read_text())
                self.assertEqual(manifest["generatedNotices"][0]["sha256"], hashlib.sha256((root / "NOTICE").read_bytes()).hexdigest())
                self.assertEqual((root / "transformer/model.gguf").read_bytes(), b"GGUF")

    def test_retains_other_publisher_notices_when_adding_attribution(self):
        root, _ = self.prepare("qwen-image-2.1", REQUIRED_ATTRIBUTION, "Additional publisher credit\n")
        self.assertEqual((root / "NOTICE").read_text(), "Additional publisher credit\n\n" + REQUIRED_ATTRIBUTION + "\n")

    def test_keeps_complete_publisher_notice_without_rewriting_it(self):
        original = "Publisher credit\n" + REQUIRED_ATTRIBUTION + "\n"
        root, _ = self.prepare("qwen-image-2.1-turbo", REQUIRED_ATTRIBUTION, original)
        self.assertEqual((root / "NOTICE").read_text(), original)
        self.assertNotIn("generatedNotices", json.loads((root / "source-manifest.json").read_text()))

    def test_rejects_an_unexpected_research_license(self):
        with self.assertRaisesRegex(ValueError, "does not contain the expected attribution"):
            self.prepare("qwen-image-2.1", "Unexpected licence")

    def test_does_not_apply_research_attribution_to_apache_models(self):
        root, original = self.prepare("qwen-image-2512", "Apache License 2.0")
        self.assertFalse((root / "NOTICE").exists())
        self.assertEqual((root / "LICENSE").read_bytes(), original["LICENSE"])


if __name__ == "__main__":
    unittest.main()
