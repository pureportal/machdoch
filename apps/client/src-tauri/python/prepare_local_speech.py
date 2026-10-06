import argparse
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import shutil
import sys


def collect_licenses(runtime, destination):
    records = []
    for package in sorted(metadata.distributions(), key=lambda item: item.metadata["Name"].lower()):
        name, version = package.metadata["Name"], package.version
        files = []
        package_root = destination / "python" / f"{name}-{version}"
        for source in package.files or []:
            if any(part.lower().startswith(("license", "licence", "copying", "copyright", "notice", "third_party", "third-party")) for part in source.parts):
                actual = Path(package.locate_file(source))
                if actual.is_file():
                    target = package_root / str(source)
                    if not target.resolve().is_relative_to(package_root.resolve()):
                        raise ValueError(f"Invalid licence path for {name}: {source}.")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(actual, target)
                    files.append({"path": str(target.relative_to(destination)), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
        supplemental = destination / "python-supplemental" / f"{name}-{version}"
        for source in sorted(supplemental.rglob("*")):
            if source.is_file():
                target = package_root / "upstream" / source.relative_to(supplemental)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
                files.append({"path": str(target.relative_to(destination)), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
        if not files:
            raise RuntimeError(f"No licence text was found for {name} {version}.")
        package_root.mkdir(parents=True, exist_ok=True)
        source_metadata = package.read_text("METADATA")
        if source_metadata is None:
            raise RuntimeError(f"Package metadata is missing for {name} {version}.")
        (package_root / "METADATA").write_text(source_metadata, encoding="utf-8")
        records.append({"name": name, "version": version, "license": package.metadata.get("License-Expression") or package.metadata.get("License"), "files": files})
    python_licenses = []
    for directory, children, filenames in os.walk(runtime):
        children[:] = [child for child in children if child != "site-packages"]
        for filename in filenames:
            path = Path(directory) / filename
            if any(part.lower().startswith(("license", "licence", "copying", "copyright", "notice")) for part in path.relative_to(runtime).parts):
                python_licenses.append(path)
    if not python_licenses:
        raise RuntimeError("The portable Python archive contains no licence texts.")
    for source in python_licenses:
        target = destination / "python-runtime" / source.relative_to(runtime)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    (destination / "python-packages.json").write_text(json.dumps(records, indent=2) + "\n", encoding="utf-8")


def remove_development_files(runtime):
    runtime = runtime.resolve()
    extensions = {".a", ".lib", ".pdb", ".pyc", ".pyo", ".h", ".hh", ".hpp", ".hxx", ".cuh"}
    removed, size = 0, 0
    for directory, children, filenames in os.walk(runtime):
        for filename in filenames:
            source = Path(directory) / filename
            if source.suffix.lower() not in extensions or filename.lower().startswith(("license", "licence", "copying", "copyright", "notice")):
                continue
            if not source.resolve().is_relative_to(runtime):
                raise ValueError("The speech runtime file is outside its resource directory.")
            size += source.stat().st_size
            source.unlink()
            removed += 1
    if removed:
        print(f"Removed {removed} speech runtime development files ({size} bytes).", flush=True)


def prepare(root, legal, verify):
    sys.dont_write_bytecode = True
    model = root / "phonon2" / "model"
    for path in (model, model.with_name("model.partial")):
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError("The speech model staging path is outside its resource directory.")
    if not verify:
        from fermion._speech.fetch import _unpack

        _unpack(root / "phonon2" / "phonon-2.bps.tar.zst", model)
        collect_licenses(root / "runtime", legal)
        entries = {}
        for path in model.rglob("*"):
            if path.is_file():
                with path.open("rb") as source:
                    entries[str(path.relative_to(model))] = hashlib.file_digest(source, "sha256").hexdigest()
        (root / "model-integrity.json").write_text(json.dumps(entries, indent=2) + "\n")
    remove_development_files(root / "runtime")
    import torch
    import transformers
    import soundfile

    if soundfile.__libsndfile_version__ != "1.2.2":
        raise RuntimeError("The bundled libsndfile version does not match its retained source archive.")

    entries = json.loads((root / "model-integrity.json").read_text())
    if not all(filename in entries for filename in ("model.fermion", "config.json", "packed_manifest.json")):
        raise RuntimeError("The Phonon-2 model integrity inventory is incomplete.")
    for relative, expected in entries.items():
        path = model / relative
        if not path.resolve().is_relative_to(model.resolve()):
            raise ValueError("Invalid speech model integrity path.")
        with path.open("rb") as source:
            if hashlib.file_digest(source, "sha256").hexdigest() != expected:
                raise RuntimeError(f"Speech model integrity check failed: {relative}.")
    packages = json.loads((legal / "python-packages.json").read_text(encoding="utf-8"))
    if not packages:
        raise RuntimeError("Speech runtime licence inventory is empty.")
    installed = {package.metadata["Name"].lower(): package.version for package in metadata.distributions()}
    recorded = {package["name"].lower(): package["version"] for package in packages}
    if installed != recorded:
        raise RuntimeError("The installed speech packages do not match the licence inventory. Prepare the speech runtime again.")
    for package in packages:
        if not package["files"]:
            raise RuntimeError(f"Missing licence for {package['name']}.")
        for entry in package["files"]:
            path = legal / entry["path"]
            if not path.resolve().is_relative_to(legal.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
                raise RuntimeError(f"Speech licence integrity check failed: {entry['path']}.")
    print(f"Speech runtime prepared: Python {sys.version.split()[0]}, torch {torch.__version__}, transformers {transformers.__version__}.", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--resource-dir", type=Path, required=True)
    parser.add_argument("--legal-dir", type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    prepare(args.resource_dir.resolve(), args.legal_dir.resolve(), args.verify)
