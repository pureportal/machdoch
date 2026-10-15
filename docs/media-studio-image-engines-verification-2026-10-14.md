# Image engine verification checkpoint — 2026-10-14

All 24 requested engines have sampling profiles and runtime routes. Full reference-quality validation remains incomplete.

## Runtime changes

- FLUX.2 Dev loads a declared GGUF transformer with the complete Mistral Small 3.2 encoder. Folder review checks the Dev configuration, processor files and decoder, and rejects incompatible GGUF declarations. Package preparation verifies publisher hashes and preserves weight bytes, licences, attribution and provenance.
- HiDream checks serialized FP4/NF4 metadata against component configuration before loading. Requested dimensions determine both the pipeline area budget and transformer patch-token capacity, fixing silent resizing and rectangular images exceeding the original token buffer.
- Base Qwen-Image variants load an NF4 encoder on CPU before block offloading. The image decoder stays on the selected GPU, preventing CPU-weight/GPU-input errors during full-frame and tiled decoding.
- Non-distilled SD3/SD3.5 offers Flow Heun alongside the recommended Euler sampler. Scheduled LoRAs use the actual timestep count so their timing also works with Heun. The shared guidance default is 4.5, with a suggested range of 3.5–7.
- Civitai checkpoint imports retain declared Illustrious and NoobAI sampling profiles. Model removal preserves installed siblings of the same architecture.

The SD3 guidance values follow the publisher examples for [Medium](https://huggingface.co/stabilityai/stable-diffusion-3.5-medium) and [Large](https://huggingface.co/stabilityai/stable-diffusion-3.5-large). Juggernaut's sampling source now points to the [XI model card](https://huggingface.co/RunDiffusion/Juggernaut-XI-v11).

## Verification changes

The evidence auditor combines render folders, deduplicates records, checks image digests, and matches each visual assessment to its reference ID and digest. Superseded classifications, obsolete Krea defaults and records without verified images cannot satisfy coverage.

The native generation verifier resets saved sampling state, checks asset dimensions, model, prompt, seed and optional worker version, and records success only after assertions pass. Reference batches reuse loaded Python libraries, route diagnostics to the current render log, support decoder-latent capture, and can stop after a failed case.

Regression coverage includes real small-model GGUF denoising, serialized NF4 encoder round trips, HiDream geometry and quantization metadata, guided SD3 Euler/Heun execution, repeated GPU decoder use, import validation, sibling removal and evidence integrity.

## Earlier local validation and remaining limits

Earlier native Playwright runs checked sampler choices, recommendations, suggested bands, warning clearing and Basic-to-Advanced persistence. Basic and Advanced SD-Turbo generation on worker 1.109.0 produced the same fixed-seed 512-square image with SHA256 `701ee16d959b1cf14aae0e61ad14d9f6a22907dcf85d23d932ec8940f8b65977`. That confirms execution and consistency, not reference-level aesthetics or validation of every later worker change.

HiDream completed the six reference subjects, including the previously failing landscape dimensions. Earlier audits still recorded composition, style or detail gaps for several engines. Completed FLUX.2 reference comparisons used Klein variants; full Dev quality remains unverified. Full-size Flow Heun and the updated Qwen encoder/decoder path also need completed GPU renders and visual review. SD3.5 Large Turbo was installed, but installation does not establish render quality.

Small-model numerical tests do not establish the speed, memory requirements or quality of full models. No claim is made that every engine matches all six reference aesthetics.

Commit verification on 2026-10-15 passed 438 native media tests, with 26 live or fixture-dependent tests ignored. The GPU decoder regression passed on the RX 9070. The small Qwen NF4 encoder regression failed with a ROCm launch error during block offloading; the same encoder passed when kept on the GPU. Its CPU round trip passed, but the encoder's GPU block-offload path remains blocked on the local PyTorch 2.12.0 / ROCm 7.14.0 and bitsandbytes 0.50.2 runtime.

Raw render files, machine-specific manifests and transient research remain local under `docs/validation/image-engines` and `D:\Models\machdoch`. The installed production desktop was not replaced during the earlier isolated validation.
