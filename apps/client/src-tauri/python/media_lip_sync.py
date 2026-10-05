from __future__ import annotations

from itertools import islice
import math
from pathlib import Path
import tempfile
import wave

import numpy as np

from media_video_composition import (
    _absolute_path, _audio_start, _decode, _has_alpha, _input_file, _output_directory,
    _run_ffmpeg, video_audio,
)
from media_video_io import encode_frames


MODEL_FILES = (
    "musetalkV15/musetalk.json", "musetalkV15/unet.pth",
    "vae/config.json", "vae/diffusion_pytorch_model.safetensors",
    "whisper/config.json", "whisper/model.safetensors", "whisper/preprocessor_config.json",
    "face-parser/79999_iter.pth", "face-detector/face_detection_yunet_2023mar.onnx",
)


def integer_setting(request, key, minimum, maximum):
    value = request.get(key)
    if type(value) not in (int, float) or not math.isfinite(value) or value != int(value) or not minimum <= value <= maximum:
        raise ValueError(f"{key} must be an integer from {minimum} through {maximum}.")
    return int(value)


def model_directory(value) -> Path:
    root = _absolute_path(value, "modelPath")
    if root.is_symlink() or not root.is_dir():
        raise ValueError("Choose the MuseTalk 1.5 model folder or download it in Lip sync.")
    for relative in MODEL_FILES:
        path = root / relative
        if path.is_symlink() or not path.is_file() or path.stat().st_size == 0 or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"MuseTalk 1.5 is missing {relative}. Download the model again in Lip sync.")
    return root


def resampled_frames(path: Path, fps, count: int):
    import cv2

    capture = cv2.VideoCapture(str(path))
    input_index = -1
    frame = None
    try:
        for output_index in range(count):
            target = math.floor(output_index * fps / 25)
            while input_index < target:
                success, frame = capture.read()
                if not success:
                    raise ValueError("The video ended before its last frame. Export it again at a constant frame rate.")
                input_index += 1
            yield frame
    finally:
        capture.release()


def validate_timing(video, soundtrack, vocals, start):
    duration = video.duration
    if not video.contiguous or max(video.width, video.height) > 1920 or duration > 300:
        raise ValueError("Use a video up to 1920 pixels and five minutes with a constant frame rate.")
    count = math.ceil(duration * 25)
    needed = count / 25
    for label, stream in (("Audio", soundtrack), ("Vocals", vocals)):
        if float(stream.duration) - start + 1 / 16000 < needed:
            raise ValueError(f"{label} ends before the video. Supply a longer track or reduce Audio start.")
    return count


def lip_sync(request, progress):
    import imageio_ffmpeg
    import torch
    from media_diffusers_worker import _configure_amd_convolution_backend, _device
    from media_musetalk import MuseTalk, audio_embeddings

    if not isinstance(request, dict):
        raise ValueError("The lip sync request must be an object.")
    path = _input_file(request.get("inputPath"), "inputPath", webm=True)
    audio = _input_file(request.get("audioPath"), "audioPath")
    voice = _input_file(request.get("voicePath"), "voicePath") if request.get("voicePath") is not None else audio
    root = model_directory(request.get("modelPath"))
    output = _output_directory(request.get("outputDirectory"))
    start = _audio_start(request.get("audioStartSeconds"))
    batch_size = integer_setting(request, "batchSize", 1, 8)
    shift = integer_setting(request, "cropShift", -64, 64)
    seed = integer_setting(request, "seed", 0, 4294967295)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    progress("Reading video and audio", 0.02)
    streams = _decode(ffmpeg, path)
    video = streams["video"]
    soundtrack = _decode(ffmpeg, audio, audio_only=True)["audio"]
    vocals = soundtrack if voice == audio else _decode(ffmpeg, voice, audio_only=True)["audio"]
    count = validate_timing(video, soundtrack, vocals, start)
    if _has_alpha(ffmpeg, path):
        raise ValueError("Lip sync requires an opaque video. Composite the background first.")
    output.mkdir(parents=True, exist_ok=True)
    device, device_label, _ = _device(torch)
    _configure_amd_convolution_backend(torch, device)
    torch.set_num_threads(4)
    torch.manual_seed(seed)
    with tempfile.TemporaryDirectory(prefix="lip-sync-", dir=output.parent) as staging:
        staging = Path(staging)
        voice_wave = staging / "voice.wav"
        _run_ffmpeg(ffmpeg, [
            "-i", str(voice), "-ss", str(start), "-t", str(count / 25),
            "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(voice_wave),
        ], "Preparing vocals")
        with wave.open(str(voice_wave), "rb") as source:
            samples = np.frombuffer(source.readframes(source.getnframes()), dtype="<i2").astype(np.float32) / 32768
        if len(samples) < count * 640:
            raise ValueError("Vocals end before the video. Supply a longer track or reduce Audio start.")
        progress("Encoding vocals", 0.08)
        with torch.inference_mode():
            embeddings = audio_embeddings(samples, root, device, count)
            progress("Loading MuseTalk 1.5", 0.16)
            model = MuseTalk(root, device, seed)
            source_frames = resampled_frames(path, float(video.fps), count)

            def rendered_frames():
                for offset in range(0, count, batch_size):
                    frames = list(islice(source_frames, batch_size))
                    if len(frames) != min(batch_size, count - offset):
                        raise ValueError("Video decoding lost frames. Export the video again.")
                    yield from model.render_batch(frames, embeddings[offset:offset + len(frames)], shift, offset)
                    progress("Animating lips", 0.2 + 0.7 * (offset + len(frames)) / count)

            silent = staging / "silent.webm"
            try:
                encode_frames(ffmpeg, silent, rendered_frames(), 25, [
                    "-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-pix_fmt", "yuv420p", "-threads", "4",
                ], alpha=False, timeout_seconds=4 * 3600)
            finally:
                source_frames.close()
        progress("Saving soundtrack", 0.92)
        result = video_audio({
            "inputPath": str(silent), "audioPath": str(audio),
            "audioStartSeconds": start, "outputDirectory": str(output),
        }, lambda stage, fraction: progress(stage, 0.92 + fraction * 0.08))
    if result["output"]["numFrames"] != count or result["output"]["fps"] != 25:
        raise ValueError("Lip sync lost frame timing. Retry generation.")
    result["lipSync"] = {
        "model": "MuseTalk 1.5", "device": device_label, "seed": seed,
        "audioStartSeconds": start, "separateVocals": voice != audio,
        "cropShift": shift, "batchSize": batch_size,
    }
    return result
