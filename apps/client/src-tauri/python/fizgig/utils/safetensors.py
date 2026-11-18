"""Safetensors reading without memory-mapping.

Windows access-violates when torch slices memory-mapped storage of very large files, so tensors
are read with positioned file reads. CUDA targets stream through two pinned staging buffers:
the disk read of one chunk overlaps the device copy of the previous one, and the copies run on
the caller's current stream, so returned tensors are ordered for immediate use.
"""

import json
import math
import os
import struct
import sys
from dataclasses import dataclass
from pathlib import Path

import torch

MAX_HEADER_BYTES = 100_000_000
STAGING_BYTES = 32 << 20
DTYPES = {
    "F64": torch.float64,
    "F32": torch.float32,
    "F16": torch.float16,
    "BF16": torch.bfloat16,
    "I64": torch.int64,
    "I32": torch.int32,
    "I16": torch.int16,
    "I8": torch.int8,
    "U8": torch.uint8,
    "BOOL": torch.bool,
    "F8_E5M2": torch.float8_e5m2,
    "F8_E4M3": torch.float8_e4m3fn,
}


@dataclass(frozen=True)
class TensorSpec:
    dtype: str
    shape: tuple[int, ...]
    start: int
    end: int

    @property
    def nbytes(self) -> int:
        return self.end - self.start


def _unique_fields(pairs):
    fields = {}
    for key, value in pairs:
        if key in fields:
            raise ValueError(f"Invalid safetensors file: duplicate field {key!r}")
        fields[key] = value
    return fields


def _tensor_spec(name: str, entry, payload_bytes: int) -> TensorSpec:
    if not isinstance(entry, dict) or set(entry) != {"dtype", "shape", "data_offsets"}:
        raise ValueError(f"Invalid safetensors tensor {name!r}: malformed metadata")
    dtype, shape, offsets = entry["dtype"], entry["shape"], entry["data_offsets"]
    if not isinstance(dtype, str) or dtype not in DTYPES:
        raise ValueError(f"Invalid safetensors tensor {name!r}: unsupported dtype")
    if (not isinstance(shape, list) or any(type(dim) is not int or dim < 0 for dim in shape)
            or math.prod(max(dim, 1) for dim in shape) > sys.maxsize):
        raise ValueError(f"Invalid safetensors tensor {name!r}: invalid shape")
    if not isinstance(offsets, list) or len(offsets) != 2 or any(type(offset) is not int for offset in offsets):
        raise ValueError(f"Invalid safetensors tensor {name!r}: invalid offsets")
    start, end = offsets
    if not 0 <= start <= end <= payload_bytes:
        raise ValueError(f"Invalid safetensors tensor {name!r}: offsets outside payload")
    if math.prod(shape) * DTYPES[dtype].itemsize != end - start:
        raise ValueError(f"Invalid safetensors tensor {name!r}: shape and offsets disagree")
    return TensorSpec(dtype, tuple(shape), start, end)


def _read_header(file) -> tuple[dict[str, TensorSpec], dict[str, str], int]:
    file_bytes = os.fstat(file.fileno()).st_size
    prefix = file.read(8)
    if len(prefix) < 8:
        raise ValueError("Invalid safetensors file: truncated header")
    header_bytes = struct.unpack("<Q", prefix)[0]
    if header_bytes > MAX_HEADER_BYTES:
        raise ValueError("Invalid safetensors file: header is too large")
    if header_bytes == 0 or header_bytes > file_bytes - 8:
        raise ValueError("Invalid safetensors file: truncated header")
    try:
        header = json.loads(file.read(header_bytes), object_pairs_hook=_unique_fields)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError("Invalid safetensors file: malformed header") from error
    if not isinstance(header, dict):
        raise ValueError("Invalid safetensors file: header must be an object")
    metadata = header.pop("__metadata__", {})
    if not isinstance(metadata, dict) or any(not isinstance(value, str) for value in metadata.values()):
        raise ValueError("Invalid safetensors file: metadata must contain string pairs")
    payload_bytes = file_bytes - 8 - header_bytes
    specs = {name: _tensor_spec(name, entry, payload_bytes) for name, entry in header.items()}
    covered = 0
    for spec in sorted(specs.values(), key=lambda spec: (spec.start, spec.end)):
        if spec.start != covered:
            raise ValueError("Invalid safetensors file: tensor offsets are not contiguous")
        covered = spec.end
    if covered != payload_bytes:
        raise ValueError("Invalid safetensors file: payload size does not match tensor offsets")
    return specs, metadata, 8 + header_bytes


