from __future__ import annotations

import torch

from media_training_embeddings import TokenEmbedding


MAX_SEQUENCE_LENGTH = 512


def encode_prompts(pipeline, captions, device, tokens=()):
    from diffusers.pipelines.wan.pipeline_wan import prompt_clean
    from diffusers.utils.torch_utils import get_module_execution_device
    from media_embedding_prompts import expand_embedding_prompt

    cleaned = [prompt_clean(expand_embedding_prompt(caption, pipeline.tokenizer)) for caption in captions]
    inputs = pipeline.tokenizer(cleaned, padding="max_length", max_length=MAX_SEQUENCE_LENGTH,
                                truncation=True, add_special_tokens=True,
                                return_attention_mask=True, return_tensors="pt")
    embedding = pipeline.text_encoder.get_input_embeddings()
    required = list(tokens)
    if isinstance(embedding, TokenEmbedding):
        required.append(pipeline.tokenizer.convert_ids_to_tokens(embedding.token_id))
    for token in required:
        identifier = pipeline.tokenizer.convert_tokens_to_ids(token)
        if not (inputs.input_ids == identifier).any(dim=1).all():
            raise ValueError("A caption truncates the embedding token. Shorten the caption or put the token first.")
    encoder_device = get_module_execution_device(pipeline.text_encoder)
    hidden = pipeline.text_encoder(inputs.input_ids.to(encoder_device),
                                   inputs.attention_mask.to(encoder_device)).last_hidden_state
    hidden = hidden.to(device=device, dtype=pipeline.transformer.dtype)
    return hidden * inputs.attention_mask.to(device=device).unsqueeze(-1)


def embedding_arguments(pipeline, prompt, negative, device, guidance):
    return {"prompt": None, "negative_prompt": None,
            "prompt_embeds": encode_prompts(pipeline, [prompt], device),
            "negative_prompt_embeds": encode_prompts(pipeline, [negative], device) if guidance > 1 else None,
            "max_sequence_length": MAX_SEQUENCE_LENGTH}


def normalize_latents(pipeline, latents):
    mean = latents.new_tensor(pipeline.vae.config.latents_mean).view(1, -1, 1, 1, 1)
    std = latents.new_tensor(pipeline.vae.config.latents_std).view(1, -1, 1, 1, 1)
    if mean.shape[1] != latents.shape[1] or std.shape[1] != latents.shape[1] or not (std > 0).all():
        raise ValueError("The Wan VAE latent statistics do not match its channels.")
    return (latents - mean) / std
