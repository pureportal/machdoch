from pathlib import Path
import json
import sys


root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root / "apps/client/src-tauri/python"))
from download_media_verification_components import download


publisher_path = Path(__file__).with_name("flux2-dev-quantized-publisher.json")
publisher = json.loads(publisher_path.read_text(encoding="utf-8"))
files = [
    file["rfilename"]
    for file in publisher["siblings"]
    if file["rfilename"].startswith(("text_encoder/", "vae/"))
    and file["rfilename"].endswith(".safetensors")
]
download(publisher_path, files, Path("D:/Models/machdoch/downloads/flux2-dev-components"))
