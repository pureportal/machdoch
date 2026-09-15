from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps


def canny_image(image: Image.Image, low: int, high: int) -> Image.Image:
    import cv2

    if type(low) is not int or type(high) is not int or not 0 <= low < high <= 255:
        raise ValueError("Canny thresholds must satisfy 0 <= low < high <= 255.")
    pixels = np.asarray(ImageOps.exif_transpose(image).convert("RGB"))
    edges = cv2.Canny(pixels, low, high)
    return Image.fromarray(edges).convert("RGB")


def depth_image(
    image: Image.Image, model_path: str, torch: Any, device: str
) -> Image.Image:
    from transformers import AutoImageProcessor, AutoModelForDepthEstimation

    processor = AutoImageProcessor.from_pretrained(
        model_path, local_files_only=True, trust_remote_code=False
    )
    model = (
        AutoModelForDepthEstimation.from_pretrained(
            model_path,
            local_files_only=True,
            trust_remote_code=False,
            use_safetensors=True,
            dtype=torch.float32,
        )
        .to(device)
        .eval()
    )
    inputs = processor(images=image.convert("RGB"), return_tensors="pt").to(device)
    with torch.inference_mode():
        prediction = model(**inputs).predicted_depth
        prediction = (
            torch.nn.functional.interpolate(
                prediction.unsqueeze(1),
                size=(image.height, image.width),
                mode="bicubic",
                align_corners=False,
            )[0, 0]
            .float()
            .cpu()
            .numpy()
        )
    if not np.isfinite(prediction).all():
        raise ValueError(
            "The depth model returned invalid values. Verify the depth model and retry."
        )
    minimum, maximum = float(prediction.min()), float(prediction.max())
    if maximum - minimum <= 1e-8:
        raise ValueError("No depth variation was detected. Choose another image.")
    pixels = (
        np.round((prediction - minimum) / (maximum - minimum) * 255)
        .clip(0, 255)
        .astype(np.uint8)
    )
    return Image.fromarray(pixels).convert("RGB")


def preprocess(
    request: dict[str, Any], kind: str, torch: Any = None, device: str = "cpu"
) -> dict[str, Any]:
    with Image.open(request["imagePath"]) as source:
        if source.width * source.height > 25_000_000:
            raise ValueError("Image is too large. Resize it before this step.")
        image = ImageOps.exif_transpose(source).convert("RGB")
    if kind == "canny":
        result = canny_image(image, request["lowThreshold"], request["highThreshold"])
    elif kind == "depth-map":
        result = depth_image(image, request["modelPath"], torch, device)
    else:
        raise ValueError("Unknown control image operation.")
    result.save(Path(request["outputDirectory"]) / "output.png")
    return {"width": result.width, "height": result.height, "kind": kind}
