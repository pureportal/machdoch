from contextlib import ExitStack
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
import wave

from local_speech_worker import forbid_network, transcribe


class LocalSpeechTests(unittest.TestCase):
    def test_rejects_unsupported_language_and_excess_key_terms(self):
        with self.assertRaisesRegex(ValueError, "English"):
            transcribe(Path("missing"), Path("missing.wav"), "de-DE", [])
        with self.assertRaisesRegex(ValueError, "25 key terms"):
            transcribe(Path("missing"), Path("missing.wav"), "en", ["country"] * 26)

    def test_rejects_corrupt_audio_and_missing_models(self):
        with tempfile.TemporaryDirectory(prefix="machdoch-speech-test-") as directory:
            root = Path(directory)
            audio = root / "recording.wav"
            with wave.open(str(audio), "wb") as recording:
                recording.setnchannels(2)
                recording.setframerate(48000)
                recording.setsampwidth(2)
                recording.writeframes(b"\0" * 400)
            with self.assertRaisesRegex(ValueError, "16 kHz mono"):
                transcribe(root, audio, None, [])
            with wave.open(str(audio), "wb") as recording:
                recording.setnchannels(1)
                recording.setframerate(16000)
                recording.setsampwidth(2)
            with self.assertRaisesRegex(ValueError, "empty"):
                transcribe(root, audio, None, [])
            with wave.open(str(audio), "wb") as recording:
                recording.setnchannels(1)
                recording.setframerate(16000)
                recording.setsampwidth(2)
                recording.writeframes(b"\0" * 32000)
            with self.assertRaisesRegex(RuntimeError, "missing"):
                transcribe(root, audio, None, [])

    def test_disables_network_and_external_fermion_configuration(self):
        with ExitStack() as stack:
            for target in ("socket.socket.connect", "socket.socket.connect_ex", "socket.create_connection", "socket.getaddrinfo"):
                stack.enter_context(patch(target))
            stack.enter_context(patch.dict(os.environ, {"FERMION_HUB_URL": "https://example.test", "FERMION_DEVICE": "cuda", "FERMION_P2_PARAKEET": "transformers"}))
            forbid_network()
            self.assertNotIn("FERMION_HUB_URL", os.environ)
            self.assertEqual(os.environ["FERMION_DEVICE"], "cpu")
            self.assertEqual(os.environ["FERMION_P2_PARAKEET"], "vendored")
            self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
            with socket.socket() as connection:
                with self.assertRaisesRegex(RuntimeError, "network"):
                    connection.connect(("127.0.0.1", 12345))
                with self.assertRaisesRegex(RuntimeError, "network"):
                    connection.connect_ex(("127.0.0.1", 12345))
            with self.assertRaisesRegex(RuntimeError, "network"):
                socket.create_connection(("127.0.0.1", 12345))
            with self.assertRaisesRegex(RuntimeError, "network"):
                socket.getaddrinfo("example.test", 443)


if __name__ == "__main__":
    unittest.main()
