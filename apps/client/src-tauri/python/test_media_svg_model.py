import base64
import io
import json
import sys
import unittest
from contextlib import ExitStack, nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch, sentinel

from PIL import Image

import media_svg_model


RED_SVG = '<svg viewBox="0 0 100 100"><rect width="100" height="100" fill="red"/></svg>'
BLUE_SVG = RED_SVG.replace('fill="red"', 'fill="blue"')
GREEN_SVG = RED_SVG.replace('fill="red"', 'fill="green"')
PURPLE_SVG = RED_SVG.replace('fill="red"', 'fill="purple"')


def critique(score):
    return json.dumps({
        "score": score, "critique": "The draft has an incorrect color.",
        "suggestions": "1. Correct the fill color.\n2. Preserve the square geometry.",
    })


class TensorInputs(dict):
    def __init__(self):
        super().__init__(input_ids=SimpleNamespace(shape=(1, 3)))
        self.device = None

    def to(self, device):
        self.device = device
        return self


class SvgModelTests(unittest.TestCase):
    def setUp(self):
        self.model = Mock()
        self.model.get_input_embeddings.return_value.weight.device = "cpu"
        self.output = MagicMock()
        self.output.__getitem__.return_value = sentinel.generated_tokens
        self.model.generate.return_value = self.output
        self.inputs = TensorInputs()
        self.processor = Mock()
        self.processor.return_value = self.inputs
        self.processor.apply_chat_template.return_value = "rendered-chat-template"
        self.processor.batch_decode.return_value = [RED_SVG]
        self.torch = SimpleNamespace(inference_mode=nullcontext)

    def request(self, policy="fast", **changes):
        request = {
            "candidateCount": 1, "prompt": "A blue square", "modelPolicy": policy,
            "model": {"path": "model-package", "packageKind": "transformers-directory"},
            "references": [],
        }
        request.update(changes)
        return request

    def test_generate_text_retains_image_order_and_decodes_only_new_tokens(self):
        messages = [
            {"role": "user", "content": [
                {"type": "image", "image": sentinel.reference},
                {"type": "text", "text": "Draw a square"},
            ]},
            {"role": "user", "content": [
                {"type": "image", "image": sentinel.rendered_draft},
                {"type": "text", "text": "Critique this image"},
            ]},
        ]
        result = media_svg_model.generate_text(
            self.model, self.processor, messages, max_new_tokens=2048, temperature=0,
        )
        self.assertEqual(result, RED_SVG)
        self.processor.assert_called_once_with(
            text=["rendered-chat-template"],
            images=[sentinel.reference, sentinel.rendered_draft], return_tensors="pt",
        )
        self.assertEqual(self.inputs.device, "cpu")
        self.output.__getitem__.assert_called_once_with((slice(None), slice(3, None)))
        self.processor.batch_decode.assert_called_once_with(
            sentinel.generated_tokens, skip_special_tokens=True,
            clean_up_tokenization_spaces=False,
        )
        self.assertFalse(self.model.generate.call_args.kwargs["do_sample"])
        self.assertNotIn("temperature", self.model.generate.call_args.kwargs)
        self.assertEqual(self.model.generate.call_args.kwargs["cache_implementation"], "offloaded")

    def test_progress_covers_loading_drafts_and_refinement_without_moving_backwards(self):
        self.processor.batch_decode.side_effect = [
            [RED_SVG], [critique(4)], [BLUE_SVG], [critique(9)],
            [GREEN_SVG], [critique(9)],
        ]
        stages = []
        with patch("media_svg_model.load_model", return_value=(self.model, self.processor)):
            with patch("media_svg_refinement.render_svg", return_value=Image.new("RGB", (8, 8))):
                result = media_svg_model.generate(
                    self.request("balanced", candidateCount=2), self.torch,
                    lambda stage, fraction: stages.append((stage, fraction)),
                )
        self.assertEqual(result, {"candidates": [BLUE_SVG, GREEN_SVG]})
        self.assertEqual(stages[0][0], "Loading SVG model")
        self.assertIn("Refining SVG", [stage for stage, _ in stages])
        fractions = [fraction for _, fraction in stages]
        self.assertEqual(fractions, sorted(fractions))
        self.assertGreaterEqual(min(fractions), 0)
        self.assertEqual(max(fractions), 1)

    def test_empty_model_response_is_an_explicit_error(self):
        self.processor.batch_decode.return_value = ["  "]
        with self.assertRaisesRegex(ValueError, "empty response"):
            media_svg_model.generate_text(
                self.model, self.processor,
                [{"role": "user", "content": [{"type": "text", "text": "Draw"}]}],
                max_new_tokens=8192, temperature=0.3,
            )

    def test_fast_generates_each_complete_candidate_without_refinement(self):
        nested_svg = '<svg><svg><circle r="2"/></svg><rect width="4" height="4"/></svg>'
        self.processor.batch_decode.side_effect = [[nested_svg], [BLUE_SVG]]
        request = self.request(candidateCount=2)
        with patch("media_svg_model.load_model", return_value=(self.model, self.processor)) as loader:
            with patch("media_svg_model.refine_svg") as refiner:
                result = media_svg_model.generate(request, self.torch)
        self.assertEqual(result, {"candidates": [nested_svg, BLUE_SVG]})
        loader.assert_called_once_with(request["model"], self.torch, False, 8192)
        self.assertEqual(self.model.generate.call_count, 2)
        refiner.assert_not_called()
        for call in self.model.generate.call_args_list:
            self.assertNotIn("stop_strings", call.kwargs)
            self.assertEqual(call.kwargs["temperature"], 0.3)

    def test_refinement_loads_vision_even_without_reference_images(self):
        for policy, tokens in (("balanced", 16384), ("quality", 32768)):
            with self.subTest(policy=policy):
                self.model.reset_mock()
                self.processor.batch_decode.side_effect = [[RED_SVG], [critique(9)]]
                request = self.request(policy)
                with patch("media_svg_model.load_model", return_value=(self.model, self.processor)) as loader:
                    with patch("media_svg_refinement.render_svg", return_value=sentinel.preview):
                        result = media_svg_model.generate(request, self.torch)
                loader.assert_called_once_with(request["model"], self.torch, True, tokens)
                self.assertEqual(result, {"candidates": [RED_SVG]})
                self.assertEqual(self.model.generate.call_count, 2)

    def test_balanced_and_quality_apply_their_bounded_visual_refinement_budgets(self):
        drafts = [RED_SVG, BLUE_SVG, GREEN_SVG, PURPLE_SVG]
        for policy, rounds in (("balanced", 1), ("quality", 3)):
            with self.subTest(policy=policy):
                self.model.reset_mock()
                responses = [[drafts[0]]]
                for iteration in range(rounds + 1):
                    responses.append([critique(4 + iteration)])
                    if iteration < rounds:
                        responses.append([drafts[iteration + 1]])
                self.processor.batch_decode.side_effect = responses
                with patch("media_svg_model.load_model", return_value=(self.model, self.processor)):
                    with patch("media_svg_refinement.render_svg", return_value=sentinel.preview) as renderer:
                        result = media_svg_model.generate(self.request(policy), self.torch)
                self.assertEqual(result, {"candidates": [drafts[rounds]]})
                self.assertEqual(self.model.generate.call_count, 2 * rounds + 2)
                self.assertEqual(
                    [call.args[0] for call in renderer.call_args_list], drafts[:rounds + 1],
                )

    def test_candidates_have_independent_drafts_and_visual_feedback(self):
        self.processor.batch_decode.side_effect = [
            [RED_SVG], [critique(4)], [BLUE_SVG], [critique(8)],
            [GREEN_SVG], [critique(3)], [PURPLE_SVG], [critique(7)],
        ]
        with patch("media_svg_model.load_model", return_value=(self.model, self.processor)):
            with patch("media_svg_refinement.render_svg", return_value=sentinel.preview) as renderer:
                result = media_svg_model.generate(
                    self.request("balanced", candidateCount=2), self.torch,
                )
        self.assertEqual(result, {"candidates": [BLUE_SVG, PURPLE_SVG]})
        self.assertEqual(
            [call.args[0] for call in renderer.call_args_list],
            [RED_SVG, BLUE_SVG, GREEN_SVG, PURPLE_SVG],
        )

    def test_reference_image_is_decoded_and_retained_for_every_visual_step(self):
        source = Image.new("RGBA", (12, 8), (255, 255, 0, 128))
        buffer = io.BytesIO()
        source.save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        self.processor.batch_decode.side_effect = [
            [RED_SVG], [critique(4)], [BLUE_SVG], [critique(9)],
        ]
        previews = [Image.new("RGB", (8, 8), "red"), Image.new("RGB", (8, 8), "blue")]
        with patch("media_svg_model.load_model", return_value=(self.model, self.processor)) as loader:
            with patch("media_svg_refinement.render_svg", side_effect=previews):
                result = media_svg_model.generate(
                    self.request("balanced", references=[encoded]), self.torch,
                )
        self.assertEqual(result, {"candidates": [BLUE_SVG]})
        self.assertTrue(loader.call_args.args[2])
        image_inputs = [call.kwargs["images"] for call in self.processor.call_args_list]
        reference = image_inputs[0][0]
        self.assertEqual(reference.mode, "RGB")
        self.assertEqual(reference.size, (12, 8))
        self.assertEqual(reference.getpixel((0, 0)), (255, 255, 0))
        self.assertEqual(image_inputs, [
            [reference], [reference, previews[0]], [reference, previews[0]],
            [reference, previews[1]],
        ])

    def test_fast_reference_generation_still_loads_the_vision_model(self):
        buffer = io.BytesIO()
        Image.new("RGB", (4, 4), "blue").save(buffer, format="PNG")
        request = self.request(references=[base64.b64encode(buffer.getvalue()).decode("ascii")])
        with patch("media_svg_model.load_model", return_value=(self.model, self.processor)) as loader:
            with patch("media_svg_model.refine_svg") as refiner:
                media_svg_model.generate(request, self.torch)
        loader.assert_called_once_with(request["model"], self.torch, True, 8192)
        refiner.assert_not_called()

    def test_invalid_request_values_fail_before_model_loading(self):
        invalid_values = [
            {"candidateCount": True}, {"candidateCount": 0}, {"candidateCount": 7},
            {"candidateCount": 1.5}, {"prompt": ""}, {"prompt": "  "}, {"prompt": None},
            {"modelPolicy": "unsupported"}, {"modelPolicy": []},
            {"references": None}, {"references": ["x"] * 5}, {"model": None},
        ]
        with patch("media_svg_model.load_model") as loader:
            for changes in invalid_values:
                with self.subTest(changes=changes), self.assertRaises(ValueError):
                    media_svg_model.generate(self.request(**changes), self.torch)
        loader.assert_not_called()

    def test_invalid_references_fail_before_model_loading(self):
        invalid_images = [
            12, "not-base64!", "", base64.b64encode(b"not an image").decode("ascii"),
        ]
        with patch("media_svg_model.load_model") as loader:
            for image in invalid_images:
                with self.subTest(image=image), self.assertRaisesRegex(ValueError, "reference"):
                    media_svg_model.generate(self.request(references=[image]), self.torch)
        loader.assert_not_called()

    def test_truncated_or_malformed_initial_svg_is_never_returned(self):
        for response in ("<svg><rect/>", "<svg><rect></svg>"):
            with self.subTest(response=response):
                self.processor.batch_decode.return_value = [response]
                with patch("media_svg_model.load_model", return_value=(self.model, self.processor)):
                    with self.assertRaisesRegex(ValueError, "incomplete|malformed"):
                        media_svg_model.generate(self.request(), self.torch)

    def test_visual_critique_errors_are_not_replaced_with_direct_output(self):
        self.processor.batch_decode.side_effect = [[RED_SVG], ["Not JSON"]]
        with patch("media_svg_model.load_model", return_value=(self.model, self.processor)):
            with patch("media_svg_refinement.render_svg", return_value=sentinel.preview):
                with self.assertRaisesRegex(ValueError, "critique JSON"):
                    media_svg_model.generate(self.request("balanced"), self.torch)


