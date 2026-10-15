from pathlib import Path
import math
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageOps
from media_upscale_settings import output_size, resolve_tile_size, validate_settings


def load_upscaler(request, device):
    from spandrel import ImageModelDescriptor, ModelLoader
    from torch import OutOfMemoryError

    validate_settings(request)
    model = ModelLoader().load_from_file(request["modelPath"])
    if not isinstance(model, ImageModelDescriptor) or model.input_channels != 3 or model.output_channels != 3 or model.scale < 2:
        raise ValueError("Choose a three-channel image super-resolution model.")
    try:
        return model.to(device).eval()
    except OutOfMemoryError as error:
        raise ValueError("The model does not fit in GPU memory. Close GPU applications or choose a smaller model.") from error


def tiled_upscale(source, model, torch, device, tile_size, report=None):
    factor = model.scale
    width, height = source.size
    if width * height * factor * factor > 64_000_000:
        raise ValueError("Upscaled image is too large. Resize the input first.")
    pixels = np.asarray(source.convert("RGB"), dtype=np.float32) / 255.0
    output = np.empty((height * factor, width * factor, 3), dtype=np.uint8)
    overlap = 32
    total = ((width + tile_size - 1) // tile_size) * ((height + tile_size - 1) // tile_size)
    completed = 0
    for top in range(0, height, tile_size):
        for left in range(0, width, tile_size):
            right, bottom = min(left + tile_size, width), min(top + tile_size, height)
            x0, y0 = max(0, left - overlap), max(0, top - overlap)
            x1, y1 = min(width, right + overlap), min(height, bottom + overlap)
            try:
                tensor = torch.from_numpy(pixels[y0:y1, x0:x1].copy()).permute(2, 0, 1).unsqueeze(0).to(device)
                with torch.inference_mode():
                    tile = model(tensor).float().cpu()[0].permute(1, 2, 0).numpy()
            except torch.OutOfMemoryError as error:
                raise ValueError("GPU memory is full. Close GPU applications or use smaller tiles and retry.") from error
            if tile.shape != ((y1 - y0) * factor, (x1 - x0) * factor, 3) or not np.isfinite(tile).all():
                raise ValueError("Upscaler returned invalid pixels or dimensions.")
            tile = tile.clip(0, 1)
            output[top*factor:bottom*factor, left*factor:right*factor] = np.round(tile[(top-y0)*factor:(bottom-y0)*factor, (left-x0)*factor:(right-x0)*factor] * 255).astype(np.uint8)
            completed += 1
            del tensor, tile
            if report:
                report(f"Upscaling tile {completed}/{total}", completed / total)
    return Image.fromarray(output)


def upscale_frame(source, model, torch, device, request, report=None):
    size = output_size(source.width, source.height, request)
    if size == source.size:
        return source.copy()
    result = source
    passes = max(1, math.ceil(math.log(max(size[0] / source.width, size[1] / source.height), model.scale) - 1e-10))
    for index in range(passes):
        tile_size = resolve_tile_size(request, result.width, result.height, model, torch, device)
        result = tiled_upscale(result, model, torch, device, tile_size,
            (lambda stage, value: report(stage, (index + value) / passes)) if report else None)
    if result.size != size:
        result = result.resize(size, Image.Resampling.LANCZOS)
    if "A" in source.getbands():
        result.putalpha(source.getchannel("A").resize(size, Image.Resampling.LANCZOS))
    return result


def upscale(request, torch, device, progress):
    progress("Loading upscaler", 0.05)
    model = load_upscaler(request, device)
    with Image.open(request["imagePath"]) as image:
        source = ImageOps.exif_transpose(image).convert("RGBA")
    tile_size = resolve_tile_size(request, source.width, source.height, model, torch, device)
    result = upscale_frame(source, model, torch, device, request, lambda stage, value: progress(stage, 0.1 + 0.85 * value))
    result.save(Path(request["outputDirectory"]) / "output.png")
    return {"width": result.width, "height": result.height, "architecture": model.architecture.id, "nativeScale": model.scale, "scale": result.width / source.width, "tileMode": request["tileMode"], "tileSize": tile_size, "device": str(device)}


def _finish_process(process, diagnostics, stage):
    try:
        code = process.wait(timeout=120)
    except subprocess.TimeoutExpired as error:
        raise ValueError(f"{stage} timed out.") from error
    if code:
        diagnostics.seek(0, 2)
        diagnostics.seek(max(0, diagnostics.tell() - 2000))
        raise ValueError(f"{stage} failed: {diagnostics.read().decode('utf-8', errors='replace')}")


def upscale_video(request, torch, device, progress):
    import imageio_ffmpeg
    from media_video_composition import _input_file, _output_directory, _decode, _has_alpha

    path = _input_file(request.get("inputPath"), "inputPath", webm=True)
    output_directory = _output_directory(request.get("outputDirectory"))
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    progress("Reading video", 0.01)
    streams = _decode(ffmpeg, path)
    video = streams["video"]
    if not video.contiguous:
        raise ValueError("Export the video at a constant frame rate, then retry.")
    alpha = _has_alpha(ffmpeg, path)
    progress("Loading upscaler", 0.05)
    model = load_upscaler(request, device)
    width, height = output_size(video.width, video.height, request)
    scale = width / video.width
    tile_size = resolve_tile_size(request, video.width, video.height, model, torch, device)
    if width > 16384 or height > 16384 or width * height > 16_000_000 or video.duration > 3600:
        raise ValueError("Video output is too large. Choose a smaller scale or shorter video.")
    output_directory.mkdir(parents=True, exist_ok=True)
    pixel_format, channels = ("rgba", 4) if alpha else ("rgb24", 3)
    common = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror"]
    decoder_args = [*common, *(["-c:v", "libvpx-vp9"] if alpha else []), "-i", str(path), "-map", "0:v:0", "-an", "-fps_mode", "passthrough", "-f", "rawvideo", "-pix_fmt", pixel_format, "pipe:1"]
    destination = output_directory / "output.webm"
    encoder_args = [*common, "-f", "rawvideo", "-pix_fmt", pixel_format, "-s", f"{width}x{height}", "-r", str(video.fps), "-i", "pipe:0", "-i", str(path), "-map", "0:v:0", "-map", "1:a:0?", "-c:a", "copy", "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p" if alpha else "yuv420p", "-auto-alt-ref", "0", "-crf", "18", "-b:v", "0", "-cpu-used", "4", "-threads", "4", "-map_metadata", "-1", "-n", str(destination)]
    decoder = encoder = None
    succeeded = False
    try:
        with tempfile.TemporaryFile() as decode_log, tempfile.TemporaryFile() as encode_log:
            decoder = subprocess.Popen(decoder_args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=decode_log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            encoder = subprocess.Popen(encoder_args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=encode_log, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            frame_bytes = video.width * video.height * channels
            count = 0
            while True:
                data = bytearray()
                while len(data) < frame_bytes:
                    chunk = decoder.stdout.read(frame_bytes - len(data))
                    if not chunk:
                        break
                    data.extend(chunk)
                if not data:
                    break
                if len(data) != frame_bytes:
                    raise ValueError("The video ended with an incomplete frame.")
                frame = Image.frombytes("RGBA" if alpha else "RGB", (video.width, video.height), bytes(data))
                result = upscale_frame(frame, model, torch, device, request)
                encoder.stdin.write(result.tobytes())
                count += 1
                progress(f"Upscaling frame {count}/{video.num_frames}", 0.1 + 0.8 * count / video.num_frames)
            encoder.stdin.close()
            _finish_process(decoder, decode_log, "Video decoding")
            _finish_process(encoder, encode_log, "Video encoding")
            if count != video.num_frames:
                raise ValueError("The upscaler did not process every video frame.")
        progress("Checking video", 0.95)
        checked = _decode(ffmpeg, destination)
        output = checked["video"]
        if (output.width, output.height, output.num_frames, output.fps) != (width, height, video.num_frames, video.fps) or not output.contiguous or ("audio" in checked) != ("audio" in streams):
            raise ValueError("The upscaled video has invalid dimensions, timing, or audio.")
        if alpha != _has_alpha(ffmpeg, destination):
            raise ValueError("The upscaled video did not preserve transparency.")
        if "audio" in streams and abs(checked["audio"].duration - streams["audio"].duration) > 0.025:
            raise ValueError("The upscaled video did not preserve the soundtrack duration.")
        succeeded = True
        return {"architecture": model.architecture.id, "device": str(device), "nativeScale": model.scale, "scale": scale, "tileMode": request["tileMode"], "tileSize": tile_size, "output": {"fileName": "output.webm", "width": width, "height": height, "numFrames": output.num_frames, "fps": float(output.fps), "durationSeconds": float(output.duration), "hasAudio": "audio" in checked, "hasAlpha": alpha}}
    finally:
        for process in (decoder, encoder):
            if process is not None:
                if process.poll() is None:
                    process.kill()
                process.wait()
                for stream in (process.stdin, process.stdout):
                    if stream is not None:
                        stream.close()
        if not succeeded:
            destination.unlink(missing_ok=True)
