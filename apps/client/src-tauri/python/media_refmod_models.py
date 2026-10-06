def vae_path(model_directory, kind):
    from safetensors import SafetensorError, safe_open

    modality = "audio" if kind == "audio" else "video"
    filename = f"minimax_h3_{modality}_vae_{'fp32' if modality == 'audio' else 'fp16'}.safetensors"
    path = model_directory / "vae" / filename
    if not path.is_file():
        raise ValueError(f"Install the MiniMax H3 {modality} VAE at {path}")
    damaged = f"MiniMax H3 {modality} VAE is incomplete or damaged. Replace {path} with a complete checkpoint."
    try:
        with safe_open(str(path), framework="pt", device="cpu") as checkpoint:
            if not checkpoint.keys():
                raise ValueError(damaged)
    except SafetensorError as error:
        raise ValueError(damaged) from error
    except OSError as error:
        raise ValueError(f"Could not read the MiniMax H3 {modality} VAE at {path}. Check file access.") from error
    return path
