# Media Studio model memory review

## Findings before the change

Media Studio's local image and video provider launched a fresh Python process for every operation, including runtime probes. Image models were loaded again for each run. Successful process exit released the process's tensors, allocator pools, and accelerator context; there was no image pipeline cache to reuse.

The managed runtime pins Diffusers 0.39.0, Accelerate 1.14.0, and accelerator-specific PyTorch builds. It supports NVIDIA CUDA, AMD ROCm through PyTorch's CUDA API, Apple MPS, and CPU execution. Image pipelines already use model CPU offloading; KREA uses group/disk offloading. Video paths also release intermediate components and isolate large encoder/denoiser stages in subprocesses. Those strategies remain in place.

Other Python workflow operations use Transformers, Spandrel, and PyTorch for segmentation, depth, upscaling, visual checks, and prompt generation. Their processes exited after each operation. BiRefNet is separate: a Rust ONNX Runtime session using the default CPU execution provider was cached indefinitely behind a mutex. It was explicitly dropped before Diffusers generation and model removal, but had no idle deadline and remained cached after inference errors. Remote image providers do not own local model memory.

The existing worker loop polled cancellation every 500 ms, enforced image/video deadlines, drained bounded diagnostics, and assigned Windows process-tree jobs. Some early error returns could bypass explicit termination/reaping. There was no Media Studio model shutdown hook or common arbitration between local model operations. The OOM classifier also matched unrelated words containing `oom`.

## Research and decisions

