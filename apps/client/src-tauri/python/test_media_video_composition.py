from __future__ import annotations

from array import array
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

import imageio_ffmpeg

import media_video_composition as composition


class VideoCompositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        cls.fixtures = tempfile.TemporaryDirectory(prefix="machdoch-video-fixtures-")
        cls.addClassCleanup(cls.fixtures.cleanup)
        cls.fixture_directory = Path(cls.fixtures.name)
        cls.red = cls.make_video("red", "red", "64x48", "10", 5)
        cls.blue = cls.make_video("blue", "blue", "48x64", "20", 10)
        cls.green = cls.make_video("green", "lime", "96x72", "10", 5)
        cls.red_audio = cls.make_video("red-audio", "red", "64x48", "10", 5, frequency=220)
        cls.green_audio = cls.make_video("green-audio", "lime", "64x48", "10", 5, frequency=880)
        cls.fractional = cls.make_video("fractional", "red", "32x24", "30000/1001", 6)
        cls.one_frame = cls.make_video("one-frame", "red", "32x24", "60", 1)
        cls.tones = cls.fixture_directory / "tones.wav"
        cls.run_ffmpeg([
            "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=0.25",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.25",
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000:duration=0.25",
            "-filter_complex", "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]",
            "-map", "[a]", "-c:a", "pcm_s16le", str(cls.tones),
        ])
        cls.audio_webm = cls.fixture_directory / "audio-only.webm"
        cls.run_ffmpeg(["-i", str(cls.tones), "-vn", "-c:a", "libopus", str(cls.audio_webm)])

    @classmethod
    def run_ffmpeg(cls, arguments):
        return subprocess.run(
            [cls.ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-nostdin", *arguments],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=True,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout

    @classmethod
    def make_video(cls, name, color, size, fps, frames, frequency=None):
        from fractions import Fraction

        destination = cls.fixture_directory / f"{name}.webm"
        arguments = ["-f", "lavfi", "-i", f"color=c={color}:s={size}:r={fps}"]
        if frequency is not None:
            arguments.extend(["-f", "lavfi", "-i", f"sine=frequency={frequency}:sample_rate=48000"])
        arguments.extend([
            "-map", "0:v:0", "-c:v", "libvpx-vp9", "-lossless", "1",
            "-pix_fmt", "yuv420p", "-threads", "1", "-t", f"{float(frames / Fraction(fps)):.12f}",
        ])
        if frequency is not None:
            arguments.extend(["-map", "1:a:0", "-c:a", "libopus"])
        else:
            arguments.append("-an")
        cls.run_ffmpeg([*arguments, str(destination)])
        return destination

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="machdoch-video-test-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.output_directory = self.directory / "output"

    def test_inspects_existing_video_and_its_soundtrack(self):
        result = composition.inspect_video({"inputPath": str(self.red_audio)}, lambda *_: None)["output"]
        self.assertEqual((result["width"], result["height"], result["numFrames"], result["fps"]), (64, 48, 5, 10))
        self.assertTrue(result["hasAudio"])
        self.assertAlmostEqual(result["durationSeconds"], 0.5)
        with self.assertRaises(ValueError):
            composition.inspect_video({"inputPath": str(self.audio_webm)}, lambda *_: None)

    def test_transparent_video_is_importable_and_not_silently_flattened(self):
        transparent = self.directory / "transparent.webm"
        self.run_ffmpeg([
            "-f", "lavfi", "-i", "color=c=red@0.25:s=32x24:r=10,format=rgba",
            "-frames:v", "2", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-threads", "1",
            str(transparent),
        ])
        metadata = composition.inspect_video({"inputPath": str(transparent)}, lambda *_: None)["output"]
        self.assertTrue(metadata["hasAlpha"])
        with self.assertRaisesRegex(ValueError, "opaque background"):
            composition.video_sequence(self.sequence_request([transparent, self.red]), lambda *_: None)
        self.assertFalse(self.output_directory.exists())

    def sequence_request(self, paths=None, **extra):
        return {
            "inputs": [{"path": str(path)} for path in (paths if paths is not None else [self.red, self.blue])],
            "outputDirectory": str(self.output_directory),
            **extra,
        }

    def audio_request(self, **extra):
        return {
            "inputPath": str(self.red_audio),
            "audioPath": str(self.tones),
            "outputDirectory": str(self.output_directory),
            **extra,
        }

    def worker(self, command, request):
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", str(Path(__file__).with_name("media_workflow_worker.py")), command],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            start_new_session=os.name != "nt",
        )
        try:
            output, diagnostics = process.communicate(json.dumps(request), timeout=60)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    capture_output=True,
                    check=True,
                    timeout=30,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )
            else:
                os.killpg(process.pid, signal.SIGKILL)
            output, diagnostics = process.communicate(timeout=10)
            self.fail(f"{command} exceeded 60 seconds:\n{diagnostics}\n{output}")
        self.assertEqual(process.returncode, 0, diagnostics + output)
        result = json.loads(output)
        self.assertEqual(result["schemaVersion"], 1)
        self.assertEqual(set(result), {"schemaVersion", "output"})
        self.assertIn("MACHDOCH_PROGRESS", diagnostics)
        self.assertNotIn("torch", diagnostics)
        return result["output"]

    def video_pixels(self, output):
        pixels = self.run_ffmpeg([
            "-i", str(self.output_directory / output["fileName"]),
            "-map", "0:v:0", "-an", "-pix_fmt", "rgb24", "-threads:v", "1", "-fps_mode", "passthrough",
            "-f", "rawvideo", "pipe:1",
        ])
        frame_size = output["width"] * output["height"] * 3
        self.assertEqual(len(pixels), frame_size * output["numFrames"])
        return [pixels[start:start + frame_size] for start in range(0, len(pixels), frame_size)]

    def center_pixel(self, frame, output):
        offset = ((output["height"] // 2) * output["width"] + output["width"] // 2) * 3
        return tuple(frame[offset:offset + 3])

    def audio_samples(self):
        samples = array("f")
        samples.frombytes(self.run_ffmpeg([
            "-i", str(self.output_directory / "output.webm"), "-map", "0:a:0", "-vn",
            "-ar", "48000", "-ac", "1", "-f", "f32le", "pipe:1",
        ]))
        if sys.byteorder != "little":
            samples.byteswap()
        return samples

    def assert_tone(self, samples, start, end, frequency):
        window = samples[round(start * 48000):round(end * 48000)]
        self.assertGreater(len(window), 0)
        strengths = {}
        for candidate in (220, 440, 880):
            sine = sum(value * math.sin(2 * math.pi * candidate * index / 48000) for index, value in enumerate(window))
            cosine = sum(value * math.cos(2 * math.pi * candidate * index / 48000) for index, value in enumerate(window))
            strengths[candidate] = sine * sine + cosine * cosine
        self.assertEqual(max(strengths, key=strengths.get), frequency, strengths)
        self.assertGreater(math.sqrt(sum(value * value for value in window) / len(window)), 0.02)

    def assert_silence(self, samples, start, end):
        window = samples[round(start * 48000):round(end * 48000)]
        self.assertGreater(len(window), 0)
        self.assertLess(math.sqrt(sum(value * value for value in window) / len(window)), 0.002)

    def test_cli_sequence_normalizes_scenes_and_retains_order(self):
        output = self.worker("video-sequence", self.sequence_request([self.red, self.blue, self.green]))
        self.assertEqual(output, {
            "fileName": "output.webm", "width": 64, "height": 48, "numFrames": 15,
            "fps": 10.0, "durationSeconds": 1.5, "hasAudio": False,
        })
        frames = self.video_pixels(output)
        for index, frame in enumerate(frames):
            pixel = self.center_pixel(frame, output)
            expected_channel = 0 if index < 5 else 2 if index < 10 else 1
            self.assertGreater(pixel[expected_channel], 230, (index, pixel))
            self.assertLess(sum(pixel) - pixel[expected_channel], 20, (index, pixel))
        middle = frames[7]
        edge = (24 * output["width"]) * 3
        self.assertLess(max(middle[edge:edge + 3]), 10)
        self.assertEqual(list(self.output_directory.iterdir()), [self.output_directory / "output.webm"])

    def test_first_scene_sets_size_and_fps_when_order_changes(self):
        output = self.worker("video-sequence", self.sequence_request([self.blue, self.red, self.blue]))
        self.assertEqual((output["width"], output["height"], output["fps"], output["numFrames"]), (48, 64, 20, 30))
        frames = self.video_pixels(output)
        for index, channel in ((0, 2), (9, 2), (10, 0), (19, 0), (20, 2), (29, 2)):
            self.assertGreater(self.center_pixel(frames[index], output)[channel], 230)

    def test_sequence_preserves_scene_audio_and_fills_silent_scenes(self):
        output = self.worker("video-sequence", self.sequence_request([self.red_audio, self.blue, self.green_audio]))
        self.assertTrue(output["hasAudio"])
        self.assertEqual(output["durationSeconds"], 1.5)
        samples = self.audio_samples()
        self.assertLessEqual(abs(len(samples) - 72000), 1200)
        self.assert_tone(samples, 0.1, 0.2, 220)
        self.assert_silence(samples, 0.7, 0.8)
        self.assert_tone(samples, 1.2, 1.3, 880)

    def test_sequence_replacement_seeks_audio_and_pads_to_video_length(self):
        output = self.worker("video-sequence", self.sequence_request(
            [self.red_audio, self.blue], audioPath=str(self.tones), audioStartSeconds=0.25,
        ))
        self.assertTrue(output["hasAudio"])
        self.assertEqual(output["durationSeconds"], 1.0)
        samples = self.audio_samples()
        self.assertLessEqual(abs(len(samples) - 48000), 1200)
        self.assert_tone(samples, 0.05, 0.15, 440)
        self.assert_tone(samples, 0.3, 0.4, 880)
        self.assert_silence(samples, 0.75, 0.85)

    def test_cli_audio_replaces_existing_soundtrack_and_trims_long_audio(self):
        output = self.worker("video-audio", self.audio_request())
        self.assertEqual(output, {
            "fileName": "output.webm", "width": 64, "height": 48, "numFrames": 5,
            "fps": 10.0, "durationSeconds": 0.5, "hasAudio": True,
        })
        samples = self.audio_samples()
        self.assertLessEqual(abs(len(samples) - 24000), 1200)
        self.assert_tone(samples, 0.05, 0.15, 220)
        self.assert_tone(samples, 0.3, 0.4, 440)
        self.video_pixels(output)

    def test_audio_adds_soundtrack_to_silent_video_and_pads_after_offset(self):
        output = self.worker("video-audio", self.audio_request(inputPath=str(self.red), audioStartSeconds=0.5))
        self.assertTrue(output["hasAudio"])
        samples = self.audio_samples()
        self.assert_tone(samples, 0.05, 0.15, 880)
        self.assert_silence(samples, 0.35, 0.45)

    def test_offset_at_or_after_audio_end_is_rejected_without_output(self):
        for index, offset in enumerate((0.75, 5)):
            with self.subTest(offset=offset):
                self.output_directory = self.directory / f"silent-{index}"
                with self.assertRaisesRegex(ValueError, "Audio start must be before"):
                    composition.video_audio(self.audio_request(audioStartSeconds=offset), lambda *_: None)
                self.assertFalse(self.output_directory.exists())

    def test_fractional_frame_rate_is_retained(self):
        output = self.worker("video-sequence", self.sequence_request([self.fractional, self.fractional]))
        self.assertEqual(output["numFrames"], 12)
        self.assertAlmostEqual(output["fps"], 30000 / 1001, places=8)
        self.assertAlmostEqual(output["durationSeconds"], 12 * 1001 / 30000, places=8)
        self.video_pixels(output)

    def test_single_frame_scene_and_existing_empty_directory(self):
        self.output_directory.mkdir()
        output = self.worker("video-sequence", self.sequence_request([self.one_frame]))
        self.assertEqual(output["numFrames"], 1)
        self.assertEqual(output["fps"], 60)
        self.video_pixels(output)

    def test_invalid_sequence_inputs_are_rejected_before_output_creation(self):
        requests = [
            None,
            self.sequence_request(inputs=None),
            self.sequence_request(inputs=[]),
            self.sequence_request(inputs="video.webm"),
            self.sequence_request(inputs=[None]),
            self.sequence_request(inputs=[{}]),
            self.sequence_request(inputs=[{"path": "relative.webm"}]),
            self.sequence_request(inputs=[{"path": str(self.directory / "missing.webm")}]),
            self.sequence_request(outputDirectory="relative"),
            self.sequence_request(audioPath="relative.wav"),
            self.sequence_request(audioPath=str(self.directory / "missing.wav")),
        ]
        for request in requests:
            with self.subTest(request=request):
                with self.assertRaises(ValueError):
                    composition.video_sequence(request, lambda *_: None)
                self.assertFalse(self.output_directory.exists())

    def test_invalid_audio_inputs_and_offsets_are_rejected(self):
        requests = [
            None,
            self.audio_request(inputPath="relative.webm"),
            self.audio_request(audioPath=None),
            self.audio_request(audioPath="relative.wav"),
            self.audio_request(outputDirectory="relative"),
            *[self.audio_request(audioStartSeconds=value) for value in (-1, True, None, "0", math.nan, math.inf, 10 ** 400)],
        ]
        for request in requests:
            with self.subTest(request=request):
                with self.assertRaises(ValueError):
                    composition.video_audio(request, lambda *_: None)
                self.assertFalse(self.output_directory.exists())

    def test_occupied_output_directory_and_file_are_rejected(self):
        self.output_directory.mkdir()
        existing = self.output_directory / "keep.txt"
        existing.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "new or empty"):
            composition.video_sequence(self.sequence_request(), lambda *_: None)
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep")
        with self.assertRaisesRegex(ValueError, "new or empty"):
            composition.video_audio(self.audio_request(outputDirectory=str(existing)), lambda *_: None)
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep")

    def test_invalid_media_and_audio_without_video_are_rejected(self):
        invalid = self.directory / "invalid.webm"
        invalid.write_bytes(b"not a WebM")
        corrupt = self.directory / "corrupt.webm"
        corrupt.write_bytes(b"\x1aE\xdf\xa3" + b"broken")
        fake_audio = self.directory / "invalid.wav"
        fake_audio.write_bytes(b"not audio")
        requests = [
            ("video-sequence", self.sequence_request([invalid])),
            ("video-sequence", self.sequence_request([corrupt])),
            ("video-sequence", self.sequence_request([self.audio_webm])),
            ("video-audio", self.audio_request(audioPath=str(fake_audio))),
            ("video-audio", self.audio_request(audioPath=str(self.red))),
        ]
        for command, request in requests:
            with self.subTest(command=command, request=request):
                handler = composition.video_sequence if command == "video-sequence" else composition.video_audio
                with self.assertRaises(ValueError):
                    handler(request, lambda *_: None)
                self.assertFalse(self.output_directory.exists())

    def test_decode_verification_failure_does_not_publish_output(self):
        decode = composition._decode

        def incorrect_frame_count(ffmpeg, path, **arguments):
            decoded = decode(ffmpeg, path, **arguments)
            if path.name == "output.webm":
                decoded["video"].num_frames += 1
            return decoded

        with mock.patch.object(composition, "_decode", side_effect=incorrect_frame_count):
            with self.assertRaisesRegex(ValueError, "expected video sequence"):
                composition.video_sequence(self.sequence_request([self.red]), lambda *_: None)
        self.assertEqual(list(self.output_directory.iterdir()), [])

    def test_cli_invalid_request_returns_schema_error(self):
        completed = subprocess.run(
            [sys.executable, "-I", "-B", str(Path(__file__).with_name("media_workflow_worker.py")), "video-sequence"],
            input=json.dumps(self.sequence_request(inputs=[])),
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.assertEqual(completed.returncode, 2)
        result = json.loads(completed.stdout)
        self.assertEqual(result["schemaVersion"], 1)
        self.assertIn("non-empty", result["error"])
        self.assertNotIn("output", result)


if __name__ == "__main__":
    unittest.main()
