# CogVideoX training verification — October 6, 2026

CogVideoX 2B, CogVideoX 1.5 5B T2V, and CogVideoX 1.5 5B I2V now have video dataset routes for LoRA, denoiser finetuning, and input-vector embeddings. The full training goal remains incomplete. The coverage audit reports 20 integrated architecture identifiers out of 52, with 32 missing trainers; integration does not establish pretrained quality or speed.

The Train view accepts MP4, WebM, MOV, and MKV clips, captions, width, height, frame count, and FPS. I2V exposes first-image dropout. Native inspection checks files and duration; the decoder crops and resamples actual frames, rejects short clips, and checks VAE output shape. Checkpoints bind the cached posterior distributions to clip hashes, captions, model identity, video settings, and seed.

LoRA can target attention alone or attention plus feed-forward layers. Finetuning trains the denoiser; the VAE and T5 remain frozen. Embeddings train an isolated T5 input vector, preserve token case, and reject truncation. Exports use the existing native import and generation contracts. The worker applies positive and negative embeddings at the transformer's exact text sequence limit. The installed model's dimensions are checked when loading LoRAs.

## Primary source and runtime

Implementation follows the weighted clean-latent objective in the pinned [Diffusers T2V trainer](https://github.com/huggingface/diffusers/blob/4295ee3ec58efa6577bc459e9b84ca3f63aa9a96/examples/cogvideo/train_cogvideox_lora.py) and first-image noise conditioning in its separate [I2V trainer](https://github.com/huggingface/diffusers/blob/4295ee3ec58efa6577bc459e9b84ca3f63aa9a96/examples/cogvideo/train_cogvideox_image_to_video_lora.py). The sources were retrieved through GitHub's API and checked against Git blob hashes `3fd542173e348e3b4544e3ce171eb1f6b6cb430c` and `12ad753eff8b9657241deb6ba198840243b4d648`. CogVideoX 1.5 temporal padding, rotary positions, I2V latent scaling, and offset conditioning follow the installed pipeline implementation. This does not imply the pinned examples already handle every 1.5 case.

The local environment is Python 3.12.10, Torch 2.12.0 + ROCm 7.14.0, Diffusers commit `4295ee3ec58efa6577bc459e9b84ca3f63aa9a96`, Transformers 5.17.0, and PEFT 0.19.1, on AMD RX9070 with 15.922 GiB physical VRAM and 31.31 GiB RAM. No dependency upgrade was performed for this continuation.

The public [CogVideoX 2B revision](https://huggingface.co/zai-org/CogVideoX-2b/tree/1137dacfc2c9c012bed6a0793f4ecf2ca8e7ba01) was downloaded anonymously: 16 files, 13,775,555,658 bytes, with every LFS SHA-256 or Git blob hash verified. The source is at `C:\mtrain\models\cogvideox-2b-pretrained`. Download evidence is in `D:\Models\machdoch\verification\2026-10-06-training\cogvideo-2b-public-download.json`.

## Completed checks

- Five reduced-component tests passed, including all nine architecture/method combinations. Each trains two steps, checks that intended weights change and frozen weights stay unchanged, exports, reloads, samples a nonsquare nine-frame video, and resumes from step one to reproduce step two exactly. These use real SDK components with random weights.
- Additional checks compare prompt encoding and loss with the pinned pipeline/trainer, check temporal padding, confirm embedding gradients and case/truncation handling, and reject short clips or invalid dimensions.
- The full media UI suite passed: 91 files, 785 tests. Targeted training/add-on tests include all three video selectors, canonical clip submission, video fields, invalid and short clip disabling, and dataset clearing when switching modalities.
- Media package type checking passed, and the production UI build passed. The broader client UI typecheck failed in `chat-session/components/conversation-feed.tsx`: chat task metadata has a different type from the conversation feed's expected instruction-resolution metadata. Training changes did not touch that code.
- The expanded Python regression suite passed: 39 tests covering CogVideoX training, open-model loading and video generation, and video composition. This includes export reuse through the generation worker for all nine reduced-component training combinations.

- The corrected native build passed. Training request/lifecycle tests passed 17/17, addon tests passed 27/27, and package tests passed 25/25. Five tests requiring explicit external fixtures were excluded from these counts.

- The video cache and precision regression suite passed: 31 tests. Each of the nine reduced training combinations now generates with new prompts/seeds on the retained pipeline and verifies that only one pipeline load occurs. Server checks cover cleanup on success, GPU memory errors, and other errors for both image and video commands.

The native build for supervised video retention passed. Its regression groups passed 82 tests: 13 model-memory, 17 training, 27 addon, and 25 package tests. Seven external-fixture tests were excluded. A previous native build compiled before the import correction was applied and still rejected CogVideoX embeddings. That stale executable's failure is retained in the external logs; it is not counted as a passing native check. The subsequent changes that release retained inference models before training and avoid duplicate copies on reimport await compilation.

The first reduced-model run found an unaligned VAE tiling shape and a loss dtype mismatch. Both were corrected. CogVideoX training and generation share tiling sizes and overlap aligned to the spatial compression factor.

## Pretrained verification in progress

Three 25-frame, 8 FPS clips were prepared from previously verified teapot/cup images using synthetic camera movement. Training uses 17 frames at 192 × 128. This dataset establishes execution of video conditioning; it does not prove learned motion, style quality, or generalization.

An initial full-size 2B BF16 LoRA run completed four steps: 4,147,200 trainable parameters, 360 adapter tensors with changed sampled values, and unchanged samples from 1,391 frozen tensors. The optimizer loop took 15.5 seconds; the complete run took 242.39 seconds. Its 3,933,201,408 allocated / 4,318,035,968 reserved peak bytes cover the optimizer loop only because the observer reset the counters after preparation. Host memory reached about 0.5 GB of free commit capacity while conditioning ran; this was not a fully resident VRAM benchmark.

Inspection of the actual pretrained safetensors found FP32 VAE weights and FP16 transformer/T5 weights. The initial loader converted the VAE through BF16. The corrected loader preserves FP32 VAE weights and the 2B T5's FP16 precision; conditioning signatures changed to reject caches produced before this correction. The initial job is retained at `C:\mtrain\verification\cogvideo-2b\lora-before-vae-precision-fix` and is not used as verification of the corrected loader. The next observer records preparation and optimizer memory separately.

The corrected public 2B FP16 LoRA run completed four steps. All 360 sampled adapter tensors changed; samples from all 1,391 frozen tensors remained unchanged. The optimizer loop and its parameter checks took 118.047 seconds, and the full Python workflow took 816.781 seconds after SDK imports. Preparation peaked at 11,688,927,232 allocated / 11,714,691,072 reserved GPU bytes; the optimizer loop peaked at 3,933,202,432 allocated / 4,315,938,816 reserved bytes. The observer confirmed FP32 VAE and original FP16 T5 precision. The 369 host-memory samples ending with the completion record show a minimum 92,028,928 bytes of free physical memory and 798,064,640 bytes of free commit capacity. These are process-wide conditions during concurrent local work, not an isolated throughput or stability benchmark.

The exported LoRA passed native inspection and import: 180 Diffusers PEFT targets, rank four, all 360 tensors recognized, and a managed SHA-256 identity. Embedding training and native base import are running. Finetuning, public checkpoint-resume comparison, and native trained-artifact video generation remain pending. The 1.5 5B T2V and I2V pretrained workflows remain unverified. Our compilation and full-size GPU jobs run sequentially to limit host-memory contention. Cold SDK imports on the installed drive remain slow, particularly during large model copies on the same drive.

Min-SNR is unavailable for this objective. Videos use a fixed cropped canvas. Training is unquantized and single-device; denoiser finetuning does not train the VAE or encoder. Reduced-model success and a verified download do not establish generation quality, throughput, long-run stability, or packaged desktop behavior.
