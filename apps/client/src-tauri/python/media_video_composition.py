from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import math
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Any, Callable


Progress = Callable[[str, float], None]


@dataclass
class DecodedStream:
    media_type: str = ""
    time_base: Fraction = Fraction(0)
    width: int = 0
    height: int = 0
    num_frames: int = 0
    first_pts: int | None = None
    end_pts: int = 0
    contiguous: bool = True

    @property
    def duration(self) -> Fraction:
        return (self.end_pts - self.first_pts) * self.time_base if self.first_pts is not None else Fraction(0)

    @property
    def fps(self) -> Fraction:
        return 1 / self.time_base


def _absolute_path(value: Any, name: str) -> Path:
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ValueError(f"{name} must be an absolute path.")
    path = Path(value)
    if not path.is_absolute():
        raise ValueError(f"{name} must be an absolute path.")
    return path


def _input_file(value: Any, name: str, *, webm: bool = False) -> Path:
    path = _absolute_path(value, name)
    if not path.is_file():
        raise ValueError(f"{name} must point to an existing file.")
    if webm:
        with path.open("rb") as source:
            signature = source.read(4)
        if path.suffix.lower() != ".webm" or signature != b"\x1aE\xdf\xa3":
            raise ValueError(f"{name} must point to a WebM video.")
    return path


def _output_directory(value: Any) -> Path:
    path = _absolute_path(value, "outputDirectory")
    if path.is_symlink() or (path.exists() and (not path.is_dir() or any(path.iterdir()))):
        raise ValueError("outputDirectory must be a new or empty directory.")
    return path


def _audio_start(value: Any) -> float:
    if type(value) not in (int, float):
        raise ValueError("audioStartSeconds must be a finite number greater than or equal to zero.")
    try:
        seconds = float(value)
    except OverflowError as error:
        raise ValueError("audioStartSeconds must be finite.") from error
    if not math.isfinite(seconds) or seconds < 0:
        raise ValueError("audioStartSeconds must be a finite number greater than or equal to zero.")
    return seconds


