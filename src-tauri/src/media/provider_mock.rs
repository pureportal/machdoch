use std::{path::Path, thread, time::Duration};

use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension as _, Transaction};
use sha2::{Digest as _, Sha256};

use super::{
    database, executor, EnqueueMockRemoteRunRequest, MediaProviderPolicySnapshot, MediaResult,
    MediaRuntimePaths, ResolveProviderReviewRequest,
};

const ADAPTER_ID: &str = "mock.remote-image";
const ADAPTER_VERSION: &str = "1.0.0";
const ENDPOINT_VERSION: &str = "fixture-2026-07-14";
const POLL_DELAY_MS: u64 = 160;

pub(crate) fn enqueue(
    paths: &MediaRuntimePaths,
    request: &EnqueueMockRemoteRunRequest,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin mock provider enqueue: {error}"))?;
    let timestamp = database::now();
    let plan_snapshot_json = request
        .plan_snapshot
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("failed to serialize provider run plan snapshot: {error}"))?;
    database::validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        request.flow_revision_id.as_deref(),
        request.plan_snapshot.as_ref(),
    )?;
    let inserted = transaction
        .execute(
            "INSERT OR IGNORE INTO runs(\n\
               id, flow_id, flow_name, plan_id, status, created_at, updated_at, prompt, model_label, target,\n\
               output_count, diagnostic_count, progress, current_step, executor, aspect_ratio, plan_snapshot_json, flow_revision_id\n\
             ) VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?5, ?6, ?7, 'remote', ?8, ?9, 0.01,\n\
               'Provider request prepared', 'mock-remote-provider', ?10, ?11, ?12)",
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
        .map_err(|error| format!("failed to enqueue mock provider run: {error}"))?;

    if inserted == 1 {
        transaction
            .execute(
                "INSERT INTO jobs(id, run_id, status) VALUES (?1, ?2, 'queued')",
                params![format!("job:{}", request.run_id), request.run_id],
            )
            .map_err(|error| format!("failed to enqueue mock provider job: {error}"))?;
        if let Some(snapshot) = request.plan_snapshot.as_ref() {
            database::seed_node_executions(&transaction, &request.run_id, snapshot, "pending")?;
        }
        insert_provider_attempt(&transaction, request, 1, &timestamp)?;
        append_event(
            &transaction,
            &request.run_id,
            "provider_prepared",
            "A redacted provider request, cost range, retention policy, and idempotency decision were durably recorded before submission.",
            Some(0.01),
            "provider.prepare",
        )?;
    } else {
        database::validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            request.flow_revision_id.as_deref(),
            &request.plan_id,
            "mock-remote-provider",
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit mock provider enqueue: {error}"))
}

fn insert_provider_attempt(
    transaction: &Transaction<'_>,
    request: &EnqueueMockRemoteRunRequest,
    attempt: u32,
    timestamp: &str,
) -> MediaResult<String> {
    let job_id = format!("provider:{}:{attempt}", request.run_id);
    let request_digest = format!(
        "{:x}",
        Sha256::digest(
            format!(
                "machdoch-mock-provider-v1\0{}\0{}\0{}\0{}",
                request.prompt, request.aspect_ratio, request.output_count, attempt
            )
            .as_bytes()
        )
    );
    let idempotency_key = format!("media-{}-{attempt}", &request_digest[..24]);
    let policy = MediaProviderPolicySnapshot {
        adapter_id: ADAPTER_ID.to_string(),
        adapter_version: ADAPTER_VERSION.to_string(),
        endpoint_version: ENDPOINT_VERSION.to_string(),
        region: "fixture-local".to_string(),
        idempotency_mode: "provider-key".to_string(),
        retry_policy: "No resubmission after possible acceptance; reconcile by idempotency key first. Polls use a persisted minimum interval and bounded deadline.".to_string(),
        cancellation_semantics: "Best effort. A late provider success is still ingested and visibly flagged.".to_string(),
        input_retention_seconds: Some(0),
        output_retention_seconds: Some(3_600),
        output_visibility: "private-signed-url".to_string(),
        public_links: false,
        no_store_requested: true,
        upload_asset_count: 0,
        upload_bytes: 0,
        contains_personal_data: false,
        remote_upload_allowed: request.allow_remote_upload,
    };
    let policy_json = serde_json::to_string(&policy)
        .map_err(|error| format!("failed to serialize provider policy snapshot: {error}"))?;
    let deadline =
        (Utc::now() + chrono::Duration::minutes(10)).to_rfc3339_opts(SecondsFormat::Millis, true);
    transaction
        .execute(
            "INSERT INTO provider_jobs(\n\
               id, run_id, attempt, status, scenario, request_digest, idempotency_key,\n\
               estimated_cost_min, estimated_cost_max, currency, reconciliation_deadline, policy_json,\n\
               created_at, updated_at\n\
             ) VALUES (?1, ?2, ?3, 'prepared', ?4, ?5, ?6, 0.02, 0.04, 'USD', ?7, ?8, ?9, ?9)",
            params![
                job_id,
                request.run_id,
                attempt,
                request.scenario,
                request_digest,
                idempotency_key,
                deadline,
                policy_json,
                timestamp,
            ],
        )
        .map_err(|error| format!("failed to prepare provider attempt: {error}"))?;
    Ok(job_id)
}

pub(crate) fn recover_interrupted(paths: &MediaRuntimePaths) -> MediaResult<Vec<String>> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider recovery: {error}"))?;
    let timestamp = database::now();
    let submitting = collect_ids(
        &transaction,
        "SELECT id FROM provider_jobs WHERE status = 'submitting'",
    )?;
    for job_id in submitting {
        let run_id = transaction
            .query_row(
                "SELECT run_id FROM provider_jobs WHERE id = ?1",
                params![job_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| format!("failed to locate submitting provider run: {error}"))?;
        transaction
            .execute(
                "UPDATE provider_jobs SET status = 'acceptance-unknown', review_required = 1,\n\
                   review_reason = 'The process stopped after submission began and before acceptance was durably confirmed.',\n\
                   next_poll_at = NULL, updated_at = ?2 WHERE id = ?1",
                params![job_id, timestamp],
            )
            .map_err(|error| format!("failed to quarantine uncertain provider submission: {error}"))?;
        transaction
            .execute(
                "UPDATE runs SET status = 'needs-review', current_step = 'Provider acceptance requires review', updated_at = ?2 WHERE id = ?1",
                params![run_id, timestamp],
            )
            .map_err(|error| format!("failed to mark provider review state: {error}"))?;
        append_event(
            &transaction,
            &run_id,
            "provider_acceptance_unknown",
            "Startup recovery found an incomplete submission commit. Automatic resubmission is blocked to prevent duplicate charges.",
            None,
            "provider.recover",
        )?;
    }
    transaction
        .execute(
            "UPDATE provider_jobs SET status = 'succeeded-download-pending', next_poll_at = ?1, updated_at = ?1\n\
             WHERE status = 'downloading'",
            params![timestamp],
        )
        .map_err(|error| format!("failed to recover provider downloads: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider recovery: {error}"))?;
    list_resumable_run_ids(paths)
}

pub(crate) fn list_resumable_run_ids(paths: &MediaRuntimePaths) -> MediaResult<Vec<String>> {
    let connection = database::open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT DISTINCT run_id FROM provider_jobs\n\
             WHERE status IN ('prepared', 'accepted', 'queued', 'running', 'succeeded-download-pending', 'downloading', 'cancel-requested')\n\
             ORDER BY created_at ASC",
        )
        .map_err(|error| format!("failed to prepare resumable provider query: {error}"))?;
    let run_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query resumable provider jobs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode resumable provider jobs: {error}"))?;
    Ok(run_ids)
}

