import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import download_media_verification_components as components


class ComponentDownloadTests(unittest.TestCase):
    def test_new_component_is_verified_before_promotion_without_a_second_read(self):
        payload = b"verified model bytes"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            publisher = self.publisher(root, payload)
            output = root / "components"
            with mock.patch.object(components.urllib.request, "urlopen", return_value=io.BytesIO(payload)), \
                    mock.patch.object(components, "verify_component", wraps=components.verify_component) as verify:
                components.download(publisher, ["model.safetensors"], output)
            verify.assert_called_once()
            self.assertEqual(verify.call_args.args[0], output / "model.safetensors.part")
            self.assertEqual((output / "model.safetensors").read_bytes(), payload)
            self.assertFalse((output / "model.safetensors.part").exists())
            provenance = json.loads((output / "component-provenance.json").read_text())
            self.assertEqual(provenance["components"][0]["sha256"], hashlib.sha256(payload).hexdigest())

    def test_corrupt_download_is_not_promoted(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            publisher = self.publisher(root, b"correct")
            output = root / "components"
            with mock.patch.object(components.urllib.request, "urlopen", return_value=io.BytesIO(b"corrupt")), \
                    self.assertRaisesRegex(ValueError, "component digest"):
                components.download(publisher, ["model.safetensors"], output)
            self.assertFalse((output / "model.safetensors").exists())
            self.assertTrue((output / "model.safetensors.part").exists())
            self.assertFalse((output / "component-provenance.json").exists())

    def test_existing_component_is_verified_and_not_downloaded_again(self):
        payload = b"verified model bytes"
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            publisher = self.publisher(root, payload)
            output = root / "components"
            output.mkdir()
            existing = output / "model.safetensors"
            existing.write_bytes(payload)
            with mock.patch.object(components.urllib.request, "urlopen") as fetch, \
                    mock.patch.object(components, "verify_component", wraps=components.verify_component) as verify:
                components.download(publisher, [existing.name], output)
            fetch.assert_not_called()
            verify.assert_called_once()
            self.assertEqual(verify.call_args.args[0], existing)
            existing.write_bytes(b"corrupt model bytes!")
            with mock.patch.object(components.urllib.request, "urlopen") as fetch, \
                    self.assertRaises(ValueError):
                components.download(publisher, [existing.name], output)
            fetch.assert_not_called()

    @staticmethod
    def publisher(root, payload):
        publisher = root / "publisher.json"
        publisher.write_text(json.dumps({
            "id": "publisher/model", "sha": "a" * 40,
            "siblings": [{"rfilename": "model.safetensors", "size": len(payload),
                          "lfs": {"sha256": hashlib.sha256(payload).hexdigest()}}],
        }), encoding="utf-8")
        return publisher


if __name__ == "__main__":
    unittest.main()
