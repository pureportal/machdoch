import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from diffusers import AutoencoderKLFlux2, FlowMatchEulerDiscreteScheduler, Flux2KleinPipeline, Flux2Transformer2DModel
from PIL import Image
from safetensors.torch import load_file
from transformers import Qwen3Config, Qwen3ForCausalLM

import media_diffusers_worker as worker
import media_flow_training as training
from media_flux2_conditioning import embedding_arguments, encode_flux2_prompts
from test_media_diffusion_training import options
from test_media_z_image_training import tiny_pipeline as z_image_pipeline


ARCHITECTURES = ("flux-2", "flux-2-klein-base-4b", "flux-2-klein-9b", "flux-2-klein-base-9b")


def tiny_pipeline(distilled):
    tokenizer = z_image_pipeline().tokenizer
    encoder = Qwen3ForCausalLM(Qwen3Config(vocab_size=len(tokenizer), hidden_size=64,
        intermediate_size=64, num_hidden_layers=28, num_attention_heads=2,
        num_key_value_heads=2, head_dim=32, max_position_embeddings=512,
        pad_token_id=0, eos_token_id=1, attention_dropout=0))
    vae = AutoencoderKLFlux2(down_block_types=("DownEncoderBlock2D",) * 2,
        up_block_types=("UpDecoderBlock2D",) * 2, block_out_channels=(8, 8),
        latent_channels=4, norm_num_groups=4, sample_size=64, layers_per_block=1)
    vae.bn.running_mean.copy_(torch.linspace(-0.3, 0.3, 16))
    vae.bn.running_var.copy_(torch.linspace(0.5, 1.5, 16))
    transformer = Flux2Transformer2DModel(in_channels=16, num_layers=1, num_single_layers=1,
        attention_head_dim=8, num_attention_heads=2, joint_attention_dim=192,
        axes_dims_rope=(2, 2, 2, 2), guidance_embeds=False)
    return Flux2KleinPipeline(vae=vae, transformer=transformer, tokenizer=tokenizer,
        text_encoder=encoder, scheduler=FlowMatchEulerDiscreteScheduler(num_train_timesteps=10),
        is_distilled=distilled)


