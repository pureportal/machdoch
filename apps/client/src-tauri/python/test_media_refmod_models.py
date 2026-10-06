import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from PIL import Image
from safetensors.torch import save_file

from media_refmod_models import vae_path
from media_refmod_creation import create
from media_refmod_preview import preview


class RefModModelTests(unittest.TestCase):
    def test_each_modality_reports_its_missing_vae_and_accepts_its_own_component(self):
        with tempfile.TemporaryDirectory() as temporary:
            models = Path(temporary)
            (models / "vae").mkdir()
            for kind, modality, precision in (("audio", "audio", "fp32"), ("video", "video", "fp16")):
                with self.assertRaisesRegex(ValueError, f"Install the MiniMax H3 {modality} VAE"):
                    vae_path(models, kind)
                path = models / "vae" / f"minimax_h3_{modality}_vae_{precision}.safetensors"
                save_file({"weight": torch.ones(2)}, str(path))
                self.assertEqual(vae_path(models, kind), path)
            self.assertEqual(vae_path(models, "image"), vae_path(models, "video"))

    def test_missing_visual_vae_fails_before_model_initialization_in_an_audio_only_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "vae").mkdir()
            (root / "vae/minimax_h3_audio_vae_fp32.safetensors").write_bytes(b"Audio fixture")
            reference = root / "video.safetensors"
            save_file({"latent": torch.zeros(1, 24, 3, 2, 2)}, str(reference), metadata={
                "refmod_meta": json.dumps({"_format_version": 4, "kind": "video"})})
            source = root / "source.png"
            Image.new("RGB", (32, 32)).save(source)
            output = root / "created.safetensors"
            with patch("torch.cuda.is_available", return_value=True), patch(
                "fizgig.minimax.video_vae_checkpoint.load_video_vae", side_effect=AssertionError("Model must not initialize")
            ) as loader:
                with self.assertRaisesRegex(ValueError, "Install the MiniMax H3 video VAE"):
                    preview({"path": str(reference), "modelPath": str(root)})
                with self.assertRaisesRegex(ValueError, "Install the MiniMax H3 video VAE"):
                    create({"outputPath": str(output), "name": "Visual", "modelPath": str(root),
                            "sources": [{"path": str(source), "kind": "image"}]})
                loader.assert_not_called()
            self.assertFalse(output.exists())

    def test_missing_audio_vae_fails_before_visual_work_for_mixed_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "vae").mkdir()
            save_file({"weight": torch.ones(2)}, str(root / "vae/minimax_h3_video_vae_fp16.safetensors"))
            image = root / "image.png"
            Image.new("RGB", (32, 32)).save(image)
            audio = root / "audio.wav"
            audio.write_bytes(b"Audio fixture")
            output = root / "mixed.safetensors"
            with patch("torch.cuda.is_available", return_value=True), patch(
                "fizgig.minimax.video_vae_checkpoint.load_video_vae", side_effect=AssertionError("Visual work must not start")
            ) as loader:
                with self.assertRaisesRegex(ValueError, "Install the MiniMax H3 audio VAE"):
                    create({"outputPath": str(output), "name": "Mixed", "modelPath": str(root),
                            "sources": [{"path": str(image), "kind": "image"}, {"path": str(audio), "kind": "audio"}]})
                loader.assert_not_called()
            self.assertFalse(output.exists())

    def test_invalid_empty_and_truncated_checkpoints_report_the_modality_and_replacement(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "vae").mkdir()
            for kind, precision in (("video", "fp16"), ("audio", "fp32")):
                path = root / "vae" / f"minimax_h3_{kind}_vae_{precision}.safetensors"
                with self.subTest(kind=kind, damage="header"):
                    path.write_bytes(b"Broken checkpoint")
                    with self.assertRaisesRegex(ValueError, f"MiniMax H3 {kind} VAE is incomplete or damaged.*Replace"):
                        vae_path(root, kind)
                with self.subTest(kind=kind, damage="empty"):
                    save_file({}, str(path))
                    with self.assertRaisesRegex(ValueError, f"MiniMax H3 {kind} VAE is incomplete or damaged.*Replace"):
                        vae_path(root, kind)
                with self.subTest(kind=kind, damage="truncated"):
                    save_file({"weight": torch.ones(16)}, str(path))
                    with path.open("r+b") as checkpoint:
                        checkpoint.truncate(path.stat().st_size - 4)
                    with self.assertRaisesRegex(ValueError, f"MiniMax H3 {kind} VAE is incomplete or damaged.*Replace"):
                        vae_path(root, kind)

    def test_damaged_audio_vae_fails_before_either_model_loads_in_mixed_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "vae").mkdir()
            save_file({"weight": torch.ones(2)}, str(root / "vae/minimax_h3_video_vae_fp16.safetensors"))
            (root / "vae/minimax_h3_audio_vae_fp32.safetensors").write_bytes(b"Broken checkpoint")
            image = root / "image.png"
            Image.new("RGB", (32, 32)).save(image)
            audio = root / "audio.wav"
            audio.write_bytes(b"Audio fixture")
            output = root / "mixed.safetensors"
            with patch("torch.cuda.is_available", return_value=True), patch(
                "fizgig.minimax.video_vae_checkpoint.load_video_vae"
            ) as video_loader, patch("fizgig.minimax.audio_vae.load_audio_vae") as audio_loader:
                with self.assertRaisesRegex(ValueError, "MiniMax H3 audio VAE is incomplete or damaged"):
                    create({"outputPath": str(output), "name": "Mixed", "modelPath": str(root),
                            "sources": [{"path": str(image), "kind": "image"}, {"path": str(audio), "kind": "audio"}]})
                video_loader.assert_not_called()
                audio_loader.assert_not_called()
            self.assertFalse(output.exists())

    def test_damaged_checkpoints_fail_before_preview_decoder_initialization(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "vae").mkdir()
            for kind, precision, shape, target in (
                ("image", "fp16", (1, 24, 1, 2, 2), "fizgig.minimax.video_vae_checkpoint.load_video_vae"),
                ("audio", "fp32", (1, 32, 2, 20), "fizgig.minimax.audio_vae.load_audio_vae"),
            ):
                modality = "video" if kind == "image" else "audio"
                (root / "vae" / f"minimax_h3_{modality}_vae_{precision}.safetensors").write_bytes(b"Broken checkpoint")
                reference = root / f"{kind}.safetensors"
                save_file({"latent": torch.zeros(shape)}, str(reference), metadata={
                    "refmod_meta": json.dumps({"_format_version": 4, "kind": kind})})
                with self.subTest(kind=kind), patch("torch.cuda.is_available", return_value=True), patch(target) as loader:
                    with self.assertRaisesRegex(ValueError, f"MiniMax H3 {modality} VAE is incomplete or damaged"):
                        preview({"path": str(reference), "modelPath": str(root)})
                    loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
