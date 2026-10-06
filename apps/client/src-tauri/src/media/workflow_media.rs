use super::*;

pub(super) fn compose(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &ExecuteMediaWorkflowRequest,
    flow: &MediaFlowDocument,
    values: &Values,
    node: &MediaFlowNode,
    iteration: u32,
) -> MediaResult<String> {
    let sequence = node.r#type == "operation.video-sequence";
    let ports = if sequence {
        (1..=8)
            .map(|index| format!("scene-{index}"))
            .collect::<Vec<_>>()
    } else {
        vec!["video".into()]
    };
    let mut videos = Vec::new();
    for port in ports {
        match optional_input(flow, values, node, &port)? {
            Some(WorkflowValue::Video(id)) => videos.push(id.clone()),
            None => {}
            _ => return Err(format!("Connect a video to {port}")),
        }
    }
    let audio = match optional_input(flow, values, node, "audio")? {
        Some(WorkflowValue::Audio(id)) => Some(id.clone()),
        None => None,
        _ => return Err("Connect an audio asset".into()),
    };
    let start = config_number(node, "audioStartSeconds", 0.0);
    let (details, asset) = provider_local_diffusers::compose_video(
        app,
        paths,
        &request.run_id,
        &videos,
        audio.as_deref(),
        start,
        sequence,
    )?;
    let inputs = videos.into_iter().chain(audio).collect::<Vec<_>>();
    database::workflow::publish(
        paths,
        &request.run_id,
        &node.id,
        iteration,
        &asset,
        "video",
        &inputs,
        details,
    )
}

pub(super) fn lip_sync(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &ExecuteMediaWorkflowRequest,
    flow: &MediaFlowDocument,
    values: &Values,
    node: &MediaFlowNode,
    iteration: u32,
) -> MediaResult<String> {
    let WorkflowValue::Video(video) = input(flow, values, node, "video")? else {
        return Err("Connect a video to Lip sync".into());
    };
    let WorkflowValue::Audio(audio) = input(flow, values, node, "audio")? else {
        return Err("Connect audio to Lip sync".into());
    };
    let voice = match optional_input(flow, values, node, "voice")? {
        Some(WorkflowValue::Audio(id)) => Some(id.as_str()),
        None => None,
        _ => return Err("Connect an audio asset to Vocals".into()),
    };
    let settings = provider_local_diffusers::LipSyncRequest {
        video_asset_id: video,
        audio_asset_id: audio,
        voice_asset_id: voice,
        model_path: config_text(node, "modelPath"),
        audio_start_seconds: config_number(node, "audioStartSeconds", 0.0),
        crop_shift: config_number(node, "cropShift", 0.0) as i32,
        batch_size: config_number(node, "batchSize", 4.0) as u32,
        seed: config_number(node, "seed", 42.0) as u64,
    };
    let (details, asset) =
        provider_local_diffusers::lip_sync_video(app, paths, &request.run_id, &settings)?;
    let inputs = [Some(video.as_str()), Some(audio.as_str()), voice]
        .into_iter()
        .flatten()
        .map(str::to_string)
        .collect::<Vec<_>>();
    database::workflow::publish(
        paths,
        &request.run_id,
        &node.id,
        iteration,
        &asset,
        "video",
        &inputs,
        details,
    )
}

pub(super) fn generate_audio(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &ExecuteMediaWorkflowRequest,
    flow: &MediaFlowDocument,
    node: &MediaFlowNode,
    prompt: String,
    seed: u64,
    iteration: u32,
) -> MediaResult<String> {
    let mut generation = super::super::GenerateMediaAudioRequest {
        schema_version: 1,
        run_id: request.run_id.clone(),
        flow_id: request.flow_id.clone(),
        flow_revision_id: request.flow_revision_id.clone(),
        flow_name: flow.name.clone(),
        plan_id: request.plan_id.clone(),
        plan_snapshot: request.plan_snapshot.clone(),
        model_id: request.model_bindings[&node.id].clone(),
        model_label: node.label.clone(),
        prompt,
        negative_prompt: config_text(node, "negativePrompt").to_string(),
        duration_seconds: config_number(node, "durationSeconds", 5.0),
        num_inference_steps: config_number(node, "numInferenceSteps", 100.0) as u32,
        guidance_scale: config_number(node, "guidanceScale", 3.5),
        seed,
        diagnostic_count: 0,
    };
    generation.validate_values()?;
    let audio = provider_local_diffusers::generate_audio(app, paths, &generation)?;
    let asset = GeneratedImageAsset {
        digest: audio.output.digest.clone(),
        relative_path: audio.relative_path,
        byte_size: audio.output.byte_size,
        mime_type: "audio/wav",
        width: 0,
        height: 0,
        output_index: 0,
        subject_cutout: None,
    };
    database::workflow::publish(
        paths,
        &request.run_id,
        &node.id,
        iteration,
        &asset,
        "audio",
        &[],
        audio.provenance,
    )
}
