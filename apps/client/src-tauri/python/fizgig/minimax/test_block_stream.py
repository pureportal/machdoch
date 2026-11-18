import unittest

import torch

from fizgig.minimax.block_stream import Int8BlockStream
from fizgig.minimax.convrot import ConvRotInt8Linear


def _block(generator):
    block = torch.nn.Module()
    block.norm = torch.nn.LayerNorm(16)
    block.first = ConvRotInt8Linear(16, 24)
    block.second = ConvRotInt8Linear(24, 16)
    for linear in (block.first, block.second):
        linear.qdata = torch.randint(-127, 128, linear.qdata.shape, dtype=torch.int8, generator=generator)
        linear.wscale = torch.rand(linear.wscale.shape, generator=generator) / 64
    return block


def _run(blocks, states, stream=None):
    for index, block in enumerate(blocks):
        if stream is not None:
            stream.wait_for_block(index)
        for linear in (block.first, block.second):
            weight = linear.qdata.float() * linear.wscale.float()
            states = (states @ weight.T).tanh() if linear is block.first else states @ weight.T
        if stream is not None:
            stream.submit_move_blocks_forward(index)
    return states


@unittest.skipUnless(torch.cuda.is_available(), "needs a GPU")
class Int8BlockStreamTests(unittest.TestCase):
    def setUp(self):
        generator = torch.Generator().manual_seed(3)
        self.blocks = torch.nn.ModuleList(_block(generator) for _ in range(7))
        self.states = torch.randn(32, 16, generator=generator).cuda()
        self.originals = [(block.first.qdata.clone(), block.second.wscale.clone()) for block in self.blocks]
        self.expected = _run(self.blocks.to("cuda"), self.states)
        self.blocks[2:].to("cpu")
        self.stream = Int8BlockStream(self.blocks, 2, torch.device("cuda"), ring_size=2)
        self.stream.move_static_weights_to_gpu()
        self.stream.prepare()

    def tearDown(self):
        self.stream.release()

    def test_streamed_forward_matches_resident_weights_across_passes(self):
        for _ in range(3):
            self.assertTrue(torch.equal(_run(self.blocks, self.states, self.stream), self.expected))
            self.stream.prepare()
            self.assertFalse(self.blocks[6].first.qdata.is_cuda)
        self.assertEqual(self.stream.n_swap, 5)
        self.assertEqual(len(self.stream.pinned), 2)
        self.assertTrue(all(slot.is_pinned() for slot in self.stream.pinned))
        self.assertTrue(self.blocks[6].norm.weight.is_cuda)

    def test_unbind_returns_every_streamed_tensor_to_its_host_bytes(self):
        _run(self.blocks, self.states, self.stream)
        self.stream.unbind_to_cpu()
        for block, (qdata, wscale) in list(zip(self.blocks, self.originals))[2:]:
            self.assertFalse(block.first.qdata.is_cuda)
            self.assertTrue(torch.equal(block.first.qdata, qdata))
            self.assertTrue(torch.equal(block.second.wscale, wscale))

    def test_rebuilding_after_a_device_round_trip_keeps_the_weights(self):
        self.stream.release()
        self.blocks.to("cuda")
        self.stream = Int8BlockStream(self.blocks, 2, torch.device("cuda"), ring_size=3)
        self.stream.move_static_weights_to_gpu()
        self.stream.prepare()
        self.assertFalse(self.blocks[6].first.qdata.is_cuda)
        self.assertTrue(torch.equal(_run(self.blocks, self.states, self.stream), self.expected))


if __name__ == "__main__":
    unittest.main()
