import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from safetensors.torch import save_file

from media_refmods import Reference, handle_request, inspect_file, save_references


class RefModCollectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def reference(self, name, description=""):
        path = self.root / f"{name}.safetensors"
        metadata = {"_format_version": 4, "kind": "image", "name": name, "description": description}
        save_file({"latent": torch.zeros(1, 24, 1, 2, 2)}, str(path),
                  metadata={"refmod_meta": json.dumps(metadata, ensure_ascii=False)})
        return str(path)

    def test_large_descriptions_fit_collection_replies_and_remain_in_individual_inspection(self):
        description = "x" * 700000
        paths = [self.reference(f"reference-{index}", description) for index in range(4)]
        batch = handle_request({"operation": "inspect-many", "paths": paths})
        library = handle_request({"operation": "list", "directory": str(self.root)})
        for page in (batch, library):
            self.assertLess(len(json.dumps(page).encode("utf-8")), 2 * 1024 * 1024)
            self.assertIsNone(page["nextOffset"])
            self.assertEqual(len(page["records"]), 4)
        self.assertNotIn("metadata", batch["records"][0]["record"]["members"][0])
        self.assertEqual(set(library["records"][0]), {"path", "name", "tokens"})
        self.assertEqual(inspect_file(paths[0])["members"][0]["metadata"]["description"], description)

    def test_pagination_preserves_file_order_and_errors(self):
        first = self.reference("a")
        invalid = self.root / "b.safetensors"
        invalid.write_bytes(b"invalid")
        last = self.reference("c")
        paths = [first, str(invalid), last]
        for operation in ("list", "inspect-many"):
            request = {"operation": operation, "paths": paths, "directory": str(self.root)}
            records, errors, offset, cursors = [], [], 0, []
            page_limit = 400 if operation == "list" else 700
            with patch("media_refmods.MAX_INSPECTION_PAGE_BYTES", page_limit):
                while True:
                    page = handle_request({**request, "offset": offset})
                    self.assertLessEqual(len(json.dumps(page).encode("utf-8")), page_limit)
                    records.extend(page["records"])
                    errors.extend(page.get("errors", []))
                    if page["nextOffset"] is None:
                        break
                    self.assertGreater(page["nextOffset"], offset)
                    offset = page["nextOffset"]
                    cursors.append(offset)
            self.assertTrue(cursors)
            if operation == "list":
                self.assertEqual([entry["path"] for entry in records], [first, last])
                self.assertEqual([entry["path"] for entry in errors], [str(invalid)])
            else:
                self.assertEqual([entry["path"] for entry in records], paths)
                self.assertTrue(records[1]["error"])

    def test_invalid_offsets_and_oversized_metadata_are_rejected(self):
        path = self.reference("valid")
        for offset in (-1, True, 2, 0.5):
            with self.assertRaisesRegex(ValueError, "Inspection offset"):
                handle_request({"operation": "inspect-many", "paths": [path], "offset": offset})
        oversized = self.reference("oversized", "x" * (1024 * 1024))
        with self.assertRaisesRegex(ValueError, "metadata exceeds"):
            inspect_file(oversized)
        invalid_name = self.root / "invalid-name.safetensors"
        member = {"_format_version": 4, "kind": "image", "name": "x" * 257}
        save_file({"ref_0": torch.zeros(1, 24, 1, 2, 2)}, str(invalid_name), metadata={
            "refmod_meta": json.dumps({"_format_version": 5, "kind": "bundle", "name": "Bundle", "members": [member]})})
        with self.assertRaisesRegex(ValueError, "member name"):
            inspect_file(str(invalid_name))
        output = self.root / "invalid-export.safetensors"
        with self.assertRaisesRegex(ValueError, "member name"):
            save_references([Reference(torch.zeros(1, 24, 1, 2, 2), member)], str(output), "Export")
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
