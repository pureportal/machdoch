import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch
from diffusers import StableDiffusionXLPipeline, UNet2DConditionModel
from peft import LoraConfig
from peft.utils import get_peft_model_state_dict
from PIL import Image

import media_sdxl_training as training


class SdxlTrainingTests(unittest.TestCase):
    def test_dataset_retains_microconditioning_and_rejects_parent_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            records = []
            for index in range(3):
                Image.new("RGB", (80, 40), "red").save(root / f"{index}.png")
                records.append(
                    json.dumps(
                        {"file_name": f"{index}.png", "text": f"red object {index}"}
                    )
                )
            (root / "metadata.jsonl").write_text("\n".join(records), encoding="utf-8")
            samples = training.read_dataset(root, 32)
            self.assertEqual(samples[0]["time_ids"], [40, 80, 0, 16, 32, 32])
            self.assertEqual(samples[0]["pixels"].shape, (32, 32, 3))
            np.testing.assert_array_equal(samples[0]["pixels"][0, 0], [1, -1, -1])
            spec = {
                "model": {"digest": "real-model"},
                "precision": "bf16",
                "resolution": 32,
            }
            original = training.dataset_signature(spec, samples)
            samples[0]["caption"] = "different caption"
            self.assertNotEqual(original, training.dataset_signature(spec, samples))
            (root / "metadata.jsonl").write_text(
                json.dumps({"file_name": "../outside.png", "text": "caption"}),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "inside the dataset"):
                training.read_dataset(root, 32)

    def test_velocity_target_uses_scheduler_and_unknown_target_fails(self):
        scheduler = SimpleNamespace(
            config=SimpleNamespace(prediction_type="v_prediction"),
            get_velocity=lambda latents, noise, timesteps: latents + noise,
        )
        result = training.noise_target(
            scheduler, torch.ones(2), torch.full((2,), 2), torch.tensor([1])
        )
        torch.testing.assert_close(result, torch.full((2,), 3.0))
        scheduler.config.prediction_type = "sample"
        with self.assertRaisesRegex(ValueError, "scheduler"):
            training.noise_target(scheduler, None, None, None)

    def test_resume_restores_adapter_optimizer_and_random_sequence(self):
        torch.manual_seed(19)
        model = UNet2DConditionModel(
            sample_size=8,
            in_channels=4,
            out_channels=4,
            layers_per_block=1,
            block_out_channels=(8,),
            down_block_types=("CrossAttnDownBlock2D",),
            up_block_types=("CrossAttnUpBlock2D",),
            cross_attention_dim=6,
            norm_num_groups=4,
            attention_head_dim=2,
        )
        model.requires_grad_(False)
        model.add_adapter(
            LoraConfig(
                r=4, lora_alpha=4, target_modules=["to_q", "to_k", "to_v", "to_out.0"]
            )
        )
        optimizer = torch.optim.AdamW(
            [parameter for parameter in model.parameters() if parameter.requires_grad],
            lr=0.001,
        )
        scaler = torch.amp.GradScaler("cpu", enabled=False)
        generator = torch.Generator().manual_seed(32)

        def update():
            optimizer.zero_grad(set_to_none=True)
            latents = torch.randn((1, 4, 8, 8), generator=generator)
            prompt = torch.randn((1, 3, 6), generator=generator)
            prediction = model(latents, 1, prompt).sample
            prediction.square().mean().backward()
            optimizer.step()

        update()
        settings = {"seed": 32, "rank": 4}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            training.save_checkpoint(
                root,
                1,
                model,
                optimizer,
                scaler,
                generator,
                "cpu",
                "signature",
                settings,
            )
            update()
            uninterrupted = {
                key: value.clone()
                for key, value in get_peft_model_state_dict(model).items()
            }
            expected_random = torch.rand(3, generator=generator)
            step = training.restore_checkpoint(
                root, model, optimizer, scaler, generator, "cpu", "signature", settings
            )
            self.assertEqual(step, 1)
            update()
            for key, tensor in get_peft_model_state_dict(model).items():
                torch.testing.assert_close(tensor, uninterrupted[key], rtol=0, atol=0)
            torch.testing.assert_close(
                torch.rand(3, generator=generator), expected_random, rtol=0, atol=0
            )
            with self.assertRaisesRegex(ValueError, "changed"):
                training.restore_checkpoint(
                    root,
                    model,
                    optimizer,
                    scaler,
                    generator,
                    "cpu",
                    "different",
                    settings,
                )
            for step in (2, 3):
                training.save_checkpoint(
                    root,
                    step,
                    model,
                    optimizer,
                    scaler,
                    generator,
                    "cpu",
                    "signature",
                    settings,
                )
            self.assertEqual(
                [path.name for path in training.checkpoints(root)],
                ["checkpoint-2", "checkpoint-3"],
            )
            adapter_weights = get_peft_model_state_dict(model)
            StableDiffusionXLPipeline.save_lora_weights(
                str(root), unet_lora_layers=adapter_weights, safe_serialization=True
            )
            restored = copy.deepcopy(model)
            restored.delete_adapters("default")
            restored.load_lora_adapter(
                str(root),
                adapter_name="loaded",
                prefix="unet",
                weight_name="pytorch_lora_weights.safetensors",
                use_safetensors=True,
            )
            loaded_weights = get_peft_model_state_dict(restored, adapter_name="loaded")
            self.assertEqual(set(loaded_weights), set(adapter_weights))
            for key in adapter_weights:
                torch.testing.assert_close(
                    loaded_weights[key], adapter_weights[key], rtol=0, atol=0
                )

    def test_invalid_training_settings_fail_before_loading_model(self):
        spec = {
            "architecture": "stable-diffusion-xl",
            "model": {"architecture": "stable-diffusion-xl"},
            "four_bit": False,
            "attention_only": True,
            "precision": "bf16",
            "steps": 4,
            "resolution": 512,
            "rank": 4,
            "learning_rate": 0.0001,
            "seed": 42,
            "checkpoint_interval": 2,
        }
        training.validate_settings(spec)
        for key, value in [
            ("four_bit", True),
            ("attention_only", False),
            ("steps", 0),
            ("steps", True),
            ("seed", -1),
            ("rank", 3),
            ("resolution", 640),
            ("checkpoint_interval", 0),
            ("learning_rate", float("nan")),
        ]:
            invalid = copy.deepcopy(spec)
            invalid[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                training.validate_settings(invalid)


if __name__ == "__main__":
    unittest.main()
