import base64
import binascii
import io
from functools import partial
from pathlib import Path
from typing import Any, Callable

from media_svg_refinement import REFINEMENT_ROUNDS, extract_svg, refine_svg


def load_model(
    model: dict[str, Any], torch: Any, image_conditioned: bool, max_new_tokens: int,
) -> tuple[Any, Any]:
    from transformers import AutoConfig, AutoProcessor, Qwen2_5_VLForConditionalGeneration

    model_path = model.get("path")
    if not isinstance(model_path, str) or not model_path:
        raise ValueError("Install the IntroSVG model package before generating")
    root = Path(model_path)
    if model.get("packageKind") != "transformers-directory" or not root.is_absolute() or not root.is_dir():
        raise ValueError("Install the IntroSVG model package before generating")
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise ValueError("IntroSVG requires a GPU with bfloat16 support")
    options = {"local_files_only": True, "trust_remote_code": False}
    processor = AutoProcessor.from_pretrained(str(root), max_pixels=512 * 512, **options)
    from accelerate import infer_auto_device_map, init_empty_weights
    from accelerate.utils import get_max_memory

    config = AutoConfig.from_pretrained(str(root), **options)
    with init_empty_weights():
        sizing_model = Qwen2_5_VLForConditionalGeneration(config)
    visual_model = sizing_model.model.visual
    sizing_model.model.visual = torch.nn.Identity()
    memory = get_max_memory()
    device = torch.cuda.current_device()
    memory = {key: value for key, value in memory.items() if key in (device, "cpu")}
    text_config = config.text_config
    context_tokens = max_new_tokens * (2 if image_conditioned else 1) + 1024
    cache_bytes = (
        context_tokens * text_config.num_key_value_heads
        * (text_config.hidden_size // text_config.num_attention_heads) * 4 * 2
    )
    reserved_bytes = max(512 * 1024 ** 2, cache_bytes + 128 * 1024 ** 2)
    memory[device] = max(0, torch.cuda.mem_get_info(device)[0] - reserved_bytes)
    text_weight_bytes = sum(parameter.numel() * 2 for parameter in sizing_model.parameters())
    if text_weight_bytes > memory[device]:
        raise ValueError("IntroSVG's text model does not fit on the GPU. Close other GPU apps or use a GPU with more memory.")
    device_map = {"model.language_model": device, "lm_head": device}
    if image_conditioned:
        memory[device] -= text_weight_bytes
        visual_map = infer_auto_device_map(
            visual_model, max_memory=memory, dtype=torch.bfloat16,
            no_split_module_classes=sizing_model._no_split_modules,
        )
        if "disk" in visual_map.values():
            raise ValueError("IntroSVG's vision model does not fit in memory. Close other apps and retry.")
        device_map.update({
            f"model.visual.{name}" if name else "model.visual": location
            for name, location in visual_map.items()
        })
    else:
        device_map["model.visual"] = "cpu"
    pipeline = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        str(root), dtype=torch.bfloat16, device_map=device_map,
        attn_implementation="sdpa", use_safetensors=True, **options,
    )
    return pipeline, processor


def generate_text(
    model: Any, processor: Any, messages: list[dict[str, Any]], *,
    max_new_tokens: int, temperature: float,
) -> str:
    images = [
        item["image"] for message in messages for item in message["content"]
        if item["type"] == "image"
    ]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[text], images=images or None, return_tensors="pt").to(
        model.get_input_embeddings().weight.device
    )
    options: dict[str, Any] = {
        "max_new_tokens": max_new_tokens, "do_sample": temperature > 0,
        "use_cache": True, "cache_implementation": "offloaded",
    }
    if temperature > 0:
        options["temperature"] = temperature
    output = model.generate(**inputs, **options)
    generated = processor.batch_decode(
        output[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True,
        clean_up_tokenization_spaces=False,
    )[0]
    if not generated.strip():
        raise ValueError("IntroSVG returned an empty response. Revise the prompt and retry.")
    return generated


def generate(
    request: dict[str, Any], torch: Any,
    progress: Callable[[str, float], None] | None = None,
) -> dict[str, Any]:
    from PIL import Image

    count = request.get("candidateCount")
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 6:
        raise ValueError("Choose between one and six SVG candidates")
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("Enter an SVG prompt")
    policy = request.get("modelPolicy")
    token_limits = {"fast": 8192, "balanced": 16384, "quality": 32768}
    if not isinstance(policy, str) or policy not in token_limits:
        raise ValueError("Choose an SVG quality level")
    max_new_tokens = token_limits[policy]
    references = request.get("references", [])
    if not isinstance(references, list) or len(references) > 4:
        raise ValueError("Choose at most four SVG references")
    images = []
    for encoded in references:
        if not isinstance(encoded, str):
            raise ValueError("SVG references must be encoded image files")
        try:
            with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as image:
                images.append(image.convert("RGB"))
        except (binascii.Error, ValueError, OSError) as error:
            raise ValueError("An SVG reference could not be read. Choose another image and retry.") from error
    model_specification = request.get("model")
    if not isinstance(model_specification, dict):
        raise ValueError("Choose an IntroSVG model package")
    if progress:
        progress("Loading SVG model", 0.02)
    model, processor = load_model(
        model_specification, torch, bool(images) or policy != "fast", max_new_tokens,
    )
    content = [{"type": "image", "image": image} for image in images]
    content.append({
        "type": "text",
        "text": "Please generate a complete, self-contained SVG with vector graphics that "
        f"meets the following description and reference images: {prompt}",
    })
    messages = [{"role": "user", "content": content}]
    complete_text = partial(generate_text, model, processor)
    candidates = []
    with torch.inference_mode():
        for index in range(count):
            if progress:
                progress(f"Generating SVG {index + 1}/{count}", 0.08 + 0.85 * index / count)
            svg = extract_svg(complete_text(
                messages, max_new_tokens=max_new_tokens,
                temperature=0.3 if policy == "fast" else 0.5,
            ))
            if policy in REFINEMENT_ROUNDS:
                candidate_progress = (
                    lambda stage, fraction: progress(stage, 0.08 + 0.85 * (index + 0.35 + 0.65 * fraction) / count)
                ) if progress else None
                svg = refine_svg(
                    svg, prompt, images, max_new_tokens, REFINEMENT_ROUNDS[policy], complete_text,
                    candidate_progress,
                )
            candidates.append(svg)
    if progress:
        progress("SVG complete", 1.0)
    return {"candidates": candidates}
