use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    database, hardware, model_import, open_models, ImportMediaLocalModelRequest,
    MediaLocalModelImportInspection, MediaLocalModelImportResult, MediaResult, MediaRuntimePaths,
};

#[cfg(test)]
#[path = "model_package_import_tests.rs"]
mod tests;

struct PackageInventory {
    root: PathBuf,
    files: Vec<PathBuf>,
    bytes: u64,
    tensor_count: u32,
    review_token: String,
    pipeline: String,
}

fn inventory(source: &Path) -> MediaResult<PackageInventory> {
    if fs::symlink_metadata(source)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Select a regular model folder.".to_string());
    }
    let root = fs::canonicalize(source)
        .map_err(|error| format!("Could not open model folder: {error}"))?;
    let mut files = Vec::new();
    let mut pending = vec![(root.clone(), 0)];
    while let Some((directory, depth)) = pending.pop() {
        if depth > 8 {
            return Err("The model folder is nested too deeply.".to_string());
        }
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Model folders cannot contain symbolic links: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                if matches!(entry.file_name().to_str(), Some(".cache" | ".git")) {
                    continue;
                }
                pending.push((path, depth + 1));
            } else if metadata.is_file() {
                if path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        matches!(
                            extension,
                            "py" | "pyc" | "bin" | "pt" | "pth" | "ckpt" | "gguf"
                        )
                    })
                {
                    return Err(format!(
                        "Remove executable or unsupported weights from the model folder: {}",
                        path.display()
                    ));
                }
                files.push(path);
                if files.len() > 4_096 {
                    return Err("The model folder contains too many files.".to_string());
                }
            } else {
                return Err("Model folders must contain regular files.".to_string());
            }
        }
    }
    files.sort();
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let mut bytes = 0_u64;
    let mut tensor_count = 0_u32;
    for path in &files {
        if path.extension().and_then(|extension| extension.to_str()) == Some("safetensors") {
            let header =
                model_import::parse_header(path.to_str().ok_or("Model path must be valid UTF-8")?)?;
            tensor_count = tensor_count
                .checked_add(header.tensor_count)
                .ok_or("The model folder contains too many tensors")?;
        }
        let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
        bytes = bytes
            .checked_add(metadata.len())
            .ok_or("Model folder size exceeds limits")?;
        let relative = path
            .strip_prefix(&root)
            .map_err(|error| error.to_string())?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        let modified = metadata
            .modified()
            .map_err(|error| error.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?;
        hasher.update(modified.as_nanos().to_le_bytes());
    }
    let index = read_json(&root.join("model_index.json"))?;
    let pipeline = index
        .get("_class_name")
        .and_then(Value::as_str)
        .ok_or("The model folder has no pipeline class")?
        .to_string();
    if !open_models::profiles()
        .iter()
        .any(|profile| profile.pipeline == pipeline)
    {
        return Err(format!(
            "Pipeline {pipeline} has no local generation adapter."
        ));
    }
    for (name, specification) in index.as_object().ok_or("Invalid model index")? {
        let Some(component) = specification.as_array() else {
            continue;
        };
        if component.len() != 2 {
            return Err(format!("Invalid component {name}"));
        }
        if component[0].is_null() && component[1].is_null() {
            continue;
        }
        if !matches!(component[0].as_str(), Some("diffusers" | "transformers")) {
            return Err(format!("Component {name} requires custom repository code."));
        }
        let relative = Path::new(name);
        if relative.components().count() != 1
            || !matches!(relative.components().next(), Some(Component::Normal(_)))
        {
            return Err("The model index contains an unsafe component path.".to_string());
        }
        let component_root = root.join(relative);
        if !component_root.is_dir() {
            return Err(format!("Missing model component: {name}"));
        }
        let class = component[1].as_str().ok_or("Invalid component class")?;
        if class.contains("Scheduler") {
            read_json(&component_root.join("scheduler_config.json"))?;
        } else if class.contains("Tokenizer") {
            read_json(&component_root.join("tokenizer_config.json"))?;
        }
        if class.contains("Model") || class.starts_with("Autoencoder") {
            read_json(&component_root.join("config.json"))?;
            let weights = files
                .iter()
                .filter(|path| {
                    path.parent() == Some(component_root.as_path())
                        && path.extension().and_then(|extension| extension.to_str())
                            == Some("safetensors")
                })
                .collect::<Vec<_>>();
            if weights.is_empty() {
                return Err(format!("Missing safetensors weights for {name}"));
            }
            for path in files.iter().filter(|path| {
                path.parent() == Some(component_root.as_path())
                    && path
                        .file_name()
                        .and_then(|file| file.to_str())
                        .is_some_and(|file| file.ends_with(".safetensors.index.json"))
            }) {
                let weight_index = read_json(path)?;
                let map = weight_index
                    .get("weight_map")
                    .and_then(Value::as_object)
                    .ok_or("Invalid weight index")?;
                if map.is_empty() {
                    return Err("The weight index is empty.".to_string());
                }
                for shard in map.values() {
                    let shard = shard.as_str().ok_or("Invalid weight shard")?;
                    if Path::new(shard).components().count() != 1
                        || !shard.ends_with(".safetensors")
                        || !files.contains(&component_root.join(shard))
                    {
                        return Err(format!("Missing or unsafe weight shard: {name}/{shard}"));
                    }
                }
            }
        }
    }
    Ok(PackageInventory {
        root,
        files,
        bytes,
        tensor_count,
        review_token: format!("{:x}", hasher.finalize()),
        pipeline,
    })
}

