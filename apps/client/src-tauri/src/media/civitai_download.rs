use super::{
    civitai_addon::{SelectedFile, MAX_RESOURCE_BYTES},
    civitai_storage, model_import, MediaResult, MediaRuntimePaths,
};
use reqwest::{redirect::Policy, Client, StatusCode, Url};
use sha2::{Digest as _, Sha256};
use std::time::Duration;
use tokio::io::AsyncWriteExt as _;

static DOWNLOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub(super) fn is_allowed_download_redirect(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.host_str() {
        Some(
            "civitai.com" | "www.civitai.com" | "civitai.red" | "www.civitai.red"
            | "b2.civitai.com",
        ) => true,
        Some(host) => {
            host.starts_with("civitai-delivery-worker-prod.")
                && host.ends_with(".r2.cloudflarestorage.com")
        }
        None => false,
    }
}

fn download_client() -> MediaResult<Client> {
    Client::builder()
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 || !is_allowed_download_redirect(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60 * 60))
        .read_timeout(Duration::from_secs(60))
        .user_agent("machdoch-media-studio/1.0")
        .build()
        .map_err(|error| format!("failed to prepare Civitai download client: {error}"))
}

pub(super) async fn download_selected(
    paths: &MediaRuntimePaths,
    selected: &SelectedFile,
    progress: impl Fn(u64, u64, Option<civitai_storage::CivitaiStorage>) -> MediaResult<()>,
) -> MediaResult<String> {
    let lock = DOWNLOAD_LOCK.lock();
    tokio::pin!(lock);
    let _download_guard = loop {
        tokio::select! {
            guard = &mut lock => break guard,
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                progress(0, selected.public.byte_size, None)?;
            }
        }
    };
    progress(0, selected.public.byte_size, None)?;
    let models_root = paths.models_root()?;
    let imports_root = models_root.join("civitai-imports");
    tokio::fs::create_dir_all(&imports_root)
        .await
        .map_err(|error| format!("failed to prepare Civitai import storage: {error}"))?;
    let destination_root = imports_root.join("sha256").join(&selected.public.sha256);
    let destination = destination_root.join("addon.safetensors");
    if destination.exists() {
        let destination_for_hash = destination.clone();
        let (bytes, digest) = tauri::async_runtime::spawn_blocking(move || {
            model_import::hash_file(&destination_for_hash)
        })
        .await
        .map_err(|error| format!("Civitai cache verification worker failed: {error}"))??;
        if bytes.abs_diff(selected.public.byte_size) <= 16 && digest == selected.public.sha256 {
            return Ok(destination.to_string_lossy().into_owned());
        }
        return Err(
            "The managed Civitai download cache conflicts with the reviewed SHA-256".to_string(),
        );
    }

    let storage = civitai_storage::check(&imports_root, selected.public.byte_size, 0)?;
    if let Some(reason) = &storage.blocking_reason {
        return Err(reason.clone());
    }
    progress(0, selected.public.byte_size, Some(storage))?;
    let import_id = model_import::new_import_id()?;
    let staging_root = imports_root.join("staging");
    tokio::fs::create_dir_all(&staging_root)
        .await
        .map_err(|error| format!("failed to prepare Civitai download staging: {error}"))?;
    let partial = staging_root.join(format!("{import_id}.safetensors.part"));
    let client = download_client()?;
    let mut request = client
        .get(selected.download_url.clone())
        .header(reqwest::header::ACCEPT, "application/octet-stream");
    if let Some(token) = super::civitai_catalog::api_key()? {
        request = request.bearer_auth(token);
    }
    let response = request.send();
    tokio::pin!(response);
    let mut response = loop {
        tokio::select! {
            result = &mut response => break result.map_err(|error| format!("Civitai download failed: {}", error.without_url()))?,
            _ = tokio::time::sleep(Duration::from_millis(200)) => {
                progress(0, selected.public.byte_size, None)?;
            }
        }
    };
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err(
                "Civitai denied this download. Save an API key with access to this model in Settings, then try again."
                    .to_string(),
            )
        }
        status if !status.is_success() => {
            return Err(format!("Civitai download returned HTTP {status}"))
        }
        _ => {}
    }
    if !is_allowed_download_redirect(response.url()) {
        return Err("Civitai redirected the download to an unapproved host".to_string());
    }
    if response
        .content_length()
        .map(|value| value.abs_diff(selected.public.byte_size) > 16)
        == Some(true)
    {
        return Err("Civitai download size does not match the reviewed file metadata".to_string());
    }
    let storage = civitai_storage::check(&imports_root, selected.public.byte_size, 0)?;
    if let Some(reason) = &storage.blocking_reason {
        return Err(reason.clone());
    }
    progress(0, selected.public.byte_size, Some(storage))?;
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)
        .await
        .map_err(|error| format!("failed to create Civitai download staging file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut byte_size = 0_u64;
    let mut last_storage_check = std::time::Instant::now();
    let download_result: MediaResult<()> = async {
        loop {
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|error| format!("Civitai download interrupted: {}", error.without_url()))?,
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    progress(byte_size, selected.public.byte_size, None)?;
                    continue;
                }
            };
            let Some(chunk) = chunk else { break; };
            progress(byte_size, selected.public.byte_size, None)?;
            byte_size = byte_size.saturating_add(chunk.len() as u64);
            if byte_size > selected.public.byte_size.saturating_add(16) || byte_size > MAX_RESOURCE_BYTES {
                return Err("The Civitai download exceeded the reviewed size limit".to_string());
            }
            if last_storage_check.elapsed() >= Duration::from_secs(1) {
                let storage = civitai_storage::check(&imports_root, selected.public.byte_size, byte_size.saturating_sub(chunk.len() as u64))?;
                if let Some(reason) = &storage.blocking_reason {
                    return Err(reason.clone());
                }
                progress(byte_size, selected.public.byte_size, Some(storage))?;
                last_storage_check = std::time::Instant::now();
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("failed to write Civitai add-on staging data: {error}"))?;
        }
        progress(selected.public.byte_size, selected.public.byte_size, None)?;
        file.flush()
            .await
            .map_err(|error| format!("failed to flush Civitai add-on staging data: {error}"))?;
        file.sync_all().await.map_err(|error| {
            format!("failed to synchronize Civitai add-on staging data: {error}")
        })?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(error) = download_result {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(error);
    }
    let digest = format!("{:x}", hasher.finalize());
    if byte_size.abs_diff(selected.public.byte_size) > 16 || digest != selected.public.sha256 {
        let _ = tokio::fs::remove_file(&partial).await;
        return Err(
            "The downloaded Civitai bytes failed SHA-256 or byte-size verification".to_string(),
        );
    }
    tokio::fs::create_dir_all(&destination_root)
        .await
        .map_err(|error| format!("failed to prepare verified Civitai cache entry: {error}"))?;
    tokio::fs::rename(&partial, &destination)
        .await
        .map_err(|error| format!("failed to publish verified Civitai download: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn queued_download_can_cancel_while_another_transfer_holds_the_lock() {
        let _active = DOWNLOAD_LOCK.lock().await;
        let root = std::env::temp_dir().join("machdoch-civitai-wait-test");
        let paths = MediaRuntimePaths {
            _storage_lease: None,
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        };
        let selected = SelectedFile {
            public: serde_json::from_value(serde_json::json!({
                "id": 1, "name": "model.safetensors", "byteSize": 1000,
                "sha256": "a".repeat(64), "pickleScanResult": "Success", "virusScanResult": "Success", "scannedAt": null
            })).unwrap(),
            download_url: Url::parse("https://civitai.com/api/download/models/1").unwrap(),
        };
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            download_selected(&paths, &selected, |_, _, _| {
                Err("Download cancelled".to_string())
            }),
        )
        .await;
        assert_eq!(result.unwrap().unwrap_err(), "Download cancelled");
    }
}
