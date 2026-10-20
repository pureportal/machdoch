use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

pub const VERSION: &str = "0.9.2-drama3-base-small";
pub const UNSUPPORTED_PLATFORM: &str = "Local Drama 3 requires Windows x64 or Linux x64. Choose another speech profile on this device.";

pub fn supported() -> bool { cfg!(all(target_arch = "x86_64", any(target_os = "windows", target_os = "linux"))) }

#[derive(serde::Deserialize)]
pub struct Model {
    pub repository: String,
    pub revision: String,
    pub filename: String,
    pub sha256: String,
    pub bytes: u64,
}

pub fn model() -> Model {
    #[derive(serde::Deserialize)]
    struct Assets { model: Model }
    serde_json::from_str::<Assets>(include_str!("../../../scripts/drama3-assets.json")).expect("validated bundled Drama 3 manifest").model
}

pub fn directory() -> PathBuf { Path::new(super::settings::model_root()).join("speech/drama3") }
pub fn path() -> PathBuf { directory().join(model().filename) }

struct Download { state: &'static str, bytes: u64, error: Option<String>, cancel: CancellationToken }
static DOWNLOAD: OnceLock<Arc<Mutex<Download>>> = OnceLock::new();
pub(super) static GENERATION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

fn download() -> &'static Arc<Mutex<Download>> {
    DOWNLOAD.get_or_init(|| Arc::new(Mutex::new(Download { state: "idle", bytes: 0, error: None, cancel: CancellationToken::new() })))
}

pub fn installed() -> bool {
    let expected = model();
    let Ok(metadata) = std::fs::symlink_metadata(path()) else { return false };
    if !metadata.is_file() || metadata.len() != expected.bytes { return false }
    let Ok(receipt) = std::fs::read(directory().join("installed.json")) else { return false };
    let Ok(receipt) = serde_json::from_slice::<Value>(&receipt) else { return false };
    let modified = metadata.modified().ok().and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map(|time| time.as_nanos().to_string());
    receipt["sha256"] == expected.sha256 && receipt["modified"].as_str() == modified.as_deref()
}

pub fn connection() -> Value {
    let ready = supported() && installed();
    json!({"backend":"drama3","configured":ready,"healthy":if ready { Some(true) } else { None },"error":if supported() { None } else { Some(UNSUPPORTED_PLATFORM) },"runtimeVersion":format!("audio.cpp/{VERSION}:{}",model().sha256),"model":"drama-3","nativeRevision":false,"maxTextBytes":null,"maxSpeakers":16})
}

pub fn status() -> Result<Value, String> {
    if !supported() { return Err(UNSUPPORTED_PLATFORM.into()) }
    let mut current = download().lock().map_err(|_| "The model download state is unavailable.")?;
    if current.state == "idle" {
        if let Ok(metadata) = std::fs::symlink_metadata(path().with_extension("gguf.part")) {
            if metadata.is_file() && metadata.len() > 0 {
                current.state = "paused";
                current.bytes = metadata.len();
            }
        }
    }
    let model = model();
    Ok(json!({"state":if installed() { "installed" } else { current.state },"bytes":current.bytes,"totalBytes":model.bytes,"error":current.error,"path":path(),"licenseUrl":format!("https://huggingface.co/{}/blob/{}/LICENSE",model.repository,model.revision)}))
}

