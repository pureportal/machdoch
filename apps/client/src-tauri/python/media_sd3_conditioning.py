from __future__ import annotations

import torch

from media_embedding_prompts import expand_embedding_prompt


def encode_sd3_prompts(pipeline, prompts: list[str], device, required_tokens: tuple[str, ...] = ()):
    components = (
        (pipeline.tokenizer, pipeline.text_encoder, pipeline.tokenizer_max_length),
        (pipeline.tokenizer_2, pipeline.text_encoder_2, pipeline.tokenizer_max_length),
        (pipeline.tokenizer_3, pipeline.text_encoder_3, 256),
    )
    encoded = []
    for tokenizer, encoder, maximum in components:
        if tokenizer is None or encoder is None:
            raise ValueError("Choose an SD3 model with all three text encoders for embedding training.")
        expanded = [expand_embedding_prompt(prompt, tokenizer) for prompt in prompts]
        tokens = tokenizer(expanded, padding="max_length", max_length=maximum,
                           truncation=True, return_tensors="pt")
        inputs = tokens.input_ids.to(device)
        for token in required_tokens:
            token_id = tokenizer.convert_tokens_to_ids(token)
            if not (inputs == token_id).any(dim=1).all():
                raise ValueError("A caption truncates the embedding token. Shorten the caption or put the token first.")
        encoded.append(inputs)
    clip = [encoder(inputs, output_hidden_states=True)
            for (_, encoder, _), inputs in zip(components[:2], encoded[:2])]
    t5 = pipeline.text_encoder_3(encoded[2], output_hidden_states=False).last_hidden_state
    hidden = torch.cat([output.hidden_states[-2] for output in clip], dim=-1)
    hidden = torch.nn.functional.pad(hidden, (0, t5.shape[-1] - hidden.shape[-1]))
    prompt = torch.cat([hidden, t5], dim=-2).to(dtype=pipeline.transformer.dtype)
    pooled = torch.cat([output.text_embeds for output in clip], dim=-1).to(dtype=pipeline.transformer.dtype)
    return prompt, pooled
