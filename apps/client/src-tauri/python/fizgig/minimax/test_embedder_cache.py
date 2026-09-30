import unittest
from types import SimpleNamespace

import torch

from fizgig.minimax.embedder import MiniMaxH3TextEncoder, TextEmbeddingCache


class FakeTokenizer:
    pad_token_id = 0

    def __call__(self, caption, **_kwargs):
        token = ord(caption[0]) if caption else self.pad_token_id
        return {"input_ids": torch.tensor([[token]], dtype=torch.long)}


class FakeModel:
    def __init__(self):
        self.calls = 0

    def eval(self):
        return self

    def __call__(self, input_ids):
        self.calls += 1
        return SimpleNamespace(last_hidden_state=input_ids.unsqueeze(-1).to(torch.float32))


class TextEmbeddingCacheTests(unittest.TestCase):
    def test_reuse_refreshes_lru_order_before_eviction(self):
        cache = TextEmbeddingCache(capacity=2)
        cache.put("a", "A")
        cache.put("b", "B")

        self.assertEqual(cache.get("a"), "A")
        cache.put("c", "C")

        self.assertEqual(cache.keys(), ("a", "c"))
        self.assertIsNone(cache.get("b"))
        self.assertEqual(len(cache), 2)

    def test_single_encode_reencodes_entries_evicted_from_the_shared_cache(self):
        model = FakeModel()
        encoder = MiniMaxH3TextEncoder(
            model, FakeTokenizer(), device="cpu", compute_dtype=torch.float32, cache_capacity=2
        )

        encoder.encode("a")
        encoder.encode("b")
        encoder.encode("a")
        encoder.encode("c")
        encoder.encode("b")

        self.assertEqual(model.calls, 4)
        self.assertEqual(encoder._cache.keys(), (("c", None), ("b", None)))

    def test_batch_deduplicates_misses_and_uses_the_same_cache_policy(self):
        model = FakeModel()
        encoder = MiniMaxH3TextEncoder(
            model, FakeTokenizer(), device="cpu", compute_dtype=torch.float32, cache_capacity=2
        )

        first = encoder.encode_batch(["a", "b", "a"])

        self.assertEqual(model.calls, 1)
        self.assertTrue(torch.equal(first[0], first[2]))
        self.assertNotEqual(first[0].data_ptr(), first[2].data_ptr())
        encoder.encode("a")
        self.assertEqual(model.calls, 1)

        encoder.encode_batch(["c", "d"])
        encoder.encode("a")

        self.assertEqual(model.calls, 3)
        self.assertEqual(len(encoder._cache), 2)


if __name__ == "__main__":
    unittest.main()
