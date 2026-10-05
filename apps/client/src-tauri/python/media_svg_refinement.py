import io
import json
import math
import re
from dataclasses import dataclass
from typing import Any, Callable, Protocol
from xml.etree import ElementTree

SVG_NAMESPACE = "http://www.w3.org/2000/svg"
SVG_START = re.compile(r"<(?:[A-Za-z_][\w.-]*:)?svg(?=[\s/>]|$)")
REFINEMENT_ROUNDS = {"balanced": 1, "quality": 3}
ACCEPTABLE_SCORE = 9.0


class TextGenerator(Protocol):
    def __call__(
        self, messages: list[dict[str, Any]], *, max_new_tokens: int,
        temperature: float,
    ) -> str: ...


@dataclass(frozen=True)
class SvgCritique:
    score: float
    critique: str
    suggestions: str


def extract_svg(text: str) -> str:
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", text, re.IGNORECASE):
        raise ValueError("The model returned SVG with a document type or entity declaration")
    start = SVG_START.search(text)
    if start is None:
        raise ValueError("The model returned no SVG. Revise the prompt and retry.")
    source = text[start.start():]
    parser = ElementTree.XMLPullParser(events=("start", "end"))
    depth = 0
    offset = 0
    try:
        for boundary in re.finditer(">", source):
            end = boundary.end()
            parser.feed(source[offset:end])
            offset = end
            for event, element in parser.read_events():
                if event == "start":
                    if depth == 0 and element.tag not in ("svg", f"{{{SVG_NAMESPACE}}}svg"):
                        raise ValueError("The model returned an invalid SVG namespace")
                    depth += 1
                else:
                    depth -= 1
                    if depth == 0:
                        parser.close()
                        if SVG_START.search(source[end:]):
                            raise ValueError("The model returned multiple SVG documents for one candidate")
                        return source[:end]
    except ElementTree.ParseError as error:
        raise ValueError(
            "The model returned malformed SVG. Revise the prompt and retry."
        ) from error
    raise ValueError("The model returned an incomplete SVG. Revise the prompt and retry.")


def parse_critique(text: str) -> SvgCritique:
    report = text.strip()
    fenced = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", report, re.DOTALL)
    if fenced:
        report = fenced.group(1)
    try:
        data = json.loads(report)
    except json.JSONDecodeError as error:
        raise ValueError("IntroSVG returned an invalid visual critique JSON report") from error
    if not isinstance(data, dict):
        raise ValueError("IntroSVG visual critique must be a JSON object")
    score = data.get("score")
    if (
        isinstance(score, bool) or not isinstance(score, (int, float))
        or not 0 <= score <= 10
    ):
        raise ValueError("IntroSVG visual critique must contain a score between zero and ten")
    for field in ("critique", "suggestions"):
        if not isinstance(data.get(field), str) or not data[field].strip():
            raise ValueError(f"IntroSVG visual critique must contain nonempty {field}")
    return SvgCritique(float(score), data["critique"].strip(), data["suggestions"].strip())


def svg_viewport(root: Any) -> tuple[float, float]:
    viewbox = root.get("viewBox")
    dimensions = None
    if viewbox is not None:
        try:
            values = [float(value) for value in re.split(r"[\s,]+", viewbox.strip())]
        except ValueError as error:
            raise ValueError("SVG must define a finite viewBox") from error
        if len(values) != 4 or not all(math.isfinite(value) for value in values) or min(values[2:]) <= 0:
            raise ValueError("SVG must define a positive, finite viewBox")
        dimensions = values[2:]
    units = {"": 1, "px": 1, "in": 96, "cm": 96 / 2.54, "mm": 96 / 25.4, "pt": 96 / 72, "pc": 16}
    sizes = []
    for index, name in enumerate(("width", "height")):
        value = root.get(name)
        if value is None:
            size = dimensions[index] if dimensions else 0
        else:
            match = re.fullmatch(r"\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z%]*)\s*", value)
            if match is None:
                raise ValueError("SVG must define positive, finite dimensions or a viewBox")
            amount, unit = float(match.group(1)), match.group(2)
            if unit == "%" and dimensions:
                size = amount * dimensions[index] / 100
            elif unit in units:
                size = amount * units[unit]
            else:
                raise ValueError("SVG dimensions must use pixels or physical units")
        if not math.isfinite(size) or size <= 0:
            raise ValueError("SVG must define positive, finite dimensions or a viewBox")
        sizes.append(size)
    return sizes[0], sizes[1]