class Flux2TrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)

    def test_methods_export_reload_generate_and_resume_exactly(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for architecture in ARCHITECTURES:
                distilled = architecture in ("flux-2", "flux-2-klein-9b")
                torch.manual_seed(11)
                pipeline = tiny_pipeline(distilled)
                base = root / architecture
                pipeline.save_pretrained(base, safe_serialization=True)
                original = {key: tensor.clone() for key, tensor in pipeline.transformer.state_dict().items()}
                for method in ("lora", "finetune", "embedding"):
                    with self.subTest(architecture=architecture, method=method):
                        job = root / f"{architecture}-{method}"
                        dataset = job / "dataset"
                        dataset.mkdir(parents=True)
                        trigger = "MiXeD" if method == "embedding" else "concept"
                        records = []
                        for index in range(3):
                            Image.new("RGB", (64, 64), (index * 60, 50, 150)).save(dataset / f"{index}.png")
                            records.append(json.dumps({"file_name": f"{index}.png", "text": f"a {trigger}"}))
                        (dataset / "metadata.jsonl").write_text("\n".join(records), encoding="utf-8")
                        spec = {**options(), "method": method, "architecture": architecture,
                            "model": {"architecture": architecture, "packageKind": "diffusers-directory", "path": str(base)},
                            "trigger_phrase": trigger, "four_bit": False, "attention_only": distilled,
                            "resolution": 64, "rank": 4, "learning_rate": 0.001, "steps": 2,
                            "resume": False, "seed": 42, "batch_size": 2, "gradient_accumulation": 2,
                            "lr_scheduler": "cosine", "warmup_steps": 1, "lora_dropout": 0.1}
                        loaded = []
                        load_pipeline = worker._load_pipeline

                        def capture(*arguments, **keywords):
                            model = load_pipeline(*arguments, **keywords)
                            loaded.append(model)
                            return model

                        with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                                patch("media_diffusers_worker._load_pipeline", side_effect=capture):
                            training.train(spec, job)
                        progress = json.loads((job / "progress.json").read_text())
                        self.assertEqual(progress["completedSteps"], 2)
                        self.assertTrue(torch.isfinite(torch.tensor(progress["loss"])))
                        cached = load_file(job / "conditioning.safetensors")
                        expected_keys = ("mean",) if method == "embedding" else ("mean", "prompt")
                        self.assertEqual(set(cached), {f"{index}.{key}" for index in range(3) for key in expected_keys})
                        self.assertEqual(cached["0.mean"].shape, (1, 16, 16, 16))
                        resumed = root / f"{architecture}-{method}-resume"
                        shutil.copytree(dataset, resumed / "dataset")
                        shutil.copyfile(job / "conditioning.safetensors", resumed / "conditioning.safetensors")
                        shutil.copytree(job / "output/checkpoint-1", resumed / "output/checkpoint-1")
                        with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)):
                            training.train({**spec, "resume": True}, resumed)
                        saved = load_file(job / "output/checkpoint-2/weights.safetensors")
                        restored = load_file(resumed / "output/checkpoint-2/weights.safetensors")
                        for key in saved:
                            torch.testing.assert_close(restored[key], saved[key], rtol=0, atol=0)
                        self.assertEqual(json.loads((resumed / "progress.json").read_text())["loss"], progress["loss"])
                        output = job / "output"
                        trained = Flux2KleinPipeline.from_pretrained(output / "model" if method == "finetune" else base,
                            local_files_only=True, use_safetensors=True)
                        if method == "finetune":
                            index = json.loads((output / "model/model_index.json").read_text())
                            self.assertEqual(index["_machdoch_training_architecture"], architecture)
                            self.assertEqual(trained.config.is_distilled, distilled)
                            self.assertTrue(any(not torch.equal(tensor, original[key])
                                for key, tensor in trained.transformer.state_dict().items()))
                        elif method == "lora":
                            trained.load_lora_weights(output, weight_name="pytorch_lora_weights.safetensors")
                            learned = load_file(output / "pytorch_lora_weights.safetensors")
                            self.assertTrue(any("to_qkv_mlp_proj" in key for key in learned))
                            self.assertEqual(any("ff.linear_in" in key for key in learned), not distilled)
                            self.assertTrue(any(tensor.abs().sum() > 0 for key, tensor in learned.items() if "lora_B" in key))
                            if distilled:
                                attention = trained.transformer.single_transformer_blocks[0].attn
                                fused = learned["transformer.single_transformer_blocks.0.attn.to_qkv_mlp_proj.lora_B.weight"]
                                output_adapter = learned["transformer.single_transformer_blocks.0.attn.to_out.lora_A.weight"]
                                self.assertEqual(torch.count_nonzero(fused[3 * attention.inner_dim:]).item(), 0)
                                self.assertEqual(torch.count_nonzero(output_adapter[:, attention.inner_dim:]).item(), 0)
                                self.assertGreater(torch.count_nonzero(fused[:3 * attention.inner_dim]).item(), 0)
                        else:
                            for key, tensor in loaded[0].transformer.state_dict().items():
                                torch.testing.assert_close(tensor, original[key], rtol=0, atol=0)
                            for key, tensor in loaded[0].text_encoder.state_dict().items():
                                if key.endswith(".vector"):
                                    continue
                                initial = pipeline.text_encoder.state_dict()[key.replace(".base.weight", ".weight")]
                                torch.testing.assert_close(tensor[:initial.shape[0]], initial, rtol=0, atol=0)
                            path = output / "learned_embeds.safetensors"
                            learned = load_file(path)
                            self.assertEqual(set(learned), {"flux2_qwen3"})
                            initial = trained.text_encoder.get_input_embeddings().weight[trained.tokenizer.encode("a", add_special_tokens=False)].mean(0)
                            self.assertFalse(torch.equal(learned["flux2_qwen3"].squeeze(0), initial))
                            worker._load_textual_inversion(trained, path, trigger, ["text-encoder"],
                                [{"component": "text-encoder", "tensorKey": "flux2_qwen3", "dimension": 64, "vectorCount": 1}])
                        image = trained(prompt=f"a {trigger}", height=64, width=64, num_inference_steps=2,
                            guidance_scale=1, generator=torch.Generator().manual_seed(12)).images[0]
                        self.assertEqual(image.size, (64, 64))

    def test_conditioning_matches_pipeline_and_rejects_truncation(self):
        pipeline = tiny_pipeline(False)
        pipeline.text_encoder.eval()
        prompts = ["a concept", "concept a"]
        with torch.no_grad():
            expected, _ = pipeline.encode_prompt(prompts, device="cpu")
            with patch.object(pipeline.text_encoder, "forward", wraps=pipeline.text_encoder.forward) as forward:
                actual = encode_flux2_prompts(pipeline, prompts, "cpu")
        self.assertEqual(forward.call_args.kwargs["logits_to_keep"], 1)
        torch.testing.assert_close(actual, expected, rtol=0, atol=0)
        from media_training_embeddings import prepare_embeddings

        prepare_embeddings(pipeline, "MiXeD", "a", "flux-2-klein-base-4b")
        with self.assertRaisesRegex(ValueError, "truncates"):
            encode_flux2_prompts(pipeline, ["a " * 600 + "MiXeD"], "cpu", ("MiXeD",))

    def test_non_square_batches_match_transformer_and_variant_validation(self):
        pipeline = tiny_pipeline(False)
        noisy = torch.randn(2, 16, 8, 12)
        timesteps = torch.tensor([1000.0, 250.0])
        batch = {"prompt": torch.randn(2, 8, 192)}
        with torch.no_grad(), patch.object(pipeline.transformer, "forward", wraps=pipeline.transformer.forward) as forward:
            prediction = training.predict_velocity(pipeline, noisy, timesteps, batch, 3.5, "flux-2-klein-base-4b")
        self.assertEqual(prediction.shape, noisy.shape)
        arguments = forward.call_args.kwargs
        self.assertEqual(arguments["img_ids"].shape, (2, 96, 4))
        self.assertEqual(arguments["txt_ids"].shape, (2, 8, 4))
        torch.testing.assert_close(arguments["timestep"], timesteps / 1000)
        self.assertIsNone(arguments["guidance"])
        spec = {**options(), "architecture": "flux-2", "model": {"architecture": "flux-2"},
            "trigger_phrase": "a", "four_bit": False, "resolution": 64, "rank": 4,
            "learning_rate": 0.001, "steps": 2, "seed": 42}
        with tempfile.TemporaryDirectory() as temporary, \
                patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                patch("media_diffusers_worker._load_pipeline", return_value=pipeline), \
                self.assertRaisesRegex(ValueError, "Klein Base or distilled"):
            training.train(spec, Path(temporary))

    def test_embedding_validation_counts_chat_template_tokens_in_both_channels(self):
        pipeline = tiny_pipeline(False)
        pipeline.tokenizer.add_tokens(["MiXeD"])
        token_id = pipeline.tokenizer.convert_tokens_to_ids("MiXeD")
        overflow = "a " * 511 + "MiXeD"
        self.assertIn(token_id, pipeline.tokenizer(overflow, truncation=True, max_length=512)["input_ids"])
        addon = {"kind": "textual-inversion", "token": "MiXeD", "placement": "both",
                 "embeddingVectors": [{"component": "text-encoder", "tensorKey": "flux2_qwen3",
                                       "registeredTokens": ["MiXeD"]}]}
        with self.assertRaisesRegex(worker.WorkerError, "positive prompt cannot fit"):
            worker._verify_embedding_prompt_tokens(pipeline, [addon], overflow, "a MiXeD")
        with self.assertRaisesRegex(worker.WorkerError, "negative prompt cannot fit"):
            worker._verify_embedding_prompt_tokens(pipeline, [addon], "a MiXeD", overflow)
        worker._verify_embedding_prompt_tokens(pipeline, [addon], "a MiXeD", "MiXeD a")
        self.assertEqual(addon["embeddingVectors"][0]["encodedTokenCounts"], {"positive": 1, "negative": 1})

    def test_embedding_conditioning_generates_with_both_prompt_channels(self):
        from media_training_embeddings import prepare_embeddings

        pipeline = tiny_pipeline(False)
        prepare_embeddings(pipeline, "MiXeD", "a", "flux-2-klein-base-4b")
        pipeline.text_encoder.eval()
        arguments = embedding_arguments(pipeline, "a MiXeD", "MiXeD a", "cpu", 4)
        self.assertEqual(set(arguments), {"prompt", "prompt_embeds", "negative_prompt_embeds"})
        self.assertFalse(arguments["prompt_embeds"].requires_grad)
        self.assertFalse(arguments["negative_prompt_embeds"].requires_grad)
        with torch.no_grad():
            expected = encode_flux2_prompts(pipeline, ["a MiXeD", "MiXeD a"], "cpu")
        torch.testing.assert_close(arguments["prompt_embeds"], expected[:1])
        torch.testing.assert_close(arguments["negative_prompt_embeds"], expected[1:])
        result = pipeline(**arguments, height=64, width=64, num_inference_steps=2,
                          guidance_scale=4, generator=torch.Generator().manual_seed(12))
        self.assertEqual(result.images[0].size, (64, 64))


if __name__ == "__main__":
    unittest.main()
