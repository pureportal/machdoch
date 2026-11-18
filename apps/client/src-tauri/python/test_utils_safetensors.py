import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from safetensors.torch import save_file

from fizgig.utils import safetensors as reader_module
from fizgig.utils.safetensors import (
    MAX_HEADER_BYTES,
    SafetensorsReader,
    ShardedSafetensorsReader,
    TensorSpec,
    load_safetensors,
    open_safetensors,
)


def sample_tensors():
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
        "fp8": torch.tensor([0.5, -2.0], dtype=torch.float8_e4m3fn),
        "empty": torch.empty((0, 3), dtype=torch.bfloat16),
    }


class SafetensorsReaderTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        self.path = self.directory / "weights.safetensors"

    def write_file(self, header, payload=b""):
        encoded = json.dumps(header).encode("utf-8")
        self.path.write_bytes(struct.pack("<Q", len(encoded)) + encoded + payload)

    def assert_same(self, actual, expected):
        self.assertEqual(actual.dtype, expected.dtype)
        self.assertEqual(tuple(actual.shape), tuple(expected.shape))
        if expected.dtype == torch.float8_e4m3fn:
            actual, expected = actual.float(), expected.float()
        self.assertTrue(torch.equal(actual, expected))

    def test_reads_every_dtype_with_metadata_and_specs(self):
        tensors = sample_tensors()
        save_file(tensors, str(self.path), {"origin": "test"})
        with SafetensorsReader(self.path) as reader:
            self.assertEqual(reader.metadata(), {"origin": "test"})
            self.assertEqual(set(reader.keys()), set(tensors))
            self.assertEqual(reader.specs["matrix"].shape, (2, 2))
            self.assertEqual(reader.specs["matrix"].dtype, "F32")
            for key, expected in tensors.items():
                self.assert_same(reader.get_tensor(key), expected)
            converted = reader.get_tensor("matrix", dtype=torch.float64)
            self.assertTrue(torch.equal(converted, tensors["matrix"].double()))
        loaded = load_safetensors(self.path)
        for key, expected in tensors.items():
            self.assert_same(loaded[key], expected)

    def test_reads_are_owned_copies(self):
        save_file({"weights": torch.arange(4, dtype=torch.float32)}, str(self.path))
        with SafetensorsReader(self.path) as reader:
            first = reader.get_tensor("weights")
            first.zero_()
            self.assertTrue(torch.equal(reader.get_tensor("weights"), torch.arange(4, dtype=torch.float32)))

    def test_missing_key_names_the_file(self):
        save_file({"weights": torch.ones(1)}, str(self.path))
        with SafetensorsReader(self.path) as reader, self.assertRaisesRegex(KeyError, "absent"):
            reader.get_tensor("absent")

    @unittest.skipUnless(torch.cuda.is_available(), "needs a GPU")
    def test_device_reads_stream_through_staging_in_chunks(self):
        weights = torch.randn(3, 1000, dtype=torch.float32)
        save_file({"weights": weights, "scale": torch.tensor([2.0])}, str(self.path))
        with patch.object(reader_module, "STAGING_BYTES", 1024), SafetensorsReader(self.path) as reader:
            on_device = reader.get_tensor("weights", "cuda")
            halves = reader.get_tensor("weights", "cuda", torch.float16)
            scale = reader.get_tensor("scale", "cuda")
        self.assertEqual(on_device.device.type, "cuda")
        self.assertTrue(torch.equal(on_device.cpu(), weights))
        self.assertTrue(torch.equal(halves.cpu(), weights.half()))
        self.assertEqual(scale.item(), 2.0)

    def test_opening_reads_only_the_header(self):
        payload_bytes = 26_000_000_000
        self.write_file({"weights": {"dtype": "BF16", "shape": [payload_bytes // 2], "data_offsets": [0, payload_bytes]}})
        header_bytes = self.path.stat().st_size
        with open(self.path, "ab") as handle:
            handle.truncate(header_bytes + payload_bytes)
        with patch.object(SafetensorsReader, "_read_into", side_effect=AssertionError("payload read")):
            with SafetensorsReader(self.path) as reader:
                self.assertEqual(reader.keys(), ["weights"])
                self.assertEqual(reader.specs["weights"], TensorSpec("BF16", (payload_bytes // 2,), 0, payload_bytes))

    def test_truncated_and_oversized_headers_fail(self):
        for contents in (b"", b"\x01", struct.pack("<Q", 20) + b"{}"):
            with self.subTest(contents=contents):
                self.path.write_bytes(contents)
                with self.assertRaisesRegex(ValueError, "truncated header"):
                    SafetensorsReader(self.path)
        self.path.write_bytes(struct.pack("<Q", MAX_HEADER_BYTES + 1))
        with self.assertRaisesRegex(ValueError, "header is too large"):
            SafetensorsReader(self.path)

    def test_duplicate_fields_fail(self):
        tensor = '{"dtype":"F32","shape":[1],"data_offsets":[0,4]}'
        for encoded in (
            f'{{"weights":{tensor},"weights":{tensor}}}',
            '{"weights":{"dtype":"F32","dtype":"BF16","shape":[1],"data_offsets":[0,4]}}',
            '{"__metadata__":{"source":"first","source":"second"}}',
        ):
            with self.subTest(header=encoded):
                header = encoded.encode("utf-8")
                self.path.write_bytes(struct.pack("<Q", len(header)) + header + b"\x00" * 4)
                with self.assertRaisesRegex(ValueError, "duplicate field"):
                    SafetensorsReader(self.path)

    def test_malformed_headers_and_metadata_fail(self):
        self.path.write_bytes(struct.pack("<Q", 1) + b"{")
        with self.assertRaisesRegex(ValueError, "malformed header"):
            SafetensorsReader(self.path)
        self.path.write_bytes(struct.pack("<Q", 2) + b"\xff\xfe")
        with self.assertRaisesRegex(ValueError, "malformed header"):
            SafetensorsReader(self.path)
        for header in ([], {"__metadata__": {"version": 1}}, {"weights": []}):
            with self.subTest(header=header), self.assertRaises(ValueError):
                self.write_file(header)
                SafetensorsReader(self.path)

    def test_invalid_tensor_fields_fail(self):
        valid = {"dtype": "F32", "shape": [2], "data_offsets": [0, 8]}
        cases = (
            ({**valid, "dtype": "UNKNOWN"}, "unsupported dtype"),
            ({**valid, "dtype": ["F32"]}, "unsupported dtype"),
            ({**valid, "shape": [-1, 2]}, "invalid shape"),
            ({**valid, "shape": [True, 2]}, "invalid shape"),
            ({**valid, "shape": [3]}, "shape and offsets disagree"),
            ({**valid, "data_offsets": [8, 0]}, "offsets outside payload"),
            ({**valid, "data_offsets": [0, 12]}, "offsets outside payload"),
            ({**valid, "data_offsets": [False, 8]}, "invalid offsets"),
            ({"dtype": "F32", "shape": [2]}, "malformed metadata"),
            ({**valid, "shape": [sys.maxsize] * 64}, "invalid shape"),
        )
        for tensor, message in cases:
            with self.subTest(tensor=tensor), self.assertRaisesRegex(ValueError, message):
                self.write_file({"weights": tensor}, b"\x00" * 8)
                SafetensorsReader(self.path)

    def test_empty_tensor_with_overflowing_stride_fails(self):
        self.write_file({"empty": {"dtype": "F32", "shape": [0, sys.maxsize, sys.maxsize], "data_offsets": [0, 0]}})
        with self.assertRaisesRegex(ValueError, "invalid shape"):
            SafetensorsReader(self.path)

    def test_payload_gaps_overlaps_and_trailing_bytes_fail(self):
        first = {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}
        cases = (
            ({"a": first, "b": first}, 8),
            ({"a": {**first, "data_offsets": [4, 8]}}, 8),
            ({"a": first}, 8),
            ({"a": first, "empty": {"dtype": "F32", "shape": [0], "data_offsets": [2, 2]}}, 4),
        )
        for header, size in cases:
            with self.subTest(header=header), self.assertRaises(ValueError):
                self.write_file(header, b"\x00" * size)
                SafetensorsReader(self.path)


class ShardedSafetensorsReaderTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.shards = self.root / "shards"
        self.shards.mkdir()
        self.index = self.shards / "model.safetensors.index.json"

    def write_shard(self, name, tensors):
        save_file(tensors, str(self.shards / name))

    def write_index(self, weight_map):
        self.index.write_text(json.dumps({"weight_map": weight_map}), encoding="utf-8")

    def assert_readable(self):
        with open_safetensors(self.shards) as reader:
            self.assertIsInstance(reader, ShardedSafetensorsReader)
            self.assertEqual(set(reader.keys()), {"first", "second"})
            self.assertEqual(reader.specs["second"].shape, (1,))
            self.assertTrue(torch.equal(reader.get_tensor("first"), torch.tensor([1.0])))
            self.assertTrue(torch.equal(reader.get_tensor("second"), torch.tensor([2.0])))

    def test_indexed_and_scanned_shards_are_readable(self):
        self.write_shard("first.safetensors", {"first": torch.tensor([1.0])})
        self.write_shard("second.safetensors", {"second": torch.tensor([2.0])})
        self.assert_readable()
        self.write_index({"first": "first.safetensors", "second": "second.safetensors"})
        self.assert_readable()

    def test_multiple_indexes_are_rejected(self):
        self.write_shard("first.safetensors", {"first": torch.tensor([1.0])})
        self.write_index({"first": "first.safetensors"})
        (self.shards / "other.safetensors.index.json").write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "multiple safetensors indexes"):
            ShardedSafetensorsReader(self.shards)

    def test_malformed_weight_maps_are_rejected(self):
        self.write_shard("first.safetensors", {"first": torch.tensor([1.0])})
        for weight_map in (None, [], {}, {"": "first.safetensors"}, {"first": 1}, {"first": ""},
                           {"missing": "first.safetensors"}):
            with self.subTest(weight_map=weight_map):
                self.write_index(weight_map)
                with self.assertRaisesRegex(ValueError, "weight_map|missing from shard"):
                    ShardedSafetensorsReader(self.shards)
        for contents, message in (
            ('{"weight_map":{"first":"first.safetensors","first":"first.safetensors"}}', "duplicate key"),
            ("{", "malformed safetensors index"),
        ):
            self.index.write_text(contents, encoding="utf-8")
            with self.assertRaisesRegex(ValueError, message):
                ShardedSafetensorsReader(self.shards)
        self.index.write_bytes(b"\xff")
        with self.assertRaisesRegex(ValueError, "malformed safetensors index"):
            ShardedSafetensorsReader(self.shards)

    def test_missing_and_escaping_shards_are_rejected(self):
        outside = self.root / "outside.safetensors"
        save_file({"first": torch.tensor([1.0])}, str(outside))
        for name in ("missing.safetensors", "../outside.safetensors", str(outside),
                     "..\\outside.safetensors", "first.txt"):
            with self.subTest(name=name):
                self.write_index({"first": name})
                with self.assertRaisesRegex(ValueError, "missing shard|invalid shard name"):
                    ShardedSafetensorsReader(self.shards)

    def test_symlink_to_outside_shard_is_rejected(self):
        outside = self.root / "outside.safetensors"
        save_file({"first": torch.tensor([1.0])}, str(outside))
        try:
            (self.shards / "linked.safetensors").symlink_to(outside)
        except OSError as error:
            self.skipTest(f"symlink unavailable: {error}")
        self.write_index({"first": "linked.safetensors"})
        with self.assertRaisesRegex(ValueError, "outside the directory"):
            ShardedSafetensorsReader(self.shards)

    def test_duplicate_keys_across_scanned_shards_are_rejected(self):
        self.write_shard("first.safetensors", {"shared": torch.tensor([1.0])})
        self.write_shard("second.safetensors", {"shared": torch.tensor([2.0])})
        with self.assertRaisesRegex(ValueError, "duplicate tensor key 'shared'"):
            ShardedSafetensorsReader(self.shards)


if __name__ == "__main__":
    unittest.main()
