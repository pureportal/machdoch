import json
import shutil
import tempfile
import unittest
from pathlib import Path

import torch
from safetensors.torch import load_file

from media_training_loop import TrainingObjective, run_training
from media_training_optimizer import create_optimizer, finetune_memory_bytes
from media_training_options import validate_options
from test_media_diffusion_training import options


class TrainingOptimizerTests(unittest.TestCase):
    def test_bf16_adafactor_restores_fp32_moments_and_exact_training_result(self):
        torch.set_num_threads(1)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            specification = {**options(), "method": "finetune", "optimizer": "adafactor",
                             "precision": "bf16", "trainable_precision": "bf16", "max_grad_norm": 0,
                             "learning_rate": 0.01, "steps": 3, "seed": 42, "resume": False}
            results = []
            for resumed in (False, True):
                torch.manual_seed(11)
                model = torch.nn.Linear(4, 3, dtype=torch.bfloat16)
                initial = model.weight.detach().clone()
                directory = root / ("resumed" if resumed else "full")
                directory.mkdir()
                if resumed:
                    shutil.copytree(root / "full/output/checkpoint-2", directory / "output/checkpoint-2")

                def loss(batch, indices, generator):
                    target = torch.randn((len(indices), 3), generator=generator)
                    return (model(batch["mean"]).float() - target).square().mean()

                objective = TrainingObjective([{"mean": torch.ones(1, 4)}], list(model.parameters()),
                                              loss, model.state_dict, model.load_state_dict)
                run_training({**specification, "resume": resumed}, directory, "optimizer-fixture",
                             objective, "cpu", torch.bfloat16)
                self.assertTrue(all(parameter.grad is None for parameter in model.parameters()))
                self.assertFalse(torch.equal(model.weight, initial))
                self.assertEqual(model.weight.dtype, torch.bfloat16)
                state = torch.load(directory / "output/checkpoint-3/state.pt", weights_only=True)
                for moments in state["optimizer"]["state"].values():
                    for value in moments.values():
                        if torch.is_tensor(value):
                            self.assertEqual(value.dtype, torch.float32)
                results.append((load_file(directory / "output/checkpoint-3/weights.safetensors"), state,
                                json.loads((directory / "progress.json").read_text())))
            for key in results[0][0]:
                torch.testing.assert_close(results[0][0][key], results[1][0][key], rtol=0, atol=0)
            for identifier, state in results[0][1]["optimizer"]["state"].items():
                for key, value in state.items():
                    other = results[1][1]["optimizer"]["state"][identifier][key]
                    if torch.is_tensor(value):
                        torch.testing.assert_close(value, other, rtol=0, atol=0)
                    else:
                        self.assertEqual(value, other)
            self.assertEqual(results[0][2]["loss"], results[1][2]["loss"])

    def test_optimizer_settings_reject_incompatible_weight_precision_and_clipping(self):
        specification = {**options(), "method": "finetune", "optimizer": "adafactor", "precision": "bf16",
                         "trainable_precision": "bf16", "max_grad_norm": 0, "four_bit": False,
                         "trigger_phrase": "token", "learning_rate": 0.001, "steps": 2,
                         "resolution": 64, "rank": 4, "seed": 42}
        validate_options(specification, ("lora", "finetune", "embedding"))
        for patch in ({"method": "lora"}, {"method": "embedding"}, {"optimizer": "adamw"},
                      {"precision": "fp16"}, {"max_grad_norm": 1}, {"trainable_precision": "fp16"}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                validate_options({**specification, **patch}, ("lora", "finetune", "embedding"))

    def test_adafactor_memory_estimate_accounts_for_factored_and_vector_states(self):
        estimates = []
        footprints = []
        for name, dtype in (("adamw", torch.float32), ("adafactor", torch.bfloat16)):
            model = torch.nn.Sequential(*(torch.nn.Linear(8, 8, dtype=dtype) for _ in range(32)))
            parameters = list(model.parameters())
            specification = {**options(), "optimizer": name, "learning_rate": 0.001,
                             "trainable_precision": "bf16" if name == "adafactor" else "float32"}
            optimizer = create_optimizer(parameters, specification)
            for parameter in parameters:
                parameter.grad = torch.ones_like(parameter)
            optimizer.step()
            allocated = sum(parameter.numel() * parameter.element_size() * 2 for parameter in parameters)
            allocated += sum(value.numel() * value.element_size() for state in optimizer.state.values()
                             for value in state.values() if torch.is_tensor(value))
            estimate = finetune_memory_bytes(parameters, specification)
            self.assertGreaterEqual(estimate, allocated - len(parameters) * 4)
            estimates.append(estimate)
            footprints.append(allocated)
        self.assertLess(estimates[1], estimates[0])
        self.assertLess(footprints[1], footprints[0] / 2)


if __name__ == "__main__":
    unittest.main()
