# OpenPose pose guidance

Machdoch now turns a pose preset or a structured agent pose request into a COCO 18-joint PNG. The PNG enters the existing `source.image` pose reference path. Local Diffusers execution loads the architecture-matched ControlNet and applies the pose image to conditioning. Advanced flows keep the same graph model and can use an imported pose map or one created by the flow assistant.

This follows the ComfyUI pattern of feeding a pose image through a ControlNet loader and apply step, including strength and start/end controls. Machdoch does not run ComfyUI, so adding ComfyUI nodes or a preprocessor dependency would duplicate its existing Diffusers pipeline. The generated skeleton makes preprocessing unnecessary for presets and agent-created poses. An imported OpenPose map remains available for custom poses.

| Image architecture | Pose guidance | Setup |
| --- | --- | --- |
| Stable Diffusion 1.5 | Supported | Install the SD 1.5 OpenPose ControlNet in Basic. |
| Stable Diffusion 2 | Supported by the existing runtime | Supply a compatible SD 2 OpenPose ControlNet manually; no pinned automatic download is provided. |
| Stable Diffusion XL, Pony | Supported | Install the SDXL OpenPose ControlNet in Basic. |
| FLUX, Krea, Qwen, SD 3, hosted models | Unavailable in the current image pipeline | Use a supported local Stable Diffusion model. |

The agent response has a required `poseMaps` array alongside `graphJson`. Each map specifies canvas aspect ratio and one to four people, with pose, position, scale, and mirror fields. The graph refers to each map with a temporary `pose-map:<id>` asset ID. Machdoch validates every map, creates the PNG assets, then replaces those IDs before applying the flow. The assistant can create a flow before a matching ControlNet is installed; generation still requires the model component.

The automatic downloads are pinned by URL, size, and SHA-256 in `openpose_components.json`. SD 2 has no pinned automatic install because the safetensors candidate is available only on a pull request ref; users can supply a compatible component manually.

## Verification

Playwright exercised the desktop-backed Basic and Advanced interfaces. Three local SD 1.5 generations completed with OpenPose ControlNet on an AMD Radeon RX 9070:

| Flow | Input | Run | Visual result |
| --- | --- | --- | --- |
| Basic | Standing preset | `264742ed-a710-406c-9cd5-d6d25ac5a089` | One upright full-body person. |
| Advanced | Agent request for one standing person left and one seated person right | `f34369d1-5e10-46e8-aaef-0eb187552b8f` | Two full-body people in those positions and poses. |
| Advanced | Waving preset selected in the pose source inspector | `8321618a-362f-42e3-9813-1cc8dacb6e17` | One full-body person with a raised waving arm. |

The run records show `controlnet-openpose` conditioning and no errors. SDXL, Pony, and SD 2 were not run live because matching local checkpoints were not installed for this review. Hosted and newer architectures do not have a compatible pose ControlNet path in the current pipeline.

References:

- [ComfyUI ControlNet nodes](https://github.com/Comfy-Org/ComfyUI/blob/master/nodes.py)
- [ComfyUI ControlNet examples](https://github.com/comfyanonymous/ComfyUI_examples/blob/master/controlnet/README.md)
- [SD 1.5 OpenPose model](https://huggingface.co/lllyasviel/control_v11p_sd15_openpose)
- [SDXL OpenPose model](https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0)
- [SD 2 OpenPose safetensors candidate](https://huggingface.co/thibaud/controlnet-sd21-openpose-diffusers/tree/refs%2Fpr%2F2)
