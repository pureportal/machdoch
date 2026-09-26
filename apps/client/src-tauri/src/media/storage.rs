use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::{
    error::{command_result, MediaCommandResult},
    krea_training, storage_migration, MediaResult, MediaRuntimePaths,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct StorageConfig {
    pub root: PathBuf,
    pub identity: Option<String>,
    pub migration: Option<storage_migration::Migration>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageStatus {
    folder: String,
    destination: Option<String>,
    phase: &'static str,
    completed_bytes: u64,
    total_bytes: u64,
    error: Option<String>,
}

pub(super) fn control_root(app: &AppHandle) -> MediaResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Media Studio storage: {error}"))
}

pub(super) fn lock(control: &Path, exclusive: bool) -> MediaResult<File> {
    fs::create_dir_all(control).map_err(|error| error.to_string())?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(control.join("media-storage.lock"))
        .map_err(|error| error.to_string())?;
    let result = if exclusive {
        file.try_lock()
    } else {
        file.try_lock_shared()
    };
    result.map_err(|_| {
        if exclusive {
            "Media Studio is busy. Wait for downloads and generation to finish, then retry."
        } else {
            "Media Studio assets are moving. Check Settings → Asset storage for progress."
        }
        .to_string()
    })?;
    Ok(file)
}

pub(super) fn read_config(control: &Path) -> MediaResult<StorageConfig> {
    match fs::read(control.join("media-storage.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Could not read asset storage settings: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(StorageConfig {
            root: control.join("media-studio"),
            identity: None,
            migration: None,
        }),
        Err(error) => Err(format!("Could not read asset storage settings: {error}")),
    }
}

pub(super) fn save_config(control: &Path, config: &StorageConfig) -> MediaResult<()> {
    let bytes = serde_json::to_vec(config).map_err(|error| error.to_string())?;
    crate::atomic_file::write_file_atomic(
        &control.join("media-storage.json"),
        &bytes,
        crate::atomic_file::AtomicWriteOptions::default(),
    )
    .map_err(|error| format!("Could not save asset storage settings: {error}"))
}

pub(super) fn resolve(control: &Path) -> MediaResult<MediaRuntimePaths> {
    let lease = Arc::new(lock(control, false)?);
    let config = read_config(control)?;
    if config.migration.is_some() {
        return Err(
            "The asset move is incomplete. Open Settings → Asset storage to resume it.".into(),
        );
    }
    if control.join("media-storage.json").exists() && !config.root.is_dir() {
        return Err("The asset folder is unavailable. Reconnect its disk and retry.".into());
    }
    if let Some(identity) = &config.identity {
        storage_migration::check_identity(&config.root, identity)?;
    }
    Ok(MediaRuntimePaths {
        database: config.root.join("media.sqlite3"),
        blobs: config.root.join("blobs").join("sha256"),
        _storage_lease: Some(lease),
    })
}

fn status(control: &Path) -> MediaResult<StorageStatus> {
    let config = read_config(control)?;
    let migration = config.migration.as_ref();
    let interrupted = migration.is_some() && lock(control, true).is_ok();
    Ok(StorageStatus {
        folder: config.root.display().to_string(),
        destination: migration.map(|value| value.target.display().to_string()),
        phase: migration.map_or("ready", |value| {
            if value.error.is_some() || interrupted {
                "paused"
            } else if value.cleaning {
                "cleaning"
            } else {
                "moving"
            }
        }),
        completed_bytes: migration.map_or(0, storage_migration::completed_bytes),
        total_bytes: migration.map_or(0, |value| value.files.iter().map(|file| file.bytes).sum()),
        error: migration.and_then(|value| value.error.clone()).or_else(|| {
            interrupted.then(|| "The move was interrupted. Resume it to continue.".into())
        }),
    })
}

fn spawn_move(
    app: AppHandle,
    control: PathBuf,
    lease: File,
    mut config: StorageConfig,
) -> MediaResult<()> {
    std::thread::Builder::new()
        .name("media-storage-move".into())
        .spawn(move || {
            let result = (|| {
                let _sleep_inhibition = super::inhibit_system_sleep_for_media_work(&app)?;
                super::model_memory::release_idle()?;
                storage_migration::execute(&control, &mut config)
            })();
            if let Err(error) = result {
                if let Some(migration) = config.migration.as_mut() {
                    migration.error = Some(format!("{error} Fix the problem and resume the move."));
                    if let Err(persist_error) = save_config(&control, &config) {
                        eprintln!("Could not save asset move failure: {persist_error}");
                    }
                }
                eprintln!("Asset move stopped: {error}");
            }
            let recovery = if config.migration.is_none() {
                let paths = MediaRuntimePaths {
                    database: config.root.join("media.sqlite3"),
                    blobs: config.root.join("blobs").join("sha256"),
                    _storage_lease: None,
                };
                Some(super::recover_runtime_storage(&paths))
            } else {
                None
            };
            drop(lease);
            if let Some(recovery) = recovery {
                if let Err(error) =
                    recovery.and_then(|recovery| super::resume_runtime_workers(&app, &recovery))
                {
                    eprintln!("Could not resume Media Studio after moving assets: {error}");
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Could not start asset move: {error}"))
}

pub(crate) fn resume_pending(app: &AppHandle) -> MediaResult<bool> {
    let control = control_root(app)?;
    if read_config(&control)?.migration.is_none() {
        return Ok(false);
    }
    let lease = lock(&control, true)?;
    let mut config = read_config(&control)?;
    if let Some(migration) = config.migration.as_mut() {
        migration.error = None;
    }
    save_config(&control, &config)?;
    spawn_move(app.clone(), control, lease, config)?;
    Ok(true)
}

#[tauri::command]
pub(crate) fn media_get_asset_storage(app: AppHandle) -> MediaCommandResult<StorageStatus> {
    command_result(
        "media_get_asset_storage",
        control_root(&app).and_then(|root| status(&root)),
    )
}

#[tauri::command]
pub(crate) async fn media_move_asset_storage(
    app: AppHandle,
    folder: String,
) -> MediaCommandResult<StorageStatus> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let control = control_root(&app)?;
        let lease = lock(&control, true)?;
        let mut config = read_config(&control)?;
        krea_training::ensure_idle(&config.root)?;
        storage_migration::prepare(&control, &mut config, Path::new(&folder))?;
        spawn_move(app, control.clone(), lease, config)?;
        status(&control)
    })
    .await
    .map_err(|error| error.to_string())
    .and_then(|result| result);
    command_result("media_move_asset_storage", result)
}

#[tauri::command]
pub(crate) fn media_resume_asset_storage(app: AppHandle) -> MediaCommandResult<StorageStatus> {
    command_result(
        "media_resume_asset_storage",
        resume_pending(&app)
            .and_then(|_| control_root(&app))
            .and_then(|root| status(&root)),
    )
}
