import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fizgig.minimax.video_vae_checkpoint import load_video_vae, verify_video_vae_checkpoint


class MiniMaxH3VAECheckpointTests(unittest.TestCase):
    def test_corrupt_checkpoints_fail_before_model_initialization(self):
        header = json.dumps({"weight": {"dtype": "F32", "shape": [4], "data_offsets": [0, 16]}}).encode()
        header += b" " * (-len(header) % 8)
        truncated = struct.pack("<Q", len(header)) + header + bytes(12)
        with tempfile.TemporaryDirectory() as temporary:
            checkpoint = Path(temporary) / "video.safetensors"
            for contents in (b"invalid checkpoint", truncated):
                with self.subTest(contents=contents[:8]):
                    checkpoint.write_bytes(contents)
                    with patch("diffusers.AutoencoderKLMiniMaxH3", create=True) as factory:
                        with self.assertRaisesRegex(ValueError, "incomplete or damaged.*Redownload"):
                            load_video_vae(checkpoint, "encode")
                        factory.assert_not_called()
                    with self.assertRaisesRegex(ValueError, "incomplete or damaged.*Redownload"):
                        verify_video_vae_checkpoint(checkpoint)


if __name__ == "__main__":
    unittest.main()