pub fn execute(operation: &str, input: &Value) -> Result<Value, String> {
    match operation {
        "runtimeModelStatus" => status(),
        "runtimeInstallModel" => {
            if input["acceptLicense"] != true { return Err("Accept the Fish Audio Community License before downloading the model.".into()) }
            if !supported() { return Err(UNSUPPORTED_PLATFORM.into()) }
            if installed() { return status() }
            let mut state = download().lock().map_err(|_| "The model download state is unavailable.")?;
            if matches!(state.state, "downloading" | "verifying") { return Err("Drama 3 is already downloading.".into()) }
            state.state = "downloading";
            state.error = None;
            let cancel = CancellationToken::new();
            state.cancel = cancel.clone();
            drop(state);
            tokio::spawn(async move {
                let result = install(&cancel).await;
                if let Ok(mut state) = download().lock() {
                    match result {
                        Ok(()) => { state.state = "installed"; state.bytes = model().bytes; },
                        Err(_) if cancel.is_cancelled() => { state.state = "paused"; },
                        Err(error) => { state.state = "failed"; state.error = Some(error); },
                    }
                }
            });
            status()
        },
        "runtimeCancelDownload" => {
            download().lock().map_err(|_| "The model download state is unavailable.")?.cancel.cancel();
            status()
        },
        "runtimeRemoveModel" => {
            let _slot = GENERATION.try_acquire().map_err(|_| "Stop local speech generation before removing its model.")?;
            let mut state = download().lock().map_err(|_| "The model download state is unavailable.")?;
            if matches!(state.state, "downloading" | "verifying") { return Err("Pause the model download before removing it.".into()) }
            for file in [path(), path().with_extension("gguf.part"), directory().join("installed.json"), directory().join("installed.json.part")] {
                match std::fs::remove_file(file) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(error) => return Err(format!("The model could not be removed: {error}")) }
            }
            state.state = "idle";
            state.bytes = 0;
            state.error = None;
            drop(state);
            status()
        },
        _ => Err("Choose a supported local model operation.".into()),
    }
}

async fn install(cancel: &CancellationToken) -> Result<(), String> {
    tokio::select! { biased; _ = cancel.cancelled() => Err("Download paused.".into()), result = install_files(cancel) => result }
}

async fn install_files(cancel: &CancellationToken) -> Result<(), String> {
    use futures_util::StreamExt;
    let model = model();
    tokio::fs::create_dir_all(directory()).await.map_err(|error| format!("Model storage could not be created: {error}"))?;
    let final_path = path();
    let partial = if final_path.exists() { final_path.clone() } else { final_path.with_extension("gguf.part") };
    let offset = match tokio::fs::symlink_metadata(&partial).await {
        Ok(metadata) if metadata.is_file() && metadata.len() <= model.bytes => metadata.len(),
        Ok(_) => return Err("Remove the invalid partial model file before downloading again.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(error) => return Err(format!("The partial model could not be read: {error}")),
    };
    let available = crate::storage_space::available_storage_bytes(&directory()).ok_or("Free model storage could not be measured. Check the model drive.")?;
    if available < model.bytes - offset + 1024 * 1024 { return Err("There is not enough space for Drama 3. Free space on the model drive and resume the download.".into()) }
    download().lock().map_err(|_| "The model download state is unavailable.")?.bytes = offset;
    let client = reqwest::Client::builder().connect_timeout(std::time::Duration::from_secs(30)).read_timeout(std::time::Duration::from_secs(90)).build().map_err(|error| error.to_string())?;
    let base = format!("https://huggingface.co/{}/resolve/{}", model.repository, model.revision);
    if offset < model.bytes {
        let mut request = client.get(format!("{base}/{}", model.filename));
        if offset > 0 { request = request.header(reqwest::header::RANGE, format!("bytes={offset}-")); }
        let response = request.send().await.map_err(|error| format!("The model download failed: {error}. Resume the download to retry."))?;
        if !(offset == 0 && response.status() == reqwest::StatusCode::OK || offset > 0 && response.status() == reqwest::StatusCode::PARTIAL_CONTENT && response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok()).is_some_and(|value| value == format!("bytes {offset}-{}/{}", model.bytes - 1, model.bytes))) {
            return Err(format!("The model download returned HTTP {} or an invalid resume range. Retry the download.", response.status()));
        }
        let mut file = tokio::fs::OpenOptions::new().create(true).append(true).open(&partial).await.map_err(|error| format!("The model download file could not be opened: {error}"))?;
        let mut stream = response.bytes_stream();
        let mut bytes = offset;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("The model download stopped: {error}. Resume to continue."))?;
            bytes += chunk.len() as u64;
            if bytes > model.bytes { return Err("The model download exceeds its published size.".into()) }
            file.write_all(&chunk).await.map_err(|error| format!("The model could not be saved: {error}. Check free disk space."))?;
            download().lock().map_err(|_| "The model download state is unavailable.")?.bytes = bytes;
        }
        file.sync_all().await.map_err(|error| error.to_string())?;
    }
    download().lock().map_err(|_| "The model download state is unavailable.")?.state = "verifying";
    verify(&partial, &model, cancel).await?;
    for name in ["LICENSE", "NOTICE"] {
        let response = client.get(format!("{base}/{name}")).send().await.map_err(|error| error.to_string())?.error_for_status().map_err(|error| error.to_string())?;
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if bytes.len() > 128 * 1024 { return Err("The model license file exceeds its expected size.".into()) }
        tokio::fs::write(directory().join(name), bytes).await.map_err(|error| error.to_string())?;
    }
    let metadata = tokio::fs::metadata(&partial).await.map_err(|error| error.to_string())?;
    let modified = metadata.modified().map_err(|error| error.to_string())?.duration_since(std::time::UNIX_EPOCH).map_err(|error| error.to_string())?.as_nanos().to_string();
    let receipt = json!({"sha256":model.sha256,"revision":model.revision,"modified":modified,"acceptedLicenseAt":super::timestamp()});
    let receipt_path = directory().join("installed.json.part");
    tokio::fs::write(&receipt_path, receipt.to_string()).await.map_err(|error| format!("The model installation record could not be saved: {error}"))?;
    if cancel.is_cancelled() { return Err("Download paused.".into()) }
    if partial != final_path { std::fs::rename(&partial, &final_path).map_err(|error| format!("The verified model could not be installed: {error}"))?; }
    std::fs::rename(receipt_path, directory().join("installed.json")).map_err(|error| format!("The model installation record could not be committed: {error}"))?;
    Ok(())
}

