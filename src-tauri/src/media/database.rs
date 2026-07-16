use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, types::Type, Connection, OptionalExtension as _, Row, Transaction};
use sha2::{Digest as _, Sha256};

use super::{
    catalog,
    error::MediaError,
    provider_local_diffusers::LocalGeneratedImageBatch,
    provider_openai::{self, GeneratedImageBatch},
    provider_svg::{self, GeneratedSvgBatch, SvgReferencePlan},
    EnqueueFixtureRunRequest, GenerateMediaImagesRequest, GenerateMediaSvgRequest,
    MediaAssetDeletionImpact, MediaAssetDeletionRequest, MediaAssetDeletionResult,
    MediaAssetExportMode, MediaAssetExportRecord, MediaAssetRecord, MediaAssetTag,
    MediaAssetTombstone, MediaHumanReviewDecisionRequest, MediaHumanReviewRecord,
    MediaImageImportResult, MediaModelCatalogSnapshot, MediaNodeExecutionRecord,
    MediaProviderJobRecord, MediaProviderPolicySnapshot, MediaResult, MediaRunDetail,
    MediaRunEvent, MediaRunPlanSnapshot, MediaRunRecord, MediaRuntimePaths,
};

pub(crate) const SCHEMA_VERSION: u32 = 25;

#[derive(Debug)]
pub(crate) struct AssetBlobSource {
    pub(crate) digest: String,
    pub(crate) relative_path: String,
    pub(crate) byte_size: u64,
    pub(crate) mime_type: String,
}

pub(crate) enum LocalImportKind<'a> {
    Raster,
    RasterizedSvg { operation_json: &'a str },
}

pub(crate) struct ImportedAssetRegistration<'a> {
    pub(crate) digest: &'a str,
    pub(crate) relative_path: &'a str,
    pub(crate) byte_size: u64,
    pub(crate) mime_type: &'a str,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) import_kind: LocalImportKind<'a>,
}

pub(crate) struct RecoverySummary {
    pub(crate) recovered_runs: u32,
}

pub(crate) enum ClaimResult {
    Claimed(FixtureExecution),
    LeaseBusy,
    Terminal,
}

pub(crate) struct FixtureExecution {
    pub(crate) prompt: String,
    pub(crate) output_count: u32,
    pub(crate) aspect_ratio: String,
}

pub(crate) fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub(crate) fn open(paths: &MediaRuntimePaths) -> MediaResult<Connection> {
    if let Some(parent) = paths.database.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create Media Studio data directory: {error}"))?;
    }
    fs::create_dir_all(&paths.blobs)
        .map_err(|error| format!("failed to create Media Studio blob directory: {error}"))?;

    let connection = Connection::open(&paths.database)
        .map_err(|error| format!("failed to open Media Studio database: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("failed to configure Media Studio busy timeout: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA foreign_keys = ON;\n\
             PRAGMA synchronous = NORMAL;",
        )
        .map_err(|error| format!("failed to configure Media Studio database: {error}"))?;
    Ok(connection)
}

pub(crate) fn initialize(paths: &MediaRuntimePaths) -> MediaResult<RecoverySummary> {
    ensure_initialized(paths)?;
    catalog::synchronize(&mut open(paths)?)?;
    let summary = recover_interrupted_runs(&mut open(paths)?)?;
    recover_pending_blob_gc(paths)?;
    Ok(summary)
}

pub(crate) fn ensure_initialized(paths: &MediaRuntimePaths) -> MediaResult<()> {
    let mut connection = open(paths)?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL;")
        .map_err(|error| format!("failed to enable Media Studio WAL mode: {error}"))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (\n\
               version INTEGER PRIMARY KEY,\n\
               applied_at TEXT NOT NULL\n\
             );",
        )
        .map_err(|error| format!("failed to initialize Media Studio migrations: {error}"))?;

    let version = connection
        .query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
            [],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|error| format!("failed to read Media Studio schema version: {error}"))?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "Media Studio database schema {version} is newer than supported schema {SCHEMA_VERSION}"
        ));
    }

    if version < 1 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin Media Studio migration: {error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE runs (\n\
                   id TEXT PRIMARY KEY,\n\
                   flow_id TEXT NOT NULL,\n\
                   flow_name TEXT NOT NULL,\n\
                   plan_id TEXT NOT NULL,\n\
                   status TEXT NOT NULL,\n\
                   created_at TEXT NOT NULL,\n\
                   updated_at TEXT NOT NULL,\n\
                   prompt TEXT NOT NULL,\n\
                   model_label TEXT NOT NULL,\n\
                   target TEXT,\n\
                   output_count INTEGER NOT NULL,\n\
                   diagnostic_count INTEGER NOT NULL,\n\
                   progress REAL NOT NULL DEFAULT 0,\n\
                   current_step TEXT NOT NULL,\n\
                   executor TEXT NOT NULL,\n\
                   error TEXT,\n\
                   cancel_requested INTEGER NOT NULL DEFAULT 0,\n\
                   aspect_ratio TEXT NOT NULL\n\
                 );\n\
                 CREATE TABLE jobs (\n\
                   id TEXT PRIMARY KEY,\n\
                   run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,\n\
                   status TEXT NOT NULL,\n\
                   attempts INTEGER NOT NULL DEFAULT 0,\n\
                   max_attempts INTEGER NOT NULL DEFAULT 3,\n\
                   started_at TEXT,\n\
                   finished_at TEXT,\n\
                   heartbeat_at TEXT,\n\
                   error TEXT\n\
                 );\n\
                 CREATE TABLE run_events (\n\
                   id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
                   run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n\
                   sequence INTEGER NOT NULL,\n\
                   kind TEXT NOT NULL,\n\
                   created_at TEXT NOT NULL,\n\
                   message TEXT NOT NULL,\n\
                   progress REAL,\n\
                   step_id TEXT,\n\
                   UNIQUE(run_id, sequence)\n\
                 );\n\
                 CREATE TABLE blobs (\n\
                   digest TEXT PRIMARY KEY,\n\
                   byte_size INTEGER NOT NULL,\n\
                   mime_type TEXT NOT NULL,\n\
                   relative_path TEXT NOT NULL,\n\
                   created_at TEXT NOT NULL\n\
                 );\n\
                 CREATE TABLE assets (\n\
                   id TEXT PRIMARY KEY,\n\
                   run_id TEXT NOT NULL REFERENCES runs(id),\n\
                   blob_digest TEXT NOT NULL REFERENCES blobs(digest),\n\
                   kind TEXT NOT NULL,\n\
                   mime_type TEXT NOT NULL,\n\
                   byte_size INTEGER NOT NULL,\n\
                   width INTEGER NOT NULL,\n\
                   height INTEGER NOT NULL,\n\
                   created_at TEXT NOT NULL,\n\
                   output_index INTEGER NOT NULL,\n\
                   fixture INTEGER NOT NULL DEFAULT 0,\n\
                   UNIQUE(run_id, output_index)\n\
                 );\n\
                 CREATE TABLE asset_inputs (\n\
                   asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,\n\
                   input_asset_id TEXT NOT NULL REFERENCES assets(id),\n\
                   role TEXT NOT NULL,\n\
                   PRIMARY KEY(asset_id, input_asset_id, role)\n\
                 );\n\
                 CREATE TABLE resource_leases (\n\
                   resource_key TEXT PRIMARY KEY,\n\
                   owner_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n\
                   acquired_at TEXT NOT NULL,\n\
                   expires_at TEXT NOT NULL\n\
                 );\n\
                 CREATE INDEX runs_created_at_idx ON runs(created_at DESC);\n\
                 CREATE INDEX run_events_run_idx ON run_events(run_id, sequence);\n\
                 CREATE INDEX assets_created_at_idx ON assets(created_at DESC);",
            )
            .map_err(|error| format!("failed to apply Media Studio schema: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![1_u32, now()],
            )
            .map_err(|error| format!("failed to record Media Studio migration: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit Media Studio migration: {error}"))?;
    }

    if version < 2 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin Media Studio metadata migration: {error}"))?;
        transaction
            .execute_batch("ALTER TABLE assets ADD COLUMN operation_json TEXT;")
            .map_err(|error| format!("failed to add Media Studio asset metadata: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![2_u32, now()],
            )
            .map_err(|error| {
                format!("failed to record Media Studio metadata migration: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio metadata migration: {error}")
        })?;
    }

    if version < 3 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio rendition migration: {error}")
        })?;
        transaction
            .execute_batch(
                "CREATE TABLE asset_renditions (\n\
                   asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,\n\
                   profile TEXT NOT NULL,\n\
                   blob_digest TEXT NOT NULL REFERENCES blobs(digest),\n\
                   mime_type TEXT NOT NULL,\n\
                   byte_size INTEGER NOT NULL,\n\
                   width INTEGER NOT NULL,\n\
                   height INTEGER NOT NULL,\n\
                   created_at TEXT NOT NULL,\n\
                   PRIMARY KEY(asset_id, profile)\n\
                 );\n\
                 CREATE INDEX asset_renditions_blob_idx ON asset_renditions(blob_digest);",
            )
            .map_err(|error| format!("failed to add Media Studio rendition cache: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![3_u32, now()],
            )
            .map_err(|error| {
                format!("failed to record Media Studio rendition migration: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio rendition migration: {error}")
        })?;
    }

    if version < 4 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin Media Studio export migration: {error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE asset_exports (\n\
                   id TEXT PRIMARY KEY,\n\
                   asset_id TEXT NOT NULL REFERENCES assets(id),\n\
                   destination_path TEXT NOT NULL,\n\
                   digest TEXT NOT NULL,\n\
                   byte_size INTEGER NOT NULL,\n\
                   status TEXT NOT NULL,\n\
                   created_at TEXT NOT NULL,\n\
                   completed_at TEXT,\n\
                   error TEXT\n\
                 );\n\
                 CREATE INDEX asset_exports_asset_idx ON asset_exports(asset_id, created_at DESC);",
            )
            .map_err(|error| format!("failed to add Media Studio export audit log: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![4_u32, now()],
            )
            .map_err(|error| format!("failed to record Media Studio export migration: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit Media Studio export migration: {error}"))?;
    }

    if version < 5 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin Media Studio tag migration: {error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE asset_tags (\n\
                   asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,\n\
                   normalized_tag TEXT NOT NULL,\n\
                   display_tag TEXT NOT NULL,\n\
                   source TEXT NOT NULL,\n\
                   confidence REAL,\n\
                   created_at TEXT NOT NULL,\n\
                   PRIMARY KEY(asset_id, normalized_tag, source)\n\
                 );\n\
                 CREATE TABLE asset_tag_revisions (\n\
                   id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
                   asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,\n\
                   source TEXT NOT NULL,\n\
                   tags_json TEXT NOT NULL,\n\
                   created_at TEXT NOT NULL\n\
                 );\n\
                 CREATE INDEX asset_tags_value_idx ON asset_tags(normalized_tag, asset_id);\n\
                 CREATE INDEX asset_tag_revisions_asset_idx ON asset_tag_revisions(asset_id, id DESC);",
            )
            .map_err(|error| format!("failed to add Media Studio asset tags: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![5_u32, now()],
            )
            .map_err(|error| format!("failed to record Media Studio tag migration: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit Media Studio tag migration: {error}"))?;
    }

    if version < 6 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin Media Studio deletion migration: {error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE assets ADD COLUMN deleted_at TEXT;\n\
                 ALTER TABLE assets ADD COLUMN deletion_mode TEXT;\n\
                 ALTER TABLE blobs ADD COLUMN available INTEGER NOT NULL DEFAULT 1;\n\
                 CREATE TABLE asset_deletions (\n\
                   id INTEGER PRIMARY KEY AUTOINCREMENT,\n\
                   asset_id TEXT NOT NULL REFERENCES assets(id),\n\
                   mode TEXT NOT NULL,\n\
                   status TEXT NOT NULL,\n\
                   impact_token TEXT NOT NULL,\n\
                   reclaimed_bytes INTEGER NOT NULL DEFAULT 0,\n\
                   retained_bytes INTEGER NOT NULL DEFAULT 0,\n\
                   error TEXT,\n\
                   created_at TEXT NOT NULL,\n\
                   completed_at TEXT\n\
                 );\n\
                 CREATE TABLE blob_gc_queue (\n\
                   deletion_id INTEGER NOT NULL REFERENCES asset_deletions(id) ON DELETE CASCADE,\n\
                   digest TEXT NOT NULL REFERENCES blobs(digest),\n\
                   relative_path TEXT NOT NULL,\n\
                   byte_size INTEGER NOT NULL,\n\
                   status TEXT NOT NULL,\n\
                   error TEXT,\n\
                   created_at TEXT NOT NULL,\n\
                   completed_at TEXT,\n\
                   PRIMARY KEY(deletion_id, digest)\n\
                 );\n\
                 CREATE INDEX assets_active_created_idx ON assets(deleted_at, created_at DESC);\n\
                 CREATE INDEX asset_deletions_asset_idx ON asset_deletions(asset_id, id DESC);\n\
                 CREATE INDEX blob_gc_queue_status_idx ON blob_gc_queue(status, deletion_id);",
            )
            .map_err(|error| format!("failed to add Media Studio deletion state: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![6_u32, now()],
            )
            .map_err(|error| {
                format!("failed to record Media Studio deletion migration: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio deletion migration: {error}")
        })?;
    }

    if version < 7 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio blob cleanup migration: {error}")
        })?;
        transaction
            .execute_batch(
                "ALTER TABLE blob_gc_queue ADD COLUMN reclaimed_bytes INTEGER NOT NULL DEFAULT 0;",
            )
            .map_err(|error| format!("failed to add blob cleanup accounting: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![7_u32, now()],
            )
            .map_err(|error| {
                format!("failed to record Media Studio blob cleanup migration: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio blob cleanup migration: {error}")
        })?;
    }

    if version < 8 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin Media Studio catalog migration: {error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE media_providers (\n\
                   id TEXT PRIMARY KEY, display_name TEXT NOT NULL, target TEXT NOT NULL,\n\
                   lifecycle TEXT NOT NULL, capabilities_json TEXT NOT NULL, privacy_summary TEXT NOT NULL,\n\
                   checked_at TEXT NOT NULL, stale_after_seconds INTEGER NOT NULL, source_url TEXT,\n\
                   catalog_revision TEXT NOT NULL, updated_at TEXT NOT NULL\n\
                 );\n\
                 CREATE TABLE media_models (\n\
                   id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES media_providers(id),\n\
                   display_name TEXT NOT NULL, family TEXT NOT NULL, target TEXT NOT NULL, lifecycle TEXT NOT NULL,\n\
                   lifecycle_checked_at TEXT NOT NULL, lifecycle_stale_after_seconds INTEGER NOT NULL,\n\
                   lifecycle_source_url TEXT, catalog_revision TEXT NOT NULL, capabilities_json TEXT NOT NULL,\n\
                   bundled INTEGER NOT NULL, package_type TEXT NOT NULL, license_name TEXT NOT NULL,\n\
                   license_spdx_id TEXT, license_source_url TEXT NOT NULL, license_commercial_use TEXT NOT NULL,\n\
                   license_requires_acceptance INTEGER NOT NULL, recommended INTEGER NOT NULL, speed_score INTEGER NOT NULL,\n\
                   quality_score INTEGER NOT NULL, min_vram_gb REAL, expected_download_gb REAL, cost_hint TEXT,\n\
                   privacy_summary TEXT NOT NULL, limitation TEXT, updated_at TEXT NOT NULL\n\
                 );\n\
                 CREATE TABLE media_model_installations (\n\
                   model_id TEXT PRIMARY KEY REFERENCES media_models(id), revision TEXT NOT NULL, status TEXT NOT NULL,\n\
                   manifest_digest TEXT NOT NULL, bytes_on_disk INTEGER NOT NULL DEFAULT 0, installed_at TEXT,\n\
                   verified_at TEXT, error TEXT, updated_at TEXT NOT NULL\n\
                 );\n\
                 CREATE TABLE media_model_lifecycle_snapshots (\n\
                   id INTEGER PRIMARY KEY AUTOINCREMENT, model_id TEXT NOT NULL REFERENCES media_models(id),\n\
                   lifecycle TEXT NOT NULL, checked_at TEXT NOT NULL, source_url TEXT,\n\
                   catalog_revision TEXT NOT NULL, observed_at TEXT NOT NULL,\n\
                   UNIQUE(model_id, lifecycle, catalog_revision)\n\
                 );\n\
                 CREATE INDEX media_models_provider_idx ON media_models(provider_id, lifecycle);\n\
                 CREATE INDEX media_model_lifecycle_idx ON media_model_lifecycle_snapshots(model_id, observed_at DESC);",
            )
            .map_err(|error| format!("failed to add Media Studio catalog state: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![8_u32, now()],
            )
            .map_err(|error| format!("failed to record Media Studio catalog migration: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit Media Studio catalog migration: {error}"))?;
    }

    if version < 9 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio model installer migration: {error}")
        })?;
        transaction
            .execute_batch(
                "ALTER TABLE media_model_installations ADD COLUMN relative_path TEXT;\n\
                 CREATE TABLE media_model_license_acceptances (\n\
                   model_id TEXT NOT NULL REFERENCES media_models(id), revision TEXT NOT NULL,\n\
                   license_digest TEXT NOT NULL, accepted_at TEXT NOT NULL,\n\
                   PRIMARY KEY(model_id, revision, license_digest)\n\
                 );\n\
                 CREATE TABLE media_model_install_jobs (\n\
                   id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES media_models(id),\n\
                   revision TEXT NOT NULL, status TEXT NOT NULL, manifest_digest TEXT NOT NULL,\n\
                   license_digest TEXT NOT NULL, files_total INTEGER NOT NULL, files_completed INTEGER NOT NULL DEFAULT 0,\n\
                   bytes_total INTEGER NOT NULL, bytes_downloaded INTEGER NOT NULL DEFAULT 0, current_file TEXT,\n\
                   error TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,\n\
                   updated_at TEXT NOT NULL, completed_at TEXT\n\
                 );\n\
                 CREATE TABLE media_model_install_files (\n\
                   job_id TEXT NOT NULL REFERENCES media_model_install_jobs(id) ON DELETE CASCADE,\n\
                   path TEXT NOT NULL, sha256 TEXT NOT NULL, byte_size INTEGER NOT NULL,\n\
                   status TEXT NOT NULL DEFAULT 'pending', bytes_downloaded INTEGER NOT NULL DEFAULT 0,\n\
                   error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(job_id, path)\n\
                 );\n\
                 CREATE INDEX media_model_install_jobs_model_idx\n\
                   ON media_model_install_jobs(model_id, created_at DESC);",
            )
            .map_err(|error| format!("failed to add Media Studio model installer state: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![9_u32, now()],
            )
            .map_err(|error| {
                format!("failed to record Media Studio model installer migration: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio model installer migration: {error}")
        })?;
    }

    if version < 10 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio model removal migration: {error}")
        })?;
        transaction
            .execute_batch(
                "CREATE TABLE media_model_removals (\n\
                   id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES media_models(id), revision TEXT NOT NULL,\n\
                   status TEXT NOT NULL, relative_path TEXT NOT NULL, trash_relative_path TEXT NOT NULL,\n\
                   byte_size INTEGER NOT NULL, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,\n\
                   completed_at TEXT\n\
                 );\n\
                 CREATE INDEX media_model_removals_status_idx ON media_model_removals(status, created_at);",
            )
            .map_err(|error| format!("failed to add Media Studio model removal journal: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![10_u32, now()],
            )
            .map_err(|error| {
                format!("failed to record Media Studio model removal migration: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio model removal migration: {error}")
        })?;
    }

    if version < 11 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio provider job migration: {error}")
        })?;
        transaction
            .execute_batch(
                "CREATE TABLE provider_jobs (\n\
                   id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,\n\
                   attempt INTEGER NOT NULL, status TEXT NOT NULL, raw_state TEXT, scenario TEXT NOT NULL,\n\
                   phase_cursor INTEGER NOT NULL DEFAULT 0, request_digest TEXT NOT NULL,\n\
                   idempotency_key TEXT, provider_job_id TEXT, provider_request_id TEXT,\n\
                   estimated_cost_min REAL NOT NULL, estimated_cost_max REAL NOT NULL, currency TEXT NOT NULL,\n\
                   poll_attempts INTEGER NOT NULL DEFAULT 0, next_poll_at TEXT, reconciliation_deadline TEXT NOT NULL,\n\
                   accepted_at TEXT, retention_expires_at TEXT, late_success INTEGER NOT NULL DEFAULT 0,\n\
                   review_required INTEGER NOT NULL DEFAULT 0, review_reason TEXT, error TEXT,\n\
                   cancel_requested INTEGER NOT NULL DEFAULT 0, policy_json TEXT NOT NULL,\n\
                   created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,\n\
                   UNIQUE(run_id, attempt)\n\
                 );\n\
                 CREATE TABLE provider_observations (\n\
                   id INTEGER PRIMARY KEY AUTOINCREMENT, provider_job_id TEXT NOT NULL REFERENCES provider_jobs(id) ON DELETE CASCADE,\n\
                   sequence INTEGER NOT NULL, normalized_state TEXT NOT NULL, raw_state TEXT NOT NULL,\n\
                   source TEXT NOT NULL, retry_after_ms INTEGER, observed_at TEXT NOT NULL,\n\
                   UNIQUE(provider_job_id, sequence)\n\
                 );\n\
                 CREATE INDEX provider_jobs_due_idx ON provider_jobs(status, next_poll_at);\n\
                 CREATE INDEX provider_jobs_run_idx ON provider_jobs(run_id, attempt DESC);\n\
                 CREATE INDEX provider_observations_job_idx ON provider_observations(provider_job_id, sequence);",
            )
            .map_err(|error| format!("failed to add Media Studio provider job state: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![11_u32, now()],
            )
            .map_err(|error| format!("failed to record provider job migration: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio provider job migration: {error}")
        })?;
    }

    if version < 12 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin Media Studio run plan migration: {error}"))?;
        transaction
            .execute_batch("ALTER TABLE runs ADD COLUMN plan_snapshot_json TEXT;")
            .map_err(|error| format!("failed to add Media Studio run plan snapshots: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![12_u32, now()],
            )
            .map_err(|error| format!("failed to record run plan migration: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio run plan migration: {error}")
        })?;
    }

    if version < 13 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio export privacy migration: {error}")
        })?;
        transaction
            .execute_batch(
                "ALTER TABLE asset_exports ADD COLUMN mode TEXT NOT NULL DEFAULT 'verified-original';
                 ALTER TABLE asset_exports ADD COLUMN source_digest TEXT;
                 ALTER TABLE asset_exports ADD COLUMN metadata_stripped INTEGER NOT NULL DEFAULT 0;
                 UPDATE asset_exports SET source_digest = digest WHERE source_digest IS NULL;",
            )
            .map_err(|error| {
                format!("failed to add Media Studio privacy-safe export audit data: {error}")
            })?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![13_u32, now()],
            )
            .map_err(|error| format!("failed to record export privacy migration: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio export privacy migration: {error}")
        })?;
    }

    if version < 14 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio flow revision migration: {error}")
        })?;
        transaction
            .execute_batch(
                "CREATE TABLE flows (
                   id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
                   head_revision_id TEXT NOT NULL, head_revision_number INTEGER NOT NULL,
                   created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                   document_digest TEXT NOT NULL, execution_digest TEXT NOT NULL,
                   layout_digest TEXT NOT NULL
                 );
                 CREATE TABLE flow_revisions (
                   revision_id TEXT PRIMARY KEY, flow_id TEXT NOT NULL,
                   revision_number INTEGER NOT NULL, parent_revision_id TEXT,
                   created_at TEXT NOT NULL, change_summary TEXT NOT NULL,
                   document_digest TEXT NOT NULL, execution_digest TEXT NOT NULL,
                   layout_digest TEXT NOT NULL, node_count INTEGER NOT NULL,
                   edge_count INTEGER NOT NULL, flow_json TEXT NOT NULL,
                   layout_json TEXT NOT NULL, artifact_relative_path TEXT NOT NULL,
                   UNIQUE(flow_id, revision_number),
                   FOREIGN KEY(flow_id) REFERENCES flows(id) DEFERRABLE INITIALLY DEFERRED,
                   FOREIGN KEY(parent_revision_id) REFERENCES flow_revisions(revision_id)
                 );
                 CREATE TABLE flow_save_requests (
                   flow_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
                   request_digest TEXT NOT NULL, revision_id TEXT NOT NULL,
                   created_revision INTEGER NOT NULL, created_at TEXT NOT NULL,
                   PRIMARY KEY(flow_id, idempotency_key),
                   FOREIGN KEY(flow_id) REFERENCES flows(id) DEFERRABLE INITIALLY DEFERRED,
                   FOREIGN KEY(revision_id) REFERENCES flow_revisions(revision_id)
                 );
                 CREATE INDEX flows_updated_at_idx ON flows(updated_at DESC);
                 CREATE INDEX flow_revisions_flow_idx ON flow_revisions(flow_id, revision_number DESC);",
            )
            .map_err(|error| format!("failed to add Media Studio flow revision storage: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![14_u32, now()],
            )
            .map_err(|error| format!("failed to record flow revision migration: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio flow revision migration: {error}")
        })?;
    }

    if version < 15 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio run flow lineage migration: {error}")
        })?;
        transaction
            .execute_batch(
                "ALTER TABLE runs ADD COLUMN flow_revision_id TEXT REFERENCES flow_revisions(revision_id);
                 CREATE INDEX runs_flow_revision_idx ON runs(flow_revision_id);",
            )
            .map_err(|error| format!("failed to add run flow revision lineage: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![15_u32, now()],
            )
            .map_err(|error| format!("failed to record run flow lineage migration: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio run flow lineage migration: {error}")
        })?;
    }

    if version < 16 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio flow portability migration: {error}")
        })?;
        transaction
            .execute_batch(
                "CREATE TABLE flow_revision_imports (
                   revision_id TEXT PRIMARY KEY,
                   bundle_digest TEXT NOT NULL,
                   source_flow_id TEXT NOT NULL,
                   source_revision_id TEXT NOT NULL,
                   source_display_name TEXT NOT NULL,
                   review_token TEXT NOT NULL,
                   imported_at TEXT NOT NULL,
                   report_json TEXT NOT NULL,
                   bundle_artifact_relative_path TEXT NOT NULL,
                   FOREIGN KEY(revision_id) REFERENCES flow_revisions(revision_id)
                 );
                 CREATE INDEX flow_revision_imports_bundle_idx
                   ON flow_revision_imports(bundle_digest, imported_at DESC);",
            )
            .map_err(|error| {
                format!("failed to add Media Studio flow import provenance: {error}")
            })?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![16_u32, now()],
            )
            .map_err(|error| format!("failed to record flow portability migration: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio flow portability migration: {error}")
        })?;
    }

    if version < 17 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio human review migration: {error}")
        })?;
        transaction
            .execute_batch(
                "CREATE TABLE human_reviews (
                   id TEXT PRIMARY KEY,
                   run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                   node_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   status TEXT NOT NULL,
                   instructions TEXT NOT NULL,
                   max_selections INTEGER NOT NULL,
                   require_comment INTEGER NOT NULL,
                   candidate_asset_ids_json TEXT NOT NULL,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   decided_at TEXT,
                   UNIQUE(run_id, node_id),
                   UNIQUE(run_id, sequence)
                 );
                 CREATE TABLE human_review_decisions (
                   id TEXT PRIMARY KEY,
                   review_id TEXT NOT NULL UNIQUE REFERENCES human_reviews(id) ON DELETE CASCADE,
                   action TEXT NOT NULL,
                   selected_asset_ids_json TEXT NOT NULL,
                   comment TEXT NOT NULL,
                   actor TEXT NOT NULL,
                   created_at TEXT NOT NULL
                 );
                 CREATE INDEX human_reviews_run_idx ON human_reviews(run_id, sequence);
                 CREATE INDEX human_reviews_pending_idx ON human_reviews(status, updated_at);",
            )
            .map_err(|error| format!("failed to add durable human reviews: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![17_u32, now()],
            )
            .map_err(|error| format!("failed to record human review migration: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio human review migration: {error}")
        })?;
    }

    if version < 18 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio node execution migration: {error}")
        })?;
        transaction
            .execute_batch(
                "ALTER TABLE run_events ADD COLUMN node_id TEXT;
                 CREATE TABLE node_executions (
                   run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                   node_id TEXT NOT NULL,
                   node_type TEXT NOT NULL,
                   node_label TEXT NOT NULL,
                   ordinal INTEGER NOT NULL,
                   status TEXT NOT NULL CHECK(status IN (
                     'pending', 'queued', 'running', 'waiting-for-review', 'retrying',
                     'completed', 'cached', 'skipped', 'failed', 'canceled', 'blocked'
                   )),
                   active_step_id TEXT,
                   runtime_phase TEXT,
                   attempt INTEGER NOT NULL DEFAULT 0,
                   progress REAL,
                   message TEXT,
                   started_at TEXT,
                   updated_at TEXT NOT NULL,
                   finished_at TEXT,
                   state_sequence INTEGER NOT NULL DEFAULT 0,
                   PRIMARY KEY(run_id, node_id)
                 );
                 CREATE INDEX node_executions_run_status_idx
                   ON node_executions(run_id, status, ordinal);",
            )
            .map_err(|error| format!("failed to add durable node executions: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![18_u32, now()],
            )
            .map_err(|error| format!("failed to record node execution migration: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio node execution migration: {error}")
        })?;
    }

    if version < 19 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio model add-on migration: {error}")
        })?;
        transaction
            .execute_batch(
                "ALTER TABLE media_models ADD COLUMN architecture TEXT;
                 ALTER TABLE media_models ADD COLUMN addon_capabilities_json TEXT NOT NULL DEFAULT '[]';
                 CREATE TABLE media_model_addons (
                   id TEXT PRIMARY KEY,
                   kind TEXT NOT NULL CHECK(kind IN ('lora', 'textual-inversion')),
                   display_name TEXT NOT NULL,
                   architecture TEXT NOT NULL,
                   architecture_confidence TEXT NOT NULL,
                   format TEXT NOT NULL CHECK(format = 'safetensors'),
                   target_components_json TEXT NOT NULL,
                   base_model_hint TEXT,
                   trigger_words_json TEXT NOT NULL,
                   default_token TEXT,
                   digest TEXT NOT NULL UNIQUE,
                   header_digest TEXT NOT NULL,
                   byte_size INTEGER NOT NULL CHECK(byte_size > 0),
                   relative_path TEXT NOT NULL,
                   source_url TEXT,
                   license_name TEXT NOT NULL,
                   license_source_url TEXT NOT NULL,
                   license_commercial_use TEXT NOT NULL,
                   imported_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL
                 );
                 CREATE INDEX media_model_addons_architecture_kind_idx
                   ON media_model_addons(architecture, kind, display_name);",
            )
            .map_err(|error| format!("failed to add Media Studio model add-on state: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![19_u32, now()],
            )
            .map_err(|error| format!("failed to record model add-on migration: {error}"))?;
        transaction.commit().map_err(|error| {
            format!("failed to commit Media Studio model add-on migration: {error}")
        })?;
    }

    if version < 20 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin Media Studio canonical node step migration: {error}")
        })?;
        transaction
            .execute_batch(
                "ALTER TABLE node_executions ADD COLUMN first_step_id TEXT;
                 ALTER TABLE node_executions ADD COLUMN last_step_id TEXT;",
            )
            .map_err(|error| format!("failed to add canonical node step bounds: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![20_u32, now()],
            )
            .map_err(|error| format!("failed to record canonical node step migration: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit canonical node step migration: {error}"))?;
    }

    if version < 21 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin local model runtime probe migration: {error}")
        })?;
        transaction
            .execute_batch(
                "CREATE TABLE media_model_runtime_probes (
                   model_id TEXT PRIMARY KEY REFERENCES media_models(id) ON DELETE CASCADE,
                   revision TEXT NOT NULL,
                   model_digest TEXT NOT NULL,
                   runtime_fingerprint TEXT NOT NULL,
                   status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
                   worker_version TEXT NOT NULL,
                   pipeline_class TEXT,
                   device_label TEXT,
                   diagnostic TEXT NOT NULL,
                   probed_at TEXT NOT NULL
                 );
                 CREATE INDEX media_model_runtime_probes_status_idx
                   ON media_model_runtime_probes(status, probed_at);",
            )
            .map_err(|error| format!("failed to add local model runtime probes: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![21_u32, now()],
            )
            .map_err(|error| {
                format!("failed to record local model runtime probe migration: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("failed to commit local model runtime probe migration: {error}")
        })?;
    }

    if version < 22 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin model add-on source provenance migration: {error}")
        })?;
        transaction
            .execute_batch("ALTER TABLE media_model_addons ADD COLUMN source_metadata_json TEXT;")
            .map_err(|error| format!("failed to add model add-on source provenance: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![22_u32, now()],
            )
            .map_err(|error| {
                format!("failed to record model add-on source provenance migration: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("failed to commit model add-on source provenance migration: {error}")
        })?;
    }

    if version < 23 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin model add-on removal migration: {error}"))?;
        transaction
            .execute_batch(
                "CREATE TABLE media_model_addon_removals (
                   id TEXT PRIMARY KEY,
                   addon_id TEXT NOT NULL,
                   digest TEXT NOT NULL,
                   status TEXT NOT NULL CHECK(status IN ('prepared', 'cleanup-pending', 'removed')),
                   relative_path TEXT NOT NULL,
                   trash_relative_path TEXT NOT NULL,
                   byte_size INTEGER NOT NULL CHECK(byte_size > 0),
                   error TEXT,
                   created_at TEXT NOT NULL,
                   updated_at TEXT NOT NULL,
                   completed_at TEXT
                 );
                 CREATE INDEX media_model_addon_removals_status_idx
                   ON media_model_addon_removals(status, created_at);",
            )
            .map_err(|error| format!("failed to add model add-on removal journal: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![23_u32, now()],
            )
            .map_err(|error| format!("failed to record model add-on removal migration: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit model add-on removal migration: {error}"))?;
    }

    if version < 24 {
        let transaction = connection.transaction().map_err(|error| {
            format!("failed to begin embedding vector profile migration: {error}")
        })?;
        transaction
            .execute_batch(
                "ALTER TABLE media_model_addons
                   ADD COLUMN embedding_vectors_json TEXT NOT NULL DEFAULT '[]';",
            )
            .map_err(|error| format!("failed to add embedding vector profiles: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![24_u32, now()],
            )
            .map_err(|error| {
                format!("failed to record embedding vector profile migration: {error}")
            })?;
        transaction.commit().map_err(|error| {
            format!("failed to commit embedding vector profile migration: {error}")
        })?;
    }

    if version < 25 {
        let transaction = connection
            .transaction()
            .map_err(|error| format!("failed to begin LoRA tensor profile migration: {error}"))?;
        transaction
            .execute_batch(
                "ALTER TABLE media_model_addons
                   ADD COLUMN lora_profile_json TEXT;",
            )
            .map_err(|error| format!("failed to add LoRA tensor profiles: {error}"))?;
        transaction
            .execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
                params![25_u32, now()],
            )
            .map_err(|error| format!("failed to record LoRA tensor profile migration: {error}"))?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit LoRA tensor profile migration: {error}"))?;
    }

    Ok(())
}

