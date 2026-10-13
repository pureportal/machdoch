import argparse
import json
import os
from pathlib import Path
import time


def verify(output: Path, hip_device: str) -> None:
    os.environ["HIP_VISIBLE_DEVICES"] = hip_device
    import bitsandbytes
    import torch

    if not torch.cuda.is_available() or not torch.version.hip:
        raise ValueError("Choose the ROCm media runtime and an available GPU")
    if not torch.cuda.is_bf16_supported():
        raise ValueError("The selected GPU does not support BF16 computation")
    torch.manual_seed(0)
    dense = torch.nn.Linear(1024, 1024, bias=False, dtype=torch.bfloat16)
    started = time.monotonic()
    dense = dense.to("cuda")
    measurements = []
    with torch.inference_mode():
        for quantization in ("nf4", "fp4"):
            quantized = bitsandbytes.nn.Linear4bit(
                1024, 1024, bias=False, compute_dtype=torch.bfloat16,
                compress_statistics=True, quant_type=quantization,
            )
            quantized = quantized.to(dtype=torch.bfloat16)
            quantized.load_state_dict({"weight": dense.weight.detach().cpu()})
            quantized = quantized.to("cuda")
            if quantized.weight.dtype != torch.uint8 or quantized.weight.quant_state.quant_type != quantization or quantized.weight.quant_state.dtype != torch.bfloat16:
                raise ValueError(f"The layer did not load as {quantization.upper()} weights")
            for batch_size in (1, 16):
                inputs = torch.randn(batch_size, 1024, device="cuda", dtype=torch.bfloat16)
                expected = dense(inputs).float()
                actual = quantized(inputs).float()
                if actual.device.type != "cuda" or not torch.isfinite(actual).all():
                    raise ValueError(f"{quantization.upper()} inference did not produce finite GPU results")
                relative_rmse = (((actual - expected).square().mean() / expected.square().mean()).sqrt()).item()
                if relative_rmse > 0.15:
                    raise ValueError(f"{quantization.upper()} relative error exceeded 15% for batch {batch_size}: {relative_rmse}")
                measurements.append({"quantization": quantization, "batchSize": batch_size, "relativeRmse": relative_rmse})
    torch.cuda.synchronize()
    properties = torch.cuda.get_device_properties(0)
    result = {
        "passed": True, "scope": "NF4 and FP4 quantization and linear inference; full model inference remains untested",
        "bitsandbytes": bitsandbytes.__version__, "torch": torch.__version__, "hip": torch.version.hip,
        "device": properties.name, "deviceMemoryBytes": properties.total_memory,
        "weightsDtype": str(quantized.weight.dtype), "quantization": ["nf4", "fp4"],
        "computeDtype": "bfloat16", "measurements": measurements,
        "seconds": time.monotonic() - started,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--hip-device", default="1")
    arguments = parser.parse_args()
    verify(arguments.output, arguments.hip_device)


if __name__ == "__main__":
    main()
