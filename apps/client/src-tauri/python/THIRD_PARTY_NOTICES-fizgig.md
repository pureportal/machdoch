# Third-Party Notices

Fizgig is licensed under the Apache License, Version 2.0 (see `LICENSE-fizgig.txt`).

It includes code derived from the third-party projects listed below. Each
component remains under its upstream license; where those files were modified,
Fizgig's changes are released under Apache-2.0.

---

## musubi-tuner — Apache License 2.0

Upstream: https://github.com/kohya-ss/musubi-tuner
Copyright the musubi-tuner authors (kohya-ss and contributors).

The LoRA network module `fizgig/networks/lora.py` is adapted (and modified)
from musubi-tuner.

On 2026-11-17, Machdoch replaced the adapted safetensors reader with its own
implementation in `fizgig/utils/safetensors.py`.

Licensed under the Apache License, Version 2.0:
http://www.apache.org/licenses/LICENSE-2.0

---

## Machdoch MiniMax H3 VAE adapters — Diffusers dependency

On 2026-10-06, Machdoch replaced the bundled MiniMax H3 audio and video VAE
ports with independently implemented adapters to Diffusers'
`AutoencoderKLMiniMaxH3Audio` and `AutoencoderKLMiniMaxH3`. Those architectures
are provided by the Apache-2.0 dependency, with copyright held by the MiniMax
and HuggingFace Teams. Checkpoint conversion research used Diffusers'
`scripts/convert_minimax_h3_to_diffusers.py`.

Upstream: https://github.com/huggingface/diffusers

On 2026-11-17, Machdoch replaced the remaining ComfyUI-derived MiniMax code —
the transformer (`minimax/model.py`), the sampler (`minimax/sampling.py`) and
the reference sizing (`minimax/reference.py`) — with its own implementation.
The packed-sequence geometry now lives in `minimax/layout.py`. The architecture
and conventions follow the Apache-2.0 MiniMax-H3 port in Diffusers
(`models/transformers/transformer_minimax_h3.py`, `schedulers/scheduling_minimax_h3.py`
and `modular_pipelines/minimax_h3`), copyright The MiniMax Team and The
HuggingFace Team. Model weights retain their separate terms. See
`NOTICE-RefMod.txt`.

---

## Note on model weights

The third-party notices above cover **source code** only. Krea 2 / FLUX.2 model
weights, the Qwen-Image VAE weights, the Qwen3-VL text-encoder weights, and the
MiniMax H3 training adapters (circlestone-labs and Ostris) are distributed by their respective publishers under their own model licenses, which
the user accepts when downloading them. Fizgig does not redistribute any model
weights.
