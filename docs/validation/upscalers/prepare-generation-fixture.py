from pathlib import Path

source = Path("D:/Models/machdoch/models/ltx-video-0.9.8")
workspace = Path("D:/Models/machdoch/verification/upscale-chain-workspace")
destination = workspace / "models/ltx-video-0.9.8"
count = 0
for file in source.rglob("*"):
    if not file.is_file():
        continue
    target = destination / file.relative_to(source)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if not target.samefile(file.resolve()):
            raise ValueError(f"Fixture differs from its source: {target}")
    else:
        target.hardlink_to(file.resolve())
    count += 1
print(f"Prepared {count} fixture files in {workspace}")
