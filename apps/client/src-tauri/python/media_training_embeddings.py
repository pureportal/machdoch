from __future__ import annotations

from typing import Any

import torch
from transformers import AddedToken


class TokenEmbedding(torch.nn.Module):
    def __init__(self, base: Any, token_id: int, initial: Any):
        super().__init__()
        self.base = base
        self.token_id = token_id
        self.vector = torch.nn.Parameter(initial.detach().float().clone())

    @property
    def weight(self):
        return self.base.weight

    def forward(self, input_ids):
        original = self.base(input_ids)
        return torch.where((input_ids == self.token_id).unsqueeze(-1),
                           self.vector.to(original.dtype), original)


def prepare_embeddings(pipeline: Any, token: str, initializer: str, architecture: str) -> dict:
    embeddings = {}
    key = ("gemma" if architecture == "sana" else "z_image_qwen3" if architecture.startswith("z-image")
           else "flux2_qwen3" if architecture.startswith("flux-2")
           else "cogvideox_t5" if architecture.startswith("cogvideox-")
           else "wan_umt5" if architecture.startswith("wan-") else "clip_l")
    components = [(key, pipeline.tokenizer, pipeline.text_encoder)]
    if architecture in ("stable-diffusion-xl", "pony"):
        components.append(("clip_g", pipeline.tokenizer_2, pipeline.text_encoder_2))
    elif architecture == "stable-diffusion-3":
        components.extend((("clip_g", pipeline.tokenizer_2, pipeline.text_encoder_2),
                           ("t5", pipeline.tokenizer_3, pipeline.text_encoder_3)))
    elif architecture.startswith("flux-1"):
        components.append(("t5", pipeline.tokenizer_2, pipeline.text_encoder_2))
    if any(tokenizer is None or encoder is None for _, tokenizer, encoder in components):
        raise ValueError("Choose an SD3 model with all three text encoders for embedding training.")
    for key, tokenizer, encoder in components:
        initial_ids = tokenizer.encode(initializer, add_special_tokens=False)
        if not initial_ids:
            raise ValueError("Enter an initializer word for the embedding.")
        if tokenizer.add_tokens([AddedToken(token, normalized=False, single_word=True)]) != 1:
            raise ValueError("Choose an embedding token that is not already in the base model.")
        encoder.resize_token_embeddings(len(tokenizer), mean_resizing=False)
        encoder.requires_grad_(False)
        base = encoder.get_input_embeddings()
        initial = base.weight[initial_ids].mean(dim=0)
        embedding = TokenEmbedding(base, tokenizer.convert_tokens_to_ids(token), initial)
        encoder.set_input_embeddings(embedding)
        embeddings[key] = embedding
    return embeddings


def encode_captions(pipeline: Any, captions: list[str], device: str, xl: bool):
    hidden = []
    pooled = None
    components = [(pipeline.tokenizer, pipeline.text_encoder)]
    if xl:
        components.append((pipeline.tokenizer_2, pipeline.text_encoder_2))
    for tokenizer, encoder in components:
        tokens = tokenizer(captions, padding="max_length", max_length=tokenizer.model_max_length,
                           truncation=True, return_tensors="pt")
        inputs = tokens.input_ids.to(device)
        embedding = encoder.get_input_embeddings()
        if isinstance(embedding, TokenEmbedding) and not (inputs == embedding.token_id).any(dim=1).all():
            raise ValueError("A caption truncates the embedding token. Shorten the caption or put the token first.")
        mask = {"attention_mask": tokens.attention_mask.to(device)} if getattr(encoder.config, "use_attention_mask", False) else {}
        output = encoder(inputs, output_hidden_states=xl, **mask)
        hidden.append(output.hidden_states[-2] if xl else output.last_hidden_state)
        if xl and encoder is pipeline.text_encoder_2:
            pooled = output.text_embeds
    return torch.cat(hidden, dim=-1), pooled


def encode_flux_captions(pipeline: Any, captions: list[str], device: str):
    encoded = []
    for tokenizer, encoder, maximum in (
        (pipeline.tokenizer, pipeline.text_encoder, pipeline.tokenizer_max_length),
        (pipeline.tokenizer_2, pipeline.text_encoder_2, 256),
    ):
        tokens = tokenizer(captions, padding="max_length", max_length=maximum,
                           truncation=True, return_tensors="pt")
        inputs = tokens.input_ids.to(device)
        embedding = encoder.get_input_embeddings()
        if not (inputs == embedding.token_id).any(dim=1).all():
            raise ValueError("A caption truncates the embedding token. Shorten the caption or put the token first.")
        encoded.append(inputs)
    prompt = pipeline.text_encoder_2(encoded[1], output_hidden_states=False).last_hidden_state
    pooled = pipeline.text_encoder(encoded[0], output_hidden_states=False).pooler_output
    return prompt, pooled
