use super::{drama3_model, SpeechService};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

use super::drama3_model::VERSION;

fn executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if !drama3_model::supported() { return Err(drama3_model::UNSUPPORTED_PLATFORM.into()) }
    let root = if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/speech/drama3")
    } else {
        app.path().resource_dir().map_err(|_| "The bundled speech engine could not be located.")?.join("speech/drama3")
    };
    let name = if cfg!(windows) { "audiocpp_cli.exe" } else { "audiocpp_cli" };
    let manifest: Value = serde_json::from_slice(&std::fs::read(root.join("runtime.json")).map_err(|_| "The bundled Drama 3 engine is missing. Reinstall Machdoch.")?).map_err(|_| "The bundled Drama 3 engine inventory is damaged. Reinstall Machdoch.")?;
    if manifest["version"] != VERSION { return Err("The bundled Drama 3 engine version is incorrect. Reinstall Machdoch.".into()) }
    let files = manifest["files"].as_object().filter(|files| files.contains_key(name)).ok_or("The speech engine inventory is incomplete. Reinstall Machdoch.")?;
    for (name, digest) in files {
        if name.contains(['/', '\\']) || name == "." || name == ".." || digest.as_str().is_none_or(|digest| digest.len() != 64) { return Err("The speech engine inventory is invalid. Reinstall Machdoch.".into()) }
        let file = root.join(name);
        if std::fs::symlink_metadata(&file).map_err(|error| error.to_string())?.file_type().is_symlink() || super::exports::hash_file(&file)? != digest.as_str().ok_or("The speech engine digest is missing.")? {
            return Err("A bundled speech engine file changed. Reinstall Machdoch.".into());
        }
    }
    Ok(root.join(name))
}

fn command(executable: &Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(executable);
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    #[cfg(target_os = "linux")]
    command.env("LD_LIBRARY_PATH", executable.parent().unwrap_or(Path::new(".")));
    command
}

fn gpu_index(devices: &str) -> Result<String, String> {
    devices.lines().filter(|line| line.ends_with("[GPU]")).find_map(|line| {
        let (backend, rest) = line.split_once(':')?;
        if backend != "Vulkan" { return None }
        let index = rest.split_whitespace().next()?;
        index.bytes().all(|byte| byte.is_ascii_digit()).then(|| index.to_string())
    }).ok_or_else(|| "No dedicated Vulkan GPU was found. Install the current graphics driver and restart Machdoch.".into())
}

pub async fn check(app: &tauri::AppHandle) -> Result<Value, String> {
    let app = app.clone();
    let executable = tauri::async_runtime::spawn_blocking(move || executable(&app)).await.map_err(|_| "The speech engine check could not finish.")??;
    let devices = tokio::time::timeout(std::time::Duration::from_secs(30), command(&executable).arg("--list-devices").output()).await.map_err(|_| "The Vulkan device check timed out. Restart the graphics driver.")?.map_err(|error| format!("The bundled speech engine could not start: {error}"))?;
    if !devices.status.success() { return Err("The bundled speech engine could not enumerate Vulkan GPUs. Check the graphics driver.".into()) }
    let index = gpu_index(&String::from_utf8_lossy(&devices.stdout))?;
    Ok(json!({"device":index,"executable":executable}))
}

pub async fn render(service: &Arc<SpeechService>, snapshot: &Value, segment: &Value, output: &Path, cancel: CancellationToken) -> Result<(f64, u32, u16), String> {
    let _slot = tokio::select! { biased; _ = cancel.cancelled() => return Err("Speech cancelled.".into()), slot = drama3_model::GENERATION.acquire() => slot.map_err(|_| "The local speech engine is unavailable.")? };
    if !drama3_model::installed() { return Err("Download Drama 3 in Text to Speech settings before generating.".into()) }
    let engine = tokio::select! { biased; _ = cancel.cancelled() => return Err("Speech cancelled.".into()), engine = check(&service.app) => engine? };
    let work = output.with_extension("drama3");
    tokio::fs::create_dir(&work).await.map_err(|error| format!("Speech working storage could not be created: {error}"))?;
    let result = generate(service, snapshot, segment, output, &work, &engine, &cancel).await;
    tokio::fs::remove_dir_all(&work).await.map_err(|error| format!("Speech working files could not be removed: {error}"))?;
    result
}