pub(crate) fn get_model_catalog(
    paths: &MediaRuntimePaths,
    configured_provider_ids: &HashSet<String>,
) -> MediaResult<MediaModelCatalogSnapshot> {
    let mut connection = open(paths)?;
    catalog::synchronize(&mut connection)?;
    catalog::snapshot(&connection, configured_provider_ids)
}

fn recover_interrupted_runs(connection: &mut Connection) -> MediaResult<RecoverySummary> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to start Media Studio recovery: {error}"))?;
    let interrupted_runs = {
        let mut statement = transaction
            .prepare("SELECT id, executor FROM runs WHERE status IN ('running', 'canceling') AND executor != 'mock-remote-provider'")
            .map_err(|error| format!("failed to inspect interrupted media runs: {error}"))?;
        let interrupted_runs = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("failed to read interrupted media runs: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode interrupted media runs: {error}"))?;
        interrupted_runs
    };

    for (run_id, executor) in &interrupted_runs {
        let cancel_requested = transaction
            .query_row(
                "SELECT cancel_requested FROM runs WHERE id = ?1",
                params![run_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("failed to inspect interrupted media run: {error}"))?;
        let (status, step, event_kind, message, diagnostic) = if cancel_requested {
            (
                "canceled",
                "Canceled during recovery",
                "run_canceled",
                "Cancellation was completed during startup recovery.",
                None,
            )
        } else if executor == "openai-image-api" {
            (
                "needs-review",
                "Provider outcome unknown after interruption",
                "provider_acceptance_unknown",
                "The desktop stopped during a paid provider request; the request was not retried automatically.",
                Some("OpenAI request acceptance is unknown after interruption; retry could create a duplicate provider charge."),
            )
        } else {
            (
                "queued",
                "Recovered after interruption",
                "run_recovered",
                "Interrupted work was returned to the durable queue.",
                None,
            )
        };
        transaction
            .execute(
                "UPDATE runs SET status = ?2, current_step = ?3, updated_at = ?4, error = ?5 WHERE id = ?1",
                params![run_id, status, step, now(), diagnostic],
            )
            .map_err(|error| format!("failed to recover media run: {error}"))?;
        transaction
            .execute(
                "UPDATE jobs SET status = ?2, heartbeat_at = ?3,
                   finished_at = CASE WHEN ?2 IN ('failed', 'canceled') THEN ?3 ELSE finished_at END,
                   error = ?4 WHERE run_id = ?1",
                params![run_id, status, now(), diagnostic],
            )
            .map_err(|error| format!("failed to recover media job: {error}"))?;
        transaction
            .execute(
                "UPDATE node_executions SET
                   status = CASE
                     WHEN ?2 = 'canceled' THEN 'canceled'
                     WHEN ?2 = 'needs-review' THEN 'blocked'
                     ELSE 'queued'
                   END,
                   runtime_phase = 'recovery', message = ?3, updated_at = ?4,
                   finished_at = CASE WHEN ?2 = 'canceled' THEN ?4 ELSE NULL END,
                   state_sequence = state_sequence + 1
                 WHERE run_id = ?1
                   AND status IN ('queued', 'running', 'retrying', 'waiting-for-review', 'blocked')",
                params![run_id, status, message, now()],
            )
            .map_err(|error| format!("failed to recover media node executions: {error}"))?;
        if executor == "openai-image-api" && !cancel_requested {
            transaction
                .execute(
                    "UPDATE provider_jobs SET status = 'acceptance-unknown', raw_state = 'desktop-interrupted',
                       review_required = 1,
                       review_reason = 'The desktop stopped after submission began. OpenAI may have accepted or charged the request, and this endpoint has no documented request lookup.',
                       next_poll_at = NULL, updated_at = ?2
                     WHERE run_id = ?1 AND status = 'submitting'",
                    params![run_id, now()],
                )
                .map_err(|error| {
                    format!("failed to quarantine interrupted OpenAI provider job: {error}")
                })?;
        }
        append_event(
            &transaction,
            run_id,
            event_kind,
            message,
            None,
            Some("recovery"),
        )?;
    }
    transaction
        .execute("DELETE FROM resource_leases", [])
        .map_err(|error| format!("failed to release stale Media Studio leases: {error}"))?;
    transaction
        .execute(
            "UPDATE asset_exports SET status = 'failed', error = 'Desktop process stopped before export verification completed' WHERE status = 'writing'",
            [],
        )
        .map_err(|error| format!("failed to recover interrupted media exports: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit Media Studio recovery: {error}"))?;

    Ok(RecoverySummary {
        recovered_runs: interrupted_runs.len() as u32,
    })
}

pub(crate) fn enqueue_fixture_run(
    paths: &MediaRuntimePaths,
    request: &EnqueueFixtureRunRequest,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin media run enqueue: {error}"))?;
    let timestamp = now();
    let plan_snapshot_json = request
        .plan_snapshot
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("failed to serialize run plan snapshot: {error}"))?;
    validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        request.flow_revision_id.as_deref(),
        request.plan_snapshot.as_ref(),
    )?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runs(\n\
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt,\n\
               model_label, target, output_count, diagnostic_count, progress, current_step,\n\
               executor, aspect_ratio, plan_snapshot_json, flow_revision_id\n\
             ) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?5, ?6, ?7, ?8, ?9, ?10, 0,\n\
               'Waiting for fixture worker', 'deterministic-fixture', ?11, ?12, ?13)",
            params![
                request.run_id,
                request.flow_id,
                request.flow_name,
                request.plan_id,
                timestamp,
                request.prompt,
                request.model_label,
                request.target,
                request.output_count,
                request.diagnostic_count,
                request.aspect_ratio,
                plan_snapshot_json,
                request.flow_revision_id,
            ],
        )
        .map_err(|error| format!("failed to enqueue media run: {error}"))?;

    if inserted == 1 {
        transaction
            .execute(
                "INSERT INTO jobs(id, run_id, status) VALUES (?1, ?2, 'queued')",
                params![format!("job:{}", request.run_id), request.run_id],
            )
            .map_err(|error| format!("failed to enqueue media job: {error}"))?;
        if let Some(snapshot) = request.plan_snapshot.as_ref() {
            seed_node_executions(&transaction, &request.run_id, snapshot, "pending")?;
        }
        append_event(
            &transaction,
            &request.run_id,
            "run_queued",
            "Deterministic fixture run was added to the durable queue.",
            Some(0.0),
            Some("queue"),
        )?;
    } else {
        validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            request.flow_revision_id.as_deref(),
            &request.plan_id,
            "deterministic-fixture",
        )?;
    }

    transaction
        .commit()
        .map_err(|error| format!("failed to commit media run enqueue: {error}"))
}

pub(crate) fn list_queued_run_ids(paths: &MediaRuntimePaths) -> MediaResult<Vec<String>> {
    let connection = open(paths)?;
    let mut statement = connection
        .prepare("SELECT id FROM runs WHERE status = 'queued' AND executor = 'deterministic-fixture' ORDER BY created_at ASC")
        .map_err(|error| format!("failed to prepare queued media run query: {error}"))?;
    let run_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query queued media runs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode queued media runs: {error}"))?;
    Ok(run_ids)
}

pub(crate) fn claim_fixture_run(
    paths: &MediaRuntimePaths,
    run_id: &str,
) -> MediaResult<ClaimResult> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin fixture claim: {error}"))?;
    let row = transaction
        .query_row(
            "SELECT status, cancel_requested, prompt, output_count, aspect_ratio FROM runs WHERE id = ?1",
            params![run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect fixture run: {error}"))?;
    let Some((status, cancel_requested, prompt, output_count, aspect_ratio)) = row else {
        return Err(format!("media run {run_id} was not found"));
    };

    if cancel_requested || status == "canceling" {
        finalize_cancellation(&transaction, run_id)?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit media cancellation: {error}"))?;
        return Ok(ClaimResult::Terminal);
    }
    if status != "queued" {
        return Ok(ClaimResult::Terminal);
    }

    let timestamp = now();
    let lease_inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO resource_leases(resource_key, owner_run_id, acquired_at, expires_at)\n\
             VALUES ('fixture:cpu', ?1, ?2, ?3)",
            params![run_id, timestamp, (Utc::now() + chrono::Duration::minutes(5)).to_rfc3339_opts(SecondsFormat::Millis, true)],
        )
        .map_err(|error| format!("failed to acquire fixture resource lease: {error}"))?;
    if lease_inserted == 0 {
        return Ok(ClaimResult::LeaseBusy);
    }

    transaction
        .execute(
            "UPDATE runs SET status = 'running', progress = 0.02, current_step = 'Preparing deterministic fixture', updated_at = ?2 WHERE id = ?1",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to start fixture run: {error}"))?;
    transaction
        .execute(
            "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?2), heartbeat_at = ?2 WHERE run_id = ?1",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to start fixture job: {error}"))?;
    append_event(
        &transaction,
        run_id,
        "run_started",
        "Deterministic fixture executor claimed the job.",
        Some(0.02),
        Some("fixture.prepare"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit fixture claim: {error}"))?;

    Ok(ClaimResult::Claimed(FixtureExecution {
        prompt,
        output_count,
        aspect_ratio,
    }))
}

pub(crate) fn is_cancellation_requested(
    paths: &MediaRuntimePaths,
    run_id: &str,
) -> MediaResult<bool> {
    open(paths)?
        .query_row(
            "SELECT cancel_requested FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect media cancellation state: {error}"))
}

pub(crate) fn is_output_published(
    paths: &MediaRuntimePaths,
    run_id: &str,
    output_index: u32,
) -> MediaResult<bool> {
    open(paths)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE run_id = ?1 AND output_index = ?2)",
            params![run_id, output_index],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect published fixture outputs: {error}"))
}

pub(crate) struct FixtureAssetRecord<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) digest: &'a str,
    pub(crate) relative_path: &'a str,
    pub(crate) bytes: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) output_index: u32,
    pub(crate) output_count: u32,
}

pub(crate) fn record_asset(
    paths: &MediaRuntimePaths,
    asset: &FixtureAssetRecord<'_>,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin fixture asset ingestion: {error}"))?;
    let timestamp = now();
    transaction
        .execute(
            "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at) VALUES (?1, ?2, 'image/png', ?3, ?4)",
            params![asset.digest, asset.bytes as i64, asset.relative_path, timestamp],
        )
        .map_err(|error| format!("failed to register content-addressed blob: {error}"))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height, created_at, output_index, fixture)\n\
             VALUES (?1, ?2, ?3, 'image', 'image/png', ?4, ?5, ?6, ?7, ?8, 1)",
            params![
                format!("asset:{}:{}", asset.run_id, asset.output_index),
                asset.run_id,
                asset.digest,
                asset.bytes as i64,
                asset.width,
                asset.height,
                timestamp,
                asset.output_index
            ],
        )
        .map_err(|error| format!("failed to register fixture asset: {error}"))?;
    let progress = 0.05 + (f64::from(asset.output_index + 1) / f64::from(asset.output_count)) * 0.9;
    transaction
        .execute(
            "UPDATE runs SET progress = ?2, current_step = ?3, updated_at = ?4 WHERE id = ?1",
            params![
                asset.run_id,
                progress,
                format!(
                    "Published fixture output {} of {}",
                    asset.output_index + 1,
                    asset.output_count
                ),
                timestamp
            ],
        )
        .map_err(|error| format!("failed to update fixture progress: {error}"))?;
    transaction
        .execute(
            "UPDATE jobs SET heartbeat_at = ?2 WHERE run_id = ?1",
            params![asset.run_id, timestamp],
        )
        .map_err(|error| format!("failed to heartbeat fixture job: {error}"))?;
    append_event(
        &transaction,
        asset.run_id,
        "asset_published",
        &format!(
            "Fixture output {} was verified and ingested into CAS.",
            asset.output_index + 1
        ),
        Some(progress),
        Some("fixture.ingest"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit fixture asset ingestion: {error}"))
}

pub(crate) fn record_imported_asset(
    paths: &MediaRuntimePaths,
    registration: ImportedAssetRegistration<'_>,
) -> MediaResult<MediaImageImportResult> {
    let ImportedAssetRegistration {
        digest,
        relative_path,
        byte_size,
        mime_type,
        width,
        height,
        import_kind,
    } = registration;
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin image import registration: {error}"))?;
    let existing_asset = transaction
        .query_row(
            "SELECT a.id, a.run_id FROM assets a JOIN runs r ON r.id = a.run_id
             WHERE a.blob_digest = ?1 AND a.kind = 'image' AND a.deleted_at IS NULL
               AND (
                 NOT EXISTS (SELECT 1 FROM human_reviews hr WHERE hr.run_id = a.run_id)
                 OR (r.status = 'completed' AND EXISTS (
                   SELECT 1 FROM human_reviews hr
                   JOIN human_review_decisions d ON d.review_id = hr.id
                   JOIN json_each(d.selected_asset_ids_json) selected
                   WHERE hr.run_id = a.run_id AND d.action = 'approve'
                     AND hr.sequence = (SELECT MAX(last_hr.sequence) FROM human_reviews last_hr WHERE last_hr.run_id = a.run_id)
                     AND selected.value = a.id
                 ))
               )
             ORDER BY a.created_at ASC, a.id ASC LIMIT 1",
            params![digest],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("failed to check imported image digest: {error}"))?;
    if let Some((asset_id, run_id)) = existing_asset {
        transaction
            .commit()
            .map_err(|error| format!("failed to finish deduplicated image import: {error}"))?;
        let detail = get_run_detail(paths, &run_id)?;
        let asset = detail
            .assets
            .iter()
            .find(|asset| asset.id == asset_id)
            .cloned()
            .ok_or_else(|| format!("deduplicated image asset {asset_id} was not found"))?;
        return Ok(MediaImageImportResult {
            detail,
            asset,
            deduplicated: true,
        });
    }
    let timestamp = now();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let run_id = format!("import:{}:{unique}", &digest[..16]);
    let (
        flow_id,
        flow_name,
        plan_id,
        prompt,
        model_label,
        executor,
        operation_json,
        imported_event,
    ) = match import_kind {
        LocalImportKind::Raster => (
            "builtin:import-image",
            "Import image",
            "import:validated-v1",
            "Imported local image",
            "Validated local import",
            "local-import",
            None,
            "Selected bytes passed format, animation, dimension, allocation, and decode checks before CAS publication.",
        ),
        LocalImportKind::RasterizedSvg { operation_json } => (
            "builtin:import-svg-raster",
            "Import safe SVG raster",
            "import:svg-raster-v1",
            "Rasterized local SVG",
            "Safe SVG rasterizer",
            "local-svg-raster",
            Some(operation_json),
            "SVG XML and resource policy checks passed before a no-network raster was published to CAS.",
        ),
    };
    let asset_id = format!("asset:{run_id}:0");
    transaction
        .execute(
            "INSERT INTO runs(\n\
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,\n\
               output_count, diagnostic_count, progress, current_step, executor, aspect_ratio\n\
             ) VALUES (?1, ?2, ?3, ?4, 'completed', ?5, ?5, ?6, ?7, 'local',\n\
               1, 0, 1, 'Completed', ?8, '1:1')",
            params![
                run_id,
                flow_id,
                flow_name,
                plan_id,
                timestamp,
                prompt,
                model_label,
                executor,
            ],
        )
        .map_err(|error| format!("failed to register image import run: {error}"))?;
    transaction
        .execute(
            "INSERT INTO jobs(id, run_id, status, attempts, started_at, finished_at, heartbeat_at)\n\
             VALUES (?1, ?2, 'completed', 1, ?3, ?3, ?3)",
            params![format!("job:{run_id}"), run_id, timestamp],
        )
        .map_err(|error| format!("failed to register image import job: {error}"))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![digest, byte_size as i64, mime_type, relative_path, timestamp],
        )
        .map_err(|error| format!("failed to register imported blob: {error}"))?;
    transaction
        .execute(
            "INSERT INTO assets(\n\
               id, run_id, blob_digest, kind, mime_type, byte_size, width, height, created_at,\n\
               output_index, fixture, operation_json\n\
             ) VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, 0, 0, ?9)",
            params![
                asset_id,
                run_id,
                digest,
                mime_type,
                byte_size as i64,
                width,
                height,
                timestamp,
                operation_json,
            ],
        )
        .map_err(|error| format!("failed to register imported image asset: {error}"))?;
    append_event(
        &transaction,
        &run_id,
        "asset_imported",
        imported_event,
        Some(1.0),
        Some("import.validate"),
    )?;
    append_event(
        &transaction,
        &run_id,
        "run_completed",
        "Local media import completed without a network request.",
        Some(1.0),
        Some("import.finalize"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit imported image: {error}"))?;
    let detail = get_run_detail(paths, &run_id)?;
    let asset = detail
        .assets
        .iter()
        .find(|asset| asset.id == asset_id)
        .cloned()
        .ok_or_else(|| format!("imported image asset {asset_id} was not found"))?;
    Ok(MediaImageImportResult {
        detail,
        asset,
        deduplicated: false,
    })
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_transformed_asset(
    paths: &MediaRuntimePaths,
    source_asset_id: &str,
    digest: &str,
    relative_path: &str,
    bytes: u64,
    mime_type: &str,
    width: u32,
    height: u32,
    operation_label: &str,
    operation_json: &str,
) -> MediaResult<MediaRunDetail> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin image transform registration: {error}"))?;
    let source_exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1 AND kind = 'image' AND deleted_at IS NULL)",
            params![source_asset_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("failed to validate transform source asset: {error}"))?;
    if !source_exists {
        return Err(format!("image asset {source_asset_id} was not found"));
    }

    let timestamp = now();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let run_id = format!("transform:{}:{unique}", &digest[..16]);
    let asset_id = format!("asset:{run_id}:0");
    transaction
        .execute(
            "INSERT INTO runs(\n\
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,\n\
               output_count, diagnostic_count, progress, current_step, executor, aspect_ratio\n\
             ) VALUES (?1, 'builtin:transform-image', ?2, 'transform:validated-v1', 'completed', ?3, ?3,\n\
               ?2, 'Built-in image processor', 'local', 1, 0, 1, 'Completed', 'local-transform', '1:1')",
            params![run_id, operation_label, timestamp],
        )
        .map_err(|error| format!("failed to register image transform run: {error}"))?;
    transaction
        .execute(
            "INSERT INTO jobs(id, run_id, status, attempts, started_at, finished_at, heartbeat_at)\n\
             VALUES (?1, ?2, 'completed', 1, ?3, ?3, ?3)",
            params![format!("job:{run_id}"), run_id, timestamp],
        )
        .map_err(|error| format!("failed to register image transform job: {error}"))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![digest, bytes as i64, mime_type, relative_path, timestamp],
        )
        .map_err(|error| format!("failed to register transformed blob: {error}"))?;
    transaction
        .execute(
            "INSERT INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height, created_at, output_index, fixture, operation_json)\n\
             VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, 0, 0, ?9)",
            params![asset_id, run_id, digest, mime_type, bytes as i64, width, height, timestamp, operation_json],
        )
        .map_err(|error| format!("failed to register transformed image asset: {error}"))?;
    transaction
        .execute(
            "INSERT INTO asset_inputs(asset_id, input_asset_id, role) VALUES (?1, ?2, 'source')",
            params![asset_id, source_asset_id],
        )
        .map_err(|error| format!("failed to register image transform lineage: {error}"))?;
    append_event(
        &transaction,
        &run_id,
        "asset_transformed",
        &format!("{operation_label} completed and published a derived CAS asset."),
        Some(1.0),
        Some("transform.publish"),
    )?;
    append_event(
        &transaction,
        &run_id,
        "run_completed",
        "Built-in image transformation completed without a network request.",
        Some(1.0),
        Some("transform.finalize"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit transformed image: {error}"))?;
    get_run_detail(paths, &run_id)
}

pub(crate) struct LocalImageFlowAssetRegistration<'a> {
    pub(crate) request: &'a crate::media::ExecuteLocalImageFlowRequest,
    pub(crate) digest: &'a str,
    pub(crate) relative_path: &'a str,
    pub(crate) bytes: u64,
    pub(crate) mime_type: &'a str,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) source_asset_ids: &'a [String],
    pub(crate) operation_json: &'a str,
    pub(crate) role: &'a str,
    pub(crate) tags: Vec<(String, String)>,
    pub(crate) companions: Vec<LocalImageFlowCompanionRegistration>,
}

pub(crate) fn begin_local_image_flow(
    paths: &MediaRuntimePaths,
    request: &crate::media::ExecuteLocalImageFlowRequest,
    flow_name: &str,
) -> MediaResult<bool> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin local image flow: {error}"))?;
    validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        Some(&request.flow_revision_id),
        Some(&request.plan_snapshot),
    )?;
    let timestamp = now();
    let plan_snapshot_json = serde_json::to_string(&request.plan_snapshot)
        .map_err(|error| format!("failed to serialize local flow plan snapshot: {error}"))?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runs(
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label,
               target, output_count, diagnostic_count, progress, current_step, executor, aspect_ratio,
               plan_snapshot_json, flow_revision_id
             ) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?5, 'Execute local image utility flow',
               'Built-in media utilities', 'local', 1, 0, 0, 'Preparing local flow',
               'local-image-flow', 'custom', ?6, ?7)",
            params![
                request.run_id,
                request.flow_id,
                flow_name,
                request.plan_id,
                timestamp,
                plan_snapshot_json,
                request.flow_revision_id,
            ],
        )
        .map_err(|error| format!("failed to register local image flow: {error}"))?;
    if inserted == 0 {
        validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            Some(&request.flow_revision_id),
            &request.plan_id,
            "local-image-flow",
        )?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit local flow replay: {error}"))?;
        return Ok(false);
    }
    transaction
        .execute(
            "INSERT INTO jobs(id, run_id, status, attempts, started_at, heartbeat_at)
             VALUES (?1, ?2, 'running', 1, ?3, ?3)",
            params![format!("job:{}", request.run_id), request.run_id, timestamp],
        )
        .map_err(|error| format!("failed to register local image flow job: {error}"))?;
    seed_node_executions(
        &transaction,
        &request.run_id,
        &request.plan_snapshot,
        "pending",
    )?;
    append_event(
        &transaction,
        &request.run_id,
        "run_started",
        "The pinned local utility graph started.",
        Some(0.0),
        None,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit local image flow start: {error}"))?;
    Ok(true)
}

pub(crate) struct LocalImageFlowCompanionRegistration {
    pub(crate) digest: String,
    pub(crate) relative_path: String,
    pub(crate) bytes: u64,
    pub(crate) mime_type: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) role: String,
    pub(crate) operation_json: String,
}

