use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

use super::MediaResult;

pub(super) const SETTINGS_FILE: &str = "model-storage.json";

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ModelStorage {
    folder: PathBuf,
}

pub(super) fn configured_folder(root: &Path) -> MediaResult<PathBuf> {
    match fs::read(root.join(SETTINGS_FILE)) {
        Ok(bytes) => {
            let settings: ModelStorage = serde_json::from_slice(&bytes)
                .map_err(|error| format!("Could not read model folder settings: {error}"))?;
            if !settings.folder.is_absolute() {
                return Err("Invalid model folder settings. Choose an absolute model folder path in Settings → Asset storage.".into());
            }
            Ok(settings.folder)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(root.join("models")),
        Err(error) => Err(format!("Could not read model folder settings: {error}")),
    }
}

pub(super) fn folder(root: &Path) -> MediaResult<PathBuf> {
    let folder = configured_folder(root)?;
    if !folder.is_dir()
        && (root.join(SETTINGS_FILE).exists() || fs::symlink_metadata(&folder).is_ok())
    {
        return Err("The model folder is unavailable. Reconnect its disk or choose another model folder in Settings → Asset storage.".into());
    }
    Ok(folder)
}

pub(super) fn save(root: &Path, folder: &Path) -> MediaResult<()> {
    let bytes = serde_json::to_vec(&ModelStorage {
        folder: folder.into(),
    })
    .map_err(|error| error.to_string())?;
    crate::atomic_file::write_file_atomic(&root.join(SETTINGS_FILE), &bytes, Default::default())
        .map_err(|error| format!("Could not save model folder settings: {error}"))
}

pub(super) fn select(root: &Path, selected: &Path) -> MediaResult<()> {
    if !selected.is_absolute() {
        return Err("Choose an absolute model folder path.".into());
    }
    let selected = if selected.join("media.sqlite3").is_file() {
        folder(selected)?
    } else {
        selected.to_path_buf()
    };
    if !selected.is_dir() {
        return Err("The model folder is unavailable. Choose an existing folder.".into());
    }
    let selected = fs::canonicalize(selected)
        .map_err(|error| format!("Could not open the model folder: {error}"))?;
    fs::create_dir_all(root).map_err(|error| format!("Could not open asset storage: {error}"))?;
    let asset_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if asset_root.starts_with(&selected)
        || (selected.starts_with(&asset_root) && selected != asset_root.join("models"))
    {
        return Err("Choose a separate model folder or the current models folder.".into());
    }
    if selected == asset_root.join("models") {
        match fs::remove_file(root.join(SETTINGS_FILE)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Could not save model folder settings: {error}")),
        }
    } else {
        save(root, &selected)
    }
}
