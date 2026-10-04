import tempfile
from pathlib import Path
import unittest
import wave
import io
import sys
from unittest import mock

import numpy as np

from media_audio import validate_request, write_waveform


class AudioTests(unittest.TestCase):
    def request(self):
        return {"schemaVersion": 5, "model": {"architecture": "audioldm-2"}, "prompt": "A bird chirps", "negativePrompt": "Low quality", "durationSeconds": 5, "numInferenceSteps": 100, "guidanceScale": 3.5, "seed": 42}

    def test_invalid_audio_requests_are_rejected_before_loading(self):
        for key, values in {
            "schemaVersion": [4, None], "prompt": ["", " ", 3, "x" * 8001],
            "negativePrompt": [False, "x" * 8001], "durationSeconds": [0, 31, float("nan"), True],
            "numInferenceSteps": [0, 201, 1.5, True], "guidanceScale": [-1, 21, float("inf"), True],
            "seed": [-1, 9_007_199_254_740_992, True, 1.5],
            "model": [{"architecture": "cogvideox-2b"}, None], "addons": [[{}]],
        }.items():
            for value in values:
                request = {**self.request(), key: value}
                with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                    validate_request(request, 5)

    def test_waveform_duration_samples_and_dynamics_survive_wav_encoding(self):
        samples = np.sin(np.arange(20_000) * 0.1).astype(np.float32) * 0.6
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "output.wav"
            result = write_waveform(path, samples, 16_000, 1)
            with wave.open(str(path), "rb") as output:
                self.assertEqual((output.getnchannels(), output.getsampwidth(), output.getframerate(), output.getnframes()), (1, 2, 16_000, 16_000))
                decoded = np.frombuffer(output.readframes(16_000), dtype="<i2").astype(np.float32) / 32767
            np.testing.assert_allclose(decoded, samples[:16_000], atol=1 / 32767)
            self.assertEqual(result["gain"], 1)
            self.assertEqual(result["byteSize"], 32_044)

    def test_overloaded_waveform_preserves_relative_amplitude_without_clipping(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "output.wav"
            samples = np.tile(np.array([0.5, -2, 1], dtype=np.float32), 6000)
            result = write_waveform(path, samples, 16_000, 1)
            self.assertEqual(result["gain"], 0.5)
            with wave.open(str(path), "rb") as output:
                decoded = np.frombuffer(output.readframes(3), dtype="<i2")
            np.testing.assert_allclose(decoded / 32767, [0.25, -1, 0.5], atol=1 / 32767)

    def test_silent_nonfinite_incomplete_and_multichannel_outputs_are_rejected(self):
        invalid = [np.zeros(16_000), np.full(16_000, np.nan), np.full(16_000, np.inf), np.ones(15_999), np.ones((1, 16_000))]
        with tempfile.TemporaryDirectory() as directory:
            for samples in invalid:
                with self.subTest(shape=samples.shape), self.assertRaises(ValueError):
                    write_waveform(Path(directory) / "output.wav", samples, 16_000, 1)

    def test_command_dispatch_uses_the_canonical_audio_generator(self):
        import media_diffusers_worker as worker

        with mock.patch.object(sys, "argv", ["worker", "generate-audio"]), mock.patch.object(sys, "stdin", io.StringIO('{"schemaVersion":5}')), mock.patch.object(sys, "stdout", io.StringIO()) as output, mock.patch("media_audio.generate", return_value={"audio": "ok"}) as generate:
            self.assertEqual(worker.main(), 0)
            generate.assert_called_once_with({"schemaVersion": 5}, worker)
            self.assertIn('"audio":"ok"', output.getvalue())


if __name__ == "__main__":
    unittest.main()
