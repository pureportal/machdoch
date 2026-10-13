from __future__ import annotations

import json
from pathlib import Path
from typing import Any


PROFILES = {
    profile["architecture"]: profile
    for profile in json.loads(Path(__file__).with_name("open_media_models.json").read_text(encoding="utf-8"))
}


def load_pipeline(diffusers: Any, model: dict[str, Any], dtype: Any, *, image_conditioned: bool = False) -> Any:
    profile = PROFILES[model["architecture"]]
    if model.get("packageKind") != "diffusers-directory":
        raise ValueError(f"{profile['displayName']} requires a complete Diffusers model folder")
    root = Path(model["path"])
    index_name = "modular_model_index.json" if profile["architecture"] == "anima" else "model_index.json"
    index = json.loads((root / index_name).read_text(encoding="utf-8"))
    if index.get("_class_name") != profile["pipeline"]:
        raise ValueError(f"The model folder does not match {profile['displayName']}")
    if profile["architecture"] == "anima":
        from media_anima import load_pipeline as load_anima

        return load_anima(diffusers, root, dtype)
    if profile["architecture"] == "hidream-i1-full":
        from media_hidream import load_pipeline as load_hidream

        return load_hidream(diffusers, root, dtype)
    if profile["architecture"] == "hunyuan-image-3":
        from media_hunyuan_image3 import HunyuanImage3Pipeline

        return HunyuanImage3Pipeline.from_pretrained(root, dtype)
    if profile.get("sampleSigmas") is not None and index.get("sample_sigmas") != profile["sampleSigmas"]:
        raise ValueError(f"The model folder is missing the published {profile['displayName']} sampling schedule")
    if profile.get("distillation", {}).get("sampler") == "lcm":
        from media_sdxl_distillation import load_pipeline as load_sdxl_student

        pipeline = load_sdxl_student(diffusers, root, profile, dtype)
        pipeline.set_progress_bar_config(disable=True)
        return pipeline
    class_name = profile.get("imagePipeline") if image_conditioned else profile["pipeline"]
    if not class_name:
        class_name = profile["pipeline"]
    pipeline_class = getattr(diffusers, class_name, None)
    if pipeline_class is None:
        raise ValueError(f"The media runtime does not expose {class_name}. Repair runtime setup.")
    options = {}
    if profile["architecture"] in ("flux-1-dev", "flux-1-schnell"):
        from diffusers.quantizers import PipelineQuantizationConfig

        options["quantization_config"] = PipelineQuantizationConfig(
            quant_backend="bitsandbytes_4bit",
            quant_kwargs={"load_in_4bit": True, "bnb_4bit_quant_type": "nf4", "bnb_4bit_compute_dtype": dtype},
            components_to_quantize=["transformer", "text_encoder_2"],
        )
    if profile["pipeline"] in ("QwenImagePipeline", "QwenImage21Pipeline"):
        from media_qwen_quantization import transformer_arguments

        options.update(transformer_arguments(diffusers, root, index, dtype))
    if profile["architecture"] == "audioldm-2":
        from transformers import GPT2LMHeadModel

        options["language_model"] = GPT2LMHeadModel.from_pretrained(
            str(root / "language_model"), dtype=dtype,
            local_files_only=True, use_safetensors=True, trust_remote_code=False,
        )
    if profile["pipeline"] == "Flux2KleinPipeline":
        options["is_distilled"] = profile["fixedSteps"]
    if profile["architecture"] == "krea-2-raw":
        options["is_distilled"] = False
    if profile["architecture"] == "krea-2-turbo":
        options["is_distilled"] = True
    if profile["architecture"] == "sana":
        import torch

        encoder_dtype = torch.bfloat16 if dtype != torch.float32 and torch.cuda.is_available() and torch.cuda.is_bf16_supported() else torch.float32
        dtype = {"transformer": dtype, "text_encoder": encoder_dtype,
                 "vae": torch.float32, "default": dtype}
    elif profile["family"] == "CogVideoX":
        import torch

        encoder_dtype = torch.float16 if model["architecture"] == "cogvideox-2b" and dtype != torch.float32 else dtype
        dtype = {"transformer": dtype, "text_encoder": encoder_dtype,
                 "vae": torch.float32, "default": dtype}
    elif profile["family"] == "Wan":
        import torch

        dtype = {"transformer": dtype, "transformer_2": dtype, "text_encoder": dtype,
                 "vae": torch.float32, "default": dtype}
    pipeline = pipeline_class.from_pretrained(
        str(root), dtype=dtype, local_files_only=True,
        use_safetensors=True, trust_remote_code=False, **options,
    )
    if hasattr(pipeline, "set_progress_bar_config"):
        pipeline.set_progress_bar_config(disable=True)
    return pipeline


