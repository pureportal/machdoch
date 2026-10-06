import hashlib
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import imageio_ffmpeg
import numpy as np
import torch
from diffusers import AutoencoderKLCogVideoX, CogVideoXDDIMScheduler, CogVideoXImageToVideoPipeline, CogVideoXPipeline, CogVideoXTransformer3DModel
from PIL import Image
from safetensors.torch import load_file
from tokenizers import Tokenizer, models, pre_tokenizers, processors
from transformers import PreTrainedTokenizerFast, T5Config, T5EncoderModel

import media_cogvideo_training as training
import media_diffusers_worker as worker
from media_cogvideo_conditioning import ARCHITECTURES, embedding_arguments, encode_prompts, pad_latent_frames, training_loss
from media_training_embeddings import prepare_embeddings
from media_training_video_data import decode_video, validate_video_settings
from media_video_io import encode_frames
from test_media_diffusion_training import options


def tiny_pipeline(architecture):
    backend = Tokenizer(models.WordLevel({"<pad>": 0, "</s>": 1, "<unk>": 2, "a": 3, "concept": 4}, unk_token="<unk>"))
    backend.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    backend.post_processor = processors.TemplateProcessing(single="$A </s>", special_tokens=[("</s>", 1)])
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend, model_max_length=226,
        pad_token="<pad>", eos_token="</s>", unk_token="<unk>")
    encoder = T5EncoderModel(T5Config(vocab_size=5, d_model=64, d_ff=64, d_kv=8,
        num_layers=1, num_heads=4, dropout_rate=0, pad_token_id=0, eos_token_id=1))
    image_conditioned = architecture.endswith("-i2v")
    version_15 = architecture != "cogvideox-2b"
    vae = AutoencoderKLCogVideoX(down_block_types=("CogVideoXDownBlock3D",) * 3,
        up_block_types=("CogVideoXUpBlock3D",) * 3, block_out_channels=(8, 8, 8),
        layers_per_block=1, latent_channels=4, norm_num_groups=4,
        temporal_compression_ratio=4, sample_height=64, sample_width=96,
        scaling_factor=0.7, invert_scale_latents=image_conditioned)
    transformer = CogVideoXTransformer3DModel(num_attention_heads=2, attention_head_dim=16,
        in_channels=8 if image_conditioned else 4, out_channels=4, num_layers=1,
        time_embed_dim=32, text_embed_dim=64, sample_width=24, sample_height=16,
        sample_frames=9, max_text_seq_length=16, patch_size=2,
        patch_size_t=2 if version_15 else None, use_rotary_positional_embeddings=version_15,
        ofs_embed_dim=32 if image_conditioned else None)
    pipeline_class = CogVideoXImageToVideoPipeline if image_conditioned else CogVideoXPipeline
    return pipeline_class(tokenizer=tokenizer, text_encoder=encoder, vae=vae,
        transformer=transformer, scheduler=CogVideoXDDIMScheduler(num_train_timesteps=10))


def make_dataset(directory, token):
    directory.mkdir(parents=True)
    records = []
    for index in range(3):
        frames = []
        for position in range(12):
            frame = np.zeros((80, 112, 3), dtype=np.uint8)
            frame[..., index] = 70
            frame[20:45, 5 + position * 3:25 + position * 3] = (220, 80, 40)
            frames.append(frame)
        name = f"{index}.webm"
        encode_frames(imageio_ffmpeg.get_ffmpeg_exe(), directory / name, frames, 8,
            ["-c:v", "libvpx-vp9", "-lossless", "1", "-pix_fmt", "yuv420p"], alpha=False)
        records.append(json.dumps({"file_name": name, "text": f"a {token}"}))
    (directory / "metadata.jsonl").write_text("\n".join(records), encoding="utf-8")


class CogVideoTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_methods_export_reload_generate_and_resume_exactly(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for architecture in ARCHITECTURES:
                torch.manual_seed(11)
                pipeline = tiny_pipeline(architecture)
                base = root / architecture
                pipeline.save_pretrained(base, safe_serialization=True)
                original = {key: tensor.clone() for key, tensor in pipeline.transformer.state_dict().items()}
                encoder_original = {key: tensor.clone() for key, tensor in pipeline.text_encoder.state_dict().items()}
                for method in ("lora", "finetune", "embedding"):
                    with self.subTest(architecture=architecture, method=method):
                        token = "MiXeD" if method == "embedding" else "concept"
                        job = root / f"{architecture}-{method}"
                        make_dataset(job / "dataset", token)
                        spec = {**options(), "architecture": architecture, "method": method,
                            "model": {"architecture": architecture, "packageKind": "diffusers-directory", "path": str(base)},
                            "trigger_phrase": token, "four_bit": False, "attention_only": architecture == "cogvideox-2b",
                            "resolution": 64, "rank": 4, "learning_rate": 0.001, "steps": 2,
                            "seed": 42, "resume": False, "batch_size": 2, "gradient_accumulation": 2,
                            "lr_scheduler": "cosine", "warmup_steps": 1, "lora_dropout": 0.1, "noise_offset": 0.05,
                            "video": {"width": 96, "height": 64, "frames": 9, "fps": 8,
                                      "image_dropout": 0.1 if architecture.endswith("-i2v") else 0}}
                        loaded = []
                        import media_open_models
                        load = media_open_models.load_pipeline

                        def capture(*args, **kwargs):
                            result = load(*args, **kwargs)
                            loaded.append(result)
                            return result

                        with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                                patch("media_open_models.load_pipeline", side_effect=capture):
                            training.train(spec, job)
                        progress = json.loads((job / "progress.json").read_text())
                        self.assertEqual(progress["completedSteps"], 2)
                        self.assertTrue(np.isfinite(progress["loss"]))
                        cached = load_file(job / "conditioning.safetensors")
                        self.assertEqual(cached["0.mean"].shape, (1, 4, 3, 16, 24))
                        self.assertEqual("0.prompt" in cached, method != "embedding")
                        self.assertEqual("0.image_mean" in cached, architecture.endswith("-i2v"))
                        trained_encoder = loaded[0].text_encoder.state_dict()
                        for key, tensor in encoder_original.items():
                            target = key.replace("shared.weight", "shared.base.weight").replace("encoder.embed_tokens.weight", "encoder.embed_tokens.base.weight") if method == "embedding" else key
                            torch.testing.assert_close(trained_encoder[target][:tensor.shape[0]], tensor, rtol=0, atol=0)
                        if method != "finetune":
                            trained = loaded[0].transformer.state_dict()
                            for key, tensor in original.items():
                                target = key.replace(".weight", ".base_layer.weight").replace(".bias", ".base_layer.bias")
                                torch.testing.assert_close(trained[target if target in trained else key], tensor, rtol=0, atol=0)
                        checkpoint = load_file(job / "output/checkpoint-2/weights.safetensors")
                        earlier = load_file(job / "output/checkpoint-1/weights.safetensors")
                        self.assertTrue(any(not torch.equal(checkpoint[key], earlier[key]) for key in checkpoint))
                        resumed = root / f"{architecture}-{method}-resume"
                        shutil.copytree(job / "dataset", resumed / "dataset")
                        shutil.copyfile(job / "conditioning.safetensors", resumed / "conditioning.safetensors")
                        shutil.copytree(job / "output/checkpoint-1", resumed / "output/checkpoint-1")
                        with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)):
                            training.train({**spec, "resume": True}, resumed)
                        restored = load_file(resumed / "output/checkpoint-2/weights.safetensors")
                        for key in checkpoint:
                            torch.testing.assert_close(restored[key], checkpoint[key], rtol=0, atol=0)
                        self.assertEqual(json.loads((resumed / "progress.json").read_text())["loss"], progress["loss"])
                        reloaded = pipeline.__class__.from_pretrained(job / "output/model" if method == "finetune" else base,
                            local_files_only=True, use_safetensors=True, torch_dtype=torch.float32)
                        arguments = {"prompt": f"a {token}", "height": 64, "width": 96, "num_frames": 9,
                                     "num_inference_steps": 2, "guidance_scale": 2, "max_sequence_length": 16,
                                     "generator": torch.Generator().manual_seed(3), "output_type": "np"}
                        if architecture.endswith("-i2v"):
                            arguments["image"] = Image.new("RGB", (96, 64), (120, 60, 30))
                        if method == "lora":
                            reloaded.load_lora_weights(job / "output")
                            self.assertEqual(any("ff.net" in key for key in checkpoint), not spec["attention_only"])
                        elif method == "embedding":
                            vectors = worker._load_textual_inversion(reloaded, job / "output/learned_embeds.safetensors", token,
                                ["text-encoder"], [{"component": "text-encoder", "tensorKey": "cogvideox_t5", "vectorCount": 1, "dimension": 64}])
                            self.assertEqual(vectors[0]["registeredTokens"], [token])
                            arguments.update(embedding_arguments(reloaded, f"a {token}", f"a {token}", "cpu", 2))
                        result = reloaded(**arguments).frames
                        self.assertEqual(result.shape, (1, 9, 64, 96, 3))
                        self.assertTrue(np.isfinite(result).all())
                        import diffusers
                        import media_open_models
                        from media_open_video import _sample_pipeline

                        addon = None
                        if method != "finetune":
                            artifact = job / "output" / ("pytorch_lora_weights.safetensors" if method == "lora" else "learned_embeds.safetensors")
                            addon = {"addonId": "trained", "kind": "lora" if method == "lora" else "textual-inversion",
                                     "enabled": True, "path": str(artifact), "digest": hashlib.sha256(artifact.read_bytes()).hexdigest(),
                                     "targetComponents": ["denoiser"] if method == "lora" else ["text-encoder"]}
                            if method == "lora":
                                addon.update(modelStrength=0.7, textEncoderStrength=None, denoisingSchedule=None,
                                    loraProfile={"algorithm": "lora", "dialect": "diffusers-peft", "rankMinimum": 4, "rankMaximum": 4,
                                        "heterogeneousRanks": False, "targetModuleCount": len(checkpoint) // 2,
                                        "convolutionTargetCount": 0, "magnitudeVectorCount": 0, "networkAlphaCount": 0})
                            else:
                                addon.update(token=token, placement="both", embeddingVectors=[
                                    {"component": "text-encoder", "tensorKey": "cogvideox_t5", "vectorCount": 1, "dimension": 64}])
                        model = {**spec["model"], "path": str(job / "output/model" if method == "finetune" else base)}
                        render_arguments = {**arguments, "prompt": "a", "negative_prompt": "a", "generator": torch.Generator().manual_seed(3)}
                        render_arguments.pop("prompt_embeds", None)
                        render_arguments.pop("negative_prompt_embeds", None)
                        from media_model_memory import ModelPipelineCache

                        cache = ModelPipelineCache(torch, "cpu")
                        with patch("media_open_models.load_pipeline", wraps=load) as loader:
                            frames, _, _, applied = _sample_pipeline({"addons": [addon] if addon else []},
                                media_open_models.PROFILES[architecture], render_arguments, model, torch.float32, "cpu", diffusers, torch, worker, cache)
                            warm_arguments = {**arguments, "prompt": "another a", "negative_prompt": "another a",
                                              "generator": torch.Generator().manual_seed(4)}
                            warm_arguments.pop("prompt_embeds", None)
                            warm_arguments.pop("negative_prompt_embeds", None)
                            warm_frames, _, _, warm_applied = _sample_pipeline({"addons": [addon] if addon else []},
                                media_open_models.PROFILES[architecture], warm_arguments, model, torch.float32, "cpu", diffusers, torch, worker, cache)
                            self.assertEqual(loader.call_count, 1)
                            self.assertEqual(np.asarray(warm_frames).shape, (9, 64, 96, 3))
                            self.assertFalse(np.array_equal(frames, warm_frames))
                            self.assertEqual(len(warm_applied), len(applied))
                        cache.clear()
                        self.assertEqual(np.asarray(frames).shape, (9, 64, 96, 3))
                        self.assertEqual(len(applied), 0 if method == "finetune" else 1)
                        if method == "embedding":
                            vector = applied[0]["embeddingVectors"][0]
                            self.assertEqual(vector["encodedTokenCounts"], {"positive": 1, "negative": 1})
                            self.assertEqual(vector["maxSequenceLength"], 16)

    def test_loss_matches_pinned_training_objective(self):
        scheduler = CogVideoXDDIMScheduler(num_train_timesteps=10)
        torch.manual_seed(13)
        clean, noisy, prediction = [torch.randn(2, 3, 4, 8, 12) for _ in range(3)]
        timesteps = torch.tensor([2, 7])
        converted = scheduler.get_velocity(prediction, noisy, timesteps)
        weights = 1 / (1 - scheduler.alphas_cumprod[timesteps])
        expected = (weights[:, None, None, None, None] * (converted - clean).square()).flatten(1).mean(1).mean()
        torch.testing.assert_close(training_loss(scheduler, prediction, noisy, clean, timesteps), expected)

    def test_frame_padding_repeats_first_frame_and_keeps_original_order(self):
        latents = torch.arange(3.0).reshape(1, 3, 1, 1, 1)
        self.assertIs(pad_latent_frames(latents, None), latents)
        self.assertEqual(pad_latent_frames(latents, 2).flatten().tolist(), [0, 0, 1, 2])
        self.assertEqual(pad_latent_frames(latents, 4).flatten().tolist(), [0, 0, 1, 2])

    def test_prompt_encoding_matches_pipeline_and_rejects_truncated_tokens(self):
        pipeline = tiny_pipeline("cogvideox-2b")
        pipeline.text_encoder.eval()
        prompt = ["a concept"]
        torch.testing.assert_close(encode_prompts(pipeline, prompt, "cpu"),
            pipeline._get_t5_prompt_embeds(prompt, max_sequence_length=16, device="cpu"), rtol=0, atol=0)
        embeddings = prepare_embeddings(pipeline, "MiXeD", "a", "cogvideox-2b")
        with self.assertRaisesRegex(ValueError, "truncates"):
            encode_prompts(pipeline, ["a " * 20 + "MiXeD"], "cpu", ("MiXeD",))
        with self.assertRaisesRegex(ValueError, "truncates"):
            encode_prompts(pipeline, ["mixed"], "cpu", ("MiXeD",))
        encode_prompts(pipeline, ["MiXeD a"], "cpu", ("MiXeD",)).sum().backward()
        self.assertGreater(embeddings["cogvideox_t5"].vector.grad.abs().sum(), 0)

    def test_decoder_rejects_short_clips_and_invalid_canvas(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            make_dataset(root / "dataset", "concept")
            settings = {"width": 96, "height": 64, "frames": 9, "fps": 8, "image_dropout": 0}
            decoded = decode_video(root / "dataset/0.webm", settings)
            self.assertEqual(decoded.shape, (1, 3, 9, 64, 96))
            self.assertFalse(torch.equal(decoded[:, :, 0], decoded[:, :, 8]))
            with self.assertRaisesRegex(ValueError, "too short"):
                decode_video(root / "dataset/0.webm", {**settings, "frames": 49})
            for changed in ({"frames": 8}, {"width": 95}, {"image_dropout": float("nan")}, {"fps": True}):
                with self.assertRaises(ValueError):
                    validate_video_settings({**settings, **changed})


if __name__ == "__main__":
    unittest.main()
