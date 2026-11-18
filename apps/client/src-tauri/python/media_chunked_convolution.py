from __future__ import annotations

import torch
import torch.nn.functional as F

COLUMN_BUDGET_BYTES = 256 << 20


def chunk_large_convolutions(module: torch.nn.Module, budget: int = COLUMN_BUDGET_BYTES) -> int:
    """Run stride-1 2D convolutions in row bands with a kernel-sized halo.

    Native HIP convolutions unfold their whole input first, so a full-resolution decoder layer
    needs gigabytes of scratch memory. Bands bound that scratch while every output pixel still
    sees exactly the same receptive field, so the result has no seams.
    """
    count = 0
    for convolution in module.modules():
        if (
            isinstance(convolution, torch.nn.Conv2d)
            and convolution.kernel_size != (1, 1)
            and convolution.stride == (1, 1)
            and convolution.dilation == (1, 1)
            and convolution.padding_mode == "zeros"
            and isinstance(convolution.padding, tuple)
        ):
            convolution.forward = _banded_forward(convolution, budget)
            count += 1
    return count


def _banded_forward(convolution: torch.nn.Conv2d, budget: int):
    kernel_height, kernel_width = convolution.kernel_size
    padding_height, padding_width = convolution.padding

    def forward(states: torch.Tensor) -> torch.Tensor:
        batch, channels, height, width = states.shape
        output_height = height + 2 * padding_height - kernel_height + 1
        output_width = width + 2 * padding_width - kernel_width + 1
        row_bytes = batch * channels * kernel_height * kernel_width * output_width * states.element_size()
        rows = max(1, budget // row_bytes)
        if rows >= output_height:
            return F.conv2d(states, convolution.weight, convolution.bias,
                            padding=convolution.padding, groups=convolution.groups)
        padded = F.pad(states, (0, 0, padding_height, padding_height))
        output = states.new_empty(batch, convolution.out_channels, output_height, output_width)
        for start in range(0, output_height, rows):
            stop = min(start + rows, output_height)
            output[:, :, start:stop] = F.conv2d(
                padded[:, :, start:stop + kernel_height - 1], convolution.weight, convolution.bias,
                padding=(0, padding_width), groups=convolution.groups,
            )
        return output

    return forward
