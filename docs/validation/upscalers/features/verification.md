Upscaling now supports 2×, 4×, and 8× presets, a 1–8× slider and numeric input, and minimum output sizes by width/height, long/short edges, or shortest edge. Targets preserve aspect ratio, round upward to whole pixels, and leave pixels unchanged when the source already meets the minimum. Factors beyond a model's native scale use repeated model passes before resizing to the requested dimensions.

Tile modes are Automatic, Manual, Divide by factor, and Full frame. Automatic tiles use live free GPU memory and reusable PyTorch cache at inference time. Manual tiles accept 32–2048 pixels; the factor divides the longest edge by 2–16. The workspace shows an estimated tile size and VRAM requirement. Warnings remain advisory, and invalid or oversized settings block submission. Settings carry into image/video nodes in Advanced, whose cards summarize the selected sizing mode.

Validation passed on Windows with an AMD Radeon RX 9070:

- [842 Media Studio tests](media-studio-tests.log), [23 Python tests](python-tests.log), and [15 native workflow tests](rust-tests.log).
- Media Studio type checking and lint, desktop UI type checking, formatting, and production UI/native builds passed. The final native build is recorded in [final-build-native.log](final-build-native.log).
- [17 Playwright checks and eight native runs](playwright-results.json), followed by [four final UI checks](final-ui-results.json). No renderer exceptions or invalid-number warnings occurred in the final check. Layouts passed at 1280, 1000, and 800 pixels.
- Real SPAN 2.75× and 8× images, Real-ESRGAN minimum width/height, SwinIR portrait edge targets, video minimum shortest edge, 1.1× video with odd dimensions, an already-large-enough image, and an Advanced canvas run all completed.
- [All eight exported outputs passed independent checks](output-verification.json): SHA-256, dimensions, alpha channels, unchanged pixels for an already-satisfied minimum, and differences from ordinary Lanczos resizing for AI outputs. Both videos retained their frame count, frame rate, frame order, and decoded audio samples.
- [Artifact checks](artifacts.json) match both tested desktop executables and their deployed upscale workers to the reports and current Python sources. The final build also verifies the corrected Advanced summary and recovery after clearing a tile divisor.

Screenshots: [custom scale](span-custom-2.75x.png), [minimum dimensions](realesrgan-minimum-dimensions.png), [portrait edges](swinir-portrait-minimum-edges.png), [compact layout](layout-800.png), [VRAM warning](final-vram-warning.png), and [Advanced summary](final-advanced-summary.png).

VRAM figures are model-family heuristics, not measured peak usage or a guarantee. The warning compares against reported total GPU memory; Automatic tiles use free memory at run time. Custom architectures and other GPU applications can change actual requirements. Low-memory planning was tested with simulated budgets; physical VRAM exhaustion was not forced. Other GPUs/platforms and long videos were not validated in this pass. Existing output limits remain: 64 million pixels per image/native pass, 16 million pixels per video frame, and 16384 pixels per output edge.

Saved upscale nodes using the previous string-scale, fixed-tile settings must be recreated with the new settings. No compatibility conversion was added. Restart the desktop runtime to load the native schema changes.

The scripts beside this report run against an isolated desktop profile on CDP port 9237, with a separate library and copies of the installed upscale models. No development server was started. Build with `node docs/validation/upscalers/features/build-native.mjs`; run `verify-ui.mjs`, `verify-outputs.py`, and `verify-artifacts.mjs` against the corresponding validation builds. `verify-final-ui.mjs` covers the final interface fixes. Only the validation desktop processes were stopped after testing.
