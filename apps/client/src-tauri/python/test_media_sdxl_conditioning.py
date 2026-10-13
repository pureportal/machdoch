from types import SimpleNamespace
import unittest

import torch
from transformers import BatchEncoding, CLIPTextConfig, CLIPTextModel, CLIPTextModelWithProjection

from media_sdxl_conditioning import encode_sdxl_prompt_pair


class FixtureTokenizer:
    bos_token_id = 0
    eos_token_id = 1
    pad_token_id = 1
    model_max_length = 77

    def __call__(self, texts, *, add_special_tokens=True, padding=None, max_length=None, truncation=False, return_tensors=None):
        rows = []
        masks = []
        for text in [texts] if isinstance(texts, str) else texts:
            ids = [2 + sum(word.encode()) % 62 for word in text.split()]
            if add_special_tokens:
                ids = [self.bos_token_id, *ids, self.eos_token_id]
            if truncation and max_length is not None and len(ids) > max_length:
                ids = ids[:max_length - 1] + [self.eos_token_id]
            mask = [1] * len(ids)
            if padding == "max_length":
                mask += [0] * (max_length - len(ids))
                ids += [self.pad_token_id] * (max_length - len(ids))
            rows.append(ids)
            masks.append(mask)
        return BatchEncoding({"input_ids": torch.tensor(rows) if return_tensors == "pt" else rows,
                              "attention_mask": torch.tensor(masks) if return_tensors == "pt" else masks})

    def batch_decode(self, tokens):
        return [str(row) for row in tokens]


class SdxlConditioningTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.manual_seed(14)
        def config(width):
            return CLIPTextConfig(vocab_size=64, hidden_size=width, intermediate_size=24, num_hidden_layers=3,
                                  num_attention_heads=2, max_position_embeddings=77, projection_dim=12,
                                  bos_token_id=0, eos_token_id=1, pad_token_id=1)
        cls.pipeline = SimpleNamespace(
            tokenizer=FixtureTokenizer(), tokenizer_2=FixtureTokenizer(),
            text_encoder=CLIPTextModel(config(8)).eval(),
            text_encoder_2=CLIPTextModelWithProjection(config(12)).eval(),
            _execution_device=torch.device("cpu"),
            config=SimpleNamespace(force_zeros_for_empty_prompt=False),
            maybe_convert_prompt=lambda texts, tokenizer: texts,
        )

    def test_short_prompts_match_upstream_sdxl_conditioning(self):
        from diffusers import StableDiffusionXLPipeline

        prompt, negative = "white haired woman overlooking overgrown ruins", "blurry text watermark"
        with torch.no_grad():
            upstream = StableDiffusionXLPipeline.encode_prompt(self.pipeline, prompt, device=torch.device("cpu"), negative_prompt=negative)
        actual = encode_sdxl_prompt_pair(self.pipeline, prompt, negative, torch.device("cpu"))
        for key, expected in zip(["prompt_embeds", "negative_prompt_embeds", "pooled_prompt_embeds", "negative_pooled_prompt_embeds"], upstream, strict=True):
            torch.testing.assert_close(actual[key], expected, atol=1e-6, rtol=1e-6)

    def test_tokens_after_the_first_clip_window_change_conditioning(self):
        prefix = "ruins " * 90
        first = encode_sdxl_prompt_pair(self.pipeline, prefix + "red", "blurry", torch.device("cpu"))
        second = encode_sdxl_prompt_pair(self.pipeline, prefix + "blue", "blurry", torch.device("cpu"))
        self.assertEqual(first["prompt_embeds"].shape, (1, 154, 20))
        self.assertEqual(first["negative_prompt_embeds"].shape, first["prompt_embeds"].shape)
        torch.testing.assert_close(first["prompt_embeds"][:, :77], second["prompt_embeds"][:, :77])
        self.assertFalse(torch.equal(first["prompt_embeds"][:, 77:], second["prompt_embeds"][:, 77:]))
        self.assertFalse(torch.equal(first["pooled_prompt_embeds"], second["pooled_prompt_embeds"]))

    def test_long_negative_prompts_preserve_positive_pooled_conditioning(self):
        from diffusers import StableDiffusionXLPipeline

        prompt = "a red teapot"
        actual = encode_sdxl_prompt_pair(self.pipeline, prompt, "blurry " * 170, torch.device("cpu"))
        with torch.no_grad():
            upstream = StableDiffusionXLPipeline.encode_prompt(self.pipeline, prompt, device=torch.device("cpu"), negative_prompt="")
        self.assertEqual(actual["prompt_embeds"].shape, (1, 231, 20))
        torch.testing.assert_close(actual["pooled_prompt_embeds"], upstream[2], atol=1e-6, rtol=1e-6)


if __name__ == "__main__":
    unittest.main()
