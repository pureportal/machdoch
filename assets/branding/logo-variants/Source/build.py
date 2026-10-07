import hashlib
import html
import json
from pathlib import Path

from outlines import outline_wordmark


SOURCE = Path(__file__).resolve().parent
ROOT = SOURCE.parent
COLORS = {"black": "#111820", "white": "#FFFFFF", "accent": "#197A9E", "current": "currentColor"}


def svg_document(title, artwork, width, height, color):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" role="img" aria-label="{html.escape(title)}">'
        f'<title>{html.escape(title)}</title>'
        f'<g fill="{color}" color="{color}">{artwork}</g></svg>\n'
    )


def write_assets(collection, directory):
    result = []
    for design in collection:
        folder = ROOT / directory / design["id"]
        folder.mkdir(parents=True, exist_ok=True)
        files = {}
        for name, color in COLORS.items():
            path = folder / f"machdoch-{design['id']}-{name}.svg"
            path.write_text(svg_document(
                f"Machdoch — {design['name']}", design["artwork"],
                design["width"], design["height"], color,
            ), encoding="utf-8")
            files[name] = path.relative_to(ROOT).as_posix()
        result.append({**design, "files": files})
    return result


def lockup_artwork(icon, wordmark):
    text_height = 56
    scale = text_height / wordmark["height"]
    return (
        f'<g transform="translate(4 6)">{icon["artwork"]}</g>'
        f'<g transform="translate(126 28) scale({scale})">{wordmark["artwork"]}</g>',
        round(132 + wordmark["width"] * scale, 3),
        112,
    )


def build_overview(icons, wordmarks):
    parts = ['<rect width="1440" height="1516" fill="#F5F6F7"/>']
    for title, top in [("Machdoch / Icons", 38), ("Machdoch / Wordmarks", 800)]:
        parts.append(f'<text x="32" y="{top}" fill="#111820" font-family="Arial,sans-serif" font-size="22">{title}</text>')
    for index, design in enumerate(icons):
        x, y = 32 + index % 4 * 352, 62 + index // 4 * 238
        parts.append(f'<rect x="{x}" y="{y}" width="328" height="214" rx="12" fill="white"/>')
        parts.append(f'<text x="{x + 18}" y="{y + 28}" fill="#64717D" font-family="Arial,sans-serif" font-size="13">{design["id"][:2]} / {html.escape(design["name"])}</text>')
        parts.append(f'<g fill="#111820" color="#111820" transform="translate({x + 114} {y + 57})">{design["artwork"]}</g>')
        for offset, size in [(18, 16), (68, 24), (128, 32)]:
            parts.append(f'<g fill="#111820" color="#111820" transform="translate({x + offset} {y + 172}) scale({size / 100})">{design["artwork"]}</g>')
    for index, design in enumerate(wordmarks):
        x, y = 32 + index % 3 * 469, 824 + index // 3 * 164
        scale = min(390 / design["width"], 54 / 112)
        parts.append(f'<rect x="{x}" y="{y}" width="445" height="140" rx="12" fill="white"/>')
        parts.append(f'<text x="{x + 18}" y="{y + 28}" fill="#64717D" font-family="Arial,sans-serif" font-size="13">{design["id"][:2]} / {html.escape(design["name"])}</text>')
        parts.append(f'<g fill="#111820" transform="translate({x + 22} {y + 59}) scale({scale})">{design["artwork"]}</g>')
    return svg_document("Machdoch logo variants", "".join(parts), 1440, 1516, "#111820")


def main():
    font_manifest = json.loads((SOURCE / "Fonts" / "manifest.json").read_text(encoding="utf-8"))
    for entry in font_manifest:
        path = SOURCE / "Fonts" / entry["family"] / entry["filename"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"Font checksum mismatch: {path.name}")
    icons = write_assets([
        {**design, "width": 100, "height": 100}
        for design in json.loads((SOURCE / "icons.json").read_text(encoding="utf-8"))
    ], "Icons")
    wordmarks = write_assets([
        outline_wordmark(design)
        for design in json.loads((SOURCE / "wordmarks.json").read_text(encoding="utf-8"))
    ], "Wordmarks")
    lockups = []
    for icon, wordmark in zip(icons, wordmarks, strict=True):
        artwork, width, height = lockup_artwork(icon, wordmark)
        lockups.append({
            "id": icon["id"], "name": f"{icon['name']} + {wordmark['name']}",
            "icon": icon["id"], "wordmark": wordmark["id"],
            "artwork": artwork, "width": width, "height": height,
        })
    lockups = write_assets(lockups, "Lockups")
    catalog = {"name": "Machdoch", "colors": COLORS, "icons": icons, "wordmarks": wordmarks, "lockups": lockups}
    (ROOT / "Catalog.json").write_text(json.dumps(catalog, indent=2) + "\n", encoding="utf-8")
    template = (SOURCE / "preview.html").read_text(encoding="utf-8")
    for token, filename in [("__STYLES__", "preview.css"), ("__SCRIPT__", "preview.js")]:
        template = template.replace(token, (SOURCE / filename).read_text(encoding="utf-8"))
    template = template.replace("__CATALOG__", json.dumps(catalog).replace("<", "\\u003c"))
    (ROOT / "Preview.html").write_text(template, encoding="utf-8")
    (ROOT / "Overview.svg").write_text(build_overview(icons, wordmarks), encoding="utf-8")
    print(f"Built {len(icons)} icons, {len(wordmarks)} wordmarks, {len(lockups)} example lockups; {len(COLORS)} colors each.")


if __name__ == "__main__":
    main()
