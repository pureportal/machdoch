import json
from pathlib import Path
import sys


root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root / "apps/client/src-tauri/python"))
from download_media_verification_models import download


credentials = root / ".cache/image-engine-native/user-config/civitai.json"
key = json.loads(credentials.read_text(encoding="utf-8"))["apiKey"]
download(
    Path("D:/Models/machdoch/downloads/civitai"),
    2167454,
    2441386,
    "flux2DEVGGUFByCity96_q4KM.gguf",
    key,
)
