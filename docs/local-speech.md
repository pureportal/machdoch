# Local speech input

Select a model in Settings → Voice → Speech input. Chat dictation and Quick Voice use the same model, microphone selection, and key terms.

| Choice              | Runtime                                   | Languages                                                | Model file                  |
| ------------------- | ----------------------------------------- | -------------------------------------------------------- | --------------------------- |
| Whisper base        | whisper.cpp                               | Multilingual; can translate to English                   | 59.7 MB, Q5_1               |
| Whisper tiny        | whisper.cpp                               | Multilingual; can translate to English                   | 32.2 MB, Q5_1               |
| Whistle             | Needle native CPU engine, decoder depth 8 | English, German, French, Spanish, Italian, Dutch, Polish | 16.9 MB                     |
| Whistle lightweight | Needle native CPU engine, decoder depth 2 | Same seven languages                                     | Shares the Whistle file     |
| Phonon-2            | Fermion 0.2.9 CPU engine                  | English                                                  | 163.5 MB compressed weights |

Whistle's lightweight version selects two trained decoder layers from the same checkpoint. Its encoder still uses all eight layers. See the [Whistle release](https://www.cactuscompute.com/blog/whistle) and [model card](https://huggingface.co/Cactus-Compute/whistle).

The microphone recording is converted to 16 kHz mono PCM WAV before inference. Whistle recordings longer than 30 seconds are split near quiet frames and all samples are retained. Key terms use the model's native decoder biasing; Phonon-2 accepts 25 terms, the other choices accept 100. Phonon-2 uses the [official CPU implementation](https://www.fermionresearch.com/docs/speech/).

Inference uses bundled files. Local providers bypass cloud transcript formatting and translation. Whisper translates within its model when enabled; Whistle and Phonon-2 transcribe the original language. The Phonon worker runs in an isolated Python process with Hugging Face offline mode and network connections disabled. Cancellation and deadlines stop that process before deleting its temporary recording. Native speech processes disable Needle telemetry with `NEEDLE_TELEMETRY=0` and `DO_NOT_TRACK=1`, as documented by [Cactus Compute](https://github.com/cactus-compute/needle#deploy).

## Building

Run `node apps/client/scripts/prepare-whisper-model.mjs` and `node apps/client/scripts/prepare-local-speech.mjs`. Tauri's build hooks run both. These packaging steps download assets; inference does not download models or install packages. Repeated preparation verifies cached assets against pinned SHA-256 digests.

The desktop bundle includes both Whisper checkpoints, Whistle, the native Needle executable, Phonon-2, and portable Python with CPU PyTorch and Fermion dependencies. Windows also bundles the Microsoft C++ runtime beside the application and Python executables. The Windows speech resources occupy approximately 1 GB before installer compression. Packaging removes compiler libraries, headers, debug symbols, and bytecode caches while retaining licence files. No system Python installation is required. Microphone permission is still required at first use.

Phonon-2 uses Fermion's bundled Torch implementation of Parakeet. Initialization and decoding took approximately two minutes on the Windows verification machine; each recording starts a fresh worker. Its deadline allows five minutes for startup plus time proportional to recording length, up to fifteen minutes. Whisper and Whistle allow ninety seconds for startup plus recording time. Cancellation remains available during initialization.

The resource map excludes model download archives, caches, and staging directories. Licence source archives are retained in the legal resources. The manifest rejects unsupported packaging platforms. Windows x64, Linux x64, Linux arm64, and macOS arm64 have pinned native assets; verification on one platform does not establish behavior on the others.

## Licensing

Whisper weights and whisper.cpp retain their MIT notices. Whistle and its separate Needle runtime retain Apache-2.0 licences and Cactus Compute attribution. Phonon-2 weights retain CC-BY-4.0 and the full Fermion Research/NVIDIA Parakeet attribution and modification history; the Fermion code is Apache-2.0. Machdoch does not modify these weights or native binaries.

`resources/speech-legal` contains model notices, portable Python dependency licences, and the native Rust dependencies embedded in Python wheels. Preparation creates versioned inventories, follows the pinned source lockfiles, and checks every retained licence's digest. Source archives for libsndfile and native crates under MPL or CDDL are included. Desktop licence generation copies these resources into the release legal bundle alongside the pinned asset manifest. See [third-party notices](../THIRD_PARTY_NOTICES.md) for retained files and source links.

Windows retains Microsoft's runtime terms, Visual Studio distribution terms, distributable list, and DLL integrity inventory. Windows installers display the runtime terms alongside Machdoch's licence. Redistributing these unmodified Microsoft DLLs requires a valid Visual Studio licence and compliance with its distribution conditions; see Microsoft's [distributable list](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution). The runtime's end-user licence alone does not grant redistribution rights.

## Verification

`node --test apps/client/scripts/download-verified-asset.test.mjs apps/client/scripts/windows-speech-runtime.test.mjs` verifies cached assets, corruption handling, interrupted downloads, cleanup, and cabinet extraction boundaries. Python boundary and offline tests are in `apps/client/src-tauri/python/test_local_speech.py`.

Frontend tests cover each local provider's WAV conversion, request lifecycle, cancellation, and avoidance of cloud processing. Rust tests cover audio validation, chunk continuity, silence, output limits, and temporary recording cleanup.

For real model tests, set `MACHDOCH_WHISPER_TEST_AUDIO` to whisper.cpp's 16 kHz mono `samples/jfk.wav`, prepare the resources, and run `cargo test --lib voice:: -- --ignored --nocapture --test-threads=1` from `apps/client/src-tauri`. These tests assert a known phrase for every model, detected English for Whistle and Phonon-2, switching between Whisper models, and cancellation/deadlines of the bundled process. Model accuracy on other speakers, languages, microphones, and machines requires recordings from those conditions.

Windows x64 verification on 2026-10-06 passed real transcription for all five choices. Whisper base and tiny took 10–21 seconds each using Vulkan on an AMD RX 9070; Whistle and its lightweight decoder took 5–8 seconds on CPU. Phonon-2 took 103 seconds in the final app test run. A separate check after removing development files took 130 seconds, returned 22 word timestamps, and confirmed that its C++ DLLs loaded from the bundled Python directory. These timings include initialization and depend on the machine and recording.

The focused frontend suite passed 77 tests. The rebuilt app passed all 42 Rust voice tests, including the five real-runtime tests, with none ignored. These checks cover every model, native telemetry opt-outs, cancellation, deadlines, silence, and model switching. Python checks cover offline inference boundaries, licence inventories, and packaging. Production UI and CLI builds and UI/test type checks passed. Live microphone interaction, clean-machine installer execution, and the other operating systems remain unverified; the Tauri automation connection timed out.
