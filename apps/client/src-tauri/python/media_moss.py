from pathlib import Path

IMPLEMENTATION_REVISION = "85975793d8b3d432f1b6e27f352abaa4c2a4c0d3"


def enable_progress(pipeline, notify):
    def progress(iterable):
        total = len(iterable)
        for index, value in enumerate(iterable):
            yield value
            notify(f"Sampling {index + 1}/{total}", 0.25 + 0.6 * (index + 1) / total)
    pipeline.progress_bar = progress


def load_pipeline(root: Path, dtype):
    import torch
    from diffusers import AutoencoderKLFlux2
    from transformers import AutoTokenizer, BitsAndBytesConfig, Qwen3_5Model
    from moss_image_runtime import MOSSImagePipeline, MOSSImageTransformer, MOSSImageScheduler

    if not torch.cuda.is_available():
        raise ValueError("MOSS requires a supported GPU with NF4 text-encoder kernels.")
    encoder = Qwen3_5Model.from_pretrained(
        str(root / "text_encoder"), dtype=dtype, local_files_only=True,
        trust_remote_code=False, use_safetensors=True,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype),
        device_map={"": torch.cuda.current_device()},
    ).eval()
    tokenizer = AutoTokenizer.from_pretrained(str(root / "tokenizer"), local_files_only=True, trust_remote_code=False)
    transformer = MOSSImageTransformer.from_pretrained(
        str(root / "transformer"), torch_dtype=dtype, local_files_only=True, use_safetensors=True,
    ).eval()
    vae = AutoencoderKLFlux2.from_pretrained(
        str(root / "vae"), torch_dtype=torch.float32, local_files_only=True, use_safetensors=True,
    ).eval()
    scheduler = MOSSImageScheduler.from_pretrained(str(root / "scheduler"), local_files_only=True)
    pipeline = MOSSImagePipeline(transformer, scheduler, encoder, tokenizer, vae)
    pipeline.vae.enable_tiling()
    pipeline.set_progress_bar_config(disable=True)
    return pipeline


def check_prompt_tokens(pipeline, prompt: str, negative_prompt: str) -> dict:
    counts = []
    for value in [prompt, negative_prompt]:
        formatted = pipeline.tokenizer.apply_chat_template(
            [{"role": "user", "content": value}], tokenize=False, add_generation_prompt=True, enable_thinking=True,
        )
        count = len(pipeline.tokenizer(formatted, truncation=False)["input_ids"])
        if count > 4096:
            raise ValueError(f"MOSS caption uses {count} tokens; shorten descriptions to fit 4096 without changing boxes or text.")
        counts.append(count)
    return {"positive": counts[0], "negative": counts[1], "maximum": 4096}
