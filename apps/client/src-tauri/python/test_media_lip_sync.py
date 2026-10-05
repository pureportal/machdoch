from fractions import Fraction
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import cv2
import imageio_ffmpeg
import numpy as np

from media_lip_sync import integer_setting, model_directory, MODEL_FILES, resampled_frames, validate_timing
from media_video_composition import DecodedStream, _decode
from media_video_io import encode_frames


class LipSyncBoundaryTests(unittest.TestCase):
    def test_rejects_incomplete_packages_and_symlinked_components(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(ValueError, "missing"):
                model_directory(str(root))
            for relative in MODEL_FILES:
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(b"model")
            self.assertEqual(model_directory(str(root)), root)
            with mock.patch.object(Path, "is_symlink", return_value=True):
                with self.assertRaises(ValueError):
                    model_directory(str(root))

    def test_rejects_invalid_settings_at_worker_boundary(self):
        for value in (True, None, "4", -1, 0, 1.5, 9, float("inf"), float("nan")):
            with self.subTest(value=value), self.assertRaises(ValueError):
                integer_setting({"batchSize": value}, "batchSize", 1, 8)
        self.assertEqual(integer_setting({"batchSize": 4.0}, "batchSize", 1, 8), 4)

    def test_audio_and_vocals_must_cover_the_entire_video_after_offset(self):
        video = DecodedStream("video", Fraction(1, 10), 640, 480, 20, 0, 20)
        audio = DecodedStream("audio", Fraction(1, 48000), first_pts=0, end_pts=144000)
        self.assertEqual(validate_timing(video, audio, audio, 1), 50)
        for start in (1.001, 3):
            with self.assertRaisesRegex(ValueError, "Audio ends"):
                validate_timing(video, audio, audio, start)
        short_voice = DecodedStream("audio", Fraction(1, 16000), first_pts=0, end_pts=16000)
        with self.assertRaisesRegex(ValueError, "Vocals ends"):
            validate_timing(video, audio, short_voice, 0)

    def test_rejects_missing_frame_timing_and_oversized_video(self):
        audio = DecodedStream("audio", Fraction(1, 48000), first_pts=0, end_pts=48000000)
        for width, frames, contiguous in ((1921, 20, True), (640, 3001, True), (640, 20, False)):
            video = DecodedStream("video", Fraction(1, 10), width, 480, frames, 0, frames, contiguous)
            with self.assertRaises(ValueError):
                validate_timing(video, audio, audio, 0)

    def test_resampling_preserves_a_scene_cut_without_temporal_blending(self):
        frames = [np.full((48, 64, 3), value, np.uint8) for value in (10, 20, 200, 210)]
        capture = mock.Mock()
        capture.read.side_effect = [(True, frame) for frame in frames]
        with mock.patch.object(cv2, "VideoCapture", return_value=capture):
            output = list(resampled_frames(Path("input.webm"), 10, 10))
        self.assertEqual([int(frame[0, 0, 0]) for frame in output], [10, 10, 10, 20, 20, 200, 200, 200, 210, 210])
        capture.release.assert_called_once()

    def test_streaming_encoder_keeps_exact_frame_count_and_releases_failed_streams(self):
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "output.webm"
            frames = (np.full((48, 64, 3), index * 10, np.uint8) for index in range(10))
            encode_frames(ffmpeg, target, frames, 25, ["-c:v", "libvpx-vp9", "-threads", "1"], alpha=False)
            video = _decode(ffmpeg, target)["video"]
            self.assertEqual((video.num_frames, video.fps, video.duration), (10, 25, Fraction(2, 5)))
            invalid = iter([np.zeros((48, 64, 3), np.uint8), np.zeros((16, 16, 3), np.uint8)])
            with self.assertRaisesRegex(ValueError, "matching dimensions"):
                encode_frames(ffmpeg, Path(directory) / "invalid.webm", invalid, 25, ["-c:v", "libvpx-vp9"], alpha=False)


if __name__ == "__main__":
    unittest.main()