- [PyTorch CUDA memory management](https://docs.pytorch.org/docs/main/notes/cuda.html#memory-management): allocated tensor memory and reserved allocator memory are different. `empty_cache()` releases unused allocator blocks, not live tensors. Cleanup therefore removes references, collects cycles, and clears the allocator; terminating and reaping the supervised process also releases its accelerator context.
- [Diffusers offloading](https://huggingface.co/docs/diffusers/optimization/memory) and [pipeline reuse](https://huggingface.co/docs/diffusers/using-diffusers/loading#reusing-models-in-multiple-pipelines): offload hooks and shared pipeline components are stateful. Retain one fully configured image pipeline, rather than independently caching components that could share incompatible state. Model identity, adapters, pipeline mode, ControlNet/IP-Adapter configuration, dimensions, and memory profile determine reuse. Prompts, seeds, and output paths do not.
- [PyTorch ROCm semantics](https://docs.pytorch.org/docs/main/notes/hip.html) and [device memory queries](https://docs.pytorch.org/docs/main/generated/torch.cuda.memory.mem_get_info.html): use the selected device's actual free memory through the CUDA API for both NVIDIA and AMD. Preserve the existing AMD adapter isolation.
- [MPS recommended memory](https://docs.pytorch.org/docs/main/generated/torch.mps.recommended_max_memory.html) and [MPS cache release](https://docs.pytorch.org/docs/main/generated/torch.mps.empty_cache.html): monitor the recommended working-set budget against driver allocations. This is an MPS budget measurement, not a global free-VRAM reading.
- [ONNX Runtime memory allocation](https://onnxruntime.ai/docs/get-started/with-c.html) and [Python garbage collection](https://docs.python.org/3/library/gc.html): long-lived session arenas and reference cycles need explicit lifetime boundaries. The installed `ort` implementation was also inspected: its final shared-session drop calls `ReleaseSession`; inference outputs must leave scope first.

The documentation does not prescribe an idle timeout. The implementation uses **four times measured cold startup/loading time, bounded to 120–600 seconds**, with the idle deadline starting after successful generation. This gives inexpensive models a short editing window and amortizes the substantial ROCm import/loading cost recorded in this repository. A reuse extends the idle deadline without increasing the retention duration. Readiness probes do not extend it. The hardware measurement below selected about 128 seconds.

Idle GPU pressure means free space below 10% of device memory, bounded to 512 MiB–2 GiB. This is a conservative headroom threshold, not a prediction that a particular model or resolution will fit. MPS uses its working-set budget. Host RAM pressure also evicts idle resources because CPU offloading retains model weights in RAM.

## Implementation

- A Media Studio worker manager serializes local Python model operations. An image worker remains available for reuse; another model operation releases it before starting. CPU-only mask and Canny processing preserve it. Runtime probes can use the resident worker.
- A five-second watchdog checks idle deadlines, process health, GPU headroom, and host RAM. Its schedule continues even when probes arrive frequently. It never interleaves cleanup with an active request. An unresponsive idle memory query is bounded to ten seconds.
- Image configuration changes discard the old pipeline before loading the replacement. Reuse keeps adapters/offload configuration, reapplies prompt embedding tokens to the new prompt, resets scheduled adapter strengths, and restores the FLUX.2 CPU-decoding VAE dtype/offload hooks.
- Every Python operation now uses the existing `SupervisedChild` process-tree abstraction. Cancellation, deadlines, worker crashes, request/response errors, and progress/database failures terminate and reap resources. OOM ends the failed worker without an automatic generation retry.
- Runtime repair, model/add-on removal, and Tauri exit release resident workers. BiRefNet has bounded idle retention, active-inference protection, and immediate cache invalidation after errors.
- The existing error notice now gives actionable memory recovery advice. No lifecycle controls, badges, or explanatory interface content were added.

## Verification

Automated native tests: `cargo test --lib media:: -- --test-threads=4` — **247 passed, seven ignored**. The ignored cases are existing optional integration tests. New process tests exercise reuse, expiry, memory pressure, replacement by another operation, active-use protection, cancellation, crashes, deadlines, monitor failures, and idle/active shutdown. They launch real supervised processes with simulated inference and pressure; expiry is advanced for deterministic testing.

Python tests: managed Python `-m unittest discover -s apps/client/src-tauri/python -p 'test_media*.py'` — **154 passed**. New tests verify that repeat generation calls the pipeline loader once, uses fresh prompts/seeds/output paths, releases model references, handles pressure and OOM, and cleans up on worker failure and input closure. CUDA/MPS memory APIs are simulated in these regression tests.

Hardware verification used the installed Stable Diffusion 1.5 checkpoint on **AMD Radeon RX 9070, PyTorch 2.12.0+rocm7.14.0 / HIP 7.14.60850**, with two 256×256 image runs. The checked-in [measurement](media-model-memory-hardware-2026-09-18.json) records:

| Measurement                                     | Result                             |
| ----------------------------------------------- | ---------------------------------- |
| First request, including worker startup/loading | 47.000 s                           |
| Reused request                                  | 9.328 s                            |
| Pipeline loading events across both requests    | 1                                  |
| Measured retention                              | 128.436 s                          |
| GPU memory returned on clean worker exit        | 366,084,096 bytes (349.125 MiB)    |
| Free GPU memory before/after worker lifetime    | 16,937,648,128 bytes in both cases |

The hardware test uses the real server protocol, real model weights, actual GPU inference, output files, and device memory queries. The probe process remains alive while measuring worker exit, so the before/after comparison includes the same observer context. Reproduce with the managed interpreter and `apps/client/scripts/verify_media_model_memory.py --request <worker-request.json> --report <report.json>`. The script reads installed weights and writes temporary outputs; it does not submit or alter Media Studio runs.

`cargo check --tests` passes, with two existing unused-import warnings in `model_import.rs`. Rust formatting checks, JSON formatting, Python syntax checks, and `git diff --check` pass. No development server was started.

## Limits

NVIDIA and Apple hardware were unavailable. Real generation/release was measured for SD1.5 on ROCm, not every image family, adapter combination, large FLUX.2 CPU-decode configuration, or video model. KREA prompt encoders and video/workflow models retain their existing per-operation lifetimes; the resident cache holds the configured image pipeline only. Hardware OOM was not deliberately induced. Expiry, pressure, cancellation, and shutdown scenarios use simulated inference/pressure with real process supervision; the GPU measurement covers normal worker exit. BiRefNet session destruction was checked in code and its existing regressions passed, but process RSS reclamation was not measured. The running user's desktop was not closed to exercise the Tauri exit event interactively.
