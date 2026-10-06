import json
import io
import base64
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch

import torch
from safetensors.torch import save_file

from media_refmods import Reference, handle_request, inspect_file, load_references, reference_map, save_references, weaken_reference
from media_refmod_creation import compress_visual
from media_refmod_preview import preview
from fizgig.minimax.model import MiniMaxH3Config, MiniMaxH3DiT, image_position_ids
from fizgig.minimax.sampling import sample_image
from media_refmod_conditioning import prepare_saved_references, reference_step_schedule, reference_video_decode_plan


class RefModTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def model_directory(self):
        models = self.root / "models"
        (models / "vae").mkdir(parents=True, exist_ok=True)
        save_file({"weight": torch.ones(2)}, str(models / "vae/minimax_h3_video_vae_fp16.safetensors"))
        return str(models)

    def standalone(self, name="hero", kind="image", shape=(1, 24, 1, 4, 4), **metadata):
        path = self.root / f"{name}.safetensors"
        latent = torch.arange(torch.tensor(shape).prod().item()).reshape(shape).float() / 100
        save_file({"latent": latent}, str(path), metadata={"refmod_meta": json.dumps({
            "_format_version": 4, "kind": kind, "name": name, **metadata})})
        return path, latent

    def test_standalone_and_bundle_roundtrip_preserve_independent_members(self):
        image_path, image = self.standalone(description="image attribution")
        audio_path, audio = self.standalone("voice", "audio", (1, 32, 2, 20), sample_rate=32000)
        refs, evidence = load_references([{"path": str(image_path)}, {"path": str(audio_path)}])
        destination = self.root / "combined.safetensors"
        info = save_references(refs, str(destination), "Character")
        loaded, bundle_evidence = load_references([{"path": str(destination)}])
        self.assertEqual(info["kind"], "bundle")
        self.assertEqual([member["frameCount"] for member in info["members"]], [1, 0])
        self.assertEqual(evidence["tokens"], 44)
        self.assertEqual(bundle_evidence["tokens"], 44)
        self.assertTrue(torch.equal(loaded[0].latent, image))
        self.assertTrue(torch.equal(loaded[1].latent, audio))
        self.assertEqual(loaded[0].metadata["description"], "image attribution")

    def test_selection_zero_strength_and_copies_count_actual_tokens(self):
        path, _ = self.standalone()
        refs, evidence = load_references([{"path": str(path), "copies": 3, "visualStrength": .4}], 12)
        self.assertEqual(len(refs), 3)
        self.assertEqual(evidence["tokens"], 12)
        self.assertEqual(refs[0].strength, .4)
        with self.assertRaisesRegex(ValueError, "tokens"):
            load_references([{"path": str(path), "copies": 4}], 12)
        with patch("safetensors.safe_open", side_effect=AssertionError("inactive files must not be opened")):
            self.assertEqual(load_references([{"path": "missing", "visualStrength": 0, "audioStrength": 0}])[0], [])
            self.assertEqual(load_references([{"path": "missing", "enabled": False}])[0], [])

    def test_invalid_headers_shapes_and_nonfinite_latents_fail_explicitly(self):
        path, _ = self.standalone(kind="image", shape=(1, 24, 2, 4, 4))
        with self.assertRaisesRegex(ValueError, "one frame"):
            inspect_file(str(path))
        path, _ = self.standalone("odd", shape=(1, 24, 1, 3, 4))
        with self.assertRaisesRegex(ValueError, "even"):
            inspect_file(str(path))
        path, _ = self.standalone("mismatch", latent_t=99)
        with self.assertRaisesRegex(ValueError, "disagrees"):
            load_references([{"path": str(path)}])
        path, _ = self.standalone("nonfinite")
        save_file({"latent": torch.full((1, 24, 1, 4, 4), float("nan"))}, str(path),
                  metadata={"refmod_meta": json.dumps({"kind": "image", "_format_version": 4})})
        with self.assertRaisesRegex(ValueError, "non-finite"):
            load_references([{"path": str(path)}])
        path, _ = self.standalone("invalid-description", description={"unsafe": "object"})
        with self.assertRaisesRegex(ValueError, "description must be text"):
            inspect_file(str(path))

    def test_atomic_export_does_not_overwrite_existing_file(self):
        path, _ = self.standalone()
        refs, _ = load_references([{"path": str(path)}])
        original = path.read_bytes()
        with self.assertRaisesRegex(ValueError, "already exists"):
            save_references(refs, str(path), "Copy")
        self.assertEqual(path.read_bytes(), original)
        destination = self.root / "interrupted.safetensors"
        with patch("safetensors.torch.save_file", side_effect=OSError("disk failure")):
            with self.assertRaisesRegex(OSError, "disk failure"):
                save_references(refs, str(destination), "Copy")
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob(".refmod-*")), [])

    def test_native_temporary_reservation_is_consumed_without_changing_other_files(self):
        path, _ = self.standalone()
        refs, _ = load_references([{"path": str(path)}])
        temporary = self.root / ".refmod-test-create.safetensors"
        temporary.touch()
        destination = self.root / "reserved.safetensors"
        original = path.read_bytes()
        saved = save_references(refs, str(destination), "Reserved", str(temporary))
        self.assertEqual(saved["tokens"], 4)
        self.assertFalse(temporary.exists())
        self.assertEqual(path.read_bytes(), original)

    def test_invalid_exports_never_publish_a_destination(self):
        destination = self.root / "invalid.safetensors"
        cases = [
            Reference(torch.zeros(1, 24, 1, 4, 4, dtype=torch.int32), {"kind": "image"}),
            Reference(torch.zeros(1, 24, 1, 4, 4), {"kind": "image", "description": {"invalid": True}}),
            Reference(torch.zeros(1, 24, 1, 4, 4), {"kind": "image", "description": "x" * 1000}),
        ]
        for reference in cases:
            with patch("media_refmods.MAX_METADATA_BYTES", 512):
                with self.assertRaises(ValueError):
                    save_references([reference], str(destination), "Invalid")
            self.assertFalse(destination.exists())
            self.assertEqual(list(self.root.glob(".refmod-*")), [])
        reference = Reference(torch.zeros(1, 24, 1, 4, 4), {"kind": "image"})
        with patch("media_refmods.MAX_FILE_BYTES", 1500), patch("media_refmods.MAX_METADATA_BYTES", 64):
            with self.assertRaisesRegex(ValueError, "file limit"):
                save_references([reference], str(destination), "Too large")
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob(".refmod-*")), [])
        with patch("media_refmods.MAX_FILE_BYTES", 4096), patch("media_refmods.MAX_METADATA_BYTES", 512), patch(
            "safetensors.torch.save_file", side_effect=lambda tensors, path, metadata: Path(path).write_bytes(b"x" * 4097)
        ):
            with self.assertRaisesRegex(ValueError, "file limit"):
                save_references([reference], str(destination), "Too large")
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob(".refmod-*")), [])

    def test_library_reports_invalid_files_and_export_survives_restart(self):
        path, _ = self.standalone()
        path = path.rename(path.with_suffix(".SAFETENSORS"))
        invalid = self.root / "wrong.safetensors"
        save_file({"weights": torch.zeros(1)}, str(invalid))
        listed = handle_request({"operation": "list", "directory": str(self.root)})
        self.assertEqual(len(listed["records"]), 1)
        self.assertEqual(len(listed["errors"]), 1)
        copied = handle_request({"operation": "save", "slots": [{"path": str(path)}],
                                 "outputPath": str(self.root / "export.safetensors"), "name": "Export"})
        self.assertEqual(handle_request({"operation": "inspect", "path": copied["path"]})["tokens"], 4)

    def test_batch_inspection_keeps_valid_records_alongside_file_errors(self):
        path, _ = self.standalone()
        invalid = self.root / "invalid.safetensors"
        invalid.write_bytes(b"invalid")
        page = handle_request({"operation": "inspect-many", "paths": [str(path), str(invalid), "missing"]})
        self.assertIsNone(page["nextOffset"])
        results = page["records"]
        self.assertEqual([result["path"] for result in results], [str(path), str(invalid), "missing"])
        self.assertEqual(results[0]["record"]["tokens"], 4)
        self.assertTrue(results[1]["error"])
        self.assertIn("existing absolute", results[2]["error"])
        with self.assertRaisesRegex(ValueError, "1–256"):
            handle_request({"operation": "inspect-many", "paths": [str(path)] * 257})

    def test_strength_and_compression_preserve_shape_and_do_not_mutate_source(self):
        _, latent = self.standalone(shape=(1, 24, 1, 8, 8))
        original = latent.clone()
        reference = Reference(latent, {"kind": "image"}, strength=.5)
        weakened = weaken_reference(reference)
        self.assertEqual(weakened.shape, latent.shape)
        self.assertTrue(torch.equal(latent, original))
        self.assertFalse(torch.equal(weakened, latent))
        pooled = compress_visual(latent, 4, 0)
        refined = compress_visual(latent, 4, 3)
        self.assertEqual(tuple(refined.shape), (1, 24, 1, 4, 4))
        restored_pool = torch.nn.functional.interpolate(pooled, size=latent.shape[2:], mode="trilinear", align_corners=False)
        restored_refined = torch.nn.functional.interpolate(refined, size=latent.shape[2:], mode="trilinear", align_corners=False)
        self.assertLessEqual((restored_refined - latent).square().mean(), (restored_pool - latent).square().mean())

    def test_temporal_compression_roundtrips_and_presents_three_frame_video(self):
        latent = torch.randn(1, 24, 7, 8, 8)
        compressed = compress_visual(latent, 4, 2, 3)
        self.assertEqual(tuple(compressed.shape), (1, 24, 3, 4, 4))
        destination = self.root / "compressed.safetensors"
        save_references([Reference(compressed, {"kind": "video"})], str(destination), "Compressed")
        self.assertEqual(inspect_file(str(destination))["members"][0]["frameCount"], 9)
        references, evidence = load_references([{"path": str(destination), "copies": 2}])
        self.assertEqual(evidence["tokens"], 24)
        decoder = Mock()
        decoder.decode_middle_frame.return_value = torch.zeros(1, 3, 64, 64)
        with patch("torch.autocast", side_effect=lambda *args, **kwargs: nullcontext()), patch.object(
            torch.Tensor, "to", lambda tensor, *args, **kwargs: tensor
        ):
            items, latents = prepare_saved_references(references, decoder)
        self.assertEqual(decoder.decode_middle_frame.call_count, 2)
        self.assertEqual([call.args[1] for call in decoder.decode_middle_frame.call_args_list], [0, 8])
        self.assertTrue(all(call.args[0].shape[2] == 7 for call in decoder.decode_middle_frame.call_args_list))
        self.assertEqual(items[0]["type"], "video")
        self.assertEqual(items[0]["timestamps"], [0, 8 / 24])
        self.assertIs(items[0], items[1])
        self.assertTrue(torch.equal(latents[0], compressed))
        self.assertEqual(latents[0].shape[2], 3)

    def test_preview_rejects_invalid_frames_before_loading_models(self):
        path, _ = self.standalone("motion", "video", (1, 24, 3, 4, 4))
        with patch("torch.cuda.is_available", side_effect=AssertionError("frame validation must run first")):
            for index in (-1, 9, True, 0.5):
                with self.subTest(index=index), self.assertRaisesRegex(ValueError, "Preview frame"):
                    preview({"path": str(path), "frameIndex": index})
            image, _ = self.standalone("still")
            audio, _ = self.standalone("sound", "audio", (1, 32, 2, 20))
            for path in (image, audio):
                with self.subTest(path=path), self.assertRaisesRegex(ValueError, "Preview frame"):
                    preview({"path": str(path), "frameIndex": 1})

    def test_video_preview_decodes_last_logical_frame_for_both_strengths(self):
        path, latent = self.standalone("motion", "video", (1, 24, 3, 4, 4))
        decoder = Mock()
        decoder.decode_middle_frame.return_value = torch.zeros(1, 3, 16, 16)
        with patch("torch.cuda.is_available", return_value=True), patch(
            "fizgig.minimax.video_vae_checkpoint.load_video_vae", return_value=decoder
        ), patch("torch.autocast", side_effect=lambda *args, **kwargs: nullcontext()), patch.object(
            torch.Tensor, "to", lambda tensor, *args, **kwargs: tensor
        ), patch("torch.cuda.empty_cache"):
            result = preview({"path": str(path), "modelPath": self.model_directory(), "frameIndex": 8,
                              "compare": True, "strength": .5})
        self.assertEqual(result["kind"], "video")
        self.assertEqual(len(result["previews"]), 2)
        self.assertEqual([call.args[1] for call in decoder.decode_middle_frame.call_args_list], [8, 8])
        self.assertTrue(all(call.args[0].shape[2] == 7 for call in decoder.decode_middle_frame.call_args_list))
        self.assertTrue(torch.equal(decoder.decode_middle_frame.call_args_list[0].args[0][:, :, :3], latent))
        for image in result["previews"]:
            self.assertTrue(base64.b64decode(image.split(",", 1)[1]).startswith(b"\x89PNG\r\n\x1a\n"))

    def test_reference_decode_plan_preserves_native_clock_and_original_latents(self):
        for length, frames, padded in ((1, 1, 1), (2, 5, 2), (3, 9, 7), (4, 13, 7),
                                       (5, 17, 7), (6, 18, 7), (7, 22, 7), (8, 26, 12),
                                       (12, 39, 12), (107, 362, 107)):
            latent = torch.arange(length).reshape(1, 1, length, 1, 1).expand(1, 24, length, 2, 2).float()
            original = latent.clone()
            presentation, frame_count = reference_video_decode_plan(latent)
            self.assertEqual(frame_count, frames)
            self.assertEqual(presentation.shape[2], padded)
            self.assertTrue(torch.equal(presentation[:, :, :length], original))
            self.assertTrue(torch.equal(latent, original))
            if padded > length:
                self.assertTrue(torch.equal(presentation[:, :, -1:], original[:, :, -1:]))

    def test_numbered_labels_follow_actual_image_video_audio_order(self):
        refs = [Reference(torch.zeros(1, 32, 2, 3), {"kind": "audio", "name": "voice"}),
                Reference(torch.zeros(1, 24, 2, 4, 4), {"kind": "video", "name": "motion"}),
                Reference(torch.zeros(1, 24, 1, 4, 4), {"kind": "image", "name": "look"})]
        self.assertEqual([record["label"] for record in reference_map(refs, image_count=1)],
                         ["<Video 1>", "<Picture 2>", "<Audio 1>"])

    def test_curves_change_only_saved_conditioning_and_do_not_keep_other_runs(self):
        latent = torch.randn(1, 24, 3, 4, 4)
        original = latent.clone()
        reference = Reference(latent, {"kind": "video"}, step_curve="increase", frame_curve="decrease")
        prefix = [torch.randn(1, 24, 1, 4, 4)]
        schedule = reference_step_schedule([reference], prefix)
        prefix.append(latent)
        start, end = schedule(0, 3, 1), schedule(2, 3, 0)
        self.assertEqual(len(start), 2)
        self.assertIs(start[0], prefix[0])
        self.assertFalse(torch.equal(start[1], end[1]))
        self.assertTrue(torch.equal(end[1][:, :, 0], latent[:, :, 0]))
        self.assertTrue(torch.equal(original, latent))
        self.assertIsNone(reference_step_schedule([], []))

    def test_import_remains_usable_after_source_is_removed(self):
        path, original = self.standalone(description="credit the source")
        imported = handle_request({"operation": "import", "path": str(path), "libraryDirectory": str(self.root / "library")})
        path.unlink()
        refs, _ = load_references([{"path": imported["path"]}])
        self.assertTrue(torch.equal(refs[0].latent, original))
        self.assertEqual(refs[0].metadata["description"], "credit the source")

    def test_export_selected_modalities_and_copies_preserves_selection(self):
        image, _ = self.standalone()
        audio, _ = self.standalone("voice", "audio", (1, 32, 2, 20))
        combined = handle_request({"operation": "save", "slots": [{"path": str(image)}, {"path": str(audio)}], "outputPath": str(self.root / "all.safetensors"), "name": "All"})
        copied = handle_request({"operation": "save", "slots": [{"path": combined["path"], "selection": "audio", "copies": 2}], "outputPath": str(self.root / "selected.safetensors"), "name": "Selected"})
        self.assertEqual([member["kind"] for member in copied["members"]], ["audio", "audio"])
        self.assertEqual(copied["tokens"], 80)

    def test_create_checks_destination_before_loading_models(self):
        from media_refmod_creation import create

        path, _ = self.standalone()
        with patch("fizgig.minimax.video_vae_checkpoint.load_video_vae", side_effect=AssertionError("must validate before model load")):
            with self.assertRaisesRegex(ValueError, "already exists"):
                create({"outputPath": str(path), "name": "Existing", "sources": []})

    def test_create_stops_accumulation_without_publishing_partial_output(self):
        from PIL import Image
        from media_refmod_creation import create

        source = self.root / "source.png"
        Image.new("RGB", (32, 32), "white").save(source)
        destination = self.root / "oversized.safetensors"
        encoder = Mock()
        encoder.encode.return_value = torch.zeros(1, 24, 1, 2, 2)
        with patch("fizgig.minimax.video_vae_checkpoint.load_video_vae", return_value=encoder), patch(
            "torch.cuda.is_available", return_value=True
        ), patch("torch.cuda.empty_cache"), patch("torch.autocast", side_effect=lambda *args, **kwargs: nullcontext()), patch.object(
            torch.Tensor, "to", lambda tensor, *args, **kwargs: tensor
        ), patch("media_refmod_creation.MAX_FILE_BYTES", 900), patch("media_refmod_creation.MAX_METADATA_BYTES", 32):
            with self.assertRaisesRegex(ValueError, "Created reference tensors"):
                create({"sources": [{"path": str(source), "kind": "image"}] * 4,
                        "outputPath": str(destination), "name": "Oversized", "modelPath": self.model_directory(),
                        "width": 32, "height": 32, "maxTokens": 0})
        self.assertEqual(encoder.encode.call_count, 3)
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob(".refmod-*")), [])

    def test_worker_command_returns_current_json_schema_and_explicit_errors(self):
        import media_diffusers_worker as worker

        path, _ = self.standalone()
        for requested_path, expected_status in ((str(path), 0), ("missing", 3)):
            output = io.StringIO()
            with patch.object(sys, "argv", ["worker", "refmod"]), patch.object(sys, "stdin", io.StringIO(json.dumps({"operation": "inspect", "path": requested_path}))), patch.object(sys, "stdout", output), patch.object(sys, "stderr", io.StringIO()):
                self.assertEqual(worker.main(), expected_status)
            response = json.loads(output.getvalue())
            self.assertEqual(response["schemaVersion"], 5)
            if expected_status == 0:
                self.assertEqual(response["result"]["tokens"], 4)
            else:
                self.assertIn("existing absolute", response["error"])


