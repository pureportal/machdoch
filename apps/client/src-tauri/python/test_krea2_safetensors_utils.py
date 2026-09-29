import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import torch
from safetensors import safe_open

from fizgig.krea2.safetensors_utils import (
    MAX_SAFETENSORS_HEADER_SIZE,
    MemoryEfficientSafeOpen,
    ShardedSafeOpen,
    load_safetensors,
    mem_eff_save_file,
    stream_save_file,
)


class Krea2SafetensorsReaderTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "weights.safetensors"

    def write_file(self, header, payload=b""):
        encoded_header = json.dumps(header).encode("utf-8")
        self.path.write_bytes(struct.pack("<Q", len(encoded_header)) + encoded_header + payload)

    def sample_tensors(self):
        return {
            "matrix": torch.tensor([[1.5, -2.0], [3.25, 4.0]], dtype=torch.float32),
            "half": torch.tensor([-0.5, 2.0], dtype=torch.float16),
            "bfloat": torch.tensor([1.0, -3.0], dtype=torch.bfloat16),
            "double": torch.tensor(2.5, dtype=torch.float64),
            "signed": torch.tensor([-128, 127], dtype=torch.int8),
            "integer": torch.tensor([[-3, 2]], dtype=torch.int32),
            "scalar": torch.tensor(7, dtype=torch.int64),
            "unsigned": torch.tensor([0, 255], dtype=torch.uint8),
            "flags": torch.tensor([True, False], dtype=torch.bool),
            "empty": torch.empty((0, 3), dtype=torch.bfloat16),
        }

    def writers(self, tensors, metadata):
        return {
            "memory efficient": lambda: mem_eff_save_file(tensors, str(self.path), metadata),
            "streaming": lambda: stream_save_file(
                {key: (value.dtype, tuple(value.shape), lambda value=value: value)
                 for key, value in tensors.items()},
                str(self.path), metadata),
        }

    def test_both_writers_remain_readable(self):
        tensors = self.sample_tensors()
        metadata = {"origin": "test", "format": "pt"}

        for name, write in self.writers(tensors, metadata).items():
            with self.subTest(writer=name):
                self.path = Path(self.directory.name) / f"{name}.safetensors"
                write()
                with MemoryEfficientSafeOpen(self.path) as reader:
                    self.assertEqual(reader.metadata(), metadata)
                    self.assertEqual(set(reader.keys()), set(tensors))
                    for key, expected in tensors.items():
                        actual = reader.get_tensor(key)
                        self.assertEqual(actual.dtype, expected.dtype)
                        self.assertEqual(tuple(actual.shape), tuple(expected.shape))
                        self.assertTrue(torch.equal(actual, expected))

    def test_installed_safetensors_reads_both_writers(self):
        tensors = self.sample_tensors()
        metadata = {"origin": "test", "format": "pt"}

        for name, write in self.writers(tensors, metadata).items():
            with self.subTest(writer=name):
                self.path = Path(self.directory.name) / f"{name}.safetensors"
                write()
                with safe_open(str(self.path), framework="pt", device="cpu") as reader:
                    self.assertEqual(reader.metadata(), metadata)
                    self.assertEqual(set(reader.keys()), set(tensors))
                    for key, expected in tensors.items():
                        actual = reader.get_tensor(key)
                        self.assertEqual(actual.dtype, expected.dtype)
                        self.assertEqual(tuple(actual.shape), tuple(expected.shape))
                        self.assertTrue(torch.equal(actual, expected))

    def test_truncated_header_length_and_header_fail_validation(self):
        for contents in (b"", b"\x05\x00", struct.pack("<Q", 20) + b"{}"):
            with self.subTest(contents=contents):
                self.path.write_bytes(contents)
                with self.assertRaisesRegex(ValueError, "Invalid safetensors file: truncated header"):
                    MemoryEfficientSafeOpen(self.path)

    def test_oversized_header_fails_before_header_read(self):
        header_size = MAX_SAFETENSORS_HEADER_SIZE + 1
        reader = MemoryEfficientSafeOpen.__new__(MemoryEfficientSafeOpen)
        reader.file = Mock()
        reader.file.read.return_value = struct.pack("<Q", header_size)

        with patch("fizgig.krea2.safetensors_utils.os.fstat", return_value=SimpleNamespace(st_size=header_size + 8)):
            with self.assertRaisesRegex(ValueError, "header is too large"):
                reader._read_header()

        reader.file.read.assert_called_once_with(8)

    def test_truncated_payload_fails_before_tensor_read(self):
        self.write_file(
            {"weights": {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]}},
            b"\x00" * 4,
        )
        with patch("numpy.fromfile", side_effect=AssertionError("payload accessed")):
            with self.assertRaisesRegex(ValueError, "offsets outside payload"):
                MemoryEfficientSafeOpen(self.path)

    def test_invalid_tensor_metadata_fails_before_tensor_read(self):
        valid = {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]}
        cases = {
            "unsupported dtype": {**valid, "dtype": "OTHER"},
            "invalid shape": {**valid, "shape": [-1, 2]},
            "boolean dimension": {**valid, "shape": [True, 2]},
            "oversized dimension": {**valid, "shape": [2**80, 0]},
            "incorrect byte count": {**valid, "shape": [3]},
            "reversed offsets": {**valid, "data_offsets": [8, 0]},
            "out-of-range offsets": {**valid, "data_offsets": [4, 12]},
            "boolean offset": {**valid, "data_offsets": [False, 8]},
            "missing field": {"dtype": "F32", "shape": [2]},
        }
        for name, tensor in cases.items():
            with self.subTest(case=name):
                self.write_file({"weights": tensor}, b"\x00" * 8)
                with patch("numpy.fromfile", side_effect=AssertionError("payload accessed")):
                    with self.assertRaisesRegex(ValueError, "Invalid safetensors"):
                        MemoryEfficientSafeOpen(self.path)

    def test_large_shape_product_is_bounded_by_declared_bytes(self):
        dimensions = [sys.maxsize] * 2048
        self.write_file(
            {"weights": {"dtype": "F32", "shape": dimensions, "data_offsets": [0, 4]}},
            b"\x00" * 4,
        )
        with patch("numpy.fromfile", side_effect=AssertionError("payload accessed")):
            with self.assertRaisesRegex(ValueError, "shape and offsets disagree"):
                MemoryEfficientSafeOpen(self.path)

        self.write_file(
            {"empty": {"dtype": "F32", "shape": [sys.maxsize, 0], "data_offsets": [0, 0]}},
        )
        with MemoryEfficientSafeOpen(self.path) as reader:
            self.assertEqual(tuple(reader.get_tensor("empty").shape), (sys.maxsize, 0))

    def test_overlapping_gapped_and_trailing_payloads_fail_validation(self):
        cases = (
            ({"a": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]},
              "b": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}, 8),
            ({"a": {"dtype": "F32", "shape": [1], "data_offsets": [4, 8]}}, 8),
            ({"a": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}, 8),
            ({"a": {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]},
              "empty": {"dtype": "F32", "shape": [0], "data_offsets": [4, 4]}}, 8),
        )
        for header, size in cases:
            with self.subTest(header=header):
                self.write_file(header, b"\x00" * size)
                with self.assertRaisesRegex(ValueError, "Invalid safetensors file"):
                    MemoryEfficientSafeOpen(self.path)

    def test_malformed_json_and_header_structure_fail_validation(self):
        self.path.write_bytes(struct.pack("<Q", 1) + b"{")
        with self.assertRaisesRegex(ValueError, "malformed header"):
            MemoryEfficientSafeOpen(self.path)

        for header in ([], {"__metadata__": {"version": 1}}, {"tensor": []}):
            with self.subTest(header=header):
                self.write_file(header)
                with self.assertRaisesRegex(ValueError, "Invalid safetensors"):
                    MemoryEfficientSafeOpen(self.path)