pub(crate) fn record_local_image_flow_asset(
    paths: &MediaRuntimePaths,
    registration: LocalImageFlowAssetRegistration<'_>,
) -> MediaResult<MediaRunDetail> {
    let LocalImageFlowAssetRegistration {
        request,
        digest,
        relative_path,
        bytes,
        mime_type,
        width,
        height,
        source_asset_ids,
        operation_json,
        role,
        tags,
        companions,
    } = registration;
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin local image flow registration: {error}"))?;
    validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        Some(&request.flow_revision_id),
        Some(&request.plan_snapshot),
    )?;
    for source_asset_id in source_asset_ids {
        let exists = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1 AND kind = 'image' AND deleted_at IS NULL)",
                params![source_asset_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| format!("failed to validate local flow source asset: {error}"))?;
        if !exists {
            return Err(format!("image asset {source_asset_id} was not found"));
        }
    }
    let timestamp = now();
    validate_existing_run_identity(
        &transaction,
        &request.run_id,
        &request.flow_id,
        Some(&request.flow_revision_id),
        &request.plan_id,
        "local-image-flow",
    )?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![digest, bytes as i64, mime_type, relative_path, timestamp],
        )
        .map_err(|error| format!("failed to register local flow blob: {error}"))?;
    let asset_id = format!("asset:{}:0", request.run_id);
    transaction
        .execute(
            "INSERT INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height,
               created_at, output_index, fixture, operation_json)
             VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, 0, 0, ?9)",
            params![
                asset_id,
                request.run_id,
                digest,
                mime_type,
                bytes as i64,
                width,
                height,
                timestamp,
                operation_json,
            ],
        )
        .map_err(|error| format!("failed to register local flow output asset: {error}"))?;
    for (index, source_asset_id) in source_asset_ids.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO asset_inputs(asset_id, input_asset_id, role) VALUES (?1, ?2, ?3)",
                params![asset_id, source_asset_id, format!("source:{index:03}")],
            )
            .map_err(|error| format!("failed to register local flow asset lineage: {error}"))?;
    }
    if role == "alpha-matte" {
        transaction
            .execute(
                "INSERT INTO asset_tags(asset_id, normalized_tag, display_tag, source, confidence, created_at)
                 VALUES (?1, 'alpha-matte', 'Alpha matte', 'technical', 1.0, ?2)",
                params![asset_id, timestamp],
            )
            .map_err(|error| format!("failed to tag extracted alpha matte: {error}"))?;
    }
    for (value, label) in tags {
        transaction
            .execute(
                "INSERT OR REPLACE INTO asset_tags(asset_id, normalized_tag, display_tag, source, confidence, created_at)
                 VALUES (?1, ?2, ?3, 'technical', 1.0, ?4)",
                params![asset_id, value, label, timestamp],
            )
            .map_err(|error| format!("failed to register local flow technical tag: {error}"))?;
    }
    for (companion_index, companion) in companions.iter().enumerate() {
        transaction
            .execute(
                "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    companion.digest,
                    companion.bytes as i64,
                    companion.mime_type,
                    companion.relative_path,
                    timestamp,
                ],
            )
            .map_err(|error| format!("failed to register local flow companion blob: {error}"))?;
        let companion_asset_id = format!("asset:{}:{}", request.run_id, companion_index + 1);
        transaction
            .execute(
                "INSERT INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height,
                   created_at, output_index, fixture, operation_json)
                 VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
                params![
                    companion_asset_id,
                    request.run_id,
                    companion.digest,
                    companion.mime_type,
                    companion.bytes as i64,
                    companion.width,
                    companion.height,
                    timestamp,
                    (companion_index + 1) as u32,
                    companion.operation_json,
                ],
            )
            .map_err(|error| {
                format!("failed to register local flow companion asset: {error}")
            })?;
        for (source_index, source_asset_id) in source_asset_ids.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO asset_inputs(asset_id, input_asset_id, role) VALUES (?1, ?2, ?3)",
                    params![
                        companion_asset_id,
                        source_asset_id,
                        format!("source:{source_index:03}"),
                    ],
                )
                .map_err(|error| {
                    format!("failed to register local flow companion lineage: {error}")
                })?;
        }
        if companion.role == "alpha matte" {
            transaction
                .execute(
                    "INSERT INTO asset_tags(asset_id, normalized_tag, display_tag, source, confidence, created_at)
                     VALUES (?1, 'alpha-matte', 'Alpha matte', 'technical', 1.0, ?2)",
                    params![companion_asset_id, timestamp],
                )
                .map_err(|error| format!("failed to tag alpha matte companion: {error}"))?;
        }
        append_event(
            &transaction,
            &request.run_id,
            "asset_published",
            &format!(
                "Published the {} companion with immutable CAS and source lineage.",
                companion.role
            ),
            Some(1.0),
            Some("local-flow.publish-companion"),
        )?;
    }
    append_event(
        &transaction,
        &request.run_id,
        "local_flow_executed",
        "The pinned local utility graph executed without a model or network request.",
        Some(1.0),
        Some("local-flow.execute"),
    )?;
    append_event(
        &transaction,
        &request.run_id,
        "asset_published",
        "The final image passed bounded encoding, SHA-256 verification, and immutable CAS publication.",
        Some(1.0),
        Some("local-flow.publish"),
    )?;
    finalize_node_executions(&transaction, &request.run_id, "completed")?;
    transaction
        .execute(
            "UPDATE runs SET status = 'completed', progress = 1, current_step = 'Completed',
             diagnostic_count = ?2, updated_at = ?3 WHERE id = ?1",
            params![request.run_id, companions.len() as u32, timestamp],
        )
        .map_err(|error| format!("failed to complete local image flow run: {error}"))?;
    transaction
        .execute(
            "UPDATE jobs SET status = 'completed', finished_at = ?2, heartbeat_at = ?2
             WHERE run_id = ?1",
            params![request.run_id, timestamp],
        )
        .map_err(|error| format!("failed to complete local image flow job: {error}"))?;
    append_event(
        &transaction,
        &request.run_id,
        "run_completed",
        "Local image utility flow completed.",
        Some(1.0),
        Some("local-flow.finalize"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit local image flow output: {error}"))?;
    get_run_detail(paths, &request.run_id)
}

pub(crate) fn begin_remote_image_generation(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaImagesRequest,
) -> MediaResult<bool> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin direct image generation: {error}"))?;
    validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        Some(&request.flow_revision_id),
        Some(&request.plan_snapshot),
    )?;
    let request_digest = provider_openai::request_digest(request)?;
    let unresolved_job_id = transaction
        .query_row(
            "SELECT id FROM provider_jobs
             WHERE request_digest = ?1 AND status = 'acceptance-unknown' AND review_required = 1
             ORDER BY created_at DESC LIMIT 1",
            params![request_digest],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect unresolved OpenAI submissions: {error}"))?;
    if let Some(job_id) = unresolved_job_id {
        return Err(format!(
            "A matching OpenAI request ({job_id}) may already have been accepted and charged. Review that provider decision before generating again."
        ));
    }
    let timestamp = now();
    let plan_snapshot_json = serde_json::to_string(&request.plan_snapshot)
        .map_err(|error| format!("failed to serialize direct generation plan: {error}"))?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runs(
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,
               output_count, diagnostic_count, progress, current_step, executor, aspect_ratio,
               plan_snapshot_json, flow_revision_id
             ) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?5, ?6, ?7, 'remote',
               ?8, ?9, 0.1, 'Generating images', 'openai-image-api', ?10, ?11, ?12)",
            params![
                request.run_id,
                request.flow_id,
                request.flow_name,
                request.plan_id,
                timestamp,
                request.prompt,
                request.model_label,
                request.output_count,
                request.diagnostic_count,
                request.aspect_ratio,
                plan_snapshot_json,
                request.flow_revision_id,
            ],
        )
        .map_err(|error| format!("failed to register direct image generation: {error}"))?;
    if inserted == 0 {
        validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            Some(&request.flow_revision_id),
            &request.plan_id,
            "openai-image-api",
        )?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit direct generation replay: {error}"))?;
        return Ok(false);
    }
    seed_node_executions(
        &transaction,
        &request.run_id,
        &request.plan_snapshot,
        "pending",
    )?;
    transaction
        .execute(
            "INSERT INTO jobs(id, run_id, status, attempts, started_at, heartbeat_at)
             VALUES (?1, ?2, 'running', 1, ?3, ?3)",
            params![format!("job:{}", request.run_id), request.run_id, timestamp],
        )
        .map_err(|error| format!("failed to register direct image generation job: {error}"))?;
    let policy_json = serde_json::to_string(&provider_openai::policy_snapshot())
        .map_err(|error| format!("failed to serialize OpenAI provider policy: {error}"))?;
    let reconciliation_deadline =
        (Utc::now() + chrono::Duration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true);
    transaction
        .execute(
            "INSERT INTO provider_jobs(
               id, run_id, attempt, status, raw_state, scenario, request_digest, idempotency_key,
               estimated_cost_min, estimated_cost_max, currency, reconciliation_deadline, policy_json,
               created_at, updated_at
             ) VALUES (?1, ?2, 1, 'submitting', 'request-dispatched', 'openai:gpt-image-2', ?3, NULL,
               0, 0, 'USD', ?4, ?5, ?6, ?6)",
            params![
                format!("provider:{}:1", request.run_id),
                request.run_id,
                request_digest,
                reconciliation_deadline,
                policy_json,
                timestamp,
            ],
        )
        .map_err(|error| format!("failed to durably prepare OpenAI provider attempt: {error}"))?;
    append_event(
        &transaction,
        &request.run_id,
        "provider_prepared",
        "A redacted OpenAI request digest and its no-idempotency retry policy were recorded before network submission.",
        Some(0.05),
        Some("provider.prepare"),
    )?;
    append_event(
        &transaction,
        &request.run_id,
        "provider_submission_started",
        "Direct OpenAI image request submission started.",
        Some(0.1),
        Some("provider.generate"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit direct image generation: {error}"))?;
    Ok(true)
}

pub(crate) fn begin_remote_svg_generation(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaSvgRequest,
    reference_plan: &SvgReferencePlan,
) -> MediaResult<bool> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin direct SVG generation: {error}"))?;
    validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        Some(&request.flow_revision_id),
        Some(&request.plan_snapshot),
    )?;
    let request_digest = provider_svg::request_digest(request, reference_plan)?;
    let unresolved_job_id = transaction
        .query_row(
            "SELECT id FROM provider_jobs
             WHERE request_digest = ?1 AND status = 'acceptance-unknown' AND review_required = 1
             ORDER BY created_at DESC LIMIT 1",
            params![request_digest],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect unresolved SVG submissions: {error}"))?;
    if let Some(job_id) = unresolved_job_id {
        return Err(format!(
            "A matching SVG request ({job_id}) may already have been accepted and charged. Review that provider decision before generating again."
        ));
    }
    let timestamp = now();
    let current_step = if request.mode == "vectorize" {
        "Preparing SVG vectorization"
    } else {
        "Preparing SVG candidate ensemble"
    };
    let submission_message = if request.mode == "vectorize" {
        "Dedicated SVG vectorization submission started."
    } else {
        "SVG candidate ensemble submission started."
    };
    let submission_step = if request.mode == "vectorize" {
        "provider.vectorize-svg"
    } else {
        "provider.generate-svg"
    };
    let plan_snapshot_json = serde_json::to_string(&request.plan_snapshot)
        .map_err(|error| format!("failed to serialize SVG generation plan: {error}"))?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runs(
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,
               output_count, diagnostic_count, progress, current_step, executor, aspect_ratio,
               plan_snapshot_json, flow_revision_id
             ) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?5, ?6, ?7, ?8,
               ?9, ?10, 0.05, ?11, 'svg-ai-pipeline', ?12, ?13, ?14)",
            params![
                request.run_id,
                request.flow_id,
                request.flow_name,
                request.plan_id,
                timestamp,
                request.prompt,
                request.model_label,
                if request.model_id.starts_with("local-svg:") { "local" } else { "remote" },
                request.output_count,
                request.diagnostic_count,
                current_step,
                request.aspect_ratio,
                plan_snapshot_json,
                request.flow_revision_id,
            ],
        )
        .map_err(|error| format!("failed to register direct SVG generation: {error}"))?;
    if inserted == 0 {
        validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            Some(&request.flow_revision_id),
            &request.plan_id,
            "svg-ai-pipeline",
        )?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit SVG generation replay: {error}"))?;
        return Ok(false);
    }
    seed_node_executions(
        &transaction,
        &request.run_id,
        &request.plan_snapshot,
        "pending",
    )?;
    transaction
        .execute(
            "INSERT INTO jobs(id, run_id, status, attempts, started_at, heartbeat_at)
             VALUES (?1, ?2, 'running', 1, ?3, ?3)",
            params![format!("job:{}", request.run_id), request.run_id, timestamp],
        )
        .map_err(|error| format!("failed to register SVG generation job: {error}"))?;
    let policy_json =
        serde_json::to_string(&provider_svg::policy_snapshot(request, reference_plan))
            .map_err(|error| format!("failed to serialize SVG provider policy: {error}"))?;
    let reconciliation_deadline =
        (Utc::now() + chrono::Duration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true);
    transaction
        .execute(
            "INSERT INTO provider_jobs(
               id, run_id, attempt, status, raw_state, scenario, request_digest, idempotency_key,
               estimated_cost_min, estimated_cost_max, currency, reconciliation_deadline, policy_json,
               created_at, updated_at
             ) VALUES (?1, ?2, 1, 'submitting', 'request-dispatched', ?3, ?4, NULL,
               0, 0, 'USD', ?5, ?6, ?7, ?7)",
            params![
                format!("provider:{}:1", request.run_id),
                request.run_id,
                request.model_id,
                request_digest,
                reconciliation_deadline,
                policy_json,
                timestamp,
            ],
        )
        .map_err(|error| format!("failed to durably prepare SVG provider attempt: {error}"))?;
    append_event(
        &transaction,
        &request.run_id,
        "provider_prepared",
        &format!(
            "A redacted SVG request digest, {} audited reference upload{} ({} bytes), and the no-automatic-retry policy were recorded before provider submission.",
            reference_plan.sources.len(),
            if reference_plan.sources.len() == 1 { "" } else { "s" },
            reference_plan.upload_bytes,
        ),
        Some(0.05),
        Some("provider.prepare-svg"),
    )?;
    append_event(
        &transaction,
        &request.run_id,
        "provider_submission_started",
        submission_message,
        Some(0.1),
        Some(submission_step),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit direct SVG generation: {error}"))?;
    Ok(true)
}

