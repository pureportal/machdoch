import hashlib
import json
import math
import os
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path


MAX_MEMBERS = 256
MAX_FILE_BYTES = 512 * 1024 * 1024
MAX_METADATA_BYTES = 1024 * 1024
MAX_INSPECTION_PAGE_BYTES = 1536 * 1024
DEFAULT_TOKEN_BUDGET = 65536
CURVES = ("constant", "increase", "decrease", "middle", "ends")


@dataclass
class Reference:
    latent: object
    metadata: dict
    path: Path | None = None
    strength: float = 1.0
    step_curve: str = "constant"
    frame_curve: str = "constant"

    @property
    def kind(self):
        return self.metadata["kind"]

    @property
    def tokens(self):
        return token_count(self.kind, self.latent.shape)


def integer(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be an integer from {minimum} to {maximum}")
    return value


def local_file(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Choose a local RefMod file")
    path = Path(value)
    if not path.is_absolute() or path.suffix.lower() != ".safetensors" or not path.is_file():
        raise ValueError("Choose an existing absolute .safetensors path")
    if path.stat().st_size > MAX_FILE_BYTES:
        raise ValueError("RefMod exceeds the 512 MiB file limit")
    return path.resolve()


def token_count(kind, shape):
    if any(isinstance(size, bool) or not isinstance(size, int) or size <= 0 for size in shape):
        raise ValueError("RefMod latent dimensions must be positive integers")
    if kind == "audio":
        if len(shape) != 4 or tuple(shape[:3]) != (1, 32, 2):
            raise ValueError("H3 audio references require shape [1,32,2,T]")
        return 2 * shape[-1]
    if kind not in ("image", "video") or len(shape) != 5 or tuple(shape[:2]) != (1, 24):
        raise ValueError("H3 visual references require shape [1,24,T,H,W]")
    if shape[-2] % 2 or shape[-1] % 2 or (kind == "image" and shape[2] != 1):
        raise ValueError("H3 visual references require even spatial dimensions and images require one frame")
    return shape[2] * (shape[-2] // 2) * (shape[-1] // 2)


def reference_visual_frame_count(length):
    return 4 * length - 3 * ((length + 4) // 5)


def _validate_member_metadata(member):
    for field in ("name", "description", "concept_type"):
        if field in member and not isinstance(member[field], str):
            raise ValueError(f"RefMod {field} must be text")
    if "name" in member and (not member["name"].strip() or len(member["name"]) > 256):
        raise ValueError("RefMod member name must contain 1–256 characters")
    if member["kind"] == "audio" and "sample_rate" in member:
        rate = member["sample_rate"]
        if type(rate) is not int or rate != 32000:
            raise ValueError("H3 audio RefMods require a 32000 Hz sample rate; recreate the reference with the H3 audio VAE")


def _members(checkpoint):
    metadata = checkpoint.metadata() or {}
    raw = metadata.get("refmod_meta") or metadata.get("audio_refmod_meta")
    if raw is None:
        raise ValueError("This safetensors file has no RefMod metadata")
    if len(raw.encode("utf-8")) > MAX_METADATA_BYTES:
        raise ValueError("RefMod metadata exceeds 1 MiB; shorten descriptions or reduce members")
    try:
        container = json.loads(raw)
    except (ValueError, TypeError) as error:
        raise ValueError("RefMod metadata is invalid JSON") from error
    if not isinstance(container, dict):
        raise ValueError("RefMod metadata must be an object")
    if "name" in container and (not isinstance(container["name"], str) or not container["name"].strip() or len(container["name"]) > 256):
        raise ValueError("RefMod name must contain 1–256 characters")
    if container.get("kind") == "bundle":
        if container.get("_format_version") != 5:
            raise ValueError("Unsupported RefMod bundle format")
        members = container.get("members")
        if not isinstance(members, list) or not 1 <= len(members) <= MAX_MEMBERS:
            raise ValueError("RefMod bundles require 1–256 members")
        pairs = [(f"ref_{index}", member) for index, member in enumerate(members)]
    else:
        pairs = [("latent", container)]
    keys = set(checkpoint.keys())
    for key, member in pairs:
        if not isinstance(member, dict) or member.get("kind") not in ("image", "video", "audio"):
            raise ValueError("RefMod member kind must be image, video or audio")
        if member.get("_format_version") != 4:
            raise ValueError("Unsupported RefMod member format")
        _validate_member_metadata(member)
        if key not in keys:
            raise ValueError(f"RefMod is missing tensor {key}")
        view = checkpoint.get_slice(key)
        shape = view.get_shape()
        if view.get_dtype() not in ("F16", "BF16", "F32"):
            raise ValueError("RefMod latents must use floating point tensors")
        token_count(member["kind"], shape)
        for name, actual in (("latent_t", shape[-1] if member["kind"] == "audio" else shape[2]),
                             ("latent_h", shape[-2]), ("latent_w", shape[-1])):
            if member["kind"] == "audio" and name != "latent_t":
                continue
            if name in member and (type(member[name]) is not int or member[name] != actual):
                raise ValueError(f"RefMod {name} disagrees with tensor {key}")
    return container, pairs


def inspect_file(value, details=True):
    from safetensors import safe_open

    path = local_file(value)
    with safe_open(str(path), framework="pt", device="cpu") as checkpoint:
        container, members = _members(checkpoint)
        entries = []
        for key, member in members:
            shape = checkpoint.get_slice(key).get_shape()
            entry = {"key": key, "kind": member["kind"], "name": member.get("name", path.stem),
                     "shape": shape, "tokens": token_count(member["kind"], shape),
                     "frameCount": 0 if member["kind"] == "audio" else reference_visual_frame_count(shape[2])}
            if details:
                entry["metadata"] = member
            entries.append(entry)
    return {"path": str(path), "name": container.get("name", path.stem),
            "kind": container["kind"], "members": entries,
            "tokens": sum(entry["tokens"] for entry in entries), "sizeBytes": path.stat().st_size}


def load_reference(value, member_index):
    import torch
    from safetensors import safe_open

    path = local_file(value)
    initial_stat = path.stat()
    with safe_open(str(path), framework="pt", device="cpu") as checkpoint:
        _, members = _members(checkpoint)
        index = integer(member_index, "Preview member", 0, len(members) - 1)
        key, metadata = members[index]
        shape = checkpoint.get_slice(key).get_shape()
        if math.prod(shape) * 4 > MAX_FILE_BYTES:
            raise ValueError("Preview reference exceeds 512 MiB; create a smaller or compressed reference")
        latent = checkpoint.get_tensor(key).clone()
        if not torch.isfinite(latent).all():
            raise ValueError("RefMod latent contains non-finite values")
    final_stat = path.stat()
    if (initial_stat.st_size, initial_stat.st_mtime_ns, initial_stat.st_ino) != (final_stat.st_size, final_stat.st_mtime_ns, final_stat.st_ino):
        raise ValueError("RefMod changed while reading; retry with a stable file")
    return Reference(latent, dict(metadata), path)


def _inspection_page(paths, offset, library):
    from safetensors import SafetensorError

    offset = integer(offset, "Inspection offset", 0, len(paths))
    records, errors, size = [], [], 128
    next_offset = None
    for index in range(offset, len(paths)):
        path = str(paths[index])
        try:
            inspection = inspect_file(path, details=False)
            entry = {key: inspection[key] for key in ("path", "name", "tokens")} if library else {"path": path, "record": inspection}
            destination = records
        except (ValueError, OSError, SafetensorError) as error:
            entry = {"path": path, "error": str(error)}
            destination = errors if library else records
        entry_size = len(json.dumps(entry, ensure_ascii=False).encode("utf-8")) + 2
        if size + entry_size > MAX_INSPECTION_PAGE_BYTES:
            if not records and not errors:
                raise ValueError("RefMod inspection is too large; shorten member names or reduce members")
            next_offset = index
            break
        destination.append(entry)
        size += entry_size
    page = {"records": records, "nextOffset": next_offset}
    if library:
        page["errors"] = errors
    return page


def load_references(slots, max_tokens=DEFAULT_TOKEN_BUDGET):
    import torch
    from safetensors import safe_open

    integer(max_tokens, "RefMod token limit", 0, 1048576)
    if not isinstance(slots, list) or len(slots) > MAX_MEMBERS:
        raise ValueError("RefMods must be a list with at most 256 slots")
    references, total, tensor_bytes, evidence = [], 0, 0, []
    for slot in slots:
        if not isinstance(slot, dict) or not isinstance(slot.get("enabled", True), bool):
            raise ValueError("Each RefMod slot requires a boolean enabled value")
        if not slot.get("enabled", True):
            continue
        selection = slot.get("selection", "all")
        if selection not in ("all", "visual", "audio"):
            raise ValueError("RefMod selection must be all, visual or audio")
        strengths = {"visual": slot.get("visualStrength", 1.0), "audio": slot.get("audioStrength", 1.0)}
        for value in strengths.values():
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError("RefMod strengths must be between 0 and 1")
        copies = integer(slot.get("copies", 1), "RefMod copies", 1, 8)
        step_curve, frame_curve = slot.get("stepCurve", "constant"), slot.get("frameCurve", "constant")
        if step_curve not in CURVES or frame_curve not in CURVES:
            raise ValueError("Choose a constant, increase, decrease, middle or ends reference curve")
        if not any(value > 0 for key, value in strengths.items() if selection in ("all", key)):
            continue
        path = local_file(slot.get("path"))
        initial_stat = path.stat()
        with safe_open(str(path), framework="pt", device="cpu") as checkpoint:
            _, members = _members(checkpoint)
            selected = []
            for key, member in members:
                modality = "audio" if member["kind"] == "audio" else "visual"
                strength = strengths[modality]
                if selection not in ("all", modality) or strength == 0:
                    continue
                shape = checkpoint.get_slice(key).get_shape()
                tokens = token_count(member["kind"], shape)
                tensor_bytes += math.prod(shape) * 4 * copies
                if tensor_bytes > MAX_FILE_BYTES:
                    raise ValueError("Active reference tensors exceed 512 MiB; reduce references or copies")
                total += tokens * copies
                if max_tokens and total > max_tokens:
                    raise ValueError(f"RefMods need {total} tokens; reduce copies or references, or raise the token limit")
                if len(references) + len(selected) + copies > MAX_MEMBERS:
                    raise ValueError("RefMods exceed 256 active reference blocks")
                selected.extend([(key, member, strength)] * copies)
            tensors = {}
            for key, member, strength in selected:
                if key not in tensors:
                    latent = checkpoint.get_tensor(key).clone()
                    if not torch.isfinite(latent).all():
                        raise ValueError("RefMod latent contains non-finite values")
                    tensors[key] = latent
                references.append(Reference(tensors[key], dict(member), path, float(strength), step_curve, frame_curve))
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        final_stat = path.stat()
        if (initial_stat.st_size, initial_stat.st_mtime_ns, initial_stat.st_ino) != (final_stat.st_size, final_stat.st_mtime_ns, final_stat.st_ino):
            raise ValueError("RefMod changed while reading; retry with a stable file")
        evidence.append({"path": str(path), "sha256": digest.hexdigest(), "selection": selection,
                         "visualStrength": strengths["visual"], "audioStrength": strengths["audio"], "copies": copies,
                         "stepCurve": step_curve, "frameCurve": frame_curve})
    return references, {"tokens": total, "files": evidence, "referenceMap": reference_map(references)}


def reference_map(references, image_count=0):
    counts = {"image": image_count, "video": 0, "audio": 0}
    result = []
    for reference in sorted(references, key=lambda reference: reference.kind == "audio"):
        counts[reference.kind] += 1
        label = {"image": "Picture", "video": "Video", "audio": "Audio"}[reference.kind]
        result.append({"label": f"<{label} {counts[reference.kind]}>",
                       "name": reference.metadata.get("name", ""), "kind": reference.kind,
                       "tokens": reference.tokens, "strength": reference.strength})
    return result


def curve_factor(curve, progress):
    if curve == "constant":
        return progress * 0 + 1
    if curve == "increase":
        return progress
    if curve == "decrease":
        return 1 - progress
    if curve == "middle":
        return 1 - abs(2 * progress - 1)
    if curve == "ends":
        return abs(2 * progress - 1)
    raise ValueError("Unknown reference curve")


def weaken_reference(reference, step_progress=None):
    import torch
    import torch.nn.functional as functional

    latent = reference.latent.float()
    if reference.strength == 1 and reference.frame_curve == "constant" and (step_progress is None or reference.step_curve == "constant"):
        return latent
    strength = reference.strength
    if step_progress is not None:
        strength *= curve_factor(reference.step_curve, step_progress)
    count = latent.shape[-1] if reference.kind == "audio" else latent.shape[2]
    if reference.frame_curve != "constant" and count > 1:
        shape = (1, 1, 1, count) if reference.kind == "audio" else (1, 1, count, 1, 1)
        strength = strength * curve_factor(reference.frame_curve, torch.linspace(0, 1, count)).reshape(shape)
    if reference.kind == "audio":
        blurred = functional.avg_pool1d(latent.reshape(64, 1, -1), 5, stride=1, padding=2).reshape_as(latent)
        return latent * strength + blurred * (1 - strength)
    size = (latent.shape[2], 2, 2)
    blurred = functional.adaptive_avg_pool3d(latent, size)
    blurred = functional.interpolate(blurred, size=latent.shape[2:], mode="trilinear", align_corners=False)
    return latent * strength + blurred * (1 - strength)


def save_destination(output_path, name):
    if not isinstance(name, str) or not name.strip() or len(name) > 256:
        raise ValueError("Enter a RefMod name of at most 256 characters")
    if not isinstance(output_path, str):
        raise ValueError("Choose an absolute .safetensors output path")
    path = Path(output_path)
    if not path.is_absolute() or path.suffix.lower() != ".safetensors":
        raise ValueError("Choose an absolute .safetensors output path")
    if path.exists():
        raise ValueError("A RefMod already exists at that path; choose a new name")
    return path


def save_references(references, output_path, name, temporary_path=None):
    import torch
    from safetensors.torch import save_file

    path = save_destination(output_path, name)
    if not 1 <= len(references) <= MAX_MEMBERS:
        raise ValueError("Save 1–256 RefMod members")
    tensor_bytes = sum(reference.latent.numel() * reference.latent.element_size() for reference in references)
    if tensor_bytes > MAX_FILE_BYTES - MAX_METADATA_BYTES:
        raise ValueError("RefMod exceeds the 512 MiB file limit")
    tensors, members = {}, []
    for index, reference in enumerate(references):
        latent = reference.latent.detach().cpu().contiguous()
        token_count(reference.kind, latent.shape)
        if latent.dtype not in (torch.float16, torch.bfloat16, torch.float32):
            raise ValueError("RefMod latents must use floating point tensors")
        if not torch.isfinite(latent).all():
            raise ValueError("Cannot save non-finite RefMod latents")
        tensors[f"ref_{index}"] = latent.clone()
        metadata = {**reference.metadata, "_format_version": 4,
                    "latent_t": latent.shape[-1] if reference.kind == "audio" else latent.shape[2]}
        if reference.kind != "audio":
            metadata.update(latent_h=latent.shape[-2], latent_w=latent.shape[-1])
        _validate_member_metadata(metadata)
        members.append(metadata)
    container = {"_format_version": 5, "kind": "bundle", "name": name.strip(), "members": members}
    encoded_metadata = json.dumps(container, ensure_ascii=False)
    if len(encoded_metadata.encode("utf-8")) > MAX_METADATA_BYTES:
        raise ValueError("RefMod metadata exceeds 1 MiB; shorten descriptions or reduce members")
    path.parent.mkdir(parents=True, exist_ok=True)
    if temporary_path is None:
        descriptor, temporary = tempfile.mkstemp(prefix=".refmod-", suffix=".safetensors", dir=path.parent)
        os.close(descriptor)
    else:
        temporary = local_file(temporary_path)
        if temporary.parent != path.parent.resolve() or not temporary.name.startswith(".refmod-") or temporary.stat().st_size:
            raise ValueError("RefMod temporary reservation is invalid")
    try:
        save_file(tensors, temporary, metadata={"refmod_meta": encoded_metadata})
        with open(temporary, "rb+") as saved:
            os.fsync(saved.fileno())
        if Path(temporary).stat().st_size > MAX_FILE_BYTES:
            raise ValueError("RefMod exceeds the 512 MiB file limit")
        os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
    return inspect_file(str(path))


def handle_request(request):
    if not isinstance(request, dict):
        raise ValueError("RefMod request must be an object")
    operation = request.get("operation")
    if operation == "inspect":
        return inspect_file(request.get("path"))
    if operation == "inspect-many":
        paths = request.get("paths")
        if not isinstance(paths, list) or not 1 <= len(paths) <= MAX_MEMBERS or any(not isinstance(path, str) for path in paths):
            raise ValueError("Choose 1–256 RefMod paths to inspect")
        return _inspection_page(paths, request.get("offset", 0), False)
    if operation == "import":
        directory = Path(request.get("libraryDirectory", ""))
        if not directory.is_absolute():
            raise ValueError("Choose an absolute RefMod library directory")
        info = inspect_file(request.get("path"))
        references, _ = load_references([{"path": info["path"]}], 0)
        return save_references(references, str(directory / f"{uuid.uuid4().hex}.safetensors"), info["name"], request.get("temporaryPath"))
    if operation == "sources":
        directory = Path(request.get("directory", ""))
        if not directory.is_absolute() or not directory.is_dir():
            raise ValueError("Choose an existing absolute source directory")
        extensions = {"image": {".png", ".jpg", ".jpeg", ".webp", ".bmp"},
                      "video": {".mp4", ".mov", ".mkv", ".webm"},
                      "audio": {".wav", ".mp3", ".flac", ".ogg", ".m4a"}}
        sources = []
        for path in sorted(directory.iterdir()):
            if not path.is_file():
                continue
            for kind, suffixes in extensions.items():
                if path.suffix.lower() in suffixes:
                    sources.append({"path": str(path.resolve()), "kind": kind, "startSeconds": 0})
                    break
            if len(sources) > MAX_MEMBERS:
                raise ValueError("Source directory exceeds 256 files; choose a smaller folder")
        if not sources:
            raise ValueError("Source directory has no supported image, video or audio files")
        return sources
    if operation == "list":
        directory = Path(request.get("directory", ""))
        if not directory.is_absolute() or not directory.is_dir():
            raise ValueError("Choose an existing absolute RefMod directory")
        paths = []
        for path in directory.rglob("*"):
            if path.suffix.lower() != ".safetensors" or not path.is_file():
                continue
            paths.append(path)
            if len(paths) > 1000:
                raise ValueError("RefMod directory exceeds 1000 files; choose a smaller folder")
        return _inspection_page(sorted(paths), request.get("offset", 0), True)
    if operation == "save":
        save_destination(request.get("outputPath"), request.get("name"))
        slots = request.get("slots")
        if not isinstance(slots, list) or not slots:
            raise ValueError("Choose RefMods to export")
        references, _ = load_references(slots, request.get("maxTokens", DEFAULT_TOKEN_BUDGET))
        references = [Reference(weaken_reference(reference), dict(reference.metadata)) for reference in references]
        return save_references(references, request.get("outputPath", ""), request.get("name"))
    if operation == "create":
        from media_refmod_creation import create

        if request.get("keepInLibrary") and not Path(request.get("libraryDirectory", "")).is_absolute():
            raise ValueError("Choose an absolute RefMod library directory")
        result = create(request)
        if request.get("keepInLibrary"):
            return handle_request({"operation": "import", "path": result["path"], "libraryDirectory": request.get("libraryDirectory"), "temporaryPath": request.get("libraryTemporaryPath")})
        return result
    if operation == "preview":
        from media_refmod_preview import preview

        return preview(request)
    raise ValueError("Choose inspect, inspect-many, import, list, sources, save, create or preview")
