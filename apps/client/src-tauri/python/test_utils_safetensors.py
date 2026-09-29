import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import torch

from fizgig.utils.safetensors import (
    MAX_SAFETENSORS_HEADER_SIZE,
    MemoryEfficientSafeOpen,
    load_safetensors,
    mem_eff_save_file,
)


class SafetensorsReaderTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.path = Path(directory.name) / "weights.safetensors"

    def write_file(self, header, payload=b""):
        encoded = json.dumps(header).encode("utf-8")
        self.path.write_bytes(struct.pack("<Q", len(encoded)) + encoded + payload)

    def test_writer_output_loads_with_empty_and_scalar_tensors(self):
        tensors = {
            "weights": torch.tensor([[1.5, -2.0]], dtype=torch.float32),
            "scalar": torch.tensor(7, dtype=torch.int64),
            "empty": torch.empty((0, 3), dtype=torch.float16),
        }
        mem_eff_save_file(tensors, str(self.path), {"source": "test"})

        with MemoryEfficientSafeOpen(self.path) as reader:
            self.assertEqual(reader.metadata(), {"source": "test"})
            self.assertEqual(set(reader.keys()), set(tensors))
            for key, expected in tensors.items():
                self.assertTrue(torch.equal(reader.get_tensor(key), expected))

        loaded = load_safetensors(str(self.path), device="cpu", disable_mmap=True)
        for key, expected in tensors.items():
            self.assertTrue(torch.equal(loaded[key], expected))

    def test_truncated_and_oversized_headers_fail_before_parsing(self):
        for contents in (b"", b"\x01", struct.pack("<Q", 20) + b"{}"):
            with self.subTest(contents=contents):
                self.path.write_bytes(contents)
                with self.assertRaisesRegex(ValueError, "truncated header"):
                    MemoryEfficientSafeOpen(self.path)

        reader = MemoryEfficientSafeOpen.__new__(MemoryEfficientSafeOpen)
        reader.file = Mock()
        reader.file.read.return_value = struct.pack("<Q", MAX_SAFETENSORS_HEADER_SIZE + 1)
        with patch("fizgig.utils.safetensors.os.fstat", return_value=SimpleNamespace(st_size=MAX_SAFETENSORS_HEADER_SIZE + 9)):
            with self.assertRaisesRegex(ValueError, "header is too large"):
                reader._read_header()
        reader.file.read.assert_called_once_with(8)

    def test_malformed_header_and_metadata_fail(self):
        self.path.write_bytes(struct.pack("<Q", 1) + b"{")
        with self.assertRaisesRegex(ValueError, "malformed header"):
            MemoryEfficientSafeOpen(self.path)

        for header in ([], {"__metadata__": {"version": 1}}, {"weights": []}):
            with self.subTest(header=header):
                self.write_file(header)
                with self.assertRaises(ValueError):
                    MemoryEfficientSafeOpen(self.path)

    def test_invalid_tensor_fields_fail_before_payload_read(self):
        valid = {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]}
        cases = (
            {**valid, "dtype": "UNKNOWN"},
            {**valid, "shape": [-1, 2]},
            {**valid, "shape": [True, 2]},
            {**valid, "shape": [3]},
            {**valid, "data_offsets": [8, 0]},
            {**valid, "data_offsets": [0, 12]},
            {**valid, "data_offsets": [False, 8]},
            {"dtype": "F32", "shape": [2]},
        )
        for tensor in cases:
            with self.subTest(tensor=tensor):
                self.write_file({"weights": tensor}, b"\x00" * 8)
                with patch("numpy.fromfile", side_effect=AssertionError("payload read")):
                    with self.assertRaises(ValueError):
                        MemoryEfficientSafeOpen(self.path)

        self.write_file({"weights": {**valid, "shape": [3]}}, b"\x00" * 8)
        with patch("numpy.fromfile", side_effect=AssertionError("payload read")):
            with self.assertRaisesRegex(ValueError, "shape and offsets disagree"):
                load_safetensors(str(self.path), device="cpu", disable_mmap=True)

    def test_payload_gaps_overlaps_and_trailing_bytes_fail(self):
        first = {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}
        cases = (
            ({"a": first, "b": first}, 8),
            ({"a": {**first, "data_offsets": [4, 8]}}, 8),
            ({"a": first}, 8),
            ({"a": first, "empty": {"dtype": "F32", "shape": [0], "data_offsets": [2, 2]}}, 4),
            ({"a": {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]}}, 4),
        )
        for header, size in cases:
            with self.subTest(header=header, size=size):
                self.write_file(header, b"\x00" * size)
                with self.assertRaises(ValueError):
                    MemoryEfficientSafeOpen(self.path)

    def test_large_shape_product_is_bounded(self):
        self.write_file(
            {"weights": {"dtype": "F32", "shape": [sys.maxsize] * 2048, "data_offsets": [0, 4]}},
            b"\x00" * 4,
        )
        with self.assertRaisesRegex(ValueError, "shape and offsets disagree"):
            MemoryEfficientSafeOpen(self.path)

    def test_empty_tensor_stride_overflow_fails_when_opening(self):
        self.write_file({
            "empty": {
                "dtype": "F32",
                "shape": [0, sys.maxsize, sys.maxsize],
                "data_offsets": [0, 0],
            }
        })
        with self.assertRaisesRegex(ValueError, "invalid shape"):
            MemoryEfficientSafeOpen(self.path)


if __name__ == "__main__":
    unittest.main()
