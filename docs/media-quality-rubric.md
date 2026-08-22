# Media quality rubric

Machdoch media changes are evaluated against the same 100-point rubric. A
passing codec or a larger frame is not evidence of visual quality. Every major
pass must include decoded frames, full-speed playback, true-alpha composites,
reproducible settings, and both automatic and human review.

## Scored criteria

| Area | Weight | 9–10 evidence | Common failure evidence |
| --- | ---: | --- | --- |
| Identity and design continuity | 15 | Face, silhouette, costume, palette, props, and distinguishing details remain recognizably the same | Face/costume drift, missing or transforming props, style changes |
| Anatomy and local detail | 15 | Limbs, hands, joints, facial features, folds, and line work remain structurally credible in every sampled frame | Extra/fused fingers or limbs, collapsing anatomy, melting detail |
| Action and physical motion | 12 | The requested subject action reads clearly with weight, anticipation, follow-through, and secondary motion | Static subject, background-only motion, pose sliding |
| Temporal coherence | 15 | Stable surfaces and edges after accounting for motion; no flashing, warping, texture boil, or abrupt discontinuity | Flicker, crawling lines, sudden detail swaps, interpolation ghosts |
| Spatial image quality | 10 | Purposeful lighting and composition, clean detail at delivery size, no avoidable generation or encoding blur | Low-detail source, mush, oversharpening, compression blocks |
| Composition and aspect fit | 8 | Subject framing and negative space are intentionally adapted to the requested ratio | Stretching, blind center crop, clipped anatomy/props |
| Transparency and compositing | 15 | Stable matte, fine-detail retention, no holes, spill, halo, or contaminated edge on checker/light/dark/complementary plates | Flickering alpha, green fringe, dark/bright halo, missing hair/fabric |
| Loop or shot ending | 5 | A requested loop closes in motion and appearance; a non-looping shot ends intentionally without forced repetition | Visible seam, ping-pong reversal when not requested, duplicated hold |
| Delivery integrity | 5 | Durable publication, valid provenance, exact export, native playback, and independently decodable output | Missing CAS blob, lost alpha, proxy-only export, decode failure |

Scores are integers from 0 to 10, multiplied by their weight. A result is
reported as a weighted score out of 100. Major-studio work is a creative and
manual production standard, not a model benchmark; Machdoch must not claim that
level unless every semantic area is visually convincing under frame stepping
and full-speed playback. The practical acceptance target for the local
consumer-GPU preset is at least 75/100, no area below 6, and no critical
delivery or alpha defect.

## Automatic measurements

Run:

```powershell
python apps/client/scripts/evaluate_media_quality.py `
  --input baseline=path\to\baseline.webm `
  --input candidate=path\to\candidate.webm `
  --output tmp\quality-evidence
```

The evaluator forces WebM through `libvpx-vp9` and reads RGBA, so its alpha
evidence cannot silently become an RGB green-screen preview. It creates contact
sheets over checkerboard, white, black, magenta, and cyan plus the decoded alpha
plane. It records:

- frame count, dimensions, frame rate, alpha range, and decode integrity;
- subject sharpness and optical-flow motion magnitude;
- motion-compensated RGB residual and high-frequency residual (texture crawl);
- motion-compensated alpha residual, coverage drift, component and hole counts;
- positive green spill at fractional/structural matte edges;
- decoded first/last RGB and alpha loop seams.

Lower residuals are better only when the requested motion is still present.
Sharpness is diagnostic rather than a goal: an oversharpened or hallucinated
frame can score high. Automatic measurements therefore never replace the
semantic rubric.

## Source-anchored articulated loops

When whole-frame video diffusion changes identity, anatomy, props, or the
background, use Media Studio's `source-anchored-articulated-loop` worker
capability with reviewed masks. A manifest declares every region that may
change, periodic rigid motion for each articulated part, optional procedural
blink poses, mask-bounded clean-plate inpainting, and periodic masked light or
particle effects. Identity-critical fabric can use attachment-anchored
`wind-fabric` deformation: several integer-temporal-frequency waves travel
from the fixed attachment toward the free edge, with displacement falloff and
optional fold shading. `wind-streaks` adds a directional, edge-faded periodic
flow field without a boundary pop. The compositor outputs a forward-only
half-open cycle: it does not warp the full frame, retime generated motion,
duplicate the closure pose, or assemble a ping-pong loop.

Encode the result through the application path and verify repeated playback:

```powershell
python apps/client/scripts/render_source_anchored_loop_with_studio.py `
  manifest.json tmp\studio-source-anchored-run `
  --encoding-quality lossless
$ffmpeg = "apps\client\src-tauri\python\runtime\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"
& $ffmpeg -stream_loop 2 -i tmp\studio-source-anchored-run\studio-encode\output-0000.webm `
  -t 9 -c copy tmp\three-cycle.webm
python apps/client/scripts/verify_loop_playback.py tmp\three-cycle.webm `
  --frames-per-cycle 48 --cycles 3 --fps 16
```

AI-generated plates and facial keyframes must remain inside their reviewed
masks. Visible layers should retain the source texture, and the semantic review
must still confirm that the articulated action reads as character motion rather
than an effectively static image.

## Review protocol

1. Record the exact source assets, hashes, model revisions, prompts, negative
   prompts, adapters, seed, scheduler, steps, guidance, dimensions, frame count,
   frame rate, loop mode, matte settings, encoder settings, elapsed time, and
   device.
2. Review the source/key image before video. Reject bad anatomy, wrong identity,
   or poor composition instead of asking the video model to repair it.
3. Inspect first, last, action-extreme, and evenly sampled frames at 100% and
   200%. Then watch normal speed at least three times.
4. For alpha, inspect the alpha plane and every diagnostic plate. Watch edges
   around hair, fabric, hands, props, and fast motion.
5. Score all nine areas, cite the visible evidence, identify the weakest one,
   and research that weakness before the next pass.
6. Re-run preview, durable publication, and verified-original export checks for
   the selected final asset.
