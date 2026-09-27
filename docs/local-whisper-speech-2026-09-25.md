# Bundled Whisper speech input

Machdoch runs Whisper in its Rust process through `whisper-rs`, which builds and statically links `whisper.cpp`. It decodes microphone recordings in the WebView, sends 16 kHz mono PCM WAV to Rust, and transcribes with a bundled multilingual `base` Q5 model. No API key, Python environment, server, or network connection is needed at runtime.

The model is pinned to a [ggml release](https://huggingface.co/ggerganov/whisper.cpp/blob/c521a4b02f422512d734391fdf08bb08c0862f68/ggml-base-q5_1.bin), with a 59,707,625-byte size and SHA-256 `422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898`. The build preparation script checks both before Tauri packages the model as a resource. The model is downloaded at build time rather than committed to Git.

The multilingual `base` model supports both transcription and speech translation to English. The local path uses Whisper's translation task directly. Saved key terms are supplied as an initial prompt. Text formatting uses the configured task model.

`whisper.cpp` is [MIT licensed](https://github.com/ggml-org/whisper.cpp/blob/v1.9.4/LICENSE), and the [OpenAI model is MIT licensed](https://huggingface.co/openai/whisper-base). Their notices are included in the application resources. `whisper-rs` is [Unlicense](https://codeberg.org/tazz4843/whisper-rs). `faster-whisper` is also [MIT licensed](https://github.com/SYSTRAN/faster-whisper), but it brings a Python and CTranslate2 deployment stack that is unnecessary for Machdoch's in-process speech input.

The current native build uses the CPU backend, so transcription speed depends on the user's CPU. The local path uses greedy decoding and scales the encoder's audio context to short recordings to reduce unnecessary work. `GGML_NATIVE=OFF` keeps release binaries portable across supported CPUs. Building the app requires CMake, a C++ compiler, and libclang for Rust bindings in addition to the existing Rust and Tauri toolchain; the installed app does not. The bundled model adds about 60 MB before installer compression.