class Krea2ShardedSafetensorsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.shards = Path(self.directory.name) / "shards"
        self.shards.mkdir()
        self.index = self.shards / "model.safetensors.index.json"

    def write_shard(self, name, tensors):
        mem_eff_save_file(tensors, str(self.shards / name))

    def write_index(self, weight_map):
        self.index.write_text(json.dumps({"weight_map": weight_map}), encoding="utf-8")

    def test_indexed_shards_remain_readable(self):
        self.write_shard("first.safetensors", {"first": torch.tensor([1.0])})
        self.write_shard("second.safetensors", {"second": torch.tensor([2.0])})
        self.write_index({"first": "first.safetensors", "second": "second.safetensors"})

        with ShardedSafeOpen(str(self.shards)) as reader:
            self.assertEqual(set(reader.keys()), {"first", "second"})
            self.assertTrue(torch.equal(reader.get_tensor("first"), torch.tensor([1.0])))
            self.assertTrue(torch.equal(reader.get_tensor("second"), torch.tensor([2.0])))

    def test_indexless_shards_remain_readable(self):
        self.write_shard("first.safetensors", {"first": torch.tensor([1.0])})
        self.write_shard("second.safetensors", {"second": torch.tensor([2.0])})

        with ShardedSafeOpen(str(self.shards)) as reader:
            self.assertEqual(set(reader.keys()), {"first", "second"})
            self.assertTrue(torch.equal(reader.get_tensor("first"), torch.tensor([1.0])))
            self.assertTrue(torch.equal(reader.get_tensor("second"), torch.tensor([2.0])))

    def test_multiple_indexes_are_rejected(self):
        self.write_shard("first.safetensors", {"first": torch.tensor([1.0])})
        self.write_index({"first": "first.safetensors"})
        (self.shards / "other.safetensors.index.json").write_text("{}", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "multiple safetensors indexes"):
            ShardedSafeOpen(str(self.shards))

    def test_malformed_weight_maps_are_rejected(self):
        self.write_shard("first.safetensors", {"first": torch.tensor([1.0])})
        invalid_maps = (None, [], {}, {"": "first.safetensors"},
                        {"first": 1}, {"first": ""}, {"missing": "first.safetensors"})
        for weight_map in invalid_maps:
            with self.subTest(weight_map=weight_map):
                self.write_index(weight_map)
                with self.assertRaisesRegex(ValueError, "weight_map|missing from shard"):
                    ShardedSafeOpen(str(self.shards))

        self.index.write_text('{"weight_map":{"first":"first.safetensors","first":"first.safetensors"}}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "duplicate key"):
            ShardedSafeOpen(str(self.shards))

        self.index.write_text("{", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "malformed safetensors index"):
            ShardedSafeOpen(str(self.shards))

        self.index.write_bytes(b"\xff")
        with self.assertRaisesRegex(ValueError, "malformed safetensors index"):
            ShardedSafeOpen(str(self.shards))

    def test_missing_and_escaping_shards_are_rejected(self):
        outside = Path(self.directory.name) / "outside.safetensors"
        mem_eff_save_file({"first": torch.tensor([1.0])}, str(outside))
        invalid_names = ("missing.safetensors", "../outside.safetensors",
                         str(outside), "..\\outside.safetensors", "first.txt")
        for name in invalid_names:
            with self.subTest(name=name):
                self.write_index({"first": name})
                with self.assertRaisesRegex(ValueError, "missing shard|invalid shard name"):
                    ShardedSafeOpen(str(self.shards))

    def test_symlink_to_outside_shard_is_rejected(self):
        outside = Path(self.directory.name) / "outside.safetensors"
        mem_eff_save_file({"first": torch.tensor([1.0])}, str(outside))
        try:
            (self.shards / "linked.safetensors").symlink_to(outside)
        except OSError as error:
            self.skipTest(f"symlink unavailable: {error}")
        self.write_index({"first": "linked.safetensors"})

        with self.assertRaisesRegex(ValueError, "outside the directory"):
            ShardedSafeOpen(str(self.shards))

    def test_duplicate_keys_across_indexless_shards_are_rejected(self):
        self.write_shard("first.safetensors", {"shared": torch.tensor([1.0])})
        self.write_shard("second.safetensors", {"shared": torch.tensor([2.0])})

        with self.assertRaisesRegex(ValueError, "duplicate tensor key 'shared'"):
            ShardedSafeOpen(str(self.shards))


class Krea2SafetensorsLoadTests(unittest.TestCase):
    def test_load_failure_propagates_without_retry(self):
        failure = RuntimeError("original load failure")
        with patch("fizgig.krea2.safetensors_utils.load_file", side_effect=failure) as load_file:
            with self.assertRaises(RuntimeError) as raised:
                load_safetensors("weights.safetensors", device="cuda")

        self.assertIs(raised.exception, failure)
        load_file.assert_called_once_with("weights.safetensors", device="cuda")

    def test_successful_load_converts_requested_dtype(self):
        weights = torch.tensor([1.5, -2.0], dtype=torch.float32)
        with patch("fizgig.krea2.safetensors_utils.load_file", return_value={"weights": weights}) as load_file:
            result = load_safetensors("weights.safetensors", device="cpu", dtype=torch.float64)

        load_file.assert_called_once_with("weights.safetensors", device="cpu")
        self.assertEqual(result["weights"].dtype, torch.float64)
        self.assertTrue(torch.equal(result["weights"], weights.to(dtype=torch.float64)))

    def test_real_file_load_converts_requested_dtype(self):
        weights = torch.tensor([1.5, -2.0], dtype=torch.float32)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "weights.safetensors")
            mem_eff_save_file({"weights": weights}, path)
            result = load_safetensors(path, device="cpu", dtype=torch.float64)

        self.assertEqual(result["weights"].dtype, torch.float64)
        self.assertTrue(torch.equal(result["weights"], weights.to(dtype=torch.float64)))


if __name__ == "__main__":
    unittest.main()
