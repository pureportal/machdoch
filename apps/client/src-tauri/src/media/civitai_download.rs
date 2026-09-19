use super::{
    civitai_addon::{SelectedFile, MAX_RESOURCE_BYTES},
    hardware, model_import, MediaResult, MediaRuntimePaths,
};
use reqwest::{redirect::Policy, Client, StatusCode, Url};
use sha2::{Digest as _, Sha256};
use std::time::Duration;
use tokio::io::AsyncWriteExt as _;

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
    progress: impl Fn(u64, u64) -> MediaResult<()>,
) -> MediaResult<String> {
    let models_root = paths.models_root()?;
    let imports_root = models_root.join("civitai-imports");
    tokio::fs::create_dir_all(&imports_root)
        .await
        .map_err(|error| format!("failed to prepare Civitai import storage: {error}"))?;
    let required_bytes = selected.public.byte_size.saturating_mul(210).div_ceil(100);
    if hardware::available_storage_bytes(&imports_root).map(|available| available < required_bytes)
        == Some(true)
    {
        return Err("The Media Studio model volume does not have enough free space".to_string());
    }
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
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("Civitai download failed: {}", error.without_url()))?;
    match response.status() {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
            return Err(
                "Civitai denied this download. Connect an API key with access to this resource and try again."
                    .to_string(),
            )
        }
        status if !status.is_success() => {
            return Err(format!("Civitai add-on download returned HTTP {status}"))
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
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)
        .await
        .map_err(|error| format!("failed to create Civitai download staging file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut byte_size = 0_u64;
    let download_result: MediaResult<()> = async {
        loop {
            let chunk = tokio::select! {
                chunk = response.chunk() => chunk.map_err(|error| format!("Civitai download interrupted: {}", error.without_url()))?,
                _ = tokio::time::sleep(Duration::from_millis(200)) => {
                    progress(byte_size, selected.public.byte_size)?;
                    continue;
                }
            };
            let Some(chunk) = chunk else { break; };
            progress(byte_size, selected.public.byte_size)?;
            byte_size = byte_size.saturating_add(chunk.len() as u64);
            if byte_size > selected.public.byte_size.saturating_add(16) || byte_size > MAX_RESOURCE_BYTES {
                return Err("The Civitai download exceeded the reviewed size limit".to_string());
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("failed to write Civitai add-on staging data: {error}"))?;
        }
        progress(selected.public.byte_size, selected.public.byte_size)?;
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
