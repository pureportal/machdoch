from types import SimpleNamespace
import unittest

import torch
from transformers import CLIPTextConfig, CLIPTextModel

from media_sd_conditioning import encode_sd_prompt_pair
from test_media_sdxl_conditioning import FixtureTokenizer


class StableDiffusionConditioningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.manual_seed(26)
        config = CLIPTextConfig(vocab_size=64, hidden_size=8, intermediate_size=24,
                                num_hidden_layers=3, num_attention_heads=2,
                                max_position_embeddings=77, bos_token_id=0,
                                eos_token_id=1, pad_token_id=1)
        cls.pipeline = SimpleNamespace(tokenizer=FixtureTokenizer(),
                                       text_encoder=CLIPTextModel(config).eval(),
                                       maybe_convert_prompt=lambda texts, tokenizer: texts)
        cls.device = torch.device("cpu")

    def test_short_prompts_match_upstream_with_and_without_attention_masks(self):
        from diffusers import StableDiffusionPipeline

        prompt, negative = "woman holding a teddy bear", "blurry text"
        for masked in (False, True):
            with self.subTest(use_attention_mask=masked):
                self.pipeline.text_encoder.config.use_attention_mask = masked
                with torch.no_grad():
                    upstream = StableDiffusionPipeline.encode_prompt(
                        self.pipeline, prompt, self.device, 1, True, negative_prompt=negative)
                actual = encode_sd_prompt_pair(self.pipeline, prompt, negative, self.device)
                torch.testing.assert_close(actual["prompt_embeds"], upstream[0], atol=1e-6, rtol=1e-6)
                torch.testing.assert_close(actual["negative_prompt_embeds"], upstream[1], atol=1e-6, rtol=1e-6)

    def test_subject_after_first_context_window_changes_conditioning(self):
        self.pipeline.text_encoder.config.use_attention_mask = False
        prefix = "dark room " * 45
        first = encode_sd_prompt_pair(self.pipeline, prefix + "girl", "", self.device)
        second = encode_sd_prompt_pair(self.pipeline, prefix + "robot", "", self.device)
        self.assertEqual(first["prompt_embeds"].shape, (1, 154, 8))
        self.assertEqual(first["negative_prompt_embeds"].shape, first["prompt_embeds"].shape)
        torch.testing.assert_close(first["prompt_embeds"][:, :77], second["prompt_embeds"][:, :77])
        self.assertFalse(torch.equal(first["prompt_embeds"][:, 77:], second["prompt_embeds"][:, 77:]))

    def test_long_negative_prompt_keeps_positive_context_aligned(self):
        self.pipeline.text_encoder.config.use_attention_mask = True
        short = encode_sd_prompt_pair(self.pipeline, "a red teapot", "", self.device)
        long = encode_sd_prompt_pair(self.pipeline, "a red teapot", "blurry " * 170, self.device)
        self.assertEqual(long["prompt_embeds"].shape, (1, 231, 8))
        self.assertEqual(long["negative_prompt_embeds"].shape, long["prompt_embeds"].shape)
        torch.testing.assert_close(long["prompt_embeds"][:, :77], short["prompt_embeds"])


if __name__ == "__main__":
    unittest.main()
