use super::*;

pub(super) fn media_worker(app: &AppHandle) -> MediaResult<(PathBuf, PathBuf)> {
    let script = worker_script(app)?.with_file_name("media_workflow_worker.py");
    let root = super::super::runtime_setup::root(app)?;
    let python = super::super::runtime_setup::python_path(&root);
    if !python.is_file() || !script.is_file() {
        return Err("Set up the media runtime in Models, then retry".into());
    }
    Ok((script, python))
}

pub(crate) fn inspect_video(
    app: &AppHandle,
    path: &Path,
    training: bool,
) -> MediaResult<serde_json::Value> {
    let (script, python) = media_worker(app)?;
    let request = serde_json::to_vec(&serde_json::json!({"inputPath": path}))
        .map_err(|error| error.to_string())?;
    let output = run_worker(
        &python,
        &script,
        if training {
            "training-video-inspect"
        } else {
            "video-inspect"
        },
        Some(&request),
        Duration::from_secs(900),
        None,
    )?;
    let result: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not read video metadata: {error}"))?;
    if !output.status.success() || result.get("error").is_some() {
        return Err(worker_failure_with_diagnostics(
            result["error"]
                .as_str()
                .unwrap_or("Could not decode video")
                .to_string(),
            &output.stderr,
        ));
    }
    let metadata = &result["output"];
    let width = metadata["width"]
        .as_u64()
        .filter(|value| (1..=16_384).contains(value));
    let height = metadata["height"]
        .as_u64()
        .filter(|value| (1..=16_384).contains(value));
    let fps = metadata["fps"]
        .as_f64()
        .filter(|value| value.is_finite() && (1.0..=120.0).contains(value));
    let duration = metadata["durationSeconds"]
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0 && *value <= 3_600.0);
    let frames = metadata["numFrames"].as_u64().filter(|value| *value > 0);
    if result["schemaVersion"] != 1
        || width.is_none()
        || height.is_none()
        || fps.is_none()
        || duration.is_none()
        || frames.is_none()
        || metadata["hasAudio"].as_bool().is_none()
        || metadata["hasAlpha"].as_bool().is_none()
    {
        return Err("Video metadata is invalid; export it again as WebM".into());
    }
    if (duration.unwrap() - frames.unwrap() as f64 / fps.unwrap()).abs() > 1.0 / fps.unwrap() {
        return Err(
            "Video frame timing is invalid; export it again at a constant frame rate".into(),
        );
    }
    Ok(result["output"].clone())
}

pub(super) fn stage_media(
    paths: &MediaRuntimePaths,
    directory: &Path,
    asset_id: &str,
    kind: &str,
    name: &str,
) -> MediaResult<PathBuf> {
    let record = database::get_asset(paths, asset_id)?;
    if record.kind != kind
        || (kind == "video" && record.mime_type != "video/webm")
        || (kind == "audio" && record.mime_type != "audio/wav")
    {
        return Err(format!("Choose a {kind} asset"));
    }
    let (_, bytes) = transform::read_asset_original(paths, asset_id)?;
    let file = directory.join(name);
    fs::write(&file, bytes).map_err(|error| format!("Could not stage {kind}: {error}"))?;
    Ok(file)
}

