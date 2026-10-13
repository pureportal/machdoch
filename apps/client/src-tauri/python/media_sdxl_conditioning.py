from __future__ import annotations

import math
from typing import Any

from media_clip_windows import clip_windows


def encode_sdxl_prompt_pair(pipeline: Any, prompt: str, negative_prompt: str, device: Any) -> dict[str, Any]:
    import torch

    tokenizers = [pipeline.tokenizer, pipeline.tokenizer_2]
    encoders = [pipeline.text_encoder, pipeline.text_encoder_2]
    context_sizes = [encoder.config.max_position_embeddings for encoder in encoders]
    if context_sizes[0] != context_sizes[1] or context_sizes[0] < 3:
        raise ValueError("SDXL text encoders must have matching context sizes")
    context_size = context_sizes[0]
    content_size = context_size - 2
    token_ids = [
        tokenizer(
            pipeline.maybe_convert_prompt([prompt, negative_prompt], tokenizer),
            add_special_tokens=False,
            truncation=False,
        )["input_ids"]
        for tokenizer in tokenizers
    ]
    chunk_count = max(1, max(math.ceil(len(ids) / content_size) for channels in token_ids for ids in channels))
    embeddings = []
    pooled = None
    with torch.no_grad():
        for tokenizer, encoder, channels in zip(tokenizers, encoders, token_ids, strict=True):
            input_ids, _ = clip_windows(tokenizer, channels, context_size, chunk_count, device)
            output = encoder(input_ids, output_hidden_states=True)
            hidden = output.hidden_states[-2]
            embeddings.append(hidden.reshape(2, chunk_count * context_size, hidden.shape[-1]))
            if encoder is encoders[-1]:
                pooled_chunks = output.text_embeds.reshape(2, chunk_count, -1)
                pooled = torch.stack([
                    pooled_chunks[channel_index, max(0, math.ceil(len(ids) / content_size) - 1)]
                    for channel_index, ids in enumerate(channels)
                ])
    combined = torch.cat(embeddings, dim=-1).to(dtype=pipeline.text_encoder_2.dtype)
    return {
        "prompt": None,
        "negative_prompt": None,
        "prompt_embeds": combined[:1],
        "negative_prompt_embeds": combined[1:],
        "pooled_prompt_embeds": pooled[:1],
        "negative_pooled_prompt_embeds": pooled[1:],
    }