pub(crate) fn begin_svg_critic_attempt(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaSvgRequest,
    candidate_index: u32,
    phase: &str,
    model: &str,
    candidate_digest: &str,
    upload_bytes: u64,
) -> MediaResult<String> {
    if !matches!(phase, "repair" | "verify") {
        return Err(format!("unsupported SVG critic phase {phase}"));
    }
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin SVG critic audit: {error}"))?;
    let run_status = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![request.run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect SVG critic run: {error}"))?
        .ok_or_else(|| format!("media run {} was not found", request.run_id))?;
    if run_status != "running" {
        return Err(format!(
            "SVG critic request cannot start while the run is {run_status}"
        ));
    }
    let request_digest = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&serde_json::json!({
                "kind": "openai-svg-render-feedback",
                "runId": request.run_id,
                "candidateIndex": candidate_index,
                "candidateDigest": candidate_digest,
                "phase": phase,
                "model": model,
                "scorerVersion": crate::media::svg::SCORER_VERSION,
            }))
            .map_err(|error| format!("failed to canonicalize SVG critic request: {error}"))?
        )
    );
    let unresolved_job_id = transaction
        .query_row(
            "SELECT id FROM provider_jobs
             WHERE request_digest = ?1 AND status = 'acceptance-unknown' AND review_required = 1
             ORDER BY created_at DESC LIMIT 1",
            params![request_digest],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect unresolved SVG critic requests: {error}"))?;
    if let Some(job_id) = unresolved_job_id {
        return Err(format!(
            "A matching OpenAI SVG {phase} request ({job_id}) may already have been accepted and charged"
        ));
    }
    let attempt = transaction
        .query_row(
            "SELECT COALESCE(MAX(attempt), 0) + 1 FROM provider_jobs WHERE run_id = ?1",
            params![request.run_id],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|error| format!("failed to allocate SVG critic attempt: {error}"))?;
    let job_id = format!("provider:{}:{attempt}", request.run_id);
    let timestamp = now();
    let reconciliation_deadline =
        (Utc::now() + chrono::Duration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let policy_json = serde_json::to_string(&MediaProviderPolicySnapshot {
        adapter_id: "openai.responses-svg-critic".to_string(),
        adapter_version: "1.0.0".to_string(),
        endpoint_version: "v1/responses".to_string(),
        region: "provider-managed".to_string(),
        idempotency_mode: "none".to_string(),
        retry_policy: "Possible provider acceptance is quarantined; paid SVG critic requests are never retried automatically.".to_string(),
        cancellation_semantics: "The synchronous critic request cannot be canceled after acceptance; only a strictly improved Secure Static SVG is retained.".to_string(),
        input_retention_seconds: None,
        output_retention_seconds: None,
        output_visibility: "inline-structured-response".to_string(),
        public_links: false,
        no_store_requested: true,
        upload_asset_count: if phase == "verify" { 2 } else { 1 },
        upload_bytes,
        contains_personal_data: false,
        remote_upload_allowed: true,
    })
    .map_err(|error| format!("failed to serialize SVG critic policy: {error}"))?;
    transaction
        .execute(
            "INSERT INTO provider_jobs(
               id, run_id, attempt, status, raw_state, scenario, request_digest, idempotency_key,
               estimated_cost_min, estimated_cost_max, currency, reconciliation_deadline, policy_json,
               created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'submitting', 'request-dispatched', ?4, ?5, NULL,
               0, 0, 'USD', ?6, ?7, ?8, ?8)",
            params![
                job_id,
                request.run_id,
                attempt,
                format!("openai:svg-critic:{phase}:{model}"),
                request_digest,
                reconciliation_deadline,
                policy_json,
                timestamp,
            ],
        )
        .map_err(|error| format!("failed to durably prepare SVG critic request: {error}"))?;
    append_event(
        &transaction,
        &request.run_id,
        "provider_prepared",
        &format!(
            "OpenAI render-feedback {phase} request for SVG candidate {} was durably prepared with a no-automatic-retry policy.",
            candidate_index + 1
        ),
        None,
        Some("provider.prepare-svg-critic"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit SVG critic preparation: {error}"))?;
    Ok(job_id)
}

pub(crate) fn complete_svg_critic_attempt(
    paths: &MediaRuntimePaths,
    provider_job_id: &str,
    provider_request_id: Option<&str>,
    improved: bool,
    diagnostic: Option<&str>,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin SVG critic completion: {error}"))?;
    let timestamp = now();
    let raw_state = if improved {
        "completed-improved"
    } else {
        "completed-no-improvement"
    };
    let updated = transaction
        .execute(
            "UPDATE provider_jobs SET status = 'completed', raw_state = ?2,
               provider_request_id = COALESCE(?3, provider_request_id), accepted_at = ?4,
               completed_at = ?4, updated_at = ?4, review_required = 0, review_reason = NULL,
               error = ?5 WHERE id = ?1 AND status = 'submitting'",
            params![
                provider_job_id,
                raw_state,
                provider_request_id,
                timestamp,
                diagnostic,
            ],
        )
        .map_err(|error| format!("failed to persist SVG critic completion: {error}"))?;
    if updated != 1 {
        return Err(
            "SVG critic completion did not match its durable submitting attempt".to_string(),
        );
    }
    let (run_id, scenario) = transaction
        .query_row(
            "SELECT run_id, scenario FROM provider_jobs WHERE id = ?1",
            params![provider_job_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| format!("failed to resolve completed SVG critic run: {error}"))?;
    let verification = scenario.starts_with("openai:svg-critic:verify:");
    append_event(
        &transaction,
        &run_id,
        "provider_accepted",
        if verification && improved {
            "OpenAI render verification found no semantic regression; the locally improved SVG was retained."
        } else if verification {
            "OpenAI render verification did not confirm a semantic and visual improvement; the original SVG was retained."
        } else if improved {
            "OpenAI render feedback returned a structurally improved SVG that passed local validation and is awaiting visual verification."
        } else {
            "OpenAI render feedback completed, but the original SVG scored at least as well and was retained."
        },
        None,
        Some("provider.verify-svg-critic"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit SVG critic completion: {error}"))
}

pub(crate) fn fail_svg_critic_attempt(
    paths: &MediaRuntimePaths,
    provider_job_id: &str,
    diagnostic: &str,
    acceptance_unknown: bool,
    provider_request_id: Option<&str>,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin SVG critic failure: {error}"))?;
    let timestamp = now();
    let (status, raw_state, review_required, review_reason, completed_at) = if acceptance_unknown {
        (
            "acceptance-unknown",
            "outcome-unknown",
            1,
            Some("OpenAI may have accepted or charged this SVG critic request. The original candidate was retained and no automatic retry is allowed."),
            None,
        )
    } else {
        ("failed", "rejected", 0, None, Some(timestamp.as_str()))
    };
    let updated = transaction
        .execute(
            "UPDATE provider_jobs SET status = ?2, raw_state = ?3,
               provider_request_id = COALESCE(?4, provider_request_id), review_required = ?5,
               review_reason = ?6, error = ?7, completed_at = ?8, updated_at = ?9
             WHERE id = ?1 AND status = 'submitting'",
            params![
                provider_job_id,
                status,
                raw_state,
                provider_request_id,
                review_required,
                review_reason,
                diagnostic,
                completed_at,
                timestamp,
            ],
        )
        .map_err(|error| format!("failed to persist SVG critic failure: {error}"))?;
    if updated != 1 {
        return Err("SVG critic failure did not match its durable submitting attempt".to_string());
    }
    let (run_id, scenario) = transaction
        .query_row(
            "SELECT run_id, scenario FROM provider_jobs WHERE id = ?1",
            params![provider_job_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|error| format!("failed to resolve failed SVG critic run: {error}"))?;
    let phase = if scenario.starts_with("openai:svg-critic:verify:") {
        "verification"
    } else {
        "repair"
    };
    let event_message = if acceptance_unknown {
        format!("OpenAI SVG {phase} acceptance is uncertain. The original candidate was retained and automatic retry is blocked.")
    } else {
        format!("OpenAI rejected the SVG {phase} request; the original validated candidate was retained.")
    };
    append_event(
        &transaction,
        &run_id,
        if acceptance_unknown {
            "provider_acceptance_unknown"
        } else {
            "provider_failed"
        },
        &event_message,
        None,
        Some("provider.svg-critic"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit SVG critic failure: {error}"))
}

pub(crate) fn begin_remote_image_edit(
    paths: &MediaRuntimePaths,
    request: &crate::media::ExecuteRemoteImageEditFlowRequest,
    plan: &crate::media::flow::RemoteImageEditFlowPlan,
) -> MediaResult<bool> {
    if request.flow_id != plan.flow_id || request.flow_revision_id != plan.revision_id {
        return Err("remote image edit plan does not match the requested revision".to_string());
    }
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin remote image edit: {error}"))?;
    validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        Some(&request.flow_revision_id),
        Some(&request.plan_snapshot),
    )?;
    let request_digest = provider_openai::edit_request_digest(plan)?;
    let unresolved_job_id = transaction
        .query_row(
            "SELECT id FROM provider_jobs
             WHERE request_digest = ?1 AND status = 'acceptance-unknown' AND review_required = 1
             ORDER BY created_at DESC LIMIT 1",
            params![request_digest],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            format!("failed to inspect unresolved OpenAI edit submissions: {error}")
        })?;
    if let Some(job_id) = unresolved_job_id {
        return Err(format!(
            "A matching OpenAI edit request ({job_id}) may already have been accepted and charged. Review that provider decision before editing again."
        ));
    }

    let timestamp = now();
    let plan_snapshot_json = serde_json::to_string(&request.plan_snapshot)
        .map_err(|error| format!("failed to serialize remote edit plan: {error}"))?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runs(
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,
               output_count, diagnostic_count, progress, current_step, executor, aspect_ratio,
               plan_snapshot_json, flow_revision_id
             ) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?5, ?6, ?7, 'remote',
               ?8, 0, 0.05, 'Preparing metadata-stripped reference uploads', 'openai-image-api', ?9, ?10, ?11)",
            params![
                request.run_id,
                request.flow_id,
                plan.flow_name,
                request.plan_id,
                timestamp,
                plan.prompt,
                plan.model_label,
                plan.output_count,
                plan.aspect_ratio,
                plan_snapshot_json,
                request.flow_revision_id,
            ],
        )
        .map_err(|error| format!("failed to register remote image edit: {error}"))?;
    if inserted == 0 {
        validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            Some(&request.flow_revision_id),
            &request.plan_id,
            "openai-image-api",
        )?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit remote edit replay: {error}"))?;
        return Ok(false);
    }
    seed_node_executions(
        &transaction,
        &request.run_id,
        &request.plan_snapshot,
        "pending",
    )?;
    transaction
        .execute(
            "INSERT INTO jobs(id, run_id, status, attempts, started_at, heartbeat_at)
             VALUES (?1, ?2, 'running', 1, ?3, ?3)",
            params![format!("job:{}", request.run_id), request.run_id, timestamp],
        )
        .map_err(|error| format!("failed to register remote image edit job: {error}"))?;
    let policy_json = serde_json::to_string(&provider_openai::edit_policy_snapshot(plan))
        .map_err(|error| format!("failed to serialize OpenAI edit provider policy: {error}"))?;
    let reconciliation_deadline =
        (Utc::now() + chrono::Duration::days(7)).to_rfc3339_opts(SecondsFormat::Millis, true);
    transaction
        .execute(
            "INSERT INTO provider_jobs(
               id, run_id, attempt, status, raw_state, scenario, request_digest, idempotency_key,
               estimated_cost_min, estimated_cost_max, currency, reconciliation_deadline, policy_json,
               created_at, updated_at
             ) VALUES (?1, ?2, 1, 'submitting', 'request-dispatched', 'openai:gpt-image-2', ?3, NULL,
               0, 0, 'USD', ?4, ?5, ?6, ?6)",
            params![
                format!("provider:{}:1", request.run_id),
                request.run_id,
                request_digest,
                reconciliation_deadline,
                policy_json,
                timestamp,
            ],
        )
        .map_err(|error| format!("failed to durably prepare OpenAI edit attempt: {error}"))?;
    append_event(
        &transaction,
        &request.run_id,
        "provider_prepared",
        &format!(
            "A redacted request digest and manifest for {} metadata-stripped reference upload{} ({} bytes) were recorded before network submission.",
            plan.sources.len(),
            if plan.sources.len() == 1 { "" } else { "s" },
            plan.upload_bytes
        ),
        Some(0.05),
        Some("provider.prepare"),
    )?;
    append_event(
        &transaction,
        &request.run_id,
        "provider_submission_started",
        "The confirmed reference images are being uploaded to OpenAI for a paid GPT Image 2 edit request.",
        Some(0.1),
        Some("provider.edit"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit remote image edit: {error}"))?;
    Ok(true)
}

pub(crate) fn begin_local_diffusers_generation(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaImagesRequest,
) -> MediaResult<bool> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin local diffusion generation: {error}"))?;
    validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        Some(&request.flow_revision_id),
        Some(&request.plan_snapshot),
    )?;
    let timestamp = now();
    let plan_snapshot_json = serde_json::to_string(&request.plan_snapshot)
        .map_err(|error| format!("failed to serialize local generation plan: {error}"))?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runs(
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,
               output_count, diagnostic_count, progress, current_step, executor, aspect_ratio,
               plan_snapshot_json, flow_revision_id
             ) VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?5, ?6, ?7, 'local',
               ?8, ?9, 0.1, 'Loading local model and add-ons', 'local-diffusers', ?10, ?11, ?12)",
            params![
                request.run_id,
                request.flow_id,
                request.flow_name,
                request.plan_id,
                timestamp,
                request.prompt,
                request.model_label,
                request.output_count,
                request.diagnostic_count,
                request.aspect_ratio,
                plan_snapshot_json,
                request.flow_revision_id,
            ],
        )
        .map_err(|error| format!("failed to register local diffusion generation: {error}"))?;
    if inserted == 0 {
        validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            Some(&request.flow_revision_id),
            &request.plan_id,
            "local-diffusers",
        )?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit local generation replay: {error}"))?;
        return Ok(false);
    }
    seed_node_executions(
        &transaction,
        &request.run_id,
        &request.plan_snapshot,
        "pending",
    )?;
    transaction
        .execute(
            "INSERT INTO jobs(id, run_id, status, attempts, started_at, heartbeat_at)
             VALUES (?1, ?2, 'running', 1, ?3, ?3)",
            params![format!("job:{}", request.run_id), request.run_id, timestamp],
        )
        .map_err(|error| format!("failed to register local diffusion job: {error}"))?;
    append_event(
        &transaction,
        &request.run_id,
        "worker_prepared",
        "The exact local model revision and ordered add-on stack will be resolved before loading the isolated Diffusers worker.",
        Some(0.02),
        Some("local-diffusers.prepare"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit local diffusion generation: {error}"))?;
    Ok(true)
}

pub(crate) fn complete_local_diffusers_generation(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaImagesRequest,
    batch: &LocalGeneratedImageBatch,
) -> MediaResult<MediaRunDetail> {
    if batch.assets.len() != request.output_count as usize {
        return Err("local diffusion generation produced an unexpected output count".to_string());
    }
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin local image publication: {error}"))?;
    let status = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![request.run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect local diffusion generation: {error}"))?
        .ok_or_else(|| format!("media run {} was not found", request.run_id))?;
    if status == "completed" {
        transaction.commit().map_err(|error| {
            format!("failed to commit completed local generation replay: {error}")
        })?;
        return get_run_detail(paths, &request.run_id);
    }
    if status == "canceling" {
        finalize_cancellation(&transaction, &request.run_id)?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit local generation cancellation: {error}"))?;
        return get_run_detail(paths, &request.run_id);
    }
    if status != "running" {
        return Err(format!(
            "local diffusion generation cannot publish from {status} state"
        ));
    }
    let timestamp = now();
    append_event(
        &transaction,
        &request.run_id,
        "worker_completed",
        "The isolated Diffusers worker completed and all outputs passed bounded local image validation.",
        Some(0.82),
        Some("local-diffusers.generate"),
    )?;
    for asset in &batch.assets {
        transaction
            .execute(
                "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    asset.digest,
                    asset.byte_size as i64,
                    asset.mime_type,
                    asset.relative_path,
                    timestamp,
                ],
            )
            .map_err(|error| format!("failed to register locally generated image blob: {error}"))?;
        let operation_json = serde_json::json!({
            "kind": "local-diffusion-generation",
            "providerId": "local-diffusers",
            "modelId": request.model_id,
            "flowRevisionId": request.flow_revision_id,
            "modelRevision": batch.provenance.model_revision,
            "modelDigest": batch.provenance.model_digest,
            "workerVersion": batch.provenance.worker_version,
            "packages": batch.provenance.packages,
            "device": batch.provenance.device,
            "deviceLabel": batch.provenance.device_label,
            "deviceMemoryBytes": batch.provenance.device_memory_bytes,
            "prompt": batch.provenance.prompt,
            "negativePrompt": batch.provenance.negative_prompt,
            "addons": batch.provenance.addons,
            "output": batch.provenance.outputs.iter().find(|output| output.index == asset.output_index),
            "subjectCutout": asset.subject_cutout,
        })
        .to_string();
        transaction
            .execute(
                "INSERT INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height,
                   created_at, output_index, fixture, operation_json)
                 VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
                params![
                    format!("asset:{}:{}", request.run_id, asset.output_index),
                    request.run_id,
                    asset.digest,
                    asset.mime_type,
                    asset.byte_size as i64,
                    asset.width,
                    asset.height,
                    timestamp,
                    asset.output_index,
                    operation_json,
                ],
            )
            .map_err(|error| format!("failed to register locally generated image asset: {error}"))?;
        append_event(
            &transaction,
            &request.run_id,
            "asset_published",
            &format!(
                "Local image {} was validated and ingested into immutable CAS.",
                asset.output_index + 1
            ),
            Some(0.84 + 0.12 * (f64::from(asset.output_index + 1) / request.output_count as f64)),
            Some("asset.publish"),
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit local image publication: {error}"))?;
    complete_run(paths, &request.run_id)?;
    get_run_detail(paths, &request.run_id)
}

pub(crate) fn complete_remote_image_generation(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaImagesRequest,
    batch: &GeneratedImageBatch,
) -> MediaResult<MediaRunDetail> {
    if batch.assets.len() != request.output_count as usize {
        return Err("direct image generation produced an unexpected output count".to_string());
    }
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin generated image publication: {error}"))?;
    let status = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![request.run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect direct image generation: {error}"))?
        .ok_or_else(|| format!("media run {} was not found", request.run_id))?;
    if status == "completed" {
        transaction
            .commit()
            .map_err(|error| format!("failed to commit completed generation replay: {error}"))?;
        return get_run_detail(paths, &request.run_id);
    }
    if status == "canceling" {
        let timestamp = now();
        transaction
            .execute(
                "UPDATE provider_jobs SET status = 'completed', raw_state = 'completed-after-cancel',
                   provider_request_id = ?2, accepted_at = ?3, completed_at = ?3, updated_at = ?3,
                   review_required = 0, review_reason = NULL
                 WHERE run_id = ?1 AND attempt = 1",
                params![request.run_id, batch.provider_request_id, timestamp],
            )
            .map_err(|error| {
                format!("failed to record OpenAI completion after cancellation: {error}")
            })?;
        finalize_cancellation(&transaction, &request.run_id)?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit direct generation cancellation: {error}"))?;
        return Err(
            "OpenAI image generation was canceled after provider completion; outputs were not published"
                .to_string(),
        );
    }
    if status != "running" {
        return Err(format!(
            "direct image generation cannot publish from {status} state"
        ));
    }

    let timestamp = now();
    let provider_completion_updated = transaction
        .execute(
            "UPDATE provider_jobs SET status = 'completed', raw_state = 'completed',
               provider_request_id = ?2, accepted_at = ?3, completed_at = ?3, updated_at = ?3,
               review_required = 0, review_reason = NULL
             WHERE run_id = ?1 AND attempt = 1 AND status = 'submitting'",
            params![request.run_id, batch.provider_request_id, timestamp],
        )
        .map_err(|error| format!("failed to persist OpenAI provider completion: {error}"))?;
    if provider_completion_updated != 1 {
        return Err(
            "OpenAI provider completion did not match the durable submitting attempt".to_string(),
        );
    }
    append_event(
        &transaction,
        &request.run_id,
        "provider_accepted",
        "OpenAI completed the direct image request.",
        Some(0.75),
        Some("provider.generate"),
    )?;
    for asset in &batch.assets {
        transaction
            .execute(
                "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    asset.digest,
                    asset.byte_size as i64,
                    asset.mime_type,
                    asset.relative_path,
                    timestamp,
                ],
            )
            .map_err(|error| format!("failed to register generated image blob: {error}"))?;
        let operation_json = serde_json::json!({
            "kind": "remote-image-generation",
            "providerId": "openai",
            "modelId": request.model_id,
            "providerRequestId": batch.provider_request_id,
            "flowRevisionId": request.flow_revision_id,
            "subjectCutout": asset.subject_cutout,
        })
        .to_string();
        transaction
            .execute(
                "INSERT INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height,
                   created_at, output_index, fixture, operation_json)
                 VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
                params![
                    format!("asset:{}:{}", request.run_id, asset.output_index),
                    request.run_id,
                    asset.digest,
                    asset.mime_type,
                    asset.byte_size as i64,
                    asset.width,
                    asset.height,
                    timestamp,
                    asset.output_index,
                    operation_json,
                ],
            )
            .map_err(|error| format!("failed to register generated image asset: {error}"))?;
        append_event(
            &transaction,
            &request.run_id,
            "asset_published",
            &format!(
                "Generated image {} was validated and ingested into immutable CAS.",
                asset.output_index + 1
            ),
            Some(0.8 + 0.15 * (f64::from(asset.output_index + 1) / request.output_count as f64)),
            Some("provider.publish"),
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit generated image publication: {error}"))?;
    complete_run(paths, &request.run_id)?;
    get_run_detail(paths, &request.run_id)
}

pub(crate) fn complete_remote_svg_generation(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaSvgRequest,
    batch: &GeneratedSvgBatch,
    reference_plan: &SvgReferencePlan,
) -> MediaResult<MediaRunDetail> {
    if batch.assets.len() != request.output_count as usize {
        return Err("direct SVG generation produced an unexpected output count".to_string());
    }
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin generated SVG publication: {error}"))?;
    let status = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![request.run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect direct SVG generation: {error}"))?
        .ok_or_else(|| format!("media run {} was not found", request.run_id))?;
    if status == "completed" {
        transaction
            .commit()
            .map_err(|error| format!("failed to commit completed SVG replay: {error}"))?;
        return get_run_detail(paths, &request.run_id);
    }
    if status == "canceling" {
        let timestamp = now();
        transaction
            .execute(
                "UPDATE provider_jobs SET status = 'completed', raw_state = 'completed-after-cancel',
                   provider_request_id = ?2, accepted_at = ?3, completed_at = ?3, updated_at = ?3,
                   review_required = 0, review_reason = NULL
                 WHERE run_id = ?1 AND attempt = 1",
                params![request.run_id, batch.provider_request_id, timestamp],
            )
            .map_err(|error| {
                format!("failed to record SVG completion after cancellation: {error}")
            })?;
        finalize_cancellation(&transaction, &request.run_id)?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit SVG generation cancellation: {error}"))?;
        return get_run_detail(paths, &request.run_id);
    }
    if status != "running" {
        return Err(format!(
            "direct SVG generation cannot publish from {status} state"
        ));
    }
    let timestamp = now();
    let provider_completion_updated = transaction
        .execute(
            "UPDATE provider_jobs SET status = 'completed', raw_state = 'validated-and-ranked',
               provider_request_id = ?2, accepted_at = ?3, completed_at = ?3, updated_at = ?3,
               review_required = 0, review_reason = NULL
             WHERE run_id = ?1 AND attempt = 1 AND status = 'submitting'",
            params![request.run_id, batch.provider_request_id, timestamp],
        )
        .map_err(|error| format!("failed to persist SVG provider completion: {error}"))?;
    if provider_completion_updated != 1 {
        return Err(
            "SVG provider completion did not match the durable submitting attempt".to_string(),
        );
    }
    append_event(
        &transaction,
        &request.run_id,
        "provider_accepted",
        &format!(
            "The SVG provider returned {} candidates{}; Secure Static validation and deterministic ranking completed{}.",
            batch.generated_candidate_count,
            batch
                .provider_credits
                .map(|credits| format!(" and reported {credits} provider credits"))
                .unwrap_or_default(),
            if batch.critic_attempt_count == 0 {
                String::new()
            } else {
                format!(
                    " after {} audited OpenAI render-feedback attempt{}",
                    batch.critic_attempt_count,
                    if batch.critic_attempt_count == 1 { "" } else { "s" }
                )
            },
        ),
        Some(0.78),
        Some("provider.verify-svg"),
    )?;
    let source_manifest = reference_plan
        .sources
        .iter()
        .map(|source| {
            serde_json::json!({
                "assetId": source.asset_id,
                "role": source.role,
                "influence": source.influence,
                "sourceDigest": source.source_digest,
                "uploadDigest": source.upload_digest,
                "uploadBytes": source.upload_byte_size,
                "width": source.width,
                "height": source.height,
            })
        })
        .collect::<Vec<_>>();
    for asset in &batch.assets {
        transaction
            .execute(
                "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at)
                 VALUES (?1, ?2, 'image/svg+xml', ?3, ?4)",
                params![asset.digest, asset.byte_size as i64, asset.relative_path, timestamp],
            )
            .map_err(|error| format!("failed to register generated SVG blob: {error}"))?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at)
                 VALUES (?1, ?2, 'image/png', ?3, ?4)",
                params![
                    asset.preview_digest,
                    asset.preview_byte_size as i64,
                    asset.preview_relative_path,
                    timestamp,
                ],
            )
            .map_err(|error| format!("failed to register SVG preview blob: {error}"))?;
        let operation_json = serde_json::json!({
            "kind": "remote-svg-generation",
            "providerId": request.model_id.split(':').next().unwrap_or("svg-ai"),
            "modelId": request.model_id,
            "providerRequestId": batch.provider_request_id,
            "flowRevisionId": request.flow_revision_id,
            "mode": request.mode,
            "autoCrop": request.auto_crop,
            "targetSize": request.target_size,
            "style": request.style,
            "textPolicy": request.text_policy,
            "candidateCount": batch.generated_candidate_count,
            "providerCredits": batch.provider_credits,
            "rank": asset.output_index + 1,
            "score": asset.score,
            "structure": asset.structure,
            "repairRounds": asset.repair_rounds,
            "criticAttempted": asset.critic_attempted,
            "criticProviderId": asset.critic_attempted.then_some("openai"),
            "criticModel": asset.critic_model,
            "criticRequestId": asset.critic_request_ids.last(),
            "criticRequestIds": asset.critic_request_ids,
            "criticVerdict": asset.critic_verdict,
            "criticAttemptCount": batch.critic_attempt_count,
            "metadataStrippedBeforeUpload": true,
            "colorProfilePreservedBeforeUpload": true,
            "sources": &source_manifest,
            "sanitizerVersion": crate::media::svg::SANITIZER_VERSION,
            "rendererVersion": crate::media::svg::RENDERER_VERSION,
            "scorerVersion": crate::media::svg::SCORER_VERSION,
            "fontPolicy": "no-host-font-access",
        })
        .to_string();
        let asset_id = format!("asset:{}:{}", request.run_id, asset.output_index);
        transaction
            .execute(
                "INSERT INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height,
                   created_at, output_index, fixture, operation_json)
                 VALUES (?1, ?2, ?3, 'vector', 'image/svg+xml', ?4, ?5, ?6, ?7, ?8, 0, ?9)",
                params![
                    asset_id,
                    request.run_id,
                    asset.digest,
                    asset.byte_size as i64,
                    asset.width,
                    asset.height,
                    timestamp,
                    asset.output_index,
                    operation_json,
                ],
            )
            .map_err(|error| format!("failed to register generated SVG asset: {error}"))?;
        for (index, source) in reference_plan.sources.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO asset_inputs(asset_id, input_asset_id, role) VALUES (?1, ?2, ?3)",
                    params![
                        asset_id,
                        source.asset_id,
                        format!("reference:{}:{index:03}", source.role),
                    ],
                )
                .map_err(|error| format!("failed to register guided SVG lineage: {error}"))?;
        }
        transaction
            .execute(
                "INSERT INTO asset_renditions(asset_id, profile, blob_digest, mime_type, byte_size, width, height, created_at)
                 VALUES (?1, 'svg-preview-1024-secure-static-v1', ?2, 'image/png', ?3, ?4, ?5, ?6)",
                params![
                    asset_id,
                    asset.preview_digest,
                    asset.preview_byte_size as i64,
                    asset.preview_width,
                    asset.preview_height,
                    timestamp,
                ],
            )
            .map_err(|error| format!("failed to register generated SVG preview: {error}"))?;
        append_event(
            &transaction,
            &request.run_id,
            "asset_published",
            &format!(
                "Ranked SVG {} passed validation, render verification, scoring, SHA-256 hashing, and immutable publication (score {:.1}).",
                asset.output_index + 1,
                asset.score.score
            ),
            Some(0.8 + 0.15 * (f64::from(asset.output_index + 1) / request.output_count as f64)),
            Some("provider.publish-svg"),
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit generated SVG publication: {error}"))?;
    complete_run(paths, &request.run_id)?;
    get_run_detail(paths, &request.run_id)
}

pub(crate) fn complete_remote_image_edit(
    paths: &MediaRuntimePaths,
    request: &crate::media::ExecuteRemoteImageEditFlowRequest,
    plan: &crate::media::flow::RemoteImageEditFlowPlan,
    batch: &GeneratedImageBatch,
) -> MediaResult<MediaRunDetail> {
    if batch.assets.len() != plan.output_count as usize {
        return Err("remote image edit produced an unexpected output count".to_string());
    }
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin edited image publication: {error}"))?;
    let status = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![request.run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect remote image edit: {error}"))?
        .ok_or_else(|| format!("media run {} was not found", request.run_id))?;
    if status == "completed" {
        transaction
            .commit()
            .map_err(|error| format!("failed to commit completed edit replay: {error}"))?;
        return get_run_detail(paths, &request.run_id);
    }
    if status == "canceling" {
        let timestamp = now();
        transaction
            .execute(
                "UPDATE provider_jobs SET status = 'completed', raw_state = 'completed-after-cancel',
                   provider_request_id = ?2, accepted_at = ?3, completed_at = ?3, updated_at = ?3,
                   review_required = 0, review_reason = NULL
                 WHERE run_id = ?1 AND attempt = 1",
                params![request.run_id, batch.provider_request_id, timestamp],
            )
            .map_err(|error| {
                format!("failed to record OpenAI edit completion after cancellation: {error}")
            })?;
        finalize_cancellation(&transaction, &request.run_id)?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit remote edit cancellation: {error}"))?;
        return Err(
            "OpenAI image edit was canceled after provider completion; outputs were not published"
                .to_string(),
        );
    }
    if status != "running" {
        return Err(format!(
            "remote image edit cannot publish from {status} state"
        ));
    }

    let timestamp = now();
    let provider_completion_updated = transaction
        .execute(
            "UPDATE provider_jobs SET status = 'completed', raw_state = 'completed',
               provider_request_id = ?2, accepted_at = ?3, completed_at = ?3, updated_at = ?3,
               review_required = 0, review_reason = NULL
             WHERE run_id = ?1 AND attempt = 1 AND status = 'submitting'",
            params![request.run_id, batch.provider_request_id, timestamp],
        )
        .map_err(|error| format!("failed to persist OpenAI edit completion: {error}"))?;
    if provider_completion_updated != 1 {
        return Err(
            "OpenAI edit completion did not match the durable submitting attempt".to_string(),
        );
    }
    append_event(
        &transaction,
        &request.run_id,
        "provider_accepted",
        "OpenAI completed the GPT Image 2 edit request; returned bytes are being validated locally.",
        Some(0.75),
        Some("provider.edit"),
    )?;
    let source_manifest = plan
        .sources
        .iter()
        .enumerate()
        .map(|(index, source)| {
            serde_json::json!({
                "order": index + 1,
                "nodeId": source.node_id,
                "assetId": source.asset_id,
                "role": source.role,
                "influence": source.influence,
                "sourceDigest": source.source_digest,
                "uploadDigest": source.upload_digest,
                "uploadBytes": source.upload_byte_size,
                "width": source.width,
                "height": source.height,
            })
        })
        .collect::<Vec<_>>();
    for asset in &batch.assets {
        transaction
            .execute(
                "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    asset.digest,
                    asset.byte_size as i64,
                    asset.mime_type,
                    asset.relative_path,
                    timestamp,
                ],
            )
            .map_err(|error| format!("failed to register edited image blob: {error}"))?;
        let operation_json = serde_json::json!({
            "kind": "remote-image-edit",
            "providerId": "openai",
            "modelId": plan.model_id,
            "modelSnapshot": "gpt-image-2-2026-04-21",
            "providerRequestId": batch.provider_request_id,
            "flowRevisionId": request.flow_revision_id,
            "taskNodeId": plan.task_node_id,
            "editStrength": plan.edit_strength,
            "metadataStrippedBeforeUpload": true,
            "orientationAppliedBeforeUpload": true,
            "colorProfilePreservedBeforeUpload": true,
            "sources": &source_manifest,
            "subjectCutout": asset.subject_cutout,
        })
        .to_string();
        let output_asset_id = format!("asset:{}:{}", request.run_id, asset.output_index);
        transaction
            .execute(
                "INSERT INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height,
                   created_at, output_index, fixture, operation_json)
                 VALUES (?1, ?2, ?3, 'image', ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10)",
                params![
                    output_asset_id,
                    request.run_id,
                    asset.digest,
                    asset.mime_type,
                    asset.byte_size as i64,
                    asset.width,
                    asset.height,
                    timestamp,
                    asset.output_index,
                    operation_json,
                ],
            )
            .map_err(|error| format!("failed to register edited image asset: {error}"))?;
        for (index, source) in plan.sources.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO asset_inputs(asset_id, input_asset_id, role) VALUES (?1, ?2, ?3)",
                    params![
                        output_asset_id,
                        source.asset_id,
                        format!("{}:{index:03}", source.role),
                    ],
                )
                .map_err(|error| format!("failed to register edited image lineage: {error}"))?;
        }
        append_event(
            &transaction,
            &request.run_id,
            "asset_published",
            &format!(
                "Edited image {} passed bounded decode, format verification, SHA-256 hashing, and immutable publication.",
                asset.output_index + 1
            ),
            Some(0.8 + 0.15 * (f64::from(asset.output_index + 1) / plan.output_count as f64)),
            Some("provider.publish"),
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit edited image publication: {error}"))?;
    complete_run(paths, &request.run_id)?;
    get_run_detail(paths, &request.run_id)
}

