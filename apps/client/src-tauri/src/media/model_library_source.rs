use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use super::{model_import, MediaResult, MediaRuntimePaths};

pub(super) const FILE_NAME: &str = "machdoch-source.json";

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LibrarySource {
    relative_path: PathBuf,
    byte_size: u64,
    modified_marker: String,
    header_digest: String,
}

pub(super) fn record(
    paths: &MediaRuntimePaths,
    destination: &Path,
    source: &Path,
) -> MediaResult<()> {
    let root = fs::canonicalize(paths.models_root()?).map_err(|error| error.to_string())?;
    let source = fs::canonicalize(source).map_err(|error| error.to_string())?;
    let Ok(relative_path) = source.strip_prefix(&root) else {
        return Ok(());
    };
    if source.starts_with(fs::canonicalize(destination).map_err(|error| error.to_string())?)
        || source.is_dir()
    {
        return Ok(());
    }
    let header = model_import::parse_header(source.to_string_lossy().as_ref())?;
    let bytes = serde_json::to_vec(&LibrarySource {
        relative_path: relative_path.into(),
        byte_size: header.byte_size,
        modified_marker: header.modified_marker,
        header_digest: header.header_digest,
    })
    .map_err(|error| error.to_string())?;
    crate::atomic_file::write_file_atomic(&destination.join(FILE_NAME), &bytes, Default::default())
        .map_err(|error| format!("Could not save model source: {error}"))
}

pub(super) fn resolve(root: &Path, package: &Path) -> MediaResult<Option<PathBuf>> {
    let metadata = match fs::symlink_metadata(package.join(FILE_NAME)) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read model source: {error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16_384 {
        return Err("The saved model source is invalid. Remove machdoch-source.json and configure the file again.".into());
    }
    let bytes = fs::read(package.join(FILE_NAME))
        .map_err(|error| format!("Could not read model source: {error}"))?;
    let source: LibrarySource = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Could not read model source: {error}"))?;
    if regular_file_size(&package.join("checkpoint.safetensors"))
        .or_else(|| regular_file_size(&package.join("addon.safetensors")))
        != Some(source.byte_size)
    {
        return Ok(None);
    }
    if source.relative_path.is_absolute()
        || !source
            .relative_path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err("The saved model source has an invalid path.".into());
    }
    let path = root.join(source.relative_path);
    let header = model_import::parse_header(path.to_string_lossy().as_ref());
    Ok(header
        .ok()
        .filter(|header| {
            header.byte_size == source.byte_size
                && header.modified_marker == source.modified_marker
                && header.header_digest == source.header_digest
        })
        .map(|_| path))
}

fn regular_file_size(path: &Path) -> Option<u64> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .map(|metadata| metadata.len())
}