class SafetensorsReader:
    """One safetensors file; only the header is read on open."""

    def __init__(self, path):
        self.path = Path(path)
        self._file = open(self.path, "rb", buffering=0)
        try:
            self.specs, self._metadata, self._data_start = _read_header(self._file)
        except BaseException:
            self._file.close()
            raise
        self._staging = None
        self._turn = 0

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    def close(self):
        self._file.close()
        self._staging = None

    def keys(self) -> list[str]:
        return list(self.specs)

    def metadata(self) -> dict[str, str]:
        return dict(self._metadata)

    def get_tensor(self, key: str, device=None, dtype: torch.dtype | None = None) -> torch.Tensor:
        spec = self.specs.get(key)
        if spec is None:
            raise KeyError(f"{key!r} is not in {self.path}")
        target = torch.device("cpu" if device is None else device)
        if target.type == "cuda":
            data = self._upload(spec, target)
        else:
            data = self._read(spec)
            if target.type != "cpu":
                data = data.to(target)
        tensor = data.view(DTYPES[spec.dtype]).reshape(spec.shape)
        return tensor if dtype is None else tensor.to(dtype)

    def _read_into(self, offset: int, view: memoryview):
        self._file.seek(self._data_start + offset)
        filled = 0
        while filled < len(view):
            count = self._file.readinto(view[filled:])
            if not count:
                raise ValueError(f"{self.path} ended inside tensor data")
            filled += count

    def _read(self, spec: TensorSpec) -> torch.Tensor:
        data = torch.empty(spec.nbytes, dtype=torch.uint8)
        self._read_into(spec.start, memoryview(data.numpy()))
        return data

    def _upload(self, spec: TensorSpec, device: torch.device) -> torch.Tensor:
        data = torch.empty(spec.nbytes, dtype=torch.uint8, device=device)
        if self._staging is None:
            self._staging = [(torch.empty(STAGING_BYTES, dtype=torch.uint8, pin_memory=True), torch.cuda.Event())
                             for _ in range(2)]
        stream = torch.cuda.current_stream(device)
        for offset in range(0, spec.nbytes, STAGING_BYTES):
            buffer, copied = self._staging[self._turn]
            self._turn ^= 1
            copied.synchronize()
            size = min(STAGING_BYTES, spec.nbytes - offset)
            self._read_into(spec.start + offset, memoryview(buffer.numpy())[:size])
            data[offset:offset + size].copy_(buffer[:size], non_blocking=True)
            copied.record(stream)
        return data


def _unique_index_keys(pairs):
    entries = {}
    for key, value in pairs:
        if key in entries:
            raise ValueError(f"Invalid safetensors index: duplicate key {key!r}")
        entries[key] = value
    return entries


class ShardedSafetensorsReader:
    """A directory of safetensors shards, routed through its index when one is present."""

    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self._readers: dict[str, SafetensorsReader] = {}
        try:
            entries = sorted(os.listdir(self.directory))
            indexes = [entry for entry in entries if entry.endswith(".safetensors.index.json")]
            if len(indexes) > 1:
                raise ValueError(f"{self.directory}: multiple safetensors indexes")
            self.weight_map = self._indexed(indexes[0]) if indexes else self._scanned(entries)
        except BaseException:
            self.close()
            raise
        self.specs = {key: self._readers[shard].specs[key] for key, shard in self.weight_map.items()}

    def _indexed(self, index: str) -> dict[str, str]:
        try:
            document = json.loads((self.directory / index).read_bytes(), object_pairs_hook=_unique_index_keys)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"{self.directory}: malformed safetensors index") from error
        weight_map = document.get("weight_map") if isinstance(document, dict) else None
        if not isinstance(weight_map, dict) or not weight_map or any(
                not key or not isinstance(shard, str) or not shard for key, shard in weight_map.items()):
            raise ValueError(f"{self.directory}: invalid safetensors weight_map")
        for key, shard in weight_map.items():
            if key not in self._open(shard).specs:
                raise ValueError(f"{self.directory}: tensor {key!r} is missing from shard {shard!r}")
        return weight_map

    def _scanned(self, entries: list[str]) -> dict[str, str]:
        shards = [entry for entry in entries if entry.endswith(".safetensors")]
        if not shards:
            raise FileNotFoundError(f"{self.directory}: no .safetensors shards")
        weight_map = {}
        for shard in shards:
            for key in self._open(shard).specs:
                if key in weight_map:
                    raise ValueError(f"{self.directory}: duplicate tensor key {key!r} in shards")
                weight_map[key] = shard
        return weight_map

    def _open(self, shard: str) -> SafetensorsReader:
        reader = self._readers.get(shard)
        if reader is not None:
            return reader
        if not shard.endswith(".safetensors") or any(mark in shard for mark in ("/", "\\", ":", "\0")):
            raise ValueError(f"{self.directory}: invalid shard name {shard!r}")
        path = (self.directory / shard).resolve()
        if path.parent != self.directory:
            raise ValueError(f"{self.directory}: shard {shard!r} is outside the directory")
        if not path.is_file():
            raise ValueError(f"{self.directory}: missing shard {shard!r}")
        reader = self._readers[shard] = SafetensorsReader(path)
        return reader

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()

    def close(self):
        for reader in self._readers.values():
            reader.close()
        self._readers.clear()

    def keys(self) -> list[str]:
        return list(self.weight_map)

    def metadata(self) -> dict[str, str]:
        merged = {}
        for reader in self._readers.values():
            merged.update(reader.metadata())
        return merged

    def get_tensor(self, key: str, device=None, dtype: torch.dtype | None = None) -> torch.Tensor:
        shard = self.weight_map.get(key)
        if shard is None:
            raise KeyError(f"{key!r} is not in any shard of {self.directory}")
        return self._readers[shard].get_tensor(key, device, dtype)


def open_safetensors(path) -> SafetensorsReader | ShardedSafetensorsReader:
    return ShardedSafetensorsReader(path) if os.path.isdir(path) else SafetensorsReader(path)


def load_safetensors(path, device="cpu") -> dict[str, torch.Tensor]:
    with SafetensorsReader(path) as reader:
        return {key: reader.get_tensor(key, device) for key in reader.keys()}
