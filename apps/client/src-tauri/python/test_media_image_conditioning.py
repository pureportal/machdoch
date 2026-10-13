from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

import torch


SPEC = importlib.util.spec_from_file_location("conditioning", Path(__file__).with_name("media_image_conditioning.py"))
CONDITIONING = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONDITIONING)


class ImageConditioningTests(unittest.TestCase):
    def test_krea_raw_encodes_positive_and_unconditional_prompts_in_one_batch(self):
        tokenized_prompts = []

        class TokenBatch(dict):
            def __getattr__(self, key):
                return self[key]

            def to(self, device):
                return self

        def tokenize(prompts, **options):
            tokenized_prompts.append(prompts)
            length = options.get("max_length", 5)
            mask = torch.ones(len(prompts), length, dtype=torch.long)
            if length > 5:
                mask[0, 80:] = 0
                mask[1, 34:] = 0
            return TokenBatch(input_ids=torch.ones_like(mask), attention_mask=mask)

        def encode(**inputs):
            count, length = inputs["input_ids"].shape
            states = torch.arange(count, dtype=torch.float32).reshape(count, 1, 1).expand(count, length, 2)
            return SimpleNamespace(hidden_states=[states] * (max(CONDITIONING.KREA_TAP_LAYERS) + 1))

        tokenizer = mock.Mock(side_effect=tokenize)
        encoder = mock.Mock(side_effect=encode)
        encoder.to.return_value = encoder
        encoder.eval.return_value = encoder
        encoder.requires_grad_.return_value = encoder
        operations = SimpleNamespace(device=lambda _: torch.device("cpu"), cuda=SimpleNamespace(current_device=lambda: 0, empty_cache=lambda: None), cat=torch.cat, stack=torch.stack, bool=torch.bool, bfloat16=torch.bfloat16, inference_mode=torch.inference_mode)
        with mock.patch("transformers.AutoTokenizer.from_pretrained", return_value=tokenizer), mock.patch("transformers.Qwen3VLForConditionalGeneration.from_pretrained", return_value=encoder):
            embeddings, mask = CONDITIONING.encode_krea_prompts(operations, Path("unused"), ["An overgrown city", ""], [])
        self.assertEqual(tokenized_prompts[0], [CONDITIONING.KREA_PREFIX + "An overgrown city", CONDITIONING.KREA_PREFIX])
        self.assertEqual(encoder.call_count, 1)
        self.assertEqual(embeddings.shape, (2, 512, len(CONDITIONING.KREA_TAP_LAYERS), 2))
        self.assertEqual(mask.shape, (2, 512))
        self.assertGreater(int(mask[0].sum()), int(mask[1].sum()))
        self.assertTrue(torch.all(embeddings[0] == 0))
        self.assertTrue(torch.all(embeddings[1] == 1))

    def test_edit_strength_selects_the_end_of_the_original_schedule(self):
        self.assertEqual(CONDITIONING.krea_edit_sigmas(8, 1.0), [1.0, 0.875, 0.75, 0.625, 0.5, 0.375, 0.25, 0.125])
        self.assertEqual(CONDITIONING.krea_edit_sigmas(8, 0.5), [0.5, 0.375, 0.25, 0.125])
        with self.assertRaisesRegex(ValueError, "Increase edit strength"):
            CONDITIONING.krea_edit_sigmas(8, 0.1)

    def test_mask_preserves_the_re_noised_source_at_each_step(self):
        source = torch.tensor([[[2.0, 3.0, 4.0]]])
        noise = torch.tensor([[[10.0, 11.0, 12.0]]])
        mask = torch.tensor([[[0.0, 0.5, 1.0]]])
        pipeline = SimpleNamespace(scheduler=SimpleNamespace(sigmas=torch.tensor([1.0, 0.5, 0.0])))
        callback = CONDITIONING.preserve_krea_mask(source, noise, mask)
        result = callback(pipeline, 0, None, {"latents": torch.tensor([[[20.0, 20.0, 20.0]]])})
        torch.testing.assert_close(result["latents"], torch.tensor([[[6.0, 13.5, 20.0]]]))
        result = callback(pipeline, 1, None, {"latents": torch.tensor([[[20.0, 20.0, 20.0]]])})
        torch.testing.assert_close(result["latents"], torch.tensor([[[2.0, 11.5, 20.0]]]))

    def test_sdxl_roles_use_different_attention_blocks(self):
        for role in ("subject", "style", "composition"):
            self.assertEqual(CONDITIONING.ip_adapter_scale("pony", role, 0.8), CONDITIONING.ip_adapter_scale("stable-diffusion-xl", role, 0.8))
        self.assertEqual(CONDITIONING.ip_adapter_scale("stable-diffusion-xl", "style", 0.8), {"up": {"block_0": [0.0, 0.8, 0.0]}})
        self.assertEqual(CONDITIONING.ip_adapter_scale("stable-diffusion-xl", "composition", 0.8), {"down": {"block_2": [0.0, 0.8]}})
        self.assertAlmostEqual(CONDITIONING.ip_adapter_scale("stable-diffusion-1", "subject", 1), 0.7)
        with self.assertRaisesRegex(ValueError, "does not implement"):
            CONDITIONING.ip_adapter_scale("stable-diffusion-1", "style", 1)

    def test_krea_vision_keeps_every_image_token_and_reference_role(self):
        text = CONDITIONING.krea_vision_text("A ceramic teapot", [{"role": "subject"}, {"role": "palette"}])
        self.assertEqual(text.count("<|image_pad|>"), 2)
        self.assertIn("subject identity and appearance from image 1", text)
        self.assertIn("color palette from image 2", text)
        self.assertTrue(text.startswith(CONDITIONING.KREA_PREFIX))
        self.assertTrue(text.endswith("A ceramic teapot" + CONDITIONING.KREA_SUFFIX))


if __name__ == "__main__":
    unittest.main()