async fn generate(service: &Arc<SpeechService>, snapshot: &Value, segment: &Value, output: &Path, work: &Path, engine: &Value, cancel: &CancellationToken) -> Result<(f64, u32, u16), String> {
    let profile = &snapshot["profile"];
    let text = super::contracts::provider_text(segment, profile)?;
    let direction = profile["direction"].as_str().ok_or("The speech direction is missing.")?;
    let text = if direction.is_empty() { text } else { format!("[{direction}]{text}") };
    let ids = segment["referenceAssetIds"].as_array().ok_or("The reference list is missing.")?;
    let mut references = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        let id = id.as_str().ok_or("The reference identity is invalid.")?;
        let transcript = snapshot["references"][id]["transcript"].as_str().ok_or("The pinned reference transcript is missing.")?;
        let mut asset = super::asset_io::open(service, id, Some(cancel))?;
        let target = work.join(format!("reference-{index}.wav"));
        tokio::fs::write(&target, asset.read_bytes(16 * 1024 * 1024)?).await.map_err(|error| error.to_string())?;
        let speaker = segment["referenceGroups"].as_array().and_then(|groups| groups.iter().position(|group| group.as_array().is_some_and(|group| group.iter().any(|value| value.as_str() == Some(id)))));
        let text = speaker.map_or_else(|| transcript.to_string(), |speaker| format!("<|speaker:{speaker}|> {transcript}"));
        references.push(json!({"audio_path":target,"text":text}));
    }
    let mut options = json!({"temperature":profile["temperature"],"top_p":profile["topP"],"max_tokens":500,"text_chunk_size":128,"text_chunk_mode":"tag_aware"});
    if !references.is_empty() { options["multi_reference_cond"] = json!(serde_json::to_string(&references).map_err(|_| "The voice references could not be encoded.")?); }
    let request = work.join("request.json");
    tokio::fs::write(&request, json!([{"text":text,"options":options}]).to_string()).await.map_err(|error| error.to_string())?;
    let log_path = work.join("engine.log");
    let log = std::fs::File::create(&log_path).map_err(|error| error.to_string())?;
    let executable = Path::new(engine["executable"].as_str().ok_or("The native speech engine is missing.")?);
    let mut command = command(executable);
    command.args(["--task", "tts", "--family", "fish_drama3", "--backend", "vulkan", "--device", engine["device"].as_str().ok_or("The Vulkan GPU is missing.")?, "--model-spec-override", "embedded", "--mode", "offline", "--batch-merge-audio", "concat", "--out-format", "pcm16", "--threads", "8", "--session-option", "fish_drama3.cpu_expert_layers=8", "--session-option", "fish_drama3.context_length=2048", "--session-option", "fish_drama3.codec_encoder_f32_accumulation=true"])
        .arg("--model").arg(drama3_model::path()).arg("--request-sequence").arg(request).arg("--out").arg(output)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(log);
    let mut command = command.into_std();
    let cancellation = cancel.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || -> Result<std::process::ExitStatus, String> {
        let mut child = machdoch_process::SupervisedChild::spawn_with_required_isolation(&mut command).map_err(|error| format!("The bundled Drama 3 engine could not start: {error}"))?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1800);
        loop {
            if cancellation.is_cancelled() {
                child.terminate_and_reap().map_err(|error| format!("The speech engine could not stop: {error}"))?;
                return Err("Speech cancelled.".into());
            }
            if std::time::Instant::now() >= deadline {
                child.terminate_and_reap().map_err(|error| format!("The speech engine could not stop: {error}"))?;
                return Err("Drama 3 exceeded the generation time limit. Try a shorter script.".into());
            }
            if let Some(status) = child.try_wait().map_err(|error| format!("The speech engine could not finish: {error}"))? { return Ok(status) }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });
    let status = worker.await.map_err(|_| "The speech engine worker could not finish.")??;
    if !status.success() {
        use std::io::{Read, Seek, SeekFrom};
        let mut log = std::fs::File::open(log_path).map_err(|error| error.to_string())?;
        let size = log.metadata().map_err(|error| error.to_string())?.len();
        log.seek(SeekFrom::Start(size.saturating_sub(2048))).map_err(|error| error.to_string())?;
        let mut tail = Vec::new();
        log.take(2048).read_to_end(&mut tail).map_err(|error| error.to_string())?;
        return Err(format!("Drama 3 generation failed ({status}): {}", String::from_utf8_lossy(&tail)));
    }
    let audio = super::reference_audio::inspect_wav(output)?;
    if audio.0 <= 0.0 { return Err("Drama 3 returned empty audio. Try a shorter script.".into()) }
    Ok(audio)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_dedicated_vulkan_gpu_and_requires_a_driver() {
        assert_eq!(gpu_index("Vulkan:0 \"AMD integrated\" [IGPU]\nVulkan:1 \"AMD RX 9070\" [GPU]\nCPU:0 [CPU]").unwrap(), "1");
        assert!(gpu_index("CPU:0 [CPU]").is_err());
        assert!(gpu_index("Vulkan:0 [IGPU]").is_err());
    }
}
