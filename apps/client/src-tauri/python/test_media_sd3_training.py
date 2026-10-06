import copy
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from diffusers import AutoencoderKL, FlowMatchEulerDiscreteScheduler, SD3Transformer2DModel, StableDiffusion3Pipeline
from PIL import Image
from safetensors.torch import load_file
from tokenizers import Tokenizer, models, pre_tokenizers, processors
from transformers import CLIPTextConfig, CLIPTextModelWithProjection, CLIPTokenizer, PreTrainedTokenizerFast, T5Config, T5EncoderModel

import media_flow_training as training
import media_diffusers_worker as worker
from media_sd3_conditioning import encode_sd3_prompts
from test_media_diffusion_training import options


def tiny_pipeline(clip_dimensions=(16, 16), t5_dimension=64):
    tokenizer = CLIPTokenizer(vocab={"<|startoftext|>": 0, "<|endoftext|>": 1, "a</w>": 2}, merges=[], model_max_length=16)
    clip_configs = [CLIPTextConfig(vocab_size=len(tokenizer), hidden_size=dimension, intermediate_size=dimension * 2,
                                  num_hidden_layers=2, num_attention_heads=2, max_position_embeddings=16,
                                  projection_dim=dimension, bos_token_id=0, eos_token_id=1, pad_token_id=1)
                    for dimension in clip_dimensions]
    backend = Tokenizer(models.WordLevel({"<pad>": 0, "</s>": 1, "<unk>": 2, "a": 3, "concept": 4}, unk_token="<unk>"))
    backend.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    backend.post_processor = processors.TemplateProcessing(single="$A </s>", special_tokens=[("</s>", 1)])
    tokenizer_3 = PreTrainedTokenizerFast(tokenizer_object=backend, model_max_length=16,
                                          pad_token="<pad>", eos_token="</s>", unk_token="<unk>")
    transformer = SD3Transformer2DModel(sample_size=32, patch_size=2, in_channels=4,
                                        num_layers=2, attention_head_dim=8, num_attention_heads=2,
                                        joint_attention_dim=t5_dimension, caption_projection_dim=16,
                                        pooled_projection_dim=sum(clip_dimensions), out_channels=4, pos_embed_max_size=64)
    vae = AutoencoderKL(in_channels=3, out_channels=3,
                        down_block_types=("DownEncoderBlock2D", "DownEncoderBlock2D"),
                        up_block_types=("UpDecoderBlock2D", "UpDecoderBlock2D"),
                        block_out_channels=(8, 8), latent_channels=4, norm_num_groups=4,
                        sample_size=64, scaling_factor=0.5, shift_factor=0.1)
    return StableDiffusion3Pipeline(
        vae=vae, transformer=transformer, scheduler=FlowMatchEulerDiscreteScheduler(num_train_timesteps=10, shift=3),
        text_encoder=CLIPTextModelWithProjection(clip_configs[0]),
        text_encoder_2=CLIPTextModelWithProjection(clip_configs[1]),
        text_encoder_3=T5EncoderModel(T5Config(vocab_size=5, d_model=t5_dimension, d_ff=64, d_kv=16,
                                              num_layers=1, num_heads=4, dropout_rate=0)),
        tokenizer=tokenizer, tokenizer_2=copy.deepcopy(tokenizer), tokenizer_3=tokenizer_3,
    )


