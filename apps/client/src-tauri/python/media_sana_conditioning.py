from __future__ import annotations

from media_embedding_prompts import expand_embedding_prompt


def encode_sana_prompts(pipeline, prompts: list[str], device, required_tokens: tuple[str, ...] = ()):
    tokenizer = pipeline.tokenizer
    tokenizer.padding_side = "right"
    expanded = [expand_embedding_prompt(prompt.strip(), tokenizer) for prompt in prompts]
    tokens = tokenizer(expanded, padding="max_length", max_length=300, truncation=True,
                       add_special_tokens=True, return_tensors="pt")
    inputs = tokens.input_ids.to(device)
    for token in required_tokens:
        token_id = tokenizer.convert_tokens_to_ids(token)
        if not (inputs == token_id).any(dim=1).all():
            raise ValueError("A caption truncates the embedding token. Shorten the caption or put the token first.")
    mask = tokens.attention_mask.to(device)
    prompt = pipeline.text_encoder(inputs, attention_mask=mask)[0]
    return prompt.to(device=device, dtype=pipeline.transformer.dtype), mask
