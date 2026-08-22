"""Publish the reviewed witch quality sample into Machdoch's development CAS.

This is intentionally a bounded evidence-publishing utility, not a general
database importer. It accepts no caller-controlled paths or identifiers, checks
every source digest, creates a SQLite backup, writes blobs atomically, records
full generation lineage, and is idempotent only when the existing publication
exactly matches the reviewed files.
"""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
from typing import Any

from PIL import Image


WORKSPACE = Path(__file__).resolve().parents[1]
MEDIA_ROOT = (
    Path(os.environ["APPDATA"])
    / "com.machdoch.desktop.dev"
    / "media-studio"
)
DATABASE = MEDIA_ROOT / "media.sqlite3"
COMPILED_FLOW = WORKSPACE / "tmp" / "witch-quality-flow-compiled.json"
SOURCE_FRAME = WORKSPACE / "tmp" / "witch-flux-start-v1" / "output-0000.png"
END_FRAME = (
    WORKSPACE / "tmp" / "witch-krea-identity-end-v2" / "output-0000.png"
)
KREA_RESPONSE = (
    WORKSPACE / "tmp" / "witch-krea-identity-end-v2.run12.stdout.log"
)
WAN_REQUEST = WORKSPACE / "tmp" / "witch-wan-quality-v2-request.json"
WAN_RESPONSE = WORKSPACE / "tmp" / "witch-wan-quality-v2.stdout.log"
REFINEMENT_REPORT = (
    WORKSPACE / "tmp" / "witch-wan-quality-final" / "refinement-report.json"
)
QUALITY_REPORT = (
    WORKSPACE / "tmp" / "quality-evidence" / "witch-final" / "report.json"
)
ALPHA_VIDEO = (
    WORKSPACE / "tmp" / "witch-wan-quality-final" / "output-0000.webm"
)
COMPOSITE_VIDEO = (
    WORKSPACE / "tmp" / "witch-wan-quality-final" / "output-0001.webm"
)

SOURCE_ASSET_ID = "asset:run:anime-witch-keyframe-flux-v1:0"
END_RUN_ID = "run:anime-witch-krea-release-v2"
END_ASSET_ID = f"asset:{END_RUN_ID}:0"
VIDEO_RUN_ID = "run:anime-witch-production-spellcast-v2"
ALPHA_ASSET_ID = f"asset:{VIDEO_RUN_ID}:0"
COMPOSITE_ASSET_ID = f"asset:{VIDEO_RUN_ID}:1"


def compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def read_json(path: Path) -> dict[str, Any]:
    payload = path.read_bytes()
    encoding = (
        "utf-16"
        if payload.startswith((b"\xff\xfe", b"\xfe\xff"))
        else "utf-8-sig"
    )
    value = json.loads(payload.decode(encoding))
    if not isinstance(value, dict):
        raise RuntimeError(f"Expected a JSON object in {path}")
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def iso_timestamp(path: Path) -> str:
    return (
        datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def image_dimensions(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        return image.size


def backup_database() -> Path:
    base = WORKSPACE / "tmp" / "media-before-witch-quality-final.sqlite3"
    backup = base
    ordinal = 1
    while backup.exists():
        backup = base.with_name(f"{base.stem}-{ordinal}{base.suffix}")
        ordinal += 1
    source = sqlite3.connect(DATABASE, timeout=30)
    destination = sqlite3.connect(backup)
    try:
        source.backup(destination)
    finally:
        destination.close()
        source.close()
    verification = sqlite3.connect(backup)
    try:
        integrity = verification.execute(
            "PRAGMA integrity_check"
        ).fetchone()[0]
    finally:
        verification.close()
    if integrity != "ok":
        raise RuntimeError("The pre-publication database backup is corrupt")
    return backup


def ingest_blob(path: Path) -> tuple[str, int, str]:
    digest = sha256(path)
    size = path.stat().st_size
    relative = Path(digest[:2]) / digest[2:4] / digest
    destination = MEDIA_ROOT / "blobs" / "sha256" / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.stat().st_size != size or sha256(destination) != digest:
            raise RuntimeError(f"Managed CAS collision at {destination}")
    else:
        temporary = destination.with_name(f"{destination.name}.quality-ingesting")
        if temporary.exists():
            raise RuntimeError(f"Stale bounded ingest file exists: {temporary}")
        shutil.copy2(path, temporary)
        if temporary.stat().st_size != size or sha256(temporary) != digest:
            raise RuntimeError(f"CAS copy verification failed for {path}")
        temporary.replace(destination)
    return digest, size, str(relative)


def add_run(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    flow_id: str,
    flow_name: str,
    plan_id: str,
    created_at: str,
    prompt: str,
    model_label: str,
    executor: str,
    output_count: int,
    plan_snapshot: dict[str, Any] | None = None,
    flow_revision_id: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO runs (
            id, flow_id, flow_name, plan_id, status, created_at, updated_at,
            prompt, model_label, target, output_count, diagnostic_count,
            progress, current_step, executor, error, cancel_requested,
            aspect_ratio, plan_snapshot_json, flow_revision_id
        ) VALUES (?, ?, ?, ?, 'completed', ?, ?, ?, ?, 'local', ?, 0, 1.0,
                  'Completed', ?, NULL, 0, '16:9', ?, ?)
        """,
        (
            run_id,
            flow_id,
            flow_name,
            plan_id,
            created_at,
            created_at,
            prompt,
            model_label,
            output_count,
            executor,
            compact(plan_snapshot) if plan_snapshot is not None else None,
            flow_revision_id,
        ),
    )


def add_asset(
    connection: sqlite3.Connection,
    *,
    asset_id: str,
    run_id: str,
    digest: str,
    byte_size: int,
    relative_path: str,
    mime_type: str,
    kind: str,
    width: int,
    height: int,
    created_at: str,
    output_index: int,
    operation: dict[str, Any],
) -> None:
    connection.execute(
        """
        INSERT INTO blobs (
            digest, byte_size, mime_type, relative_path, created_at, available
        ) VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(digest) DO UPDATE SET
            byte_size = excluded.byte_size,
            mime_type = excluded.mime_type,
            relative_path = excluded.relative_path,
            available = 1
        """,
        (digest, byte_size, mime_type, relative_path, created_at),
    )
    connection.execute(
        """
        INSERT INTO assets (
            id, run_id, blob_digest, kind, mime_type, byte_size, width, height,
            created_at, output_index, fixture, operation_json,
            deleted_at, deletion_mode
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL)
        """,
        (
            asset_id,
            run_id,
            digest,
            kind,
            mime_type,
            byte_size,
            width,
            height,
            created_at,
            output_index,
            compact(operation),
        ),
    )


def add_tags(
    connection: sqlite3.Connection,
    asset_id: str,
    tags: list[tuple[str, str, str]],
    created_at: str,
) -> None:
    for normalized, label, source in tags:
        connection.execute(
            """
            INSERT INTO asset_tags (
                asset_id, normalized_tag, display_tag, source, confidence,
                created_at
            ) VALUES (?, ?, ?, ?, 1.0, ?)
            """,
            (asset_id, normalized, label, source, created_at),
        )


def add_event(
    connection: sqlite3.Connection,
    *,
    run_id: str,
    sequence: int,
    kind: str,
    created_at: str,
    message: str,
    progress: float,
    step_id: str,
    node_id: str | None = None,
) -> None:
    connection.execute(
        """
        INSERT INTO run_events (
            run_id, sequence, kind, created_at, message, progress, step_id,
            node_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            run_id,
            sequence,
            kind,
            created_at,
            message,
            progress,
            step_id,
            node_id,
        ),
    )


def main() -> None:
    required = (
        DATABASE,
        COMPILED_FLOW,
        SOURCE_FRAME,
        END_FRAME,
        KREA_RESPONSE,
        WAN_REQUEST,
        WAN_RESPONSE,
        REFINEMENT_REPORT,
        QUALITY_REPORT,
        ALPHA_VIDEO,
        COMPOSITE_VIDEO,
    )
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError(f"Required reviewed artifacts are missing: {missing}")

    compiled = read_json(COMPILED_FLOW)
    krea = read_json(KREA_RESPONSE)
    request = read_json(WAN_REQUEST)
    wan = read_json(WAN_RESPONSE)
    refinement = read_json(REFINEMENT_REPORT)
    quality = read_json(QUALITY_REPORT)
    if compiled["plan"]["status"] != "ready":
        raise RuntimeError("The reviewed quality workflow is not ready")
    if krea.get("editConditioning", {}).get("mode") != "krea2-identity-edit-v1.2":
        raise RuntimeError("The reviewed endpoint lacks KREA dual conditioning")
    if (
        wan.get("conditioningMode") != "first-last-temporal-context-lock-v3"
        or wan.get("endpointRestoration", {}).get("engine")
        != "endpoint-reference-color-and-pixel-restore-v3"
        or wan.get("endpointRestoration", {}).get("exactEndpointFrame") is not True
    ):
        raise RuntimeError("The reviewed WAN pass lacks exact endpoint conditioning")
    if (
        refinement.get("workerVersion") != "media-diffusers-worker/1.13.0"
        or refinement.get("encodingQuality") != "lossless"
        or refinement.get("transientGroundSuppression", {}).get("engine")
        != "low-persistence-ground-alpha-v3"
    ):
        raise RuntimeError("The reviewed temporal matte refinement is incomplete")
    final_alpha_metrics = quality["clips"]["final-alpha"]
    final_composite_metrics = quality["clips"]["final-composite"]
    if (
        final_alpha_metrics["clip"]["frame_count"] != 17
        or final_alpha_metrics["decode"]["usableAlpha"] is not True
        or final_composite_metrics["clip"]["frame_count"] != 17
        or final_composite_metrics["decode"]["opaqueInput"] is not True
    ):
        raise RuntimeError("Independent final decode evidence is incomplete")

    source_digest = sha256(SOURCE_FRAME)
    end_digest, end_size, end_relative = ingest_blob(END_FRAME)
    alpha_digest, alpha_size, alpha_relative = ingest_blob(ALPHA_VIDEO)
    composite_digest, composite_size, composite_relative = ingest_blob(
        COMPOSITE_VIDEO
    )
    if (
        alpha_digest != refinement["transparentOutput"]["sha256"]
        or alpha_size != refinement["transparentOutput"]["byteSize"]
        or composite_digest != refinement["compositeOutput"]["sha256"]
        or composite_size != refinement["compositeOutput"]["byteSize"]
    ):
        raise RuntimeError("Final files do not match the refinement manifest")

    existing = sqlite3.connect(DATABASE, timeout=30)
    existing_rows = dict(
        existing.execute(
            "SELECT id, blob_digest FROM assets WHERE id IN (?, ?, ?)",
            (END_ASSET_ID, ALPHA_ASSET_ID, COMPOSITE_ASSET_ID),
        ).fetchall()
    )
    existing.close()
    expected_existing = {
        END_ASSET_ID: end_digest,
        ALPHA_ASSET_ID: alpha_digest,
        COMPOSITE_ASSET_ID: composite_digest,
    }
    if existing_rows:
        if existing_rows == expected_existing:
            print(
                json.dumps(
                    {
                        "alreadyPublished": True,
                        "assetDigests": expected_existing,
                        "database": str(DATABASE),
                    },
                    indent=2,
                )
            )
            return
        raise RuntimeError(
            f"Conflicting partial quality publication exists: {existing_rows}"
        )

    backup = backup_database()
    source_width, source_height = image_dimensions(SOURCE_FRAME)
    end_width, end_height = image_dimensions(END_FRAME)
    end_created = iso_timestamp(END_FRAME)
    video_created = iso_timestamp(COMPOSITE_VIDEO)
    flow = compiled["flow"]
    layout = compiled["layout"]
    plan = compiled["plan"]
    revision_material = (
        flow["id"]
        + compiled["documentDigest"]
        + compiled["executionDigest"]
        + compiled["layoutDigest"]
    )
    revision_id = "mfr-" + hashlib.sha256(
        revision_material.encode("utf-8")
    ).hexdigest()[:32]
    flow_folder = hashlib.sha256(flow["id"].encode("utf-8")).hexdigest()[:16]
    artifact_relative = str(Path(flow_folder) / f"{revision_id}.json")
    artifact_path = MEDIA_ROOT / "flow-revisions" / artifact_relative
    artifact = {
        "schemaVersion": 1,
        "flowId": flow["id"],
        "revisionId": revision_id,
        "revisionNumber": 1,
        "parentRevisionId": None,
        "createdAt": flow["createdAt"],
        "changeSummary":
            "KREA identity release key, 20-step WAN action, production temporal "
            "matte refinement, lossless VP9 alpha, and enchanted-beach composite",
        "documentDigest": compiled["documentDigest"],
        "executionDigest": compiled["executionDigest"],
        "layoutDigest": compiled["layoutDigest"],
        "flow": flow,
        "layout": layout,
    }
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    artifact_path.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    krea_model = read_json(WORKSPACE / "tmp" / "witch-krea-identity-end-v1-request.run11.json")[
        "model"
    ]
    krea_operation = {
        "kind": "local-diffusion-generation",
        "providerId": "local-diffusers",
        "modelId": krea_model["id"],
        "flowRevisionId": None,
        "modelRevision": krea_model["revision"],
        "modelDigest": krea_model["digest"],
        "workerVersion": krea["workerVersion"],
        "packages": krea["packages"],
        "device": krea["device"],
        "deviceLabel": krea["deviceLabel"],
        "deviceMemoryBytes": krea["deviceMemoryBytes"],
        "prompt": krea["prompt"],
        "negativePrompt": krea["negativePrompt"],
        "addons": krea["addons"],
        "performance": krea["performance"],
        "editConditioning": krea["editConditioning"],
        "referenceImageAssetId": SOURCE_ASSET_ID,
        "referenceImageDigest": source_digest,
        "output": krea["outputs"][0],
        "subjectCutout": None,
    }
    matte = {
        **wan["output"]["matte"],
        "temporalGroundSuppression": refinement["transientGroundSuppression"],
    }
    alpha_output = {
        **wan["output"],
        "width": final_alpha_metrics["clip"]["width"],
        "height": final_alpha_metrics["clip"]["height"],
        "frameCount": final_alpha_metrics["clip"]["frame_count"],
        "fps": final_alpha_metrics["clip"]["fps"],
        "durationSeconds": final_alpha_metrics["clip"]["duration_seconds"],
        "loopMode": "none",
        "hasAlpha": True,
        "matte": matte,
        "encodingQuality": "lossless",
        "byteSize": alpha_size,
        "sha256": alpha_digest,
        "decodedFrameCount": final_alpha_metrics["clip"]["frame_count"],
        "decodedLoopEndpointMae": final_alpha_metrics["loop"][
            "compositedSubjectRgbMae"
        ],
        "decodedAlphaLoopEndpointMae": final_alpha_metrics["loop"]["alphaMae"],
    }
    composite_output = {
        **refinement["compositeOutput"],
        "byteSize": composite_size,
        "sha256": composite_digest,
    }
    common_video_operation = {
        "kind": "local-wan-video-generation",
        "providerId": "local-wan",
        "modelId": request["model"]["id"],
        "flowRevisionId": revision_id,
        "modelRevision": wan["modelRevision"],
        "modelDigest": wan["modelDigest"],
        "workerVersion": refinement["workerVersion"],
        "packages": wan["packages"],
        "device": wan["device"],
        "deviceLabel": wan["deviceLabel"],
        "deviceMemoryBytes": wan["deviceMemoryBytes"],
        "performance": wan["performance"],
        "conv3dBackend": wan["conv3dBackend"],
        "conditioningMode": wan["conditioningMode"],
        "endpointRestoration": wan["endpointRestoration"],
        "loopEndpointRestoration": wan["loopEndpointRestoration"],
        "prompt": wan["prompt"],
        "negativePrompt": wan["negativePrompt"],
        "resolution": wan["resolution"],
        "guidanceScale": wan["guidanceScale"],
        "numInferenceSteps": wan["numInferenceSteps"],
        "transparentBackground": True,
        "memoryProfile": request["memoryProfile"],
        "firstFrameAssetId": SOURCE_ASSET_ID,
        "firstFrameDigest": source_digest,
        "lastFrameAssetId": END_ASSET_ID,
        "lastFrameDigest": end_digest,
        "sameEndpointConditioning": False,
        "postProcessing": {
            "engine": "production-temporal-alpha-refinement-v1",
            "workerVersion": refinement["workerVersion"],
            "transientGroundSuppression": refinement[
                "transientGroundSuppression"
            ],
            "qualityEvidence": {
                "report": str(QUALITY_REPORT.relative_to(WORKSPACE)),
                "alphaInstability":
                    final_alpha_metrics["alpha"]["motionCompensatedMaeMean"],
                "edgeGreenSpill":
                    final_alpha_metrics["alpha"][
                        "positiveGreenSpillAtEdgeMean"
                    ],
            },
        },
    }

    connection = sqlite3.connect(DATABASE, timeout=30)
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        connection.execute("BEGIN IMMEDIATE")
        occupied = list(
            connection.execute(
                """
                SELECT id FROM runs WHERE id IN (?, ?)
                UNION ALL SELECT id FROM flows WHERE id = ?
                """,
                (END_RUN_ID, VIDEO_RUN_ID, flow["id"]),
            )
        )
        if occupied:
            raise RuntimeError(f"Target publication identifiers exist: {occupied}")
        source_row = connection.execute(
            """
            SELECT a.blob_digest, a.width, a.height, b.relative_path,
                   b.byte_size, b.available
            FROM assets a JOIN blobs b ON b.digest = a.blob_digest
            WHERE a.id = ?
            """,
            (SOURCE_ASSET_ID,),
        ).fetchone()
        if (
            source_row is None
            or source_row[0] != source_digest
            or source_row[1:3] != (source_width, source_height)
            or source_row[5] != 1
        ):
            raise RuntimeError("The immutable source key is unavailable or changed")
        source_blob = MEDIA_ROOT / "blobs" / "sha256" / source_row[3]
        if (
            not source_blob.is_file()
            or source_blob.stat().st_size != source_row[4]
            or sha256(source_blob) != source_digest
        ):
            raise RuntimeError("The immutable source key CAS blob failed verification")

        connection.execute(
            """
            INSERT INTO flows (
                id, name, description, head_revision_id,
                head_revision_number, created_at, updated_at,
                document_digest, execution_digest, layout_digest
            ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
            """,
            (
                flow["id"],
                flow["name"],
                flow["description"],
                revision_id,
                flow["createdAt"],
                flow["updatedAt"],
                compiled["documentDigest"],
                compiled["executionDigest"],
                compiled["layoutDigest"],
            ),
        )
        connection.execute(
            """
            INSERT INTO flow_revisions (
                revision_id, flow_id, revision_number, parent_revision_id,
                created_at, change_summary, document_digest, execution_digest,
                layout_digest, node_count, edge_count, flow_json, layout_json,
                artifact_relative_path
            ) VALUES (?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                revision_id,
                flow["id"],
                flow["createdAt"],
                artifact["changeSummary"],
                compiled["documentDigest"],
                compiled["executionDigest"],
                compiled["layoutDigest"],
                len(flow["nodes"]),
                len(flow["edges"]),
                compact(flow),
                compact(layout),
                artifact_relative,
            ),
        )
        add_run(
            connection,
            run_id=END_RUN_ID,
            flow_id="flow:anime-witch-krea-release-v2",
            flow_name="Anime witch identity-preserved release key",
            plan_id=f"{flow['id']}:krea-release-key",
            created_at=end_created,
            prompt=krea["prompt"],
            model_label="KREA 2 Identity Edit v1.2 r64",
            executor="local-diffusers",
            output_count=1,
        )
        add_run(
            connection,
            run_id=VIDEO_RUN_ID,
            flow_id=flow["id"],
            flow_name=flow["name"],
            plan_id=plan["id"],
            created_at=video_created,
            prompt=wan["prompt"],
            model_label="Wan2.2 TI2V 5B quality",
            executor="local-wan-video",
            output_count=2,
            plan_snapshot=compiled["planSnapshot"],
            flow_revision_id=revision_id,
        )
        add_asset(
            connection,
            asset_id=END_ASSET_ID,
            run_id=END_RUN_ID,
            digest=end_digest,
            byte_size=end_size,
            relative_path=end_relative,
            mime_type="image/png",
            kind="image",
            width=end_width,
            height=end_height,
            created_at=end_created,
            output_index=0,
            operation=krea_operation,
        )
        add_asset(
            connection,
            asset_id=ALPHA_ASSET_ID,
            run_id=VIDEO_RUN_ID,
            digest=alpha_digest,
            byte_size=alpha_size,
            relative_path=alpha_relative,
            mime_type="video/webm",
            kind="video",
            width=alpha_output["width"],
            height=alpha_output["height"],
            created_at=video_created,
            output_index=0,
            operation={**common_video_operation, "output": alpha_output},
        )
        add_asset(
            connection,
            asset_id=COMPOSITE_ASSET_ID,
            run_id=VIDEO_RUN_ID,
            digest=composite_digest,
            byte_size=composite_size,
            relative_path=composite_relative,
            mime_type="video/webm",
            kind="video",
            width=composite_output["width"],
            height=composite_output["height"],
            created_at=video_created,
            output_index=1,
            operation={
                **common_video_operation,
                "sourceTransparentVideoAssetId": ALPHA_ASSET_ID,
                "sourceTransparentVideoDigest": alpha_digest,
                "output": composite_output,
            },
        )
        for asset_id, input_id, role in (
            (END_ASSET_ID, SOURCE_ASSET_ID, "edit-reference"),
            (ALPHA_ASSET_ID, SOURCE_ASSET_ID, "first-frame"),
            (ALPHA_ASSET_ID, END_ASSET_ID, "last-frame"),
            (
                COMPOSITE_ASSET_ID,
                ALPHA_ASSET_ID,
                "transparent-foreground-video",
            ),
            (COMPOSITE_ASSET_ID, SOURCE_ASSET_ID, "first-frame"),
            (COMPOSITE_ASSET_ID, END_ASSET_ID, "last-frame"),
        ):
            connection.execute(
                "INSERT INTO asset_inputs(asset_id, input_asset_id, role) "
                "VALUES (?, ?, ?)",
                (asset_id, input_id, role),
            )
        add_tags(
            connection,
            END_ASSET_ID,
            [
                ("anime", "Anime", "manual"),
                ("witch", "Witch", "manual"),
                ("identity-reference", "Identity reference", "manual"),
                ("krea-2", "KREA 2", "technical"),
                ("reference-edit", "Reference edit", "technical"),
                ("action-keyframe", "Action keyframe", "manual"),
            ],
            end_created,
        )
        common_tags = [
            ("anime", "Anime", "manual"),
            ("witch", "Witch", "manual"),
            ("spellcast", "Spellcast", "manual"),
            ("character-action", "Character action", "manual"),
            ("wan2-2-ti2v", "Wan2.2 TI2V", "technical"),
            ("non-looping-shot", "Non-looping shot", "technical"),
            ("quality-640", "Quality 640", "technical"),
            ("lossless-vp9", "Lossless VP9", "technical"),
        ]
        add_tags(
            connection,
            ALPHA_ASSET_ID,
            [
                *common_tags,
                ("transparent-video", "Transparent video", "technical"),
                ("vp9-alpha", "VP9 alpha", "technical"),
                ("temporal-matte", "Temporal matte", "technical"),
            ],
            video_created,
        )
        add_tags(
            connection,
            COMPOSITE_ASSET_ID,
            [
                *common_tags,
                ("animated-background", "Animated background", "technical"),
                ("enchanted-beach", "Enchanted beach", "manual"),
                ("composited-video", "Composited video", "technical"),
            ],
            video_created,
        )
        add_event(
            connection,
            run_id=END_RUN_ID,
            sequence=1,
            kind="image_edited",
            created_at=end_created,
            message=(
                "Restaged the immutable witch key with KREA 2 Identity Edit "
                "v1.2 dual conditioning and reviewed r64 adapter."
            ),
            progress=0.9,
            step_id="local-diffusers.generate",
            node_id="last-action-frame",
        )
        add_event(
            connection,
            run_id=END_RUN_ID,
            sequence=2,
            kind="run_completed",
            created_at=end_created,
            message="Published the reviewed identity-preserved release key into immutable CAS.",
            progress=1,
            step_id="finalize",
        )
        video_events = [
            (
                "worker_prepared",
                "Verified both immutable identity keys and activated 16 GB disk group offload.",
                0.05,
                "local-wan.prepare",
            ),
            (
                "video_generated",
                "Generated the 17-frame, 20-step, endpoint-locked full-body spellcast.",
                0.82,
                "local-wan.generate",
            ),
            (
                "matte_refined",
                "Stabilized alpha temporally, decontaminated edge colors, repaired holes, and removed low-persistence floor contamination.",
                0.91,
                "video.alpha-refine",
            ),
            (
                "asset_published",
                "Published the independently decoded lossless VP9 alpha master and opaque enchanted-beach companion into immutable CAS.",
                0.99,
                "asset.publish",
            ),
            (
                "run_completed",
                "Completed the intentionally non-looping 640x352 production-quality evidence shot.",
                1,
                "finalize",
            ),
        ]
        for sequence, (kind, message, progress, step_id) in enumerate(
            video_events, start=1
        ):
            add_event(
                connection,
                run_id=VIDEO_RUN_ID,
                sequence=sequence,
                kind=kind,
                created_at=video_created,
                message=message,
                progress=progress,
                step_id=step_id,
            )
        for ordinal, node in enumerate(compiled["planSnapshot"]["nodes"]):
            connection.execute(
                """
                INSERT INTO node_executions (
                    run_id, node_id, node_type, node_label, ordinal, status,
                    active_step_id, runtime_phase, attempt, progress, message,
                    started_at, updated_at, finished_at, state_sequence,
                    first_step_id, last_step_id
                ) VALUES (?, ?, ?, ?, ?, 'completed', ?, 'quality-evidence',
                          1, 1.0, 'Completed and published', ?, ?, ?, 2, ?, ?)
                """,
                (
                    VIDEO_RUN_ID,
                    node["id"],
                    node["type"],
                    node["label"],
                    ordinal,
                    f"quality:{node['id']}",
                    video_created,
                    video_created,
                    video_created,
                    f"quality:{node['id']}",
                    f"quality:{node['id']}",
                ),
            )
        connection.execute(
            "UPDATE media_catalog_revisions SET revision = revision + 1 "
            "WHERE catalog IN ('asset-library', 'run-library')"
        )
        foreign_key_errors = list(connection.execute("PRAGMA foreign_key_check"))
        if foreign_key_errors:
            raise RuntimeError(
                f"Foreign-key validation failed: {foreign_key_errors}"
            )
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    verify = sqlite3.connect(DATABASE, timeout=30)
    integrity = verify.execute("PRAGMA integrity_check").fetchone()[0]
    rows = dict(
        verify.execute(
            "SELECT id, blob_digest FROM assets WHERE id IN (?, ?, ?)",
            (END_ASSET_ID, ALPHA_ASSET_ID, COMPOSITE_ASSET_ID),
        ).fetchall()
    )
    revisions = dict(
        verify.execute(
            "SELECT catalog, revision FROM media_catalog_revisions"
        ).fetchall()
    )
    verify.close()
    if integrity != "ok" or rows != expected_existing:
        raise RuntimeError(
            f"Post-publication verification failed: {integrity=} {rows=}"
        )
    print(
        json.dumps(
            {
                "alreadyPublished": False,
                "database": str(DATABASE),
                "backup": str(backup),
                "flowId": flow["id"],
                "flowRevisionId": revision_id,
                "runIds": [END_RUN_ID, VIDEO_RUN_ID],
                "assetDigests": expected_existing,
                "catalogRevisions": revisions,
                "integrity": integrity,
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
