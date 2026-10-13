import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3


ARCHITECTURES = (
    "stable-diffusion-2", "stable-diffusion-3", "flux-2", "flux-2-klein-base-4b",
    "flux-1-dev", "flux-1-schnell", "qwen-image", "qwen-image-2512", "pony", "stable-diffusion-xl",
)


def synchronize(model_root: Path, verification_store: Path, checks: Path, architectures: list[str]) -> None:
    source_database = model_root.resolve() / "media.sqlite3"
    private_root = verification_store.resolve()
    target_database = private_root / "media.sqlite3"
    if not source_database.is_file() or not target_database.is_file():
        raise ValueError("Both model catalogs must already exist")
    if target_database.resolve() == source_database.resolve():
        raise ValueError("Choose the separate verification catalog")
    models = []
    for architecture in architectures:
        log = (checks / f"{architecture}-native-import-current.log").read_text(encoding="utf-8-sig")
        if "test result: ok. 1 passed; 0 failed" not in log:
            raise ValueError(f"Native import has not passed: {architecture}")
        records = [json.loads(line) for line in log.splitlines() if line.startswith('{"schemaVersion":1,"modelId":')]
        if len(records) != 1:
            raise ValueError(f"Expected one native import result: {architecture}")
        models.append((architecture, records[0]))
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup_path = private_root / f"media-before-catalog-sync-{timestamp}.sqlite3"
    with sqlite3.connect(f"{source_database.as_uri()}?mode=ro", uri=True) as source:
        source.row_factory = sqlite3.Row
        with sqlite3.connect(target_database) as target:
            target.execute("PRAGMA foreign_keys = ON")
            with sqlite3.connect(backup_path) as backup:
                target.backup(backup)
            with target:
                for architecture, imported in models:
                    model_id = imported["modelId"]
                    metadata = source.execute("SELECT * FROM media_models WHERE id = ?", (model_id,)).fetchone()
                    installation = source.execute("SELECT * FROM media_model_installations WHERE model_id = ?", (model_id,)).fetchone()
                    if metadata is None or installation is None:
                        raise ValueError(f"The source catalog is missing the native import: {architecture}")
                    if metadata["architecture"] != architecture or installation["status"] != "installed":
                        raise ValueError(f"The source catalog does not contain an installed engine: {architecture}")
                    relative_path = Path("models") / installation["relative_path"]
                    if metadata["package_type"] not in {"safetensors", "diffusers"}:
                        raise ValueError(f"The verification catalog cannot import this package type: {architecture}")
                    target_path = relative_path / "checkpoint.safetensors" if metadata["package_type"] == "safetensors" else relative_path
                    if installation["manifest_digest"] != imported["digest"] or target_path.as_posix() != imported["targetLabel"]:
                        raise ValueError(f"The catalog differs from the native import: {architecture}")
                    if not private_root.joinpath(relative_path).is_dir():
                        raise ValueError(f"The verification model junction is missing: {architecture}")
                    if not private_root.joinpath(target_path).exists():
                        raise ValueError(f"The imported verification package is missing: {architecture}")
                    for table, record in (("media_models", metadata), ("media_model_installations", installation)):
                        columns = record.keys()
                        placeholders = ",".join("?" for _ in columns)
                        primary_key = "id" if table == "media_models" else "model_id"
                        updates = ",".join(f"{column}=excluded.{column}" for column in columns if column != primary_key)
                        target.execute(
                            f"INSERT INTO {table} ({','.join(columns)}) VALUES ({placeholders}) "
                            f"ON CONFLICT({primary_key}) DO UPDATE SET {updates}", tuple(record),
                        )
            count = target.execute(
                "SELECT count(*) FROM media_models m JOIN media_model_installations i ON m.id = i.model_id "
                "WHERE i.status = 'installed' AND m.target = 'local' AND m.capabilities_json LIKE '%text-to-image%'"
            ).fetchone()[0]
    result = {"source": str(source_database), "target": str(target_database), "backup": str(backup_path),
              "copiedModels": [record["modelId"] for _, record in models], "installedImageCheckpoints": count}
    (checks / "native-verification-catalog-sync.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ("model-root", "verification-store", "checks"):
        parser.add_argument(f"--{name}", type=Path, required=True)
    parser.add_argument("--architecture", action="append", choices=ARCHITECTURES)
    arguments = parser.parse_args()
    synchronize(arguments.model_root, arguments.verification_store, arguments.checks, arguments.architecture or list(ARCHITECTURES))


if __name__ == "__main__":
    main()
