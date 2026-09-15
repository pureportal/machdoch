from __future__ import annotations

import json
from pathlib import Path
import sys
import traceback

import numpy as np
from PIL import Image, ImageFilter, ImageOps


def progress(stage, fraction):
    print("MACHDOCH_PROGRESS " + json.dumps({"stage": stage, "progress": fraction}), file=sys.stderr, flush=True)


def load_image(path: str) -> Image.Image:
    with Image.open(path) as source:
        if source.width * source.height > 25_000_000:
            raise ValueError("Image is too large. Resize it before this step.")
        return ImageOps.exif_transpose(source).convert("RGBA")


def select_mask(masks, scores, selection: str, invert: bool, grow: int, feather: int):
    if len(masks) == 0:
        raise ValueError("No objects matched. Change Object or lower Confidence.")
    masks = np.asarray(masks, dtype=bool)
    if masks.ndim != 3 or not np.isfinite(scores).all():
        raise ValueError("SAM3 returned invalid detections.")
    if selection == "largest":
        selected = masks[int(masks.sum(axis=(1, 2)).argmax())]
    elif selection == "best":
        selected = masks[int(np.asarray(scores).argmax())]
    elif selection == "all":
        selected = masks.any(axis=0)
    else:
        raise ValueError("Choose a valid object selection.")
    if not selected.any():
        raise ValueError("SAM3 returned an empty mask. Change Object.")
    if invert:
        selected = ~selected
    if not selected.any():
        raise ValueError("The surrounding area is empty. Change the selection.")
    return refine_mask(Image.fromarray(selected.astype(np.uint8) * 255), grow, feather)


def refine_mask(image, grow, feather, region="selection", boundary_width=8):
    if region == "surroundings":
        image = ImageOps.invert(image)
    if grow:
        image = image.filter((ImageFilter.MaxFilter if grow > 0 else ImageFilter.MinFilter)(2 * abs(grow) + 1))
    if region == "boundary":
        if type(boundary_width) is not int or not 1 <= boundary_width <= 64:
            raise ValueError("Choose a boundary radius from 1 to 64 pixels.")
        binary = image.point(lambda value: 255 if value >= 128 else 0)
        expanded = np.asarray(binary.filter(ImageFilter.MaxFilter(2 * boundary_width + 1)))
        contracted = np.asarray(binary.filter(ImageFilter.MinFilter(2 * boundary_width + 1)))
        image = Image.fromarray(expanded - contracted)
    elif region not in ("selection", "surroundings"):
        raise ValueError("Choose the selection, its surroundings, or its boundary.")
    if feather:
        image = image.filter(ImageFilter.GaussianBlur(feather))
    if image.getbbox() is None:
        raise ValueError("The mask is empty. Reduce shrinking or paint a selection.")
    return image


def prepare_mask(request):
    from media_diffusers_worker import _rasterize_edit_mask

    source = load_image(request["imagePath"])
    if request.get("maskPath"):
        with Image.open(request["maskPath"]) as image:
            mask = image.convert("L")
        if mask.size != source.size:
            raise ValueError("The mask dimensions do not match the image.")
    else:
        mask = _rasterize_edit_mask(request["editMask"], source.width, source.height)
    region = request.get("region", "selection")
    boundary_width = request.get("boundaryWidth", 8)
    mask = refine_mask(mask, request["grow"], request["feather"], region, boundary_width)
    mask.save(Path(request["outputDirectory"]) / "output.png")
    return {"width": source.width, "height": source.height, "selectedPixels": int((np.asarray(mask) > 0).sum()), "grow": request["grow"], "feather": request["feather"], "region": region, "boundaryWidth": boundary_width if region == "boundary" else None}


def check_image(request, torch, device):
    from media_visual_check import visual_check

    source = load_image(request["imagePath"])
    reference = load_image(request["referencePath"]) if request.get("referencePath") else None
    return visual_check(request, source, reference, torch, device, progress)


def image_mask(request):
    image = load_image(request["imagePath"])
    channels = {"red": "R", "green": "G", "blue": "B", "alpha": "A"}
    channel = request["channel"]
    if channel == "luminance":
        mask = image.convert("L")
    elif channel in channels:
        mask = image.getchannel(channels[channel])
    else:
        raise ValueError("Choose an image channel for the mask.")
    if request["invert"]:
        mask = ImageOps.invert(mask)
    mask.save(Path(request["outputDirectory"]) / "output.png")
    return {"width": mask.width, "height": mask.height, "channel": channel, "inverted": request["invert"]}


def composite_masks(first, second, operation):
    if first.size != second.size:
        raise ValueError("The masks must have matching dimensions.")
    destination = np.asarray(first.convert("L"), dtype=np.float32) / 255.0
    source = np.asarray(second.convert("L"), dtype=np.float32) / 255.0
    if operation == "add":
        result = destination + source
    elif operation == "subtract":
        result = destination - source
    elif operation == "multiply":
        result = destination * source
    else:
        raise ValueError("Choose Add, Subtract, or Multiply for the masks.")
    return Image.fromarray(np.round(result.clip(0, 1) * 255).astype(np.uint8))


def mask_composite(request):
    with Image.open(request["imagePath"]) as first, Image.open(request["maskPath"]) as second:
        result = composite_masks(first, second, request["operation"])
    result.save(Path(request["outputDirectory"]) / "output.png")
    return {"width": result.width, "height": result.height, "operation": request["operation"]}