async fn verify(path: &Path, model: &Model, cancel: &CancellationToken) -> Result<(), String> {
    let mut file = tokio::fs::File::open(path).await.map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut bytes = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        if cancel.is_cancelled() { return Err("Download paused.".into()) }
        let count = file.read(&mut buffer).await.map_err(|error| error.to_string())?;
        if count == 0 { break }
        bytes += count as u64;
        digest.update(&buffer[..count]);
    }
    if bytes != model.bytes { return Err("The model download is incomplete. Resume it to finish.".into()) }
    if format!("{:x}", digest.finalize()) != model.sha256 {
        tokio::fs::remove_file(path).await.map_err(|error| format!("The corrupt download could not be removed: {error}"))?;
        return Err("Model verification failed. Download the model again.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn verifies_model_bytes_and_removes_corrupt_downloads() {
        let path = std::env::temp_dir().join(format!("drama3-integrity-{}", super::super::identifier().unwrap()));
        let mut model = Model { repository: String::new(), revision: String::new(), filename: String::new(), sha256: format!("{:x}", Sha256::digest(b"model")), bytes: 5 };
        tokio::fs::write(&path, b"model").await.unwrap();
        verify(&path, &model, &CancellationToken::new()).await.unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(verify(&path, &model, &cancel).await.unwrap_err().contains("paused"));
        assert!(path.exists());
        model.bytes = 6;
        assert!(verify(&path, &model, &CancellationToken::new()).await.unwrap_err().contains("incomplete"));
        assert!(path.exists());
        model.bytes = 5;
        tokio::fs::write(&path, b"wrong").await.unwrap();
        assert!(verify(&path, &model, &CancellationToken::new()).await.unwrap_err().contains("verification failed"));
        assert!(!path.exists());
    }

    #[test]
    fn requires_license_acceptance_and_pins_all_model_components() {
        assert!(execute("runtimeInstallModel", &json!({"acceptLicense":false})).unwrap_err().contains("License"));
        let model = model();
        assert_eq!(model.bytes, 17_053_639_872);
        assert_eq!(model.sha256.len(), 64);
        assert_eq!(model.revision.len(), 40);
    }

    #[ignore = "downloads and verifies the published 15.9 GiB model"]
    #[tokio::test]
    async fn installs_published_drama3_model() {
        install(&CancellationToken::new()).await.unwrap();
        assert!(installed());
        assert_eq!(status().unwrap()["state"], "installed");
    }
}
