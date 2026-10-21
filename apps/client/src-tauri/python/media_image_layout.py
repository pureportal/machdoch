import copy
import json
import math
import re


def text_length(value):
    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


def validate_layout(value):
    if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or value["schemaVersion"] != 1 or set(value) - {"schemaVersion", "canvas", "caption", "background", "elements", "relations"}:
        raise ValueError("Invalid image layout")
    canvas = value.get("canvas", {})
    if not isinstance(canvas, dict) or set(canvas) != {"width", "height"}:
        raise ValueError("Invalid layout canvas")
    width, height = canvas.get("width"), canvas.get("height")
    if any(type(size) is not int or not 1 <= size <= 8192 for size in [width, height]):
        raise ValueError("Invalid layout dimensions")
    elements = value.get("elements")
    if not isinstance(elements, list) or len(elements) > 256 or not isinstance(value.get("caption"), str):
        raise ValueError("Invalid layout elements or caption")
    if text_length(value["caption"]) > 16000 or ("background" in value and not valid_color(value["background"])):
        raise ValueError("Invalid caption or background")
    ids = set()
    for element in elements:
        if not isinstance(element, dict):
            raise ValueError("Invalid layout element")
        identity = element.get("id")
        if not isinstance(identity, str) or len(identity) > 64 or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", identity) or identity in ids:
            raise ValueError("Each layout element requires a unique ID")
        ids.add(identity)
        box = element.get("box", [])
        if not isinstance(box, list) or len(box) != 4 or any(type(coordinate) is not int for coordinate in box):
            raise ValueError("Layout boxes require four integer pixel coordinates")
        if not 0 <= box[0] < box[2] <= width or not 0 <= box[1] < box[3] <= height:
            raise ValueError("Layout boxes must have positive area inside the canvas")
        if element.get("kind") not in {"object", "text", "shape"} or type(element.get("zIndex")) is not int or not -10000 <= element["zIndex"] <= 10000:
            raise ValueError("Invalid layout kind or layer")
        if not isinstance(element.get("description"), str) or text_length(element["description"]) > 4000:
            raise ValueError("Layout elements require descriptions")
        if "opacity" in element and (type(element["opacity"]) not in (int, float) or not math.isfinite(element["opacity"]) or not 0 <= element["opacity"] <= 1):
            raise ValueError("Invalid element opacity")
        allowed = {"id", "kind", "description", "box", "zIndex", "opacity"}
        if element["kind"] == "object":
            allowed.update({"assetId", "fit", "cutout"})
            if "assetId" in element and (not isinstance(element["assetId"], str) or not element["assetId"].strip() or text_length(element["assetId"]) > 256):
                raise ValueError("Invalid layout asset reference")
            if ("fit" in element and element["fit"] not in {"contain", "cover", "stretch"}) or ("cutout" in element and type(element["cutout"]) is not bool):
                raise ValueError("Invalid object fitting or cutout")
        elif element["kind"] == "text":
            allowed.update({"text", "font", "fontSize", "color", "align", "direction"})
            if not isinstance(element.get("text"), str) or not 1 <= text_length(element["text"]) <= 8000:
                raise ValueError("Text elements require literal text")
            if not isinstance(element.get("font"), str) or not element["font"].strip() or text_length(element["font"]) > 256 or type(element.get("fontSize")) is not int or not 1 <= element["fontSize"] <= 1024:
                raise ValueError("Invalid text font or size")
            if not valid_color(element.get("color")) or element.get("align") not in {"left", "center", "right"} or element.get("direction") not in {"ltr", "rtl"}:
                raise ValueError("Invalid text color or alignment")
        else:
            allowed.update({"shape", "color"})
            if element.get("shape") not in {"rectangle", "ellipse", "arrow"} or not valid_color(element.get("color")):
                raise ValueError("Invalid shape")
        if set(element) - allowed:
            raise ValueError("Unexpected layout element fields")
    if "relations" in value:
        relations = value["relations"]
        if not isinstance(relations, list) or len(relations) > 1024:
            raise ValueError("Invalid layout relations")
        for relation in relations:
            if not isinstance(relation, dict) or set(relation) != {"kind", "subjectId", "objectId"} or relation["kind"] not in {"left-of", "above", "on", "inside"} or relation["subjectId"] not in ids or relation["objectId"] not in ids or relation["subjectId"] == relation["objectId"]:
                raise ValueError("Invalid layout relation")
    return copy.deepcopy(value)


def valid_color(value):
    return isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", value) is not None


def compile_native_layout(value, architecture):
    layout = validate_layout(value)
    width, height = layout["canvas"]["width"], layout["canvas"]["height"]
    if width % 16 or height % 16:
        raise ValueError("Native layout dimensions must be divisible by 16")
    elements = sorted(layout["elements"], key=lambda element: element["zIndex"])
    if any(element.get("assetId") for element in elements):
        raise ValueError("Use composition for layout assets")
    if architecture in {"moss-image-base", "moss-image-sft"}:
        items = []
        for element in elements:
            x0, y0, x1, y1 = element["box"]
            item = {"label": "text" if element["kind"] == "text" else "object", "caption": element["description"]}
            if element["kind"] == "shape":
                item["caption"] += f"\n{element['color']} {element['shape']}"
            if element["kind"] == "text":
                item["text"] = element["text"]
            item["bbox"] = [y0 - height // 2, x0 - width // 2, y1 - height // 2, x1 - width // 2]
            items.append(item)
        prompt = {"summary": {"meta": [], "canvas": "single", "caption": layout["caption"]}, "items": items,
                  "bbox_coord_space": "abs_centralized", "bbox_format": "yxyx"}
        return {"prompt": json.dumps(prompt, ensure_ascii=False, separators=(",", ":")), "elementIds": [element["id"] for element in elements]}
    if architecture == "flux-3-image-klein":
        boxes = []
        for element in elements:
            x0, y0, x1, y1 = element["box"]
            bbox = [y0 / height, x0 / width, y1 / height, x1 / width]
            rounded = [round(coordinate * 1000) for coordinate in bbox]
            if rounded[0] >= rounded[2] or rounded[1] >= rounded[3]:
                raise ValueError(f"Enlarge {element['id']}; its box collapses in FLUX 3 coordinates")
            description = element["description"]
            if element["kind"] == "shape":
                description += f"\n{element['color']} {element['shape']}"
            if element["kind"] == "text":
                description += "\nLiteral text: " + json.dumps(element["text"], ensure_ascii=False)
            boxes.append({"id": element["id"], "desc": description, "bbox": bbox})
        rows = [{"id": box["id"], "bbox": [round(value * 1000) for value in box["bbox"]], "desc": box["desc"]} for box in boxes]
        caption = layout["caption"] + " " + " ".join(f"<{box['id']}> {box['desc']}" for box in boxes)
        return {"prompt": caption + " " + json.dumps(rows, ensure_ascii=False), "boxes": boxes, "rows": rows, "captionSource": "immutable-layout"}
    raise ValueError("The selected model has no native layout adapter")
