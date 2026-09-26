# MiniMax H3 local generation

## Hardware and model choice

This machine has an AMD Radeon RX 9070 with 15.92 GiB VRAM and 31.31 GiB system RAM. The Machdoch ROCm runtime sees the discrete GPU as device 1. The stock 32B text encoder exceeded available host memory during two direct loading attempts. [Diffusers' low VRAM recipe](https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_h3) expects about 75 GiB host RAM on a 12–16 GiB GPU.

For an image reference, the Ref2VA checkpoint is the matching H3 variant; FL2VA serves text and first/last frame conditioning. The [Comfy-Org release](https://huggingface.co/Comfy-Org/MiniMax-H3) provides a 19.53 GiB pruned INT8 ConvRot Ref2VA checkpoint, video and audio VAEs, and text encoders. These are model files, independent of the ComfyUI application. [FenomAI's quantization notes](https://huggingface.co/FenomAI/MiniMax-H3) identify NVFP4 as a Blackwell path and recommend INT8 ConvRot elsewhere. The pruned INT8 Ref2VA checkpoint is therefore the best available match for this AMD GPU, with block swapping between GPU and RAM.

The 32B H3 text encoder is replaced for this hardware by [Qwen3-VL-4B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct) and [ClipProj v3.1](https://huggingface.co/NicoLab28/ClipProj-MiniMax-H3). ClipProj projects layer 24 from 2560 to H3's 5120 conditioning dimensions and substitutes its calibrated attention sink. This is an approximate conditioning path, so prompt following and voice quality need output inspection.

The dedicated [LightX2V Ref2V Turbo LoRA](https://huggingface.co/lightx2v/Minimax-h3-Turbo) is the relevant adapter. Its 768p v1.0 file is present locally and loads at strength 1.0. [ModelTC's inference guide](https://github.com/ModelTC/Minimax-H3-Turbo/blob/main/DIFFUSERS_SETUP_AND_INFERENCE.md) recommends an eight-evaluation Euler trajectory, video shift 6, and audio shift 3. Other H3 LoRAs are task specific and should only be selected after checking the checkpoint variant and adapter key layout.

## Scope and limits

MiniMax's [hosted H3 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) has no documented custom checkpoint or LoRA input. Local weights are required for this adapter. The open weights generate video and audio together; the hosted Context-IR and 2K regeneration stages are not released with them. The published [community license](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) excludes the EU, UK, US, and South Korea from its geographic grant; a separate grant may be needed there.

The direct local render probe is `scripts/probe-minimax-h3.py`. It uses PyTorch and the Apache-licensed Fizgig H3 model implementation, without the ComfyUI application. Its end-to-end video and audio output is still under validation. Media Studio does not yet expose this path as a ready local model.
