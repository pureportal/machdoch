"""Check the current H3 GPU API and samplers using synthetic weights."""

import gc
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))

import torch
import diffusers
import media_diffusers_worker as worker
from media_h3_adapters import fuse_pairs, load_dmad_adapter
from media_h3_geometry import H3Geometry, latent_shape, packed_sequence
from media_h3_sampling import rollout
from media_open_models import PROFILES

torch.set_num_threads(2)
print("device", worker._device(torch), flush=True)
print("backend", worker._configure_amd_convolution_backend(torch, "cuda"), flush=True)
geometry = H3Geometry((1, 2, 2), 24, 32, 16)
shape = latent_shape(32, 32, 124, geometry)
layout = packed_sequence(3, shape, geometry).to("cuda")
embeddings = torch.randn(1, 3, 5120, dtype=torch.bfloat16, device="cuda")
profiles = [profile for profile in PROFILES.values() if profile.get("distillation") and profile["pipeline"] == "MiniMaxH3ModularPipeline"]

with tempfile.TemporaryDirectory(prefix="machdoch-h3-synthetic-") as directory:
    teacher = diffusers.MiniMaxH3Transformer3DModel(
        num_attention_heads=1, attention_head_dim=128, hidden_size=128,
        num_layers=1, num_refiner_layers=1, ffn_dim=256,
        time_embed_hidden_dim=128, time_embed_dim=64,
    )
    teacher.save_pretrained(directory, safe_serialization=True)
    del teacher
    baseline = {}
    for offload in (False, True):
        for profile in profiles:
            transformer = diffusers.MiniMaxH3Transformer3DModel.from_pretrained(
                directory, dtype=torch.bfloat16, local_files_only=True,
                use_safetensors=True, low_cpu_mem_usage=True,
            ).eval().requires_grad_(False)
            target_name, target = next(
                (name[:-len(".weight")], value)
                for name, value in transformer.named_parameters()
                if name.endswith(".weight") and value.ndim == 2 and value.dtype == torch.bfloat16
            )
            generator = torch.Generator().manual_seed(42)
            pairs = {target_name: {
                "A": torch.randn((128, target.shape[1]), generator=generator) * 0.001,
                "B": torch.randn((target.shape[0], 128), generator=generator) * 0.001,
            }}
            del target
            if profile["distillation"]["method"] == "dmad":
                transformer = load_dmad_adapter(transformer, pairs)
            else:
                fuse_pairs(transformer, pairs)
            del pairs
            if offload:
                transformer.enable_group_offload(
                    onload_device=torch.device("cuda"), offload_device=torch.device("cpu"),
                    offload_type="block_level", num_blocks_per_group=1, use_stream=False,
                )
            else:
                transformer.to("cuda")
            progress = []
            result = rollout(
                transformer, embeddings, layout, shape, geometry,
                {**profile["distillation"], "steps": profile["steps"]}, 71, "cuda",
                lambda step, total: progress.append((step, total)),
            )
            assert len(progress) == profile["steps"]
            assert result[0].shape == shape["video_tokens"]
            assert result[1].shape == shape["audio_tokens"]
            assert all(torch.isfinite(value).all() for value in result)
            if offload:
                assert all(torch.equal(left, right) for left, right in zip(result, baseline[profile["id"]]))
            else:
                baseline[profile["id"]] = result
            print("PASS", profile["id"], "CPU group offload" if offload else "GPU resident", flush=True)
            del transformer
            gc.collect()
            torch.cuda.empty_cache()
print("PASS current H3 loading, student adapters, samplers, GPU execution and group offloading", flush=True)
