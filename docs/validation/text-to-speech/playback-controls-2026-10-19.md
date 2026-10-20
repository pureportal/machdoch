# Playback controls validation — 2026-10-19

Scope: shared speech playback handles and coordinator only.

Implemented:
- Coordinator volume/rate state and preferences, bounded seeking, copied loop selections, and explicit unavailable errors.
- Optional typed `PlaybackHandle.setLoop(selection: PlaybackLoop | null): void` and `setOutputDevice(deviceId: string): Promise<void>`.
- `PlaybackLoop` is `{ start: number; end: number }` in seconds. Loops require finite completed seekable audio and satisfy `0 <= start < end <= duration`. Seeking outside an active selection requires clearing it.
- Audio-element selection loops and sequence loops across clips. Sequence handles carry volume, rate and the selected output into subsequent clips and use measured clip durations before metadata loads.
- Output selection is exposed only when the underlying audio element or PCM AudioContext implements `setSinkId`. An empty device ID selects the default output. Unsupported output selection throws rather than switching implementations.
- Selected-device removal pauses the retained audio element or suspends the retained PCM context and reports a recoverable blocked state. User resume reuses those objects and PCM buffers. System speech resumes its existing utterance. No recovery path requests synthesis or regenerates audio.
- Live PCM and system speech explicitly advertise seeking and selection loops as unavailable.

Integration:
- Subscribe with `speechPlayback.subscribe(listener)` or read `speechPlayback.snapshot()`.
- Use `setVolume(0..1)`, `setRate(0 < rate <= 4)`, `seek(seconds)`, `setLoop({start,end})`, `setLoop(null)`, and `await setOutputDevice(deviceId)`.
- State includes optional `volume`, `rate`, `loop`, `loopAvailable`, `seekable`, `outputDeviceSupported` and `outputDeviceId`.
- Offer selection looping when `loopAvailable` is true and output selection when `outputDeviceSupported` is true. Await device changes and surface rejected selections.
- After blocked playback, device loss or a recoverable playback error, call `resume()` on the existing coordinator. Calling `play(item)` starts a new foreground item.
- Output enumeration and any browser permission UI remain caller responsibilities. Capabilities report actual handle support.

Focused checks:
- Added 11 Node tests in `packages/speech/src/playback-controls.test.ts`.
- Cases cover volume/rate preferences, loop bounds and immutable state, media ending and loop clearing, device removal, gesture blocking, recovery identity, failed/unsupported output selection, unknown-duration rejection, sequence boundary and cross-clip loops, stale item output completion, PCM suspension/recovery, system-speech unavailable controls, and seeking from measured sequence durations before metadata.
- Attempted `node --experimental-strip-types --test packages/speech/src/playback-controls.test.ts`.
- The execution tool rejected the command before process creation with `blocked by policy`. No tests executed; no passing results are claimed.
- Source review identified and corrected metadata-dependent sequence seeking, stale coordinator output completion and Node type-stripping compatibility in the new test fixture.
- No servers started; no models, inference assets or caches were created.

Limits:
- Browser/device behavior and timing, real audio hardware hot-plug, output permissions, and test execution remain unverified because command execution is blocked in this worker.
- Audio-element loop boundaries are enforced on media progress/end events; sample-accurate looping is not guaranteed.
- An irrecoverably closed PCM context remains an explicit failure. Recovery implemented here preserves suspended contexts and their buffers.
- This report covers the delegated playback-controls objective, not acceptance of the full Text to Speech suite.
