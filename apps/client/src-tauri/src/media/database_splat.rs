use super::*;
use crate::media::splat::{
    GenerateMediaSplatRequest, GeneratedSplat, SPLAT_MIME_TYPE, SPLAT_PREVIEW_PROFILE,
};

pub(crate) fn begin(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaSplatRequest,
) -> MediaResult<bool> {
    let flow =
        super::super::flow::load_workflow(paths, &request.flow_id, &request.flow_revision_id)?;
    if flow.nodes.len() != 3
        || flow.edges.len() != 2
        || flow.name != request.flow_name
        || flow.nodes.iter().any(|node| {
            !matches!(
                node.r#type.as_str(),
                "source.image" | "task.generate-splat" | "output.splat"
            ) || !request.plan_snapshot.nodes.iter().any(|snapshot| {
                snapshot.id == node.id
                    && snapshot.r#type == node.r#type
                    && snapshot.layer == node.layer
            })
        })
        || request.plan_snapshot.nodes.len() != flow.nodes.len()
    {
        return Err("The 3D request does not match its saved flow.".into());
    }
    let node = |kind: &str| {
        flow.nodes
            .iter()
            .find(|node| node.r#type == kind)
            .ok_or_else(|| format!("The 3D flow has no {kind} node"))
    };
    let source = node("source.image")?;
    let config = &node("task.generate-splat")?.config;
    let text = |key: &str| config.get(key).and_then(serde_json::Value::as_str);
    let number = |key: &str| config.get(key).and_then(serde_json::Value::as_f64);
    if source.config.get("assetId").and_then(serde_json::Value::as_str)
        != Some(request.source_asset_id.as_str())
        || text("modelId").is_some_and(|id| id != request.model_id)
        || text("inputKind") != Some(request.input_kind.as_str())
        || number("gaussianCount") != Some(f64::from(request.gaussian_count))
        || number("numInferenceSteps") != Some(f64::from(request.num_inference_steps))
        || number("guidanceScale") != Some(request.guidance_scale)
        || number("timeShift") != Some(request.time_shift)
        || number("minOpacity") != Some(request.min_opacity)
        || config
            .get("seed")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|seed| seed != request.seed)
    {
        return Err("The 3D settings changed after the flow was saved. Save and retry.".into());
    }
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        Some(&request.flow_revision_id),
        Some(&request.plan_snapshot),
    )?;
    let timestamp = now();
    let snapshot =
        serde_json::to_string(&request.plan_snapshot).map_err(|error| error.to_string())?;
    let inserted = transaction.execute(
        "INSERT OR IGNORE INTO runs(id,flow_id,flow_name,plan_id,status,created_at,updated_at,prompt,model_label,target,output_count,diagnostic_count,progress,current_step,executor,aspect_ratio,plan_snapshot_json,flow_revision_id)
         VALUES(?1,?2,?3,?4,'running',?5,?5,'',?6,'local',1,?7,0.02,'Starting Idol','local-splat','1:1',?8,?9)",
        params![request.run_id,request.flow_id,request.flow_name,request.plan_id,timestamp,request.model_label,request.diagnostic_count,snapshot,request.flow_revision_id],
    ).map_err(|error| format!("Could not register 3D run: {error}"))?;
    if inserted == 0 {
        validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            Some(&request.flow_revision_id),
            &request.plan_id,
            "local-splat",
        )?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(false);
    }
    seed_node_executions(
        &transaction,
        &request.run_id,
        &request.plan_snapshot,
        "pending",
    )?;
    transaction.execute("INSERT INTO jobs(id,run_id,status,attempts,started_at,heartbeat_at) VALUES(?1,?2,'running',1,?3,?3)",params![format!("job:{}",request.run_id),request.run_id,timestamp]).map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        &request.run_id,
        "worker_prepared",
        "3D generation started",
        Some(0.02),
        Some("splat.prepare"),
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

pub(crate) fn insert_splat_asset(
    transaction: &rusqlite::Transaction<'_>,
    asset_id: &str,
    run_id: &str,
    output_index: u32,
    splat: &GeneratedSplat,
    operation: &serde_json::Value,
    source_asset_id: &str,
) -> MediaResult<()> {
    let timestamp = now();
    for (digest, byte_size, mime_type, relative_path) in [
        (&splat.digest, splat.byte_size, SPLAT_MIME_TYPE, &splat.relative_path),
        (&splat.preview_digest, splat.preview_byte_size, "image/png", &splat.preview_relative_path),
    ] {
        transaction.execute("INSERT INTO blobs(digest,byte_size,mime_type,relative_path,created_at,available) VALUES(?1,?2,?3,?4,?5,1) ON CONFLICT(digest) DO UPDATE SET available=1",params![digest,byte_size as i64,mime_type,relative_path,timestamp]).map_err(|error|error.to_string())?;
    }
    transaction.execute("INSERT INTO assets(id,run_id,blob_digest,kind,mime_type,byte_size,width,height,created_at,output_index,fixture,operation_json) VALUES(?1,?2,?3,'splat',?4,?5,0,0,?6,?7,0,?8)",params![asset_id,run_id,splat.digest,SPLAT_MIME_TYPE,splat.byte_size as i64,timestamp,output_index,operation.to_string()]).map_err(|error|error.to_string())?;
    transaction.execute("INSERT INTO asset_inputs(asset_id,input_asset_id,role) VALUES(?1,?2,'source:0')",params![asset_id,source_asset_id]).map_err(|error|error.to_string())?;
    transaction.execute("INSERT INTO asset_renditions(asset_id,profile,blob_digest,mime_type,byte_size,width,height,created_at) VALUES(?1,?2,?3,'image/png',?4,?5,?5,?6)",params![asset_id,SPLAT_PREVIEW_PROFILE,splat.preview_digest,splat.preview_byte_size as i64,splat.preview_edge,timestamp]).map_err(|error|error.to_string())?;
    transaction.execute("INSERT INTO asset_tags(asset_id,normalized_tag,display_tag,source,confidence,created_at) VALUES(?1,'idol','Idol','technical',1.0,?2)",params![asset_id,timestamp]).map_err(|error|error.to_string())?;
    Ok(())
}

pub(crate) fn complete(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaSplatRequest,
    splat: &GeneratedSplat,
) -> MediaResult<MediaRunDetail> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let status: String = transaction
        .query_row(
            "SELECT status FROM runs WHERE id=?1",
            [&request.run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if status == "canceling" {
        finalize_cancellation(&transaction, &request.run_id)?;
        transaction.commit().map_err(|error| error.to_string())?;
        return get_run_detail(paths, &request.run_id);
    }
    if status != "running" {
        return Err(format!("3D output cannot be published from {status} state"));
    }
    let operation = serde_json::json!({"kind":"local-splat-generation","providerId":"local-diffusers","modelId":request.model_id,"flowRevisionId":request.flow_revision_id,"sourceAssetId":request.source_asset_id,"generation":splat.provenance});
    insert_splat_asset(
        &transaction,
        &format!("asset:{}:0", request.run_id),
        &request.run_id,
        0,
        splat,
        &operation,
        &request.source_asset_id,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    transition_nodes_by_type(
        paths,
        &request.run_id,
        &["task.generate-splat", "output.splat"],
        "completed",
        Some("splat.publish"),
        Some("3D object saved"),
        Some(0.98),
    )?;
    complete_run(paths, &request.run_id)?;
    get_run_detail(paths, &request.run_id)
}
