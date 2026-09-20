# Fleet media and RALPH verification

The Fleet Manager Media Studio now embeds the same editor, asset library, model controls, and Civitai components used by the desktop client. The previous reduced Fleet-only media component has been removed.

## Implemented paths

- Shared `@machdoch/media-studio` package contains the existing media engine types, recipe compiler, Basic/Advanced editors, model and add-on management, assets, Civitai, and activity components.
- A bounded media RPC protocol carries native media operations through Fleet Manager to desktop-connected hosts and the installed executable's CLI Fleet service.
- Image, SVG, video, advanced workflows, reference images, editing, model installation/removal, checkpoint/LoRA/embedding imports, Civitai account/search/download operations, and review/cancellation controls call the same native functions as the client.
- Native file pickers become browser uploads; exports become browser downloads. Folder inputs refer to paths on the connected host.
- Asset/run pagination retrieves the full library. Image previews use bounded concurrent requests. Long operations are submitted once and polled separately, allowing progress reads and cancellation while work is running.
- The CLI Fleet host can start, recover, and cancel RALPH runs using the existing core runner and durable checkpoints. Existing Fleet chat controls remain in place.
- Fleet preserves the media iframe when switching sections so drafts and its active generation queue survive navigation.
- The media route uses the existing owner/CSRF checks, a fixed native command allowlist, bounded upload requests, and same-origin framing. Docker build inputs and the production public bundle have been updated.

## Verification performed

- Shared Media Studio: 474 tests passed across 67 suites; the expanded transport suite subsequently passed all 5 tests, including optional-field serialization, bounded thumbnail concurrency, cancellation, binary responses, Unicode chunks, and native error handling.
- Product UI: 111 tests passed after removing the superseded media component and its tests.
- Targeted CLI RALPH, chat, and desktop media bridge: 18 tests passed. The RALPH integration test executes a stored START/END flow, verifies completion and duplicate-command handling.
- Fleet API/gateway/request limits: 27 tests passed, including full-size media chunks and rejection of oversized uploads.
- Fleet protocol: 280 TypeScript tests passed.
- Native compilation and the new argument-validation Rust test passed. The initial native executable build succeeded; a later build linked successfully but could not replace the executable held open by the running debug client. Native browser checks used the linked binary without stopping that client.
- Client UI, shared packages, Fleet Manager, core, and client test TypeScript checks passed. Targeted lint passed.
- Client UI, CLI bundle, shared media bundle, and Fleet Manager production builds passed.
- Playwright on desktop and mobile exercised Basic, Advanced, Assets, Civitai, image submission, and a 260-item library beyond the old snapshot limit. The editor also passed inside a same-origin iframe with the configured security headers. These generation checks use a native-command fixture, not paid/GPU inference.
- A windowless native worker returned 444 host assets, 19 catalog models, and 9 add-ons. A native-backed browser displayed real asset previews without JavaScript errors.
- A real Fleet transport round trip uploaded a temporary PNG, imported it, resized it, read its preview, and exported it. The temporary assets and transfers were removed afterward.
- A live Civitai search through the native worker returned 3 compatible SDXL Age LoRAs.

Screenshots are under `.cache/fleet-media-review`. Run `pnpm --filter @machdoch/client build:fleet-media` followed by `pnpm verify:fleet-media` for the browser fixture; add `--native` to the script for native reads. `MACHDOCH_NATIVE_EXECUTABLE` can identify the compiled native executable.

## Remaining limits and unverified behavior

- No authenticated browser-to-running-manager-to-enrolled-host session was exercised. Development servers were not started; API/gateway tests and routed browser/native-worker checks verify the layers separately.
- Real GPU inference, paid image providers, video generation, and an actual Civitai model download/import were not repeated through Fleet. They use the existing native implementations, but routing coverage does not establish successful inference or download on every host.
- CLI media requires the Machdoch native executable and its media runtime. The standalone JavaScript-only headless archive does not include that executable. Linux operation without a graphical session remains unverified.
- RALPH remote control covers run, recovery, cancellation, and status. Full RALPH flow editing and waiting-for-input interaction are not added by this change. Existing CLI chat interview/prompt-enhancement limitations remain.
- Concurrent editors still save whole Media Studio drafts/metadata; simultaneous edits can overwrite each other. Abandoned uploads can remain in the host transfer directory after a worker crash.
- Docker files were updated, but an image build could not be tested because the Docker daemon is unavailable.
