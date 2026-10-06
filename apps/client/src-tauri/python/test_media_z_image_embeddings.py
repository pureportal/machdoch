import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import torch
from diffusers import ZImagePipeline
from PIL import Image
from safetensors.torch import load_file, save_file

import media_diffusers_worker as worker
import media_flow_training as training
from media_z_image_conditioning import encode_z_image_prompts
from test_media_diffusion_training import options
from test_media_z_image_training import tiny_pipeline


class ZImageEmbeddingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(1)

    def test_embeddings_change_only_the_vector_resume_exactly_and_generate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            torch.manual_seed(11)
            pipeline = tiny_pipeline()
            base = root / "base"
            pipeline.save_pretrained(base, safe_serialization=True)
            frozen = {name: {key: value.clone() for key, value in component.state_dict().items()}
                      for name, component in (("transformer", pipeline.transformer), ("vae", pipeline.vae),
                                               ("text_encoder", pipeline.text_encoder))}
            initial = pipeline.text_encoder.get_input_embeddings().weight[4].detach().clone()
            loader = worker._load_pipeline
            loaded = []

            def observe(*arguments, **keywords):
                trained = loader(*arguments, **keywords)
                loaded.append(trained)
                return trained

            for architecture in ("z-image", "z-image-turbo"):
                with self.subTest(architecture=architecture):
                    job = root / architecture
                    dataset = job / "dataset"
                    dataset.mkdir(parents=True)
                    records = []
                    for index in range(3):
                        Image.new("RGB", (64, 64), (index * 60, 50, 150)).save(dataset / f"{index}.png")
                        records.append(json.dumps({"file_name": f"{index}.png", "text": "a " * (index + 1) + "<MiXeDConcept>"}))
                    (dataset / "metadata.jsonl").write_text("\n".join(records), encoding="utf-8")
                    spec = {**options(), "method": "embedding", "architecture": architecture,
                            "model": {"architecture": architecture, "packageKind": "diffusers-directory", "path": str(base)},
                            "trigger_phrase": "<MiXeDConcept>", "initializer_token": "concept", "four_bit": False,
                            "resolution": 64, "rank": 4, "learning_rate": 0.001, "steps": 2,
                            "resume": False, "seed": 42, "batch_size": 2, "gradient_accumulation": 2,
                            "lr_scheduler": "constant", "warmup_steps": 1, "noise_offset": 0}
                    with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), patch("media_diffusers_worker._load_pipeline", side_effect=observe):
                        training.train(spec, job)
                    trained = loaded[-1]
                    trainable = [parameter for parameter in trained.text_encoder.parameters() if parameter.requires_grad]
                    self.assertEqual(len(trainable), 1)
                    self.assertEqual(trainable[0].numel(), 64)
                    self.assertTrue(torch.isfinite(trainable[0]).all())
                    self.assertFalse(torch.equal(trainable[0].detach(), initial))
                    for name in ("transformer", "vae"):
                        component = getattr(trained, name)
                        self.assertFalse(any(parameter.requires_grad for parameter in component.parameters()))
                        for key, value in component.state_dict().items():
                            torch.testing.assert_close(value, frozen[name][key], rtol=0, atol=0)
                    for key, value in frozen["text_encoder"].items():
                        current = trained.text_encoder.get_input_embeddings().base.weight[:-1] if key == "embed_tokens.weight" else trained.text_encoder.state_dict()[key]
                        torch.testing.assert_close(current, value, rtol=0, atol=0)
                    cache = load_file(job / "conditioning.safetensors")
                    self.assertEqual(set(cache), {f"{index}.mean" for index in range(3)})
                    sample = training.read_dataset(dataset, 64, False)[0]
                    pixels = torch.from_numpy(sample["pixels"]).permute(2, 0, 1).unsqueeze(0)
                    with torch.no_grad():
                        torch.testing.assert_close(cache["0.mean"], pipeline.vae.encode(pixels).latent_dist.mode(), rtol=1e-5, atol=1e-5)
                    resumed = root / f"{architecture}-resumed"
                    shutil.copytree(dataset, resumed / "dataset")
                    shutil.copyfile(job / "conditioning.safetensors", resumed / "conditioning.safetensors")
                    shutil.copytree(job / "output/checkpoint-1", resumed / "output/checkpoint-1")
                    with patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)):
                        training.train({**spec, "resume": True}, resumed)
                    learned = load_file(job / "output/learned_embeds.safetensors")
                    self.assertEqual(set(learned), {"z_image_qwen3"})
                    torch.testing.assert_close(learned["z_image_qwen3"], load_file(resumed / "output/learned_embeds.safetensors")["z_image_qwen3"], rtol=0, atol=0)
                    self.assertEqual(json.loads((job / "progress.json").read_text())["loss"], json.loads((resumed / "progress.json").read_text())["loss"])
                    reloaded = ZImagePipeline.from_pretrained(base, local_files_only=True, use_safetensors=True)
                    profiles = worker._load_textual_inversion(reloaded, job / "output/learned_embeds.safetensors", "<MiXeDConcept>",
                        ["text-encoder"], [{"tensorKey": "z_image_qwen3", "component": "text-encoder", "vectorCount": 1, "dimension": 64}])
                    applied = [{"kind": "textual-inversion", "token": "<MiXeDConcept>", "placement": "positive", "embeddingVectors": profiles}]
                    worker._verify_embedding_prompt_tokens(reloaded, applied, "a <MiXeDConcept>", "")
                    self.assertEqual(profiles[0]["encodedTokenCounts"], {"positive": 1})
                    guidance = 0 if architecture == "z-image-turbo" else 4
                    arguments = worker._z_image_embedding_arguments(reloaded, "a <MiXeDConcept>", "", "cpu", guidance)
                    image = reloaded(**arguments, height=64, width=64, num_inference_steps=9 if guidance == 0 else 4,
                                     guidance_scale=guidance, generator=torch.Generator().manual_seed(12)).images[0]
                    self.assertEqual(image.size, (64, 64))

    def test_conditioning_matches_the_pipeline_and_chat_truncation_fails_before_encoding(self):
        pipeline = tiny_pipeline()
        pipeline.text_encoder.eval()
        prompts = ["a concept", "a a a concept"]
        with torch.no_grad():
            expected, _ = pipeline.encode_prompt(prompt=list(prompts), device="cpu", do_classifier_free_guidance=False)
            with patch.object(pipeline.text_encoder, "forward", wraps=pipeline.text_encoder.forward) as forward:
                prompt, mask = encode_z_image_prompts(pipeline, prompts, "cpu")
                self.assertEqual(forward.call_args.kwargs["logits_to_keep"], 1)
        for hidden, valid, original in zip(prompt, mask, expected):
            torch.testing.assert_close(hidden[valid], original, rtol=0, atol=0)
        pipeline.tokenizer.add_tokens(["<MiXeDConcept>"])
        pipeline.text_encoder.resize_token_embeddings(len(pipeline.tokenizer), mean_resizing=False)
        with patch.object(pipeline.text_encoder, "forward", wraps=pipeline.text_encoder.forward) as forward:
            with self.assertRaisesRegex(ValueError, "truncates"):
                encode_z_image_prompts(pipeline, ["a " * 511 + "<MiXeDConcept>"], "cpu", ("<MiXeDConcept>",))
            forward.assert_not_called()
        applied = [{"kind": "textual-inversion", "token": "<MiXeDConcept>", "placement": "positive",
                    "embeddingVectors": [{"component": "text-encoder", "tensorKey": "z_image_qwen3", "registeredTokens": ["<MiXeDConcept>"]}]}]
        with self.assertRaisesRegex(worker.WorkerError, "cannot fit"):
            worker._verify_embedding_prompt_tokens(pipeline, applied, "a " * 511 + "<MiXeDConcept>", "")

    def test_embedding_memory_is_checked_before_dataset_preparation(self):
        pipeline = tiny_pipeline()
        capacity = sum(parameter.numel() * parameter.element_size() for parameter in pipeline.transformer.parameters()) + 1
        specification = {**options(), "architecture": "z-image", "model": {"architecture": "z-image"},
                         "method": "embedding", "trigger_phrase": "<MiXeDConcept>", "initializer_token": "concept",
                         "four_bit": False, "resolution": 64, "rank": 4, "learning_rate": 0.001, "steps": 2, "seed": 42}
        with tempfile.TemporaryDirectory() as temporary, patch("media_diffusers_worker._device", return_value=("cpu", "CPU test", None)), patch("media_diffusers_worker._load_pipeline", return_value=pipeline), patch("media_diffusers_worker._physical_memory_bytes", return_value=capacity), patch("media_flow_training.read_dataset") as read_dataset:
            with self.assertRaisesRegex(ValueError, "transformer and text encoders"):
                training.train(specification, Path(temporary))
            read_dataset.assert_not_called()

    def test_case_sensitive_multi_vector_aliases_reach_both_conditioning_channels(self):
        pipeline = tiny_pipeline()
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "vectors.safetensors"
            save_file({"z_image_qwen3": torch.randn(2, 64)}, str(path))
            profiles = worker._load_textual_inversion(pipeline, path, "<MiXeDConcept>", ["text-encoder"],
                [{"component": "text-encoder", "tensorKey": "z_image_qwen3", "vectorCount": 2, "dimension": 64}])
            applied = [{"kind": "textual-inversion", "token": "<MiXeDConcept>", "placement": "both", "embeddingVectors": profiles}]
            worker._verify_embedding_prompt_tokens(pipeline, applied, "a <MiXeDConcept>", "<MiXeDConcept>")
            self.assertEqual(profiles[0]["encodedTokenCounts"], {"positive": 2, "negative": 2})
            arguments = worker._z_image_embedding_arguments(pipeline, "a <MiXeDConcept>", "<MiXeDConcept>", "cpu", 4)
            self.assertEqual(len(arguments["prompt_embeds"]), 1)
            self.assertEqual(len(arguments["negative_prompt_embeds"]), 1)
            self.assertEqual(arguments["prompt_embeds"][0].shape[0], 7)
            self.assertEqual(arguments["negative_prompt_embeds"][0].shape[0], 6)


if __name__ == "__main__":
    unittest.main()
