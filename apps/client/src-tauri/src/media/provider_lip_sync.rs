use super::*;
use super::video_composition::{media_worker, publish_video_output, stage_media};

pub(crate) struct LipSyncRequest<'a> {
    pub video_asset_id: &'a str,
    pub audio_asset_id: &'a str,
    pub voice_asset_id: Option<&'a str>,
    pub model_path: &'a str,
    pub audio_start_seconds: f64,
    pub crop_shift: i32,
    pub batch_size: u32,
    pub seed: u64,
}

pub(crate) fn lip_sync_video(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    run_id: &str,
    request: &LipSyncRequest<'_>,
) -> MediaResult<(serde_json::Value, GeneratedImageAsset)> {
    let model = Path::new(request.model_path);
    if !model.is_absolute() || !model.is_dir() {
        return Err("Choose the MuseTalk 1.5 model folder or download it in Lip sync".into());
    }
    let (script, python) = media_worker(app)?;
    let staging = create_staging_directory(paths)?;
    let video = stage_media(paths, &staging.0, request.video_asset_id, "video", "input.webm")?;
    let audio = stage_media(paths, &staging.0, request.audio_asset_id, "audio", "soundtrack.wav")?;
    let voice = request.voice_asset_id.map(|id| {
        stage_media(paths, &staging.0, id, "audio", "vocals.wav")
    }).transpose()?;
    let payload = serde_json::json!({
        "inputPath": video,
        "audioPath": audio,
        "voicePath": voice,
        "modelPath": model,
        "audioStartSeconds": request.audio_start_seconds,
        "cropShift": request.crop_shift,
        "batchSize": request.batch_size,
        "seed": request.seed,
        "outputDirectory": staging.0.join("output"),
    });
    let output = run_worker(
        &python,
        &script,
        "lip-sync",
        Some(&serde_json::to_vec(&payload).map_err(|error| error.to_string())?),
        VIDEO_GENERATION_TIMEOUT,
        Some((paths, run_id)),
    )?;
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        worker_failure_with_diagnostics(format!("Lip sync returned invalid JSON: {error}"), &output.stderr)
    })?;
    if !output.status.success() || result.get("error").is_some() {
        return Err(worker_failure_with_diagnostics(
            result["error"].as_str().unwrap_or("Lip sync failed").to_string(),
            &output.stderr,
        ));
    }
    publish_video_output(paths, &staging.0, result, true)
}