fn read_json(path: &Path) -> MediaResult<Value> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Missing {}: {error}", path.display()))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 16 * 1_024 * 1_024
    {
        return Err(format!("Invalid model configuration: {}", path.display()));
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Invalid {}: {error}", path.display()))
}

pub(super) fn inspect(source: &Path) -> MediaResult<MediaLocalModelImportInspection> {
    let package = inventory(source)?;
    let matches = open_models::profiles()
        .iter()
        .filter(|profile| profile.pipeline == package.pipeline)
        .collect::<Vec<_>>();
    let detected = (matches.len() == 1).then(|| matches[0].architecture.clone());
    let name = package
        .root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Model")
        .to_string();
    Ok(MediaLocalModelImportInspection {
        schema_version: 1,
        can_import: true,
        blocking_reason: None,
        source_path: package.root.to_string_lossy().into_owned(),
        source_file_name: name.clone(),
        byte_size: package.bytes,
        tensor_count: package.tensor_count,
        header_digest: package.review_token.clone(),
        duplicate: None,
        review_token: package.review_token,
        suggested_display_name: name,
        architecture_confidence: if detected.is_some() {
            "high"
        } else {
            "unknown"
        }
        .to_string(),
        detected_architecture: detected,
        metadata_summary: vec![package.pipeline],
        warnings: Vec::new(),
    })
}

pub(super) fn import_reviewed(
    paths: &MediaRuntimePaths,
    request: &ImportMediaLocalModelRequest,
) -> MediaResult<MediaLocalModelImportResult> {
    let profile =
        open_models::by_architecture(&request.architecture).ok_or("Select a model architecture")?;
    model_import::validated_text("displayName", &request.display_name, 120)?;
    model_import::validated_source_url(request.source_url.as_deref())?;
    model_import::validated_optional_text("licenseName", request.license_name.as_deref(), 256)?;
    let inspection = inspect(Path::new(&request.source_path))?;
    if request.review_token != inspection.review_token {
        return Err("The model folder changed. Inspect it again.".to_string());
    }
    let package = inventory(Path::new(&request.source_path))?;
    if profile.pipeline != package.pipeline {
        return Err("The selected architecture does not match the model folder.".to_string());
    }
    if request
        .commercial_use
        .as_deref()
        .is_some_and(|value| !matches!(value, "allowed" | "review-required"))
    {
        return Err("Invalid commercialUse value".to_string());
    }
    let root = paths.models_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    if hardware::available_storage_bytes(&root)
        .is_some_and(|available| available < package.bytes.saturating_mul(105).div_ceil(100))
    {
        return Err("There is not enough free space to import this model.".to_string());
    }
    let stage = root
        .join("staging")
        .join(format!("package-{}", model_import::new_import_id()?));
    fs::create_dir_all(&stage).map_err(|error| error.to_string())?;
    let result = publish(paths, request, &inspection, &package, &stage);
    if stage.exists() {
        fs::remove_dir_all(&stage)
            .map_err(|error| format!("Could not clean model staging: {error}"))?;
    }
    result
}

