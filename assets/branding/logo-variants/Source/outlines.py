import io
import json
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


FONTS = Path(__file__).resolve().parent / "Fonts"


def outline_wordmark(design):
    manifest = json.loads((FONTS / "manifest.json").read_text(encoding="utf-8"))
    entry = next(item for item in manifest if item["family"] == design["family"])
    font = TTFont(FONTS / entry["family"] / entry["filename"])
    if "fvar" in font:
        coordinates = {axis.axisTag: axis.defaultValue for axis in font["fvar"].axes}
        coordinates.update(design.get("axes", {}), wght=design["weight"])
        font = instantiateVariableFont(font, coordinates, inplace=True)
    stream = io.BytesIO()
    font.save(stream)
    units = font["head"].unitsPerEm
    normalization = 1000 / units
    shaping_font = hb.Font(hb.Face(stream.getvalue()))
    shaping_font.scale = (units, units)
    buffer = hb.Buffer()
    buffer.add_str(design["text"])
    buffer.guess_segment_properties()
    hb.shape(shaping_font, buffer, {"kern": True, "liga": True})
    glyphs = font.getGlyphSet()
    drawing = DecomposingRecordingPen(glyphs)
    glyph_order = font.getGlyphOrder()
    cursor = 0
    for info, position in zip(buffer.glyph_infos, buffer.glyph_positions):
        if info.codepoint == 0:
            raise ValueError(f"Missing glyph in {design['id']}")
        glyphs[glyph_order[info.codepoint]].draw(TransformPen(drawing, (
            normalization, 0, 0, normalization,
            cursor + position.x_offset * normalization,
            position.y_offset * normalization,
        )))
        cursor += position.x_advance * normalization + design.get("tracking", 0)
    bounds = BoundsPen(None)
    drawing.replay(bounds)
    x_min, y_min, x_max, y_max = bounds.bounds
    scale = 100 / (y_max - y_min)
    pen = SVGPathPen(None, ntos=lambda value: f"{value:.3f}".rstrip("0").rstrip("."))
    drawing.replay(TransformPen(pen, (
        scale, 0, 0, -scale, 6 - x_min * scale, 6 + y_max * scale,
    )))
    font.close()
    return {
        **design,
        "artwork": f'<path d="{pen.getCommands()}"/>',
        "width": round((x_max - x_min) * scale + 12, 3),
        "height": 112,
    }
