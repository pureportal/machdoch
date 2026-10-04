import base64
import io
from pathlib import Path
from typing import Any


def load_model(
    model: dict[str, Any], torch: Any, image_conditioned: bool, max_new_tokens: int,
) -> tuple[Any, Any]:
    from transformers import AutoConfig, AutoProcessor, Qwen2_5_VLForConditionalGeneration

    root = Path(model["path"])
    if model.get("packageKind") != "transformers-directory" or not root.is_absolute() or not root.is_dir():
        raise ValueError("Install the IntroSVG model package before generating")
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise ValueError("IntroSVG requires a GPU with bfloat16 support")
    options = {"local_files_only": True, "trust_remote_code": False}
    processor = AutoProcessor.from_pretrained(str(root), **options)
    device_map = "auto"
    if not image_conditioned:
        from accelerate import infer_auto_device_map, init_empty_weights
        from accelerate.utils import get_max_memory

        config = AutoConfig.from_pretrained(str(root), **options)
        with init_empty_weights():
            sizing_model = Qwen2_5_VLForConditionalGeneration(config)
        sizing_model.model.visual = torch.nn.Identity()
        memory = get_max_memory()
        device = torch.cuda.current_device()
        text_config = config.text_config
        cache_bytes = (
            (max_new_tokens + 1024) * text_config.num_hidden_layers
            * text_config.num_key_value_heads
            * (text_config.hidden_size // text_config.num_attention_heads) * 4
        )
        reserved_bytes = max(512 * 1024 ** 2, cache_bytes + 128 * 1024 ** 2)
        memory[device] = max(0, torch.cuda.mem_get_info(device)[0] - reserved_bytes)
        weight_bytes = sum(parameter.numel() * 2 for parameter in sizing_model.parameters())
        if weight_bytes <= memory[device]:
            device_map = {"": device}
        else:
            device_map = infer_auto_device_map(
                sizing_model, max_memory=memory, dtype=torch.bfloat16,
                no_split_module_classes=sizing_model._no_split_modules,
            )
        device_map["model.visual"] = "cpu"
    pipeline = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        str(root), dtype=torch.bfloat16, device_map=device_map,
        attn_implementation="sdpa", use_safetensors=True, **options,
    )
    return pipeline, processor


def extract_svg(text: str) -> str:
    start = text.find("<svg")
    end = text.rfind("</svg>")
    if start < 0 or end < start:
        raise ValueError("The model returned no complete SVG. Revise the prompt and retry.")
    return text[start:end + len("</svg>")]


def generate(request: dict[str, Any], torch: Any) -> dict[str, Any]:
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
        with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as image:
            images.append(image.convert("RGB"))
    model, processor = load_model(request["model"], torch, bool(images), max_new_tokens)
    content = [{"type": "image", "image": image} for image in images]
    content.append({"type": "text", "text": prompt})
    messages = [{"role": "user", "content": content}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[text], images=images or None, return_tensors="pt").to(
        model.get_input_embeddings().weight.device
    )
    candidates = []
    with torch.inference_mode():
        for _ in range(count):
            output = model.generate(
                **inputs, max_new_tokens=max_new_tokens, do_sample=True,
                temperature=0.3 if policy == "fast" else 0.7,
                use_cache=True, stop_strings=["</svg>"], tokenizer=processor.tokenizer,
            )
            generated = processor.batch_decode(
                output[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True,
                clean_up_tokenization_spaces=False,
            )[0]
            candidates.append(extract_svg(generated))
    return {"candidates": candidates}
