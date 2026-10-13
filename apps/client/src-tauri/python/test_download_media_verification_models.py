import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.request

from download_media_verification_models import ModelDownloadRedirects, download


class DeliveryResponse(io.BytesIO):
    def __init__(self, content=b"", content_range=None, status=200):
        super().__init__(content)
        self.status = status
        self.headers = {"Content-Range": content_range}

    def geturl(self):
        return "https://b2.civitai.com/model.gguf"


class ModelDownloadsTest(unittest.TestCase):
    def test_delivery_redirect_removes_api_credentials(self):
        request = urllib.request.Request("https://civitai.com/api/download/models/1", headers={"Authorization": "Bearer test-only", "User-Agent": "machdoch"})
        redirected = ModelDownloadRedirects().redirect_request(request, None, 302, "Found", {}, "https://b2.civitai.com/model.safetensors")
        self.assertIsNone(redirected.get_header("Authorization"))
        self.assertEqual(redirected.get_header("User-agent"), "machdoch")

    def test_redirect_rejects_untrusted_or_unencrypted_delivery(self):
        request = urllib.request.Request("https://civitai.com/api/download/models/1", headers={"Authorization": "Bearer test-only"})
        for target in ["https://civitai.com.example.org/file", "http://b2.civitai.com/file", "https://example.org/file"]:
            with self.subTest(target=target), self.assertRaises(ValueError):
                ModelDownloadRedirects().redirect_request(request, None, 302, "Found", {}, target)

    def test_metadata_cannot_send_credentials_to_an_external_file_url(self):
        metadata = {"modelVersions": [{"id": 2, "files": [{"name": "model.gguf", "sizeKB": 1, "hashes": {"SHA256": "0" * 64}, "downloadUrl": "https://example.org/file"}]}]}
        with tempfile.TemporaryDirectory() as directory, patch("urllib.request.build_opener") as build:
            opener = build.return_value
            opener.open.return_value = io.BytesIO(json.dumps(metadata).encode())
            with self.assertRaisesRegex(ValueError, "unexpected download URL"):
                download(Path(directory), 1, 2, "model.gguf", "test-only")
            self.assertEqual(opener.open.call_count, 1)

    def test_digest_failure_does_not_activate_partial_model(self):
        metadata = {"modelVersions": [{"id": 2, "files": [{"name": "model.gguf", "sizeKB": 8 / 1024, "hashes": {"SHA256": hashlib.sha256(b"expected").hexdigest()}, "downloadUrl": "https://civitai.com/api/download/models/2"}]}]}
        with tempfile.TemporaryDirectory() as directory, patch("urllib.request.build_opener") as build:
            build.return_value.open.side_effect = [io.BytesIO(json.dumps(metadata).encode()), DeliveryResponse(), DeliveryResponse(b"corrupt!", "bytes 0-7/8", 206)]
            with self.assertRaisesRegex(ValueError, "unexpected digest"):
                download(Path(directory), 1, 2, "model.gguf", "test-only")
            destination = Path(directory) / "1/2/model.gguf"
            self.assertFalse(destination.exists())
            self.assertTrue(destination.with_suffix(".gguf.part").is_file())

    def test_incomplete_transfer_does_not_activate_partial_model(self):
        metadata = {"modelVersions": [{"id": 2, "files": [{"name": "model.gguf", "sizeKB": 16 / 1024, "hashes": {"SHA256": hashlib.sha256(b"expected").hexdigest()}, "downloadUrl": "https://civitai.com/api/download/models/2"}]}]}
        with tempfile.TemporaryDirectory() as directory, patch("urllib.request.build_opener") as build:
            build.return_value.open.side_effect = [io.BytesIO(json.dumps(metadata).encode()), DeliveryResponse(), DeliveryResponse(b"expected", "bytes 0-15/16", 206)]
            with self.assertRaisesRegex(ValueError, "received 8 of 16 bytes"):
                download(Path(directory), 1, 2, "model.gguf", "test-only")
            destination = Path(directory) / "1/2/model.gguf"
            self.assertFalse(destination.exists())
            self.assertTrue(destination.with_suffix(".gguf.part").is_file())

    def test_partial_checkpoint_resumes_without_sending_api_credentials_to_delivery(self):
        content = b"verified"
        metadata = {"name": "Reviewed", "modelVersions": [{"id": 2, "baseModel": "Test", "files": [{"name": "model.gguf", "sizeKB": len(content) / 1024, "hashes": {"SHA256": hashlib.sha256(content).hexdigest()}, "downloadUrl": "https://civitai.com/api/download/models/2"}]}]}
        with tempfile.TemporaryDirectory() as directory, patch("urllib.request.build_opener") as build:
            destination = Path(directory) / "1/2/model.gguf"
            destination.parent.mkdir(parents=True)
            destination.with_suffix(".gguf.part").write_bytes(content[:3])
            build.return_value.open.side_effect = [io.BytesIO(json.dumps(metadata).encode()), DeliveryResponse(), DeliveryResponse(content[3:], "bytes 3-7/8", 206)]
            download(Path(directory), 1, 2, "model.gguf", "test-only")
            self.assertEqual(destination.read_bytes(), content)
            self.assertFalse(destination.with_suffix(".gguf.part").exists())
            delivery_request = build.return_value.open.call_args_list[2].args[0]
            self.assertEqual(delivery_request.get_header("Range"), "bytes=3-7")
            self.assertIsNone(delivery_request.get_header("Authorization"))

    def test_server_ignoring_range_does_not_append_the_wrong_payload(self):
        content = b"verified"
        metadata = {"modelVersions": [{"id": 2, "files": [{"name": "model.gguf", "sizeKB": len(content) / 1024, "hashes": {"SHA256": hashlib.sha256(content).hexdigest()}, "downloadUrl": "https://civitai.com/api/download/models/2"}]}]}
        with tempfile.TemporaryDirectory() as directory, patch("urllib.request.build_opener") as build:
            destination = Path(directory) / "1/2/model.gguf"
            destination.parent.mkdir(parents=True)
            partial = destination.with_suffix(".gguf.part")
            partial.write_bytes(content[:3])
            build.return_value.open.side_effect = [io.BytesIO(json.dumps(metadata).encode()), DeliveryResponse(), DeliveryResponse(content)]
            with self.assertRaisesRegex(ValueError, "requested byte range"):
                download(Path(directory), 1, 2, "model.gguf", "test-only")
            self.assertEqual(partial.read_bytes(), content[:3])
            self.assertFalse(destination.exists())

    def test_multiple_ranges_share_one_resolved_delivery_link(self):
        content = b"verified"
        metadata = {"name": "Reviewed", "modelVersions": [{"id": 2, "baseModel": "Test", "files": [{"name": "model.gguf", "sizeKB": len(content) / 1024, "hashes": {"SHA256": hashlib.sha256(content).hexdigest()}, "downloadUrl": "https://civitai.com/api/download/models/2"}]}]}
        with tempfile.TemporaryDirectory() as directory, patch("urllib.request.build_opener") as build, patch("download_media_verification_models.CHECKPOINT_RANGE_BYTES", 4):
            build.return_value.open.side_effect = [
                io.BytesIO(json.dumps(metadata).encode()), DeliveryResponse(),
                DeliveryResponse(content[:4], "bytes 0-3/8", 206),
                DeliveryResponse(content[4:], "bytes 4-7/8", 206),
            ]
            download(Path(directory), 1, 2, "model.gguf", "test-only")
            destination = Path(directory) / "1/2/model.gguf"
            self.assertEqual(destination.read_bytes(), content)
            self.assertEqual(build.return_value.open.call_count, 4)
            requests = [call.args[0] for call in build.return_value.open.call_args_list[2:]]
            self.assertEqual([request.get_header("Range") for request in requests], ["bytes=0-3", "bytes=4-7"])
            self.assertTrue(all(request.get_header("Authorization") is None for request in requests))


if __name__ == "__main__":
    unittest.main()
