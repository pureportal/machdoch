from typing import Any


def clip_windows(tokenizer: Any, channels: list[list[int]], context_size: int,
                 chunk_count: int, device: Any) -> tuple[Any, Any]:
    import torch

    content_size = context_size - 2
    rows = []
    masks = []
    for ids in channels:
        for chunk_index in range(chunk_count):
            start = chunk_index * content_size
            content = ids[start:start + content_size]
            padding = content_size - len(content)
            rows.append([tokenizer.bos_token_id, *content, tokenizer.eos_token_id]
                        + [tokenizer.pad_token_id] * padding)
            masks.append([1] * (len(content) + 2) + [0] * padding)
    return (torch.tensor(rows, dtype=torch.long, device=device),
            torch.tensor(masks, dtype=torch.long, device=device))
