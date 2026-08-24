use std::{fs, io::ErrorKind, path::PathBuf};

use serde::{Deserialize, Serialize};

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::with_cooperative_file_lock,
};

use super::{
    resolve_workspace_root_path, settings::normalize_user_memory_entries,
    settings_types::UserMemoryEntry,
};

const WORKSPACE_MEMORY_VERSION: u8 = 1;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceMemoryDocument {
    version: u8,
    entries: Vec<UserMemoryEntry>,
}

fn get_workspace_memory_path(workspace_root: &str) -> Result<PathBuf, String> {
    Ok(resolve_workspace_root_path(workspace_root)?
        .join(".machdoch")
        .join("memory.json"))
}

fn load_workspace_memory_document(path: &PathBuf) -> Result<WorkspaceMemoryDocument, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(WorkspaceMemoryDocument {
                version: WORKSPACE_MEMORY_VERSION,
                entries: Vec::new(),
            });
        }
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    let document = serde_json::from_str::<WorkspaceMemoryDocument>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;

    if document.version != WORKSPACE_MEMORY_VERSION {
        return Err(format!(
            "Unsupported workspace memory version in {}.",
            path.display()
        ));
    }

    Ok(WorkspaceMemoryDocument {
        version: WORKSPACE_MEMORY_VERSION,
        entries: normalize_user_memory_entries(&document.entries, "workspace"),
    })
}

pub(super) fn load_workspace_memory_entries(
    workspace_root: &str,
) -> Result<Vec<UserMemoryEntry>, String> {
    let path = get_workspace_memory_path(workspace_root)?;
    Ok(load_workspace_memory_document(&path)?.entries)
}

pub(super) fn forget_workspace_memory_entry(
    workspace_root: &str,
    id: &str,
) -> Result<Vec<UserMemoryEntry>, String> {
    let path = get_workspace_memory_path(workspace_root)?;
    let normalized_id = id.trim();

    if normalized_id.is_empty() {
        return Err("Expected a workspace memory id.".to_string());
    }

    with_cooperative_file_lock(&path, || {
        let mut document = load_workspace_memory_document(&path)?;
        let previous_length = document.entries.len();
        document.entries.retain(|entry| entry.id != normalized_id);

        if document.entries.len() != previous_length {
            let parent = path
                .parent()
                .ok_or_else(|| format!("Memory path has no parent: {}", path.display()))?;
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
            let mut raw = serde_json::to_vec_pretty(&document)
                .map_err(|error| format!("Failed to serialize workspace memory: {error}"))?;
            raw.push(b'\n');
            write_file_atomic(&path, &raw, AtomicWriteOptions::default())
                .map_err(|error| format!("Failed to write {}: {error}", path.display()))?;
        }

        Ok(document.entries)
    })
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    fn create_workspace() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should be available")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "machdoch-workspace-memory-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("workspace should be created");
        path
    }

    #[test]
    fn loads_and_forgets_workspace_memory() {
        let workspace = create_workspace();
        let memory_path = workspace.join(".machdoch").join("memory.json");
        fs::create_dir_all(
            memory_path
                .parent()
                .expect("memory path should have a parent"),
        )
        .expect("memory directory should be created");
        let document = WorkspaceMemoryDocument {
            version: WORKSPACE_MEMORY_VERSION,
            entries: vec![UserMemoryEntry {
                id: "package-manager".to_string(),
                scope: "workspace".to_string(),
                key: "package-manager".to_string(),
                kind: "decision".to_string(),
                content: "Package manager: pnpm".to_string(),
                search_terms: vec!["dependencies".to_string()],
                importance: 4,
                confidence: 1.0,
                created_at: 1,
                updated_at: 1,
            }],
        };
        fs::write(
            &memory_path,
            serde_json::to_vec_pretty(&document).expect("memory should serialize"),
        )
        .expect("memory should be written");

        let loaded = load_workspace_memory_entries(
            workspace
                .to_str()
                .expect("workspace path should be valid UTF-8"),
        )
        .expect("memory should load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].search_terms, vec!["dependencies"]);

        let remaining = forget_workspace_memory_entry(
            workspace
                .to_str()
                .expect("workspace path should be valid UTF-8"),
            "package-manager",
        )
        .expect("memory should be removed");
        assert!(remaining.is_empty());
        assert!(load_workspace_memory_entries(
            workspace
                .to_str()
                .expect("workspace path should be valid UTF-8")
        )
        .expect("memory should reload")
        .is_empty());

        fs::remove_dir_all(&workspace).expect("workspace should be removed");
    }
}
