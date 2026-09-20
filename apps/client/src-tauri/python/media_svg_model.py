import base64
import io
from pathlib import Path
from typing import Any


def load_model(model: dict[str, Any], torch: Any) -> tuple[Any, Any]:
    from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

    root = Path(model["path"])
    if model.get("packageKind") != "transformers-directory" or not root.is_absolute() or not root.is_dir():
        raise ValueError("Install the IntroSVG model package before generating")
    if not torch.cuda.is_available() or not torch.cuda.is_bf16_supported():
        raise ValueError("IntroSVG requires a GPU with bfloat16 support")
    options = {"local_files_only": True, "trust_remote_code": False}
    processor = AutoProcessor.from_pretrained(str(root), **options)
    pipeline = Qwen2_5_VLForConditionalGeneration.from_pretrained(
        str(root), dtype=torch.bfloat16, device_map="auto",
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
    references = request.get("references", [])
    if not isinstance(references, list) or len(references) > 4:
        raise ValueError("Choose at most four SVG references")
    images = []
    for encoded in references:
        with Image.open(io.BytesIO(base64.b64decode(encoded, validate=True))) as image:
            images.append(image.convert("RGB"))
    model, processor = load_model(request["model"], torch)
    content = [{"type": "image", "image": image} for image in images]
    content.append({"type": "text", "text": prompt})
    messages = [{"role": "user", "content": content}]
    text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = processor(text=[text], images=images or None, return_tensors="pt").to(model.device)
    candidates = []
    with torch.inference_mode():
        for _ in range(count):
            output = model.generate(
                **inputs, max_new_tokens=32768, do_sample=True,
                temperature=0.3 if request.get("modelPolicy") == "fast" else 0.7,
            )
            generated = processor.batch_decode(
                output[:, inputs["input_ids"].shape[1]:], skip_special_tokens=True,
                clean_up_tokenization_spaces=False,
            )[0]
            candidates.append(extract_svg(generated))
    return {"candidates": candidates}
