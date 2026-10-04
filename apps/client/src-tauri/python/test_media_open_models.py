from __future__ import annotations

from contextlib import nullcontext
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import imageio_ffmpeg
import numpy as np
from PIL import Image

import media_diffusers_worker as worker
import media_open_models as models
import media_open_video as video


class OpenMediaModelTests(unittest.TestCase):
    def test_catalog_model_ids_and_architectures_are_unique(self):
        profiles = json.loads(Path(__file__).with_name("open_media_models.json").read_text(encoding="utf-8"))
        for field in ("id", "architecture"):
            values = [profile[field] for profile in profiles]
            self.assertEqual(len(values), len(set(values)), field)

    def test_qwen_edit_preserves_multiple_references_and_true_cfg(self):
        images = [object(), object(), object()]
        arguments = models.image_arguments("qwen-image-edit-2511", {}, images, "")
        self.assertEqual(arguments["image"], images)
        self.assertEqual(arguments["true_cfg_scale"], 4)
        self.assertEqual(arguments["negative_prompt"], " ")
        with self.assertRaisesRegex(ValueError, "reference image"):
            models.image_arguments("qwen-image-edit-2511", {}, [], "")
        with self.assertRaisesRegex(ValueError, "at most 3"):
            models.image_arguments("qwen-image-edit-2511", {}, images + [object()], "")

    def test_raw_krea_accepts_sampling_and_rejects_reference_images(self):
        models.validate_sampling("krea-2-raw", 28, 4.5)
        with self.assertRaisesRegex(ValueError, "does not accept"):
            models.image_arguments("krea-2-raw", {}, [object()], "")

    def test_distilled_and_base_flux_use_distinct_offline_load_options(self):
        for architecture, distilled in [("flux-2-klein-base-4b", False), ("flux-2-klein-9b", True)]:
            with self.subTest(architecture=architecture), tempfile.TemporaryDirectory() as directory:
                Path(directory, "model_index.json").write_text(json.dumps({"_class_name": "Flux2KleinPipeline"}), encoding="utf-8")
                loader = mock.Mock(return_value=SimpleNamespace())
                diffusers = SimpleNamespace(Flux2KleinPipeline=SimpleNamespace(from_pretrained=loader))
                models.load_pipeline(diffusers, {"architecture": architecture, "path": directory, "packageKind": "diffusers-directory"}, "bf16")
                self.assertEqual(loader.call_args.kwargs, {"torch_dtype": "bf16", "local_files_only": True, "use_safetensors": True, "trust_remote_code": False, "is_distilled": distilled})

    def test_wrong_pipeline_folder_is_rejected_before_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "model_index.json").write_text('{"_class_name":"WanPipeline"}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "does not match"):
                models.load_pipeline(SimpleNamespace(), {"architecture": "z-image-turbo", "path": directory, "packageKind": "diffusers-directory"}, "bf16")

    def test_audio_uses_the_current_gpt2_generation_component_without_changing_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "model_index.json").write_text('{"_class_name":"AudioLDM2Pipeline"}', encoding="utf-8")
            language_model = mock.Mock()
            constructor = mock.Mock(return_value=language_model)
            loader = mock.Mock(return_value=SimpleNamespace())
            diffusers = SimpleNamespace(AudioLDM2Pipeline=SimpleNamespace(from_pretrained=loader))
            with mock.patch.dict("sys.modules", {"transformers": SimpleNamespace(GPT2LMHeadModel=SimpleNamespace(from_pretrained=constructor))}):
                models.load_pipeline(diffusers, {"architecture": "audioldm-2", "path": directory, "packageKind": "diffusers-directory"}, "fp16")
            self.assertEqual(constructor.call_args.args, (str(Path(directory) / "language_model"),))
            self.assertTrue(constructor.call_args.kwargs["local_files_only"])
            self.assertIs(loader.call_args.kwargs["language_model"], language_model)

    def test_fixed_sampling_is_enforced_and_base_sampling_is_adjustable(self):
        models.validate_sampling("flux-2-klein-base-4b", 35, 3.5)
        models.validate_sampling("z-image-turbo", 9, 0)
        with self.assertRaisesRegex(ValueError, "9 sampling"):
            models.validate_sampling("z-image-turbo", 4, 0)
        with self.assertRaisesRegex(ValueError, "guidance"):
            models.validate_sampling("flux-2-klein-9b", 4, 4)

    def test_video_modes_do_not_create_synthetic_image_conditions(self):
        profile = models.PROFILES["wan-2.2-t2v-a14b"]
        request = {"numFrames": 5, "numInferenceSteps": 40, "guidanceScale": 4, "prompt": "A bird flies", "fps": 16}
        arguments = models.video_arguments(profile, request, None, None, 512, 288, "generator")
        self.assertNotIn("image", arguments)
        self.assertNotIn("last_image", arguments)
        self.assertEqual(arguments["prompt"], request["prompt"])
        with self.assertRaisesRegex(ValueError, "from a prompt"):
            models.video_arguments(profile, request, object(), None, 512, 288, "generator")

    def test_wan_i2v_preserves_both_endpoints(self):
        profile = models.PROFILES["wan-2.2-i2v-a14b"]
        first, last = object(), object()
        request = {"numFrames": 5, "numInferenceSteps": 40, "guidanceScale": 3.5, "prompt": "A bird flies", "fps": 16}
        arguments = models.video_arguments(profile, request, first, last, 512, 288, None)
        self.assertIs(arguments["image"], first)
        self.assertIs(arguments["last_image"], last)
        with self.assertRaisesRegex(ValueError, "reference image"):
            models.video_arguments(profile, request, None, None, 512, 288, None)

    def test_video_frame_contracts_and_spatial_dimensions(self):
        self.assertEqual(worker._video_dimensions("16:9", "quality-768", "ltx-2.5"), (768, 448))
        self.assertEqual(worker._video_dimensions("16:9", "quality-768", "wan-2.2-t2v-a14b"), (768, 432))
        profile = models.PROFILES["helios"]
        with self.assertRaisesRegex(ValueError, "frames"):
            models.video_arguments(profile, {"numFrames": 17}, None, None, 512, 288, None)

    def test_svd_does_not_send_prompt_arguments(self):
        profile = models.PROFILES["stable-video-diffusion"]
        arguments = models.video_arguments(profile, {"numFrames": 25, "numInferenceSteps": 25, "guidanceScale": 3, "fps": 7}, object(), None, 512, 288, None)
        self.assertNotIn("prompt", arguments)
        self.assertNotIn("negative_prompt", arguments)
        self.assertEqual(arguments["max_guidance_scale"], 3)

    def test_single_image_pipelines_reject_a_distinct_closing_image(self):
        for architecture in ("stable-video-diffusion", "cogvideox-1.5-5b-i2v"):
            profile = models.PROFILES[architecture]
            request = {"numFrames": profile["video"]["minimum"], "numInferenceSteps": profile["steps"], "guidanceScale": profile["guidance"], "fps": profile["video"]["fps"], "prompt": "A bird flies"}
            with self.subTest(architecture=architecture), self.assertRaisesRegex(ValueError, "one opening image"):
                models.video_arguments(profile, request, object(), object(), 512, 288, None)

    def test_distilled_ltx_disables_all_guidance_branches(self):
        profile = models.PROFILES["ltx-2.5"]
        sigmas = [1.0, 0.0]
        modules = {"diffusers.pipelines.ltx2.utils": SimpleNamespace(DISTILLED_SIGMA_VALUES=sigmas)}
        request = {"numFrames": 9, "numInferenceSteps": 8, "guidanceScale": 1, "fps": 24, "prompt": "A bird flies"}
        with mock.patch.dict("sys.modules", modules):
            arguments = models.video_arguments(profile, request, None, None, 512, 288, None)
        self.assertIs(arguments["sigmas"], sigmas)
        for name in ("guidance_scale", "audio_guidance_scale", "modality_scale", "audio_modality_scale"):
            self.assertEqual(arguments[name], 1.0)
        for name in ("stg_scale", "audio_stg_scale", "guidance_rescale", "audio_guidance_rescale"):
            self.assertEqual(arguments[name], 0.0)

    def test_prompt_only_video_orchestration_publishes_no_source_digests(self):
        pipeline = mock.Mock()
        pipeline.return_value = SimpleNamespace(frames=[[Image.new("RGB", (512, 288)) for _ in range(5)]])
        torch = SimpleNamespace(Generator=mock.Mock(return_value=SimpleNamespace(manual_seed=lambda seed: seed)), inference_mode=nullcontext)
        runtime = SimpleNamespace(SCHEMA_VERSION=1, WORKER_VERSION="test", WorkerError=ValueError,
            _required_text=lambda data, key, maximum: data[key], _video_dimensions=worker._video_dimensions,
            _runtime=lambda: (torch, SimpleNamespace()), _device=lambda _: ("cpu", "CPU", None),
            _configure_video_conv3d_backend=lambda *_: "cpu", _start_video_memory_observation=lambda *_: None,
            _pipeline_dtype=lambda *_: "fp32", _fresh_output_directory=lambda path: Path(path),
            _progress=mock.Mock(), _enable_sampling_progress=mock.Mock(),
            _finish_video_memory_observation=lambda *_: None, _package_versions=lambda: {})
        with tempfile.TemporaryDirectory() as directory:
            runtime._encode_video_webm = mock.Mock(return_value=(Path(directory, "video.webm"), {"durationSeconds": 0.3125}, None))
            request = {"schemaVersion": 1, "model": {"architecture": "wan-2.2-t2v-a14b", "revision": "revision", "digest": "digest"}, "prompt": "A bird flies", "numFrames": 5, "numInferenceSteps": 40, "guidanceScale": 4, "fps": 16, "seed": 1, "loopMode": "none", "aspectRatio": "16:9", "resolution": "preview-512", "outputDirectory": directory, "matteQuality": "production", "encodingQuality": "lossless"}
            with mock.patch.object(models, "load_pipeline", return_value=pipeline):
                result = video.generate(request, runtime)
            self.assertEqual(result["conditioningMode"], "native-text-to-video")
            self.assertNotIn("image", pipeline.call_args.kwargs)
            self.assertEqual(result["output"]["fileName"], "video.webm")
            runtime._enable_sampling_progress.assert_called_once_with(pipeline)

    def test_generated_audio_is_muxed_and_both_tracks_decode(self):
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory, "video.webm")
            subprocess.run([ffmpeg, "-v", "error", "-y", "-f", "lavfi", "-i", "color=size=128x128:rate=8:duration=1", "-c:v", "libvpx-vp9", str(destination)], check=True, capture_output=True, creationflags=flags)
            audio = mock.Mock()
            audio.detach.return_value.float.return_value.cpu.return_value.numpy.return_value = np.zeros((1, 2, 24000), dtype=np.float32)
            video._mux_audio(destination, audio, 24000, 1)
            result = subprocess.run([ffmpeg, "-v", "error", "-i", str(destination), "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-"], capture_output=True, creationflags=flags)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(destination.with_suffix(".wav").exists())


if __name__ == "__main__":
    unittest.main()