def image_arguments(architecture: str, sampling: dict[str, Any], images: list[Any], negative_prompt: str) -> dict[str, Any]:
    profile = PROFILES[architecture]
    if images and "image-to-image" not in profile["capabilities"]:
        raise ValueError(f"{profile['displayName']} does not accept reference images")
    if "image-to-image" in profile["capabilities"] and "text-to-image" not in profile["capabilities"] and not images:
        raise ValueError(f"Choose a reference image for {profile['displayName']}")
    if len(images) > profile.get("maxReferences", 1):
        raise ValueError(f"{profile['displayName']} accepts at most {profile.get('maxReferences', 1)} reference images")
    if profile.get("negativePrompt") is False and negative_prompt.strip():
        raise ValueError(f"{profile['displayName']} does not use negative prompts")
    guidance = sampling.get("guidanceScale")
    published_guidance_schedule = architecture == "ideogram-4" and guidance is None and sampling.get("numInferenceSteps") in (None, profile["steps"])
    arguments = {}
    if not published_guidance_schedule:
        arguments[profile["guidanceParameter"]] = profile["guidance"] if guidance is None else guidance
        if architecture == "ideogram-4":
            arguments["guidance_schedule"] = None
    if profile.get("distillation", {}).get("sampler") == "lcm":
        if negative_prompt.strip():
            raise ValueError(f"{profile['displayName']} does not use negative prompts")
        arguments["timesteps"] = profile["distillation"]["timesteps"]
    if profile["guidanceParameter"] == "true_cfg_scale" and profile.get("negativePrompt") is not False:
        arguments["negative_prompt"] = negative_prompt or " "
    if architecture == "sana":
        arguments["complex_human_instruction"] = None
        arguments["use_resolution_binning"] = False
    if architecture == "sana-sprint" and sampling.get("numInferenceSteps", profile["steps"]) != 2:
        arguments["intermediate_timesteps"] = None
    if profile.get("sampleSigmas") is not None:
        arguments["sigmas"] = profile["sampleSigmas"]
        arguments["use_kv_cache"] = True
    if images:
        arguments["image"] = images[0] if len(images) == 1 else images
    return arguments


def validate_sampling(architecture: str, steps: int, guidance: float | None) -> None:
    profile = PROFILES[architecture]
    if profile["fixedSteps"] and steps != profile["steps"]:
        raise ValueError(f"{profile['displayName']} requires {profile['steps']} sampling steps")
    if profile["fixedGuidance"] and guidance is not None and guidance != profile["guidance"]:
        raise ValueError(f"{profile['displayName']} requires guidance {profile['guidance']}")


def video_arguments(profile: dict[str, Any], request: dict[str, Any], image: Any, last_image: Any, width: int, height: int, generator: Any) -> dict[str, Any]:
    contract = profile["video"]
    if profile.get("distillation") and request.get("fps") != contract["fps"]:
        raise ValueError(f"{profile['displayName']} requires {contract['fps']} fps")
    frames = request.get("numFrames")
    if not isinstance(frames, int) or isinstance(frames, bool) or not contract["minimum"] <= frames <= contract["maximum"] or (frames - contract["minimum"]) % contract["stride"]:
        raise ValueError(f"{profile['displayName']} requires {contract['minimum']}–{contract['maximum']} frames in increments of {contract['stride']}")
    steps, guidance = request.get("numInferenceSteps"), request.get("guidanceScale")
    validate_sampling(profile["architecture"], steps, guidance)
    if image is None and "text-to-video" not in profile["capabilities"]:
        raise ValueError(f"Choose a reference image for {profile['displayName']}")
    if image is not None and "image-to-video" not in profile["capabilities"]:
        raise ValueError(f"{profile['displayName']} generates video from a prompt")
    arguments = {"width": width, "height": height, "num_frames": frames,
        "num_inference_steps": steps, "generator": generator, "output_type": "pil"}
    if profile.get("prompt", True):
        arguments["prompt"] = request["prompt"]
    if profile.get("negativePrompt", True):
        arguments["negative_prompt"] = request.get("negativePrompt", "")
    if profile["guidanceParameter"] != "guider":
        arguments["max_guidance_scale" if profile["pipeline"] == "StableVideoDiffusionPipeline" else "guidance_scale"] = guidance
    if image is not None:
        arguments["image"] = image
    if last_image is not None:
        if "start-end-to-video" not in profile["capabilities"]:
            raise ValueError(f"{profile['displayName']} accepts one opening image")
        arguments["last_image"] = last_image
    if profile.get("audio"):
        arguments.update(frame_rate=float(request["fps"]), audio_guidance_scale=1.0 if profile["fixedGuidance"] else 7.0)
    if profile["architecture"] == "ltx-2.5":
        from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES

        arguments.update(
            sigmas=DISTILLED_SIGMA_VALUES,
            stg_scale=0.0, audio_stg_scale=0.0,
            modality_scale=1.0, audio_modality_scale=1.0,
            guidance_rescale=0.0, audio_guidance_rescale=0.0,
        )
    if profile["pipeline"] == "StableVideoDiffusionPipeline":
        arguments["fps"] = request["fps"]
        arguments["decode_chunk_size"] = 8
    return arguments
