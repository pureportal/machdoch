import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from diffusers import FluxPipeline, FluxTransformer2DModel
from PIL import Image
from safetensors.torch import load_file
from transformers import CLIPTextModel

import media_diffusers_worker as worker
import media_flow_training as training
from test_media_diffusion_training import options
from test_media_sd3_training import tiny_pipeline as tiny_sd3_pipeline


def tiny_pipeline(guidance):
    components = tiny_sd3_pipeline()
    transformer = FluxTransformer2DModel(
        in_channels=16, num_layers=2, num_single_layers=2, attention_head_dim=8,
        num_attention_heads=2, joint_attention_dim=64, pooled_projection_dim=16,
        guidance_embeds=guidance, axes_dims_rope=(2, 2, 4),
    )
    return FluxPipeline(
        transformer=transformer, vae=components.vae, scheduler=components.scheduler,
        text_encoder=CLIPTextModel(components.text_encoder.config), tokenizer=components.tokenizer,
        text_encoder_2=components.text_encoder_3, tokenizer_2=components.tokenizer_3,
    )


class FluxTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)

    def test_dev_and_schnell_methods_export_reload_inference_and_exact_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for guidance, architecture in ((True, "flux-1-dev"), (False, "flux-1-schnell")):
                torch.manual_seed(11)
                pipeline = tiny_pipeline(guidance)
                base = root / architecture
                pipeline.save_pretrained(base, safe_serialization=True)
                original = {key: tensor.clone() for key, tensor in pipeline.transformer.state_dict().items()}
                clip_original = {key: tensor.clone() for key, tensor in pipeline.text_encoder.state_dict().items()}
                text_original = {key: tensor.clone() for key, tensor in pipeline.text_encoder_2.state_dict().items()}
                for method in ("lora", "finetune", "embedding"):
                    with self.subTest(architecture=architecture, method=method):
                        trigger = "mdfluxtoken" if method == "embedding" else "concept"
                        job = root / f"{architecture}-{method}"
                        dataset = job / "dataset"
                        dataset.mkdir(parents=True)
                        records = []
                        for index in range(3):
                            Image.new("RGB", (64, 64), (index * 60, 50, 150)).save(dataset / f"{index}.png")
                            records.append(json.dumps({"file_name": f"{index}.png", "text": f"a {trigger}"}))
                        (dataset / "metadata.jsonl").write_text("\n".join(records), encoding="utf-8")
                        spec = {**options(), "method": method, "architecture": architecture,
                                "model": {"architecture": architecture, "packageKind": "diffusers-directory", "path": str(base)},
                                "trigger_phrase": trigger, "four_bit": False, "attention_only": False,
                                "resolution": 64, "rank": 4, "learning_rate": 0.001, "steps": 2,
                                "resume": False, "seed": 42, "batch_size": 2, "gradient_accumulation": 2,
                                "lr_scheduler": "cosine", "warmup_steps": 1, "noise_offset": 0.05,
                                "lora_dropout": 0.1, "guidance_scale": 3.5, "initializer_token": "a"}
                        loaded = []
                        load_pipeline = worker._load_pipeline

                        def load(*arguments, **keywords):
                            model = load_pipeline(*arguments, **keywords)
                            loaded.append(model)
                            return model

                        with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                                patch("media_diffusers_worker._load_pipeline", side_effect=load):
                            training.train(spec, job)
                        progress = json.loads((job / "progress.json").read_text())
                        self.assertEqual(progress["completedSteps"], 2)
                        self.assertTrue(torch.isfinite(torch.tensor(progress["loss"])))
                        cache = load_file(job / "conditioning.safetensors")
                        if method == "embedding":
                            self.assertEqual(set(cache), {f"{index}.{key}" for index in range(3) for key in ("mean", "std")})
                            for key, tensor in loaded[0].transformer.state_dict().items():
                                torch.testing.assert_close(tensor, original[key], rtol=0, atol=0)
                            for encoder, initial in ((loaded[0].text_encoder, clip_original),
                                                     (loaded[0].text_encoder_2, text_original)):
                                for key, tensor in encoder.state_dict().items():
                                    if key.endswith(".vector"):
                                        continue
                                    source = initial[key.replace(".base.weight", ".weight")]
                                    torch.testing.assert_close(tensor[:source.shape[0]], source, rtol=0, atol=0)
                        else:
                            self.assertEqual(cache["0.prompt"].shape[-1], 64)
                            self.assertEqual(cache["0.pooled"].shape[-1], 16)
                        output = job / "output"
                        resumed = root / f"{architecture}-{method}-resume"
                        shutil.copytree(dataset, resumed / "dataset")
                        shutil.copyfile(job / "conditioning.safetensors", resumed / "conditioning.safetensors")
                        shutil.copytree(output / "checkpoint-1", resumed / "output/checkpoint-1")
                        with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)):
                            training.train({**spec, "resume": True}, resumed)
                        uninterrupted = load_file(output / "checkpoint-2/weights.safetensors")
                        restored = load_file(resumed / "output/checkpoint-2/weights.safetensors")
                        for key in uninterrupted:
                            torch.testing.assert_close(restored[key], uninterrupted[key], rtol=0, atol=0)
                        self.assertEqual(json.loads((resumed / "progress.json").read_text())["loss"], progress["loss"])
                        trained = FluxPipeline.from_pretrained(
                            output / "model" if method == "finetune" else base,
                            local_files_only=True, use_safetensors=True,
                        )
                        if method == "lora":
                            trained.load_lora_weights(output, weight_name="pytorch_lora_weights.safetensors")
                            learned = load_file(output / "pytorch_lora_weights.safetensors")
                            self.assertTrue(any(tensor.abs().sum() > 0 for key, tensor in learned.items() if "lora_B" in key))
                            self.assertTrue(any("add_q_proj" in key for key in learned))
                            self.assertTrue(any("proj_mlp" in key for key in learned))
                        elif method == "finetune":
                            self.assertTrue(any(not torch.equal(tensor, original[key]) for key, tensor in trained.transformer.state_dict().items()))
                        for key, tensor in trained.text_encoder_2.state_dict().items():
                            torch.testing.assert_close(tensor, text_original[key], rtol=0, atol=0)
                        if method == "embedding":
                            path = output / "learned_embeds.safetensors"
                            learned = load_file(path)
                            self.assertEqual(set(learned), {"clip_l", "t5"})
                            profiles = []
                            for key, encoder, tokenizer, component in (
                                ("clip_l", trained.text_encoder, trained.tokenizer, "text-encoder"),
                                ("t5", trained.text_encoder_2, trained.tokenizer_2, "text-encoder-2"),
                            ):
                                initial = encoder.get_input_embeddings().weight[tokenizer.encode("a", add_special_tokens=False)].mean(dim=0)
                                self.assertFalse(torch.equal(learned[key].squeeze(0), initial))
                                profiles.append({"tensorKey": key, "component": component,
                                                 "dimension": learned[key].shape[-1], "vectorCount": 1})
                            worker._load_textual_inversion(trained, path, trigger,
                                                          [profile["component"] for profile in profiles], profiles)
                        image = trained(f"a {trigger}", height=64, width=64, num_inference_steps=2,
                                        guidance_scale=3.5 if guidance else 0, max_sequence_length=16,
                                        generator=torch.Generator().manual_seed(12)).images[0]
                        self.assertEqual(image.size, (64, 64))

    def test_packed_non_square_batches_and_guidance_match_transformer_contract(self):
        for guidance in (True, False):
            pipeline = tiny_pipeline(guidance)
            pipeline.transformer.eval()
            noisy = torch.randn((2, 4, 16, 24))
            timesteps = torch.tensor([1000.0, 250.0])
            batch = {"prompt": torch.randn((2, 8, 64)), "pooled": torch.randn((2, 16))}
            with torch.no_grad(), patch.object(pipeline.transformer, "forward", wraps=pipeline.transformer.forward) as forward:
                low = training.predict_velocity(pipeline, noisy, timesteps, batch, 1, "flux-1")
                high = training.predict_velocity(pipeline, noisy, timesteps, batch, 4, "flux-1")
            self.assertEqual(low.shape, noisy.shape)
            arguments = forward.call_args.kwargs
            torch.testing.assert_close(arguments["timestep"], timesteps / 1000)
            self.assertEqual(arguments["img_ids"].shape, (96, 3))
            self.assertEqual(arguments["txt_ids"].shape, (8, 3))
            if guidance:
                torch.testing.assert_close(arguments["guidance"], torch.full((2,), 4.0))
                self.assertFalse(torch.equal(low, high))
            else:
                self.assertIsNone(arguments["guidance"])
                torch.testing.assert_close(low, high, rtol=0, atol=0)

    def test_invalid_methods_options_variants_and_memory_are_rejected_before_dataset(self):
        specification = {**options(), "architecture": "flux-1-dev",
                         "model": {"architecture": "flux-1-dev"}, "trigger_phrase": "a",
                         "four_bit": False, "resolution": 64, "rank": 4, "learning_rate": 0.001,
                         "steps": 2, "seed": 42}
        for invalid in ({"method": "invalid"}, {"snr_gamma": 5}, {"four_bit": True}, {"guidance_scale": float("nan")},
                        {"guidance_scale": -1}, {"guidance_scale": 21}, {"model": {"architecture": "flux-1-schnell"}}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                training.validate_settings({**specification, **invalid})
        with tempfile.TemporaryDirectory() as temporary, \
                patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                patch("media_flow_training.read_dataset") as read_dataset:
            with patch("media_diffusers_worker._load_pipeline", return_value=tiny_pipeline(False)):
                with self.assertRaisesRegex(ValueError, "dev or Schnell"):
                    training.train(specification, Path(temporary))
            with patch("media_diffusers_worker._load_pipeline", return_value=tiny_pipeline(True)), \
                    patch("media_diffusers_worker._physical_memory_bytes", return_value=1):
                with self.assertRaisesRegex(ValueError, "Use BF16 Adafactor, LoRA, or a device with more memory"):
                    training.train({**specification, "method": "finetune"}, Path(temporary))
                with self.assertRaisesRegex(ValueError, "before trainable weights and activations"):
                    training.train(specification, Path(temporary))
            read_dataset.assert_not_called()

    def test_embedding_captions_reject_truncation_in_either_encoder(self):
        from media_training_embeddings import encode_flux_captions, prepare_embeddings

        pipeline = tiny_pipeline(True)
        prepare_embeddings(pipeline, "mdfluxtoken", "a", "flux-1-dev")
        with self.assertRaisesRegex(ValueError, "truncates the embedding token"):
            encode_flux_captions(pipeline, ["a " * 20 + "mdfluxtoken"], "cpu")
        pipeline.tokenizer_max_length = 300
        with self.assertRaisesRegex(ValueError, "truncates the embedding token"):
            encode_flux_captions(pipeline, ["a " * 260 + "mdfluxtoken"], "cpu")


if __name__ == "__main__":
    unittest.main()