class SvgModelLoadingTests(unittest.TestCase):
    def setUp(self):
        self.torch = Mock()
        self.torch.bfloat16 = sentinel.bfloat16
        self.torch.cuda.is_available.return_value = True
        self.torch.cuda.is_bf16_supported.return_value = True
        self.torch.cuda.current_device.return_value = 0
        self.available_memory = 16 * 1024 ** 3
        self.torch.cuda.mem_get_info.return_value = (self.available_memory, self.available_memory)
        self.config = SimpleNamespace(text_config=SimpleNamespace(
            num_hidden_layers=28, num_key_value_heads=4, hidden_size=3584, num_attention_heads=28,
        ))
        self.sizing_model = Mock()
        self.visual_encoder = self.sizing_model.model.visual
        parameter = Mock()
        parameter.numel.return_value = 5 * 1024 ** 3
        self.sizing_model.parameters.return_value = [parameter]
        self.sizing_model._no_split_modules = ["DecoderLayer", "VisionBlock"]
        self.transformers = SimpleNamespace(
            AutoConfig=Mock(), AutoProcessor=Mock(), Qwen2_5_VLForConditionalGeneration=Mock(),
        )
        self.transformers.AutoConfig.from_pretrained.return_value = self.config
        self.transformers.Qwen2_5_VLForConditionalGeneration.return_value = self.sizing_model
        self.accelerate = SimpleNamespace(
            infer_auto_device_map=Mock(), init_empty_weights=nullcontext,
        )
        self.accelerate.infer_auto_device_map.return_value = {
            "patch_embed": 0, "blocks.0": 0, "blocks.1": "cpu",
        }
        self.memory_tools = SimpleNamespace(get_max_memory=Mock(return_value={
            0: self.available_memory, "cpu": 32 * 1024 ** 3,
        }))
        self.package = {"path": "model-package", "packageKind": "transformers-directory"}

    def loader_dependencies(self):
        stack = ExitStack()
        stack.enter_context(patch.dict(sys.modules, {
            "transformers": self.transformers, "accelerate": self.accelerate,
            "accelerate.utils": self.memory_tools,
        }))
        stack.enter_context(patch("media_svg_model.Path", return_value=SimpleNamespace(
            is_absolute=lambda: True, is_dir=lambda: True,
        )))
        return stack

    def test_text_model_stays_resident_and_vision_budget_includes_cache_headroom(self):
        with self.loader_dependencies():
            media_svg_model.load_model(self.package, self.torch, True, 32768)
        allocated_memory = self.accelerate.infer_auto_device_map.call_args.kwargs["max_memory"][0]
        self.assertEqual(allocated_memory, self.available_memory - 10 * 1024 ** 3 - 512 * 1024 ** 2)
        self.assertIs(self.accelerate.infer_auto_device_map.call_args.args[0], self.visual_encoder)
        self.torch.nn.Identity.assert_called_once_with()
        options = self.transformers.Qwen2_5_VLForConditionalGeneration.from_pretrained.call_args.kwargs
        self.assertEqual(options["device_map"], {"model.language_model": 0, "lm_head": 0, "model.visual.patch_embed": 0, "model.visual.blocks.0": 0, "model.visual.blocks.1": "cpu"})
        self.assertTrue(options["local_files_only"])
        self.assertFalse(options["trust_remote_code"])

    def test_text_only_fast_loading_preserves_visual_offloading(self):
        with self.loader_dependencies():
            media_svg_model.load_model(self.package, self.torch, False, 8192)
        options = self.transformers.Qwen2_5_VLForConditionalGeneration.from_pretrained.call_args.kwargs
        self.assertEqual(options["device_map"]["model.visual"], "cpu")
        self.torch.nn.Identity.assert_called_once_with()
        self.assertEqual(options["device_map"]["model.language_model"], 0)
        self.assertEqual(options["device_map"]["lm_head"], 0)
        self.accelerate.infer_auto_device_map.assert_not_called()

    def test_insufficient_gpu_memory_is_reported_before_loading_weights(self):
        self.torch.cuda.mem_get_info.return_value = (4 * 1024 ** 3, 16 * 1024 ** 3)
        with self.loader_dependencies(), self.assertRaisesRegex(ValueError, "text model does not fit"):
            media_svg_model.load_model(self.package, self.torch, True, 16384)
        self.transformers.Qwen2_5_VLForConditionalGeneration.from_pretrained.assert_not_called()

    def test_vision_that_requires_disk_swapping_is_rejected_before_loading_weights(self):
        self.accelerate.infer_auto_device_map.return_value = {"": "disk"}
        with self.loader_dependencies(), self.assertRaisesRegex(ValueError, "vision model does not fit"):
            media_svg_model.load_model(self.package, self.torch, True, 16384)
        self.transformers.Qwen2_5_VLForConditionalGeneration.from_pretrained.assert_not_called()


if __name__ == "__main__":
    unittest.main()
