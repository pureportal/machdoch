use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::with_cooperative_file_lock,
    runtime_snapshot::get_user_config_directory,
};

use super::{
    FleetControlInner, FleetControlState, FleetControlStateFile, FLEET_CONTROL_STATE_FILE_NAME,
    FLEET_CONTROL_STATE_SCHEMA_VERSION, MAX_COMPLETED_COMMAND_ENTRIES, MAX_PENDING_COMMAND_ENTRIES,
};

impl FleetControlState {
    pub(super) fn ensure_state_loaded(&self) -> Result<(), String> {
        if self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to inspect Fleet control state.".to_string())?
            .state_loaded
        {
            return Ok(());
        }

        let state_file = load_state_file()?;
        let mut inner = self
            .shared
            .inner
            .lock()
            .map_err(|_| "Unable to load Fleet control state.".to_string())?;
        if !inner.state_loaded {
            inner.pending_commands = state_file.pending_commands.into_iter().collect();
            inner.completed_commands = state_file.completed_commands.into_iter().collect();
            inner.state_loaded = true;
        }
        Ok(())
    }
}

pub(super) fn persist_state_locked(inner: &FleetControlInner) -> Result<(), String> {
    write_state_file(&FleetControlStateFile {
        schema_version: FLEET_CONTROL_STATE_SCHEMA_VERSION,
        pending_commands: inner.pending_commands.iter().cloned().collect(),
        completed_commands: inner.completed_commands.iter().cloned().collect(),
    })
}

fn state_file_path() -> Result<PathBuf, String> {
    Ok(get_user_config_directory()?.join(FLEET_CONTROL_STATE_FILE_NAME))
}

fn load_state_file() -> Result<FleetControlStateFile, String> {
    load_state_file_at_path(&state_file_path()?)
}

fn load_state_file_at_path(path: &Path) -> Result<FleetControlStateFile, String> {
    if !path.exists() {
        return Ok(FleetControlStateFile::default());
    }

    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let state_file = serde_json::from_str::<FleetControlStateFile>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
    normalize_state_file(state_file)
}

fn normalize_state_file(
    mut state_file: FleetControlStateFile,
) -> Result<FleetControlStateFile, String> {
    if state_file.schema_version != FLEET_CONTROL_STATE_SCHEMA_VERSION {
        return Err(format!(
            "Fleet control schema version {FLEET_CONTROL_STATE_SCHEMA_VERSION} is required."
        ));
    }

    let mut seen_command_ids = HashSet::new();
    state_file.completed_commands.retain(|command| {
        !command.command_id.trim().is_empty()
            && !command.payload_hash.trim().is_empty()
            && seen_command_ids.insert(command.command_id.clone())
    });
    if state_file.completed_commands.len() > MAX_COMPLETED_COMMAND_ENTRIES {
        state_file
            .completed_commands
            .drain(..state_file.completed_commands.len() - MAX_COMPLETED_COMMAND_ENTRIES);
    }
    state_file.pending_commands.retain(|command| {
        !command.command_id.trim().is_empty() && seen_command_ids.insert(command.command_id.clone())
    });
    state_file
        .pending_commands
        .truncate(MAX_PENDING_COMMAND_ENTRIES);
    Ok(state_file)
}

fn write_state_file(state_file: &FleetControlStateFile) -> Result<(), String> {
    let path = state_file_path()?;
    with_cooperative_file_lock(&path, || write_state_file_at_path(state_file, &path))
}

fn write_state_file_at_path(state_file: &FleetControlStateFile, path: &Path) -> Result<(), String> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Failed to create {}: {error}", directory.display()))?;
        secure_directory(directory)?;
    }

    let serialized = serde_json::to_string_pretty(state_file)
        .map_err(|error| format!("Failed to serialize Fleet control state: {error}"))?;
    write_file_atomic(
        path,
        format!("{serialized}\n").as_bytes(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
    secure_file(path)
}

fn secure_directory(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }
    Ok(())
}

fn secure_file(path: &Path) -> Result<(), String> {
    #[cfg(not(unix))]
    let _ = path;
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Failed to secure {}: {error}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn test_path() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        std::env::temp_dir()
            .join(format!("machdoch-fleet-control-{unique}"))
            .join(FLEET_CONTROL_STATE_FILE_NAME)
    }

    #[test]
    fn state_file_round_trip_preserves_the_current_schema() {
        let path = test_path();
        let state_file = FleetControlStateFile::default();
        write_state_file_at_path(&state_file, &path).expect("state file should write");
        let loaded = load_state_file_at_path(&path).expect("state file should load");

        assert_eq!(loaded.schema_version, FLEET_CONTROL_STATE_SCHEMA_VERSION);
        assert!(loaded.pending_commands.is_empty());
        assert!(loaded.completed_commands.is_empty());

        fs::remove_dir_all(path.parent().expect("path should have a parent"))
            .expect("test directory should be removable");
    }

    #[test]
    fn state_file_rejects_an_unknown_schema() {
        let error = normalize_state_file(FleetControlStateFile {
            schema_version: FLEET_CONTROL_STATE_SCHEMA_VERSION + 1,
            ..FleetControlStateFile::default()
        })
        .expect_err("unknown schema should fail");

        assert!(error.contains("schema version"));
    }
}
