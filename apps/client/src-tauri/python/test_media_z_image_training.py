import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from diffusers import AutoencoderKL, FlowMatchEulerDiscreteScheduler, ZImagePipeline, ZImageTransformer2DModel
from PIL import Image
from safetensors.torch import load_file
from tokenizers import Tokenizer, models, pre_tokenizers
from transformers import PreTrainedTokenizerFast, Qwen3Config, Qwen3Model

import media_diffusers_worker as worker
import media_flow_training as training
from test_media_diffusion_training import options


def tiny_pipeline(caption_dimension=64):
    vocabulary = {"<pad>": 0, "</s>": 1, "<unk>": 2, "a": 3, "concept": 4,
                  "<user>": 5, "<assistant>": 6, "<think>": 7}
    backend = Tokenizer(models.WordLevel(vocabulary, unk_token="<unk>"))
    backend.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=backend, model_max_length=512,
                                       pad_token="<pad>", eos_token="</s>", unk_token="<unk>")
    tokenizer.chat_template = "{% for message in messages %}<user> {{ message['content'] }} </s> {% endfor %}{% if add_generation_prompt %}<assistant> {% if enable_thinking %}<think>{% endif %}{% endif %}"
    encoder = Qwen3Model(Qwen3Config(vocab_size=len(vocabulary), hidden_size=caption_dimension,
                                    intermediate_size=128, num_hidden_layers=2, num_attention_heads=2,
                                    num_key_value_heads=2, head_dim=32, max_position_embeddings=512,
                                    pad_token_id=0, eos_token_id=1, attention_dropout=0))
    vae = AutoencoderKL(in_channels=3, out_channels=3, down_block_types=("DownEncoderBlock2D",) * 2,
                        up_block_types=("UpDecoderBlock2D",) * 2, block_out_channels=(8, 8),
                        latent_channels=4, norm_num_groups=4, sample_size=64,
                        scaling_factor=0.5, shift_factor=0.1)
    transformer = ZImageTransformer2DModel(in_channels=4, dim=32, n_layers=2, n_refiner_layers=1,
                                           n_heads=4, n_kv_heads=4, cap_feat_dim=caption_dimension,
                                           axes_dims=(2, 2, 4), axes_lens=(64, 64, 64))
    return ZImagePipeline(tokenizer=tokenizer, text_encoder=encoder, vae=vae, transformer=transformer,
                          scheduler=FlowMatchEulerDiscreteScheduler(num_train_timesteps=10, shift=3))


class ZImageTrainingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)

    def test_methods_export_reload_inference_and_exact_resume(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            torch.manual_seed(11)
            pipeline = tiny_pipeline()
            base = root / "base"
            pipeline.save_pretrained(base, safe_serialization=True)
            original = {key: value.clone() for key, value in pipeline.transformer.state_dict().items()}
            text_original = {key: value.clone() for key, value in pipeline.text_encoder.state_dict().items()}
            for architecture in ("z-image", "z-image-turbo"):
                for method in ("lora", "finetune"):
                    with self.subTest(architecture=architecture, method=method):
                        job = root / f"{architecture}-{method}"
                        dataset = job / "dataset"
                        dataset.mkdir(parents=True)
                        records = []
                        for index in range(3):
                            Image.new("RGB", (64, 64), (index * 60, 50, 150)).save(dataset / f"{index}.png")
                            records.append(json.dumps({"file_name": f"{index}.png", "text": "a " * (index + 1) + "concept"}))
                        (dataset / "metadata.jsonl").write_text("\n".join(records), encoding="utf-8")
                        spec = {**options(), "method": method, "architecture": architecture,
                                "model": {"architecture": architecture, "packageKind": "diffusers-directory", "path": str(base)},
                                "trigger_phrase": "concept", "four_bit": False, "attention_only": False,
                                "resolution": 64, "rank": 4, "learning_rate": 0.001, "steps": 2,
                                "resume": False, "seed": 42, "batch_size": 2, "gradient_accumulation": 2,
                                "lr_scheduler": "cosine", "warmup_steps": 1, "noise_offset": 0.05, "lora_dropout": 0.1}
                        with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)):
                            training.train(spec, job)
                        cache = load_file(job / "conditioning.safetensors")
                        self.assertEqual(set(cache), {f"{index}.{key}" for index in range(3) for key in ("mean", "prompt", "mask")})
                        self.assertEqual(cache["0.prompt"].shape, (1, 512, 64))
                        self.assertGreater(cache["2.mask"].sum(), cache["0.mask"].sum())
                        sample = training.read_dataset(dataset, 64, False)[0]
                        pixels = torch.from_numpy(sample["pixels"]).permute(2, 0, 1).unsqueeze(0)
                        with torch.no_grad():
                            torch.testing.assert_close(cache["0.mean"], pipeline.vae.encode(pixels).latent_dist.mode(), rtol=1e-5, atol=1e-5)
                            prompts, _ = pipeline.encode_prompt(prompt="a concept", device="cpu", do_classifier_free_guidance=False)
                            torch.testing.assert_close(cache["0.prompt"][0][cache["0.mask"][0]], prompts[0], rtol=0, atol=0)
                        output = job / "output"
                        resumed = root / f"{architecture}-{method}-resumed"
                        shutil.copytree(dataset, resumed / "dataset")
                        shutil.copyfile(job / "conditioning.safetensors", resumed / "conditioning.safetensors")
                        shutil.copytree(output / "checkpoint-1", resumed / "output/checkpoint-1")
                        with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)):
                            training.train({**spec, "resume": True}, resumed)
                        saved = load_file(output / "checkpoint-2/weights.safetensors")
                        restored = load_file(resumed / "output/checkpoint-2/weights.safetensors")
                        for key in saved:
                            torch.testing.assert_close(restored[key], saved[key], rtol=0, atol=0)
                        self.assertEqual(json.loads((resumed / "progress.json").read_text())["loss"], json.loads((job / "progress.json").read_text())["loss"])
                        trained = ZImagePipeline.from_pretrained(output / "model" if method == "finetune" else base,
                                                                 local_files_only=True, use_safetensors=True)
                        if method == "lora":
                            trained.load_lora_weights(output, weight_name="pytorch_lora_weights.safetensors")
                            learned = load_file(output / "pytorch_lora_weights.safetensors")
                            self.assertTrue(any(tensor.abs().sum() > 0 for key, tensor in learned.items() if "lora_B" in key))
                            self.assertTrue(any("feed_forward.w" in key for key in learned))
                        else:
                            self.assertEqual(json.loads((output / "model/model_index.json").read_text())["_machdoch_training_architecture"], architecture)
                            self.assertTrue(any(not torch.equal(value, original[key]) for key, value in trained.transformer.state_dict().items()))
                        for key, value in trained.text_encoder.state_dict().items():
                            torch.testing.assert_close(value, text_original[key], rtol=0, atol=0)
                        image = trained(prompt="a concept", height=64, width=64, num_inference_steps=2,
                                        guidance_scale=0, generator=torch.Generator().manual_seed(12)).images[0]
                        self.assertEqual(image.size, (64, 64))

    def test_ragged_captions_reversed_timesteps_and_prediction_sign(self):
        pipeline = tiny_pipeline()
        pipeline.transformer.eval()
        noisy = torch.randn((2, 4, 8, 16))
        timesteps = torch.tensor([1000.0, 250.0])
        batch = {"prompt": torch.randn((2, 8, 64)), "mask": torch.tensor([[1, 1, 1, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 0, 0, 0]])}
        with torch.no_grad(), patch.object(pipeline.transformer, "forward", wraps=pipeline.transformer.forward) as forward:
            prediction = training.predict_velocity(pipeline, noisy, timesteps, batch, 3.5, "z-image")
            arguments = forward.call_args.args
            self.assertEqual([value.shape for value in arguments[0]], [(4, 1, 8, 16)] * 2)
            torch.testing.assert_close(arguments[1], torch.tensor([0.0, 0.75]), rtol=0, atol=0)
            self.assertEqual([value.shape for value in arguments[2]], [(3, 64), (5, 64)])
            expected = pipeline.transformer(*arguments, return_dict=False)[0]
        torch.testing.assert_close(prediction, -torch.stack(expected).squeeze(2), rtol=0, atol=0)

    def test_invalid_methods_model_memory_and_options_rejected_before_dataset(self):
        spec = {**options(), "architecture": "z-image", "model": {"architecture": "z-image"},
                "trigger_phrase": "concept", "four_bit": False, "resolution": 64, "rank": 4,
                "learning_rate": 0.001, "steps": 2, "seed": 42}
        for invalid in ({"method": "unknown"}, {"snr_gamma": 5}, {"four_bit": True}, {"model": {"architecture": "z-image-turbo"}}):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                training.validate_settings({**spec, **invalid})
        with tempfile.TemporaryDirectory() as temporary, patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), patch("media_flow_training.read_dataset") as read_dataset:
            with patch("media_diffusers_worker._load_pipeline", return_value=object()):
                with self.assertRaisesRegex(ValueError, "pipeline does not match"):
                    training.train(spec, Path(temporary))
            with patch("media_diffusers_worker._load_pipeline", return_value=tiny_pipeline()), patch("media_diffusers_worker._physical_memory_bytes", return_value=1):
                with self.assertRaisesRegex(ValueError, "weights, gradients"):
                    training.train({**spec, "method": "finetune"}, Path(temporary))
                with self.assertRaisesRegex(ValueError, "base transformer"):
                    training.train(spec, Path(temporary))
            read_dataset.assert_not_called()


if __name__ == "__main__":
    unittest.main()
