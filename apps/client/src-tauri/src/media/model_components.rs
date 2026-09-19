use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

use super::{hardware, model_import, runtime_setup::installer, MediaResult, MediaRuntimePaths};
use reqwest::{blocking::Client, header, StatusCode};
use serde::Deserialize;

#[derive(Deserialize)]
struct ComponentFile {
    path: String,
    url: String,
    bytes: u64,
    sha256: String,
}

fn regular_file(path: &Path) -> MediaResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(format!(
            "Model component must be a regular file: {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn matches_file(path: &Path, component: &ComponentFile) -> MediaResult<bool> {
    if !regular_file(path)?
        || fs::metadata(path).map_err(|e| e.to_string())?.len() != component.bytes
    {
        return Ok(false);
    }
    let (_, digest) = model_import::hash_file(path)?;
    Ok(digest == component.sha256)
}

fn download(client: &Client, destination: &Path, component: &ComponentFile) -> MediaResult<()> {
    let partial = destination.with_extension("download");
    let existing = if regular_file(&partial)? {
        fs::metadata(&partial).map_err(|e| e.to_string())?.len()
    } else {
        0
    };
    let offset = if existing < component.bytes {
        existing
    } else {
        0
    };
    let mut request = client.get(&component.url);
    if offset > 0 {
        request = request.header(header::RANGE, format!("bytes={offset}-"));
    }
    let mut response = request
        .send()
        .map_err(|e| format!("Component download failed. Check your connection and retry: {e}"))?;
    let resume = offset > 0 && response.status() == StatusCode::PARTIAL_CONTENT;
    if resume
        && response
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            != Some(format!("bytes {offset}-{}/{}", component.bytes - 1, component.bytes).as_str())
    {
        return Err(
            "Component download returned an invalid resume range. Retry import.".to_string(),
        );
    }
    if !response.status().is_success() {
        return Err(format!(
            "Component download returned {}. Retry import.",
            response.status()
        ));
    }
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .append(resume)
        .truncate(!resume)
        .open(&partial)
        .map_err(|e| e.to_string())?;
    let mut total = if resume { offset } else { 0 };
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        let count = response.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > component.bytes {
            return Err("Component download exceeded its expected size".to_string());
        }
        file.write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
    }
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    if !matches_file(&partial, component)? {
        fs::remove_file(&partial).map_err(|e| e.to_string())?;
        return Err("A downloaded component did not pass verification. Retry import.".to_string());
    }
    if regular_file(destination)? {
        fs::remove_file(destination).map_err(|e| e.to_string())?;
    }
    fs::rename(&partial, destination).map_err(|e| e.to_string())
}

pub(super) fn ensure_krea_components(root: &Path) -> MediaResult<PathBuf> {
    ensure_components(root, include_str!("krea_components.json"))
}

pub(super) fn ensure_sd_config(root: &Path, architecture: &str) -> MediaResult<PathBuf> {
    let manifest = match architecture {
        "stable-diffusion-1" => include_str!("sd15_components.json"),
        "stable-diffusion-xl" | "pony" => include_str!("sdxl_components.json"),
        _ => return Err("Unsupported Stable Diffusion component family".to_string()),
    };
    ensure_components(root, manifest)
}

pub(super) fn ensure_ip_adapter(
    paths: &MediaRuntimePaths,
    architecture: &str,
) -> MediaResult<PathBuf> {
    let manifest = match architecture {
        "stable-diffusion-1" => include_str!("ip_adapter_sd15_components.json"),
        "stable-diffusion-xl" | "pony" => include_str!("ip_adapter_sdxl_components.json"),
        _ => return Err("Unsupported image adapter family".to_string()),
    };
    let root = paths.models_root()?.join("components").join("ip-adapter");
    ensure_components(&root, include_str!("ip_adapter_encoder_components.json"))?;
    ensure_components(&root, manifest)
}

pub(super) fn ensure_components(root: &Path, manifest: &str) -> MediaResult<PathBuf> {
    installer::validate_directory(root)?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let lock_path = root.join("components.lock");
    regular_file(&lock_path)?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    lock.try_lock().map_err(|_| {
        "Another model is installing shared components. Retry when it finishes.".to_string()
    })?;
    let files: Vec<ComponentFile> = serde_json::from_str(manifest).map_err(|e| e.to_string())?;
    let client = Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(90 * 60))
        .build()
        .map_err(|e| e.to_string())?;
    for component in files {
        let mut directory = root.clone();
        let relative = Path::new(&component.path);
        if relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("Invalid component path".to_string());
        }
        for part in relative.parent().unwrap().components() {
            directory.push(part);
            installer::validate_directory(&directory)?;
            if !fs::canonicalize(&directory)
                .map_err(|e| e.to_string())?
                .starts_with(&root)
            {
                return Err("Model component directory is outside its storage root".to_string());
            }
        }
        let destination = root.join(&component.path);
        if matches_file(&destination, &component)? {
            continue;
        }
        if hardware::available_storage_bytes(&root).is_some_and(|free| free < component.bytes) {
            return Err("Free up disk space for model components, then retry import.".to_string());
        }
        download(&client, &destination, &component)?;
    }
    Ok(root)
}
