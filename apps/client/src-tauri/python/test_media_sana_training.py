import json
import math
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from diffusers import AutoencoderDC, DPMSolverMultistepScheduler, SanaPipeline, SanaTransformer2DModel
from PIL import Image
from safetensors.torch import load_file
from tokenizers import Tokenizer, models, pre_tokenizers, processors
from transformers import Gemma2Config, Gemma2Model, PreTrainedTokenizerFast

import media_flow_training as training
import media_diffusers_worker as worker
from media_sana_conditioning import encode_sana_prompts
from test_media_diffusion_training import options


def tiny_pipeline(gemma_dimension=64):
    backend = Tokenizer(models.WordLevel({"<pad>": 0, "</s>": 1, "<unk>": 2, "a": 3, "concept": 4}, unk_token="<unk>"))
    backend.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    backend.post_processor = processors.TemplateProcessing(single="$A </s>", special_tokens=[("</s>", 1)])
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend, model_max_length=512,
                                       pad_token="<pad>", eos_token="</s>", unk_token="<unk>", padding_side="right")
    encoder = Gemma2Model(Gemma2Config(
        vocab_size=5, hidden_size=gemma_dimension, intermediate_size=128, num_hidden_layers=1,
        num_attention_heads=2, num_key_value_heads=2, head_dim=32, max_position_embeddings=512,
        pad_token_id=0, eos_token_id=1, bos_token_id=1, attention_dropout=0,
    ))
    vae = AutoencoderDC(
        latent_channels=4, attention_head_dim=4,
        encoder_block_out_channels=(8, 8, 8, 8), decoder_block_out_channels=(8, 8, 8, 8),
        encoder_layers_per_block=(1, 1, 1, 1), decoder_layers_per_block=(1, 1, 1, 1),
        encoder_qkv_multiscales=((), (), (), ()), decoder_qkv_multiscales=((), (), (), ()),
        encoder_out_shortcut=False, decoder_in_shortcut=False, scaling_factor=0.5,
    )
    transformer = SanaTransformer2DModel(
        in_channels=4, out_channels=4, num_layers=2, num_attention_heads=2, attention_head_dim=8,
        num_cross_attention_heads=2, cross_attention_head_dim=8, cross_attention_dim=16,
        caption_channels=gemma_dimension, mlp_ratio=2, sample_size=32, patch_size=1,
    )
    return SanaPipeline(tokenizer=tokenizer, text_encoder=encoder, vae=vae, transformer=transformer,
                         scheduler=DPMSolverMultistepScheduler(num_train_timesteps=10, use_flow_sigmas=True,
                                                              prediction_type="flow_prediction", flow_shift=3))