pub(crate) fn fail_remote_image_generation(
    paths: &MediaRuntimePaths,
    run_id: &str,
    diagnostic: &str,
    acceptance_unknown: bool,
    provider_request_id: Option<&str>,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin direct generation failure update: {error}"))?;
    let timestamp = now();
    let run_status = if acceptance_unknown {
        "needs-review"
    } else {
        "failed"
    };
    let current_step = if acceptance_unknown {
        "Provider acceptance requires review"
    } else {
        "Failed"
    };
    if acceptance_unknown {
        transaction
            .execute(
                "UPDATE node_executions SET status = 'blocked', runtime_phase = 'provider.acceptance-unknown',
                 message = ?2, updated_at = ?3, finished_at = NULL,
                 state_sequence = state_sequence + 1
                 WHERE run_id = ?1 AND status IN ('queued', 'running', 'retrying')",
                params![run_id, diagnostic, timestamp],
            )
            .map_err(|error| format!("failed to quarantine provider node executions: {error}"))?;
    } else {
        finalize_node_executions(&transaction, run_id, "failed")?;
    }
    let updated = transaction
        .execute(
            "UPDATE runs SET status = ?2, updated_at = ?3, current_step = ?4, error = ?5
             WHERE id = ?1 AND status IN ('running', 'canceling')",
            params![run_id, run_status, timestamp, current_step, diagnostic],
        )
        .map_err(|error| format!("failed to record direct generation failure: {error}"))?;
    if updated > 0 {
        transaction
            .execute(
                "UPDATE jobs SET status = ?2, finished_at = ?3, heartbeat_at = ?3, error = ?4
                  WHERE run_id = ?1",
                params![run_id, run_status, timestamp, diagnostic],
            )
            .map_err(|error| format!("failed to record direct generation job failure: {error}"))?;
        if acceptance_unknown {
            transaction
                .execute(
                    "UPDATE provider_jobs SET status = 'acceptance-unknown', raw_state = 'outcome-unknown',
                       provider_request_id = COALESCE(?2, provider_request_id), review_required = 1,
                       review_reason = 'OpenAI may have accepted or completed this paid request, but the result could not be durably published. No automatic resubmission is allowed.',
                       error = ?3, next_poll_at = NULL, updated_at = ?4
                     WHERE run_id = ?1 AND attempt = 1 AND status = 'submitting'",
                    params![run_id, provider_request_id, diagnostic, timestamp],
                )
                .map_err(|error| {
                    format!("failed to quarantine uncertain OpenAI submission: {error}")
                })?;
        } else {
            transaction
                .execute(
                    "UPDATE provider_jobs SET status = 'failed', raw_state = 'rejected',
                       provider_request_id = COALESCE(?2, provider_request_id), review_required = 0,
                       review_reason = NULL, error = ?3, completed_at = ?4, updated_at = ?4
                     WHERE run_id = ?1 AND attempt = 1 AND status = 'submitting'",
                    params![run_id, provider_request_id, diagnostic, timestamp],
                )
                .map_err(|error| format!("failed to close rejected OpenAI submission: {error}"))?;
        }
        append_event(
            &transaction,
            run_id,
            if acceptance_unknown {
                "provider_acceptance_unknown"
            } else {
                "provider_failed"
            },
            if acceptance_unknown {
                "OpenAI may have accepted or charged the request. Automatic resubmission is blocked until the provider decision is reviewed."
            } else {
                "OpenAI rejected the request before returning a publishable image result."
            },
            None,
            Some("provider.generate"),
        )?;
        if !acceptance_unknown {
            append_event(
                &transaction,
                run_id,
                "run_failed",
                "Direct image generation failed.",
                None,
                Some("provider.finalize"),
            )?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit direct generation failure: {error}"))
}

pub(crate) fn resolve_openai_provider_review(
    paths: &MediaRuntimePaths,
    provider_job_id: &str,
    action: &str,
) -> MediaResult<String> {
    if action == "reconcile-only" {
        return Err("This synchronous provider adapter does not expose a documented request lookup. Check the provider usage dashboard, then explicitly confirm that no charge occurred before generating again.".to_string());
    }
    let accepted_duplicate_charge_risk = match action {
        "confirm-not-accepted-and-retry" => false,
        "accept-duplicate-charge-risk-and-retry" => true,
        _ => return Err("provider review action is not supported".to_string()),
    };
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin OpenAI provider review: {error}"))?;
    let (run_id, status, scenario) = transaction
        .query_row(
            "SELECT run_id, status, scenario FROM provider_jobs WHERE id = ?1",
            params![provider_job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect OpenAI provider review: {error}"))?
        .ok_or_else(|| format!("provider job {provider_job_id} was not found"))?;
    let is_svg_critic = scenario.starts_with("openai:svg-critic:");
    let is_direct_synchronous_request = scenario == "openai:gpt-image-2"
        || is_svg_critic
        || scenario.starts_with("quiver:")
        || scenario.starts_with("recraft:")
        || scenario.starts_with("local-svg:");
    if !is_direct_synchronous_request || status != "acceptance-unknown" {
        return Err(format!(
            "provider job is not an unresolved synchronous generation request (status {status})"
        ));
    }
    let run_status = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("failed to inspect reviewed OpenAI run: {error}"))?;
    let timestamp = now();
    let raw_state = if accepted_duplicate_charge_risk {
        "operator-accepted-duplicate-charge-risk"
    } else {
        "operator-confirmed-not-accepted"
    };
    let provider_error = if accepted_duplicate_charge_risk {
        "Operator accepted that a replacement request could create a duplicate charge."
    } else {
        "Operator confirmed that the provider did not accept or charge the request."
    };
    let current_step = if accepted_duplicate_charge_risk {
        "Review closed — duplicate-charge risk accepted"
    } else {
        "Review closed — safe to generate again"
    };
    let run_error = if accepted_duplicate_charge_risk {
        "The unresolved provider attempt was closed after explicit acceptance of possible duplicate-charge risk."
    } else {
        "The unresolved provider attempt was closed after explicit confirmation that no charge occurred."
    };
    let event_message = if is_svg_critic && run_status == "completed" {
        if accepted_duplicate_charge_risk {
            "The uncertain SVG repair request was closed after accepting possible duplicate-charge risk; the already published original candidate remains unchanged."
        } else {
            "The uncertain SVG repair request was closed after confirming no charge; the already published original candidate remains unchanged."
        }
    } else if accepted_duplicate_charge_risk {
        "The user accepted that a replacement provider request may create a duplicate charge. A future Generate action may submit a new paid request."
    } else {
        "The user confirmed that the provider did not accept or charge the unresolved request. A future Generate action may submit a new request."
    };
    transaction
        .execute(
            "UPDATE provider_jobs SET status = 'failed', raw_state = ?2,
               review_required = 0, review_reason = NULL,
               error = ?3, completed_at = ?4, updated_at = ?4 WHERE id = ?1",
            params![provider_job_id, raw_state, provider_error, timestamp],
        )
        .map_err(|error| format!("failed to close OpenAI provider review: {error}"))?;
    if !is_svg_critic || run_status != "completed" {
        finalize_node_executions(&transaction, &run_id, "failed")?;
        transaction
            .execute(
                "UPDATE runs SET status = 'failed', current_step = ?2, error = ?3,
                   updated_at = ?4 WHERE id = ?1",
                params![run_id, current_step, run_error, timestamp],
            )
            .map_err(|error| format!("failed to close reviewed OpenAI run: {error}"))?;
        transaction
            .execute(
                "UPDATE jobs SET status = 'failed', finished_at = ?2, heartbeat_at = ?2,
                   error = 'Provider review closed without retry' WHERE run_id = ?1",
                params![run_id, timestamp],
            )
            .map_err(|error| format!("failed to close reviewed OpenAI job: {error}"))?;
    }
    append_event(
        &transaction,
        &run_id,
        "provider_review_closed",
        event_message,
        None,
        Some("provider.review"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit OpenAI provider review: {error}"))?;
    Ok(run_id)
}

pub(crate) fn record_quality_report(
    paths: &MediaRuntimePaths,
    source_asset_id: &str,
    digest: &str,
    relative_path: &str,
    bytes: u64,
    report: &super::MediaQualityReport,
) -> MediaResult<MediaRunDetail> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin quality report registration: {error}"))?;
    let source_exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1 AND kind = 'image' AND deleted_at IS NULL)",
            params![source_asset_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("failed to validate quality analysis source: {error}"))?;
    if !source_exists {
        return Err(format!("image asset {source_asset_id} was not found"));
    }

    let timestamp = now();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let run_id = format!("analysis:{}:{unique}", &digest[..16]);
    let asset_id = format!("asset:{run_id}:0");
    let operation_json = serde_json::to_string(&serde_json::json!({
        "kind": "analyze-quality",
        "profileId": report.profile.id,
        "verdict": report.verdict,
    }))
    .map_err(|error| format!("failed to encode quality report metadata: {error}"))?;
    transaction
        .execute(
            "INSERT INTO runs(\n\
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,\n\
               output_count, diagnostic_count, progress, current_step, executor, aspect_ratio\n\
             ) VALUES (?1, 'builtin:analyze-image', 'Analyze image quality', ?2, 'completed', ?3, ?3,\n\
               'Deterministic technical image analysis', 'Technical image profile', 'local', 1, 0, 1,\n\
               'Completed', 'local-analysis', '1:1')",
            params![run_id, format!("quality:{}:{}", report.profile.id, report.profile.version), timestamp],
        )
        .map_err(|error| format!("failed to register quality analysis run: {error}"))?;
    transaction
        .execute(
            "INSERT INTO jobs(id, run_id, status, attempts, started_at, finished_at, heartbeat_at)\n\
             VALUES (?1, ?2, 'completed', 1, ?3, ?3, ?3)",
            params![format!("job:{run_id}"), run_id, timestamp],
        )
        .map_err(|error| format!("failed to register quality analysis job: {error}"))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at)\n\
             VALUES (?1, ?2, 'application/json', ?3, ?4)",
            params![digest, bytes as i64, relative_path, timestamp],
        )
        .map_err(|error| format!("failed to register quality report blob: {error}"))?;
    transaction
        .execute(
            "INSERT INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height, created_at, output_index, fixture, operation_json)\n\
             VALUES (?1, ?2, ?3, 'report', 'application/json', ?4, 0, 0, ?5, 0, 0, ?6)",
            params![asset_id, run_id, digest, bytes as i64, timestamp, operation_json],
        )
        .map_err(|error| format!("failed to register quality report asset: {error}"))?;
    transaction
        .execute(
            "INSERT INTO asset_inputs(asset_id, input_asset_id, role) VALUES (?1, ?2, 'source')",
            params![asset_id, source_asset_id],
        )
        .map_err(|error| format!("failed to register quality report lineage: {error}"))?;
    append_event(
        &transaction,
        &run_id,
        "asset_analyzed",
        &format!(
            "Technical quality profile {} produced a {} verdict and immutable report.",
            report.profile.id, report.verdict
        ),
        Some(1.0),
        Some("analysis.publish"),
    )?;
    append_event(
        &transaction,
        &run_id,
        "run_completed",
        "Deterministic local image analysis completed without a network request.",
        Some(1.0),
        Some("analysis.finalize"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit quality report: {error}"))?;
    get_run_detail(paths, &run_id)
}

pub(crate) fn complete_run(paths: &MediaRuntimePaths, run_id: &str) -> MediaResult<()> {
    let connection = open(paths)?;
    let (status, executor, plan_snapshot_json) = connection
        .query_row(
            "SELECT status, executor, plan_snapshot_json FROM runs WHERE id = ?1",
            params![run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect completed fixture run: {error}"))?
        .ok_or_else(|| format!("media run {run_id} was not found"))?;
    if matches!(status.as_str(), "completed" | "waiting-for-review") {
        return Ok(());
    }
    if status != "running" {
        return Err(format!("media run {run_id} cannot complete from {status}"));
    }
    let review_steps = plan_snapshot_json
        .map(|raw| {
            serde_json::from_str::<MediaRunPlanSnapshot>(&raw)
                .map_err(|error| format!("failed to decode run plan snapshot: {error}"))
        })
        .transpose()?
        .map(|snapshot| {
            snapshot
                .steps
                .into_iter()
                .filter(|step| step.kind == "wait-for-review")
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    drop(connection);

    if review_steps.is_empty() {
        let message = match executor.as_str() {
            "mock-remote-provider" => {
                "All provider outputs were ingested into CAS before their retention deadline."
            }
            "openai-image-api" => {
                "All OpenAI image outputs passed bounded decode and immutable CAS publication checks."
            }
            "openai-image-edit-api" => {
                "All edited OpenAI image outputs passed bounded decode, lineage, and immutable CAS publication checks."
            }
            _ => "All fixture outputs passed decode and CAS ingestion checks.",
        };
        return update_terminal_run(
            paths,
            run_id,
            "completed",
            "Completed",
            "run_completed",
            message,
            None,
        );
    }

    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin human review handoff: {error}"))?;
    let candidate_asset_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT id FROM assets WHERE run_id = ?1 AND deleted_at IS NULL ORDER BY output_index ASC",
            )
            .map_err(|error| format!("failed to prepare review candidate query: {error}"))?;
        let candidates = statement
            .query_map(params![run_id], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to read review candidates: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode review candidates: {error}"))?;
        candidates
    };
    if candidate_asset_ids.is_empty() {
        return Err("human review requires at least one published candidate".to_string());
    }
    let timestamp = now();
    for (index, step) in review_steps.iter().enumerate() {
        let review = step.review.as_ref().ok_or_else(|| {
            format!(
                "human review step {} has no durable review contract",
                step.id
            )
        })?;
        let review_id = format!("human-review:{run_id}:{}", step.id);
        let candidates: &[String] = if index == 0 {
            &candidate_asset_ids
        } else {
            &[]
        };
        let candidate_json = serde_json::to_string(candidates)
            .map_err(|error| format!("failed to serialize review candidates: {error}"))?;
        transaction
            .execute(
                "INSERT INTO human_reviews(
                   id, run_id, node_id, sequence, status, instructions, max_selections,
                   require_comment, candidate_asset_ids_json, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    review_id,
                    run_id,
                    step.source_node_id,
                    (index + 1) as u32,
                    if index == 0 { "pending" } else { "queued" },
                    review.instructions,
                    review.max_selections,
                    review.require_comment,
                    candidate_json,
                    timestamp,
                ],
            )
            .map_err(|error| format!("failed to persist human review: {error}"))?;
    }
    transaction
        .execute(
            "UPDATE runs SET status = 'waiting-for-review', progress = 0.96,
             current_step = 'Waiting for human review', updated_at = ?2 WHERE id = ?1",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to pause media run for review: {error}"))?;
    transaction
        .execute(
            "UPDATE jobs SET status = 'waiting-for-review', heartbeat_at = ?2 WHERE run_id = ?1",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to pause media job for review: {error}"))?;
    transaction
        .execute(
            "DELETE FROM resource_leases WHERE owner_run_id = ?1",
            params![run_id],
        )
        .map_err(|error| format!("failed to release media lease for review: {error}"))?;
    transaction
        .execute(
            "UPDATE node_executions SET status = 'queued', active_step_id = NULL,
             runtime_phase = 'human.review', message = 'Waiting for review approval',
             updated_at = ?2, finished_at = NULL, state_sequence = state_sequence + 1
             WHERE run_id = ?1 AND status = 'running'
               AND ordinal > COALESCE(
                 (SELECT MIN(review_node.ordinal) FROM node_executions review_node
                  WHERE review_node.run_id = ?1
                    AND review_node.node_id IN (SELECT node_id FROM human_reviews WHERE run_id = ?1)),
                 -1
               )",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to queue post-review node executions: {error}"))?;
    transition_node_execution_in_transaction(
        &transaction,
        run_id,
        &review_steps[0].source_node_id,
        "waiting-for-review",
        Some("human.review"),
        Some("Waiting for human review"),
        Some(0.96),
    )?;
    let first_contract = review_steps[0].review.as_ref().expect("validated above");
    append_event(
        &transaction,
        run_id,
        "human_review_requested",
        &format!(
            "{} candidates are ready; approve up to {}. Compute leases were released while the run waits.",
            candidate_asset_ids.len(), first_contract.max_selections
        ),
        Some(0.96),
        Some(&review_steps[0].source_node_id),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit human review handoff: {error}"))
}

pub(crate) fn resolve_human_review(
    paths: &MediaRuntimePaths,
    request: &MediaHumanReviewDecisionRequest,
) -> MediaResult<String> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin human review decision: {error}"))?;
    let selected_json = serde_json::to_string(&request.selected_asset_ids)
        .map_err(|error| format!("failed to serialize selected assets: {error}"))?;
    let existing_decision = transaction
        .query_row(
            "SELECT hr.run_id, d.review_id, d.action, d.selected_asset_ids_json, d.comment
             FROM human_review_decisions d
             JOIN human_reviews hr ON hr.id = d.review_id
             WHERE d.id = ?1",
            params![request.decision_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect human review idempotency: {error}"))?;
    if let Some((run_id, review_id, action, selected, comment)) = existing_decision {
        if review_id == request.review_id
            && action == request.action
            && selected == selected_json
            && comment == request.comment
        {
            transaction
                .commit()
                .map_err(|error| format!("failed to finish idempotent review: {error}"))?;
            return Ok(run_id);
        }
        return Err(
            "human review decision idempotency conflict: decisionId was reused with different inputs"
                .to_string(),
        );
    }

    let (run_id, node_id, sequence, status, max_selections, require_comment, candidate_json) =
        transaction
            .query_row(
                "SELECT run_id, node_id, sequence, status, max_selections, require_comment,
                        candidate_asset_ids_json
                 FROM human_reviews WHERE id = ?1",
                params![request.review_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, u32>(4)?,
                        row.get::<_, bool>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("failed to inspect human review: {error}"))?
            .ok_or_else(|| format!("human review {} was not found", request.review_id))?;
    if status != "pending" {
        return Err(format!(
            "human review {} cannot be decided from {status}",
            request.review_id
        ));
    }
    let run_status = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("failed to inspect human review run: {error}"))?;
    if run_status != "waiting-for-review" {
        return Err(format!("media run {run_id} is not waiting for review"));
    }
    let candidates = serde_json::from_str::<Vec<String>>(&candidate_json)
        .map_err(|error| format!("failed to decode human review candidates: {error}"))?;
    if require_comment && request.comment.is_empty() {
        return Err("this human review requires a comment".to_string());
    }
    if request.action == "approve" {
        if request.selected_asset_ids.is_empty() {
            return Err("approve requires at least one selected asset".to_string());
        }
        if request.selected_asset_ids.len() > max_selections as usize {
            return Err(format!(
                "this human review allows at most {max_selections} selected assets"
            ));
        }
        let candidate_set = candidates.iter().collect::<HashSet<_>>();
        if request
            .selected_asset_ids
            .iter()
            .any(|asset_id| !candidate_set.contains(asset_id))
        {
            return Err("selectedAssetIds must be candidates from this review".to_string());
        }
    } else if !request.selected_asset_ids.is_empty() {
        return Err("reject decisions cannot contain selected assets".to_string());
    }

    let timestamp = now();
    let actor = "local-user";
    transaction
        .execute(
            "INSERT INTO human_review_decisions(
               id, review_id, action, selected_asset_ids_json, comment, actor, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                request.decision_id,
                request.review_id,
                request.action,
                selected_json,
                request.comment,
                actor,
                timestamp,
            ],
        )
        .map_err(|error| format!("failed to append human review decision: {error}"))?;
    transaction
        .execute(
            "UPDATE human_reviews SET status = ?2, updated_at = ?3, decided_at = ?3 WHERE id = ?1",
            params![
                request.review_id,
                if request.action == "approve" {
                    "approved"
                } else {
                    "rejected"
                },
                timestamp,
            ],
        )
        .map_err(|error| format!("failed to finalize human review: {error}"))?;

    if request.action == "approve" {
        transition_node_execution_in_transaction(
            &transaction,
            &run_id,
            &node_id,
            "completed",
            Some("human.review.approved"),
            Some("Human review approved"),
            Some(0.98),
        )?;
        append_event(
            &transaction,
            &run_id,
            "human_review_approved",
            &format!(
                "Reviewer approved {} of {} candidates.",
                request.selected_asset_ids.len(),
                candidates.len()
            ),
            Some(0.98),
            Some(&node_id),
        )?;
        let next_review = transaction
            .query_row(
                "SELECT id, node_id, max_selections FROM human_reviews
                 WHERE run_id = ?1 AND sequence > ?2 AND status = 'queued'
                 ORDER BY sequence ASC LIMIT 1",
                params![run_id, sequence],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, u32>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("failed to inspect chained human review: {error}"))?;
        if let Some((next_id, next_node_id, next_max)) = next_review {
            transaction
                .execute(
                    "UPDATE human_reviews SET status = 'pending', candidate_asset_ids_json = ?2,
                     updated_at = ?3 WHERE id = ?1",
                    params![next_id, selected_json, timestamp],
                )
                .map_err(|error| format!("failed to activate chained human review: {error}"))?;
            transaction
                .execute(
                    "UPDATE runs SET progress = 0.98, current_step = 'Waiting for the next human review',
                     updated_at = ?2 WHERE id = ?1",
                    params![run_id, timestamp],
                )
                .map_err(|error| format!("failed to advance chained human review: {error}"))?;
            transition_node_execution_in_transaction(
                &transaction,
                &run_id,
                &next_node_id,
                "waiting-for-review",
                Some("human.review"),
                Some("Waiting for the next human review"),
                Some(0.98),
            )?;
            append_event(
                &transaction,
                &run_id,
                "human_review_requested",
                &format!(
                    "{} approved candidates entered the next review; approve up to {}.",
                    request.selected_asset_ids.len(),
                    next_max
                ),
                Some(0.98),
                Some(&next_node_id),
            )?;
        } else {
            finalize_node_executions(&transaction, &run_id, "completed")?;
            transaction
                .execute(
                    "UPDATE runs SET status = 'completed', progress = 1,
                     current_step = ?2, updated_at = ?3 WHERE id = ?1",
                    params![
                        run_id,
                        format!("Completed · {} approved", request.selected_asset_ids.len()),
                        timestamp,
                    ],
                )
                .map_err(|error| format!("failed to complete reviewed media run: {error}"))?;
            transaction
                .execute(
                    "UPDATE jobs SET status = 'completed', finished_at = ?2, heartbeat_at = ?2
                     WHERE run_id = ?1",
                    params![run_id, timestamp],
                )
                .map_err(|error| format!("failed to complete reviewed media job: {error}"))?;
            append_event(
                &transaction,
                &run_id,
                "run_completed",
                "Human-approved outputs completed the durable review contract.",
                Some(1.0),
                Some("finalize"),
            )?;
        }
    } else {
        transition_node_execution_in_transaction(
            &transaction,
            &run_id,
            &node_id,
            "canceled",
            Some("human.review.rejected"),
            Some("Rejected in human review"),
            None,
        )?;
        finalize_node_executions(&transaction, &run_id, "canceled")?;
        transaction
            .execute(
                "UPDATE runs SET status = 'canceled', progress = MIN(progress, 0.99),
                 current_step = 'Rejected in human review', updated_at = ?2 WHERE id = ?1",
                params![run_id, timestamp],
            )
            .map_err(|error| format!("failed to reject reviewed media run: {error}"))?;
        transaction
            .execute(
                "UPDATE jobs SET status = 'canceled', finished_at = ?2, heartbeat_at = ?2
                 WHERE run_id = ?1",
                params![run_id, timestamp],
            )
            .map_err(|error| format!("failed to reject reviewed media job: {error}"))?;
        append_event(
            &transaction,
            &run_id,
            "human_review_rejected",
            &format!("Reviewer rejected all {} candidates.", candidates.len()),
            None,
            Some(&node_id),
        )?;
        append_event(
            &transaction,
            &run_id,
            "run_canceled",
            "The run ended without approved outputs after explicit human rejection.",
            None,
            Some("finalize"),
        )?;
    }
    transaction
        .execute(
            "DELETE FROM resource_leases WHERE owner_run_id = ?1",
            params![run_id],
        )
        .map_err(|error| format!("failed to release reviewed media lease: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit human review decision: {error}"))?;
    Ok(run_id)
}

pub(crate) fn cancel_run(paths: &MediaRuntimePaths, run_id: &str) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin fixture cancellation: {error}"))?;
    finalize_cancellation(&transaction, run_id)?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit fixture cancellation: {error}"))
}

fn finalize_cancellation(transaction: &Transaction<'_>, run_id: &str) -> MediaResult<()> {
    let timestamp = now();
    finalize_node_executions(transaction, run_id, "canceled")?;
    transaction
        .execute(
            "UPDATE runs SET status = 'canceled', progress = MIN(progress, 0.99), current_step = 'Canceled', updated_at = ?2 WHERE id = ?1 AND status NOT IN ('completed', 'failed', 'canceled')",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to cancel media run: {error}"))?;
    transaction
        .execute(
            "UPDATE jobs SET status = 'canceled', finished_at = ?2, heartbeat_at = ?2 WHERE run_id = ?1 AND status NOT IN ('completed', 'failed', 'canceled')",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to cancel media job: {error}"))?;
    transaction
        .execute(
            "DELETE FROM resource_leases WHERE owner_run_id = ?1",
            params![run_id],
        )
        .map_err(|error| format!("failed to release canceled media lease: {error}"))?;
    append_event(
        transaction,
        run_id,
        "run_canceled",
        "Fixture execution stopped at a safe checkpoint.",
        None,
        Some("cancel"),
    )
}

pub(crate) fn fail_run(paths: &MediaRuntimePaths, run_id: &str, error: &str) -> MediaResult<()> {
    update_terminal_run(
        paths,
        run_id,
        "failed",
        "Failed",
        "run_failed",
        "Fixture execution failed. Inspect the persisted error before retrying.",
        Some(error),
    )
}

fn update_terminal_run(
    paths: &MediaRuntimePaths,
    run_id: &str,
    status: &str,
    current_step: &str,
    event_kind: &str,
    message: &str,
    error: Option<&str>,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|failure| format!("failed to begin media run finalization: {failure}"))?;
    let timestamp = now();
    finalize_node_executions(&transaction, run_id, status)?;
    transaction
        .execute(
            "UPDATE runs SET status = ?2, progress = CASE WHEN ?2 = 'completed' THEN 1 ELSE progress END, current_step = ?3, error = ?4, updated_at = ?5 WHERE id = ?1",
            params![run_id, status, current_step, error, timestamp],
        )
        .map_err(|failure| format!("failed to finalize media run: {failure}"))?;
    transaction
        .execute(
            "UPDATE jobs SET status = ?2, finished_at = ?3, heartbeat_at = ?3, error = ?4 WHERE run_id = ?1",
            params![run_id, status, timestamp, error],
        )
        .map_err(|failure| format!("failed to finalize media job: {failure}"))?;
    transaction
        .execute(
            "DELETE FROM resource_leases WHERE owner_run_id = ?1",
            params![run_id],
        )
        .map_err(|failure| format!("failed to release media lease: {failure}"))?;
    append_event(
        &transaction,
        run_id,
        event_kind,
        message,
        (status == "completed").then_some(1.0),
        Some("finalize"),
    )?;
    transaction
        .commit()
        .map_err(|failure| format!("failed to commit media run finalization: {failure}"))
}

pub(crate) fn request_cancellation(paths: &MediaRuntimePaths, run_id: &str) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin media cancellation request: {error}"))?;
    let status = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect media run for cancellation: {error}"))?
        .ok_or_else(|| format!("media run {run_id} was not found"))?;
    if matches!(status.as_str(), "completed" | "failed" | "canceled") {
        return Ok(());
    }
    if status == "waiting-for-review" {
        finalize_cancellation(&transaction, run_id)?;
        transaction
            .commit()
            .map_err(|error| format!("failed to commit review cancellation: {error}"))?;
        return Ok(());
    }
    transaction
        .execute(
            "UPDATE runs SET cancel_requested = 1, status = 'canceling', current_step = 'Cancellation requested', updated_at = ?2 WHERE id = ?1",
            params![run_id, now()],
        )
        .map_err(|error| format!("failed to request media cancellation: {error}"))?;
    append_event(
        &transaction,
        run_id,
        "cancel_requested",
        "Cancellation will occur at the next safe checkpoint.",
        None,
        Some("cancel"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit media cancellation request: {error}"))
}

pub(crate) fn retry_fixture_run(paths: &MediaRuntimePaths, run_id: &str) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin fixture retry: {error}"))?;
    let (status, attempts, max_attempts, output_count, published_outputs) = transaction
        .query_row(
            "SELECT r.status, j.attempts, j.max_attempts, r.output_count,\n\
                    (SELECT COUNT(*) FROM assets a WHERE a.run_id = r.id)\n\
             FROM runs r JOIN jobs j ON j.run_id = r.id WHERE r.id = ?1",
            params![run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, u32>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect fixture retry state: {error}"))?
        .ok_or_else(|| format!("media run {run_id} was not found"))?;
    if !matches!(status.as_str(), "failed" | "canceled") {
        return Err(format!(
            "media run {run_id} cannot be retried from {status}"
        ));
    }
    let has_human_review = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM human_reviews WHERE run_id = ?1)",
            params![run_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("failed to inspect fixture review history: {error}"))?;
    if has_human_review {
        return Err(
            "human-reviewed runs are immutable; create a new run instead of retrying this outcome"
                .to_string(),
        );
    }
    if attempts >= max_attempts {
        return Err(format!(
            "media run {run_id} exhausted its {max_attempts} fixture attempts"
        ));
    }

    let progress = if output_count == 0 || published_outputs == 0 {
        0.0
    } else {
        0.05 + (f64::from(published_outputs) / f64::from(output_count)) * 0.9
    };
    let timestamp = now();
    transaction
        .execute(
            "UPDATE runs SET status = 'queued', progress = ?2, current_step = 'Queued for retry', error = NULL, cancel_requested = 0, updated_at = ?3 WHERE id = ?1",
            params![run_id, progress, timestamp],
        )
        .map_err(|error| format!("failed to queue fixture retry: {error}"))?;
    transaction
        .execute(
            "UPDATE jobs SET status = 'queued', finished_at = NULL, heartbeat_at = ?2, error = NULL WHERE run_id = ?1",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to queue fixture job retry: {error}"))?;
    transaction
        .execute(
            "UPDATE node_executions SET status = 'retrying', runtime_phase = 'fixture.retry',
             message = 'Queued for retry', updated_at = ?2, finished_at = NULL,
             state_sequence = state_sequence + 1
             WHERE run_id = ?1 AND status IN ('failed', 'canceled')",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to queue fixture node retry: {error}"))?;
    append_event(
        &transaction,
        run_id,
        "retry_queued",
        "Fixture retry was queued; previously ingested outputs will be reused.",
        Some(progress),
        Some("retry"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit fixture retry: {error}"))
}

pub(crate) fn list_runs(paths: &MediaRuntimePaths, limit: u32) -> MediaResult<Vec<MediaRunRecord>> {
    let connection = open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,\n\
                    output_count, diagnostic_count, progress, current_step, executor, error, flow_revision_id\n\
             FROM runs ORDER BY created_at DESC LIMIT ?1",
        )
        .map_err(|error| format!("failed to prepare media run query: {error}"))?;
    let runs = statement
        .query_map(params![limit], map_run)
        .map_err(|error| format!("failed to query media runs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode media runs: {error}"))?;
    Ok(runs)
}

pub(crate) fn get_run_detail(
    paths: &MediaRuntimePaths,
    run_id: &str,
) -> MediaResult<MediaRunDetail> {
    let connection = open(paths)?;
    let mut run = connection
        .query_row(
            "SELECT id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,\n\
                    output_count, diagnostic_count, progress, current_step, executor, error, flow_revision_id\n\
             FROM runs WHERE id = ?1",
            params![run_id],
            map_run,
        )
        .optional()
        .map_err(|error| format!("failed to read media run: {error}"))?
        .ok_or_else(|| format!("media run {run_id} was not found"))?;
    let events = list_events(&connection, run_id)?;
    let assets = list_assets_for_run(&connection, run_id)?;
    if let Some(failure) = run.failure.take() {
        run.failure = Some(failure.with_partial_outputs(!assets.is_empty()));
    }
    let provider_jobs = list_provider_jobs_for_run(&connection, run_id)?;
    let human_reviews = list_human_reviews_for_run(&connection, run_id)?;
    let node_executions = list_node_executions(&connection, run_id)?;
    let plan_snapshot = connection
        .query_row(
            "SELECT plan_snapshot_json FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|error| format!("failed to read run plan snapshot: {error}"))?
        .map(|raw| {
            serde_json::from_str::<MediaRunPlanSnapshot>(&raw)
                .map_err(|error| format!("failed to decode run plan snapshot: {error}"))
        })
        .transpose()?;
    Ok(MediaRunDetail {
        run,
        events,
        assets,
        provider_jobs,
        human_reviews,
        node_executions,
        plan_snapshot,
    })
}

pub(crate) fn list_assets(
    paths: &MediaRuntimePaths,
    limit: u32,
) -> MediaResult<Vec<MediaAssetRecord>> {
    let connection = open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT a.id, a.run_id, a.blob_digest, a.kind, a.mime_type, a.byte_size, a.width, a.height, a.created_at, a.output_index, a.fixture, a.operation_json\n\
             FROM assets a JOIN runs r ON r.id = a.run_id\n\
             WHERE a.deleted_at IS NULL\n\
               AND (\n\
                 NOT EXISTS (SELECT 1 FROM human_reviews hr WHERE hr.run_id = a.run_id)\n\
                 OR (r.status = 'completed' AND EXISTS (\n\
                   SELECT 1 FROM human_reviews hr\n\
                   JOIN human_review_decisions d ON d.review_id = hr.id\n\
                   JOIN json_each(d.selected_asset_ids_json) selected\n\
                   WHERE hr.run_id = a.run_id AND d.action = 'approve'\n\
                     AND hr.sequence = (SELECT MAX(last_hr.sequence) FROM human_reviews last_hr WHERE last_hr.run_id = a.run_id)\n\
                     AND selected.value = a.id\n\
                 ))\n\
               )\n\
             ORDER BY r.created_at DESC, a.output_index ASC LIMIT ?1",
        )
        .map_err(|error| format!("failed to prepare media asset query: {error}"))?;
    let mut assets = statement
        .query_map(params![limit], map_asset)
        .map_err(|error| format!("failed to query media assets: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode media assets: {error}"))?;
    attach_asset_inputs(&connection, &mut assets)?;
    attach_asset_tags(&connection, &mut assets)?;
    Ok(assets)
}

pub(crate) fn set_user_asset_tags(
    paths: &MediaRuntimePaths,
    asset_id: &str,
    tags: &[(String, String)],
) -> MediaResult<MediaAssetRecord> {
    replace_asset_tags(paths, asset_id, "user", tags, None)
}

pub(crate) fn auto_tag_asset(
    paths: &MediaRuntimePaths,
    asset_id: &str,
) -> MediaResult<MediaAssetRecord> {
    let connection = open(paths)?;
    let (kind, mime_type, width, height, fixture) = connection
        .query_row(
            "SELECT kind, mime_type, width, height, fixture FROM assets WHERE id = ?1 AND deleted_at IS NULL",
            params![asset_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, u32>(3)?,
                    row.get::<_, bool>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect asset for technical tags: {error}"))?
        .ok_or_else(|| format!("media asset {asset_id} was not found"))?;
    drop(connection);

    let mut tags = vec![(kind.clone(), kind)];
    let format = match mime_type.as_str() {
        "image/png" => Some(("png", "PNG")),
        "image/jpeg" => Some(("jpeg", "JPEG")),
        "image/webp" => Some(("webp", "WebP")),
        "image/svg+xml" => Some(("svg-vector", "SVG vector")),
        "application/json" => Some(("json-report", "JSON report")),
        _ => None,
    };
    if let Some((value, label)) = format {
        tags.push((value.to_string(), label.to_string()));
    }
    if width > 0 && height > 0 {
        let difference = width.abs_diff(height);
        let aspect_tag = if difference <= width.max(height) / 100 {
            ("square", "Square")
        } else if width > height {
            ("landscape", "Landscape")
        } else {
            ("portrait", "Portrait")
        };
        tags.push((aspect_tag.0.to_string(), aspect_tag.1.to_string()));
        let resolution_tag = if width.min(height) < 512 {
            ("low-resolution", "Low resolution")
        } else if width.max(height) >= 1_920 || u64::from(width) * u64::from(height) >= 2_000_000 {
            ("high-resolution", "High resolution")
        } else {
            ("standard-resolution", "Standard resolution")
        };
        tags.push((resolution_tag.0.to_string(), resolution_tag.1.to_string()));
    }
    if fixture {
        tags.push(("fixture-output".to_string(), "Fixture output".to_string()));
    }
    replace_asset_tags(paths, asset_id, "technical", &tags, Some(1.0))
}

fn replace_asset_tags(
    paths: &MediaRuntimePaths,
    asset_id: &str,
    source: &str,
    tags: &[(String, String)],
    confidence: Option<f64>,
) -> MediaResult<MediaAssetRecord> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin asset tag revision: {error}"))?;
    let run_id = transaction
        .query_row(
            "SELECT run_id FROM assets WHERE id = ?1 AND deleted_at IS NULL",
            params![asset_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to locate tagged media asset: {error}"))?
        .ok_or_else(|| format!("media asset {asset_id} was not found"))?;
    transaction
        .execute(
            "DELETE FROM asset_tags WHERE asset_id = ?1 AND source = ?2",
            params![asset_id, source],
        )
        .map_err(|error| format!("failed to replace asset tags: {error}"))?;
    let timestamp = now();
    for (value, label) in tags {
        transaction
            .execute(
                "INSERT INTO asset_tags(asset_id, normalized_tag, display_tag, source, confidence, created_at)\n\
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![asset_id, value, label, source, confidence, timestamp],
            )
            .map_err(|error| format!("failed to store asset tag: {error}"))?;
    }
    let tags_json = serde_json::to_string(
        &tags
            .iter()
            .map(|(value, label)| serde_json::json!({ "value": value, "label": label }))
            .collect::<Vec<_>>(),
    )
    .map_err(|error| format!("failed to encode asset tag revision: {error}"))?;
    transaction
        .execute(
            "INSERT INTO asset_tag_revisions(asset_id, source, tags_json, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![asset_id, source, tags_json, timestamp],
        )
        .map_err(|error| format!("failed to record asset tag revision: {error}"))?;
    append_event(
        &transaction,
        &run_id,
        "asset_tagged",
        &format!(
            "{} {} tag{} were saved as a metadata-only revision.",
            tags.len(),
            source,
            if tags.len() == 1 { "" } else { "s" }
        ),
        Some(1.0),
        Some("asset.tags"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit asset tag revision: {error}"))?;
    get_asset(paths, asset_id)
}

pub(crate) fn get_asset(
    paths: &MediaRuntimePaths,
    asset_id: &str,
) -> MediaResult<MediaAssetRecord> {
    let connection = open(paths)?;
    let mut asset = connection
        .query_row(
            "SELECT id, run_id, blob_digest, kind, mime_type, byte_size, width, height, created_at, output_index, fixture, operation_json FROM assets WHERE id = ?1 AND deleted_at IS NULL",
            params![asset_id],
            map_asset,
        )
        .optional()
        .map_err(|error| format!("failed to read tagged media asset: {error}"))?
        .ok_or_else(|| format!("media asset {asset_id} was not found"))?;
    attach_asset_inputs(&connection, std::slice::from_mut(&mut asset))?;
    attach_asset_tags(&connection, std::slice::from_mut(&mut asset))?;
    Ok(asset)
}

#[derive(Debug, Clone)]
struct DeletionBlobCandidate {
    digest: String,
    relative_path: String,
    byte_size: u64,
    reclaimable: bool,
    available: bool,
}

#[derive(Debug, Clone)]
struct DeletedAssetIdentity {
    run_id: String,
    digest: String,
    kind: String,
    mime_type: String,
}

pub(crate) fn plan_asset_deletion(
    paths: &MediaRuntimePaths,
    asset_id: &str,
) -> MediaResult<MediaAssetDeletionImpact> {
    build_asset_deletion_impact(&open(paths)?, asset_id)
}

fn build_asset_deletion_impact(
    connection: &Connection,
    asset_id: &str,
) -> MediaResult<MediaAssetDeletionImpact> {
    let (digest, original_byte_size) = connection
        .query_row(
            "SELECT a.blob_digest, a.byte_size FROM assets a WHERE a.id = ?1 AND a.deleted_at IS NULL",
            params![asset_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)),
        )
        .optional()
        .map_err(|error| format!("failed to inspect media asset deletion impact: {error}"))?
        .ok_or_else(|| format!("active media asset {asset_id} was not found"))?;
    let mut dependent_asset_ids = query_string_list(
        connection,
        "SELECT ai.asset_id FROM asset_inputs ai JOIN assets a ON a.id = ai.asset_id WHERE ai.input_asset_id = ?1 AND a.deleted_at IS NULL ORDER BY ai.asset_id",
        params![asset_id],
        "asset dependencies",
    )?;
    dependent_asset_ids.dedup();
    let shared_blob_asset_ids = query_string_list(
        connection,
        "SELECT id FROM assets WHERE blob_digest = ?1 AND id <> ?2 AND deleted_at IS NULL ORDER BY id",
        (&digest, asset_id),
        "shared media blobs",
    )?;
    let (export_count, active_export_count) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(CASE WHEN status = 'writing' THEN 1 ELSE 0 END), 0) FROM asset_exports WHERE asset_id = ?1",
            params![asset_id],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?)),
        )
        .map_err(|error| format!("failed to inspect asset export references: {error}"))?;
    let (rendition_count, rendition_byte_size) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(byte_size), 0) FROM asset_renditions WHERE asset_id = ?1",
            params![asset_id],
            |row| Ok((row.get::<_, u32>(0)?, row.get::<_, i64>(1)? as u64)),
        )
        .map_err(|error| format!("failed to inspect asset renditions: {error}"))?;
    let candidates = deletion_blob_candidates(connection, asset_id)?;
    let reclaimable_byte_size = candidates
        .iter()
        .filter(|candidate| candidate.reclaimable)
        .map(|candidate| candidate.byte_size)
        .sum();
    let retained_shared_byte_size = candidates
        .iter()
        .filter(|candidate| candidate.available && !candidate.reclaimable)
        .map(|candidate| candidate.byte_size)
        .sum();
    let mut warnings = Vec::new();
    if !dependent_asset_ids.is_empty() {
        warnings.push(format!(
            "{} active derived asset{} retain lineage to this asset and will show a source tombstone.",
            dependent_asset_ids.len(),
            if dependent_asset_ids.len() == 1 { "" } else { "s" }
        ));
    }
    if export_count > 0 {
        warnings.push(format!(
            "{export_count} export audit record{} and external copied files are not removed.",
            if export_count == 1 { "" } else { "s" }
        ));
    }
    if active_export_count > 0 {
        warnings.push("Deletion is blocked until the active export finishes.".to_string());
    }
    if !shared_blob_asset_ids.is_empty() || retained_shared_byte_size > 0 {
        warnings.push(
            "Content-addressed bytes still referenced by another active asset or rendition will be retained."
                .to_string(),
        );
    }
    if rendition_count > 0 {
        warnings.push(format!(
            "{rendition_count} cached rendition{} will be detached; only unreferenced rendition bytes are reclaimed.",
            if rendition_count == 1 { "" } else { "s" }
        ));
    }
    if candidates.iter().any(|candidate| !candidate.available) {
        warnings.push(
            "At least one cataloged blob is already missing; deletion preserves this integrity fact."
                .to_string(),
        );
    }
    let token_payload = serde_json::json!({
        "assetId": asset_id,
        "digest": digest,
        "dependentAssetIds": dependent_asset_ids,
        "sharedBlobAssetIds": shared_blob_asset_ids,
        "exportCount": export_count,
        "activeExportCount": active_export_count,
        "renditionCount": rendition_count,
        "reclaimableByteSize": reclaimable_byte_size,
        "retainedSharedByteSize": retained_shared_byte_size,
    });
    let confirmation_token = format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(&token_payload)
                .map_err(|error| format!("failed to encode deletion impact: {error}"))?
        )
    );
    Ok(MediaAssetDeletionImpact {
        asset_id: asset_id.to_string(),
        digest,
        dependent_asset_ids,
        shared_blob_asset_ids,
        export_count,
        active_export_count,
        rendition_count,
        original_byte_size,
        rendition_byte_size,
        reclaimable_byte_size,
        retained_shared_byte_size,
        warnings,
        confirmation_token,
    })
}

fn query_string_list<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    params: P,
    label: &str,
) -> MediaResult<Vec<String>> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("failed to prepare {label} query: {error}"))?;
    let values = statement
        .query_map(params, |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query {label}: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode {label}: {error}"))?;
    Ok(values)
}

fn deletion_blob_candidates(
    connection: &Connection,
    asset_id: &str,
) -> MediaResult<Vec<DeletionBlobCandidate>> {
    let mut statement = connection
        .prepare(
            "SELECT b.digest, b.relative_path, b.byte_size, b.available\n\
             FROM blobs b JOIN assets a ON a.blob_digest = b.digest WHERE a.id = ?1\n\
             UNION\n\
             SELECT b.digest, b.relative_path, b.byte_size, b.available\n\
             FROM blobs b JOIN asset_renditions r ON r.blob_digest = b.digest WHERE r.asset_id = ?1",
        )
        .map_err(|error| format!("failed to prepare deletion blob query: {error}"))?;
    let raw = statement
        .query_map(params![asset_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? as u64,
                row.get::<_, bool>(3)?,
            ))
        })
        .map_err(|error| format!("failed to query deletion blobs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode deletion blobs: {error}"))?;
    raw.into_iter()
        .map(|(digest, relative_path, byte_size, available)| {
            let active_asset_references = connection
                .query_row(
                    "SELECT COUNT(*) FROM assets WHERE blob_digest = ?1 AND id <> ?2 AND deleted_at IS NULL",
                    params![digest, asset_id],
                    |row| row.get::<_, u32>(0),
                )
                .map_err(|error| format!("failed to inspect active blob references: {error}"))?;
            let other_rendition_references = connection
                .query_row(
                    "SELECT COUNT(*) FROM asset_renditions WHERE blob_digest = ?1 AND asset_id <> ?2",
                    params![digest, asset_id],
                    |row| row.get::<_, u32>(0),
                )
                .map_err(|error| format!("failed to inspect rendition blob references: {error}"))?;
            Ok(DeletionBlobCandidate {
                digest,
                relative_path,
                byte_size,
                reclaimable: available
                    && active_asset_references == 0
                    && other_rendition_references == 0,
                available,
            })
        })
        .collect()
}