class Sd3TrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)

    def test_all_methods_export_reload_inference_and_exact_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            torch.manual_seed(11)
            pipeline = tiny_pipeline()
            base = root / "base"
            pipeline.save_pretrained(base, safe_serialization=True)
            original = {key: tensor.clone() for key, tensor in pipeline.transformer.state_dict().items()}
            text_original = {key: tensor.clone() for key, tensor in pipeline.text_encoder_3.state_dict().items()}
            originals = [{key: tensor.clone() for key, tensor in encoder.state_dict().items()}
                         for encoder in (pipeline.text_encoder, pipeline.text_encoder_2, pipeline.text_encoder_3)]
            for method in ("lora", "finetune", "embedding"):
                with self.subTest(method=method):
                    trigger = "<MiXeDConcept>" if method == "embedding" else "concept"
                    job = root / method
                    dataset = job / "dataset"
                    dataset.mkdir(parents=True)
                    records = []
                    for index in range(3):
                        Image.new("RGB", (64, 64), (index * 60, 50, 150)).save(dataset / f"{index}.png")
                        records.append(json.dumps({"file_name": f"{index}.png", "text": f"a {trigger}"}))
                    (dataset / "metadata.jsonl").write_text("\n".join(records), encoding="utf-8")
                    spec = {**options(), "method": method, "architecture": "stable-diffusion-3",
                            "model": {"architecture": "stable-diffusion-3", "packageKind": "diffusers-directory", "path": str(base)},
                            "trigger_phrase": trigger, "initializer_token": "a", "four_bit": False, "attention_only": False,
                            "resolution": 64, "rank": 4, "learning_rate": 0.001, "steps": 2,
                            "resume": False, "seed": 42, "batch_size": 2, "gradient_accumulation": 2,
                            "lr_scheduler": "cosine", "warmup_steps": 1, "noise_offset": 0.05,
                            "lora_dropout": 0.1}
                    loaded = []
                    load_pipeline = worker._load_pipeline

                    def load(*arguments, **keywords):
                        model = load_pipeline(*arguments, **keywords)
                        loaded.append(model)
                        return model

                    with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                            patch("media_diffusers_worker._load_pipeline", side_effect=load):
                        training.train(spec, job)
                    if method == "embedding":
                        for key, tensor in loaded[0].transformer.state_dict().items():
                            torch.testing.assert_close(tensor, original[key], rtol=0, atol=0)
                        for encoder, initial in zip((loaded[0].text_encoder, loaded[0].text_encoder_2, loaded[0].text_encoder_3), originals):
                            for key, tensor in encoder.state_dict().items():
                                if key.endswith(".vector"):
                                    continue
                                source = initial[key.replace(".base.weight", ".weight")]
                                torch.testing.assert_close(tensor[:source.shape[0]], source, rtol=0, atol=0)
                    progress = json.loads((job / "progress.json").read_text())
                    self.assertEqual(progress["completedSteps"], 2)
                    self.assertTrue(torch.isfinite(torch.tensor(progress["loss"])))
                    cache = load_file(job / "conditioning.safetensors")
                    if method == "embedding":
                        self.assertEqual(set(cache), {f"{index}.{key}" for index in range(3) for key in ("mean", "std")})
                    else:
                        self.assertEqual(cache["0.prompt"].shape[-1], 64)
                        self.assertEqual(cache["0.pooled"].shape[-1], 32)
                    output = job / "output"
                    resumed = root / f"{method}-resume"
                    shutil.copytree(dataset, resumed / "dataset")
                    shutil.copyfile(job / "conditioning.safetensors", resumed / "conditioning.safetensors")
                    shutil.copytree(output / "checkpoint-1", resumed / "output/checkpoint-1")
                    with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)):
                        training.train({**spec, "resume": True}, resumed)
                    uninterrupted_weights = load_file(output / "checkpoint-2/weights.safetensors")
                    resumed_weights = load_file(resumed / "output/checkpoint-2/weights.safetensors")
                    for key in uninterrupted_weights:
                        torch.testing.assert_close(resumed_weights[key], uninterrupted_weights[key], rtol=0, atol=0)
                    self.assertEqual(json.loads((resumed / "progress.json").read_text())["loss"], progress["loss"])
                    trained = StableDiffusion3Pipeline.from_pretrained(
                        output / "model" if method == "finetune" else base,
                        local_files_only=True, use_safetensors=True,
                    )
                    if method == "lora":
                        trained.load_lora_weights(output, weight_name="pytorch_lora_weights.safetensors")
                        learned = load_file(output / "pytorch_lora_weights.safetensors")
                        self.assertTrue(any(tensor.abs().sum() > 0 for key, tensor in learned.items() if "lora_B" in key))
                        self.assertTrue(any("add_q_proj" in key for key in learned))
                        self.assertTrue(any("ff_context" in key for key in learned))
                    elif method == "finetune":
                        self.assertTrue(any(not torch.equal(tensor, original[key]) for key, tensor in trained.transformer.state_dict().items()))
                    for key, tensor in trained.text_encoder_3.state_dict().items():
                        torch.testing.assert_close(tensor, text_original[key], rtol=0, atol=0)
                    arguments = {"prompt": f"a {trigger}"}
                    if method == "embedding":
                        path = output / "learned_embeds.safetensors"
                        learned = load_file(path)
                        self.assertEqual(set(learned), {"clip_l", "clip_g", "t5"})
                        profiles = []
                        for key, component, encoder, tokenizer in (
                            ("clip_l", "text-encoder", trained.text_encoder, trained.tokenizer),
                            ("clip_g", "text-encoder-2", trained.text_encoder_2, trained.tokenizer_2),
                            ("t5", "text-encoder-3", trained.text_encoder_3, trained.tokenizer_3),
                        ):
                            initial = encoder.get_input_embeddings().weight[tokenizer.encode("a", add_special_tokens=False)].mean(dim=0)
                            self.assertFalse(torch.equal(learned[key].squeeze(0), initial))
                            profiles.append({"tensorKey": key, "component": component,
                                             "dimension": learned[key].shape[-1], "vectorCount": 1})
                        worker._load_textual_inversion(trained, path, trigger, [item["component"] for item in profiles], profiles)
                        arguments = worker._sd3_embedding_arguments(trained, f"a {trigger}", "", "cpu", 1)
                    image = trained(**arguments, height=64, width=64, num_inference_steps=2,
                                    guidance_scale=1, max_sequence_length=16,
                                    generator=torch.Generator().manual_seed(12)).images[0]
                    self.assertEqual(image.size, (64, 64))
                    image.save(job / "generated.png")

    def test_flow_objective_and_invalid_options(self):
        latents = torch.tensor([1.0, 2.0])
        noise = torch.tensor([3.0, 1.0])
        velocity = (noise - latents).requires_grad_()
        loss = training.flow_matching_loss(velocity, latents, noise)
        self.assertEqual(loss.item(), 0)
        loss.backward()
        self.assertTrue(torch.equal(velocity.grad, torch.zeros_like(velocity)))
        specification = {**options(), "architecture": "stable-diffusion-3",
                         "model": {"architecture": "stable-diffusion-3"}, "trigger_phrase": "a",
                         "four_bit": False, "resolution": 64, "rank": 4, "learning_rate": 0.001,
                         "steps": 2, "seed": 42}
        for invalid in ({"method": "unknown"}, {"snr_gamma": 5}, {"four_bit": True}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                training.validate_settings({**specification, **invalid})

    def test_embedding_encoding_matches_pipeline_and_checks_every_encoder_before_forward(self):
        from media_training_embeddings import prepare_embeddings

        pipeline = tiny_pipeline()
        prepare_embeddings(pipeline, "<MiXeD>", "a", "stable-diffusion-3")
        for encoder in (pipeline.text_encoder, pipeline.text_encoder_2, pipeline.text_encoder_3):
            encoder.eval()
        captions = ["a <MiXeD>", "<MiXeD> a"]
        with torch.no_grad():
            prompt, pooled = encode_sd3_prompts(pipeline, captions, "cpu", ("<MiXeD>",))
            expected, _, expected_pooled, _ = pipeline.encode_prompt(
                captions, prompt_2=None, prompt_3=None, device="cpu",
                do_classifier_free_guidance=False, max_sequence_length=256)
        torch.testing.assert_close(prompt, expected, rtol=0, atol=0)
        torch.testing.assert_close(pooled, expected_pooled, rtol=0, atol=0)
        for maximum, repetitions in ((16, 16), (300, 256)):
            with self.subTest(maximum=maximum), \
                    patch.object(pipeline, "tokenizer_max_length", maximum), \
                    patch.object(pipeline.text_encoder, "forward") as clip_l, \
                    patch.object(pipeline.text_encoder_2, "forward") as clip_g, \
                    patch.object(pipeline.text_encoder_3, "forward") as t5, \
                    self.assertRaisesRegex(ValueError, "truncates the embedding token"):
                encode_sd3_prompts(pipeline, ["a " * repetitions + "<MiXeD>"], "cpu", ("<MiXeD>",))
            clip_l.assert_not_called()
            clip_g.assert_not_called()
            t5.assert_not_called()
        missing = tiny_pipeline()
        missing.text_encoder_3 = None
        with self.assertRaisesRegex(ValueError, "all three text encoders"):
            prepare_embeddings(missing, "<MiXeD>", "a", "stable-diffusion-3")
        self.assertNotIn("<MiXeD>", missing.tokenizer.get_vocab())

    def test_case_sensitive_multi_vectors_are_encoded_in_both_prompt_channels(self):
        import hashlib
        from safetensors.torch import save_file

        pipeline = tiny_pipeline(clip_dimensions=(64, 64), t5_dimension=256)
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "learned.safetensors"
            vectors = {"clip_l": torch.randn(2, 64), "clip_g": torch.randn(2, 64), "t5": torch.randn(2, 256)}
            save_file(vectors, path)
            profiles = [{"tensorKey": key, "component": component, "dimension": vectors[key].shape[-1], "vectorCount": 2}
                        for key, component in (("clip_l", "text-encoder"), ("clip_g", "text-encoder-2"), ("t5", "text-encoder-3"))]
            addon = {"kind": "textual-inversion", "enabled": True, "addonId": "test:sd3",
                     "digest": hashlib.sha256(path.read_bytes()).hexdigest(), "path": str(path.resolve()),
                     "targetComponents": [item["component"] for item in profiles], "embeddingVectors": profiles,
                     "token": "<MiXeD>", "placement": "both"}
            prompt, negative, applied, _, _, _ = worker._apply_addons(pipeline, [addon], "a", "")
            self.assertEqual([item["encodedTokenCounts"] for item in applied[0]["embeddingVectors"]],
                             [{"positive": 2, "negative": 2}] * 3)
            with patch.object(pipeline.text_encoder, "forward", wraps=pipeline.text_encoder.forward) as clip_l, \
                    patch.object(pipeline.text_encoder_2, "forward", wraps=pipeline.text_encoder_2.forward) as clip_g, \
                    patch.object(pipeline.text_encoder_3, "forward", wraps=pipeline.text_encoder_3.forward) as t5:
                arguments = worker._sd3_embedding_arguments(pipeline, prompt, negative, "cpu", 3.5)
            for forward, tokenizer in zip((clip_l, clip_g, t5), (pipeline.tokenizer, pipeline.tokenizer_2, pipeline.tokenizer_3)):
                for alias in ("<MiXeD>", "<MiXeD>_1"):
                    self.assertTrue((forward.call_args.args[0] == tokenizer.convert_tokens_to_ids(alias)).any(dim=1).all())
            image = pipeline(**arguments, height=64, width=64, num_inference_steps=2, guidance_scale=3.5,
                             generator=torch.Generator().manual_seed(12)).images[0]
            self.assertEqual(image.size, (64, 64))

    def test_finetune_rejects_insufficient_memory_before_preparing_images(self):
        specification = {**options(), "method": "finetune", "architecture": "stable-diffusion-3",
                         "model": {"architecture": "stable-diffusion-3"}, "trigger_phrase": "a",
                         "four_bit": False, "resolution": 64, "rank": 4, "learning_rate": 0.001,
                         "steps": 2, "seed": 42}
        with tempfile.TemporaryDirectory() as temporary, \
                patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                patch("media_diffusers_worker._physical_memory_bytes", return_value=1), \
                patch("media_diffusers_worker._load_pipeline", return_value=tiny_pipeline()), \
                patch("media_flow_training.read_dataset") as read_dataset:
            with self.assertRaisesRegex(ValueError, "Use BF16 Adafactor, LoRA, or a device with more memory"):
                training.train(specification, Path(temporary))
            read_dataset.assert_not_called()


if __name__ == "__main__":
    unittest.main()
