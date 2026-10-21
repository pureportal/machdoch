from pathlib import Path
from types import SimpleNamespace
import json


def load_pipeline(diffusers, root: Path, dtype):
    import torch
    from transformers import AutoProcessor, BitsAndBytesConfig, Qwen3VLForConditionalGeneration
    from diffusers import AutoencoderKLFlux2, Flux3Transformer2DModel, GGUFQuantizationConfig

    if not torch.cuda.is_available():
        raise ValueError("FLUX 3 requires a supported GPU with NF4 kernels.")
    blocks = diffusers.Flux3DistilledAutoBlocks()
    blocks.sub_blocks.pop("prompt_upsampler")
    manager = diffusers.ComponentsManager()
    pipeline = blocks.init_pipeline(str(root), components_manager=manager)
    encoder = Qwen3VLForConditionalGeneration.from_pretrained(
        str(root / "text_encoder"), dtype=dtype, local_files_only=True, trust_remote_code=False,
        quantization_config=BitsAndBytesConfig(load_in_4bit=True, bnb_4bit_quant_type="nf4", bnb_4bit_compute_dtype=dtype),
        device_map={"": torch.cuda.current_device()}, use_safetensors=True,
    )
    index = json.loads((root / "modular_model_index.json").read_text(encoding="utf-8"))
    quantization = index.get("machdoch_quantization")
    if quantization != {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}}:
        raise ValueError("Invalid FLUX 3 transformer quantization specification")
    transformer_quantization = GGUFQuantizationConfig(compute_dtype=dtype)
    transformer_quantization.modules_to_not_convert = ["timestep_embedder", "target_timestep_embedder"]
    transformer = Flux3Transformer2DModel.from_single_file(
        str(root / "transformer/model.gguf"), config=str(root / "transformer"),
        torch_dtype=dtype, local_files_only=True,
        quantization_config=transformer_quantization,
    )
    def validate_prediction(module, inputs, output):
        prediction = output if isinstance(output, torch.Tensor) else output[0] if isinstance(output, tuple) else output.sample
        if not torch.isfinite(prediction).all():
            raise ValueError("FLUX 3 produced non-finite predictions. Check the model precision and quantization.")
    transformer.register_forward_hook(validate_prediction)
    processor = AutoProcessor.from_pretrained(str(root / "text_encoder"), local_files_only=True, trust_remote_code=False)
    vae = AutoencoderKLFlux2.from_pretrained(
        str(root / "vae"), torch_dtype=torch.float32, local_files_only=True, use_safetensors=True,
    )
    vae.enable_tiling()
    vae.tile_sample_min_size = 512
    vae.tile_latent_min_size = 64
    vae.decoder.register_forward_hook(validate_prediction)
    pipeline.update_components(text_encoder=encoder, transformer=transformer, tokenizer=processor, vae=vae)
    manager.enable_auto_cpu_offload(device=f"cuda:{torch.cuda.current_device()}")
    return pipeline


def generate_image(pipeline, arguments, progress):
    prompt = arguments["prompt"]
    processor = pipeline.tokenizer
    formatted = processor.apply_chat_template([{"role": "user", "content": prompt}], tokenize=False, add_generation_prompt=True)
    token_count = len(processor.tokenizer(formatted, truncation=False)["input_ids"])
    if token_count > 8192:
        raise ValueError(f"FLUX 3 caption uses {token_count} tokens; shorten descriptions to fit 8192.")
    completed = 0
    total = arguments["num_inference_steps"]
    def sampled(module, inputs, output):
        nonlocal completed
        completed += 1
        progress(completed, total)
    handle = pipeline.transformer.register_forward_hook(sampled)
    try:
        images = pipeline(output="images", **arguments)
    finally:
        handle.remove()
    return SimpleNamespace(images=images)