fn publish(
    paths: &MediaRuntimePaths,
    request: &ImportMediaLocalModelRequest,
    inspection: &MediaLocalModelImportInspection,
    package: &PackageInventory,
    stage: &Path,
) -> MediaResult<MediaLocalModelImportResult> {
    let mut hasher = Sha256::new();
    hasher.update(request.architecture.as_bytes());
    for source in &package.files {
        let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || !fs::canonicalize(source)
                .map_err(|error| error.to_string())?
                .starts_with(&package.root)
        {
            return Err("The model folder changed. Inspect it again.".to_string());
        }
        let relative = source
            .strip_prefix(&package.root)
            .map_err(|error| error.to_string())?;
        let destination = stage.join(relative);
        fs::create_dir_all(destination.parent().ok_or("Invalid model destination")?)
            .map_err(|error| error.to_string())?;
        fs::copy(source, &destination).map_err(|error| format!("Could not copy model: {error}"))?;
        let (size, digest) = model_import::hash_file(&destination)?;
        let (source_size, source_digest) = model_import::hash_file(source)?;
        if (size, &digest) != (source_size, &source_digest) {
            return Err("The model changed during import.".to_string());
        }
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update(digest.as_bytes());
    }
    if inventory(&package.root)?.review_token != package.review_token {
        return Err("The model changed during import.".to_string());
    }
    let digest = format!("{:x}", hasher.finalize());
    let model_id = format!("{}{digest}", model_import::USER_MODEL_ID_PREFIX);
    let relative_path = format!("packages/user-{}/revisions/{digest}", &digest[..32]);
    let destination = paths.models_root()?.join(&relative_path);
    let already_installed = database::open(paths)?.query_row("SELECT EXISTS(SELECT 1 FROM media_model_installations WHERE model_id = ?1 AND status = 'installed')", [&model_id], |row| row.get::<_, bool>(0)).map_err(|error| error.to_string())?;
    if destination.exists() {
        let installed = inventory(&destination)?;
        if installed.files.len() != package.files.len() {
            return Err(
                "The existing model package is incomplete. Remove it and import again.".to_string(),
            );
        }
        for staged in &package.files {
            let relative = staged
                .strip_prefix(&package.root)
                .map_err(|error| error.to_string())?;
            if model_import::hash_file(&stage.join(relative))?
                != model_import::hash_file(&destination.join(relative))?
            {
                return Err(
                    "The existing model package failed verification. Remove it and import again."
                        .to_string(),
                );
            }
        }
    } else {
        fs::create_dir_all(destination.parent().ok_or("Invalid model revision")?)
            .map_err(|error| error.to_string())?;
        fs::rename(stage, &destination)
            .map_err(|error| format!("Could not publish model folder: {error}"))?;
    }
    let imported_at = database::now();
    model_import::persist_import(
        paths,
        request,
        inspection,
        &digest,
        &relative_path,
        &imported_at,
        "diffusers",
    )?;
    Ok(MediaLocalModelImportResult {
        schema_version: 1,
        model_id,
        display_name: request.display_name.trim().to_string(),
        family: open_models::by_architecture(&request.architecture)
            .ok_or("Unknown architecture")?
            .family
            .clone(),
        revision: digest.clone(),
        digest,
        byte_size: package.bytes,
        target_label: format!("models/{relative_path}"),
        imported_at,
        already_installed,
    })
}
