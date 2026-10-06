import torch

from media_refmods import reference_visual_frame_count, weaken_reference


def reference_video_decode_plan(latent):
    length = latent.shape[2]
    frame_count = reference_visual_frame_count(length)
    padding = 0 if length == 1 else -(length - 2) % 5
    if padding:
        latent = torch.cat([latent, latent[:, :, -1:].expand(-1, -1, padding, -1, -1)], dim=2)
    return latent, frame_count


def prepare_saved_references(references, decoder):
    items, latents, decoded = [], [], {}
    for reference in references:
        latents.append(weaken_reference(reference))
        if reference.kind == "audio":
            items.append({"type": "audio"})
            continue
        identity = id(reference.latent)
        if identity not in decoded:
            latent = reference.latent
            if max(latent.shape[-2:]) > 128:
                raise ValueError("Visual presentation exceeds 2048 pixels; create a smaller or compressed reference")
            if reference.kind == "image":
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
                    pixels = decoder.decode(latent.to("cuda", torch.float32))[0].cpu()
                decoded[identity] = {"type": "image", "data": pixels.permute(1, 2, 0)}
            else:
                presentation, frame_count = reference_video_decode_plan(latent)
                presentation = presentation.to("cuda", torch.float32)
                count = min(8, max(2, (frame_count + 11) // 12))
                indices = torch.linspace(0, frame_count - 1, count).round().long().tolist()
                frames = []
                with torch.no_grad(), torch.autocast("cuda", dtype=torch.float16):
                    for index in indices:
                        frame = decoder.decode_middle_frame(presentation, index)[0].cpu()
                        frames.append(frame.permute(1, 2, 0))
                decoded[identity] = {"type": "video", "data": torch.stack(frames),
                                      "timestamps": [index / 24 for index in indices]}
        items.append(decoded[identity])
    return items, latents


def reference_step_schedule(references, prefix):
    if all(reference.step_curve == "constant" for reference in references):
        return None
    prefix = tuple(prefix)

    def schedule(step, total, sigma):
        progress = step / max(1, total - 1)
        return [*prefix, *(weaken_reference(reference, progress) for reference in references)]

    return schedule
