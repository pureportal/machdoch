import base64
import gc
import io
import wave
from pathlib import Path

import torch

from media_refmods import integer, load_reference, reference_visual_frame_count, weaken_reference
from media_refmod_conditioning import reference_video_decode_plan
from media_refmod_models import vae_path


def encode_image(pixels):
    import numpy as np
    from PIL import Image

    image = Image.fromarray((pixels.permute(1, 2, 0).clamp(0, 1).cpu().numpy() * 255).astype(np.uint8))
    image.thumbnail((500, 500), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def encode_audio(samples):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(32000)
        pcm = (samples[:, :64000].clamp(-1, 1).T.cpu().numpy() * 32767).astype("<i2")
        output.writeframes(pcm.tobytes())
    return "data:audio/wav;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")


def preview(request):
    from fizgig.minimax.audio_vae import load_audio_vae
    from fizgig.minimax.video_vae_checkpoint import load_video_vae

    reference = load_reference(request.get("path"), request.get("member", 0))
    frame_count = 1 if reference.kind == "audio" else reference_visual_frame_count(reference.latent.shape[2])
    frame_index = integer(request.get("frameIndex", 0), "Preview frame", 0, frame_count - 1)
    comparison = request.get("compare", False)
    if not isinstance(comparison, bool):
        raise ValueError("Preview comparison must be a boolean")
    strength = request.get("strength", 1)
    if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not 0 <= strength <= 1:
        raise ValueError("Preview strength must be between 0 and 1")
    reference.strength = strength
    if not torch.cuda.is_available():
        raise ValueError("Preview requires a supported GPU and installed H3 VAEs")
    model_path = request.get("modelPath")
    if not isinstance(model_path, str) or not Path(model_path).is_absolute():
        raise ValueError("Choose the installed H3 model directory")
    models = Path(model_path)
    latents = [reference.latent]
    if comparison:
        latents.append(weaken_reference(reference))
    decoder = None
    try:
        if reference.kind == "audio":
            decoder = load_audio_vae(vae_path(models, "audio"), "decode", device="cuda")
            with torch.no_grad():
                result = [encode_audio(decoder.decode(latent[..., :80].to("cuda", torch.float32))[0]) for latent in latents]
            return {"kind": "audio", "previews": result}
        if max(reference.latent.shape[-2:]) > 128:
            raise ValueError("Preview exceeds 2048 pixels; create a smaller or compressed reference")
        decoder = load_video_vae(vae_path(models, "video"), "decode")
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
            result = [encode_image(decoder.decode_middle_frame(reference_video_decode_plan(latent)[0].to("cuda", torch.float32), frame_index)[0]) for latent in latents]
        return {"kind": reference.kind, "previews": result}
    finally:
        del decoder
        gc.collect()
        torch.cuda.empty_cache()