pub(crate) fn delete_asset(
    paths: &MediaRuntimePaths,
    request: &MediaAssetDeletionRequest,
) -> MediaResult<MediaAssetDeletionResult> {
    if !matches!(
        request.mode.as_str(),
        "metadata-only" | "metadata-and-unreferenced-bytes"
    ) {
        return Err("unsupported media asset deletion mode".to_string());
    }
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin media asset deletion: {error}"))?;
    let impact = build_asset_deletion_impact(&transaction, &request.asset_id)?;
    if impact.confirmation_token != request.confirmation_token {
        return Err(
            "asset deletion impact changed; review the refreshed dependencies before confirming"
                .to_string(),
        );
    }
    if impact.active_export_count > 0 {
        return Err("asset deletion is blocked while an export is being written".to_string());
    }
    if !impact.dependent_asset_ids.is_empty() && !request.confirm_dependencies {
        return Err("dependent assets require explicit deletion acknowledgement".to_string());
    }
    let identity = transaction
        .query_row(
            "SELECT run_id, blob_digest, kind, mime_type FROM assets WHERE id = ?1 AND deleted_at IS NULL",
            params![request.asset_id],
            |row| {
                Ok(DeletedAssetIdentity {
                    run_id: row.get(0)?,
                    digest: row.get(1)?,
                    kind: row.get(2)?,
                    mime_type: row.get(3)?,
                })
            },
        )
        .map_err(|error| format!("failed to locate active asset for deletion: {error}"))?;
    let candidates = deletion_blob_candidates(&transaction, &request.asset_id)?;
    let deleted_at = now();
    transaction
        .execute(
            "UPDATE assets SET deleted_at = ?2, deletion_mode = ?3 WHERE id = ?1 AND deleted_at IS NULL",
            params![request.asset_id, deleted_at, request.mode],
        )
        .map_err(|error| format!("failed to tombstone media asset: {error}"))?;
    let initial_status = if request.mode == "metadata-only" {
        "retained"
    } else {
        "pending"
    };
    let retained_bytes = if request.mode == "metadata-only" {
        candidates
            .iter()
            .filter(|candidate| candidate.available)
            .map(|candidate| candidate.byte_size)
            .sum()
    } else {
        candidates
            .iter()
            .filter(|candidate| candidate.available && !candidate.reclaimable)
            .map(|candidate| candidate.byte_size)
            .sum()
    };
    transaction
        .execute(
            "INSERT INTO asset_deletions(asset_id, mode, status, impact_token, retained_bytes, created_at, completed_at)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, CASE WHEN ?3 = 'retained' THEN ?6 ELSE NULL END)",
            params![
                request.asset_id,
                request.mode,
                initial_status,
                request.confirmation_token,
                retained_bytes as i64,
                deleted_at,
            ],
        )
        .map_err(|error| format!("failed to record media asset deletion: {error}"))?;
    let deletion_id = transaction.last_insert_rowid();
    if request.mode == "metadata-and-unreferenced-bytes" {
        transaction
            .execute(
                "DELETE FROM asset_renditions WHERE asset_id = ?1",
                params![request.asset_id],
            )
            .map_err(|error| format!("failed to detach deleted asset renditions: {error}"))?;
        for candidate in candidates.iter().filter(|candidate| candidate.reclaimable) {
            transaction
                .execute(
                    "INSERT INTO blob_gc_queue(deletion_id, digest, relative_path, byte_size, status, created_at)\n\
                     VALUES (?1, ?2, ?3, ?4, 'pending', ?5)",
                    params![
                        deletion_id,
                        candidate.digest,
                        candidate.relative_path,
                        candidate.byte_size as i64,
                        deleted_at,
                    ],
                )
                .map_err(|error| format!("failed to queue unreferenced media blob: {error}"))?;
        }
    }
    append_event(
        &transaction,
        &identity.run_id,
        "asset_deleted",
        "Asset metadata was replaced by a durable tombstone after dependency review.",
        Some(1.0),
        Some("asset.delete"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit media asset tombstone: {error}"))?;

    let (reclaimed_bytes, failed_blob_digests) = process_blob_gc_queue(paths, deletion_id)?;
    let bytes_status = finalize_asset_deletion(
        paths,
        deletion_id,
        &request.mode,
        reclaimed_bytes,
        retained_bytes,
        &failed_blob_digests,
    )?;
    Ok(MediaAssetDeletionResult {
        tombstone: MediaAssetTombstone {
            asset_id: request.asset_id.clone(),
            digest: identity.digest,
            kind: identity.kind,
            mime_type: identity.mime_type,
            deleted_at,
            mode: request.mode.clone(),
            bytes_status,
        },
        reclaimed_bytes,
        retained_bytes,
        failed_blob_digests,
    })
}

fn process_blob_gc_queue(
    paths: &MediaRuntimePaths,
    deletion_id: i64,
) -> MediaResult<(u64, Vec<String>)> {
    let connection = open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT digest, relative_path, byte_size, status, reclaimed_bytes\n\
             FROM blob_gc_queue\n\
             WHERE deletion_id = ?1 AND status IN ('pending', 'deleting')\n\
             ORDER BY digest",
        )
        .map_err(|error| format!("failed to prepare media blob cleanup: {error}"))?;
    let queued = statement
        .query_map(params![deletion_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? as u64,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)? as u64,
            ))
        })
        .map_err(|error| format!("failed to query media blob cleanup: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode media blob cleanup: {error}"))?;
    drop(statement);
    drop(connection);
    for (digest, relative_path, byte_size, status, _recorded_reclaimed_bytes) in queued {
        let path = match safe_blob_path(paths, &relative_path) {
            Ok(path) => path,
            Err(error) => {
                open(paths)?
                    .execute(
                        "UPDATE blob_gc_queue\n\
                         SET status = 'failed', reclaimed_bytes = 0, error = ?3, completed_at = ?4\n\
                         WHERE deletion_id = ?1 AND digest = ?2",
                        params![deletion_id, digest, error, now()],
                    )
                    .map_err(|update_error| {
                        format!("failed to record unsafe media blob cleanup path: {update_error}")
                    })?;
                continue;
            }
        };
        if status == "pending" {
            let expected_reclaimed_bytes = if path.is_file() { byte_size } else { 0 };
            open(paths)?
                .execute(
                    "UPDATE blob_gc_queue\n\
                     SET status = 'deleting', reclaimed_bytes = ?3, error = NULL\n\
                     WHERE deletion_id = ?1 AND digest = ?2 AND status = 'pending'",
                    params![deletion_id, digest, expected_reclaimed_bytes as i64],
                )
                .map_err(|error| format!("failed to begin media blob cleanup: {error}"))?;
        }
        let deletion = fs::remove_file(&path);
        let missing = deletion
            .as_ref()
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
        if deletion.is_ok() || missing {
            let timestamp = now();
            let mut connection = open(paths)?;
            let transaction = connection.transaction().map_err(|error| {
                format!("failed to begin media blob cleanup completion: {error}")
            })?;
            transaction
                .execute(
                    "UPDATE blobs SET available = 0 WHERE digest = ?1",
                    params![digest],
                )
                .map_err(|error| format!("failed to tombstone reclaimed blob: {error}"))?;
            transaction
                .execute(
                    "UPDATE blob_gc_queue\n\
                     SET status = 'completed', completed_at = ?3, error = NULL\n\
                     WHERE deletion_id = ?1 AND digest = ?2",
                    params![deletion_id, digest, timestamp],
                )
                .map_err(|error| format!("failed to complete media blob cleanup: {error}"))?;
            transaction.commit().map_err(|error| {
                format!("failed to commit media blob cleanup completion: {error}")
            })?;
        } else if let Err(error) = deletion {
            open(paths)?
                .execute(
                    "UPDATE blob_gc_queue\n\
                     SET status = 'failed', reclaimed_bytes = 0, error = ?3, completed_at = ?4\n\
                     WHERE deletion_id = ?1 AND digest = ?2",
                    params![deletion_id, digest, error.to_string(), now()],
                )
                .map_err(|update_error| {
                    format!("failed to record media blob cleanup failure: {update_error}")
                })?;
        }
    }
    let connection = open(paths)?;
    let reclaimed_bytes = connection
        .query_row(
            "SELECT COALESCE(SUM(reclaimed_bytes), 0)\n\
             FROM blob_gc_queue\n\
             WHERE deletion_id = ?1 AND status = 'completed'",
            params![deletion_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("failed to total reclaimed media bytes: {error}"))?
        .max(0) as u64;
    let failed_blob_digests = query_string_list(
        &connection,
        "SELECT digest FROM blob_gc_queue WHERE deletion_id = ?1 AND status = 'failed' ORDER BY digest",
        params![deletion_id],
        "failed media blob cleanup",
    )?;
    Ok((reclaimed_bytes, failed_blob_digests))
}

fn finalize_asset_deletion(
    paths: &MediaRuntimePaths,
    deletion_id: i64,
    mode: &str,
    reclaimed_bytes: u64,
    retained_bytes: u64,
    failed_blob_digests: &[String],
) -> MediaResult<String> {
    let status = if mode == "metadata-only" {
        "retained"
    } else if !failed_blob_digests.is_empty() && reclaimed_bytes == 0 {
        "failed"
    } else if !failed_blob_digests.is_empty() || retained_bytes > 0 {
        "partial"
    } else if reclaimed_bytes > 0 {
        "deleted"
    } else {
        "shared"
    };
    let error = (!failed_blob_digests.is_empty()).then(|| {
        format!(
            "Failed to reclaim {} blob(s): {}",
            failed_blob_digests.len(),
            failed_blob_digests.join(", ")
        )
    });
    open(paths)?
        .execute(
            "UPDATE asset_deletions\n\
             SET status = ?2, reclaimed_bytes = ?3, retained_bytes = ?4, error = ?5, completed_at = ?6\n\
             WHERE id = ?1",
            params![
                deletion_id,
                status,
                reclaimed_bytes as i64,
                retained_bytes as i64,
                error,
                now(),
            ],
        )
        .map_err(|error| format!("failed to finalize media asset deletion: {error}"))?;
    Ok(status.to_string())
}

fn recover_pending_blob_gc(paths: &MediaRuntimePaths) -> MediaResult<()> {
    let pending_deletions = {
        let connection = open(paths)?;
        let mut statement = connection
            .prepare(
                "SELECT id, mode, retained_bytes\n\
                 FROM asset_deletions\n\
                 WHERE status = 'pending'\n\
                 ORDER BY id",
            )
            .map_err(|error| {
                format!("failed to prepare pending media deletion recovery: {error}")
            })?;
        let pending = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?.max(0) as u64,
                ))
            })
            .map_err(|error| format!("failed to query pending media deletions: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode pending media deletions: {error}"))?;
        pending
    };
    for (deletion_id, mode, retained_bytes) in pending_deletions {
        let (reclaimed_bytes, failed_blob_digests) = process_blob_gc_queue(paths, deletion_id)?;
        finalize_asset_deletion(
            paths,
            deletion_id,
            &mode,
            reclaimed_bytes,
            retained_bytes,
            &failed_blob_digests,
        )?;
    }
    Ok(())
}

fn safe_blob_path(
    paths: &MediaRuntimePaths,
    relative_path: &str,
) -> MediaResult<std::path::PathBuf> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("stored media blob path is outside the content-addressed root".to_string());
    }
    Ok(paths.blobs.join(relative))
}

pub(crate) fn get_asset_blob_source(
    paths: &MediaRuntimePaths,
    asset_id: &str,
) -> MediaResult<AssetBlobSource> {
    open(paths)?
        .query_row(
            "SELECT b.digest, b.relative_path, b.byte_size, a.mime_type\n\
             FROM assets a JOIN blobs b ON b.digest = a.blob_digest\n\
             WHERE a.id = ?1 AND a.deleted_at IS NULL AND b.available = 1",
            params![asset_id],
            |row| {
                Ok(AssetBlobSource {
                    digest: row.get(0)?,
                    relative_path: row.get(1)?,
                    byte_size: row.get::<_, i64>(2)? as u64,
                    mime_type: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("failed to locate image asset blob: {error}"))?
        .ok_or_else(|| format!("media asset {asset_id} was not found"))
}

pub(crate) fn get_published_image_blob_source(
    paths: &MediaRuntimePaths,
    asset_id: &str,
) -> MediaResult<AssetBlobSource> {
    open(paths)?
        .query_row(
            "SELECT b.digest, b.relative_path, b.byte_size, a.mime_type\n\
             FROM assets a\n\
             JOIN blobs b ON b.digest = a.blob_digest\n\
             JOIN runs r ON r.id = a.run_id\n\
             WHERE a.id = ?1 AND a.deleted_at IS NULL AND b.available = 1\n\
               AND a.kind = 'image'\n\
               AND a.mime_type IN ('image/png', 'image/jpeg', 'image/webp')\n\
               AND (\n\
                 NOT EXISTS (SELECT 1 FROM human_reviews hr WHERE hr.run_id = a.run_id)\n\
                 OR (r.status = 'completed' AND EXISTS (\n\
                   SELECT 1 FROM human_reviews hr\n\
                   JOIN human_review_decisions d ON d.review_id = hr.id\n\
                   JOIN json_each(d.selected_asset_ids_json) selected\n\
                   WHERE hr.run_id = a.run_id AND d.action = 'approve'\n\
                     AND hr.sequence = (SELECT MAX(last_hr.sequence) FROM human_reviews last_hr WHERE last_hr.run_id = a.run_id)\n\
                     AND selected.value = a.id\n\
                 ))\n\
               )",
            params![asset_id],
            |row| {
                Ok(AssetBlobSource {
                    digest: row.get(0)?,
                    relative_path: row.get(1)?,
                    byte_size: row.get::<_, i64>(2)? as u64,
                    mime_type: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("failed to locate published image asset blob: {error}"))?
        .ok_or_else(|| {
            format!(
                "published Media Studio image asset {asset_id} was not found or is no longer available"
            )
        })
}

pub(crate) fn get_asset_rendition_blob_source(
    paths: &MediaRuntimePaths,
    asset_id: &str,
    profile: &str,
) -> MediaResult<Option<AssetBlobSource>> {
    open(paths)?
        .query_row(
            "SELECT b.digest, b.relative_path, b.byte_size, r.mime_type\n\
             FROM asset_renditions r\n\
             JOIN blobs b ON b.digest = r.blob_digest\n\
             JOIN assets a ON a.id = r.asset_id\n\
             WHERE r.asset_id = ?1 AND r.profile = ?2 AND a.deleted_at IS NULL AND b.available = 1",
            params![asset_id, profile],
            |row| {
                Ok(AssetBlobSource {
                    digest: row.get(0)?,
                    relative_path: row.get(1)?,
                    byte_size: row.get::<_, i64>(2)? as u64,
                    mime_type: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("failed to locate cached asset rendition: {error}"))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn record_asset_rendition(
    paths: &MediaRuntimePaths,
    asset_id: &str,
    profile: &str,
    digest: &str,
    relative_path: &str,
    byte_size: u64,
    mime_type: &str,
    width: u32,
    height: u32,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin asset rendition registration: {error}"))?;
    let timestamp = now();
    transaction
        .execute(
            "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![digest, byte_size as i64, mime_type, relative_path, timestamp],
        )
        .map_err(|error| format!("failed to register rendition blob: {error}"))?;
    transaction
        .execute(
            "INSERT INTO asset_renditions(asset_id, profile, blob_digest, mime_type, byte_size, width, height, created_at)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)\n\
             ON CONFLICT(asset_id, profile) DO UPDATE SET\n\
               blob_digest = excluded.blob_digest, mime_type = excluded.mime_type,\n\
               byte_size = excluded.byte_size, width = excluded.width, height = excluded.height,\n\
               created_at = excluded.created_at",
            params![asset_id, profile, digest, mime_type, byte_size as i64, width, height, timestamp],
        )
        .map_err(|error| format!("failed to register asset rendition: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit asset rendition: {error}"))
}

pub(crate) fn begin_asset_export(
    paths: &MediaRuntimePaths,
    asset_id: &str,
    destination_path: &str,
    mode: MediaAssetExportMode,
    source_digest: &str,
    digest: &str,
    byte_size: u64,
) -> MediaResult<MediaAssetExportRecord> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin asset export audit: {error}"))?;
    let asset_exists = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1 AND deleted_at IS NULL)",
            params![asset_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| format!("failed to validate exported asset: {error}"))?;
    if !asset_exists {
        return Err(format!("media asset {asset_id} was not found"));
    }
    let created_at = now();
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let record = MediaAssetExportRecord {
        id: format!("export:{}:{unique}", &digest[..16]),
        asset_id: asset_id.to_string(),
        destination_path: destination_path.to_string(),
        mode,
        source_digest: source_digest.to_string(),
        digest: digest.to_string(),
        byte_size,
        metadata_stripped: mode == MediaAssetExportMode::MetadataStripped,
        created_at,
    };
    transaction
        .execute(
            "INSERT INTO asset_exports(\n\
               id, asset_id, destination_path, mode, source_digest, digest, byte_size,\n\
               metadata_stripped, status, created_at\n\
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'writing', ?9)",
            params![
                record.id,
                record.asset_id,
                record.destination_path,
                record.mode.as_str(),
                record.source_digest,
                record.digest,
                record.byte_size as i64,
                record.metadata_stripped,
                record.created_at,
            ],
        )
        .map_err(|error| format!("failed to create asset export audit record: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit asset export audit record: {error}"))?;
    Ok(record)
}

pub(crate) fn complete_asset_export(
    paths: &MediaRuntimePaths,
    record: &MediaAssetExportRecord,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin asset export completion: {error}"))?;
    let updated = transaction
        .execute(
            "UPDATE asset_exports SET status = 'completed', completed_at = ?2, error = NULL WHERE id = ?1 AND status = 'writing'",
            params![record.id, now()],
        )
        .map_err(|error| format!("failed to complete asset export audit: {error}"))?;
    if updated != 1 {
        return Err("asset export audit record is not writable".to_string());
    }
    let run_id = transaction
        .query_row(
            "SELECT run_id FROM assets WHERE id = ?1",
            params![record.asset_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("failed to locate exported asset run: {error}"))?;
    append_event(
        &transaction,
        &run_id,
        "asset_exported",
        match record.mode {
            MediaAssetExportMode::VerifiedOriginal => {
                "Verified original bytes were copied to a user-selected destination."
            }
            MediaAssetExportMode::MetadataStripped => {
                "A pixel-decoded export was written without embedded container metadata; local provenance remains intact."
            }
        },
        Some(1.0),
        Some("export.verify"),
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit asset export completion: {error}"))
}

pub(crate) fn fail_asset_export(
    paths: &MediaRuntimePaths,
    export_id: &str,
    error_message: &str,
) -> MediaResult<()> {
    open(paths)?
        .execute(
            "UPDATE asset_exports SET status = 'failed', error = ?2 WHERE id = ?1 AND status = 'writing'",
            params![export_id, error_message],
        )
        .map(|_| ())
        .map_err(|error| format!("failed to record asset export failure: {error}"))
}

fn list_events(connection: &Connection, run_id: &str) -> MediaResult<Vec<MediaRunEvent>> {
    let mut statement = connection
        .prepare("SELECT id, run_id, sequence, kind, created_at, message, progress, step_id, node_id FROM run_events WHERE run_id = ?1 ORDER BY sequence ASC")
        .map_err(|error| format!("failed to prepare media event query: {error}"))?;
    let events = statement
        .query_map(params![run_id], |row| {
            Ok(MediaRunEvent {
                id: row.get(0)?,
                run_id: row.get(1)?,
                sequence: row.get(2)?,
                kind: row.get(3)?,
                created_at: row.get(4)?,
                message: row.get(5)?,
                progress: row.get(6)?,
                step_id: row.get(7)?,
                node_id: row.get(8)?,
            })
        })
        .map_err(|error| format!("failed to query media events: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode media events: {error}"))?;
    Ok(events)
}

fn list_node_executions(
    connection: &Connection,
    run_id: &str,
) -> MediaResult<Vec<MediaNodeExecutionRecord>> {
    let mut statement = connection
        .prepare(
            "SELECT run_id, node_id, node_type, node_label, ordinal, status, active_step_id,
                    runtime_phase, attempt, progress, message, started_at, updated_at, finished_at,
                    state_sequence
             FROM node_executions WHERE run_id = ?1 ORDER BY ordinal ASC, node_id ASC",
        )
        .map_err(|error| format!("failed to prepare node execution query: {error}"))?;
    let executions = statement
        .query_map(params![run_id], |row| {
            Ok(MediaNodeExecutionRecord {
                run_id: row.get(0)?,
                node_id: row.get(1)?,
                node_type: row.get(2)?,
                node_label: row.get(3)?,
                ordinal: row.get(4)?,
                status: row.get(5)?,
                active_step_id: row.get(6)?,
                runtime_phase: row.get(7)?,
                attempt: row.get(8)?,
                progress: row.get(9)?,
                message: row.get(10)?,
                started_at: row.get(11)?,
                updated_at: row.get(12)?,
                finished_at: row.get(13)?,
                state_sequence: row.get(14)?,
            })
        })
        .map_err(|error| format!("failed to query node executions: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode node executions: {error}"))?;
    Ok(executions)
}

fn list_provider_jobs_for_run(
    connection: &Connection,
    run_id: &str,
) -> MediaResult<Vec<MediaProviderJobRecord>> {
    let mut statement = connection
        .prepare(
            "SELECT id, run_id, attempt, status, raw_state, scenario, request_digest, idempotency_key,\n\
                    provider_job_id, provider_request_id, estimated_cost_min, estimated_cost_max, currency,\n\
                    poll_attempts, next_poll_at, reconciliation_deadline, accepted_at, retention_expires_at,\n\
                    late_success, review_required, review_reason, error, policy_json, created_at, updated_at, completed_at\n\
             FROM provider_jobs WHERE run_id = ?1 ORDER BY attempt ASC",
        )
        .map_err(|error| format!("failed to prepare provider job query: {error}"))?;
    let jobs = statement
        .query_map(params![run_id], map_provider_job)
        .map_err(|error| format!("failed to query provider jobs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode provider jobs: {error}"))?;
    Ok(jobs)
}

fn list_human_reviews_for_run(
    connection: &Connection,
    run_id: &str,
) -> MediaResult<Vec<MediaHumanReviewRecord>> {
    let mut statement = connection
        .prepare(
            "SELECT hr.id, hr.run_id, hr.node_id, hr.sequence, hr.status, hr.instructions,
                    hr.max_selections, hr.require_comment, hr.candidate_asset_ids_json,
                    hr.created_at, hr.updated_at, hr.decided_at,
                    d.id, d.action, d.selected_asset_ids_json, d.comment, d.actor, d.created_at
             FROM human_reviews hr
             LEFT JOIN human_review_decisions d ON d.review_id = hr.id
             WHERE hr.run_id = ?1 ORDER BY hr.sequence ASC",
        )
        .map_err(|error| format!("failed to prepare human review query: {error}"))?;
    let reviews = statement
        .query_map(params![run_id], |row| {
            let candidate_json = row.get::<_, String>(8)?;
            let candidate_asset_ids = serde_json::from_str::<Vec<String>>(&candidate_json)
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(8, Type::Text, Box::new(error))
                })?;
            let selected_json = row.get::<_, Option<String>>(14)?;
            let selected_asset_ids = selected_json
                .map(|raw| {
                    serde_json::from_str::<Vec<String>>(&raw).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(14, Type::Text, Box::new(error))
                    })
                })
                .transpose()?
                .unwrap_or_default();
            Ok(MediaHumanReviewRecord {
                id: row.get(0)?,
                run_id: row.get(1)?,
                node_id: row.get(2)?,
                sequence: row.get(3)?,
                status: row.get(4)?,
                instructions: row.get(5)?,
                max_selections: row.get(6)?,
                require_comment: row.get(7)?,
                candidate_asset_ids,
                selected_asset_ids,
                decision_id: row.get(12)?,
                decision_action: row.get(13)?,
                comment: row.get(15)?,
                actor: row.get(16)?,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
                decided_at: row.get(11)?,
            })
        })
        .map_err(|error| format!("failed to query human reviews: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode human reviews: {error}"))?;
    Ok(reviews)
}

fn map_provider_job(row: &Row<'_>) -> rusqlite::Result<MediaProviderJobRecord> {
    let raw_policy = row.get::<_, String>(22)?;
    let policy =
        serde_json::from_str::<MediaProviderPolicySnapshot>(&raw_policy).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(22, Type::Text, Box::new(error))
        })?;
    let id = row.get::<_, String>(0)?;
    let run_id = row.get::<_, String>(1)?;
    let error = row.get::<_, Option<String>>(21)?;
    let failure = error.as_ref().map(|diagnostic| {
        MediaError::from_internal("provider_job", diagnostic).with_run_id(&run_id)
    });
    Ok(MediaProviderJobRecord {
        id,
        run_id,
        attempt: row.get(2)?,
        status: row.get(3)?,
        raw_state: row.get(4)?,
        scenario: row.get(5)?,
        request_digest: row.get(6)?,
        idempotency_key: row.get(7)?,
        provider_job_id: row.get(8)?,
        provider_request_id: row.get(9)?,
        estimated_cost_min: row.get(10)?,
        estimated_cost_max: row.get(11)?,
        currency: row.get(12)?,
        poll_attempts: row.get(13)?,
        next_poll_at: row.get(14)?,
        reconciliation_deadline: row.get(15)?,
        accepted_at: row.get(16)?,
        retention_expires_at: row.get(17)?,
        late_success: row.get(18)?,
        review_required: row.get(19)?,
        review_reason: row.get(20)?,
        error,
        failure,
        policy,
        created_at: row.get(23)?,
        updated_at: row.get(24)?,
        completed_at: row.get(25)?,
    })
}

fn list_assets_for_run(
    connection: &Connection,
    run_id: &str,
) -> MediaResult<Vec<MediaAssetRecord>> {
    let mut statement = connection
        .prepare("SELECT id, run_id, blob_digest, kind, mime_type, byte_size, width, height, created_at, output_index, fixture, operation_json FROM assets WHERE run_id = ?1 AND deleted_at IS NULL ORDER BY output_index ASC")
        .map_err(|error| format!("failed to prepare run asset query: {error}"))?;
    let mut assets = statement
        .query_map(params![run_id], map_asset)
        .map_err(|error| format!("failed to query run assets: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode run assets: {error}"))?;
    attach_asset_inputs(connection, &mut assets)?;
    attach_asset_tags(connection, &mut assets)?;
    Ok(assets)
}

fn map_run(row: &Row<'_>) -> rusqlite::Result<MediaRunRecord> {
    let id = row.get::<_, String>(0)?;
    let error = row.get::<_, Option<String>>(15)?;
    let failure = error
        .as_ref()
        .map(|diagnostic| MediaError::from_internal("run_execution", diagnostic).with_run_id(&id));
    Ok(MediaRunRecord {
        id,
        flow_id: row.get(1)?,
        flow_revision_id: row.get(16)?,
        flow_name: row.get(2)?,
        plan_id: row.get(3)?,
        status: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
        prompt: row.get(7)?,
        model_label: row.get(8)?,
        target: row.get(9)?,
        output_count: row.get(10)?,
        diagnostic_count: row.get(11)?,
        progress: row.get(12)?,
        current_step: row.get(13)?,
        executor: row.get(14)?,
        error,
        failure,
    })
}

pub(crate) fn validate_run_flow_revision(
    connection: &Connection,
    flow_id: &str,
    flow_revision_id: Option<&str>,
    plan_snapshot: Option<&crate::media::MediaRunPlanSnapshot>,
) -> MediaResult<()> {
    let Some(flow_revision_id) = flow_revision_id else {
        return Ok(());
    };
    let plan_snapshot = plan_snapshot.ok_or_else(|| {
        "flowRevisionId requires a validated planSnapshot for execution lineage".to_string()
    })?;
    let revision = connection
        .query_row(
            "SELECT flow_id, execution_digest FROM flow_revisions WHERE revision_id = ?1",
            params![flow_revision_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("failed to validate run flow revision: {error}"))?
        .ok_or_else(|| format!("flow revision {flow_revision_id} was not found"))?;
    if revision.0 != flow_id || plan_snapshot.flow_id != flow_id {
        return Err("run flow revision identity does not match the execution plan".to_string());
    }
    if revision.1 != plan_snapshot.flow_fingerprint {
        return Err(
            "run flow revision execution digest does not match the compiled plan".to_string(),
        );
    }
    Ok(())
}

pub(crate) fn validate_existing_run_identity(
    connection: &Connection,
    run_id: &str,
    flow_id: &str,
    flow_revision_id: Option<&str>,
    plan_id: &str,
    executor: &str,
) -> MediaResult<()> {
    let stored = connection
        .query_row(
            "SELECT flow_id, flow_revision_id, plan_id, executor FROM runs WHERE id = ?1",
            params![run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|error| format!("failed to validate existing media run identity: {error}"))?;
    if stored.0 != flow_id
        || stored.1.as_deref() != flow_revision_id
        || stored.2 != plan_id
        || stored.3 != executor
    {
        return Err(
            "run idempotency conflict: runId was reused with different immutable inputs"
                .to_string(),
        );
    }
    Ok(())
}

fn map_asset(row: &Row<'_>) -> rusqlite::Result<MediaAssetRecord> {
    let operation = row
        .get::<_, Option<String>>(11)?
        .map(|raw| {
            serde_json::from_str(&raw).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(11, Type::Text, Box::new(error))
            })
        })
        .transpose()?;
    Ok(MediaAssetRecord {
        id: row.get(0)?,
        run_id: row.get(1)?,
        digest: row.get(2)?,
        kind: row.get(3)?,
        mime_type: row.get(4)?,
        byte_size: row.get::<_, i64>(5)? as u64,
        width: row.get(6)?,
        height: row.get(7)?,
        created_at: row.get(8)?,
        output_index: row.get(9)?,
        fixture: row.get(10)?,
        operation,
        source_asset_ids: Vec::new(),
        tags: Vec::new(),
    })
}

fn attach_asset_inputs(
    connection: &Connection,
    assets: &mut [MediaAssetRecord],
) -> MediaResult<()> {
    if assets.is_empty() {
        return Ok(());
    }
    let indices = assets
        .iter()
        .enumerate()
        .map(|(index, asset)| (asset.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection
        .prepare(
            "SELECT asset_id, input_asset_id FROM asset_inputs
             ORDER BY asset_id, role, input_asset_id",
        )
        .map_err(|error| format!("failed to prepare asset lineage query: {error}"))?;
    let inputs = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("failed to query asset lineage: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode asset lineage: {error}"))?;
    for (asset_id, input_asset_id) in inputs {
        if let Some(index) = indices.get(&asset_id) {
            assets[*index].source_asset_ids.push(input_asset_id);
        }
    }
    Ok(())
}

fn attach_asset_tags(connection: &Connection, assets: &mut [MediaAssetRecord]) -> MediaResult<()> {
    if assets.is_empty() {
        return Ok(());
    }
    let indices = assets
        .iter()
        .enumerate()
        .map(|(index, asset)| (asset.id.clone(), index))
        .collect::<HashMap<_, _>>();
    let mut statement = connection
        .prepare(
            "SELECT asset_id, normalized_tag, display_tag, source, confidence, created_at\n\
             FROM asset_tags ORDER BY normalized_tag, source",
        )
        .map_err(|error| format!("failed to prepare asset tag query: {error}"))?;
    let tags = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                MediaAssetTag {
                    value: row.get(1)?,
                    label: row.get(2)?,
                    source: row.get(3)?,
                    confidence: row.get(4)?,
                    created_at: row.get(5)?,
                },
            ))
        })
        .map_err(|error| format!("failed to query asset tags: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode asset tags: {error}"))?;
    for (asset_id, tag) in tags {
        if let Some(index) = indices.get(&asset_id) {
            assets[*index].tags.push(tag);
        }
    }
    Ok(())
}

fn is_terminal_node_status(status: &str) -> bool {
    matches!(
        status,
        "completed" | "cached" | "skipped" | "failed" | "canceled"
    )
}

fn is_valid_node_transition(from: &str, to: &str) -> bool {
    from == to
        || matches!(
            (from, to),
            (
                "pending",
                "queued"
                    | "running"
                    | "waiting-for-review"
                    | "completed"
                    | "cached"
                    | "skipped"
                    | "failed"
                    | "canceled"
                    | "blocked"
            ) | (
                "queued",
                "pending"
                    | "running"
                    | "retrying"
                    | "completed"
                    | "failed"
                    | "canceled"
                    | "blocked"
            ) | (
                "running",
                "queued"
                    | "waiting-for-review"
                    | "retrying"
                    | "completed"
                    | "cached"
                    | "skipped"
                    | "failed"
                    | "canceled"
                    | "blocked"
            ) | (
                "waiting-for-review",
                "running" | "completed" | "failed" | "canceled" | "blocked"
            ) | (
                "retrying",
                "queued" | "running" | "completed" | "failed" | "canceled" | "blocked"
            ) | (
                "blocked",
                "queued" | "running" | "retrying" | "completed" | "failed" | "canceled"
            )
        )
}

pub(crate) fn seed_node_executions(
    transaction: &Transaction<'_>,
    run_id: &str,
    snapshot: &MediaRunPlanSnapshot,
    initial_status: &str,
) -> MediaResult<()> {
    if !matches!(initial_status, "pending" | "queued" | "completed") {
        return Err(format!(
            "unsupported initial node execution status {initial_status}"
        ));
    }
    let timestamp = now();
    let mut step_bounds = HashMap::<&str, (&str, &str)>::new();
    for step in &snapshot.steps {
        step_bounds
            .entry(step.source_node_id.as_str())
            .and_modify(|bounds| bounds.1 = step.id.as_str())
            .or_insert((step.id.as_str(), step.id.as_str()));
    }
    for (ordinal, node) in snapshot.nodes.iter().enumerate() {
        let (first_step_id, last_step_id) = step_bounds
            .get(node.id.as_str())
            .map(|(first, last)| (Some(*first), Some(*last)))
            .unwrap_or((None, None));
        transaction
            .execute(
                "INSERT OR IGNORE INTO node_executions(
                   run_id, node_id, node_type, node_label, ordinal, status, active_step_id,
                   progress, started_at, updated_at, finished_at, first_step_id, last_step_id
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    run_id,
                    node.id,
                    node.r#type,
                    node.label,
                    ordinal as u32,
                    initial_status,
                    if initial_status == "completed" {
                        last_step_id
                    } else {
                        None
                    },
                    if initial_status == "completed" {
                        Some(1.0)
                    } else {
                        None
                    },
                    if initial_status == "completed" {
                        Some(timestamp.as_str())
                    } else {
                        None
                    },
                    timestamp,
                    if initial_status == "completed" {
                        Some(timestamp.as_str())
                    } else {
                        None
                    },
                    first_step_id,
                    last_step_id,
                ],
            )
            .map_err(|error| format!("failed to seed node execution {}: {error}", node.id))?;
    }
    Ok(())
}

