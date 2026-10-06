import json
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import Mock, patch

import torch
from safetensors import safe_open
from safetensors.torch import save_file

from media_refmods import Reference, inspect_file, load_reference, load_references, save_references


class RefModLoadingTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def bundle(self):
        references = [
            Reference(torch.ones(1, 24, 1, 4, 4), {"kind": "image", "name": "Look"}),
            Reference(torch.ones(1, 32, 2, 20, dtype=torch.bfloat16), {"kind": "audio", "name": "Sound", "sample_rate": 32000}),
            Reference(torch.ones(1, 24, 3, 4, 4, dtype=torch.float16), {"kind": "video", "name": "Motion"}),
        ]
        path = self.root / "bundle.safetensors"
        save_references(references, str(path), "Mixed")
        return path, references

    def test_preview_loading_reads_only_the_selected_tensor_and_preserves_its_dtype(self):
        path, references = self.bundle()
        opened = []

        @contextmanager
        def tracked_open(*args, **kwargs):
            with safe_open(*args, **kwargs) as checkpoint:
                tracked = Mock(wraps=checkpoint)
                opened.append(tracked)
                yield tracked

        with patch("safetensors.safe_open", side_effect=tracked_open):
            for index, expected in enumerate(references):
                actual = load_reference(str(path), index)
                self.assertEqual(actual.kind, expected.kind)
                self.assertEqual(actual.metadata["name"], expected.metadata["name"])
                self.assertEqual(actual.latent.dtype, expected.latent.dtype)
                self.assertTrue(torch.equal(actual.latent, expected.latent))
                opened[-1].get_tensor.assert_called_once_with(f"ref_{index}")

    def test_invalid_preview_member_is_rejected_before_materializing_any_tensor(self):
        path, _ = self.bundle()

        @contextmanager
        def header_only(*args, **kwargs):
            with safe_open(*args, **kwargs) as checkpoint:
                tracked = Mock(wraps=checkpoint)
                tracked.get_tensor.side_effect = AssertionError("invalid member must not load tensors")
                yield tracked

        with patch("safetensors.safe_open", side_effect=header_only):
            for index in (-1, 3, True, 0.5, "1"):
                with self.subTest(index=index), self.assertRaisesRegex(ValueError, "Preview member"):
                    load_reference(str(path), index)

    def test_preview_rejects_nonfinite_selected_values_without_loading_other_members(self):
        path, _ = self.bundle()
        with safe_open(str(path), framework="pt") as checkpoint:
            metadata = checkpoint.metadata()
            tensors = {key: checkpoint.get_tensor(key).clone() for key in checkpoint.keys()}
        tensors["ref_1"].fill_(float("nan"))
        save_file(tensors, str(path), metadata=metadata)
        self.assertEqual(load_reference(str(path), 0).metadata["name"], "Look")
        with self.assertRaisesRegex(ValueError, "non-finite"):
            load_reference(str(path), 1)
        with self.assertRaisesRegex(ValueError, "non-finite"):
            load_references([{"path": str(path)}])

    def test_incorrect_audio_clock_is_rejected_on_inspection_load_and_save(self):
        latent = torch.ones(1, 32, 2, 20)
        for rate in (16000, 48000, 32000.0, "32000", True, None):
            with self.subTest(rate=rate):
                metadata = {"kind": "audio", "_format_version": 4, "sample_rate": rate}
                path = self.root / "invalid.safetensors"
                save_file({"latent": latent}, str(path), metadata={"refmod_meta": json.dumps(metadata)})
                for operation in (lambda: inspect_file(str(path)), lambda: load_reference(str(path), 0),
                                  lambda: load_references([{"path": str(path)}])):
                    with self.assertRaisesRegex(ValueError, "32000 Hz"):
                        operation()
                output = self.root / "rejected.safetensors"
                with self.assertRaisesRegex(ValueError, "32000 Hz"):
                    save_references([Reference(latent, metadata)], str(output), "Invalid")
                self.assertFalse(output.exists())
                self.assertEqual(list(self.root.glob(".refmod-*")), [])

    def test_dimensions_require_integer_metadata(self):
        for dimension in (True, 1.0, "1"):
            with self.subTest(dimension=dimension):
                path = self.root / "invalid-dimension.safetensors"
                save_file({"latent": torch.ones(1, 24, 1, 4, 4)}, str(path), metadata={
                    "refmod_meta": json.dumps({"kind": "image", "_format_version": 4, "latent_t": dimension})})
                with self.assertRaisesRegex(ValueError, "disagrees"):
                    inspect_file(str(path))

    def test_preview_checks_float32_memory_cost_before_loading_the_selected_tensor(self):
        path = self.root / "large.safetensors"
        save_file({"latent": torch.ones(1, 24, 1, 16, 16, dtype=torch.float16)}, str(path), metadata={
            "refmod_meta": json.dumps({"kind": "image", "_format_version": 4})})
        self.assertLess(path.stat().st_size, 16000)

        @contextmanager
        def header_only(*args, **kwargs):
            with safe_open(*args, **kwargs) as checkpoint:
                tracked = Mock(wraps=checkpoint)
                tracked.get_tensor.side_effect = AssertionError("oversized reference must not load tensors")
                yield tracked

        with patch("media_refmods.MAX_FILE_BYTES", 16000), patch("safetensors.safe_open", side_effect=header_only):
            with self.assertRaisesRegex(ValueError, "Preview reference exceeds"):
                load_reference(str(path), 0)


if __name__ == "__main__":
    unittest.main()
