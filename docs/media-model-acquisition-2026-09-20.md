# Video and SVG model acquisition

Wan 2.2 TI2V-5B and IntroSVG now use the managed model library: installation plans, pinned downloads, SHA-256 verification, cancellation, removal, and an offline model probe before generation. Uninstalled managed models remain visible in Assets. Desktop and connected Fleet use the same controls.

| Model | Acquisition | Execution |
| --- | --- | --- |
| Wan 2.2 TI2V-5B | Managed official package; Civitai and local FP16/BF16/FP32 safetensors imports | Existing Wan video pipeline, now also loading single checkpoints |
| IntroSVG Qwen2.5-VL 7B | Managed complete Transformers package | Native local text/image-to-SVG worker; existing sanitization, rendering, and evaluation |
| LTX-Video 0.9.8 2B / 13B FP8 | Existing complete workspace package; Civitai LoRAs | Existing LTX video worker |
| FramePack I2V 13B | Existing assembled workspace package | Existing FramePack video worker |
| HunyuanVideo 1.5 step-distilled I2V | Existing complete workspace package | Existing Hunyuan video worker |
| InternSVG / VFIG | Existing separately configured local endpoint | Existing endpoint adapter |
| Wan 2.2 A14B / quantized Wan checkpoints | Unavailable | No matching native loader |
| Wan-Alpha | Unavailable | Requires its own model and alpha-decoding pipeline |

The remaining workspace video packages and external SVG endpoints have not gained managed downloads in this change. Civitai continues to filter resource families and file formats against the loaders actually present. SVG models are offered in the model library; no unsupported Civitai SVG family was added.

## Packages

- [Wan Diffusers](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B-Diffusers/tree/b8fff7315c768468a5333511427288870b2e9635): 21 files, 34,201,436,033 bytes (31.85 GiB). The standalone checkpoint path downloads the tokenizer, text encoder, VAE, scheduler, and configuration from the same revision, excluding the base transformer weights (about 13.2 GiB). Local checkpoint imports retain the existing synchronous component-install behavior; that phase does not expose managed-job progress or cancellation.
- [IntroSVG](https://huggingface.co/gitcat404/IntroSVG-Qwen2.5-VL-7B/tree/5da60d628d226361fb0a8210dc021782e5ee484a): 16 files, 16,600,362,059 bytes (15.46 GiB). Only inference weights and processor/configuration files are installed. Loading disables network access and remote Python code.
- Both manifests pin file sizes and SHA-256 values. They use the existing managed asset root and storage-move machinery.

Wan checkpoint detection checks tensor dimensions and layer count, rather than trusting a Civitai label. Imported models retain their content-derived identity through selection, persisted settings, Advanced flows, probing, and generation. Workspace discovery does not replace an installed managed model's descriptor.

## Transparency

Wan's existing transparent output uses matting and alpha-video encoding. [Wan-Alpha](https://github.com/WeChatCV/Wan-Alpha) is a separate generative pipeline based on Wan 2.1 T2V 14B, specialized adapters, and an alpha VAE. Those weights cannot be executed by the TI2V-5B loader and are not advertised as compatible downloads.

## Verification

- Frontend: 507 tests; lint, Media Studio and client UI type checks, production UI build.
- Native: 283 tests passed, 12 ignored, covering managed installation plans, catalog acquisition/readiness, checkpoint detection, Civitai compatibility, and generation cancellation.
- Python: 12 tests covering component-path validation, SVG output validation, existing Wan behavior, and a real small Diffusers checkpoint conversion that preserves every tensor offline.
- Playwright: Civitai controls plus Wan/IntroSVG install dialogs in desktop and Fleet views; existing 390px/320px settings layout checks. The browser fixtures mock native responses, so they do not establish a live Fleet transfer or a completed model installation.
- Public Civitai metadata lists a compatible [FP16 Wan 2.2 TI2V-5B checkpoint](https://civitai.com/models/1817671?modelVersionId=2057016). A bounded download attempt returned HTTP 401 without credentials.

Full model downloads and generation with the new full-size packages were not performed. The small conversion test verifies weight loading, not output quality, memory requirements, or every third-party checkpoint. Wan-Alpha and A14B remain unsupported.
