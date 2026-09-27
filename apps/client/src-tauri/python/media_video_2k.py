import argparse
import subprocess
from pathlib import Path

import cv2
import imageio_ffmpeg
import numpy as np


OUTPUT_SIZES = {
    "1:1": (2048, 2048),
    "16:9": (2560, 1440),
    "9:16": (1440, 2560),
    "21:9": (2560, 1138),
}


class Video2KRegenerator:
    def __init__(self, width: int, height: int):
        if width <= 0 or height <= 0 or width % 2 or height % 2:
            raise ValueError("2K output dimensions must be positive and even")
        self.size = (width, height)
        self.previous_low = None
        self.previous_high = None

    def process(self, frame: np.ndarray) -> np.ndarray:
        if frame.dtype != np.uint8 or frame.ndim != 3 or frame.shape[2] != 3:
            raise ValueError("Expected an RGB uint8 video frame")
        source = frame.astype(np.float32)
        high = cv2.resize(source, self.size, interpolation=cv2.INTER_LANCZOS4)
        high = self._back_project(high, source)

        blurred = cv2.GaussianBlur(high, (0, 0), 0.9)
        gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
        edges = cv2.magnitude(
            cv2.Sobel(gray, cv2.CV_32F, 1, 0),
            cv2.Sobel(gray, cv2.CV_32F, 0, 1),
        )
        edge_weight = cv2.resize(np.clip(edges / 96.0, 0, 1), self.size, interpolation=cv2.INTER_LINEAR)
        high += (high - blurred) * edge_weight[:, :, None] * 0.25

        if self.previous_low is not None:
            previous_gray = cv2.cvtColor(self.previous_low, cv2.COLOR_RGB2GRAY)
            low_flow = cv2.calcOpticalFlowFarneback(gray, previous_gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
            low_coordinates = np.indices(frame.shape[:2], dtype=np.float32)
            previous_low = cv2.remap(
                self.previous_low,
                low_coordinates[1] + low_flow[:, :, 0],
                low_coordinates[0] + low_flow[:, :, 1],
                cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_REFLECT,
            )
            flow = cv2.resize(low_flow, self.size, interpolation=cv2.INTER_LINEAR)
            flow[:, :, 0] *= self.size[0] / frame.shape[1]
            flow[:, :, 1] *= self.size[1] / frame.shape[0]
            coordinates = np.indices((self.size[1], self.size[0]), dtype=np.float32)
            remap_x = coordinates[1] + flow[:, :, 0]
            remap_y = coordinates[0] + flow[:, :, 1]
            previous = cv2.remap(self.previous_high, remap_x, remap_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
            difference = np.mean(np.abs(source - previous_low.astype(np.float32)), axis=2)
            confidence = cv2.resize(np.exp(-difference / 18.0), self.size, interpolation=cv2.INTER_LINEAR)
            previous_detail = previous - cv2.GaussianBlur(previous, (0, 0), 1.1)
            high += previous_detail * (confidence * 0.12)[:, :, None]

        high = self._back_project(high, source)
        result = np.clip(np.rint(high), 0, 255).astype(np.uint8)
        self.previous_low = frame.copy()
        self.previous_high = result.astype(np.float32)
        return result

    def _back_project(self, high: np.ndarray, source: np.ndarray) -> np.ndarray:
        for _ in range(2):
            low = cv2.resize(high, (source.shape[1], source.shape[0]), interpolation=cv2.INTER_AREA)
            residual = source - low
            high += cv2.resize(residual, self.size, interpolation=cv2.INTER_CUBIC) * 0.85
        return high


def regenerate_video(source: Path, destination: Path, size: tuple[int, int], audio_gain_db: float = 0.0) -> int:
    if source.resolve() == destination.resolve():
        raise ValueError("Input and output video paths must differ")
    if destination.suffix.lower() != ".mp4":
        raise ValueError("2K video output must be an MP4 file")
    if not np.isfinite(audio_gain_db):
        raise ValueError("Audio gain must be finite")
    capture = cv2.VideoCapture(str(source))
    if not capture.isOpened():
        raise ValueError(f"Cannot open video: {source}")
    fps = capture.get(cv2.CAP_PROP_FPS)
    if not np.isfinite(fps) or fps <= 0:
        capture.release()
        raise ValueError("Source video has no valid frame rate")
    destination.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg, "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
        "-s", f"{size[0]}x{size[1]}", "-r", str(fps), "-i", "pipe:0",
        "-i", str(source), "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "libx264",
        "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-c:a", "aac",
        "-b:a", "192k",
    ]
    if audio_gain_db:
        command.extend(["-af", f"volume={audio_gain_db}dB"])
    command.extend(["-shortest", str(destination)])
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    regenerator = Video2KRegenerator(*size)
    count = 0
    try:
        while True:
            success, bgr = capture.read()
            if not success:
                break
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            process.stdin.write(regenerator.process(rgb).tobytes())
            count += 1
        process.stdin.close()
        error = process.stderr.read().decode(errors="replace")
        if process.wait() != 0:
            raise RuntimeError(error[-2000:])
        if count == 0:
            raise ValueError("Source video has no decodable frames")
        return count
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        capture.release()
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stderr.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--aspect-ratio", choices=OUTPUT_SIZES, default="16:9")
    args = parser.parse_args()
    count = regenerate_video(args.input, args.output, OUTPUT_SIZES[args.aspect_ratio])
    print(f"{args.output} ({count} frames)")


if __name__ == "__main__":
    main()
