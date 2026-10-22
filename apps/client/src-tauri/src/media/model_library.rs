use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
};

use super::{
    database, model_discovery, model_import, model_install, MediaModelCatalogSnapshot, MediaResult,
    MediaRuntimePaths, MediaWorkspaceModelDiscovery,
};

#[cfg(test)]
#[path = "model_library_tests.rs"]
mod tests;

fn regular_file_size(path: &Path) -> Option<u64> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        .map(|metadata| metadata.len())
}

fn package_size(root: &Path) -> MediaResult<u64> {
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut bytes = 0_u64;
    let mut files = 0;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 12 || files > 50_000 {
            return Err("The model folder exceeds the inspection limit.".into());
        }
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if matches!(
                entry.file_name().to_str(),
                Some(".cache" | ".git" | super::model_library_source::FILE_NAME)
            ) {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Ok(0);
            }
            if metadata.is_dir() {
                pending.push((entry.path(), depth + 1));
            } else if metadata.is_file() {
                files += 1;
                bytes = bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok(bytes)
}

pub(super) fn available_models(paths: &MediaRuntimePaths) -> MediaResult<HashMap<String, PathBuf>> {
    let models_root = paths.configured_models_root()?;
    let folder_available = models_root.is_dir();
    let connection = database::open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT m.id, m.package_type, i.bytes_on_disk FROM media_models m
         JOIN media_model_installations i ON i.model_id = m.id WHERE i.status = 'installed'
         AND m.target = 'local' AND m.bundled = 0 AND m.lifecycle != 'removed'",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?.max(0) as u64,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut present = HashMap::new();
    for (id, package_type, expected_bytes) in rows {
        if !folder_available
            || (!model_install::has_manifest(&id)
                && !id.starts_with(model_import::USER_MODEL_ID_PREFIX))
        {
            continue;
        }
        let root = model_install::library_path(paths, &id)?;
        let exists = if !model_install::library_files_present(paths, &id)? {
            false
        } else if id.starts_with(model_import::USER_MODEL_ID_PREFIX) {
            if package_type == "safetensors" {
                regular_file_size(&root.join("checkpoint.safetensors")) == Some(expected_bytes)
            } else {
                regular_file_size(&super::model_package_import::index_path(&root)).is_some()
                    && package_size(&root).is_ok_and(|bytes| bytes >= expected_bytes)
            }
        } else {
            true
        };
        if exists {
            present.insert(id, root);
        }
    }
    Ok(present)
}

pub(super) fn annotate(
    paths: &MediaRuntimePaths,
    snapshot: &mut MediaModelCatalogSnapshot,
) -> MediaResult<Vec<PathBuf>> {
    let models_root = paths.configured_models_root()?;
    let present = available_models(paths)?;
    let mut configured_paths = present.values().cloned().collect::<Vec<_>>();
    for model in &mut snapshot.models {
        if model.target == "local"
            && !model.bundled
            && model.installed
            && matches!(
                model.management.acquisition.as_str(),
                "file-import" | "managed-install"
            )
            && !present.contains_key(&model.id)
        {
            model.installed = false;
            model.configured = false;
            model.installation_status = "not-installed".into();
            model.installed_revision = None;
            model.runtime_readiness = "unverified".into();
        }
    }
    snapshot
        .models
        .retain(|model| !model.user_imported || model.installed);
    snapshot.addons.retain(|addon| {
        let relative = Path::new(&addon.relative_path);
        if relative.is_absolute()
            || !relative
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return false;
        }
        let root = models_root.join(relative);
        let present = regular_file_size(&root.join("addon.safetensors")) == Some(addon.byte_size);
        if present {
            configured_paths.push(root);
        }
        present
    });
    Ok(configured_paths)
}

pub(super) fn discover(
    paths: &MediaRuntimePaths,
    workspace_root: Option<&str>,
) -> MediaResult<MediaWorkspaceModelDiscovery> {
    database::ensure_initialized(paths)?;
    let connection = database::open(paths)?;
    model_install::reconcile_library(paths, &connection)?;
    let mut snapshot = super::catalog::snapshot(&connection, &HashSet::new())?;
    let mut excluded = annotate(paths, &mut snapshot)?;
    let root = paths.models_root()?;
    let mut warnings = Vec::new();
    for package in excluded.clone() {
        match super::model_library_source::resolve(&root, &package) {
            Ok(Some(source)) => excluded.push(source),
            Ok(None) => {}
            Err(error) => warnings.push(error),
        }
    }
    excluded.extend(
        [
            "staging",
            "trash",
            "quarantine",
            "components",
            "workflow",
            "whisper",
            "verification",
            "verification-downloads",
            "civitai-imports",
            "addons/staging",
            "addons/trash",
            "addons/quarantine",
        ]
        .map(|relative| root.join(relative)),
    );
    let mut discovery = model_discovery::discover_folder(&root, &excluded)?;
    discovery.warnings.extend(warnings);
    for entry in &mut discovery.entries {
        if entry.status == "ready" {
            entry.status = "importable".into();
        }
    }
    if let Some(workspace_root) = workspace_root.filter(|value| !value.trim().is_empty()) {
        let workspace =
            crate::runtime_snapshot::resolve_workspace_root_path(workspace_root)?.join("models");
        if workspace.is_dir() && fs::canonicalize(&workspace).ok() != fs::canonicalize(&root).ok() {
            let extra = model_discovery::discover_folder(&workspace, &excluded)?;
            discovery.entries.extend(extra.entries);
            discovery.truncated |= extra.truncated;
            discovery.warnings.extend(extra.warnings);
        }
    }
    discovery.entries.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
    });
    discovery
        .entries
        .dedup_by(|left, right| left.path == right.path);
    Ok(discovery)
}
