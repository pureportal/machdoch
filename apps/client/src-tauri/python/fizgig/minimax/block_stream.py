"""Streams the int8 ConvRot weights of swapped MiniMax H3 blocks from host memory to the GPU.

Each swapped block keeps its ``qdata``/``wscale`` in one pageable host buffer. Before a block
runs, its buffer is copied into a page-locked host slot and from there, on a copy stream, into
a device slot, so the transfer of block ``n + slots`` overlaps the compute of block ``n``. Only
the slots are page-locked: the pinned commitment stays at ``slots`` block sizes no matter how
many blocks are swapped. The frozen base is never copied back to the host.

At any time a module's ``qdata``/``wscale`` point either at its host buffer or at a device slot
holding its own bytes, so parking the model on the CPU always moves the right data.
"""

from __future__ import annotations

import torch

ALIGNMENT = 256
STREAMED = ("qdata", "wscale")


def _is_streamed(module) -> bool:
    return type(module).__name__ == "ConvRotInt8Linear"


class Int8BlockStream:
    kind = "int8"

    def __init__(self, blocks, swap_from: int, device: torch.device, ring_size: int = 2):
        self.blocks = blocks
        self.swap_from = swap_from
        self.device = torch.device(device)
        self.sources = {
            index: [(module, name) for module in blocks[index].modules() if _is_streamed(module) for name in STREAMED]
            for index in range(swap_from, len(blocks))
        }
        self.sources = {index: entries for index, entries in self.sources.items() if entries}
        if not self.sources:
            raise RuntimeError("the swapped blocks hold no int8 ConvRot weights")
        self.n_swap = len(self.sources)
        self.slots = min(max(1, int(ring_size)), self.n_swap)
        first = [getattr(module, name) for module, name in self.sources[min(self.sources)]]
        self.offsets, self.block_bytes = self._layout(first)
        self.host = {index: self._host_buffer(index) for index in self.sources}
        self.stream = torch.cuda.Stream(device=self.device)
        self.pinned = None
        self.device_slots = None
        self.reset_slots()
        self.hooks = [blocks[index].register_full_backward_hook(self._backward_hook(index)) for index in self.sources]

    @property
    def staged_gb(self) -> float:
        return self.n_swap * self.block_bytes / 1e9

    @staticmethod
    def _layout(tensors):
        offsets, total = [], 0
        for tensor in tensors:
            total = -(-total // ALIGNMENT) * ALIGNMENT
            offsets.append(total)
            total += tensor.numel() * tensor.element_size()
        return offsets, total

    def _views(self, flat: torch.Tensor, index: int):
        return [flat[offset: offset + getattr(module, name).numel() * getattr(module, name).element_size()]
                .view(getattr(module, name).dtype).view(getattr(module, name).shape)
                for offset, (module, name) in zip(self.offsets, self.sources[index])]

    def _host_buffer(self, index: int):
        flat = torch.empty(self.block_bytes, dtype=torch.uint8)
        views = self._views(flat, index)
        for view, (module, name) in zip(views, self.sources[index]):
            view.copy_(getattr(module, name))
            setattr(module, name, view)
        return flat, views

    def _bind(self, index: int, views):
        for view, (module, name) in zip(views, self.sources[index]):
            setattr(module, name, view)

    def reset_slots(self):
        self.owner = [None] * self.slots
        self.slot_free = [None] * self.slots
        self.copied = [None] * self.slots
        self.ready = {}

    def move_static_weights_to_gpu(self):
        for index in self.sources:
            for module in self.blocks[index].modules():
                for parameter in module.parameters(recurse=False):
                    parameter.data = parameter.data.to(self.device)
                for name, buffer in list(module.named_buffers(recurse=False)):
                    if not (_is_streamed(module) and name in STREAMED):
                        module._buffers[name] = buffer.to(self.device)

    def prepare(self):
        if self.device_slots is None:
            self.pinned = [torch.empty(self.block_bytes, dtype=torch.uint8, pin_memory=True) for _ in range(self.slots)]
            self.device_slots = [torch.empty(self.block_bytes, dtype=torch.uint8, device=self.device)
                                 for _ in range(self.slots)]
        self.unbind_to_cpu()
        for rank in range(self.slots):
            self._load(rank)
        torch.cuda.current_stream(self.device).wait_stream(self.stream)

    def _load(self, rank: int):
        index = self.swap_from + rank
        slot = rank % self.slots
        flat = self.device_slots[slot]
        views = self._views(flat, index)
        if self.owner[slot] == index:
            self._bind(index, views)
            return
        if self.owner[slot] is not None:
            self._bind(self.owner[slot], self.host[self.owner[slot]][1])
        if self.copied[slot] is not None:
            self.copied[slot].synchronize()
        self.pinned[slot].copy_(self.host[index][0])
        with torch.cuda.stream(self.stream):
            if self.slot_free[slot] is not None:
                self.stream.wait_event(self.slot_free[slot])
            flat.copy_(self.pinned[slot], non_blocking=True)
            self.copied[slot] = self.stream.record_event()
        self.owner[slot] = index
        self.ready[index] = self.copied[slot]
        self._bind(index, views)

    def wait_for_block(self, index: int):
        if index not in self.sources:
            return
        if self.owner[(index - self.swap_from) % self.slots] != index:
            self._load(index - self.swap_from)
        torch.cuda.current_stream(self.device).wait_event(self.ready[index])

    def submit_move_blocks_forward(self, index: int):
        if index not in self.sources:
            return
        rank = index - self.swap_from
        self.slot_free[rank % self.slots] = torch.cuda.current_stream(self.device).record_event()
        if rank + self.slots < self.n_swap:
            self._load(rank + self.slots)

    def _backward_hook(self, index: int):
        def prefetch_previous(module, grad_input, grad_output):
            rank = index - self.swap_from
            self.slot_free[rank % self.slots] = torch.cuda.current_stream(self.device).record_event()
            if rank >= self.slots:
                self._load(rank - self.slots)
        return prefetch_previous

    def unbind_to_cpu(self):
        for index, (_, views) in self.host.items():
            self._bind(index, views)
        self.reset_slots()

    def release(self):
        self.stream.synchronize()
        for hook in self.hooks:
            hook.remove()
        self.hooks = []
        self.unbind_to_cpu()
        self.device_slots = None
        self.pinned = None
        torch.cuda.empty_cache()
