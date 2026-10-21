import json
from pathlib import Path
import sys


root = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(root / "apps/client/src-tauri/python"))
from download_media_verification_models import download


credentials = root / ".cache/image-engine-native/user-config/civitai.json"
key = json.loads(credentials.read_text(encoding="utf-8"))["apiKey"]
storage = Path("D:/Models/machdoch/downloads/civitai")
for version, filename in [
    (2247497, "illustrious_masterpieces_v3.safetensors"),
    (1070123, "illustrious_noobai_epsilon_pred_1_masterpieces_v1.safetensors"),
    (1040450, "quality_modifiers_masterpieces_v1.safetensors"),
]:
    download(storage, 929497, version, filename, key)
    source = f"https://civitai.com/models/929497?modelVersionId={version}"
    (storage / "929497" / str(version) / "NOTICE.txt").write_text(
        "Aesthetic Quality Modifiers - Masterpiece by motimalu.\n"
        f"Source: {source}\nDownloaded weight bytes are unchanged. Model and base-model terms remain applicable.\n",
        encoding="utf-8",
    )
