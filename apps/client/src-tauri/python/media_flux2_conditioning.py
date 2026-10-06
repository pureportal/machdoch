from __future__ import annotations

import torch

from media_embedding_prompts import expand_embedding_prompt


def encode_flux2_prompts(pipeline, prompts: list[str], device, required_tokens: tuple[str, ...] = ()):
    tokenizer = pipeline.tokenizer
    formatted = [tokenizer.apply_chat_template(
        [{"role": "user", "content": expand_embedding_prompt(prompt, tokenizer)}],
        tokenize=False, add_generation_prompt=True, enable_thinking=False,
    ) for prompt in prompts]
    tokens = tokenizer(formatted, padding="max_length", max_length=512,
                       truncation=True, return_tensors="pt")
    inputs = tokens.input_ids.to(device)
    for token in required_tokens:
        token_id = tokenizer.convert_tokens_to_ids(token)
        if not (inputs == token_id).any(dim=1).all():
            raise ValueError("A caption truncates the embedding token. Shorten the caption or put the token first.")
    output = pipeline.text_encoder(input_ids=inputs, attention_mask=tokens.attention_mask.to(device),
                                   output_hidden_states=True, use_cache=False, logits_to_keep=1)
    hidden = torch.stack([output.hidden_states[index] for index in (9, 18, 27)], dim=1)
    count, layers, length, dimension = hidden.shape
    prompt = hidden.permute(0, 2, 1, 3).reshape(count, length, layers * dimension)
    return prompt.to(device=device, dtype=pipeline.text_encoder.dtype)


@torch.no_grad()
def embedding_arguments(pipeline, prompt: str, negative_prompt: str, device, guidance: float):
    arguments = {"prompt": None, "prompt_embeds": encode_flux2_prompts(pipeline, [prompt], device)}
    if guidance > 1:
        arguments["negative_prompt_embeds"] = encode_flux2_prompts(pipeline, [negative_prompt], device)
    return arguments


def predict_velocity(pipeline, noisy, timesteps, prompt, guidance_scale):
    image_ids = pipeline._prepare_latent_ids(noisy).to(noisy.device)
    text_ids = pipeline._prepare_text_ids(prompt).to(noisy.device)
    packed = pipeline._pack_latents(noisy)
    guidance = (torch.full((noisy.shape[0],), guidance_scale, device=noisy.device, dtype=noisy.dtype)
                if pipeline.transformer.config.guidance_embeds else None)
    prediction = pipeline.transformer(hidden_states=packed, timestep=timesteps / 1000,
                                      guidance=guidance, encoder_hidden_states=prompt,
                                      txt_ids=text_ids, img_ids=image_ids, return_dict=False)[0]
    return pipeline._unpack_latents_with_ids(prediction, image_ids)
