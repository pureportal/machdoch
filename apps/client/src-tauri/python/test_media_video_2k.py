import unittest
import subprocess
import tempfile
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np

from media_video_2k import OUTPUT_SIZES, Video2KRegenerator, regenerate_video


class Video2KRegeneratorTests(unittest.TestCase):
    def test_output_sizes_are_even_and_match_the_requested_aspect(self):
        self.assertEqual(OUTPUT_SIZES["16:9"], (2560, 1440))
        for width, height in OUTPUT_SIZES.values():
            self.assertEqual(width % 2, 0)
            self.assertEqual(height % 2, 0)

    def test_static_and_moving_frames_preserve_size_and_source_colors(self):
        first = np.full((24, 40, 3), (80, 40, 20), dtype=np.uint8)
        first[:, 8:16] = (200, 150, 100)
        second = np.roll(first, 2, axis=1)
        regenerator = Video2KRegenerator(160, 96)

        for source in (first, second):
            result = regenerator.process(source)
            self.assertEqual(result.shape, (96, 160, 3))
            self.assertEqual(result.dtype, np.uint8)
            self.assertLess(np.abs(result[40, 120].astype(int) - source[10, 30].astype(int)).max(), 3)

    def test_rejects_invalid_frames_and_dimensions(self):
        with self.assertRaises(ValueError):
            Video2KRegenerator(159, 96)
        with self.assertRaises(ValueError):
            Video2KRegenerator(160, 96).process(np.zeros((24, 40), dtype=np.uint8))

    def test_video_stage_preserves_frame_count_and_audio(self):
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.mp4"
            destination = Path(directory) / "output.mp4"
            subprocess.run([
                ffmpeg, "-loglevel", "error", "-y", "-f", "lavfi", "-i",
                "testsrc=size=40x24:rate=24:duration=0.125", "-f", "lavfi", "-i",
                "sine=frequency=440:duration=0.125", "-c:v", "libx264",
                "-pix_fmt", "yuv420p", "-c:a", "aac", str(source),
            ], check=True, capture_output=True)

            self.assertEqual(regenerate_video(source, destination, (160, 96), audio_gain_db=-3), 3)
            capture = cv2.VideoCapture(str(destination))
            self.assertEqual(int(capture.get(cv2.CAP_PROP_FRAME_COUNT)), 3)
            self.assertEqual(int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), 160)
            self.assertEqual(int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)), 96)
            capture.release()
            decoded = subprocess.run([
                ffmpeg, "-loglevel", "error", "-i", str(destination),
                "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-",
            ], capture_output=True, text=True)
            self.assertEqual(decoded.returncode, 0, decoded.stderr)
            samples = []
            for video in (source, destination):
                audio = subprocess.run([
                    ffmpeg, "-loglevel", "error", "-i", str(video),
                    "-map", "0:a:0", "-f", "f32le", "-ac", "1", "pipe:1",
                ], capture_output=True, check=True)
                samples.append(np.frombuffer(audio.stdout, dtype=np.float32))
            source_rms, output_rms = (np.sqrt(np.mean(sample ** 2)) for sample in samples)
            self.assertAlmostEqual(output_rms / source_rms, 10 ** (-3 / 20), delta=0.05)


if __name__ == "__main__":
    unittest.main()