pub(crate) fn compose_video(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    run_id: &str,
    video_asset_ids: &[String],
    audio_asset_id: Option<&str>,
    audio_start_seconds: f64,
    sequence: bool,
) -> MediaResult<(serde_json::Value, GeneratedImageAsset)> {
    if !(1..=8).contains(&video_asset_ids.len())
        || (sequence && video_asset_ids.len() < 2)
        || (!sequence && (video_asset_ids.len() != 1 || audio_asset_id.is_none()))
        || !audio_start_seconds.is_finite()
        || !(0.0..=86400.0).contains(&audio_start_seconds)
    {
        return Err("Connect the videos and check the audio start time".into());
    }
    let (script, python) = media_worker(app)?;
    let staging = create_staging_directory(paths)?;
    let mut inputs = Vec::new();
    for (index, id) in video_asset_ids.iter().enumerate() {
        inputs.push(serde_json::json!({"path": stage_media(paths, &staging.0, id, "video", &format!("scene-{index}.webm"))?}));
    }
    let mut request = serde_json::json!({
        "outputDirectory": staging.0.join("output"),
        "audioStartSeconds": audio_start_seconds,
    });
    if sequence {
        request["inputs"] = serde_json::json!(inputs);
    } else {
        request["inputPath"] = inputs[0]["path"].clone();
    }
    if let Some(id) = audio_asset_id {
        request["audioPath"] = serde_json::json!(stage_media(
            paths,
            &staging.0,
            id,
            "audio",
            "soundtrack.wav"
        )?);
    }
    let output = run_worker(
        &python,
        &script,
        if sequence {
            "video-sequence"
        } else {
            "video-audio"
        },
        Some(&serde_json::to_vec(&request).map_err(|error| error.to_string())?),
        Duration::from_secs(1800),
        Some((paths, run_id)),
    )?;
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        worker_failure_with_diagnostics(
            format!("Video composition returned invalid JSON: {error}"),
            &output.stderr,
        )
    })?;
    if !output.status.success() || result.get("error").is_some() {
        return Err(worker_failure_with_diagnostics(
            result["error"]
                .as_str()
                .unwrap_or("Video composition failed")
                .to_string(),
            &output.stderr,
        ));
    }
    publish_video_output(paths, &staging.0, result, audio_asset_id.is_some())
}

pub(super) fn publish_video_output(
    paths: &MediaRuntimePaths,
    staging: &Path,
    result: serde_json::Value,
    require_audio: bool,
) -> MediaResult<(serde_json::Value, GeneratedImageAsset)> {
    let metadata = &result["output"];
    let width = metadata["width"]
        .as_u64()
        .filter(|value| (1..=16384).contains(value))
        .ok_or("Invalid video width")?;
    let height = metadata["height"]
        .as_u64()
        .filter(|value| (1..=16384).contains(value))
        .ok_or("Invalid video height")?;
    let frames = metadata["numFrames"]
        .as_u64()
        .filter(|value| *value > 0)
        .ok_or("Invalid video frame count")?;
    let fps = metadata["fps"]
        .as_f64()
        .filter(|value| value.is_finite() && (1.0..=120.0).contains(value))
        .ok_or("Invalid video frame rate")?;
    let duration = metadata["durationSeconds"]
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or("Invalid video duration")?;
    if result["schemaVersion"] != 1
        || metadata["fileName"] != "output.webm"
        || metadata["hasAudio"].as_bool().is_none()
        || (require_audio && metadata["hasAudio"] != true)
        || (duration - frames as f64 / fps).abs() > 1.0 / fps
    {
        return Err("Video composition returned inconsistent metadata".into());
    }
    let file = staging.join("output/output.webm");
    let file_metadata = fs::symlink_metadata(&file).map_err(|error| error.to_string())?;
    if !file_metadata.is_file()
        || file_metadata.file_type().is_symlink()
        || file_metadata.len() > 512 * 1024 * 1024
    {
        return Err("Video composition output must be a regular file under 512 MB".into());
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    if !bytes.starts_with(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Err("Video composition did not produce WebM".into());
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let relative_path = transform::cas_relative_path(&digest);
    transform::publish_cas_bytes(paths, &relative_path, &digest, &bytes)?;
    Ok((
        result,
        GeneratedImageAsset {
            digest,
            relative_path: relative_path.to_string_lossy().into_owned(),
            byte_size: bytes.len() as u64,
            mime_type: "video/webm",
            width: width as u32,
            height: height as u32,
            output_index: 0,
            subject_cutout: None,
        },
    ))
}
