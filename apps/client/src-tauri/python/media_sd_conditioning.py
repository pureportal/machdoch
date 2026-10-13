import math
from typing import Any

from media_clip_windows import clip_windows


def encode_sd_prompt_pair(pipeline: Any, prompt: str, negative_prompt: str, device: Any) -> dict[str, Any]:
    import torch

    tokenizer, encoder = pipeline.tokenizer, pipeline.text_encoder
    context_size = encoder.config.max_position_embeddings
    if context_size < 3:
        raise ValueError("The Stable Diffusion text encoder context is too small")
    channels = tokenizer(pipeline.maybe_convert_prompt([prompt, negative_prompt], tokenizer),
                         add_special_tokens=False, truncation=False)["input_ids"]
    chunk_count = max(1, max(math.ceil(len(ids) / (context_size - 2)) for ids in channels))
    input_ids, attention_mask = clip_windows(tokenizer, channels, context_size, chunk_count, device)
    if not getattr(encoder.config, "use_attention_mask", False):
        attention_mask = None
    with torch.no_grad():
        hidden = encoder(input_ids, attention_mask=attention_mask)[0]
    embeddings = hidden.reshape(2, chunk_count * context_size, hidden.shape[-1]).to(dtype=encoder.dtype)
    return {"prompt": None, "negative_prompt": None,
            "prompt_embeds": embeddings[:1], "negative_prompt_embeds": embeddings[1:]}
