import tempfile
import subprocess
import sys
import json
from pathlib import Path
import unittest

import numpy as np
from PIL import Image

import media_workflow_worker as worker
import media_diffusers_worker as generation
from media_visual_check import parse_visual_result, reconcile_reviews, review_messages


class WorkflowWorkerTests(unittest.TestCase):
    def test_visual_reviews_require_unanimous_verdicts_per_criterion(self):
        from itertools import product

        criteria = ["The dress is blue", "The face is unchanged"]
        for passes in range(1, 4):
            for verdicts in product(["pass", "fail", "unknown"], repeat=passes):
                reviews = [{"checks": [{"criterion": criterion, "verdict": verdict, "reason": "Visible evidence"} for criterion in criteria]} for verdict in verdicts]
                result = reconcile_reviews(reviews, criteria)
                expected = verdicts[0] if len(set(verdicts)) == 1 else "unknown"
                self.assertEqual([check["verdict"] for check in result], [expected, expected])
                if len(set(verdicts)) > 1:
                    self.assertIn("disagree", result[0]["reason"])

    def test_visual_parser_rejects_duplicate_fields_and_boolean_criterion_ids(self):
        for response in [
            '{"checks":[{"criterion":1,"reason":"Red dress","verdict":"fail","verdict":"pass"}]}',
            '{"checks":[],"checks":[{"criterion":1,"reason":"Blue dress","verdict":"pass"}]}',
            '{"checks":[{"criterion":true,"reason":"Blue dress","verdict":"pass"}]}',
            '{"checks":[{"criterion":1,"reason":"Blue dress","verdict":"pass","confidence":1}]}',
        ]:
            self.assertEqual(parse_visual_result(response, ["Blue dress"])[0]["verdict"], "unknown")

    def test_reviews_keep_image_labels_with_their_pixels_when_reordering(self):
        source = Image.new("RGB", (8, 8), "blue")
        reference = Image.new("RGB", (8, 8), "red")
        for index in range(3):
            content = review_messages(source, reference, ["Blue dress"], index)[1]["content"]
            result_index = 2 if index % 2 else 0
            self.assertTrue(content[result_index]["text"].startswith("RESULT"))
            self.assertEqual(content[result_index + 1]["image"].getpixel((0, 0)), (0, 0, 255))
            self.assertTrue(content[2 - result_index]["text"].startswith("REFERENCE"))
        self.assertNotEqual(review_messages(source, None, ["Blue dress"], 0)[1]["content"][-1], review_messages(source, None, ["Blue dress"], 1)[1]["content"][-1])

    def test_boundary_selection_preserves_the_subject_interior_and_distant_background(self):
        pixels = np.zeros((64, 64), dtype=np.uint8)
        pixels[16:48, 16:48] = 255
        for selection in [pixels, 255 - pixels]:
            boundary = worker.refine_mask(Image.fromarray(selection), 0, 0, "boundary", 2)
            actual = np.asarray(boundary)
            self.assertEqual(np.count_nonzero(actual), 36 * 36 - 28 * 28)
            self.assertEqual(actual[32, 32], 0)
            self.assertEqual(actual[0, 0], 0)
            self.assertEqual(actual[16, 32], 255)
            context = generation._masked_generation_context(Image.new("RGB", (64, 64), "red"), None, 64, 64, 16, boundary)
            edited = np.asarray(generation._composite_masked_result(context, Image.new("RGB", (64, 64), "blue")))
            np.testing.assert_array_equal(edited[actual == 0], np.broadcast_to([255, 0, 0], edited[actual == 0].shape))
        for width in [0, 65, 1.5, True]:
            with self.assertRaisesRegex(ValueError, "radius"):
                worker.refine_mask(Image.fromarray(pixels), 0, 0, "boundary", width)
        with self.assertRaisesRegex(ValueError, "empty"):
            worker.refine_mask(Image.new("L", (32, 32), 255), 0, 0, "boundary", 2)

    def test_inverting_a_connected_selection_precedes_growth(self):
        mask = np.zeros((32, 32), dtype=np.uint8)
        mask[8:24, 8:24] = 255
        actual = worker.refine_mask(Image.fromarray(mask), 2, 0, "surroundings")
        expected = worker.refine_mask(Image.fromarray(255 - mask), 2, 0)
        np.testing.assert_array_equal(np.asarray(actual), np.asarray(expected))
        self.assertEqual(np.count_nonzero(np.asarray(actual) == 0), 12 * 12)

    def test_isolated_desktop_worker_loads_its_bundled_mask_module(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "source.png"
            Image.new("RGB", (32, 32), "red").save(source)
            request = {"imagePath": str(source), "outputDirectory": folder, "grow": 1, "feather": 1, "editMask": {"schemaVersion": 2, "sourceAssetId": "source", "inverted": False, "strokes": [{"mode": "paint", "size": 0.25, "opacity": 1, "softness": 0, "points": [{"x": 0.5, "y": 0.5}]}]}}
            result = subprocess.run([sys.executable, "-I", "-B", str(Path(worker.__file__).resolve()), "prepare-mask"], input=json.dumps(request), capture_output=True, text=True, timeout=60, cwd=folder)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertGreater(json.loads(result.stdout)["selectedPixels"], 0)
            self.assertTrue((Path(folder) / "output.png").is_file())

    def test_visual_check_never_accepts_missing_or_malformed_criteria(self):
        criteria = ["Dress is blue", "Person is unchanged"]
        for response in ["not JSON", "null", "[]", '{"checks":[]}', '{"checks":[{"criterion":1,"verdict":"pass","reason":"Blue"}]}', '{"checks":[{"criterion":1,"verdict":"pass","reason":"Blue"},{"criterion":1,"verdict":"pass","reason":"Same"}]}']:
            self.assertTrue(all(check["verdict"] == "unknown" for check in parse_visual_result(response, criteria)))
        result = parse_visual_result('{"checks":[{"criterion":1,"verdict":"fail","reason":"Red dress"},{"criterion":2,"verdict":"unknown","reason":"Face is obscured"}]}', criteria)
        self.assertEqual([check["verdict"] for check in result], ["fail", "unknown"])
        self.assertEqual([check["criterion"] for check in result], criteria)

    def test_visual_check_accepts_one_complete_json_block_without_repairing_its_contents(self):
        criteria = ["The dress is blue"]
        body = '{"checks":[{"criterion":1,"reason":"The dress is blue.","verdict":"pass"}]}'
        wrapped = "```json\n" + body + "\n```"
        self.assertEqual(parse_visual_result(wrapped, criteria), parse_visual_result(body, criteria))
        for response in ["Explanation\n" + wrapped, wrapped + "\nExtra answer", wrapped[:-3], "```json\n" + body[:-1] + "\n```", "```json\n{\"checks\": []}\n```"]:
            self.assertEqual(parse_visual_result(response, criteria)[0]["verdict"], "unknown")

    def test_mask_refinement_changes_only_a_bounded_boundary(self):
        pixels = np.zeros((64, 64), dtype=np.uint8)
        pixels[16:48, 16:48] = 255
        mask = Image.fromarray(pixels)
        grown = np.asarray(worker.refine_mask(mask, 2, 0))
        shrunk = np.asarray(worker.refine_mask(mask, -2, 0))
        self.assertEqual(np.count_nonzero(grown), 36 * 36)
        self.assertEqual(np.count_nonzero(shrunk), 28 * 28)
        feathered = np.asarray(worker.refine_mask(mask, 2, 1))
        self.assertTrue(np.any((feathered > 0) & (feathered < 255)))
        self.assertEqual(feathered[32, 32], 255)
        self.assertEqual(feathered[0, 0], 0)
        with self.assertRaisesRegex(ValueError, "empty"):
            worker.refine_mask(mask, -32, 0)

    def test_selection_unions_matches_and_inverts_only_the_surroundings(self):
        masks = np.zeros((2, 12, 16), dtype=bool)
        masks[0, 2:5, 2:6] = True
        masks[1, 7:11, 8:14] = True
        scores = np.array([0.9, 0.6])
        for choice, expected in [("all", masks.any(axis=0)), ("best", masks[0]), ("largest", masks[1])]:
            selected = np.asarray(worker.select_mask(masks, scores, choice, False, 0, 0)) > 0
            np.testing.assert_array_equal(selected, expected)
            surrounding = np.asarray(worker.select_mask(masks, scores, choice, True, 0, 0)) > 0
            np.testing.assert_array_equal(surrounding, ~expected)

    def test_no_detections_and_empty_surroundings_fail_explicitly(self):
        with self.assertRaisesRegex(ValueError, "No objects matched"):
            worker.select_mask([], [], "all", False, 0, 0)
        with self.assertRaisesRegex(ValueError, "surrounding area is empty"):
            worker.select_mask(np.ones((1, 8, 8)), [0.9], "all", True, 0, 0)

    def test_connected_masks_preserve_every_unselected_pixel_and_dimensions(self):
        rng = np.random.default_rng(8)
        pixels = rng.integers(0, 255, (231, 413, 3), dtype=np.uint8)
        masks = np.zeros((1, 231, 413), dtype=bool)
        masks[0, 80:160, 140:240] = True
        for inverted in [False, True]:
            mask = worker.select_mask(masks, [0.9], "all", inverted, 0, 0)
            context = generation._masked_generation_context(Image.fromarray(pixels), None, 256, 256, 16, mask)
            edited = generation._composite_masked_result(context, Image.new("RGB", (context["width"], context["height"]), "blue"))
            self.assertEqual(edited.size, (413, 231))
            untouched = np.asarray(mask) == 0
            np.testing.assert_array_equal(np.asarray(edited)[untouched], pixels[untouched])
            self.assertTrue(np.any(np.asarray(edited)[~untouched] != pixels[~untouched]))

    def test_upscale_tiles_cover_odd_dimensions_without_seams(self):
        import torch

        class Upscaler:
            scale = 2

            def __call__(self, image):
                return torch.nn.functional.interpolate(image, scale_factor=2, mode="nearest")

        pixels = np.random.default_rng(17).integers(0, 255, (91, 139, 3), dtype=np.uint8)
        actual = worker.tiled_upscale(Image.fromarray(pixels), Upscaler(), torch, "cpu", 64)
        expected = np.repeat(np.repeat(pixels, 2, axis=0), 2, axis=1)
        np.testing.assert_array_equal(np.asarray(actual), expected)

    def test_loading_preserves_alpha(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "source.png"
            source = Image.new("RGBA", (7, 9), (120, 30, 20, 74))
            source.save(path)
            self.assertEqual(worker.load_image(str(path)).getpixel((3, 4)), (120, 30, 20, 74))


if __name__ == "__main__":
    unittest.main()
