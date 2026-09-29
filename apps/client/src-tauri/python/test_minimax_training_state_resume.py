import json
import tempfile
import unittest
from pathlib import Path

import torch
from safetensors.torch import save_file

from fizgig.minimax import trainer


class MiniMaxTrainingStateResumeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.state_dir = Path(self.directory.name) / "run-000003-state"
        self.state_dir.mkdir()

        self.saved_network = torch.nn.Linear(1, 1, bias=False)
        self.saved_optimizer = torch.optim.Adam(self.saved_network.parameters())
        self.saved_network(torch.tensor([[2.0]])).sum().backward()
        self.saved_optimizer.step()

        save_file(self.saved_network.state_dict(), self.state_dir / "lora.safetensors")
        torch.save(self.saved_optimizer.state_dict(), self.state_dir / "optimizer.pt")
        (self.state_dir / "training_state.json").write_text(
            json.dumps({"epoch": 3, "global_step": 7}), encoding="utf-8")

        self.network = torch.nn.Linear(1, 1, bias=False)
        with torch.no_grad():
            self.network.weight.fill_(-7)
        self.optimizer = torch.optim.Adam(self.network.parameters())

    def test_missing_optimizer_is_rejected_before_network_weights_are_applied(self):
        (self.state_dir / "optimizer.pt").unlink()

        with self.assertRaisesRegex(RuntimeError, "missing optimizer.pt") as error:
            trainer._load_training_state(str(self.state_dir), self.network, self.optimizer,
                                         device="cpu")

        self.assertIn("Choose another complete saved state or start a new run", str(error.exception))
        self.assertEqual(self.network.weight.item(), -7)
        self.assertEqual(self.optimizer.state_dict()["state"], {})

    def test_complete_state_restores_network_and_optimizer(self):
        epoch, global_step, meta = trainer._load_training_state(
            str(self.state_dir), self.network, self.optimizer, device="cpu")

        self.assertEqual((epoch, global_step), (3, 7))
        self.assertEqual(meta, {"epoch": 3, "global_step": 7})
        self.assertTrue(torch.equal(self.network.weight, self.saved_network.weight))
        saved_state = self.saved_optimizer.state_dict()["state"][0]
        restored_state = self.optimizer.state_dict()["state"][0]
        self.assertTrue(torch.equal(restored_state["step"], saved_state["step"]))
        self.assertTrue(torch.equal(restored_state["exp_avg"], saved_state["exp_avg"]))
        self.assertTrue(torch.equal(restored_state["exp_avg_sq"], saved_state["exp_avg_sq"]))


if __name__ == "__main__":
    unittest.main()
