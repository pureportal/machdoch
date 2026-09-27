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

## Five style renders

`assets/media/h3-style-tests/renders.json` records the source images, prompts, seeds, and adapters for the anime, cartoon, 3D, romantic editorial, and action renders. Each final MP4 contains 124 frames at 512 × 288 and 24 fps with a decodable audio stream. Frame inspection confirmed visible motion in all five. The anime and cartoon renders used their respective style LoRAs at strength 0.7 with the LightX2V four-step adapter. The 3D and action renders used the four-step adapter; the romantic editorial render used the LightX2V eight-step adapter. The source PNGs do not record which image model generated them.

Media Studio accepts one imported MiniMax H3 style LoRA in addition to its built-in eight-step adapter. The add-on importer recognizes the tested H3 style tensor layout, and the worker validates the selected LoRA before generation. The downloaded Alibaba PAI Ref2VA accelerator remains untested in a render.

## Quality investigation

The previous caterpillar MP4 is 640 × 384 at 24 fps with 32 kHz stereo AAC audio around 200 kb/s. All 124 frames and the audio decode; the measured near-clipped sample fraction is about 0.001%. The weakest measured frame sharpness is near the end of the clip. The style contact sheet at `assets/media/h3-style-quality-contact-sheet.png` shows that several weak frames also coincide with the subject drifting to an edge of the frame. These observations do not establish that the codec caused the reported audio or visual defects. The 4B substitute conditioner, low render resolution, and use of the eight-step Turbo adapter with a ten-evaluation Beta57/ER-SDE sampler are more plausible quality limits.

The direct renderer and Media Studio now use eight evaluations on the adapter's documented shifted grid with Euler updates for both generated streams. The restored reference at `assets/media/h3-quality-reference-restored.png` is 1411 × 1115, derived from the supplied 550 × 435 image; restoration synthesized detail, so the original remains at `assets/media/h3-quality-reference-original.png` for identity comparison. No new H3 render was run for this investigation because the published community license does not grant use in the EU. Visual and audio improvement from the sampler change remains unverified.

## Local 2K stage

Media Studio offers a local 2K output choice for H3. The worker generates its usual 768-class base video and then runs `media_video_2k.py` on the decoded frames before WebM encoding. This stage uses motion-compensated temporal detail, edge-limited sharpening, and iterative back projection to produce 2560 × 1440 output for 16:9. It does not use MiniMax's unreleased H3-Regenerate-2K checkpoint or reconstruct prompt-dependent detail. A standalone MP4 processor accepts existing video files and retains their audio.

`assets/media/romantic-scene-local-2k.mp4` is a 124-frame, 24 fps, 2560 × 1440 output from the existing H3 romantic editorial clip. It retains the subject's turn and hair gesture and uses the clip's native, varying audio at 3 dB lower gain. The scene script is `scripts/render-romantic-scene-2k.py`. The 2K stage upscales the existing 512 × 288 H3 frames; it does not add new model-generated detail. No new H3 inference was run for this stage because the published license excludes EU use under the standard grant.