class SanaTrainingTests(unittest.TestCase):
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
            text_original = {key: tensor.clone() for key, tensor in pipeline.text_encoder.state_dict().items()}
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
                    spec = {**options(), "method": method, "architecture": "sana",
                            "model": {"architecture": "sana", "packageKind": "diffusers-directory", "path": str(base)},
                            "trigger_phrase": trigger, "initializer_token": "concept", "four_bit": False, "attention_only": False,
                            "resolution": 64, "rank": 4, "learning_rate": 0.001, "steps": 2,
                            "resume": False, "seed": 42, "batch_size": 2, "gradient_accumulation": 2,
                            "lr_scheduler": "cosine", "warmup_steps": 1, "noise_offset": 0.05, "lora_dropout": 0.1}
                    loaded = []
                    load_pipeline = worker._load_pipeline

                    def load(*arguments, **keywords):
                        model = load_pipeline(*arguments, **keywords)
                        loaded.append(model)
                        return model

                    with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                            patch("media_diffusers_worker._load_pipeline", side_effect=load), \
                            patch("transformers.modeling_utils.checkpoint", wraps=torch.utils.checkpoint.checkpoint) as checkpoint:
                        training.train(spec, job)
                    if method == "embedding":
                        self.assertGreater(checkpoint.call_count, 0)
                        for key, tensor in loaded[0].transformer.state_dict().items():
                            torch.testing.assert_close(tensor, original[key], rtol=0, atol=0)
                        for key, tensor in loaded[0].text_encoder.state_dict().items():
                            if key.endswith(".vector"):
                                continue
                            source = text_original[key.replace(".base.weight", ".weight")]
                            torch.testing.assert_close(tensor[:source.shape[0]], source, rtol=0, atol=0)
                    progress = json.loads((job / "progress.json").read_text())
                    self.assertEqual(progress["completedSteps"], 2)
                    self.assertTrue(torch.isfinite(torch.tensor(progress["loss"])))
                    cache = load_file(job / "conditioning.safetensors")
                    self.assertNotIn("0.std", cache)
                    if method == "embedding":
                        self.assertEqual(set(cache), {f"{index}.mean" for index in range(3)})
                    else:
                        self.assertEqual(cache["0.mask"].shape, (1, 300))
                        self.assertTrue(torch.any(cache["0.mask"] == 0))
                    sample = training.read_dataset(dataset, 64, False)[0]
                    pixels = torch.from_numpy(sample["pixels"]).permute(2, 0, 1).unsqueeze(0)
                    with torch.no_grad():
                        torch.testing.assert_close(cache["0.mean"], pipeline.vae.encode(pixels).latent, rtol=1e-5, atol=1e-5)
                    output = job / "output"
                    resumed = root / f"{method}-resume"
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
                    trained = SanaPipeline.from_pretrained(output / "model" if method == "finetune" else base,
                                                           local_files_only=True, use_safetensors=True)
                    if method == "lora":
                        trained.load_lora_weights(output, weight_name="pytorch_lora_weights.safetensors")
                        learned = load_file(output / "pytorch_lora_weights.safetensors")
                        self.assertTrue(any(tensor.abs().sum() > 0 for key, tensor in learned.items() if "lora_B" in key))
                        self.assertTrue(any("ff.conv" in key for key in learned))
                    elif method == "finetune":
                        config = json.loads((output / "model/scheduler/scheduler_config.json").read_text())
                        self.assertTrue(all(not isinstance(value, float) or math.isfinite(value) for value in config.values()))
                        self.assertEqual(trained.scheduler.config.lambda_min_clipped, float("-inf"))
                        self.assertTrue(any(not torch.equal(tensor, original[key]) for key, tensor in trained.transformer.state_dict().items()))
                    for key, tensor in trained.text_encoder.state_dict().items():
                        torch.testing.assert_close(tensor, text_original[key], rtol=0, atol=0)
                    arguments = {"prompt": f"a {trigger}"}
                    if method == "embedding":
                        path = output / "learned_embeds.safetensors"
                        learned = load_file(path)
                        self.assertEqual(set(learned), {"gemma"})
                        self.assertFalse(torch.equal(learned["gemma"].squeeze(0), text_original["embed_tokens.weight"][4]))
                        profiles = [{"tensorKey": "gemma", "component": "text-encoder", "dimension": 64, "vectorCount": 1}]
                        worker._load_textual_inversion(trained, path, trigger, ["text-encoder"], profiles)
                        arguments = worker._sana_embedding_arguments(trained, f"a {trigger}", "", "cpu", 1)
                    image = trained(**arguments, height=64, width=64, num_inference_steps=2, guidance_scale=1,
                                    max_sequence_length=16, complex_human_instruction=None, use_resolution_binning=False,
                                    generator=torch.Generator().manual_seed(12)).images[0]
                    self.assertEqual(image.size, (64, 64))

    def test_non_square_batches_forward_mask_and_unscaled_timesteps(self):
        pipeline = tiny_pipeline()
        pipeline.transformer.eval()
        noisy = torch.randn((2, 4, 8, 16))
        timesteps = torch.tensor([1000.0, 250.0])
        batch = {"prompt": torch.randn((2, 8, 64)), "mask": torch.tensor([[1, 1, 1, 0, 0, 0, 0, 0]] * 2)}
        with torch.no_grad(), patch.object(pipeline.transformer, "forward", wraps=pipeline.transformer.forward) as forward:
            prediction = training.predict_velocity(pipeline, noisy, timesteps, batch, 3.5, "sana")
        self.assertEqual(prediction.shape, noisy.shape)
        torch.testing.assert_close(forward.call_args.kwargs["timestep"], timesteps, rtol=0, atol=0)
        torch.testing.assert_close(forward.call_args.kwargs["encoder_attention_mask"], batch["mask"], rtol=0, atol=0)

    def test_invalid_methods_memory_and_pipeline_rejected_before_dataset(self):
        spec = {**options(), "architecture": "sana", "model": {"architecture": "sana"},
                "trigger_phrase": "concept", "four_bit": False, "resolution": 64, "rank": 4,
                "learning_rate": 0.001, "steps": 2, "seed": 42}
        for invalid in ({"method": "unknown"}, {"snr_gamma": 5}, {"four_bit": True}, {"model": {"architecture": "sana-sprint"}}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                training.validate_settings({**spec, **invalid})
        with tempfile.TemporaryDirectory() as temporary, \
                patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), \
                patch("media_flow_training.read_dataset") as read_dataset:
            with patch("media_diffusers_worker._load_pipeline", return_value=object()):
                with self.assertRaisesRegex(ValueError, "pipeline does not match"):
                    training.train(spec, Path(temporary))
            with patch("media_diffusers_worker._load_pipeline", return_value=tiny_pipeline()), \
                    patch("media_diffusers_worker._physical_memory_bytes", return_value=1):
                with self.assertRaisesRegex(ValueError, "Use BF16 Adafactor, LoRA, or a device with more memory"):
                    training.train({**spec, "method": "finetune"}, Path(temporary))
                with self.assertRaisesRegex(ValueError, "before trainable weights and activations"):
                    training.train(spec, Path(temporary))
            read_dataset.assert_not_called()

    def test_embedding_case_multi_vectors_negative_prompt_and_sequence_limit(self):
        from safetensors.torch import save_file

        pipeline = tiny_pipeline()
        pipeline.text_encoder.eval()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "learned.safetensors"
            vectors = torch.randn(2, 64)
            save_file({"gemma": vectors}, path)
            profiles = [{"tensorKey": "gemma", "component": "text-encoder", "dimension": 64, "vectorCount": 2}]
            loaded = worker._load_textual_inversion(pipeline, path, "<MiXeD>", ["text-encoder"], profiles)
            applied = [{"kind": "textual-inversion", "placement": "both", "token": "<MiXeD>", "embeddingVectors": loaded}]
            worker._verify_embedding_prompt_tokens(pipeline, applied, "a <MiXeD>", "<MiXeD>")
            self.assertEqual(loaded[0]["encodedTokenCounts"], {"positive": 2, "negative": 2})
            self.assertEqual(loaded[0]["maxSequenceLength"], 300)
            with patch.object(pipeline.text_encoder, "forward", wraps=pipeline.text_encoder.forward) as forward:
                arguments = worker._sana_embedding_arguments(pipeline, "a <MiXeD>", "<MiXeD>", "cpu", 4.5)
            inputs = forward.call_args.args[0]
            for alias in loaded[0]["registeredTokens"]:
                self.assertTrue((inputs == pipeline.tokenizer.convert_tokens_to_ids(alias)).any(dim=1).all())
            self.assertEqual(arguments["prompt_attention_mask"].shape, (1, 300))
            self.assertEqual(arguments["negative_prompt_attention_mask"].shape, (1, 300))
            pipeline(**arguments, height=64, width=64, num_inference_steps=2, guidance_scale=4.5,
                     use_resolution_binning=False, generator=torch.Generator().manual_seed(12))
            long_caption = "a " * 300 + "<MiXeD>"
            with self.assertRaisesRegex(worker.WorkerError, "cannot fit all vectors"):
                worker._verify_embedding_prompt_tokens(pipeline, applied, long_caption, "<MiXeD>")
            with self.assertRaisesRegex(ValueError, "truncates the embedding token"), \
                    patch.object(pipeline.text_encoder, "forward") as forward:
                encode_sana_prompts(pipeline, [long_caption], "cpu", ("<MiXeD>",))
            forward.assert_not_called()


if __name__ == "__main__":
    unittest.main()
