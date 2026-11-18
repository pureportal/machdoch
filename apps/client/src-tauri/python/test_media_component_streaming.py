import unittest
from unittest import mock

import torch

import media_diffusers_worker as worker


def _layers(count):
    return torch.nn.ModuleList(torch.nn.Linear(4, 4) for _ in range(count))


class ComponentStreamingTests(unittest.TestCase):
    def stream(self, component):
        with mock.patch("diffusers.hooks.apply_group_offloading") as apply:
            worker._stream_component_layers(component, torch.device("cuda"), torch)
        return [(call.args[0], call.kwargs["offload_type"]) for call in apply.call_args_list]

    def test_nested_layer_list_streams_by_block_and_siblings_by_leaf(self):
        encoder = torch.nn.Module()
        encoder.shared = torch.nn.Embedding(8, 4)
        encoder.encoder = torch.nn.Module()
        encoder.encoder.block = _layers(3)
        encoder.encoder.norm = torch.nn.LayerNorm(4)
        encoder.dropout = torch.nn.Dropout()
        self.assertEqual(self.stream(encoder), [(encoder.encoder, "block_level"), (encoder.shared, "leaf_level")])

    def test_top_level_layer_list_streams_the_whole_component_by_block(self):
        decoder = torch.nn.Module()
        decoder.embed_tokens = torch.nn.Embedding(8, 4)
        decoder.layers = _layers(2)
        self.assertEqual(self.stream(decoder), [(decoder, "block_level")])

    def test_component_without_layer_list_streams_by_leaf(self):
        projection = torch.nn.Sequential(torch.nn.Linear(4, 4))
        self.assertEqual(self.stream(projection), [(projection, "leaf_level")])


if __name__ == "__main__":
    unittest.main()
