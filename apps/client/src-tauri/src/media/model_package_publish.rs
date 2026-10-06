use std::{fs, path::PathBuf};

use sha2::{Digest, Sha256};

use super::super::{database, hardware};
use super::{
    inventory, model_import, ImportMediaLocalModelRequest, MediaLocalModelImportInspection,
    MediaLocalModelImportResult, MediaResult, MediaRuntimePaths, PackageInventory,
};

struct PackageFile {
    relative: PathBuf,
    bytes: u64,
    digest: String,
}

fn fingerprint(
    package: &PackageInventory,
    architecture: &str,
) -> MediaResult<(String, Vec<PackageFile>)> {
    let mut hasher = Sha256::new();
    hasher.update(architecture.as_bytes());
    let mut files = Vec::with_capacity(package.files.len());
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
            .map_err(|error| error.to_string())?
            .to_path_buf();
        let (bytes, digest) = model_import::hash_file(source)?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update(digest.as_bytes());
        files.push(PackageFile {
            relative,
            bytes,
            digest,
        });
    }
    if inventory(&package.root)?.review_token != package.review_token {
        return Err("The model changed during import.".to_string());
    }
    Ok((format!("{:x}", hasher.finalize()), files))
}

fn publish_files(
    root: &std::path::Path,
    destination: &std::path::Path,
    package: &PackageInventory,
    files: &[PackageFile],
) -> MediaResult<()> {
    if destination.exists() {
        let installed = inventory(destination)?;
        if installed.files.len() != files.len() {
            return Err(
                "The existing model package is incomplete. Remove it and import again.".to_string(),
            );
        }
        for file in files {
            if model_import::hash_file(&destination.join(&file.relative))?
                != (file.bytes, file.digest.clone())
            {
                return Err(
                    "The existing model package failed verification. Remove it and import again."
                        .to_string(),
                );
            }
        }
        return Ok(());
    }
    if hardware::available_storage_bytes(root)
        .is_some_and(|available| available < package.bytes.saturating_mul(105).div_ceil(100))
    {
        return Err("There is not enough free space to import this model.".to_string());
    }
    let stage = root
        .join("staging")
        .join(format!("package-{}", model_import::new_import_id()?));
    fs::create_dir_all(&stage).map_err(|error| error.to_string())?;
    let result = (|| {
        for file in files {
            let staged = stage.join(&file.relative);
            fs::create_dir_all(staged.parent().ok_or("Invalid model destination")?)
                .map_err(|error| error.to_string())?;
            fs::copy(package.root.join(&file.relative), &staged)
                .map_err(|error| format!("Could not copy model: {error}"))?;
            if model_import::hash_file(&staged)? != (file.bytes, file.digest.clone()) {
                return Err("The model changed during import.".to_string());
            }
        }
        if inventory(&package.root)?.review_token != package.review_token {
            return Err("The model changed during import.".to_string());
        }
        fs::create_dir_all(destination.parent().ok_or("Invalid model revision")?)
            .map_err(|error| error.to_string())?;
        fs::rename(&stage, destination)
            .map_err(|error| format!("Could not publish model folder: {error}"))
    })();
    if stage.exists() {
        fs::remove_dir_all(&stage)
            .map_err(|error| format!("Could not clean model staging: {error}"))?;
    }
    result
}

pub(super) fn publish(
    paths: &MediaRuntimePaths,
    request: &ImportMediaLocalModelRequest,
    inspection: &MediaLocalModelImportInspection,
    package: &PackageInventory,
) -> MediaResult<MediaLocalModelImportResult> {
    let root = paths.models_root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let (digest, files) = fingerprint(package, &request.architecture)?;
    let model_id = format!("{}{digest}", model_import::USER_MODEL_ID_PREFIX);
    let relative_path = format!("packages/user-{}/revisions/{digest}", &digest[..32]);
    let already_installed = database::open(paths)?.query_row(
        "SELECT EXISTS(SELECT 1 FROM media_model_installations WHERE model_id = ?1 AND status = 'installed')",
        [&model_id], |row| row.get::<_, bool>(0)
    ).map_err(|error| error.to_string())?;
    publish_files(&root, &root.join(&relative_path), package, &files)?;
    if inventory(&package.root)?.review_token != package.review_token {
        return Err("The model changed during import.".to_string());
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
        family: model_import::architecture_profile(&request.architecture)
            .ok_or("Unknown architecture")?
            .family
            .to_string(),
        revision: digest.clone(),
        digest,
        byte_size: package.bytes,
        target_label: format!("models/{relative_path}"),
        imported_at,
        already_installed,
    })
}