fn canonical_step_for_node(
    transaction: &Transaction<'_>,
    run_id: &str,
    node_id: &str,
    completed: bool,
) -> MediaResult<Option<String>> {
    let raw_snapshot = transaction
        .query_row(
            "SELECT plan_snapshot_json FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|error| format!("failed to read node execution plan: {error}"))?;
    let Some(raw_snapshot) = raw_snapshot else {
        return Ok(None);
    };
    let snapshot = serde_json::from_str::<MediaRunPlanSnapshot>(&raw_snapshot)
        .map_err(|error| format!("failed to decode node execution plan: {error}"))?;
    let mut steps = snapshot
        .steps
        .iter()
        .filter(|step| step.source_node_id == node_id);
    Ok(if completed {
        steps.next_back().map(|step| step.id.clone())
    } else {
        steps.next().map(|step| step.id.clone())
    })
}

fn transition_node_execution_in_transaction(
    transaction: &Transaction<'_>,
    run_id: &str,
    node_id: &str,
    status: &str,
    runtime_phase: Option<&str>,
    message: Option<&str>,
    progress: Option<f64>,
) -> MediaResult<bool> {
    let current = transaction
        .query_row(
            "SELECT status, node_label, first_step_id, last_step_id
             FROM node_executions WHERE run_id = ?1 AND node_id = ?2",
            params![run_id, node_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect node execution {node_id}: {error}"))?
        .ok_or_else(|| format!("node execution {node_id} was not found for run {run_id}"))?;
    if current.0 == status && message.is_none() && progress.is_none() {
        return Ok(false);
    }
    if !is_valid_node_transition(&current.0, status) {
        return Err(format!(
            "invalid node execution transition for {node_id}: {} -> {status}",
            current.0
        ));
    }
    let timestamp = now();
    let terminal = is_terminal_node_status(status);
    let canonical_step = if terminal {
        current.3.clone().or_else(|| current.2.clone())
    } else {
        current.2.clone()
    };
    let canonical_step = match canonical_step {
        Some(step_id) => Some(step_id),
        None => canonical_step_for_node(transaction, run_id, node_id, terminal)?,
    };
    let normalized_progress = progress.map(|value| value.clamp(0.0, 1.0));
    let event_message = message.unwrap_or(&current.1);
    transaction
        .execute(
            "UPDATE node_executions SET
               status = ?3,
               active_step_id = ?4,
               runtime_phase = ?5,
               attempt = attempt + CASE WHEN ?3 = 'running' AND status != 'running' THEN 1 ELSE 0 END,
               progress = COALESCE(?6, progress),
               message = COALESCE(?7, message),
               started_at = CASE
                 WHEN ?3 IN ('running', 'waiting-for-review', 'retrying') THEN COALESCE(started_at, ?8)
                 ELSE started_at
               END,
               updated_at = ?8,
               finished_at = CASE WHEN ?9 THEN ?8 ELSE NULL END,
               state_sequence = state_sequence + 1
             WHERE run_id = ?1 AND node_id = ?2",
            params![
                run_id,
                node_id,
                status,
                canonical_step,
                runtime_phase,
                normalized_progress,
                message,
                timestamp,
                terminal,
            ],
        )
        .map_err(|error| format!("failed to transition node execution {node_id}: {error}"))?;
    transaction
        .execute(
            "UPDATE runs SET current_step = ?2, progress = COALESCE(?3, progress), updated_at = ?4
             WHERE id = ?1 AND status NOT IN ('completed', 'failed', 'canceled')",
            params![run_id, event_message, normalized_progress, timestamp],
        )
        .map_err(|error| format!("failed to project node execution onto run: {error}"))?;
    append_event_scoped(
        transaction,
        run_id,
        "node_state_changed",
        event_message,
        normalized_progress,
        canonical_step.as_deref(),
        Some(node_id),
    )?;
    Ok(true)
}

pub(crate) fn transition_node_execution(
    paths: &MediaRuntimePaths,
    run_id: &str,
    node_id: &str,
    status: &str,
    runtime_phase: Option<&str>,
    message: Option<&str>,
    progress: Option<f64>,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin node execution transition: {error}"))?;
    transition_node_execution_in_transaction(
        &transaction,
        run_id,
        node_id,
        status,
        runtime_phase,
        message,
        progress,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit node execution transition: {error}"))
}

pub(crate) fn transition_nodes_by_type(
    paths: &MediaRuntimePaths,
    run_id: &str,
    node_types: &[&str],
    status: &str,
    runtime_phase: Option<&str>,
    message: Option<&str>,
    progress: Option<f64>,
) -> MediaResult<()> {
    let wanted = node_types.iter().copied().collect::<HashSet<_>>();
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin typed node execution transition: {error}"))?;
    let node_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT node_id, node_type FROM node_executions WHERE run_id = ?1 ORDER BY ordinal",
            )
            .map_err(|error| format!("failed to prepare typed node execution query: {error}"))?;
        let executions = statement
            .query_map(params![run_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("failed to query typed node executions: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode typed node executions: {error}"))?;
        executions
    };
    for (node_id, node_type) in node_ids {
        if wanted.contains(node_type.as_str()) {
            transition_node_execution_in_transaction(
                &transaction,
                run_id,
                &node_id,
                status,
                runtime_phase,
                message,
                progress,
            )?;
        }
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit typed node execution transition: {error}"))
}

fn finalize_node_executions(
    transaction: &Transaction<'_>,
    run_id: &str,
    terminal_status: &str,
) -> MediaResult<()> {
    let node_ids = {
        let mut statement = transaction
            .prepare(
                "SELECT node_id, status FROM node_executions WHERE run_id = ?1 ORDER BY ordinal",
            )
            .map_err(|error| format!("failed to prepare terminal node execution query: {error}"))?;
        let executions = statement
            .query_map(params![run_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| format!("failed to query terminal node executions: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode terminal node executions: {error}"))?;
        executions
    };
    for (node_id, status) in node_ids {
        let target = match terminal_status {
            "completed" if !is_terminal_node_status(&status) => Some("completed"),
            "failed"
                if matches!(
                    status.as_str(),
                    "running" | "retrying" | "waiting-for-review" | "blocked"
                ) =>
            {
                Some("failed")
            }
            "canceled"
                if matches!(
                    status.as_str(),
                    "queued" | "running" | "retrying" | "waiting-for-review" | "blocked"
                ) =>
            {
                Some("canceled")
            }
            _ => None,
        };
        if let Some(target) = target {
            transition_node_execution_in_transaction(
                transaction,
                run_id,
                &node_id,
                target,
                Some("run.finalize"),
                None,
                if target == "completed" {
                    Some(1.0)
                } else {
                    None
                },
            )?;
        }
    }
    Ok(())
}

fn append_event(
    transaction: &Transaction<'_>,
    run_id: &str,
    kind: &str,
    message: &str,
    progress: Option<f64>,
    step_id: Option<&str>,
) -> MediaResult<()> {
    append_event_scoped(transaction, run_id, kind, message, progress, step_id, None)
}

fn append_event_scoped(
    transaction: &Transaction<'_>,
    run_id: &str,
    kind: &str,
    message: &str,
    progress: Option<f64>,
    step_id: Option<&str>,
    node_id: Option<&str>,
) -> MediaResult<()> {
    let sequence = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_events WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|error| format!("failed to allocate media event sequence: {error}"))?;
    transaction
        .execute(
            "INSERT INTO run_events(run_id, sequence, kind, created_at, message, progress, step_id, node_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![run_id, sequence, kind, now(), message, progress, step_id, node_id],
        )
        .map_err(|error| format!("failed to append media run event: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn test_paths(label: &str) -> MediaRuntimePaths {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-media-{label}-{}-{unique}",
            std::process::id()
        ));
        MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        }
    }

    fn request(run_id: &str) -> EnqueueFixtureRunRequest {
        EnqueueFixtureRunRequest {
            run_id: run_id.to_string(),
            flow_id: "flow-1".to_string(),
            flow_revision_id: None,
            flow_name: "Fixture".to_string(),
            plan_id: "plan-1".to_string(),
            prompt: "A deterministic fixture".to_string(),
            model_label: "Fixture executor".to_string(),
            target: Some("local".to_string()),
            output_count: 1,
            diagnostic_count: 0,
            aspect_ratio: "1:1".to_string(),
            plan_snapshot: None,
        }
    }

    fn plan_snapshot() -> crate::media::MediaRunPlanSnapshot {
        crate::media::MediaRunPlanSnapshot {
            schema_version: 1,
            plan_id: "plan-1".to_string(),
            flow_id: "flow-1".to_string(),
            flow_fingerprint: "sha256:test-flow".to_string(),
            compiled_at: "2026-07-14T00:00:00.000Z".to_string(),
            nodes: vec![crate::media::MediaRunPlanNodeSnapshot {
                id: "node:prompt".to_string(),
                r#type: "source.prompt".to_string(),
                label: "Prompt".to_string(),
                layer: "source".to_string(),
            }],
            steps: vec![crate::media::MediaRunPlanStepSnapshot {
                id: "step:normalize".to_string(),
                source_node_id: "node:prompt".to_string(),
                kind: "normalize-prompt".to_string(),
                label: "Normalize prompt".to_string(),
                target: "orchestrator".to_string(),
                cacheable: true,
                side_effect: None,
                review: None,
            }],
        }
    }

    fn openai_request(run_id: &str) -> GenerateMediaImagesRequest {
        GenerateMediaImagesRequest {
            schema_version: 1,
            run_id: run_id.to_string(),
            flow_id: "flow-1".to_string(),
            flow_revision_id: "revision:openai-test".to_string(),
            flow_name: "OpenAI fixture".to_string(),
            plan_id: "plan-1".to_string(),
            prompt: "A durable provider request".to_string(),
            model_id: "openai:gpt-image-2".to_string(),
            model_label: "GPT Image 2".to_string(),
            output_count: 1,
            diagnostic_count: 0,
            aspect_ratio: "1:1".to_string(),
            output_format: "png".to_string(),
            model_policy: "balanced".to_string(),
            model_addons: Vec::new(),
            transparent_background: false,
            subject_cutout_model_priority: Vec::new(),
            plan_snapshot: plan_snapshot(),
        }
    }

    fn svg_request(run_id: &str) -> GenerateMediaSvgRequest {
        GenerateMediaSvgRequest {
            schema_version: 1,
            run_id: run_id.to_string(),
            flow_id: "flow-1".to_string(),
            flow_revision_id: "revision:svg-test".to_string(),
            flow_name: "SVG fixture".to_string(),
            plan_id: "plan-1".to_string(),
            prompt: "A durable SVG repair request".to_string(),
            model_id: "quiver:arrow-1.1-max".to_string(),
            model_label: "Arrow 1.1 Max".to_string(),
            output_count: 1,
            candidate_count: 1,
            diagnostic_count: 0,
            aspect_ratio: "1:1".to_string(),
            model_policy: "quality".to_string(),
            transparent_background: false,
            mode: "generate".to_string(),
            auto_crop: true,
            target_size: 1_024,
            style: "illustration".to_string(),
            text_policy: "avoid".to_string(),
            critic_enabled: true,
            reference_images: Vec::new(),
            allow_remote_upload: false,
            plan_snapshot: plan_snapshot(),
        }
    }

    fn openai_edit_request(run_id: &str) -> crate::media::ExecuteRemoteImageEditFlowRequest {
        crate::media::ExecuteRemoteImageEditFlowRequest {
            schema_version: 1,
            run_id: run_id.to_string(),
            flow_id: "flow-1".to_string(),
            flow_revision_id: "revision:openai-test".to_string(),
            plan_id: "plan-1".to_string(),
            plan_snapshot: plan_snapshot(),
            allow_remote_upload: true,
        }
    }

    fn openai_edit_plan() -> crate::media::flow::RemoteImageEditFlowPlan {
        crate::media::flow::RemoteImageEditFlowPlan {
            flow_id: "flow-1".to_string(),
            flow_name: "Remote edit".to_string(),
            revision_id: "revision:openai-test".to_string(),
            prompt: "Preserve the base and apply the style reference".to_string(),
            provider_prompt:
                "Preserve the base and apply the style reference\n\nOrdered references".to_string(),
            task_node_id: "edit".to_string(),
            model_id: "openai:gpt-image-2".to_string(),
            model_label: "GPT Image 2".to_string(),
            output_count: 1,
            aspect_ratio: "1:1".to_string(),
            output_format: "png".to_string(),
            model_policy: "balanced".to_string(),
            transparent_background: false,
            subject_cutout_model_priority: Vec::new(),
            edit_strength: 0.65,
            sources: vec![crate::media::flow::RemoteImageEditSource {
                node_id: "base".to_string(),
                asset_id: "asset:source-run:0".to_string(),
                role: "base".to_string(),
                influence: 1.0,
                source_digest: "a".repeat(64),
                upload_digest: "b".repeat(64),
                upload_byte_size: 17,
                upload_bytes: vec![0; 17],
                width: 64,
                height: 64,
            }],
            upload_bytes: 17,
        }
    }

    fn insert_openai_test_revision(paths: &MediaRuntimePaths) {
        let timestamp = now();
        let mut connection = open(paths).unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "INSERT INTO flows(
                   id, name, description, head_revision_id, head_revision_number, created_at,
                   updated_at, document_digest, execution_digest, layout_digest
                 ) VALUES ('flow-1', 'Test', '', 'revision:openai-test', 1, ?1, ?1,
                   'document', ?2, 'layout')",
                params![timestamp, plan_snapshot().flow_fingerprint],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO flow_revisions(
                   revision_id, flow_id, revision_number, parent_revision_id, created_at,
                   change_summary, document_digest, execution_digest, layout_digest,
                   node_count, edge_count, flow_json, layout_json, artifact_relative_path
                 ) VALUES (?1, 'flow-1', 1, NULL, ?2, 'Test', 'document', ?3, 'layout',
                   1, 0, '{}', '{}', 'test/openai.json')",
                params![
                    "revision:openai-test",
                    timestamp,
                    plan_snapshot().flow_fingerprint
                ],
            )
            .unwrap();
        transaction.commit().unwrap();
    }

    fn cleanup(paths: &MediaRuntimePaths) {
        if let Some(root) = paths.database.parent() {
            let _ = fs::remove_dir_all(root);
        }
    }

    fn record_fixture_asset(
        paths: &MediaRuntimePaths,
        run_id: &str,
        digest: &str,
        relative_path: &str,
        bytes: u64,
        dimensions: (u32, u32),
    ) {
        record_asset(
            paths,
            &FixtureAssetRecord {
                run_id,
                digest,
                relative_path,
                bytes,
                width: dimensions.0,
                height: dimensions.1,
                output_index: 0,
                output_count: 1,
            },
        )
        .unwrap();
    }

    #[test]
    fn migration_and_enqueue_are_idempotent() {
        let paths = test_paths("enqueue");
        initialize(&paths).unwrap();
        initialize(&paths).unwrap();
        enqueue_fixture_run(&paths, &request("run-1")).unwrap();
        enqueue_fixture_run(&paths, &request("run-1")).unwrap();

        let mut conflicting = request("run-1");
        conflicting.plan_id = "plan-conflict".to_string();
        assert!(enqueue_fixture_run(&paths, &conflicting)
            .unwrap_err()
            .contains("run idempotency conflict"));

        let detail = get_run_detail(&paths, "run-1").unwrap();
        assert_eq!(detail.run.status, "queued");
        assert_eq!(detail.events.len(), 1);
        cleanup(&paths);
    }

    #[test]
    fn svg_critic_requests_are_durably_audited_without_retry() {
        let paths = test_paths("svg-critic-audit");
        initialize(&paths).unwrap();
        enqueue_fixture_run(&paths, &request("run:svg-critic")).unwrap();
        claim_fixture_run(&paths, "run:svg-critic").unwrap();
        let request = svg_request("run:svg-critic");

        let completed_job = begin_svg_critic_attempt(
            &paths,
            &request,
            0,
            "repair",
            "gpt-5.6",
            &"a".repeat(64),
            4_096,
        )
        .unwrap();
        complete_svg_critic_attempt(&paths, &completed_job, Some("resp_svg_repair"), true, None)
            .unwrap();
        let verified_job = begin_svg_critic_attempt(
            &paths,
            &request,
            0,
            "verify",
            "gpt-5.6",
            &"b".repeat(64),
            8_192,
        )
        .unwrap();
        complete_svg_critic_attempt(&paths, &verified_job, Some("resp_svg_verify"), true, None)
            .unwrap();
        let uncertain_job = begin_svg_critic_attempt(
            &paths,
            &request,
            1,
            "repair",
            "gpt-5.6",
            &"c".repeat(64),
            8_192,
        )
        .unwrap();
        fail_svg_critic_attempt(
            &paths,
            &uncertain_job,
            "connection closed after submission",
            true,
            None,
        )
        .unwrap();

        let detail = get_run_detail(&paths, "run:svg-critic").unwrap();
        assert_eq!(detail.provider_jobs.len(), 3);
        assert_eq!(detail.provider_jobs[0].status, "completed");
        assert!(detail.provider_jobs[0].policy.no_store_requested);
        assert_eq!(detail.provider_jobs[1].status, "completed");
        assert_eq!(detail.provider_jobs[1].policy.upload_asset_count, 2);
        assert_eq!(detail.provider_jobs[2].status, "acceptance-unknown");
        assert!(detail.provider_jobs[2].review_required);
        assert!(detail.provider_jobs[2]
            .policy
            .retry_policy
            .contains("never retried"));
        cleanup(&paths);
    }

    #[test]
    fn persists_canonical_node_execution_state_and_scoped_events() {
        let paths = test_paths("node-executions");
        initialize(&paths).unwrap();
        let mut tracked = request("run:nodes");
        tracked.plan_snapshot = Some(plan_snapshot());
        enqueue_fixture_run(&paths, &tracked).unwrap();

        let queued = get_run_detail(&paths, &tracked.run_id).unwrap();
        assert_eq!(queued.node_executions.len(), 1);
        assert_eq!(queued.node_executions[0].node_id, "node:prompt");
        assert_eq!(queued.node_executions[0].status, "pending");

        transition_node_execution(
            &paths,
            &tracked.run_id,
            "node:prompt",
            "running",
            Some("fixture.normalize"),
            Some("Normalizing prompt"),
            Some(0.1),
        )
        .unwrap();
        let running = get_run_detail(&paths, &tracked.run_id).unwrap();
        assert_eq!(running.node_executions[0].status, "running");
        assert_eq!(
            running.node_executions[0].active_step_id.as_deref(),
            Some("step:normalize")
        );
        assert_eq!(
            running.node_executions[0].runtime_phase.as_deref(),
            Some("fixture.normalize")
        );
        assert!(running.events.iter().any(|event| {
            event.kind == "node_state_changed"
                && event.node_id.as_deref() == Some("node:prompt")
                && event.step_id.as_deref() == Some("step:normalize")
        }));
        cleanup(&paths);
    }

    #[test]
    fn direct_openai_requests_quarantine_unknown_acceptance_and_block_duplicates() {
        let paths = test_paths("openai-provider-guard");
        initialize(&paths).unwrap();
        insert_openai_test_revision(&paths);

        let first = openai_request("run:openai:1");
        assert!(begin_remote_image_generation(&paths, &first).unwrap());
        let submitting = get_run_detail(&paths, &first.run_id).unwrap();
        assert_eq!(submitting.provider_jobs.len(), 1);
        assert_eq!(submitting.provider_jobs[0].status, "submitting");
        assert_eq!(submitting.provider_jobs[0].policy.idempotency_mode, "none");

        fail_remote_image_generation(
            &paths,
            &first.run_id,
            "transport ended after submission",
            true,
            Some("req_openai_1"),
        )
        .unwrap();
        let uncertain = get_run_detail(&paths, &first.run_id).unwrap();
        assert_eq!(uncertain.run.status, "needs-review");
        assert_eq!(uncertain.provider_jobs[0].status, "acceptance-unknown");
        assert!(uncertain.provider_jobs[0].review_required);
        assert_eq!(
            uncertain.provider_jobs[0].provider_request_id.as_deref(),
            Some("req_openai_1")
        );

        let second = openai_request("run:openai:2");
        assert!(begin_remote_image_generation(&paths, &second)
            .unwrap_err()
            .contains("may already have been accepted and charged"));
        resolve_openai_provider_review(
            &paths,
            &uncertain.provider_jobs[0].id,
            "confirm-not-accepted-and-retry",
        )
        .unwrap();
        assert!(begin_remote_image_generation(&paths, &second).unwrap());
        fail_remote_image_generation(
            &paths,
            &second.run_id,
            "provider rejected the request",
            false,
            Some("req_openai_2"),
        )
        .unwrap();
        let rejected = get_run_detail(&paths, &second.run_id).unwrap();
        assert_eq!(rejected.run.status, "failed");
        assert_eq!(rejected.provider_jobs[0].status, "failed");
        assert!(!rejected.provider_jobs[0].review_required);
        cleanup(&paths);
    }

    #[test]
    fn direct_openai_review_can_accept_duplicate_charge_risk_before_a_new_run() {
        let paths = test_paths("openai-provider-risk-override");
        initialize(&paths).unwrap();
        insert_openai_test_revision(&paths);

        let first = openai_request("run:openai:risk:1");
        assert!(begin_remote_image_generation(&paths, &first).unwrap());
        fail_remote_image_generation(
            &paths,
            &first.run_id,
            "transport ended after submission",
            true,
            None,
        )
        .unwrap();

        let uncertain = get_run_detail(&paths, &first.run_id).unwrap();
        resolve_openai_provider_review(
            &paths,
            &uncertain.provider_jobs[0].id,
            "accept-duplicate-charge-risk-and-retry",
        )
        .unwrap();

        let reviewed = get_run_detail(&paths, &first.run_id).unwrap();
        assert_eq!(reviewed.run.status, "failed");
        assert_eq!(
            reviewed.provider_jobs[0].raw_state.as_deref(),
            Some("operator-accepted-duplicate-charge-risk")
        );
        assert!(!reviewed.provider_jobs[0].review_required);
        assert!(reviewed.events.iter().any(|event| {
            event.kind == "provider_review_closed"
                && event.message.contains("may create a duplicate charge")
        }));

        let second = openai_request("run:openai:risk:2");
        assert!(begin_remote_image_generation(&paths, &second).unwrap());
        cleanup(&paths);
    }

    #[test]
    fn direct_openai_completion_honors_the_pinned_human_review_contract() {
        let paths = test_paths("openai-human-review");
        initialize(&paths).unwrap();
        insert_openai_test_revision(&paths);

        let immediate = openai_request("run:openai:immediate");
        begin_remote_image_generation(&paths, &immediate).unwrap();
        let immediate_batch = GeneratedImageBatch {
            assets: vec![provider_openai::GeneratedImageAsset {
                digest: "a".repeat(64),
                relative_path: "aa/immediate.png".to_string(),
                byte_size: 256,
                mime_type: "image/png",
                width: 1_024,
                height: 1_024,
                output_index: 0,
                subject_cutout: None,
            }],
            provider_request_id: Some("req_openai_immediate".to_string()),
        };
        let completed =
            complete_remote_image_generation(&paths, &immediate, &immediate_batch).unwrap();
        assert_eq!(completed.run.status, "completed");

        let mut reviewed = openai_request("run:openai:reviewed");
        reviewed.output_count = 3;
        reviewed
            .plan_snapshot
            .nodes
            .push(crate::media::MediaRunPlanNodeSnapshot {
                id: "node:review".to_string(),
                r#type: "control.human-review".to_string(),
                label: "Choose final images".to_string(),
                layer: "control".to_string(),
            });
        reviewed
            .plan_snapshot
            .steps
            .push(crate::media::MediaRunPlanStepSnapshot {
                id: "step:review".to_string(),
                source_node_id: "node:review".to_string(),
                kind: "wait-for-review".to_string(),
                label: "Choose final images".to_string(),
                target: "orchestrator".to_string(),
                cacheable: false,
                side_effect: None,
                review: Some(crate::media::MediaHumanReviewContract {
                    instructions: "Choose the strongest candidate for publication.".to_string(),
                    max_selections: 1,
                    require_comment: false,
                }),
            });
        begin_remote_image_generation(&paths, &reviewed).unwrap();
        let reviewed_batch = GeneratedImageBatch {
            assets: (0..3)
                .map(|output_index| provider_openai::GeneratedImageAsset {
                    digest: format!("{}", output_index + 2).repeat(64),
                    relative_path: format!("review/candidate-{output_index}.png"),
                    byte_size: 256,
                    mime_type: "image/png",
                    width: 1_024,
                    height: 1_024,
                    output_index,
                    subject_cutout: None,
                })
                .collect(),
            provider_request_id: Some("req_openai_reviewed".to_string()),
        };
        let waiting = complete_remote_image_generation(&paths, &reviewed, &reviewed_batch).unwrap();
        assert_eq!(waiting.run.status, "waiting-for-review");
        assert_eq!(waiting.assets.len(), 3);
        assert_eq!(waiting.human_reviews.len(), 1);
        assert_eq!(waiting.human_reviews[0].candidate_asset_ids.len(), 3);
        assert_eq!(waiting.human_reviews[0].max_selections, 1);
        assert_eq!(list_assets(&paths, 100).unwrap().len(), 1);

        let decision = MediaHumanReviewDecisionRequest {
            review_id: waiting.human_reviews[0].id.clone(),
            decision_id: "decision:openai:reviewed".to_string(),
            action: "approve".to_string(),
            selected_asset_ids: vec![waiting.human_reviews[0].candidate_asset_ids[1].clone()],
            comment: String::new(),
        };
        resolve_human_review(&paths, &decision).unwrap();
        assert_eq!(
            get_run_detail(&paths, &reviewed.run_id).unwrap().run.status,
            "completed"
        );
        let published = list_assets(&paths, 100).unwrap();
        assert_eq!(published.len(), 2);
        assert!(published
            .iter()
            .any(|asset| asset.id == decision.selected_asset_ids[0]));
        cleanup(&paths);
    }

    #[test]
    fn local_diffusers_completion_persists_reproducible_addon_provenance() {
        let paths = test_paths("local-diffusers-provenance");
        initialize(&paths).unwrap();
        insert_openai_test_revision(&paths);

        let mut request = openai_request("run:local-diffusers");
        request.model_id = "local:user:model-digest".to_string();
        request.model_label = "Community XL".to_string();
        request.model_addons = vec![crate::media::MediaModelAddonSelection::Lora {
            addon_id: "addon:lora-digest".to_string(),
            enabled: true,
            model_strength: 0.8,
            text_encoder_strength: Some(0.5),
            denoising_schedule: None,
        }];
        assert!(begin_local_diffusers_generation(&paths, &request).unwrap());
        let batch = LocalGeneratedImageBatch {
            assets: vec![provider_openai::GeneratedImageAsset {
                digest: "d".repeat(64),
                relative_path: "dd/local.png".to_string(),
                byte_size: 512,
                mime_type: "image/png",
                width: 1_024,
                height: 1_024,
                output_index: 0,
                subject_cutout: None,
            }],
            provenance: crate::media::provider_local_diffusers::LocalDiffusersProvenance {
                worker_version: "media-diffusers-worker/1.0.0".to_string(),
                packages: HashMap::from([("diffusers".to_string(), Some("0.39.0".to_string()))]),
                device: "cuda".to_string(),
                device_label: "Test GPU".to_string(),
                device_memory_bytes: Some(24 * 1_024_u64.pow(3)),
                model_revision: "model-revision".to_string(),
                model_digest: "m".repeat(64),
                prompt: request.prompt.clone(),
                negative_prompt: String::new(),
                addons: vec![serde_json::json!({
                    "kind": "lora",
                    "addonId": "addon:lora-digest",
                    "digest": "a".repeat(64),
                    "modelStrength": 0.8,
                    "textEncoderStrength": 0.5,
                    "adapterName": "machdoch_aaaaaaaaaaaaaaaa"
                })],
                outputs: vec![
                    crate::media::provider_local_diffusers::LocalDiffusersOutputProvenance {
                        index: 0,
                        seed: 42,
                    },
                ],
            },
        };
        let detail = complete_local_diffusers_generation(&paths, &request, &batch).unwrap();
        assert_eq!(detail.run.status, "completed");
        assert!(detail.provider_jobs.is_empty());
        let operation = detail.assets[0]
            .operation
            .as_ref()
            .expect("local image provenance should exist");
        assert_eq!(operation["kind"], "local-diffusion-generation");
        assert_eq!(operation["modelRevision"], "model-revision");
        assert_eq!(operation["workerVersion"], "media-diffusers-worker/1.0.0");
        assert_eq!(
            operation["addons"][0]["adapterName"],
            "machdoch_aaaaaaaaaaaaaaaa"
        );
        assert_eq!(operation["output"]["seed"], 42);
        cleanup(&paths);
    }

    #[test]
    fn startup_recovery_never_resubmits_an_interrupted_openai_request() {
        let paths = test_paths("openai-recovery-guard");
        initialize(&paths).unwrap();
        insert_openai_test_revision(&paths);
        let request = openai_request("run:openai:recovery");
        begin_remote_image_generation(&paths, &request).unwrap();

        let recovery = initialize(&paths).unwrap();
        let detail = get_run_detail(&paths, &request.run_id).unwrap();
        assert_eq!(recovery.recovered_runs, 1);
        assert_eq!(detail.run.status, "needs-review");
        assert_eq!(detail.provider_jobs[0].status, "acceptance-unknown");
        assert!(detail.provider_jobs[0].review_required);
        assert!(detail
            .events
            .iter()
            .any(|event| event.kind == "provider_acceptance_unknown"));
        cleanup(&paths);
    }

    #[test]
    fn remote_edits_audit_uploads_and_quarantine_matching_unknown_acceptance() {
        let paths = test_paths("openai-edit-provider-guard");
        initialize(&paths).unwrap();
        insert_openai_test_revision(&paths);
        let plan = openai_edit_plan();
        let first = openai_edit_request("run:openai-edit:1");
        assert!(begin_remote_image_edit(&paths, &first, &plan).unwrap());
        let submitting = get_run_detail(&paths, &first.run_id).unwrap();
        assert_eq!(submitting.provider_jobs[0].policy.upload_asset_count, 1);
        assert_eq!(submitting.provider_jobs[0].policy.upload_bytes, 17);
        assert!(submitting.events.iter().any(|event| {
            event.kind == "provider_prepared" && event.message.contains("17 bytes")
        }));

        fail_remote_image_generation(
            &paths,
            &first.run_id,
            "response ended after upload",
            true,
            Some("req_edit_1"),
        )
        .unwrap();
        let second = openai_edit_request("run:openai-edit:2");
        assert!(begin_remote_image_edit(&paths, &second, &plan)
            .unwrap_err()
            .contains("may already have been accepted and charged"));

        let mut different_upload = plan.clone();
        different_upload.sources[0].upload_digest = "c".repeat(64);
        let different = openai_edit_request("run:openai-edit:3");
        assert!(begin_remote_image_edit(&paths, &different, &different_upload).unwrap());
        cleanup(&paths);
    }

    #[test]
    fn remote_edit_completion_publishes_exact_role_lineage_and_upload_provenance() {
        let paths = test_paths("openai-edit-lineage");
        initialize(&paths).unwrap();
        insert_openai_test_revision(&paths);
        enqueue_fixture_run(&paths, &request("source-run")).unwrap();
        record_fixture_asset(
            &paths,
            "source-run",
            &"a".repeat(64),
            "aa/source.png",
            128,
            (64, 64),
        );
        let request = openai_edit_request("run:openai-edit:lineage");
        let plan = openai_edit_plan();
        begin_remote_image_edit(&paths, &request, &plan).unwrap();
        let batch = GeneratedImageBatch {
            assets: vec![provider_openai::GeneratedImageAsset {
                digest: "e".repeat(64),
                relative_path: "ee/output.png".to_string(),
                byte_size: 256,
                mime_type: "image/png",
                width: 128,
                height: 128,
                output_index: 0,
                subject_cutout: None,
            }],
            provider_request_id: Some("req_edit_lineage".to_string()),
        };
        let detail = complete_remote_image_edit(&paths, &request, &plan, &batch).unwrap();
        assert_eq!(detail.run.status, "completed");
        assert_eq!(
            detail.assets[0].source_asset_ids,
            vec!["asset:source-run:0".to_string()]
        );
        let operation = detail.assets[0].operation.as_ref().unwrap();
        assert_eq!(operation["kind"], "remote-image-edit");
        assert_eq!(operation["modelSnapshot"], "gpt-image-2-2026-04-21");
        assert_eq!(operation["sources"][0]["role"], "base");
        assert_eq!(operation["sources"][0]["uploadBytes"], 17);
        assert_eq!(operation["metadataStrippedBeforeUpload"], true);
        cleanup(&paths);
    }

    #[test]
    fn export_privacy_migration_backfills_existing_audit_rows() {
        let paths = test_paths("export-privacy-migration");
        fs::create_dir_all(paths.database.parent().unwrap()).unwrap();
        let connection = Connection::open(&paths.database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
                 INSERT INTO schema_migrations(version, applied_at) VALUES (12, '2026-01-01T00:00:00Z');
                 CREATE TABLE runs (id TEXT PRIMARY KEY);
                 CREATE TABLE run_events (id INTEGER PRIMARY KEY AUTOINCREMENT);
                 CREATE TABLE media_models (id TEXT PRIMARY KEY);
                 CREATE TABLE asset_exports (
                   id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, destination_path TEXT NOT NULL,
                   digest TEXT NOT NULL, byte_size INTEGER NOT NULL, status TEXT NOT NULL,
                   created_at TEXT NOT NULL, completed_at TEXT, error TEXT
                 );
                 INSERT INTO asset_exports(
                   id, asset_id, destination_path, digest, byte_size, status, created_at
                 ) VALUES (
                   'export:legacy', 'asset:legacy', 'C:/legacy.png',
                   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                   128, 'completed', '2026-01-01T00:00:00Z'
                 );",
            )
            .unwrap();
        drop(connection);

        ensure_initialized(&paths).unwrap();

        let connection = open(&paths).unwrap();
        let migrated: (String, String, bool) = connection
            .query_row(
                "SELECT mode, source_digest, metadata_stripped FROM asset_exports WHERE id = 'export:legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(migrated.0, "verified-original");
        assert_eq!(
            migrated.1,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert!(!migrated.2);
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master
                     WHERE type = 'table' AND name = 'media_model_runtime_probes'",
                    [],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| row
                    .get::<_, u32>(
                    0
                ),)
                .unwrap(),
            SCHEMA_VERSION
        );
        drop(connection);
        cleanup(&paths);
    }

    #[test]
    fn run_plan_snapshot_round_trips_without_mutating_run_identity() {
        let paths = test_paths("run-plan");
        initialize(&paths).unwrap();
        let mut request = request("run-plan");
        request.plan_snapshot = Some(plan_snapshot());
        enqueue_fixture_run(&paths, &request).unwrap();

        let detail = get_run_detail(&paths, "run-plan").unwrap();
        let snapshot = detail.plan_snapshot.unwrap();
        assert_eq!(snapshot.plan_id, detail.run.plan_id);
        assert_eq!(snapshot.nodes.len(), 1);
        assert_eq!(snapshot.steps[0].source_node_id, snapshot.nodes[0].id);
        cleanup(&paths);
    }

    #[test]
    fn human_review_waits_without_a_lease_and_commits_an_idempotent_decision() {
        let paths = test_paths("human-review");
        initialize(&paths).unwrap();
        let mut request = request("run-human-review");
        request.output_count = 2;
        let mut snapshot = plan_snapshot();
        snapshot.nodes.push(crate::media::MediaRunPlanNodeSnapshot {
            id: "node:review".to_string(),
            r#type: "control.human-review".to_string(),
            label: "Human review".to_string(),
            layer: "control".to_string(),
        });
        snapshot.steps.push(crate::media::MediaRunPlanStepSnapshot {
            id: "step:review".to_string(),
            source_node_id: "node:review".to_string(),
            kind: "wait-for-review".to_string(),
            label: "Pause for review".to_string(),
            target: "orchestrator".to_string(),
            cacheable: false,
            side_effect: None,
            review: Some(crate::media::MediaHumanReviewContract {
                instructions: "Select the strongest candidate.".to_string(),
                max_selections: 1,
                require_comment: true,
            }),
        });
        request.plan_snapshot = Some(snapshot);
        enqueue_fixture_run(&paths, &request).unwrap();
        crate::media::executor::execute_fixture_run(&paths, &request.run_id).unwrap();

        let waiting = get_run_detail(&paths, &request.run_id).unwrap();
        assert_eq!(waiting.run.status, "waiting-for-review");
        assert_eq!(waiting.assets.len(), 2);
        assert_eq!(waiting.human_reviews.len(), 1);
        assert_eq!(waiting.human_reviews[0].status, "pending");
        assert_eq!(waiting.human_reviews[0].candidate_asset_ids.len(), 2);
        assert!(list_assets(&paths, 100).unwrap().is_empty());
        for candidate_id in &waiting.human_reviews[0].candidate_asset_ids {
            assert!(get_published_image_blob_source(&paths, candidate_id)
                .unwrap_err()
                .contains("was not found or is no longer available"));
        }
        assert_eq!(
            open(&paths)
                .unwrap()
                .query_row(
                    "SELECT COUNT(*) FROM resource_leases WHERE owner_run_id = ?1",
                    params![request.run_id],
                    |row| row.get::<_, u32>(0),
                )
                .unwrap(),
            0
        );

        initialize(&paths).unwrap();
        assert_eq!(
            get_run_detail(&paths, &request.run_id).unwrap().run.status,
            "waiting-for-review"
        );
        let review = &waiting.human_reviews[0];
        let decision = MediaHumanReviewDecisionRequest {
            review_id: review.id.clone(),
            decision_id: "decision:human-review:1".to_string(),
            action: "approve".to_string(),
            selected_asset_ids: vec![review.candidate_asset_ids[0].clone()],
            comment: "Clean silhouette and strongest material detail.".to_string(),
        };
        assert_eq!(
            resolve_human_review(&paths, &decision).unwrap(),
            request.run_id
        );
        let completed = get_run_detail(&paths, &request.run_id).unwrap();
        assert_eq!(completed.run.status, "completed");
        assert_eq!(completed.human_reviews[0].status, "approved");
        assert_eq!(list_assets(&paths, 100).unwrap().len(), 1);
        assert!(get_published_image_blob_source(&paths, &decision.selected_asset_ids[0]).is_ok());
        assert!(get_published_image_blob_source(
            &paths,
            &waiting.human_reviews[0].candidate_asset_ids[1]
        )
        .is_err());
        assert_eq!(
            completed.human_reviews[0].decision_id.as_deref(),
            Some("decision:human-review:1")
        );
        let event_count = completed.events.len();

        assert_eq!(
            resolve_human_review(&paths, &decision).unwrap(),
            request.run_id
        );
        assert_eq!(
            get_run_detail(&paths, &request.run_id)
                .unwrap()
                .events
                .len(),
            event_count
        );
        let mut conflicting = decision;
        conflicting.comment = "Different immutable decision inputs.".to_string();
        assert!(resolve_human_review(&paths, &conflicting)
            .unwrap_err()
            .contains("idempotency conflict"));
        cleanup(&paths);
    }

    #[test]
    fn catalog_sync_is_idempotent_and_overlays_configuration_and_installation_state() {
        let paths = test_paths("catalog");
        initialize(&paths).unwrap();
        initialize(&paths).unwrap();

        let configured = HashSet::from(["openai".to_string()]);
        let initial = get_model_catalog(&paths, &configured).unwrap();
        assert_eq!(initial.schema_version, 1);
        assert_eq!(initial.catalog_revision, catalog::CATALOG_REVISION);
        assert_eq!(initial.providers.len(), 7);
        assert_eq!(initial.models.len(), 11);
        assert!(
            initial
                .models
                .iter()
                .find(|model| model.id == "openai:gpt-image-2")
                .unwrap()
                .configured
        );
        let flux = initial
            .models
            .iter()
            .find(|model| model.id == "local:flux-2-klein-4b")
            .unwrap();
        assert!(!flux.installed);
        assert_eq!(flux.installation_status, "not-installed");

        let timestamp = now();
        open(&paths)
            .unwrap()
            .execute(
                "INSERT INTO media_model_installations(\n\
                   model_id, revision, status, manifest_digest, bytes_on_disk, installed_at, verified_at, updated_at\n\
                 ) VALUES (?1, ?2, 'installed', ?3, 1024, ?4, ?4, ?4)",
                params![
                    "local:flux-2-klein-4b",
                    "flux-test-revision",
                    "sha256:catalog-fixture",
                    timestamp,
                ],
            )
            .unwrap();

        let installed = get_model_catalog(&paths, &HashSet::new()).unwrap();
        let flux = installed
            .models
            .iter()
            .find(|model| model.id == "local:flux-2-klein-4b")
            .unwrap();
        assert!(flux.installed);
        assert_eq!(flux.installation_status, "installed");
        assert_eq!(
            flux.installed_revision.as_deref(),
            Some("flux-test-revision")
        );
        let lifecycle_snapshots = open(&paths)
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM media_model_lifecycle_snapshots",
                [],
                |row| row.get::<_, u32>(0),
            )
            .unwrap();
        assert_eq!(lifecycle_snapshots, initial.models.len() as u32);
        cleanup(&paths);
    }

    #[test]
    fn startup_requeues_interrupted_work() {
        let paths = test_paths("recovery");
        initialize(&paths).unwrap();
        enqueue_fixture_run(&paths, &request("run-2")).unwrap();
        let connection = open(&paths).unwrap();
        connection
            .execute("UPDATE runs SET status = 'running' WHERE id = 'run-2'", [])
            .unwrap();
        connection
            .execute(
                "UPDATE jobs SET status = 'running' WHERE run_id = 'run-2'",
                [],
            )
            .unwrap();
        drop(connection);

        let recovery = initialize(&paths).unwrap();
        let detail = get_run_detail(&paths, "run-2").unwrap();
        assert_eq!(recovery.recovered_runs, 1);
        assert_eq!(detail.run.status, "queued");
        assert!(detail
            .events
            .iter()
            .any(|event| event.kind == "run_recovered"));
        cleanup(&paths);
    }

    #[test]
    fn tags_are_revisioned_without_rewriting_asset_identity() {
        let paths = test_paths("tags");
        initialize(&paths).unwrap();
        enqueue_fixture_run(&paths, &request("run-tags")).unwrap();
        record_fixture_asset(
            &paths,
            "run-tags",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "aa/test.png",
            128,
            (1_024, 1_024),
        );

        let original = list_assets(&paths, 10).unwrap().remove(0);
        let manually_tagged = set_user_asset_tags(
            &paths,
            &original.id,
            &[("hero-image".to_string(), "Hero Image".to_string())],
        )
        .unwrap();
        let auto_tagged = auto_tag_asset(&paths, &original.id).unwrap();

        assert_eq!(manually_tagged.digest, original.digest);
        assert!(auto_tagged
            .tags
            .iter()
            .any(|tag| tag.value == "hero-image" && tag.source == "user"));
        assert!(auto_tagged
            .tags
            .iter()
            .any(|tag| tag.value == "square" && tag.source == "technical"));
        let connection = open(&paths).unwrap();
        let revisions = connection
            .query_row(
                "SELECT COUNT(*) FROM asset_tag_revisions WHERE asset_id = ?1",
                params![original.id],
                |row| row.get::<_, u32>(0),
            )
            .unwrap();
        assert_eq!(revisions, 2);
        drop(connection);
        cleanup(&paths);
    }

    #[test]
    fn deletion_requires_dependency_review_and_preserves_lineage_tombstone() {
        let paths = test_paths("delete-dependency");
        initialize(&paths).unwrap();
        enqueue_fixture_run(&paths, &request("run-source")).unwrap();
        enqueue_fixture_run(&paths, &request("run-dependent")).unwrap();
        record_fixture_asset(
            &paths,
            "run-source",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "bb/source.png",
            64,
            (640, 640),
        );
        record_fixture_asset(
            &paths,
            "run-dependent",
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
            "cc/dependent.png",
            96,
            (640, 640),
        );
        let source_id = "asset:run-source:0";
        let dependent_id = "asset:run-dependent:0";
        open(&paths)
            .unwrap()
            .execute(
                "INSERT INTO asset_inputs(asset_id, input_asset_id, role) VALUES (?1, ?2, 'source')",
                params![dependent_id, source_id],
            )
            .unwrap();

        let impact = plan_asset_deletion(&paths, source_id).unwrap();
        assert_eq!(impact.dependent_asset_ids, vec![dependent_id]);
        let unconfirmed = MediaAssetDeletionRequest {
            asset_id: source_id.to_string(),
            mode: "metadata-only".to_string(),
            confirmation_token: impact.confirmation_token.clone(),
            confirm_dependencies: false,
        };
        assert!(delete_asset(&paths, &unconfirmed)
            .unwrap_err()
            .contains("explicit deletion acknowledgement"));

        let confirmed = MediaAssetDeletionRequest {
            confirm_dependencies: true,
            ..unconfirmed
        };
        let result = delete_asset(&paths, &confirmed).unwrap();
        assert_eq!(result.tombstone.bytes_status, "retained");
        assert!(list_assets(&paths, 10)
            .unwrap()
            .iter()
            .all(|asset| asset.id != source_id));
        let dependent = get_run_detail(&paths, "run-dependent").unwrap();
        assert_eq!(dependent.assets[0].source_asset_ids, vec![source_id]);
        assert!(get_asset_blob_source(&paths, source_id).is_err());
        cleanup(&paths);
    }

    #[test]
    fn byte_deletion_reclaims_only_unreferenced_cas_blob() {
        let paths = test_paths("delete-bytes");
        initialize(&paths).unwrap();
        enqueue_fixture_run(&paths, &request("run-delete-bytes")).unwrap();
        let relative_path = "dd/original.png";
        let blob_path = paths.blobs.join(relative_path);
        fs::create_dir_all(blob_path.parent().unwrap()).unwrap();
        fs::write(&blob_path, vec![7_u8; 128]).unwrap();
        record_fixture_asset(
            &paths,
            "run-delete-bytes",
            "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
            relative_path,
            128,
            (512, 512),
        );
        let asset_id = "asset:run-delete-bytes:0";
        let impact = plan_asset_deletion(&paths, asset_id).unwrap();
        assert_eq!(impact.reclaimable_byte_size, 128);

        let result = delete_asset(
            &paths,
            &MediaAssetDeletionRequest {
                asset_id: asset_id.to_string(),
                mode: "metadata-and-unreferenced-bytes".to_string(),
                confirmation_token: impact.confirmation_token,
                confirm_dependencies: false,
            },
        )
        .unwrap();

        assert_eq!(result.reclaimed_bytes, 128);
        assert_eq!(result.retained_bytes, 0);
        assert_eq!(result.tombstone.bytes_status, "deleted");
        assert!(!blob_path.exists());
        let available = open(&paths)
            .unwrap()
            .query_row(
                "SELECT available FROM blobs WHERE digest = ?1",
                params![result.tombstone.digest],
                |row| row.get::<_, bool>(0),
            )
            .unwrap();
        assert!(!available);
        cleanup(&paths);
    }

    #[test]
    fn startup_finishes_journaled_blob_cleanup() {
        let paths = test_paths("delete-recovery");
        initialize(&paths).unwrap();
        enqueue_fixture_run(&paths, &request("run-delete-recovery")).unwrap();
        let relative_path = "ee/recover.png";
        let blob_path = paths.blobs.join(relative_path);
        fs::create_dir_all(blob_path.parent().unwrap()).unwrap();
        fs::write(&blob_path, vec![9_u8; 80]).unwrap();
        let digest = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        record_fixture_asset(
            &paths,
            "run-delete-recovery",
            digest,
            relative_path,
            80,
            (320, 320),
        );
        let asset_id = "asset:run-delete-recovery:0";
        let timestamp = now();
        let mut connection = open(&paths).unwrap();
        let transaction = connection.transaction().unwrap();
        transaction
            .execute(
                "UPDATE assets SET deleted_at = ?2, deletion_mode = 'metadata-and-unreferenced-bytes' WHERE id = ?1",
                params![asset_id, timestamp],
            )
            .unwrap();
        transaction
            .execute(
                "INSERT INTO asset_deletions(asset_id, mode, status, impact_token, retained_bytes, created_at)\n\
                 VALUES (?1, 'metadata-and-unreferenced-bytes', 'pending', 'recovery-test', 0, ?2)",
                params![asset_id, timestamp],
            )
            .unwrap();
        let deletion_id = transaction.last_insert_rowid();
        transaction
            .execute(
                "INSERT INTO blob_gc_queue(\n\
                   deletion_id, digest, relative_path, byte_size, status, reclaimed_bytes, created_at\n\
                 ) VALUES (?1, ?2, ?3, 80, 'deleting', 80, ?4)",
                params![deletion_id, digest, relative_path, timestamp],
            )
            .unwrap();
        transaction.commit().unwrap();

        initialize(&paths).unwrap();

        assert!(!blob_path.exists());
        let deletion = open(&paths)
            .unwrap()
            .query_row(
                "SELECT status, reclaimed_bytes, completed_at IS NOT NULL\n\
                 FROM asset_deletions WHERE id = ?1",
                params![deletion_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, bool>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(deletion, ("deleted".to_string(), 80_i64, true));
        cleanup(&paths);
    }
}