def validate_svg_resources(root: Any) -> None:
    for element in root.iter():
        for name, value in element.attrib.items():
            if name.rsplit("}", 1)[-1] == "href" and not value.strip().startswith(("#", "data:")):
                raise ValueError("Generated SVG cannot reference external resources")
        content = " ".join([*element.attrib.values(), element.text or ""])
        if re.search(r"@import\b", content, re.IGNORECASE):
            raise ValueError("Generated SVG cannot reference external resources")
        for resource in re.findall(r"url\s*\((.*?)\)", content, re.IGNORECASE):
            if not resource.strip().strip("\"'").startswith(("#", "data:")):
                raise ValueError("Generated SVG cannot reference external resources")


def render_svg(svg: str) -> Any:
    try:
        import resvg_py
    except (ImportError, OSError) as error:
        raise RuntimeError(
            "The SVG renderer is missing. Repair the local runtime and retry."
        ) from error
    from PIL import Image

    try:
        root = ElementTree.fromstring(extract_svg(svg))
        validate_svg_resources(root)
        width, height = svg_viewport(root)
        if root.tag == "svg":
            root.set("xmlns", SVG_NAMESPACE)
        root.set("width", str(width))
        root.set("height", str(height))
        scale = 512 / max(width, height)
        png = resvg_py.svg_to_bytes(
            svg_string=ElementTree.tostring(root, encoding="unicode"),
            width=max(1, round(width * scale)), height=max(1, round(height * scale)),
            background="white",
        )
        with Image.open(io.BytesIO(png)) as image:
            return image.convert("RGB")
    except Exception as error:
        raise ValueError(f"The generated SVG could not be rendered for visual critique: {error}") from error


def _visual_messages(
    prompt: str, references: list[Any], rendered: Any, instruction: str,
) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [
        {"type": "text", "text": f"Original design prompt: {prompt}"},
    ]
    for index, reference in enumerate(references, start=1):
        content.extend([
            {"type": "text", "text": f"Original reference image {index}:"},
            {"type": "image", "image": reference},
        ])
    content.extend([
        {"type": "text", "text": "Rendered SVG draft (shown on a white backdrop):"},
        {"type": "image", "image": rendered},
        {"type": "text", "text": instruction},
    ])
    return [{"role": "user", "content": content}]


def refine_svg(
    svg: str, prompt: str, references: list[Any], max_new_tokens: int,
    max_refinements: int, generate_text: TextGenerator,
    progress: Callable[[str, float], None] | None = None,
) -> str:
    best_svg = svg
    best_score = -1.0
    for iteration in range(max_refinements + 1):
        if progress:
            progress("Reviewing SVG", 2 * iteration / (2 * max_refinements + 1))
        rendered = render_svg(svg)
        critique_messages = _visual_messages(
            prompt, references, rendered,
            "Act as a professional SVG design critic. Evaluate the rendered draft against "
            "the original design prompt and reference images. Inspect missing or incorrect "
            "subjects, geometry, proportions, alignment, overlaps, clipping, unwanted "
            "details, colors, stroke consistency, and requested text. Judge visible design "
            "quality and prompt alignment; XML validity alone does not imply good artwork. "
            "Do not request a background merely because the preview has a white backdrop. "
            "Return only a JSON object with these three fields: "
            '"score": a number from 0 to 10; '
            '"critique": a detailed explanation of visible shortcomings; '
            '"suggestions": a string containing two to four specific SVG corrections, '
            "or a statement that no corrections are needed if the draft is excellent.",
        )
        critique = parse_critique(generate_text(
            critique_messages, max_new_tokens=2048, temperature=0.0,
        ))
        if critique.score >= best_score:
            best_svg = svg
            best_score = critique.score
        if critique.score >= ACCEPTABLE_SCORE or iteration == max_refinements:
            break
        if progress:
            progress("Refining SVG", (2 * iteration + 1) / (2 * max_refinements + 1))
        correction_messages = _visual_messages(
            prompt, references, rendered,
            "Improve the SVG draft using the visual critique and the original design goal. "
            "Preserve correct elements and fix the specific defects. Output only one "
            "complete, self-contained SVG document with vector graphics.\n"
            f"Draft SVG:\n{svg}\n"
            f"Visual critique:\n{critique.critique}\n"
            f"Required corrections:\n{critique.suggestions}",
        )
        revised = extract_svg(generate_text(
            correction_messages, max_new_tokens=max_new_tokens, temperature=0.2,
        ))
        if revised == svg:
            raise ValueError("IntroSVG did not apply the visual corrections. Revise the prompt and retry.")
        svg = revised
    if progress:
        progress("SVG refined", 1.0)
    return best_svg
