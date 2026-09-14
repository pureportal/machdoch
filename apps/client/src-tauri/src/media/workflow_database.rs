use super::*;
use crate::media::{provider_openai::GeneratedImageAsset, ExecuteLocalImageFlowRequest};
use serde_json::{json, Value};

pub(crate) fn begin(
    paths: &MediaRuntimePaths,
    request: &ExecuteLocalImageFlowRequest,
    name: &str,
    prompt: &str,
    output_count: usize,
) -> MediaResult<bool> {
    let connection = open(paths)?;
    if connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE id = ?1)",
            params![request.run_id],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        validate_existing_run_identity(
            &connection,
            &request.run_id,
            &request.flow_id,
            Some(&request.flow_revision_id),
            &request.plan_id,
            "media-workflow",
        )?;
        return Ok(false);
    }
    drop(connection);
    if !begin_local_image_flow(paths, request, name)? {
        return Ok(false);
    }
    open(paths)?.execute("UPDATE runs SET executor = 'media-workflow', model_label = 'Workflow', prompt = ?2, output_count = ?3 WHERE id = ?1", params![request.run_id, prompt, output_count as i64]).map_err(|e| e.to_string())?;
    Ok(true)
}

pub(crate) fn publish(
    paths: &MediaRuntimePaths,
    run_id: &str,
    node_id: &str,
    iteration: u32,
    asset: &GeneratedImageAsset,
    kind: &str,
    inputs: &[String],
    details: Value,
) -> MediaResult<String> {
    let original = std::fs::read(paths.blobs.join(&asset.relative_path))
        .map_err(|e| format!("Workflow output cannot be read: {e}"))?;
    if original.len() as u64 != asset.byte_size
        || format!("{:x}", Sha256::digest(&original)) != asset.digest
    {
        return Err("Workflow output integrity check failed".into());
    }
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let status: String = transaction
        .query_row(
            "SELECT status FROM runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if status != "running" {
        return Err("Workflow stopped before output publication".into());
    }
    let index: u32 = transaction
        .query_row(
            "SELECT COUNT(*) FROM assets WHERE run_id = ?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id = format!("asset:{run_id}:{index}");
    let timestamp = now();
    transaction.execute("INSERT OR IGNORE INTO blobs(digest, byte_size, mime_type, relative_path, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![asset.digest, asset.byte_size as i64, asset.mime_type, asset.relative_path, timestamp]).map_err(|e| e.to_string())?;
    let operation = json!({"kind":"workflow", "sourceNodeId":node_id, "iteration":iteration, "details":details});
    transaction.execute("INSERT INTO assets(id, run_id, blob_digest, kind, mime_type, byte_size, width, height, created_at, output_index, fixture, operation_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,0,?11)", params![id, run_id, asset.digest, kind, asset.mime_type, asset.byte_size as i64, asset.width, asset.height, timestamp, index, operation.to_string()]).map_err(|e| e.to_string())?;
    for (input_index, input) in inputs.iter().enumerate() {
        transaction
            .execute(
                "INSERT INTO asset_inputs(asset_id,input_asset_id,role) VALUES (?1,?2,?3)",
                params![id, input, format!("source:{input_index}")],
            )
            .map_err(|e| e.to_string())?;
    }
    append_event_scoped(
        &transaction,
        run_id,
        "asset_published",
        &format!("Attempt {iteration}: output saved"),
        None,
        None,
        Some(node_id),
    )?;
    transaction.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

pub(crate) fn retry(
    paths: &MediaRuntimePaths,
    run_id: &str,
    node_ids: &HashSet<String>,
    iteration: u32,
    reason: &str,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    for id in node_ids {
        transaction.execute("UPDATE node_executions SET status = 'pending', progress = 0, finished_at = NULL, message = ?3, state_sequence = state_sequence + 1 WHERE run_id = ?1 AND node_id = ?2", params![run_id,id,format!("Waiting for attempt {iteration}")]).map_err(|e| e.to_string())?;
    }
    append_event(
        &transaction,
        run_id,
        "workflow_retry",
        &format!("Attempt {iteration}: {reason}"),
        None,
        None,
    )?;
    transaction.commit().map_err(|e| e.to_string())
}

pub(crate) fn progress(
    paths: &MediaRuntimePaths,
    run_id: &str,
    message: &str,
    progress: f64,
) -> MediaResult<bool> {
    let connection = open(paths)?;
    let executor: String = connection
        .query_row(
            "SELECT executor FROM runs WHERE id=?1",
            params![run_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if executor != "media-workflow" {
        return Ok(false);
    }
    let node_id: Option<String> = connection
        .query_row(
            "SELECT node_id FROM node_executions WHERE run_id=?1 AND status='running' LIMIT 1",
            params![run_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(node_id) = node_id {
        transition_node_execution(
            paths,
            run_id,
            &node_id,
            "running",
            Some("workflow.execute"),
            Some(message),
            Some(progress),
        )?;
    }
    Ok(true)
}

pub(crate) fn finish(
    paths: &MediaRuntimePaths,
    run_id: &str,
    output_count: usize,
) -> MediaResult<()> {
    open(paths)?
        .execute(
            "UPDATE runs SET output_count=?2 WHERE id=?1",
            params![run_id, output_count as i64],
        )
        .map_err(|e| e.to_string())?;
    update_terminal_run(
        paths,
        run_id,
        "completed",
        "Completed",
        "run_completed",
        "Workflow completed",
        None,
    )
}

pub(crate) fn record_result(
    paths: &MediaRuntimePaths,
    run_id: &str,
    node_id: &str,
    kind: &str,
    message: &str,
) -> MediaResult<()> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    append_event_scoped(
        &transaction,
        run_id,
        kind,
        message,
        None,
        None,
        Some(node_id),
    )?;
    transaction.commit().map_err(|e| e.to_string())
}
