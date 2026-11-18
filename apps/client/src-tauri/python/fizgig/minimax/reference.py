"""Reference images for MiniMax H3 reference-to-video conditioning.

A reference is scaled down (never up) to the generation's pixel area and snapped to the
32-pixel canvas grid. The same resized picture must feed both the VAE condition rows and the
vision encoder so both describe one framing.
"""

import math

import numpy as np
import torch

CANVAS_MULTIPLE = 32


def reference_canvas(reference_width: int, reference_height: int, width: int, height: int) -> tuple[int, int]:
    """Canvas ``(width, height)`` for a reference rendered alongside a ``width x height`` clip."""
    scale = min(1.0, math.sqrt((width * height) / (reference_width * reference_height)))
    canvas = tuple(int(side * scale) // CANVAS_MULTIPLE * CANVAS_MULTIPLE
                   for side in (reference_width, reference_height))
    if min(canvas) == 0:
        raise ValueError(f"reference dimensions must remain at least {CANVAS_MULTIPLE}px after scaling")
    return canvas


def resize_reference(image, width: int, height: int):
    """PIL image -> RGB PIL image on its reference canvas."""
    from PIL import Image
    return image.convert("RGB").resize(reference_canvas(image.width, image.height, width, height),
                                       Image.LANCZOS)


def reference_to_tensor(image) -> torch.Tensor:
    """PIL image -> ``[1, 3, H, W]`` float tensor in ``[-1, 1]``."""
    pixels = torch.from_numpy(np.array(image.convert("RGB"), dtype=np.uint8, copy=True)).float()
    return pixels.permute(2, 0, 1).unsqueeze(0) / 127.5 - 1.0
