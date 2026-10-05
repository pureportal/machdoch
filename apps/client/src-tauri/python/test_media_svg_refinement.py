import base64
import io
import json
import sys
import unittest
from unittest.mock import Mock, patch

from PIL import Image

from media_svg_refinement import extract_svg, parse_critique, refine_svg, render_svg


RED_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
    '<rect width="100" height="100" fill="red"/></svg>'
)
BLUE_SVG = RED_SVG.replace('fill="red"', 'fill="blue"')
GREEN_SVG = RED_SVG.replace('fill="red"', 'fill="green"')
PURPLE_SVG = RED_SVG.replace('fill="red"', 'fill="purple"')


def report(score: float, critique: str = "The square has the wrong color.") -> str:
    return json.dumps({
        "score": score, "critique": critique,
        "suggestions": "1. Make the square blue.\n2. Preserve its proportions.",
    })


def message_images(messages):
    return [
        item["image"] for message in messages for item in message["content"]
        if item["type"] == "image"
    ]


def message_text(messages):
    return "\n".join(
        item["text"] for message in messages for item in message["content"]
        if item["type"] == "text"
    )


class SvgParsingTests(unittest.TestCase):
    def test_complete_svg_is_preserved_inside_fences_and_prose(self):
        response = "Here is the illustration:\n```xml\n" + RED_SVG + "\n```\nDone."
        self.assertEqual(extract_svg(response), RED_SVG)

    def test_nested_svg_does_not_finish_at_the_inner_closing_tag(self):
        svg = '<svg><svg><circle r="2"/></svg><rect width="4" height="4"/></svg>'
        self.assertEqual(extract_svg(svg), svg)

    def test_prefixed_namespace_and_whitespace_closing_tag(self):
        svg = '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:rect/></s:svg >'
        self.assertEqual(extract_svg(svg), svg)

    def test_self_closing_svg_is_complete(self):
        svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"/>'
        self.assertEqual(extract_svg(svg), svg)

    def test_comments_cdata_and_quoted_greater_than_are_parsed(self):
        svg = (
            '<svg data-label="A > B"><!-- </svg> -->'
            '<text><![CDATA[A > B </svg>]]></text></svg>'
        )
        self.assertEqual(extract_svg(svg), svg)

    def test_escaped_text_is_preserved(self):
        svg = '<svg><text>Fish &amp; chips &lt; 5</text></svg>'
        self.assertEqual(extract_svg(svg), svg)

    def test_no_svg_and_similar_tag_names_are_rejected(self):
        for text in ("", "No image", "<svgish/>", "<SVG/>"):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "no SVG"):
                extract_svg(text)

    def test_incomplete_root_is_rejected(self):
        for text in ("<svg", "<svg>", '<svg><path d="M0 0"/>', "<svg><svg/></svg"):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "incomplete"):
                extract_svg(text)

    def test_malformed_xml_is_rejected_even_with_a_closing_svg_tag(self):
        for text in (
            "<svg><g></svg>", "<svg><rect></circle></svg>", "<svg>&unknown;</svg>",
            '<svg width="1" width="2"></svg>',
        ):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "malformed"):
                extract_svg(text)

    def test_wrong_namespace_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "namespace"):
            extract_svg('<svg xmlns="https://example.com/not-svg"/>')

    def test_multiple_documents_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "multiple SVG"):
            extract_svg(RED_SVG + "\n" + BLUE_SVG)

    def test_document_types_and_entities_are_rejected(self):
        for text in (
            '<!DOCTYPE svg SYSTEM "file:///private.svg">' + RED_SVG,
            '<!DOCTYPE svg [<!ENTITY a "expanded">]><svg>&a;</svg>',
        ):
            with self.subTest(text=text), self.assertRaisesRegex(ValueError, "declaration"):
                extract_svg(text)


class CritiqueParsingTests(unittest.TestCase):
    def test_numeric_score_and_actionable_feedback(self):
        critique = parse_critique(report(7.5))
        self.assertEqual(critique.score, 7.5)
        self.assertIn("wrong color", critique.critique)
        self.assertIn("Make the square blue", critique.suggestions)

    def test_json_fence_and_boundary_scores(self):
        for score in (0, 10):
            with self.subTest(score=score):
                critique = parse_critique("\n```json\n" + report(score) + "\n```\n")
                self.assertEqual(critique.score, score)

    def test_invalid_scores_are_rejected(self):
        for score in (True, False, "9", None, -1, 11, float("nan"), float("inf"), 10 ** 400):
            with self.subTest(score=repr(score)), self.assertRaisesRegex(ValueError, "score"):
                parse_critique(report(score))

    def test_feedback_fields_must_be_nonempty_strings(self):
        for field in ("critique", "suggestions"):
            for value in (None, "", "  ", [], 2):
                data = json.loads(report(4))
                data[field] = value
                with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, field):
                    parse_critique(json.dumps(data))

    def test_missing_fields_are_rejected(self):
        for field in ("score", "critique", "suggestions"):
            data = json.loads(report(4))
            del data[field]
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, field):
                parse_critique(json.dumps(data))

    def test_malformed_json_and_non_object_reports_are_rejected(self):
        for text in ('{"score": 9', report(4) + report(5), "No critique", "[]", "null"):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_critique(text)


