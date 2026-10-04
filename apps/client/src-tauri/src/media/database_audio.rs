use super::*;
use crate::media::{audio::GeneratedAudio, GenerateMediaAudioRequest};

pub(crate) fn begin(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaAudioRequest,
) -> MediaResult<bool> {
    let flow =
        super::super::flow::load_workflow(paths, &request.flow_id, &request.flow_revision_id)?;
    if flow.nodes.len() != 3
        || flow.edges.len() != 2
        || flow.name != request.flow_name
        || flow.nodes.iter().any(|node| {
            !matches!(
                node.r#type.as_str(),
                "source.prompt" | "task.generate-audio" | "output.audio"
            )
        })
        || flow.nodes.iter().any(|node| {
            !request.plan_snapshot.nodes.iter().any(|snapshot| {
                snapshot.id == node.id
                    && snapshot.r#type == node.r#type
                    && snapshot.layer == node.layer
            })
        })
        || request.plan_snapshot.nodes.len() != flow.nodes.len()
    {
        return Err("The audio request does not match its saved flow.".into());
    }
    let task = flow
        .nodes
        .iter()
        .find(|node| node.r#type == "task.generate-audio")
        .ok_or("The audio flow has no generator")?;
    let prompt = flow
        .nodes
        .iter()
        .find(|node| node.r#type == "source.prompt")
        .ok_or("The audio flow has no prompt")?;
    let config = &task.config;
    if prompt
        .config
        .get("prompt")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        != Some(request.prompt.as_str())
        || config
            .get("negativePrompt")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            != Some(request.negative_prompt.as_str())
        || config
            .get("modelId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| id != request.model_id)
        || config
            .get("durationSeconds")
            .and_then(serde_json::Value::as_f64)
            != Some(request.duration_seconds)
        || config
            .get("numInferenceSteps")
            .and_then(serde_json::Value::as_u64)
            != Some(u64::from(request.num_inference_steps))
        || config
            .get("guidanceScale")
            .and_then(serde_json::Value::as_f64)
            != Some(request.guidance_scale)
        || config
            .get("seed")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|seed| seed != request.seed)
    {
        return Err("The audio settings changed after the flow was saved. Save and retry.".into());
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
         VALUES(?1,?2,?3,?4,'running',?5,?5,?6,?7,'local',1,?8,0.04,'Generating audio','local-audio','1:1',?9,?10)",
        params![request.run_id,request.flow_id,request.flow_name,request.plan_id,timestamp,request.prompt,request.model_label,request.diagnostic_count,snapshot,request.flow_revision_id],
    ).map_err(|error| format!("Could not register audio run: {error}"))?;
    if inserted == 0 {
        validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            Some(&request.flow_revision_id),
            &request.plan_id,
            "local-audio",
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
        "Audio generation started",
        Some(0.04),
        Some("audio.prepare"),
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

pub(crate) fn complete(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaAudioRequest,
    audio: &GeneratedAudio,
) -> MediaResult<MediaRunDetail> {
    let output = &audio.output;
    crate::media::transform::resolve_verified_blob_path(
        paths,
        &AssetBlobSource {
            digest: output.digest.clone(),
            relative_path: audio.relative_path.clone(),
            byte_size: output.byte_size,
            mime_type: "audio/wav".into(),
        },
    )?;
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
        return Err(format!("Audio cannot be published from {status} state"));
    }
    let timestamp = now();
    transaction.execute("INSERT INTO blobs(digest,byte_size,mime_type,relative_path,created_at,available) VALUES(?1,?2,'audio/wav',?3,?4,1) ON CONFLICT(digest) DO UPDATE SET available=1",params![output.digest,output.byte_size as i64,audio.relative_path,timestamp]).map_err(|error|error.to_string())?;
    let provenance = serde_json::json!({"kind":"local-audio-generation","providerId":"local-diffusers","modelId":request.model_id,"flowRevisionId":request.flow_revision_id,"generation":audio.provenance}).to_string();
    let asset_id = format!("asset:{}:0", request.run_id);
    transaction.execute("INSERT INTO assets(id,run_id,blob_digest,kind,mime_type,byte_size,width,height,created_at,output_index,fixture,operation_json) VALUES(?1,?2,?3,'audio','audio/wav',?4,0,0,?5,0,0,?6)",params![asset_id,request.run_id,output.digest,output.byte_size as i64,timestamp,provenance]).map_err(|error|error.to_string())?;
    transaction.execute("INSERT INTO asset_tags(asset_id,normalized_tag,display_tag,source,confidence,created_at) VALUES(?1,'audioldm-2','AudioLDM 2','technical',1.0,?2)",params![asset_id,timestamp]).map_err(|error|error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    transition_nodes_by_type(
        paths,
        &request.run_id,
        &["task.generate-audio", "output.audio"],
        "completed",
        Some("audio.publish"),
        Some("Audio saved"),
        Some(0.96),
    )?;
    complete_run(paths, &request.run_id)?;
    get_run_detail(paths, &request.run_id)
}