def _run_ffmpeg(ffmpeg: str, arguments: list[str], stage: str) -> str:
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as diagnostics:
        try:
            completed = subprocess.run(
                [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", *arguments],
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=diagnostics,
                timeout=900,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired as error:
            raise ValueError(f"{stage} timed out.") from error
        except OSError as error:
            raise ValueError(f"{stage} could not start: {error}") from error
        if completed.returncode != 0:
            diagnostics.seek(0, 2)
            diagnostics.seek(max(0, diagnostics.tell() - 2_000))
            diagnostic = diagnostics.read().decode("utf-8", errors="replace").strip()
            raise ValueError(f"{stage} failed: {diagnostic or completed.returncode}")
        output.seek(0)
        return output.read().decode("utf-8", errors="strict")


def _decode(ffmpeg: str, path: Path, *, audio_only: bool = False) -> dict[str, DecodedStream]:
    maps = ["-map", "0:a:0", "-vn"] if audio_only else ["-map", "0:v:0", "-map", "0:a:0?"]
    video_arguments = [] if audio_only else [
        "-c:v", "rawvideo", "-pix_fmt", "rgb24", "-threads:v", "1", "-fps_mode", "passthrough",
    ]
    report = _run_ffmpeg(
        ffmpeg,
        [
            "-err_detect", "explode", "-i", str(path), *maps, *video_arguments,
            "-c:a", "pcm_s16le", "-f", "framehash", "pipe:1",
        ],
        f"Decoding {path.name}",
    )
    streams: dict[int, DecodedStream] = {}
    for line in report.splitlines():
        header = re.fullmatch(r"#(tb|media_type|dimensions)\s+(\d+):\s*(.*)", line)
        if header:
            field, index, value = header.groups()
            stream = streams.setdefault(int(index), DecodedStream())
            if field == "tb":
                stream.time_base = Fraction(value)
            elif field == "media_type":
                stream.media_type = value
            else:
                stream.width, stream.height = (int(part) for part in value.split("x"))
        elif line and not line.startswith("#"):
            index, _, pts, duration, size = (int(part.strip()) for part in line.split(",")[:5])
            stream = streams[index]
            if duration <= 0 or size <= 0 or stream.time_base <= 0:
                raise ValueError(f"{path.name} contains invalid decoded frames.")
            if stream.media_type == "video" and size != stream.width * stream.height * 3:
                raise ValueError(f"{path.name} contains inconsistent video dimensions.")
            if stream.first_pts is None:
                stream.first_pts = pts
            elif pts != stream.end_pts:
                stream.contiguous = False
            stream.end_pts = pts + duration
            stream.num_frames += 1
    decoded = {stream.media_type: stream for stream in streams.values() if stream.num_frames}
    required = "audio" if audio_only else "video"
    if required not in decoded or decoded[required].duration <= 0:
        raise ValueError(f"{path.name} contains no decodable {required}.")
    return decoded


def _has_alpha(ffmpeg: str, path: Path) -> bool:
    metadata = _run_ffmpeg(ffmpeg, ["-i", str(path), "-map_metadata", "0:s:v:0", "-f", "ffmetadata", "pipe:1"], "Reading video transparency")
    return any(line.strip().lower() == "alpha_mode=1" for line in metadata.splitlines())


def _soundtrack_filter(source: str, label: str, duration: Fraction, start: float = 0) -> str:
    return (
        f"{source}asetpts=PTS-STARTPTS,atrim=start={start:.12f},asetpts=PTS-STARTPTS,"
        "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,"
        f"apad,atrim=duration={float(duration):.12f},asetpts=N/SR/TB[{label}]"
    )


def _compose(
    paths: list[Path],
    audio_path: Path | None,
    audio_start: float,
    output_directory: Path,
    progress: Progress,
) -> dict[str, Any]:
    import imageio_ffmpeg

    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    decoded = []
    for index, path in enumerate(paths):
        progress(f"Reading scene {index + 1}/{len(paths)}", 0.05 + 0.25 * index / len(paths))
        if _has_alpha(ffmpeg, path):
            raise ValueError("Choose clips with an opaque background before joining scenes or setting a soundtrack.")
        decoded.append(_decode(ffmpeg, path))
    first = decoded[0]["video"]
    width, height, fps = first.width, first.height, first.fps
    if width <= 0 or height <= 0 or fps <= 0:
        raise ValueError("The first scene has invalid dimensions or frame rate.")
    frame_counts = [
        max(1, math.floor(scene["video"].duration * fps + Fraction(1, 2)))
        for scene in decoded
    ]
    num_frames = sum(frame_counts)
    duration = num_frames / fps
    has_audio = audio_path is not None or any("audio" in scene for scene in decoded)
    if audio_path is not None:
        progress("Reading soundtrack", 0.3)
        audio = _decode(ffmpeg, audio_path, audio_only=True)["audio"]
        if audio_start >= audio.duration:
            raise ValueError(f"Audio start must be before {float(audio.duration):g} seconds.")

    arguments = []
    filters = []
    labels = []
    preserve_audio = has_audio and audio_path is None
    for index, (path, scene, frame_count) in enumerate(zip(paths, decoded, frame_counts, strict=True)):
        arguments.extend(["-err_detect", "explode", "-i", str(path)])
        filters.append(
            f"[{index}:v:0]setpts=PTS-STARTPTS,fps={fps}:round=near,"
            f"scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,"
            f"tpad=stop_mode=clone:stop_duration=1,trim=end_frame={frame_count},"
            f"setpts=N/({fps}*TB)[v{index}]"
        )
        labels.append(f"[v{index}]")
        if preserve_audio:
            source = f"[{index}:a:0]" if "audio" in scene else "anullsrc=r=48000:cl=stereo,"
            filters.append(_soundtrack_filter(source, f"a{index}", frame_count / fps))
            labels.append(f"[a{index}]")
    concat_outputs = "[joined][aout]" if preserve_audio else "[joined]"
    filters.append(f"{''.join(labels)}concat=n={len(paths)}:v=1:a={int(preserve_audio)}{concat_outputs}")
    filters.append(f"[joined]setpts=N/({fps}*TB)[vout]")
    if audio_path is not None:
        arguments.extend(["-err_detect", "explode", "-i", str(audio_path)])
        filters.append(_soundtrack_filter(f"[{len(paths)}:a:0]", "aout", duration, audio_start))
    arguments.extend(["-filter_complex_threads", "1", "-filter_complex", ";".join(filters), "-map", "[vout]"])
    if has_audio:
        arguments.extend(["-map", "[aout]", "-c:a", "libopus", "-b:a", "192k", "-ar", "48000", "-ac", "2"])
    else:
        arguments.append("-an")
    arguments.extend([
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuv420p", "-crf", "18", "-b:v", "0",
        "-deadline", "good", "-cpu-used", "2",
        "-threads", str(min(4, math.ceil(height / 64))),
        "-r", str(fps), "-fps_mode", "cfr", "-frames:v", str(num_frames),
        "-t", f"{float(duration):.12f}",
        "-map_metadata", "-1", "-f", "webm", "-n",
    ])

    output_directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="machdoch-video-", dir=output_directory) as temporary:
        destination = Path(temporary) / "output.webm"
        progress("Composing video", 0.4)
        _run_ffmpeg(ffmpeg, [*arguments, str(destination)], "Video composition")
        progress("Checking video", 0.9)
        result = _decode(ffmpeg, destination)
        video = result["video"]
        if (
            (video.width, video.height, video.fps, video.num_frames) != (width, height, fps, num_frames)
            or not video.contiguous
            or ("audio" in result) != has_audio
        ):
            raise ValueError("The output did not decode to the expected video sequence.")
        if has_audio and abs(result["audio"].duration - duration) > Fraction(1, 40):
            raise ValueError("The output soundtrack does not match the video duration.")
        destination.rename(output_directory / "output.webm")
    progress("Video ready", 1.0)
    return {
        "output": {
            "fileName": "output.webm",
            "width": video.width,
            "height": video.height,
            "numFrames": video.num_frames,
            "fps": video.fps.numerator if video.fps.denominator == 1 else float(video.fps),
            "durationSeconds": float(video.duration),
            "hasAudio": has_audio,
        },
    }


def video_sequence(request: dict[str, Any], progress: Progress) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("The video sequence request must be an object.")
    inputs = request.get("inputs")
    if not isinstance(inputs, list) or not inputs:
        raise ValueError("inputs must be an ordered, non-empty list of scenes.")
    paths = []
    for index, scene in enumerate(inputs):
        if not isinstance(scene, dict):
            raise ValueError(f"inputs[{index}] must contain a path.")
        paths.append(_input_file(scene.get("path"), f"inputs[{index}].path", webm=True))
    audio_path = _input_file(request["audioPath"], "audioPath") if request.get("audioPath") is not None else None
    audio_start = _audio_start(request.get("audioStartSeconds", 0))
    output_directory = _output_directory(request.get("outputDirectory"))
    return _compose(paths, audio_path, audio_start, output_directory, progress)


def video_audio(request: dict[str, Any], progress: Progress) -> dict[str, Any]:
    if not isinstance(request, dict):
        raise ValueError("The video audio request must be an object.")
    path = _input_file(request.get("inputPath"), "inputPath", webm=True)
    audio_path = _input_file(request.get("audioPath"), "audioPath")
    audio_start = _audio_start(request.get("audioStartSeconds", 0))
    output_directory = _output_directory(request.get("outputDirectory"))
    return _compose([path], audio_path, audio_start, output_directory, progress)


def inspect_video(request: dict[str, Any], progress: Progress, *, require_webm: bool = True) -> dict[str, Any]:
    import imageio_ffmpeg

    path = _input_file(request.get("inputPath"), "inputPath", webm=require_webm)
    progress("Reading video", 0.1)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    streams = _decode(ffmpeg, path)
    video = streams["video"]
    if not video.contiguous:
        raise ValueError("The video has missing frames; export it again with a constant frame rate.")
    progress("Video ready", 1.0)
    return {"output": {
        "width": video.width, "height": video.height,
        "numFrames": video.num_frames, "fps": float(video.fps),
        "durationSeconds": float(video.duration), "hasAudio": "audio" in streams,
        "hasAlpha": _has_alpha(ffmpeg, path),
    }}