class SvgRefinementTests(unittest.TestCase):
    def test_rendered_feedback_and_references_reach_critic_and_correction(self):
        reference = Image.new("RGB", (10, 10), "yellow")
        previews = [Image.new("RGB", (16, 16), "red"), Image.new("RGB", (16, 16), "blue")]
        generator = Mock(side_effect=[report(4), BLUE_SVG, report(9.5)])
        with patch("media_svg_refinement.render_svg", side_effect=previews) as renderer:
            result = refine_svg(RED_SVG, "A blue square", [reference], 16384, 1, generator)
        self.assertEqual(result, BLUE_SVG)
        self.assertEqual([call.args[0] for call in renderer.call_args_list], [RED_SVG, BLUE_SVG])
        first_critic, correction, final_critic = generator.call_args_list
        self.assertEqual(message_images(first_critic.args[0]), [reference, previews[0]])
        self.assertEqual(message_images(correction.args[0]), [reference, previews[0]])
        self.assertEqual(message_images(final_critic.args[0]), [reference, previews[1]])
        correction_text = message_text(correction.args[0])
        self.assertIn(RED_SVG, correction_text)
        self.assertIn("A blue square", correction_text)
        self.assertIn("The square has the wrong color.", correction_text)
        self.assertIn("Make the square blue", correction_text)
        self.assertEqual(correction.kwargs["max_new_tokens"], 16384)

    def test_every_quality_revision_is_rendered_and_final_revision_is_assessed(self):
        drafts = [RED_SVG, BLUE_SVG, GREEN_SVG, PURPLE_SVG]
        previews = [Image.new("RGB", (8, 8), color) for color in ("red", "blue", "green", "purple")]
        generator = Mock(side_effect=[
            report(3), BLUE_SVG, report(5), GREEN_SVG, report(6), PURPLE_SVG, report(8),
        ])
        with patch("media_svg_refinement.render_svg", side_effect=previews) as renderer:
            result = refine_svg(RED_SVG, "A purple square", [], 32768, 3, generator)
        self.assertEqual(result, PURPLE_SVG)
        self.assertEqual([call.args[0] for call in renderer.call_args_list], drafts)
        self.assertEqual(generator.call_count, 7)
        for iteration in range(4):
            self.assertEqual(
                message_images(generator.call_args_list[iteration * 2].args[0]),
                [previews[iteration]],
            )
        for iteration in range(3):
            self.assertIn(
                drafts[iteration], message_text(generator.call_args_list[iteration * 2 + 1].args[0]),
            )

    def test_a_strong_initial_critique_stops_without_correction(self):
        generator = Mock(return_value=report(9))
        with patch("media_svg_refinement.render_svg", return_value=Image.new("RGB", (8, 8))):
            result = refine_svg(RED_SVG, "A red square", [], 32768, 3, generator)
        self.assertEqual(result, RED_SVG)
        self.assertEqual(generator.call_count, 1)

    def test_the_best_assessed_draft_is_selected_when_later_drafts_regress(self):
        generator = Mock(side_effect=[report(4), BLUE_SVG, report(8), GREEN_SVG, report(5)])
        with patch("media_svg_refinement.render_svg", return_value=Image.new("RGB", (8, 8))):
            result = refine_svg(RED_SVG, "A blue square", [], 32768, 2, generator)
        self.assertEqual(result, BLUE_SVG)
        self.assertEqual(generator.call_count, 5)

    def test_invalid_critique_is_an_error_even_for_valid_xml(self):
        generator = Mock(return_value='{"score": 9, "critique": "It parses."}')
        with patch("media_svg_refinement.render_svg", return_value=Image.new("RGB", (8, 8))):
            with self.assertRaisesRegex(ValueError, "suggestions"):
                refine_svg(RED_SVG, "A blue square", [], 16384, 1, generator)
        self.assertEqual(generator.call_count, 1)

    def test_invalid_revision_does_not_return_an_earlier_draft_as_success(self):
        generator = Mock(side_effect=[report(4), "<svg><rect></svg>"])
        with patch("media_svg_refinement.render_svg", return_value=Image.new("RGB", (8, 8))):
            with self.assertRaisesRegex(ValueError, "malformed"):
                refine_svg(RED_SVG, "A blue square", [], 16384, 1, generator)

    def test_unchanged_revision_is_an_explicit_error(self):
        generator = Mock(side_effect=[report(4), RED_SVG])
        with patch("media_svg_refinement.render_svg", return_value=Image.new("RGB", (8, 8))):
            with self.assertRaisesRegex(ValueError, "did not apply"):
                refine_svg(RED_SVG, "A blue square", [], 16384, 1, generator)

    def test_render_failure_never_becomes_a_visual_quality_score(self):
        generator = Mock()
        with patch("media_svg_refinement.render_svg", side_effect=ValueError("Invalid drawing")):
            with self.assertRaisesRegex(ValueError, "Invalid drawing"):
                refine_svg(RED_SVG, "A blue square", [], 16384, 1, generator)
        generator.assert_not_called()

    def test_real_raster_feedback_changes_after_revision(self):
        generator = Mock(side_effect=[report(4), BLUE_SVG, report(9)])
        result = refine_svg(RED_SVG, "A blue square", [], 16384, 1, generator)
        self.assertEqual(result, BLUE_SVG)
        first_image = message_images(generator.call_args_list[0].args[0])[0]
        final_image = message_images(generator.call_args_list[2].args[0])[0]
        self.assertEqual(first_image.getpixel((256, 256)), (255, 0, 0))
        self.assertEqual(final_image.getpixel((256, 256)), (0, 0, 255))


