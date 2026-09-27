# MiniMax H3 local generation

## Hardware and model choice

This machine has an AMD Radeon RX 9070 with 15.92 GiB VRAM and 31.31 GiB system RAM. The Machdoch ROCm runtime sees the discrete GPU as device 1. The stock 32B text encoder exceeded available host memory during two direct loading attempts. [Diffusers' low VRAM recipe](https://huggingface.co/docs/diffusers/main/en/api/pipelines/minimax_h3) expects about 75 GiB host RAM on a 12–16 GiB GPU.

For an image reference, the Ref2VA checkpoint is the matching H3 variant; FL2VA serves text and first/last frame conditioning. The [Comfy-Org release](https://huggingface.co/Comfy-Org/MiniMax-H3) provides a 19.53 GiB pruned INT8 ConvRot Ref2VA checkpoint, video and audio VAEs, and text encoders. These are model files, independent of the ComfyUI application. [FenomAI's quantization notes](https://huggingface.co/FenomAI/MiniMax-H3) identify NVFP4 as a Blackwell path and recommend INT8 ConvRot elsewhere. The pruned INT8 Ref2VA checkpoint is therefore the best available match for this AMD GPU, with block swapping between GPU and RAM.

The 32B H3 text encoder is replaced for this hardware by [Qwen3-VL-4B-Instruct](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct) and [ClipProj v3.1](https://huggingface.co/NicoLab28/ClipProj-MiniMax-H3). This is an approximate conditioning path, so prompt following and voice quality need output inspection.

The dedicated [LightX2V Ref2V Turbo LoRA](https://huggingface.co/lightx2v/Minimax-h3-Turbo) is the relevant adapter. Its 768p v1.0 file loads at strength 1.0. Its authors recommend eight Euler evaluations with video shift 6 and audio shift 3. The requested render uses 10 evaluations with the [Beta57 schedule](https://github.com/ClownsharkBatwing/RES4LYF/blob/main/README.md) and [ER-SDE solver](https://github.com/QinpengCui/ER-SDE-Solver), implemented directly in the local PyTorch sampler. The model directory also contains LightX2V's four-step Ref2V adapter, [Anime Motion](https://huggingface.co/prithivMLmods/MiniMax-H3-I2V-Anime-Motion-LoRA), [Rough 2D Cartoon](https://huggingface.co/prithivMLmods/MiniMax-H3-Rough-2D-Cartoon-Illustration), and [Alibaba PAI's Ref2VA eight-step accelerator](https://huggingface.co/alibaba-pai/MiniMax-H3-Acc-LoRAs). The five-style comparison uses the first three additional adapters; the Alibaba adapter is downloaded but has not been rendered.

## Scope and limits

MiniMax's [hosted H3 API](https://platform.minimax.io/docs/api-reference/video-generation-v2-create) has no documented custom checkpoint or LoRA input. Local weights are required for this adapter. The open weights generate video and audio together; the hosted Context-IR and 2K regeneration stages are not released with them. The published [community license](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) excludes the EU, UK, US, and South Korea from its geographic grant; a separate grant may be needed there.

Machdoch's direct H3 runtime is `apps/client/src-tauri/python/media_minimax_h3.py`. It uses PyTorch and selected Apache-licensed Fizgig H3 components, without a ComfyUI process or installation. Media Studio discovers the installed `models/minimax-h3-ref2va` package and routes Basic image-to-video generation through this runtime. The application enforces H3's 24 fps, 17n+5 frame grid, one reference image, and native audio output.

## Verified render

The requested 10-step Beta57/ER-SDE render completed on the RX 9070 at 640 × 384, 124 frames, and 24 fps. The finished MP4 is `assets/media/caterpillar-h3-final.mp4`. FFmpeg decoded all frames and the stereo audio stream without errors. A frame contact sheet shows the caterpillar crawling, opening its mouth, looking up, and continuing without the previous grid artifact. Whisper Tiny English transcribed the generated speech as “I am bored as fuck.” The Machdoch managed runtime passed its full operation check and recognized the H3 model package as ready. A separate four-step run through Media Studio's worker returned a valid 124-frame VP9/Opus WebM with native audio and a measured 8.47 GiB peak GPU allocation at 512 × 288.
