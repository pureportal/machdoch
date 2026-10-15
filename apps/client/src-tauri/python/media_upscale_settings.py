import math


def validate_settings(request):
    if request.get("sizeMode") not in ("scale", "dimensions", "edges", "short-edge"):
        raise ValueError("Choose a sizing mode.")
    scale = request.get("scale")
    if type(scale) not in (int, float) or not math.isfinite(scale) or not 1 <= scale <= 8:
        raise ValueError("Choose a scale from 1× to 8×.")
    for key in ("minWidth", "minHeight", "minLongEdge", "minShortEdge"):
        if type(request.get(key)) is not int or not 0 <= request[key] <= 16384:
            raise ValueError("Enter whole pixel sizes from 0 to 16384.")
    mode = request["sizeMode"]
    if ((mode == "dimensions" and not (request["minWidth"] or request["minHeight"]))
            or (mode == "edges" and not (request["minLongEdge"] or request["minShortEdge"]))
            or (mode == "short-edge" and not request["minShortEdge"])):
        raise ValueError("Enter at least one minimum size.")
    if request.get("tileMode") not in ("automatic", "manual", "factor", "full"):
        raise ValueError("Choose a tile mode.")
    if type(request.get("tileSize")) is not int or not 32 <= request["tileSize"] <= 2048:
        raise ValueError("Choose a tile size from 32 to 2048.")
    if type(request.get("tileFactor")) is not int or not 2 <= request["tileFactor"] <= 16:
        raise ValueError("Choose a tile divisor from 2 to 16.")


def output_size(width, height, request):
    mode = request["sizeMode"]
    if mode == "scale":
        factor = request["scale"]
    elif mode == "dimensions":
        factor = max(1, request["minWidth"] / width, request["minHeight"] / height)
    elif mode == "edges":
        factor = max(1, request["minLongEdge"] / max(width, height), request["minShortEdge"] / min(width, height))
    else:
        factor = max(1, request["minShortEdge"] / min(width, height))
    size = math.ceil(width * factor), math.ceil(height * factor)
    if max(size) > 16384 or size[0] * size[1] > 64_000_000:
        raise ValueError("Output is too large. Reduce the scale or minimum size.")
    return size


def resolve_tile_size(request, width, height, model, torch, device):
    mode = request["tileMode"]
    if mode == "manual":
        return request["tileSize"]
    if mode == "factor":
        return max(32, math.ceil(max(width, height) / request["tileFactor"] / 32) * 32)
    if mode == "full":
        return max(width, height)
    if not str(device).startswith("cuda"):
        return 128
    free, _ = torch.cuda.mem_get_info(device)
    free += torch.cuda.memory_reserved(device) - torch.cuda.memory_allocated(device)
    architecture = model.architecture.id.lower()
    bytes_per_pixel = 4096 if "span" in architecture else 16384 if "esrgan" in architecture else 24576
    bytes_per_pixel *= max(1, (model.scale / 4) ** 2)
    usable = max(0, free * 0.7 - 512 * 1024 ** 2)
    return max(32, min(512, math.floor((math.sqrt(usable / bytes_per_pixel) - 64) / 32) * 32))
