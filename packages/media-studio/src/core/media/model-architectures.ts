import type { MediaLocalModelArchitecture } from "./contracts.js";

export const MEDIA_MODEL_ARCHITECTURES: ReadonlyArray<{
  value: MediaLocalModelArchitecture;
  label: string;
}> = [
  { value: "flux-1", label: "FLUX.1" },
  { value: "flux-2", label: "FLUX.2" },
  { value: "stable-diffusion-xl", label: "SDXL" },
  { value: "pony", label: "Pony (SDXL)" },
  { value: "stable-diffusion-3", label: "Stable Diffusion 3" },
  { value: "stable-diffusion-2", label: "Stable Diffusion 2" },
  { value: "stable-diffusion-1", label: "Stable Diffusion 1" },
  { value: "krea-2", label: "Krea 2" },
  { value: "qwen-image-2.1", label: "Qwen-Image 2.1" },
  { value: "wan-2.2-ti2v", label: "WAN 2.2 TI2V" },
  { value: "ltx-video", label: "LTX Video" },
  { value: "framepack-i2v", label: "FramePack" },
  { value: "hunyuan-video-1.5-i2v", label: "HunyuanVideo 1.5" },
  { value: "minimax-h3-ref2va", label: "MiniMax H3" },
];