class SvgRenderingTests(unittest.TestCase):
    def test_real_renderer_preserves_aspect_ratio_and_visible_colors(self):
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">'
            '<rect width="100" height="100" fill="red"/></svg>'
        )
        image = render_svg(svg)
        self.assertEqual(image.size, (512, 256))
        self.assertEqual(image.mode, "RGB")
        self.assertEqual(image.getpixel((128, 128)), (255, 0, 0))
        self.assertEqual(image.getpixel((384, 128)), (255, 255, 255))

    def test_explicit_physical_dimensions_set_the_viewport_ratio(self):
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1in" '
            'viewBox="0 0 100 100"><circle cx="50" cy="50" r="20" fill="blue"/></svg>'
        )
        self.assertEqual(render_svg(svg).size, (512, 256))

    def test_large_intrinsic_dimensions_have_bounded_raster_size(self):
        svg = '<svg width="1000000000" height="2000000000"><rect width="1" height="1"/></svg>'
        self.assertEqual(render_svg(svg).size, (256, 512))

    def test_undefined_or_invalid_dimensions_are_explicit_errors(self):
        for svg in (
            "<svg><circle r=\"5\"/></svg>",
            '<svg width="0" height="5"/>',
            '<svg width="nan" height="5"/>',
            '<svg width="-5" height="5"/>',
        ):
            with self.subTest(svg=svg), self.assertRaisesRegex(ValueError, "dimensions"):
                render_svg(svg)

    def test_external_images_are_rejected_instead_of_fetched_or_silently_removed(self):
        for url in ("https://example.invalid/image.png", "file:///private.png"):
            svg = (
                '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
                f'<image href="{url}" width="100" height="100"/></svg>'
            )
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "external resources"):
                render_svg(svg)

    def test_embedded_images_render_without_external_resource_access(self):
        buffer = io.BytesIO()
        Image.new("RGB", (4, 4), "blue").save(buffer, format="PNG")
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            f'<image href="data:image/png;base64,{encoded}" width="100" height="100"/></svg>'
        )
        image = render_svg(svg)
        self.assertEqual(image.getpixel((256, 256)), (0, 0, 255))

    def test_invalid_viewbox_is_reported_as_a_rendering_error(self):
        for viewbox in ("0 0 0 100", "0 0 -1 100", "0 0 100", "0 0 nan 100", "invalid"):
            svg = f'<svg viewBox="{viewbox}"><rect width="10" height="10"/></svg>'
            with self.subTest(viewbox=viewbox), self.assertRaisesRegex(ValueError, "viewBox"):
                render_svg(svg)

    def test_internal_paint_and_use_references_are_rendered(self):
        svg = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
            '<defs><linearGradient id="paint"><stop stop-color="blue"/>'
            '<stop offset="1" stop-color="blue"/></linearGradient>'
            '<rect id="square" width="100" height="100" fill="url(#paint)"/></defs>'
            '<use href="#square"/></svg>'
        )
        self.assertEqual(render_svg(svg).getpixel((256, 256)), (0, 0, 255))

    def test_missing_renderer_is_reported_with_a_recovery_instruction(self):
        with patch.dict(sys.modules, {"resvg_py": None}):
            with self.assertRaisesRegex(RuntimeError, "renderer is missing"):
                render_svg(RED_SVG)


if __name__ == "__main__":
    unittest.main()
