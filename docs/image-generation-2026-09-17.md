# Image generation integration

Checked against official OpenAI sources on 2026-09-17.

## OpenAI API

Machdoch now uses `gpt-image-2.5-sunburst-2026-09-08` for generation and reference-image editing. Its catalog identifier is `openai:gpt-image-2.5-sunburst`. Sunburst fits the existing editing workflow; Flare is the separate, faster 2.5 variant. OpenAI lists both as available in the API, subject to account access and possible organization verification.

The existing `POST /v1/images/generations` and multipart `POST /v1/images/edits` integrations remain applicable. Their base64 image responses, PNG/JPEG/WebP formats, existing sizes, and low/medium/high quality settings remain supported. Machdoch continues its explicit subject-cutout workflow with opaque provider output. No older image model is used when a request fails.

- [Sunburst identifiers and dated snapshot](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- [Image API generation, editing, parameters, and access](https://developers.openai.com/api/docs/guides/image-generation)

## Codex CLI

`codex-cli:image-generation` is a separate selectable model, using the existing Codex executable setting and saved CLI sign-in. Its package type is `agent-cli`; generation is remote even though the CLI runs locally. This path currently supports text-to-image. Reference editing remains available through the OpenAI API path.

Machdoch invokes `codex exec --json --output-schema ... --output-last-message ...` in an isolated working directory with a read-only sandbox. The prompt requests only the built-in `image_gen` tool. No API-script or alternate generator is substituted. The model running Codex is distinct from the image model and is not set to an image model identifier.

The result manifest reports the image paths supplied by the tool. Machdoch reads the session identity from `thread.started`, accepts only files inside that session's `$CODEX_HOME/generated_images/<session-id>` directory, validates count, format, size, and decoding, then publishes the images through the existing content-addressed asset store. It neither scans unrelated sessions nor deletes Codex's original images. Image payloads are read from files, independently of the CLI's bounded diagnostic capture.

Aspect ratio and quality are prompt preferences on this path; Codex's image tool does not expose the Image API's parameter controls. Deterministic seeds, local sampling controls, adapters, and reference inputs are rejected. Interrupted or uncertain requests use the existing review state without automatic resubmission.

The exact Codex image model cannot be pinned or verified as 2.5: the [Images 2.5 announcement](https://openai.com/index/introducing-chatgpt-images-2-5/) includes Codex, but the [image-generation guide](https://learn.chatgpt.com/docs/image-generation) and [official CLI tool implementation](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/tool.rs) still name `gpt-image-2`. Accordingly the option is labeled **Codex CLI**, with no claim that it selects Sunburst or Flare.

- [Non-interactive invocation, JSON events, and structured output](https://developers.openai.com/codex/noninteractive)
- [Official generated-image path implementation](https://github.com/openai/codex/blob/main/codex-rs/ext/image-generation/src/artifact.rs)

## Live verification

Opt-in native tests exercise each provider and publish its real output into a temporary Machdoch media database and asset store:

```powershell
cargo test --lib --manifest-path apps/client/src-tauri/Cargo.toml image_generation_live -- --ignored --nocapture --test-threads=1
```

The OpenAI test uses the configured API key and incurs normal API usage. The Codex test uses the saved CLI sign-in and its allowance. Each successful test prints the resulting image path, dimensions, and byte size. These tests are ignored by default.

Both live tests passed on 2026-09-17, including run completion, image decode, and asset-store digest verification:

| Path | Result |
| --- | --- |
| OpenAI Sunburst 2.5, pinned snapshot | 1024 × 1024 PNG, 1,093,210 bytes |
| Codex CLI 0.153.4, saved ChatGPT sign-in | 1254 × 1254 PNG, 1,387,969 bytes |

The prompt was a blue ceramic mug on a white background. Live reference editing, multi-image CLI batches, and other operating systems were not exercised. CLI generation succeeded, but its backend image version remains unverified for the reasons above. Existing saved flows pinned to the retired `openai:gpt-image-2` catalog entry need to select the new model.

## Regression verification

Client core, UI, test, and logic-test type checks and client lint passed. Targeted media catalog, model-selection, flow, and UI tests passed, as did all 280 Fleet protocol tests.

All 23 targeted native checks passed across the regression run and reruns. These cover API request mapping, image retrieval and validation, catalog configuration, publication, duplicate-submission protection, interruption recovery, and the shared CLI process runner. Three process timing tests failed during parallel execution while another build was active, then all five CLI process tests passed when rerun serially. Desktop UI interaction was not exercised.
