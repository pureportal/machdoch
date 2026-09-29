import unittest
from types import SimpleNamespace

import torch

from fizgig.minimax.embedder import MiniMaxH3TextEncoder


class FakeTokenizer:
    pad_token_id = 0

    def __call__(self, caption, **options):
        tokens = [len(word) for word in caption.split()]
        if options.get("truncation"):
            tokens = tokens[:options["max_length"]]
        return {"input_ids": torch.tensor([tokens], dtype=torch.long)}


class FakeTextModel:
    def __init__(self):
        self.forward_count = 0

    def eval(self):
        return self

    def __call__(self, *, input_ids):
        self.forward_count += 1
        return SimpleNamespace(last_hidden_state=input_ids.unsqueeze(-1).float())


class MiniMaxTextEmbeddingCacheTests(unittest.TestCase):
    def setUp(self):
        self.model = FakeTextModel()
        self.encoder = MiniMaxH3TextEncoder(
            self.model, FakeTokenizer(), device="cpu", compute_dtype=torch.float32)
        self.caption = "one two three four"

    def test_single_encoding_separates_token_limits_and_reuses_matching_entries(self):
        uncapped = self.encoder.encode(self.caption)
        capped = self.encoder.encode(self.caption, max_length=2)

        self.assertEqual(uncapped.shape, (1, 4, 1))
        self.assertEqual(capped.shape, (1, 2, 1))
        self.assertEqual(set(self.encoder._cache), {
            (self.caption, None), (self.caption, 2)})
        self.assertTrue(torch.equal(self.encoder.encode(self.caption, max_length=0), uncapped))
        self.assertTrue(torch.equal(self.encoder.encode(self.caption, max_length=2), capped))
        self.assertTrue(torch.equal(self.encoder.encode_batch([self.caption])[0], uncapped))
        self.assertTrue(torch.equal(
            self.encoder.encode_batch([self.caption], max_length=2)[0], capped))
        self.assertEqual(self.model.forward_count, 2)

    def test_batch_and_single_encoding_share_only_matching_limit_entries(self):
        captions = [self.caption, "five six seven"]
        capped = self.encoder.encode_batch(captions, max_length=2)
        uncapped = self.encoder.encode_batch(captions)

        self.assertEqual([value.shape[1] for value in capped], [2, 2])
        self.assertEqual([value.shape[1] for value in uncapped], [4, 3])
        self.assertEqual(self.model.forward_count, 2)
        self.assertTrue(torch.equal(self.encoder.encode(self.caption, max_length=2), capped[0]))
        self.assertTrue(torch.equal(self.encoder.encode(self.caption), uncapped[0]))
        self.assertEqual(self.encoder.encode_batch(captions, max_length=2)[0].shape[1], 2)
        self.assertEqual(self.encoder.encode_batch(captions)[0].shape[1], 4)
        self.assertEqual(self.model.forward_count, 2)


if __name__ == "__main__":
    unittest.main()
