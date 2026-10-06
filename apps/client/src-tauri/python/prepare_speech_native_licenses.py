from concurrent.futures import ThreadPoolExecutor, as_completed
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import tomllib
from urllib.request import urlopen


LEGAL_NAME = re.compile(r"^(licen[sc]es?|copying|copyright|notices?|third[-_ ]?party|patents|authors)([._ -]|$)", re.IGNORECASE)


def legal_files(archive):
    files = {}
    for entry in archive.getmembers():
        if not entry.isfile():
            continue
        relative = PurePosixPath(*PurePosixPath(entry.name).parts[1:])
        if not relative.parts or ".." in relative.parts or relative.is_absolute():
            raise ValueError("Invalid native dependency archive path.")
        is_legal = any(LEGAL_NAME.match(part) for part in relative.parts)
        if not is_legal and not relative.name.lower().startswith("readme"):
            continue
        content = archive.extractfile(entry).read()
        if is_legal or (b"Permission is hereby granted" in content and b"THE SOFTWARE IS PROVIDED" in content):
            files[str(relative)] = content
    return files


def retain_files(files, destination, legal):
    records = []
    for relative, content in sorted(files.items()):
        target = destination / relative
        if not target.resolve().is_relative_to(destination.resolve()):
            raise ValueError("Invalid native dependency licence path.")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        records.append({"path": target.relative_to(legal).as_posix(), "sha256": hashlib.sha256(content).hexdigest()})
    return records


def retain_crate(package, legal, cache, supplements):
    name, version, checksum = package["name"], package["version"], package["checksum"]
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", name) or not re.fullmatch(r"[a-zA-Z0-9.+_-]+", version):
        raise ValueError("Invalid native dependency name or version.")
    archive_path = cache / f"{name}-{version}.crate"
    content = archive_path.read_bytes() if archive_path.is_file() else None
    if content is None or hashlib.sha256(content).hexdigest() != checksum:
        url = f"https://static.crates.io/crates/{name}/{name}-{version}.crate"
        with urlopen(url, timeout=60) as response:
            content = response.read(64 * 1024 * 1024 + 1)
        if len(content) > 64 * 1024 * 1024 or hashlib.sha256(content).hexdigest() != checksum:
            raise RuntimeError(f"Native dependency integrity check failed: {name} {version}.")
        archive_path.write_bytes(content)
    with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
        grants = legal_files(archive)
        for supplement in supplements:
            if supplement["name"] == name and supplement["version"] == version:
                for file in supplement["files"]:
                    value = (legal / file["path"]).read_bytes()
                    if hashlib.sha256(value).hexdigest() != file["sha256"]:
                        raise RuntimeError(f"Supplemental native licence integrity check failed: {name} {version}.")
                    grants[f"upstream/{PurePosixPath(file['path']).name}"] = value
        if not grants:
            raise RuntimeError(f"No licence text was found for native dependency {name} {version}.")
        manifest = next(entry for entry in archive.getmembers() if len(PurePosixPath(entry.name).parts) == 2 and entry.name.endswith("/Cargo.toml"))
        metadata = tomllib.loads(archive.extractfile(manifest).read().decode("utf-8"))["package"]
    destination = legal / "python-native" / "cargo" / f"{name}-{version}"
    files = retain_files(grants, destination, legal)
    if any(license in metadata.get("license", "") for license in ("MPL-2.0", "CDDL-1.0")):
        source = legal / "source" / "cargo" / archive_path.name
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(content)
        files.append({"path": source.relative_to(legal).as_posix(), "sha256": checksum})
    return {"name": name, "version": version, "license": metadata.get("license"), "repository": metadata.get("repository"), "sourceSha256": checksum, "files": files}


def prepare_native_licenses(root, legal, sources, supplements):
    packages = {}
    components = []
    cache = root / "native-license-cache"
    cache.mkdir(parents=True, exist_ok=True)
    for source in sources:
        path = legal / source["path"]
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != source["sha256"]:
            raise RuntimeError(f"Native source integrity check failed: {source['name']}.")
        with tarfile.open(fileobj=io.BytesIO(content), mode="r:gz") as archive:
            grants = legal_files(archive)
            if not grants:
                raise RuntimeError(f"No source licences were found for {source['name']}.")
            files = retain_files(grants, legal / "python-native" / source["name"], legal)
            lock_path = source["lock"]
            entry = next(item for item in archive.getmembers() if PurePosixPath(*PurePosixPath(item.name).parts[1:]).as_posix() == lock_path)
            lock_bytes = archive.extractfile(entry).read()
            lock = tomllib.loads(lock_bytes.decode("utf-8"))
            dependencies = []
            for package in lock["package"]:
                if package.get("source", "").startswith("registry+"):
                    key = (package["name"], package["version"])
                    if key in packages and packages[key]["checksum"] != package["checksum"]:
                        raise RuntimeError("Conflicting native dependency checksums.")
                    packages[key] = package
                    dependencies.append({"name": key[0], "version": key[1]})
                elif package.get("source"):
                    raise RuntimeError(f"Unpinned native dependency source: {package['name']}.")
        components.append({"name": source["name"], "version": source["version"], "source": source["url"], "sourceSha256": source["sha256"], "lockSha256": hashlib.sha256(lock_bytes).hexdigest(), "files": files, "dependencies": dependencies})
    records, failures = [], []
    with ThreadPoolExecutor(max_workers=8) as executor:
        jobs = {executor.submit(retain_crate, package, legal, cache, supplements): package for package in packages.values()}
        for job in as_completed(jobs):
            try:
                records.append(job.result())
            except Exception as error:
                package = jobs[job]
                failures.append(f"{package['name']} {package['version']}: {error}")
    if failures:
        raise RuntimeError("Native dependency licence audit failed:\n" + "\n".join(sorted(failures)))
    inventory = {"components": components, "crates": sorted(records, key=lambda package: (package["name"], package["version"]))}
    (legal / "python-native.json").write_text(json.dumps(inventory, indent=2) + "\n", encoding="utf-8")
    print(f"Native speech dependency licences retained: {len(records)} crates.", flush=True)


def verify_native_licenses(legal, sources):
    inventory = json.loads((legal / "python-native.json").read_text(encoding="utf-8"))
    if not inventory["components"] or not inventory["crates"]:
        raise RuntimeError("The native speech licence inventory is empty.")
    expected = sorted((source["name"], source["version"], source["sha256"]) for source in sources)
    actual = sorted((component["name"], component["version"], component["sourceSha256"]) for component in inventory["components"])
    if expected != actual:
        raise RuntimeError("The native speech licence inventory does not match its pinned sources.")
    crates = {(package["name"], package["version"]) for package in inventory["crates"]}
    if any((dependency["name"], dependency["version"]) not in crates for component in inventory["components"] for dependency in component["dependencies"]):
        raise RuntimeError("A native speech dependency is missing from the licence inventory.")
    for component in inventory["components"] + inventory["crates"]:
        if not component["files"]:
            raise RuntimeError(f"Missing native licence for {component['name']}.")
        for entry in component["files"]:
            path = legal / entry["path"]
            if not path.resolve().is_relative_to(legal.resolve()) or hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
                raise RuntimeError(f"Native licence integrity check failed: {entry['path']}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--resource-dir", type=Path, required=True)
    parser.add_argument("--legal-dir", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    legal = args.legal_dir.resolve()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    sources = manifest["pythonNativeSources"]
    if not args.verify:
        prepare_native_licenses(args.resource_dir.resolve(), legal, sources, manifest["nativeSupplementalLicenses"])
    verify_native_licenses(legal, sources)