def segment(request, torch, device):
    from transformers import Sam3Model, Sam3Processor

    progress("Loading SAM3", 0.1)
    source = load_image(request["imagePath"])
    model = Sam3Model.from_pretrained(request["modelPath"], local_files_only=True).to(device).eval()
    processor = Sam3Processor.from_pretrained(request["modelPath"], local_files_only=True)
    inputs = processor(images=source.convert("RGB"), text=request["query"], return_tensors="pt").to(device)
    progress("Selecting objects", 0.5)
    with torch.inference_mode():
        outputs = model(**inputs)
    result = processor.post_process_instance_segmentation(outputs, threshold=request["threshold"], mask_threshold=0.5, target_sizes=inputs["original_sizes"].tolist())[0]
    scores = result["scores"].float().cpu().numpy()
    mask = select_mask(result["masks"].cpu().numpy(), scores, request["selection"], request["invert"], request["grow"], request["feather"])
    mask.save(Path(request["outputDirectory"]) / "output.png")
    return {"width": source.width, "height": source.height, "detections": [{"score": float(score), "box": box} for score, box in zip(scores, result["boxes"].float().cpu().tolist())], "selectedPixels": int((np.asarray(mask) > 0).sum())}


def tiled_upscale(source, model, torch, device, tile_size):
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
            tensor = torch.from_numpy(pixels[y0:y1, x0:x1].copy()).permute(2, 0, 1).unsqueeze(0).to(device)
            with torch.inference_mode():
                tile = model(tensor).clamp(0, 1).float().cpu()[0].permute(1, 2, 0).numpy()
            if tile.shape[:2] != ((y1 - y0) * factor, (x1 - x0) * factor) or not np.isfinite(tile).all():
                raise ValueError("Upscaler returned invalid pixels or dimensions.")
            output[top*factor:bottom*factor, left*factor:right*factor] = np.round(tile[(top-y0)*factor:(bottom-y0)*factor, (left-x0)*factor:(right-x0)*factor] * 255).astype(np.uint8)
            completed += 1
            progress(f"Upscaling tile {completed}/{total}", 0.25 + 0.7 * completed / total)
    return Image.fromarray(output)


def upscale(request, torch, device):
    from spandrel import ImageModelDescriptor, ModelLoader

    progress("Loading upscaler", 0.1)
    source = load_image(request["imagePath"])
    model = ModelLoader().load_from_file(request["modelPath"])
    if not isinstance(model, ImageModelDescriptor) or model.input_channels != 3 or model.output_channels != 3 or model.scale < 2:
        raise ValueError("Choose a three-channel image super-resolution model.")
    scale = int(request["scale"])
    if scale > model.scale:
        raise ValueError(f"This model supports up to {model.scale}×. Choose a smaller scale.")
    model = model.to(device).eval()
    result = tiled_upscale(source, model, torch, device, request["tileSize"])
    size = (source.width * scale, source.height * scale)
    if result.size != size:
        result = result.resize(size, Image.Resampling.LANCZOS)
    result.putalpha(source.getchannel("A").resize(size, Image.Resampling.LANCZOS))
    result.save(Path(request["outputDirectory"]) / "output.png")
    return {"width": result.width, "height": result.height, "architecture": model.architecture.id, "nativeScale": model.scale, "scale": scale, "tileSize": request["tileSize"]}


def generate_prompt(request, torch, device):
    from transformers import AutoModelForCausalLM, AutoTokenizer

    progress("Loading text model", 0.1)
    path = request["modelPath"]
    tokenizer = AutoTokenizer.from_pretrained(path, local_files_only=True, trust_remote_code=False)
    model = AutoModelForCausalLM.from_pretrained(path, local_files_only=True, trust_remote_code=False, dtype=torch.float32 if device == "cpu" else torch.bfloat16).to(device).eval()
    messages = [{"role": "system", "content": request["instructions"]}, {"role": "user", "content": request["prompt"]}]
    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
    inputs = tokenizer(text, return_tensors="pt").to(device)
    if inputs["input_ids"].shape[1] > 8192:
        raise ValueError("Prompt input is too long. Shorten the brief or instructions.")
    progress("Writing prompt", 0.5)
    with torch.inference_mode():
        outputs = model.generate(**inputs, max_new_tokens=request["maxTokens"], do_sample=False)
    prompt = tokenizer.decode(outputs[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True).strip()
    if not prompt or len(prompt) > 8000:
        raise ValueError("The text model returned no usable prompt. Revise Instructions.")
    return {"prompt": prompt, "modelType": model.config.model_type}


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    request = json.load(sys.stdin)
    command = sys.argv[1]
    image_operations = {"prepare-mask": prepare_mask, "image-mask": image_mask, "mask-composite": mask_composite}
    if command in image_operations:
        print(json.dumps({"schemaVersion": 1, **image_operations[command](request)}))
        return
    if command == "canny":
        from media_controlnet import preprocess

        print(json.dumps({"schemaVersion": 1, **preprocess(request, command)}))
        return
    import torch
    from media_diffusers_worker import _device

    device, _, _ = _device(torch)
    if command == "depth-map":
        from media_controlnet import preprocess
        from media_diffusers_worker import _configure_amd_convolution_backend

        _configure_amd_convolution_backend(torch, device)
        print(json.dumps({"schemaVersion": 1, **preprocess(request, command, torch, device)}))
        return
    handlers = {"segment": segment, "visual-check": check_image, "upscale": upscale, "generate-prompt": generate_prompt}
    if command not in handlers:
        raise ValueError("Unknown workflow operation")
    result = handlers[command](request, torch, device)
    print(json.dumps({"schemaVersion": 1, **result}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"schemaVersion": 1, "error": str(error)}))
        sys.exit(2)
