import argparse
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
args = parser.parse_args()
root = args.root.resolve()
os.environ["HF_HOME"] = str(root / "cache/huggingface")
os.environ["HF_HUB_OFFLINE"] = "1"
workspace = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(workspace / "apps/client/src-tauri/python"))
from media_image_layout import compile_native_layout
from media_moss import check_prompt_tokens
from media_flux3 import generate_image
from transformers import AutoProcessor, AutoTokenizer
from diffusers.modular_pipelines.flux3.prompt_upsampler import boxes_to_canvas, split_caption

files = json.loads((root / "layout-control/evidence/moss-base-files.json").read_text())
tokenizer = AutoTokenizer.from_pretrained(str(Path(files["path"]) / "tokenizer"), local_files_only=True, trust_remote_code=False)
qwen = json.loads((root / "layout-control/evidence/qwen3vl4b-files.json").read_text())
processor = AutoProcessor.from_pretrained(qwen["path"], local_files_only=True, trust_remote_code=False)
checks = []
for name in ("scene", "dense-infographic"):
    layout = json.loads((workspace / "docs/artifacts/layout-control-2026-10-18" / f"{name}.json").read_text(encoding="utf-8"))
    moss = compile_native_layout(layout, "moss-image-base")
    payload = json.loads(moss["prompt"])
    assert list(payload) == ["summary", "items", "bbox_coord_space", "bbox_format"]
    assert moss["elementIds"] == [element["id"] for element in sorted(layout["elements"], key=lambda item: item["zIndex"])]
    for element, item in zip(sorted(layout["elements"], key=lambda item: item["zIndex"]), payload["items"]):
        assert list(item) == (["label", "caption", "text", "bbox"] if element["kind"] == "text" else ["label", "caption", "bbox"])
        if element["kind"] == "text": assert item["text"] == element["text"]
        x0,y0,x1,y1 = element["box"]
        assert item["bbox"] == [y0-layout["canvas"]["height"]//2,x0-layout["canvas"]["width"]//2,y1-layout["canvas"]["height"]//2,x1-layout["canvas"]["width"]//2]
    formatted = tokenizer.apply_chat_template([{"role":"user","content":moss["prompt"]}], tokenize=False, add_generation_prompt=True, enable_thinking=True)
    count = len(tokenizer(formatted, truncation=False)["input_ids"])
    assert count <= 4096
    flux = compile_native_layout(layout, "flux-3-image-klein")
    assert boxes_to_canvas(flux["boxes"]) == flux["rows"]
    assert split_caption(flux["prompt"])[1] == flux["rows"]
    formatted = processor.apply_chat_template([{"role":"user","content":flux["prompt"]}], tokenize=False, add_generation_prompt=True)
    flux_count = len(processor.tokenizer(formatted, truncation=False)["input_ids"])
    assert flux_count <= 8192
    checks.append({"scene":name,"elements":len(layout["elements"]),"mossTokens":count,"mossLimit":4096,"fluxTokens":flux_count,"fluxLimit":8192,"fluxRowsMatchPinnedUpstream":True,"moss":moss,"flux":flux})
destination = root / "layout-control/evidence/native-contract.json"
destination.write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps([{key:entry[key] for key in ("scene","elements","mossTokens","fluxTokens","fluxRowsMatchPinnedUpstream")} for entry in checks]))
over_limit = " orange" * 10000
rejections = []
for name, check in [
    ("moss-positive", lambda: check_prompt_tokens(SimpleNamespace(tokenizer=tokenizer), over_limit, "")),
    ("moss-negative", lambda: check_prompt_tokens(SimpleNamespace(tokenizer=tokenizer), "", over_limit)),
    ("flux-positive", lambda: generate_image(SimpleNamespace(tokenizer=processor), {"prompt": over_limit}, None)),
]:
    try:
        check()
    except ValueError as error:
        assert "tokens" in str(error) and "shorten descriptions" in str(error)
        rejections.append({"case": name, "error": str(error)})
    else:
        raise AssertionError(f"{name} accepted an over-limit prompt")
(root / "layout-control/evidence/native-token-limits.json").write_text(json.dumps(rejections, indent=2), encoding="utf-8")
print(json.dumps({"overLimitRejections": rejections, "inference": False}))
