# DMAD and PDMD setup

## SDXL DMAD

1. Open **Media Studio → Assets → Models** and search for **SDXL DMAD**.
2. Choose **SDXL DMAD 1-step** or **SDXL DMAD 4-step**, then select **Download model**.
3. Review the licence and download size, accept the terms, and start the download.
4. Select **Use model**, enter a prompt in **Basic**, and generate an image.

Each download contains the matching student and all required SDXL base components, about 6.9 GB in total. Sampling settings are automatic.

For a model folder you already have, use **Import → Model folder**. The import selects a detected student and offers only the student variants included in that folder.

## MiniMax H3 DMAD and PDMD

Open **Assets → Models**, search for the variant, and select **Import model**. The setup shows a base-model link, the exact student download, and the filename to save it under. **Folder contents** lists the required components.

Use the full [MiniMax H3 base](https://huggingface.co/MiniMaxAI/MiniMax-H3) with its original text encoder. Add the student to that folder, then select **Model folder** and import it. Select **Use model**, enter a video prompt, and generate. Sampling settings are automatic.

| Variant | Student location inside the base folder |
| --- | --- |
| H3 DMAD 4-step | `distillation/dmad_minimax_h3_4step_lora_critic.safetensors` |
| H3 DMAD Full Critic 4-step | `distillation/dmad_minimax_h3_4step_full_critic.safetensors` |
| H3 PDMD 4-step | `distillation/pdmd_4nfe.safetensors` |
| H3 PDMD 2-step | `distillation/pdmd_2nfe.safetensors` |

The PDMD download is named `lora_model_0.safetensors`; save it under the matching name above.

H3 needs a CUDA or ROCm worker. The [PDMD publisher's tested setup](https://github.com/ZeamoxWang/pdmd#inference) uses 24 GB VRAM and 128 GB RAM; see the [DMAD hardware instructions](https://github.com/Yzmblog/DMAD#on-consumer-gpus) for its setup. Real H3 generation in Machdoch remains unverified.

The [H3 licence](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE) excludes the EU, UK, US, and South Korea. Use in those territories needs a separate grant. The import shows the licence before folder selection.