class NativeReferenceTests(unittest.TestCase):
    def test_audio_position_grid_uses_target_stereo_axis_and_shifts_target_clock(self):
        baseline = image_position_ids(3, 4, 4, num_audio_latents=2)
        positions = image_position_ids(3, 4, 4, num_audio_latents=2, refs=[(4, 4, 1), ("audio", 5)])
        self.assertEqual(positions.shape[0], baseline.shape[0] + 14)
        self.assertEqual(positions[7:12, 0].tolist(), [4, 5, 6, 7, 8])
        self.assertEqual(positions[12:17, 0].tolist(), [4, 5, 6, 7, 8])
        self.assertTrue(torch.equal(positions[17:, 0], baseline[3:, 0] + 6))
        self.assertEqual(positions[7, 2], baseline[3, 2])
        self.assertEqual(positions[12, 2], baseline[5, 2])

    def test_tiny_dit_samples_visual_and_audio_refs_without_denoising_them(self):
        torch.manual_seed(7)
        model = MiniMaxH3DiT(MiniMaxH3Config(hidden_size=48, num_layers=1, token_refiner_num_layers=1,
                                           num_attention_heads=3, attention_head_dim=16, ffn_hidden_size=64,
                                           text_dim=24, timestep_input_dim=16, time_embed_hidden_size=32,
                                           time_embed_dim=24, rope_inv_freq_len=2)).eval()
        model.pack_audio_rows = True
        visual = torch.randn(1, 24, 2, 4, 4)
        audio = torch.randn(1, 32, 2, 5)
        original_visual, original_audio = visual.clone(), audio.clone()
        result, soundtrack = sample_image(model, torch.randn(1, 3, 24), width=64, height=64,
                                          num_frames=22,
                                          steps=2, sampler="euler", device="cpu", dtype=torch.float32,
                                          ref_latents=[visual, audio], return_audio=True)
        self.assertEqual(tuple(result.shape), (1, 24, 7, 4, 4))
        self.assertEqual(soundtrack.shape[-1], 32)
        self.assertTrue(torch.isfinite(result).all())
        self.assertTrue(torch.equal(visual, original_visual))
        self.assertTrue(torch.equal(audio, original_audio))


if __name__ == "__main__":
    unittest.main()
