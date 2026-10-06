import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from diffusers import AutoencoderKL, DDPMScheduler, StableDiffusionPipeline, StableDiffusionXLPipeline, UNet2DConditionModel
from PIL import Image
from safetensors.torch import load_file, save_file
from transformers import CLIPTextConfig, CLIPTextModel, CLIPTextModelWithProjection, CLIPTokenizer

import media_diffusion_training as training
from media_training_data import read_dataset
from media_training_state import checkpoints, restore_checkpoint, save_checkpoint


def options():
    return {"method": "lora", "precision": "float32", "optimizer": "adamw", "trainable_precision": "float32", "batch_size": 1,
            "gradient_accumulation": 1, "lr_scheduler": "constant", "warmup_steps": 0,
            "weight_decay": 0.01, "max_grad_norm": 1, "snr_gamma": 0,
            "noise_offset": 0, "lora_dropout": 0, "guidance_scale": 3.5, "checkpoint_interval": 1,
            "checkpoint_retention": 2, "gradient_checkpointing": True,
            "preserve_aspect_ratio": False, "initializer_token": "a"}


def tiny_pipeline(xl):
    tokenizer = CLIPTokenizer(vocab={"<|startoftext|>": 0, "<|endoftext|>": 1, "a</w>": 2}, merges=[], model_max_length=16)
    config = CLIPTextConfig(vocab_size=len(tokenizer), hidden_size=32, intermediate_size=32,
                            num_hidden_layers=2, num_attention_heads=4, max_position_embeddings=16,
                            projection_dim=32, bos_token_id=0, eos_token_id=1, pad_token_id=1)
    unet = UNet2DConditionModel(sample_size=32, in_channels=4, out_channels=4, layers_per_block=1,
                               block_out_channels=(8,), down_block_types=("CrossAttnDownBlock2D",),
                               up_block_types=("CrossAttnUpBlock2D",), cross_attention_dim=64 if xl else 32,
                               norm_num_groups=4, attention_head_dim=2,
                               **({"addition_embed_type": "text_time", "addition_time_embed_dim": 8,
                                   "projection_class_embeddings_input_dim": 80} if xl else {}))
    vae = AutoencoderKL(in_channels=3, out_channels=3, down_block_types=("DownEncoderBlock2D", "DownEncoderBlock2D"),
                        up_block_types=("UpDecoderBlock2D", "UpDecoderBlock2D"), block_out_channels=(8, 8),
                        latent_channels=4, norm_num_groups=4, sample_size=64)
    shared = dict(vae=vae, text_encoder=CLIPTextModel(config), tokenizer=tokenizer, unet=unet,
                  scheduler=DDPMScheduler(num_train_timesteps=10, steps_offset=1, clip_sample=False))
    if xl:
        return StableDiffusionXLPipeline(**shared, text_encoder_2=CLIPTextModelWithProjection(config),
                                         tokenizer_2=copy.deepcopy(tokenizer), add_watermarker=False)
    return StableDiffusionPipeline(**shared, safety_checker=None, feature_extractor=None, requires_safety_checker=False)


class DiffusionTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_training_export_and_generation_across_stable_diffusion_architectures(self):
        self.verify_architecture_workflows("adamw")

    def test_adafactor_export_generation_and_exact_resume_across_stable_diffusion_architectures(self):
        self.verify_architecture_workflows("adafactor")

    def verify_architecture_workflows(self, optimizer):
        for architecture in ("stable-diffusion-1", "stable-diffusion-2", "stable-diffusion-xl", "pony"):
            xl = architecture in ("stable-diffusion-xl", "pony")
            with self.subTest(architecture=architecture), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                torch.manual_seed(11)
                pipeline = tiny_pipeline(xl)
                if architecture == "stable-diffusion-2":
                    pipeline.scheduler = DDPMScheduler.from_config(pipeline.scheduler.config, prediction_type="v_prediction")
                base = root / "base"
                pipeline.save_pretrained(base, safe_serialization=True)
                original = {key: value.clone() for key, value in pipeline.unet.state_dict().items()}
                for method in ("lora", "finetune", "embedding"):
                    job = root / method
                    dataset = job / "dataset"
                    dataset.mkdir(parents=True)
                    records = []
                    for index in range(3):
                        Image.new("RGB", (64, 64), (index * 60, 50, 150)).save(dataset / f"{index}.png")
                        records.append(json.dumps({"file_name": f"{index}.png", "text": "a <mdconcept>"}))
                    (dataset / "metadata.jsonl").write_text("\n".join(records), encoding="utf-8")
                    spec = {**options(), "method": method, "optimizer": optimizer,
                            "max_grad_norm": 0 if optimizer == "adafactor" else 1, "architecture": architecture,
                            "model": {"architecture": architecture, "packageKind": "diffusers-directory", "path": str(base)},
                            "trigger_phrase": "<mdconcept>", "four_bit": False, "attention_only": True,
                            "resolution": 64, "rank": 4, "learning_rate": 0.001,
                            "steps": 2, "resume": False, "seed": 42}
                    if method == "lora":
                        spec.update(batch_size=2, gradient_accumulation=2, snr_gamma=5,
                                    noise_offset=0.05, lora_dropout=0.1, attention_only=False,
                                    lr_scheduler="cosine", warmup_steps=1)
                    elif method == "embedding":
                        spec["warmup_steps"] = 2
                    with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)):
                        training.train(spec, job)
                    progress = json.loads((job / "progress.json").read_text())
                    self.assertEqual(progress["completedSteps"], 2)
                    self.assertTrue(torch.isfinite(torch.tensor(progress["loss"])))
                    if method == "embedding":
                        metrics = [json.loads(line) for line in (job / "metrics.jsonl").read_text().splitlines()]
                        self.assertEqual(metrics[0]["learningRate"], 0.0005)
                        self.assertEqual(metrics[1]["learningRate"], 0.001)
                    output = job / "output"
                    self.assertEqual(len(checkpoints(output)), 2)
                    resumed_job = root / f"{method}-resume"
                    shutil.copytree(dataset, resumed_job / "dataset")
                    shutil.copyfile(job / "conditioning.safetensors", resumed_job / "conditioning.safetensors")
                    shutil.copytree(output / "checkpoint-1", resumed_job / "output/checkpoint-1")
                    with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)):
                        training.train({**spec, "resume": True}, resumed_job)
                    expected_weights = load_file(output / "checkpoint-2/weights.safetensors")
                    resumed_weights = load_file(resumed_job / "output/checkpoint-2/weights.safetensors")
                    self.assertEqual(expected_weights.keys(), resumed_weights.keys())
                    for key in expected_weights:
                        torch.testing.assert_close(resumed_weights[key], expected_weights[key], rtol=0, atol=0)
                    resumed_progress = json.loads((resumed_job / "progress.json").read_text())
                    self.assertEqual(resumed_progress["loss"], progress["loss"])
                    cls = StableDiffusionXLPipeline if xl else StableDiffusionPipeline
                    if method == "finetune":
                        trained = cls.from_pretrained(output / "model", local_files_only=True, use_safetensors=True)
                        self.assertTrue(any(not torch.equal(value, original[key]) for key, value in trained.unet.state_dict().items()))
                    else:
                        trained = cls.from_pretrained(base, local_files_only=True, use_safetensors=True)
                        if method == "lora":
                            trained.load_lora_weights(output, weight_name="pytorch_lora_weights.safetensors")
                            self.assertTrue(any(tensor.abs().sum() > 0 for key, tensor in load_file(str(output / "pytorch_lora_weights.safetensors")).items() if "lora_B" in key))
                        else:
                            learned = load_file(str(output / "learned_embeds.safetensors"))
                            targets = [("clip_l" if xl else "emb_params", trained.tokenizer, trained.text_encoder)]
                            if xl:
                                targets.append(("clip_g", trained.tokenizer_2, trained.text_encoder_2))
                            for key, tokenizer, encoder in targets:
                                initial = encoder.get_input_embeddings().weight[tokenizer.encode("a", add_special_tokens=False)].mean(0)
                                self.assertFalse(torch.equal(learned[key].squeeze(0), initial))
                            from media_diffusers_worker import _load_textual_inversion

                            profiles = [{"component": "text-encoder" if index == 0 else "text-encoder-2",
                                         "tensorKey": key, "vectorCount": 1,
                                         "dimension": int(learned[key].shape[-1])}
                                        for index, (key, _, _) in enumerate(targets)]
                            _load_textual_inversion(trained, output / "learned_embeds.safetensors", "<mdconcept>",
                                                    [profile["component"] for profile in profiles], profiles)
                    image = trained("a <mdconcept>", height=64, width=64, num_inference_steps=2, guidance_scale=1,
                                    generator=torch.Generator().manual_seed(12)).images[0]
                    self.assertEqual(image.size, (64, 64))
                    image.save(job / "generated.png")

    def test_finetune_memory_limit_fails_before_dataset_or_optimizer_allocation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            pipeline = tiny_pipeline(True)
            spec = {**options(), "method": "finetune", "architecture": "stable-diffusion-xl",
                    "model": {"architecture": "stable-diffusion-xl"}, "four_bit": False,
                    "trigger_phrase": "a", "resolution": 64, "rank": 4,
                    "learning_rate": 0.001, "steps": 2, "seed": 42}
            with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                 patch("media_diffusers_worker._physical_memory_bytes", return_value=1), \
                 patch("media_diffusers_worker._load_pipeline", return_value=pipeline):
                with self.assertRaisesRegex(ValueError, "Use BF16 Adafactor, LoRA"):
                    training.train(spec, root)

    def test_embedding_loader_preserves_vocabulary_and_registers_all_vectors(self):
        from media_diffusers_worker import WorkerError, _load_textual_inversion

        with tempfile.TemporaryDirectory() as temporary:
            pipeline = tiny_pipeline(True)
            path = Path(temporary) / "vectors.safetensors"
            vectors = {"clip_l": torch.arange(64, dtype=torch.float32).reshape(2, 32) / 100,
                       "clip_g": torch.arange(64, dtype=torch.float32).reshape(2, 32) / 200}
            save_file(vectors, path)
            originals = [encoder.get_input_embeddings().weight.detach().clone()
                         for encoder in (pipeline.text_encoder, pipeline.text_encoder_2)]
            profiles = [{"component": "text-encoder", "tensorKey": "clip_l", "vectorCount": 2, "dimension": 32},
                        {"component": "text-encoder-2", "tensorKey": "clip_g", "vectorCount": 2, "dimension": 32}]
            loaded = _load_textual_inversion(pipeline, path, "<MiXeD>",
                                            [profile["component"] for profile in profiles], profiles)
            for index, (key, tokenizer, encoder) in enumerate([
                ("clip_l", pipeline.tokenizer, pipeline.text_encoder),
                ("clip_g", pipeline.tokenizer_2, pipeline.text_encoder_2),
            ]):
                aliases = loaded[index]["registeredTokens"]
                self.assertEqual(aliases, ["<MiXeD>", "<MiXeD>_1"])
                self.assertEqual(tokenizer.tokenize(" ".join(aliases)), aliases)
                weight = encoder.get_input_embeddings().weight
                torch.testing.assert_close(weight[:len(originals[index])], originals[index], rtol=0, atol=0)
                torch.testing.assert_close(weight[tokenizer.convert_tokens_to_ids(aliases)], vectors[key], rtol=0, atol=0)
                expanded = pipeline.maybe_convert_prompt("a <MiXeD>", tokenizer)
                self.assertIn("<MiXeD> <MiXeD>_1", expanded)
            with self.assertRaisesRegex(WorkerError, "collide"):
                _load_textual_inversion(pipeline, path, "<MiXeD>",
                                        [profile["component"] for profile in profiles], profiles)

    def test_checkpoint_resume_restores_optimizer_schedule_weights_and_randomness(self):
        for method in ("lora", "finetune", "embedding"):
            with self.subTest(method=method), tempfile.TemporaryDirectory() as temporary:
                torch.manual_seed(13)
                parameter = torch.nn.Parameter(torch.randn(4))
                optimizer = torch.optim.AdamW([parameter], lr=0.01)
                scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=4)
                scaler = torch.amp.GradScaler("cpu", enabled=False)
                generator = torch.Generator().manual_seed(12)

                def update():
                    optimizer.zero_grad(set_to_none=True)
                    (parameter * torch.randn(4, generator=generator)).square().mean().backward()
                    optimizer.step()
                    scheduler.step()

                def restore(weights):
                    with torch.no_grad():
                        parameter.copy_(weights[method])

                update()
                output = Path(temporary)
                save_checkpoint(output, 1, {method: parameter}, optimizer, scheduler, scaler, generator, "cpu", "dataset", {"method": method}, 2)
                update()
                expected = parameter.detach().clone()
                expected_random = torch.rand(3, generator=generator)
                self.assertEqual(restore_checkpoint(output, restore, optimizer, scheduler, scaler, generator, "cpu", "dataset", {"method": method}), 1)
                update()
                torch.testing.assert_close(parameter, expected, rtol=0, atol=0)
                torch.testing.assert_close(torch.rand(3, generator=generator), expected_random, rtol=0, atol=0)
                with self.assertRaisesRegex(ValueError, "changed"):
                    restore_checkpoint(output, restore, optimizer, scheduler, scaler, generator, "cpu", "changed", {"method": method})

    def test_bucket_dimensions_and_unsafe_dataset_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = []
            for index in range(3):
                Image.new("RGB", (160, 80), "red").save(root / f"{index}.png")
                records.append(json.dumps({"file_name": f"{index}.png", "text": "red"}))
            (root / "metadata.jsonl").write_text("\n".join(records), encoding="utf-8")
            sample = read_dataset(root, 512, True)[0]
            self.assertEqual(sample["pixels"].shape[:2], (384, 704))
            self.assertEqual(sample["time_ids"][-2:], [384, 704])
            (root / "metadata.jsonl").write_text(json.dumps({"file_name": "../outside.png", "text": "red"}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "inside the dataset"):
                read_dataset(root, 64)

    def test_velocity_target_and_min_snr_weighting(self):
        scheduler = DDPMScheduler(num_train_timesteps=10, prediction_type="v_prediction")
        noise, latents, steps = torch.randn(2, 4, 8, 8), torch.randn(2, 4, 8, 8), torch.tensor([2, 5])
        torch.testing.assert_close(training.noise_target(scheduler, latents, noise, steps), scheduler.get_velocity(latents, noise, steps))
        loss = training.diffusion_loss(torch.zeros_like(noise), noise, scheduler, steps, 5)
        self.assertTrue(torch.isfinite(loss))
        self.assertGreater(loss, 0)


if __name__ == "__main__":
    unittest.main()
