import argparse
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps/client/src-tauri/python"))

from media_video_2k import OUTPUT_SIZES, regenerate_video


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT / "assets/media/h3-style-tests/erotic-h3.mp4")
    parser.add_argument("--output", type=Path, default=ROOT / "assets/media/romantic-scene-local-2k.mp4")
    args = parser.parse_args()
    count = regenerate_video(args.source, args.output, OUTPUT_SIZES["16:9"], audio_gain_db=-3.0)
    print(f"{args.output} ({count} frames)")


if __name__ == "__main__":
    main()
