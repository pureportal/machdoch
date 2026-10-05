# Third-party notices

The Apache licence in the repository root applies to Machdoch-owned material. It does not replace the following upstream licences or the licences of dependencies and downloaded models.

| Material | Licence and attribution |
| --- | --- |
| UI components derived from [shadcn/ui](https://github.com/shadcn-ui/ui) | MIT; Copyright (c) 2023 shadcn. The complete notice is in [legal/third-party/shadcn-ui/LICENSE.txt](legal/third-party/shadcn-ui/LICENSE.txt). |
| Bundled [Fizgig](https://github.com/shootthesound/Fizgig) Python modules | Retain [LICENSE-fizgig.txt](apps/client/src-tauri/python/LICENSE-fizgig.txt) and [THIRD_PARTY_NOTICES-fizgig.md](apps/client/src-tauri/python/THIRD_PARTY_NOTICES-fizgig.md). The ComfyUI-derived MiniMax portions have unresolved GPL provenance; see [legal/README.md](legal/README.md). |
| Code adapted from [MuseTalk](https://github.com/TMElyralab/MuseTalk) | Retain [LICENSE-MuseTalk.txt](apps/client/src-tauri/python/LICENSE-MuseTalk.txt). |
| Diffusers-derived training code | Retain [LICENSE-diffusers-training.txt](apps/client/src-tauri/python/LICENSE-diffusers-training.txt) and source copyright notices. |
| Whisper.cpp and the bundled Whisper model | Retain [LICENSE-whisper.cpp.txt](apps/client/src-tauri/resources/whisper/LICENSE-whisper.cpp.txt) and [LICENSE-whisper-model.txt](apps/client/src-tauri/resources/whisper/LICENSE-whisper-model.txt). |
| Windows Vulkan loader | Retain [LICENSE-vulkan-loader.txt](apps/client/src-tauri/resources/whisper/LICENSE-vulkan-loader.txt). |

Release licence bundles contain the full licence, copyright and notice files collected from the installed dependency versions. Lucide's combined ISC and Feather MIT notices are preserved in full. Desktop bundles also include the licence of the exact embedded Node.js version and notices for the Rust graph; Linux staging retains ONNX Runtime's licence and third-party notices.

The dependency inventories in [docs/licensing](docs/licensing/README.md) describe the audit snapshot, including development and optional packages. They are not an exact contents list for an individual release.