pub(crate) fn is_provider_run(paths: &MediaRuntimePaths, run_id: &str) -> MediaResult<bool> {
    database::open(paths)?
        .query_row(
            "SELECT executor = 'mock-remote-provider' FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
        .map(|value| value.unwrap_or(false))
        .map_err(|error| format!("failed to inspect provider run executor: {error}"))
}

pub(crate) fn execute(paths: &MediaRuntimePaths, run_id: &str) -> MediaResult<()> {
    for _ in 0..32 {
        let state = current_state(paths, run_id)?;
        let Some((job_id, status, raw_state, scenario, phase_cursor, cancel_requested)) = state
        else {
            return Ok(());
        };
        if scenario == "crash-before-submit"
            && status == "prepared"
            && raw_state.as_deref() != Some("injected-crash-before-submit")
        {
            inject_interruption(
                paths,
                run_id,
                &job_id,
                "injected-crash-before-submit",
                "Injected process stop before any provider submission. The prepared request remains safe to resume.",
            )?;
            return Ok(());
        }
        match status.as_str() {
            "prepared" => begin_submission(paths, run_id, &job_id)?,
            "submitting" => {
                if matches!(
                    scenario.as_str(),
                    "crash-during-submit" | "crash-after-acceptance"
                ) && !matches!(
                    raw_state.as_deref(),
                    Some("injected-crash-during-submit" | "provider-may-have-accepted")
                ) {
                    let (marker, message) = if scenario == "crash-after-acceptance" {
                        (
                            "provider-may-have-accepted",
                            "Injected process stop after simulated paid acceptance but before the acceptance commit.",
                        )
                    } else {
                        (
                            "injected-crash-during-submit",
                            "Injected process stop while submission outcome was unresolved.",
                        )
                    };
                    inject_interruption(paths, run_id, &job_id, marker, message)?;
                    return Ok(());
                }
                finish_submission(paths, run_id, &job_id, &scenario)?;
            }
            "accepted" => schedule_poll(paths, run_id, &job_id, "queued", "queued")?,
            "queued" => {
                wait_until_due(paths, &job_id)?;
                schedule_poll(paths, run_id, &job_id, "running", "processing")?;
            }
            "running" | "cancel-requested" => {
                wait_until_due(paths, &job_id)?;
                if scenario == "crash-during-poll"
                    && raw_state.as_deref() != Some("injected-crash-during-poll")
                {
                    inject_interruption(
                        paths,
                        run_id,
                        &job_id,
                        "injected-crash-during-poll",
                        "Injected process stop after a durable poll schedule. Recovery may reconcile without resubmission.",
                    )?;
                    return Ok(());
                } else if cancel_requested && scenario != "cancel-race-success" {
                    finish_cancelled(paths, run_id, &job_id)?;
                } else if scenario == "provider-failure" {
                    finish_failed(
                        paths,
                        run_id,
                        &job_id,
                        "Mock provider rejected the prepared request.",
                    )?;
                } else if scenario == "result-expired" {
                    finish_expired(paths, run_id, &job_id)?;
                } else {
                    mark_output_pending(
                        paths,
                        run_id,
                        &job_id,
                        cancel_requested || status == "cancel-requested",
                    )?;
                    if scenario == "crash-after-success" {
                        return Ok(());
                    }
                }
            }
            "succeeded-download-pending" => begin_download(
                paths,
                run_id,
                &job_id,
                raw_state.as_deref() == Some("injected-crash-during-download"),
            )?,
            "downloading" => {
                if scenario == "crash-during-download"
                    && raw_state.as_deref() != Some("injected-crash-during-download")
                {
                    inject_interruption(
                        paths,
                        run_id,
                        &job_id,
                        "injected-crash-during-download",
                        "Injected process stop during bounded result download. Recovery restarts idempotent CAS ingestion.",
                    )?;
                    return Ok(());
                }
                ingest_outputs(paths, run_id, &job_id, phase_cursor)?;
                finish_completed(paths, run_id, &job_id)?;
            }
            _ => return Ok(()),
        }
        thread::sleep(Duration::from_millis(60));
    }
    Err(format!(
        "provider run {run_id} exceeded its bounded transition budget"
    ))
}

type CurrentState = (String, String, Option<String>, String, u32, bool);

fn current_state(paths: &MediaRuntimePaths, run_id: &str) -> MediaResult<Option<CurrentState>> {
    database::open(paths)?
        .query_row(
            "SELECT p.id, p.status, p.raw_state, p.scenario, p.phase_cursor, r.cancel_requested\n\
             FROM provider_jobs p JOIN runs r ON r.id = p.run_id\n\
             WHERE p.run_id = ?1 ORDER BY p.attempt DESC LIMIT 1",
            params![run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect provider state: {error}"))
}

fn begin_submission(paths: &MediaRuntimePaths, run_id: &str, job_id: &str) -> MediaResult<()> {
    database::transition_nodes_by_type(
        paths,
        run_id,
        &["source.prompt", "source.image"],
        "completed",
        Some("provider.resolve-inputs"),
        Some("Provider inputs resolved"),
        Some(0.05),
    )?;
    database::transition_nodes_by_type(
        paths,
        run_id,
        &["task.generate-image", "task.edit-image"],
        "running",
        Some("provider.submit"),
        Some("Submitting prepared provider request"),
        Some(0.08),
    )?;
    transition(
        paths,
        run_id,
        job_id,
        "submitting",
        "submitting",
        0.08,
        "Submitting prepared provider request",
        "provider_submission_started",
        "The prepared request was sent exactly once with its persisted idempotency key.",
        "provider.submit",
        None,
    )
}

fn finish_submission(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    scenario: &str,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider acceptance: {error}"))?;
    let timestamp = database::now();
    if scenario == "acceptance-unknown" {
        transaction
            .execute(
                "UPDATE provider_jobs SET status = 'acceptance-unknown', raw_state = 'transport-disconnected',\n\
                   review_required = 1, review_reason = 'The mock transport disconnected after the provider may have accepted and charged the request.',\n\
                   next_poll_at = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'submitting'",
                params![job_id, timestamp],
            )
            .map_err(|error| format!("failed to persist uncertain acceptance: {error}"))?;
        transaction
            .execute(
                "UPDATE runs SET status = 'needs-review', progress = 0.12, current_step = 'Provider acceptance requires review', updated_at = ?2 WHERE id = ?1",
                params![run_id, timestamp],
            )
            .map_err(|error| format!("failed to update uncertain provider run: {error}"))?;
        observe(
            &transaction,
            job_id,
            "acceptance-unknown",
            "transport-disconnected",
            "submit",
            None,
        )?;
        append_event(
            &transaction,
            run_id,
            "provider_acceptance_unknown",
            "The connection ended after possible paid acceptance. Automatic resubmission is blocked; reconcile by idempotency key or explicitly confirm non-acceptance.",
            Some(0.12),
            "provider.acceptance",
        )?;
    } else {
        let provider_job_id = format!("mock-job-{}", &job_id.replace(':', "-"));
        let provider_request_id = format!("mock-request-{}", &job_id.replace(':', "-"));
        let retention_expires_at =
            (Utc::now() + chrono::Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
        transaction
            .execute(
                "UPDATE provider_jobs SET status = 'accepted', raw_state = 'accepted', provider_job_id = ?2,\n\
                   provider_request_id = ?3, accepted_at = ?4, retention_expires_at = ?5,\n\
                   next_poll_at = ?4, updated_at = ?4 WHERE id = ?1 AND status = 'submitting'",
                params![job_id, provider_job_id, provider_request_id, timestamp, retention_expires_at],
            )
            .map_err(|error| format!("failed to persist provider acceptance: {error}"))?;
        transaction
            .execute(
                "UPDATE runs SET status = 'running', progress = 0.18, current_step = 'Provider accepted request', updated_at = ?2 WHERE id = ?1",
                params![run_id, timestamp],
            )
            .map_err(|error| format!("failed to update accepted provider run: {error}"))?;
        transaction
            .execute(
                "UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = COALESCE(started_at, ?2), heartbeat_at = ?2 WHERE run_id = ?1",
                params![run_id, timestamp],
            )
            .map_err(|error| format!("failed to start provider job: {error}"))?;
        observe(
            &transaction,
            job_id,
            "accepted",
            "accepted",
            "submit",
            Some(POLL_DELAY_MS),
        )?;
        append_event(
            &transaction,
            run_id,
            "provider_accepted",
            "Provider acceptance, request identifiers, cost exposure, and result-retention deadline were persisted immediately.",
            Some(0.18),
            "provider.acceptance",
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider acceptance: {error}"))?;
    if scenario == "acceptance-unknown" {
        database::transition_nodes_by_type(
            paths,
            run_id,
            &["task.generate-image", "task.edit-image"],
            "blocked",
            Some("provider.acceptance-unknown"),
            Some("Provider acceptance requires review"),
            Some(0.12),
        )?;
    }
    Ok(())
}

fn schedule_poll(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    status: &str,
    raw_state: &str,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider poll update: {error}"))?;
    let timestamp = database::now();
    let next_poll = (Utc::now() + chrono::Duration::milliseconds(POLL_DELAY_MS as i64))
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let progress = if status == "queued" { 0.28 } else { 0.56 };
    transaction
        .execute(
            "UPDATE provider_jobs SET status = ?2, raw_state = ?3, poll_attempts = poll_attempts + 1,\n\
               next_poll_at = ?4, updated_at = ?5 WHERE id = ?1",
            params![job_id, status, raw_state, next_poll, timestamp],
        )
        .map_err(|error| format!("failed to persist provider poll: {error}"))?;
    transaction
        .execute(
            "UPDATE runs SET status = 'running', progress = ?2, current_step = ?3, updated_at = ?4 WHERE id = ?1",
            params![run_id, progress, if status == "queued" { "Provider queued request" } else { "Provider is processing" }, timestamp],
        )
        .map_err(|error| format!("failed to update provider poll progress: {error}"))?;
    observe(
        &transaction,
        job_id,
        status,
        raw_state,
        "poll",
        Some(POLL_DELAY_MS),
    )?;
    append_event(
        &transaction,
        run_id,
        "provider_reconciled",
        if status == "queued" {
            "Provider state was reconciled as queued; the next poll time is durable."
        } else {
            "Provider state was reconciled as running; backoff and deadline remain durable."
        },
        Some(progress),
        "provider.poll",
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider poll update: {error}"))
}

fn mark_output_pending(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    late_success: bool,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider output transition: {error}"))?;
    let timestamp = database::now();
    transaction
        .execute(
            "UPDATE provider_jobs SET status = 'succeeded-download-pending', raw_state = 'succeeded',\n\
               late_success = ?2, next_poll_at = ?3, updated_at = ?3 WHERE id = ?1",
            params![job_id, late_success, timestamp],
        )
        .map_err(|error| format!("failed to persist pending provider output: {error}"))?;
    transaction
        .execute(
            "UPDATE runs SET status = 'running', progress = 0.72, current_step = 'Downloading provider output', updated_at = ?2 WHERE id = ?1",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to update pending output run: {error}"))?;
    observe(
        &transaction,
        job_id,
        "succeeded-download-pending",
        "succeeded",
        "poll",
        None,
    )?;
    append_event(
        &transaction,
        run_id,
        if late_success {
            "provider_late_success"
        } else {
            "provider_output_pending"
        },
        if late_success {
            "The provider completed after cancellation was requested. Output ingestion continues to avoid losing a paid result."
        } else {
            "Provider success was observed. The expiring result is queued for immediate bounded download and CAS ingestion."
        },
        Some(0.72),
        "provider.output",
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider output transition: {error}"))?;
    database::transition_nodes_by_type(
        paths,
        run_id,
        &["task.generate-image", "task.edit-image"],
        "completed",
        Some("provider.output"),
        Some("Provider output is ready"),
        Some(0.72),
    )
}

fn begin_download(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    already_interrupted: bool,
) -> MediaResult<()> {
    transition(
        paths,
        run_id,
        job_id,
        "downloading",
        if already_interrupted {
            "injected-crash-during-download"
        } else {
            "downloading-signed-result"
        },
        0.8,
        "Verifying provider output",
        "provider_download_started",
        "A bounded download began; provider URLs and response bodies remain outside renderer state.",
        "provider.download",
        None,
    )
}

fn ingest_outputs(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    phase_cursor: u32,
) -> MediaResult<()> {
    let (prompt, output_count, aspect_ratio) = database::open(paths)?
        .query_row(
            "SELECT prompt, output_count, aspect_ratio FROM runs WHERE id = ?1",
            params![run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| format!("failed to inspect provider output contract: {error}"))?;
    let (width, height) = executor::dimensions(&aspect_ratio);
    for output_index in phase_cursor..output_count {
        let bytes =
            executor::render_fixture_png(&format!("remote:{prompt}"), output_index, width, height)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("provider output exceeded the 16 MiB fixture download bound".to_string());
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let relative_path = Path::new(&digest[0..2]).join(&digest[2..4]).join(&digest);
        let destination = paths.blobs.join(&relative_path);
        if !destination.exists() {
            if let Some(parent) = destination.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("failed to create provider CAS shard: {error}"))?;
            }
            crate::atomic_file::write_file_atomic(
                &destination,
                &bytes,
                crate::atomic_file::AtomicWriteOptions::default(),
            )
            .map_err(|error| format!("failed to atomically publish provider output: {error}"))?;
        }
        record_provider_asset(
            paths,
            run_id,
            job_id,
            &digest,
            &relative_path.to_string_lossy(),
            bytes.len() as u64,
            width,
            height,
            output_index,
            output_count,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn record_provider_asset(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    digest: &str,
    relative_path: &str,
    bytes: u64,
    width: u32,
    height: u32,
    output_index: u32,
    output_count: u32,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider asset ingestion: {error}"))?;
    let timestamp = database::now();
    transaction
        .execute(
            "INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at) VALUES (?1, ?2, 'image/png', ?3, ?4)",
            params![digest, bytes as i64, relative_path, timestamp],
        )
        .map_err(|error| format!("failed to register provider blob: {error}"))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height, created_at, output_index, fixture, operation_json)\n\
             VALUES (?1, ?2, ?3, 'image', 'image/png', ?4, ?5, ?6, ?7, ?8, 1, ?9)",
            params![
                format!("asset:{run_id}:{output_index}"),
                run_id,
                digest,
                bytes as i64,
                width,
                height,
                timestamp,
                output_index,
                serde_json::json!({
                    "kind": "mock-provider-generation",
                    "providerJobId": job_id,
                    "adapterId": ADAPTER_ID,
                    "adapterVersion": ADAPTER_VERSION,
                }).to_string(),
            ],
        )
        .map_err(|error| format!("failed to register provider asset: {error}"))?;
    let progress = 0.8 + (f64::from(output_index + 1) / f64::from(output_count)) * 0.15;
    transaction
        .execute(
            "UPDATE provider_jobs SET phase_cursor = MAX(phase_cursor, ?2), updated_at = ?3 WHERE id = ?1",
            params![job_id, output_index + 1, timestamp],
        )
        .map_err(|error| format!("failed to checkpoint provider download: {error}"))?;
    transaction
        .execute(
            "UPDATE runs SET progress = ?2, current_step = ?3, updated_at = ?4 WHERE id = ?1",
            params![
                run_id,
                progress,
                format!(
                    "Ingested provider output {} of {}",
                    output_index + 1,
                    output_count
                ),
                timestamp
            ],
        )
        .map_err(|error| format!("failed to checkpoint provider asset: {error}"))?;
    append_event(
        &transaction,
        run_id,
        "asset_published",
        &format!(
            "Provider output {} passed the size bound, decoded, hashed, and entered CAS.",
            output_index + 1
        ),
        Some(progress),
        "provider.ingest",
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider asset ingestion: {error}"))
}

fn finish_completed(paths: &MediaRuntimePaths, run_id: &str, job_id: &str) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider delivery finalization: {error}"))?;
    let timestamp = database::now();
    transaction
        .execute(
            "UPDATE provider_jobs SET status = 'completed', raw_state = 'completed',
             next_poll_at = NULL, review_required = 0, updated_at = ?2, completed_at = ?2
             WHERE id = ?1",
            params![job_id, timestamp],
        )
        .map_err(|error| format!("failed to finalize provider delivery: {error}"))?;
    observe(&transaction, job_id, "completed", "completed", "poll", None)?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider delivery: {error}"))?;
    database::complete_run(paths, run_id)
}

fn finish_failed(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    error: &str,
) -> MediaResult<()> {
    finish_terminal(paths, run_id, job_id, "failed", "failed", "Provider failed", "provider_failed", "The provider returned a terminal refusal. The normalized reason was preserved without exposing a response body.", Some(error))
}

fn finish_expired(paths: &MediaRuntimePaths, run_id: &str, job_id: &str) -> MediaResult<()> {
    finish_terminal(paths, run_id, job_id, "expired", "failed", "Provider result expired", "provider_failed", "The provider result expired before it could be observed; automatic resubmission remains blocked because the original request may have been charged.", Some("Provider result retention window expired."))
}

fn finish_cancelled(paths: &MediaRuntimePaths, run_id: &str, job_id: &str) -> MediaResult<()> {
    finish_terminal(
        paths,
        run_id,
        job_id,
        "cancelled",
        "canceled",
        "Canceled by provider",
        "run_canceled",
        "Provider cancellation was observed and persisted. No success output was available.",
        None,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_terminal(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    provider_status: &str,
    run_status: &str,
    step: &str,
    event_kind: &str,
    message: &str,
    error: Option<&str>,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|failure| format!("failed to begin provider finalization: {failure}"))?;
    let timestamp = database::now();
    transaction
        .execute(
            "UPDATE provider_jobs SET status = ?2, raw_state = ?2, next_poll_at = NULL, review_required = 0,\n\
               error = ?3, updated_at = ?4, completed_at = ?4 WHERE id = ?1",
            params![job_id, provider_status, error, timestamp],
        )
        .map_err(|failure| format!("failed to finalize provider job: {failure}"))?;
    transaction
        .execute(
            "UPDATE runs SET status = ?2, progress = CASE WHEN ?2 = 'completed' THEN 1 ELSE progress END,\n\
               current_step = ?3, error = ?4, updated_at = ?5 WHERE id = ?1",
            params![run_id, run_status, step, error, timestamp],
        )
        .map_err(|failure| format!("failed to finalize provider run: {failure}"))?;
    transaction
        .execute(
            "UPDATE jobs SET status = ?2, finished_at = ?3, heartbeat_at = ?3, error = ?4 WHERE run_id = ?1",
            params![run_id, run_status, timestamp, error],
        )
        .map_err(|failure| format!("failed to finalize provider queue job: {failure}"))?;
    observe(
        &transaction,
        job_id,
        provider_status,
        provider_status,
        "poll",
        None,
    )?;
    append_event(
        &transaction,
        run_id,
        event_kind,
        message,
        (run_status == "completed").then_some(1.0),
        "provider.finalize",
    )?;
    transaction
        .commit()
        .map_err(|failure| format!("failed to commit provider finalization: {failure}"))?;
    database::transition_nodes_by_type(
        paths,
        run_id,
        &["task.generate-image", "task.edit-image"],
        if run_status == "canceled" {
            "canceled"
        } else {
            "failed"
        },
        Some("provider.finalize"),
        Some(step),
        None,
    )
}

pub(crate) fn request_cancellation(paths: &MediaRuntimePaths, run_id: &str) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider cancellation request: {error}"))?;
    let timestamp = database::now();
    let updated = transaction
        .execute(
            "UPDATE provider_jobs SET status = CASE WHEN status IN ('accepted', 'queued', 'running') THEN 'cancel-requested' ELSE status END,\n\
               cancel_requested = 1, next_poll_at = ?2, updated_at = ?2\n\
             WHERE run_id = ?1 AND status NOT IN ('cancelled', 'failed', 'expired', 'completed')",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to persist provider cancellation request: {error}"))?;
    if updated > 0 {
        append_event(
            &transaction,
            run_id,
            "provider_cancel_requested",
            "A best-effort provider cancellation was requested. The run remains reconcilable because success can race cancellation.",
            None,
            "provider.cancel",
        )?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider cancellation request: {error}"))
}

pub(crate) fn wake_reconciliation(
    paths: &MediaRuntimePaths,
    provider_job_id: &str,
) -> MediaResult<String> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider wake hint: {error}"))?;
    let run_id = transaction
        .query_row(
            "SELECT run_id FROM provider_jobs WHERE id = ?1",
            params![provider_job_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect provider wake hint: {error}"))?
        .ok_or_else(|| format!("provider job {provider_job_id} was not found"))?;
    transaction
        .execute(
            "UPDATE provider_jobs SET next_poll_at = ?2, updated_at = ?2\n\
             WHERE id = ?1 AND status IN ('accepted', 'queued', 'running', 'cancel-requested', 'succeeded-download-pending')",
            params![provider_job_id, database::now()],
        )
        .map_err(|error| format!("failed to persist provider wake hint: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider wake hint: {error}"))?;
    Ok(run_id)
}

pub(crate) fn resolve_review(
    paths: &MediaRuntimePaths,
    request: &ResolveProviderReviewRequest,
) -> MediaResult<String> {
    if !matches!(
        request.action.as_str(),
        "reconcile-only" | "confirm-not-accepted-and-retry"
    ) {
        return Err("provider review action is not supported".to_string());
    }
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider review resolution: {error}"))?;
    let (run_id, status, attempt) = transaction
        .query_row(
            "SELECT run_id, status, attempt FROM provider_jobs WHERE id = ?1",
            params![request.provider_job_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u32>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect provider review: {error}"))?
        .ok_or_else(|| format!("provider job {} was not found", request.provider_job_id))?;
    if status != "acceptance-unknown" {
        return Err(format!(
            "provider job is not awaiting review (status {status})"
        ));
    }
    let timestamp = database::now();
    if request.action == "reconcile-only" {
        let provider_job_id = format!(
            "mock-reconciled-{}",
            request.provider_job_id.replace(':', "-")
        );
        let retention_expires_at =
            (Utc::now() + chrono::Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Millis, true);
        transaction
            .execute(
                "UPDATE provider_jobs SET status = 'accepted', raw_state = 'accepted-by-idempotency-lookup',\n\
                   provider_job_id = ?2, provider_request_id = ?3, accepted_at = ?4, retention_expires_at = ?5,\n\
                   review_required = 0, review_reason = NULL, next_poll_at = ?4, updated_at = ?4 WHERE id = ?1",
                params![request.provider_job_id, provider_job_id, format!("lookup-{provider_job_id}"), timestamp, retention_expires_at],
            )
            .map_err(|error| format!("failed to reconcile uncertain provider job: {error}"))?;
        transaction
            .execute(
                "UPDATE runs SET status = 'running', progress = 0.18, current_step = 'Acceptance reconciled without resubmission', updated_at = ?2 WHERE id = ?1",
                params![run_id, timestamp],
            )
            .map_err(|error| format!("failed to resume reconciled provider run: {error}"))?;
        observe(
            &transaction,
            &request.provider_job_id,
            "accepted",
            "accepted-by-idempotency-lookup",
            "manual-reconcile",
            Some(POLL_DELAY_MS),
        )?;
        append_event(&transaction, &run_id, "provider_reconciled", "Idempotency lookup found the original paid request. Processing resumed without a second submission.", Some(0.18), "provider.review")?;
    } else {
        transaction
            .execute(
                "UPDATE provider_jobs SET status = 'failed', raw_state = 'operator-confirmed-not-accepted',\n\
                   review_required = 0, review_reason = NULL, error = 'Operator confirmed the request was not accepted.',\n\
                   completed_at = ?2, updated_at = ?2 WHERE id = ?1",
                params![request.provider_job_id, timestamp],
            )
            .map_err(|error| format!("failed to close uncertain provider job: {error}"))?;
        let (flow_id, flow_revision_id, flow_name, plan_id, prompt, model_label, output_count, diagnostic_count, aspect_ratio, plan_snapshot_json) = transaction
            .query_row(
                "SELECT flow_id, flow_revision_id, flow_name, plan_id, prompt, model_label, output_count, diagnostic_count, aspect_ratio, plan_snapshot_json FROM runs WHERE id = ?1",
                params![run_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, u32>(6)?, row.get::<_, u32>(7)?, row.get::<_, String>(8)?, row.get::<_, Option<String>>(9)?)),
            )
            .map_err(|error| format!("failed to prepare reviewed provider retry: {error}"))?;
        let plan_snapshot = plan_snapshot_json
            .map(|raw| serde_json::from_str(&raw))
            .transpose()
            .map_err(|error| format!("failed to decode reviewed run plan snapshot: {error}"))?;
        let retry_request = EnqueueMockRemoteRunRequest {
            run_id: run_id.clone(),
            flow_id,
            flow_revision_id,
            flow_name,
            plan_id,
            prompt,
            model_label,
            target: Some("remote".to_string()),
            output_count,
            diagnostic_count,
            aspect_ratio,
            scenario: "success".to_string(),
            allow_remote_upload: false,
            plan_snapshot,
        };
        insert_provider_attempt(&transaction, &retry_request, attempt + 1, &timestamp)?;
        transaction
            .execute(
                "UPDATE runs SET status = 'queued', progress = 0.01, current_step = 'Explicitly approved provider retry', error = NULL, cancel_requested = 0, updated_at = ?2 WHERE id = ?1",
                params![run_id, timestamp],
            )
            .map_err(|error| format!("failed to queue reviewed provider retry: {error}"))?;
        append_event(&transaction, &run_id, "retry_queued", "A new provider attempt was created only after explicit confirmation that the previous request was not accepted.", Some(0.01), "provider.review")?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider review resolution: {error}"))?;
    database::transition_nodes_by_type(
        paths,
        &run_id,
        &["task.generate-image", "task.edit-image"],
        if request.action == "reconcile-only" {
            "running"
        } else {
            "retrying"
        },
        Some("provider.review"),
        Some(if request.action == "reconcile-only" {
            "Provider acceptance reconciled"
        } else {
            "Provider retry queued"
        }),
        Some(if request.action == "reconcile-only" {
            0.18
        } else {
            0.01
        }),
    )?;
    Ok(run_id)
}

fn wait_until_due(paths: &MediaRuntimePaths, job_id: &str) -> MediaResult<()> {
    let next_poll_at = database::open(paths)?
        .query_row(
            "SELECT next_poll_at FROM provider_jobs WHERE id = ?1",
            params![job_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|error| format!("failed to read provider poll schedule: {error}"))?;
    if let Some(next_poll_at) = next_poll_at {
        if let Ok(next) = chrono::DateTime::parse_from_rfc3339(&next_poll_at) {
            let remaining = next.with_timezone(&Utc) - Utc::now();
            if let Ok(duration) = remaining.to_std() {
                thread::sleep(duration.min(Duration::from_secs(2)));
            }
        }
    }
    Ok(())
}

fn inject_interruption(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    raw_state: &str,
    message: &str,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider fault injection: {error}"))?;
    let timestamp = database::now();
    transaction
        .execute(
            "UPDATE provider_jobs SET raw_state = ?2, updated_at = ?3 WHERE id = ?1",
            params![job_id, raw_state, timestamp],
        )
        .map_err(|error| format!("failed to checkpoint provider fault injection: {error}"))?;
    transaction
        .execute(
            "UPDATE runs SET current_step = 'Injected provider process interruption', updated_at = ?2 WHERE id = ?1",
            params![run_id, timestamp],
        )
        .map_err(|error| format!("failed to checkpoint interrupted provider run: {error}"))?;
    append_event(
        &transaction,
        run_id,
        "run_recovered",
        message,
        None,
        "provider.fault-injection",
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider fault injection: {error}"))
}

#[allow(clippy::too_many_arguments)]
fn transition(
    paths: &MediaRuntimePaths,
    run_id: &str,
    job_id: &str,
    status: &str,
    raw_state: &str,
    progress: f64,
    step: &str,
    event_kind: &str,
    message: &str,
    step_id: &str,
    phase_cursor: Option<u32>,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin provider transition: {error}"))?;
    let timestamp = database::now();
    transaction
        .execute(
            "UPDATE provider_jobs SET status = ?2, raw_state = ?3, phase_cursor = COALESCE(?4, phase_cursor), updated_at = ?5 WHERE id = ?1",
            params![job_id, status, raw_state, phase_cursor, timestamp],
        )
        .map_err(|error| format!("failed to persist provider transition: {error}"))?;
    transaction
        .execute(
            "UPDATE runs SET status = 'running', progress = ?2, current_step = ?3, updated_at = ?4 WHERE id = ?1",
            params![run_id, progress, step, timestamp],
        )
        .map_err(|error| format!("failed to persist provider run transition: {error}"))?;
    observe(&transaction, job_id, status, raw_state, "worker", None)?;
    append_event(
        &transaction,
        run_id,
        event_kind,
        message,
        Some(progress),
        step_id,
    )?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit provider transition: {error}"))
}

fn observe(
    transaction: &Transaction<'_>,
    job_id: &str,
    normalized_state: &str,
    raw_state: &str,
    source: &str,
    retry_after_ms: Option<u64>,
) -> MediaResult<()> {
    let sequence = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM provider_observations WHERE provider_job_id = ?1",
            params![job_id],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|error| format!("failed to sequence provider observation: {error}"))?;
    transaction
        .execute(
            "INSERT INTO provider_observations(provider_job_id, sequence, normalized_state, raw_state, source, retry_after_ms, observed_at)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![job_id, sequence, normalized_state, raw_state, source, retry_after_ms.map(|value| value as i64), database::now()],
        )
        .map(|_| ())
        .map_err(|error| format!("failed to record provider observation: {error}"))
}

fn append_event(
    transaction: &Transaction<'_>,
    run_id: &str,
    kind: &str,
    message: &str,
    progress: Option<f64>,
    step_id: &str,
) -> MediaResult<()> {
    let sequence = transaction
        .query_row(
            "SELECT COALESCE(MAX(sequence), 0) + 1 FROM run_events WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|error| format!("failed to sequence provider event: {error}"))?;
    transaction
        .execute(
            "INSERT INTO run_events(run_id, sequence, kind, created_at, message, progress, step_id)\n\
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![run_id, sequence, kind, database::now(), message, progress, step_id],
        )
        .map(|_| ())
        .map_err(|error| format!("failed to append provider event: {error}"))
}

fn collect_ids(transaction: &Transaction<'_>, sql: &str) -> MediaResult<Vec<String>> {
    let mut statement = transaction
        .prepare(sql)
        .map_err(|error| format!("failed to prepare provider recovery query: {error}"))?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query provider recovery state: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode provider recovery state: {error}"))?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn test_paths(label: &str) -> MediaRuntimePaths {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("machdoch-provider-{label}-{unique}"));
        MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        }
    }

    fn request(run_id: &str, scenario: &str) -> EnqueueMockRemoteRunRequest {
        EnqueueMockRemoteRunRequest {
            run_id: run_id.to_string(),
            flow_id: "flow:provider".to_string(),
            flow_revision_id: None,
            flow_name: "Remote fixture".to_string(),
            plan_id: "plan:provider".to_string(),
            prompt: "A durable provider test".to_string(),
            model_label: "Mock Remote Image v1".to_string(),
            target: Some("remote".to_string()),
            output_count: 1,
            diagnostic_count: 0,
            aspect_ratio: "1:1".to_string(),
            scenario: scenario.to_string(),
            allow_remote_upload: false,
            plan_snapshot: None,
        }
    }

    #[test]
    fn completes_remote_output_through_cas() {
        let paths = test_paths("success");
        database::ensure_initialized(&paths).unwrap();
        enqueue(&paths, &request("run:success", "success")).unwrap();
        execute(&paths, "run:success").unwrap();
        let detail = database::get_run_detail(&paths, "run:success").unwrap();
        assert_eq!(detail.run.status, "completed");
        assert_eq!(detail.provider_jobs[0].status, "completed");
        assert_eq!(detail.assets.len(), 1);
        assert!(paths.blobs.join(&detail.assets[0].digest[0..2]).exists());
    }

    #[test]
    fn completed_provider_delivery_enters_the_durable_human_review_gate() {
        let paths = test_paths("success-review");
        database::ensure_initialized(&paths).unwrap();
        let mut request = request("run:success-review", "success");
        request.plan_snapshot = Some(crate::media::MediaRunPlanSnapshot {
            schema_version: 1,
            plan_id: request.plan_id.clone(),
            flow_id: request.flow_id.clone(),
            flow_fingerprint: "sha256:provider-review".to_string(),
            compiled_at: "2026-07-14T00:00:00.000Z".to_string(),
            nodes: vec![crate::media::MediaRunPlanNodeSnapshot {
                id: "node:review".to_string(),
                r#type: "control.human-review".to_string(),
                label: "Human review".to_string(),
                layer: "control".to_string(),
            }],
            steps: vec![crate::media::MediaRunPlanStepSnapshot {
                id: "step:review".to_string(),
                source_node_id: "node:review".to_string(),
                kind: "wait-for-review".to_string(),
                label: "Pause for review".to_string(),
                target: "orchestrator".to_string(),
                cacheable: false,
                side_effect: None,
                review: Some(crate::media::MediaHumanReviewContract {
                    instructions: "Approve a provider candidate.".to_string(),
                    max_selections: 1,
                    require_comment: false,
                }),
            }],
        });
        enqueue(&paths, &request).unwrap();
        execute(&paths, &request.run_id).unwrap();

        let detail = database::get_run_detail(&paths, &request.run_id).unwrap();
        assert_eq!(detail.run.status, "waiting-for-review");
        assert_eq!(detail.provider_jobs[0].status, "completed");
        assert_eq!(detail.human_reviews[0].status, "pending");
        assert!(database::list_assets(&paths, 10).unwrap().is_empty());
    }

    #[test]
    fn uncertain_acceptance_requires_reconciliation_without_resubmission() {
        let paths = test_paths("uncertain");
        database::ensure_initialized(&paths).unwrap();
        enqueue(&paths, &request("run:uncertain", "acceptance-unknown")).unwrap();
        execute(&paths, "run:uncertain").unwrap();
        let detail = database::get_run_detail(&paths, "run:uncertain").unwrap();
        assert_eq!(detail.run.status, "needs-review");
        assert!(detail.provider_jobs[0].review_required);

        resolve_review(
            &paths,
            &ResolveProviderReviewRequest {
                provider_job_id: detail.provider_jobs[0].id.clone(),
                action: "reconcile-only".to_string(),
            },
        )
        .unwrap();
        execute(&paths, "run:uncertain").unwrap();
        let reconciled = database::get_run_detail(&paths, "run:uncertain").unwrap();
        assert_eq!(reconciled.run.status, "completed");
        assert_eq!(reconciled.provider_jobs.len(), 1);
    }

    #[test]
    fn fault_injection_resumes_without_creating_a_second_submission() {
        for scenario in [
            "crash-before-submit",
            "crash-during-poll",
            "crash-after-success",
            "crash-during-download",
        ] {
            let paths = test_paths(scenario);
            database::ensure_initialized(&paths).unwrap();
            let run_id = format!("run:{scenario}");
            enqueue(&paths, &request(&run_id, scenario)).unwrap();
            execute(&paths, &run_id).unwrap();
            if scenario == "crash-during-download" {
                let resumed = recover_interrupted(&paths).unwrap();
                assert_eq!(resumed, vec![run_id.clone()]);
            }
            execute(&paths, &run_id).unwrap();
            let detail = database::get_run_detail(&paths, &run_id).unwrap();
            assert_eq!(detail.run.status, "completed", "scenario {scenario}");
            assert_eq!(detail.provider_jobs.len(), 1, "scenario {scenario}");
            assert_eq!(detail.assets.len(), 1, "scenario {scenario}");
        }
    }

    #[test]
    fn submission_crashes_enter_acceptance_unknown_instead_of_resubmitting() {
        for scenario in ["crash-during-submit", "crash-after-acceptance"] {
            let paths = test_paths(scenario);
            database::ensure_initialized(&paths).unwrap();
            let run_id = format!("run:{scenario}");
            enqueue(&paths, &request(&run_id, scenario)).unwrap();
            execute(&paths, &run_id).unwrap();
            let interrupted = database::get_run_detail(&paths, &run_id).unwrap();
            assert_eq!(interrupted.provider_jobs[0].status, "submitting");

            recover_interrupted(&paths).unwrap();
            let uncertain = database::get_run_detail(&paths, &run_id).unwrap();
            assert_eq!(uncertain.run.status, "needs-review");
            assert_eq!(uncertain.provider_jobs.len(), 1);
            assert_eq!(uncertain.provider_jobs[0].status, "acceptance-unknown");
            assert!(uncertain.provider_jobs[0].review_required);
        }
    }
}
