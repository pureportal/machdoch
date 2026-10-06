from __future__ import annotations

from media_embedding_prompts import expand_embedding_prompt


def encode_z_image_prompts(pipeline, prompts: list[str], device, required_tokens: tuple[str, ...] = ()):
    tokenizer = pipeline.tokenizer
    formatted = [tokenizer.apply_chat_template(
        [{"role": "user", "content": expand_embedding_prompt(prompt, tokenizer)}],
        tokenize=False, add_generation_prompt=True, enable_thinking=True,
    ) for prompt in prompts]
    tokens = tokenizer(formatted, padding="max_length", max_length=512, truncation=True, return_tensors="pt")
    inputs = tokens.input_ids.to(device)
    for token in required_tokens:
        token_id = tokenizer.convert_tokens_to_ids(token)
        if not (inputs == token_id).any(dim=1).all():
            raise ValueError("A caption truncates the embedding token. Shorten the caption or put the token first.")
    mask = tokens.attention_mask.to(device).bool()
    prompt = pipeline.text_encoder(input_ids=inputs, attention_mask=mask, output_hidden_states=True,
                                   use_cache=False, logits_to_keep=1).hidden_states[-2]
    return prompt.to(device=device, dtype=pipeline.transformer.dtype), mask
