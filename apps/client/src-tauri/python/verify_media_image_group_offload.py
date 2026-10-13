import argparse
import gc
import json
import os
from pathlib import Path
import tempfile
import time


def verify(output: Path) -> None:
    os.environ.update({"HIP_VISIBLE_DEVICES": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1"})
    import diffusers
    from diffusers.hooks.group_offloading import apply_group_offloading
    import gguf
    import torch
    from transformers import T5Config, T5EncoderModel

    from media_qwen_quantization import transformer_arguments

    if not torch.cuda.is_available():
        raise ValueError("The GPU offload probe requires the verification GPU")
    torch.manual_seed(17)
    records = []
    options = {
        "onload_device": torch.device("cuda", 0), "offload_device": torch.device("cpu"),
        "offload_type": "block_level", "num_blocks_per_group": 1,
        "non_blocking": True, "use_stream": True, "record_stream": True,
        "low_cpu_mem_usage": True,
    }
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        component = root / "transformer"
        component.mkdir()
        original = diffusers.QwenImageTransformer2DModel(
            in_channels=32, out_channels=32, num_layers=2,
            attention_head_dim=16, num_attention_heads=2, joint_attention_dim=32,
            axes_dims_rope=(4, 4, 8),
        )
        original.save_config(component)
        writer = gguf.GGUFWriter(str(component / "model.gguf"), "qwen_image")
        for key, value in original.state_dict().items():
            weights = value.detach().numpy()
            if weights.ndim == 2 and weights.shape[-1] % 32 == 0:
                writer.add_tensor(key, gguf.quants.quantize(weights, gguf.GGMLQuantizationType.Q8_0), raw_dtype=gguf.GGMLQuantizationType.Q8_0)
            else:
                writer.add_tensor(key, weights)
        writer.write_header_to_file()
        writer.write_kv_data_to_file()
        writer.write_tensors_to_file()
        writer.close()
        qwen = transformer_arguments(diffusers, root, {
            "_class_name": "QwenImagePipeline",
            "machdoch_quantization": {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}},
        }, torch.float32)["transformer"]
        del original
        models = (
            ("QwenImageTransformer2DModel-Q8_0", qwen, {
                "hidden_states": torch.randn(1, 4, 32), "encoder_hidden_states": torch.randn(1, 4, 32),
                "encoder_hidden_states_mask": torch.ones(1, 4, dtype=torch.bool),
                "timestep": torch.tensor([0.5]), "img_shapes": [(1, 2, 2)], "return_dict": False,
            }),
            ("FluxTransformer2DModel", diffusers.FluxTransformer2DModel(
                in_channels=32, out_channels=32, num_layers=2, num_single_layers=2,
                attention_head_dim=16, num_attention_heads=2, joint_attention_dim=32,
                pooled_projection_dim=32, guidance_embeds=False, axes_dims_rope=(4, 4, 8),
            ), {
                "hidden_states": torch.randn(1, 4, 32), "encoder_hidden_states": torch.randn(1, 4, 32),
                "pooled_projections": torch.randn(1, 32), "timestep": torch.tensor([0.5]),
                "img_ids": torch.tensor([[0, 0, 0], [0, 0, 1], [0, 1, 0], [0, 1, 1]]),
                "txt_ids": torch.zeros(4, 3), "return_dict": False,
            }),
            ("T5EncoderModel", T5EncoderModel(T5Config(
                vocab_size=64, d_model=32, d_ff=64, d_kv=16, num_heads=2, num_layers=2,
            )), {"input_ids": torch.tensor([[1, 2, 3, 4]]), "return_dict": False}),
        )
        for name, model, inputs in models:
            model.eval()
            with torch.inference_mode():
                reference = model(**inputs)[0].cpu()
                apply_group_offloading(model, **options)
                gpu_inputs = {key: value.to("cuda") if isinstance(value, torch.Tensor) else value for key, value in inputs.items()}
                torch.cuda.reset_peak_memory_stats()
                started = time.monotonic()
                actual = model(**gpu_inputs)[0].cpu()
                torch.cuda.synchronize()
                if not torch.isfinite(actual).all():
                    raise ValueError(f"Non-finite offloaded output: {name}")
                torch.testing.assert_close(actual, reference, atol=0.001, rtol=0.001)
                record = {
                    "model": name, "seconds": time.monotonic() - started,
                    "peakAllocatedBytes": torch.cuda.max_memory_allocated(),
                    "maxAbsoluteErrorAgainstCpu": float((actual - reference).abs().max()),
                    "finite": True, "outputShape": list(actual.shape),
                }
                records.append(record)
                print(json.dumps(record), flush=True)
                del gpu_inputs, actual, reference
            gc.collect()
            torch.cuda.empty_cache()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "scope": "Small real SDK graphs; full checkpoint generation remains separate",
        "device": torch.cuda.get_device_name(), "torch": torch.__version__,
        "diffusers": diffusers.__version__, "offload": {key: str(value) for key, value in options.items()},
        "records": records, "passed": len(records) == 3,
    }, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    verify(arguments.output)
