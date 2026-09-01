use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use machdoch_fleet_protocol::FleetManagedPrompt;

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::with_cooperative_file_lock,
    runtime_snapshot::get_user_config_directory,
};

const MAX_PROMPTS: usize = 128;
const MAX_PROMPT_BYTES: usize = 128 * 1024;
const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;

pub(super) fn synchronize(manager_id: &str, prompts: &[FleetManagedPrompt]) -> Result<(), String> {
    let config_root = get_user_config_directory()?;
    ensure_directory(&config_root)?;
    let prompts_root = config_root.join("prompts");
    ensure_directory(&prompts_root)?;
    ensure_contained(&config_root, &prompts_root)?;
    synchronize_at(&prompts_root, manager_id, prompts)
}

fn synchronize_at(
    prompts_root: &Path,
    manager_id: &str,
    prompts: &[FleetManagedPrompt],
) -> Result<(), String> {
    if !super::valid_identifier(manager_id, "manager") {
        return Err("Managed prompt owner is invalid.".to_string());
    }
    let desired = validate_prompts(prompts)?;
    ensure_directory(prompts_root)?;
    let managed_root = prompts_root.join(".fleet-managed");
    ensure_directory(&managed_root)?;
    ensure_contained(prompts_root, &managed_root)?;
    let lock_target = managed_root.join("synchronization");
    with_cooperative_file_lock(&lock_target, || {
        synchronize_locked(&managed_root.join(manager_id), &desired)
    })
}

fn synchronize_locked(
    manager_root: &Path,
    desired: &BTreeMap<PathBuf, &[u8]>,
) -> Result<(), String> {
    ensure_directory(manager_root)?;
    ensure_contained(
        manager_root
            .parent()
            .ok_or_else(|| "Managed prompt root is invalid.".to_string())?,
        manager_root,
    )?;
    let existing = collect_files(manager_root)?;
    for (relative_path, content) in desired {
        let destination = manager_root.join(relative_path);
        ensure_relative_parent(manager_root, relative_path)?;
        if let Ok(metadata) = fs::symlink_metadata(&destination) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "Managed prompt path {} is not a regular file.",
                    destination.display()
                ));
            }
        }
        let unchanged = fs::read(&destination)
            .ok()
            .is_some_and(|current| current == *content);
        if !unchanged {
            write_file_atomic(
                &destination,
                content,
                AtomicWriteOptions::with_unix_mode(0o600),
            )
            .map_err(|error| {
                format!(
                    "Failed to write managed prompt {}: {error}",
                    destination.display()
                )
            })?;
        }
    }
    for relative_path in existing {
        if desired.contains_key(&relative_path) {
            continue;
        }
        let path = manager_root.join(relative_path);
        fs::remove_file(&path).map_err(|error| {
            format!(
                "Failed to remove managed prompt {}: {error}",
                path.display()
            )
        })?;
    }
    remove_empty_directories(manager_root, manager_root)
}

fn validate_prompts(prompts: &[FleetManagedPrompt]) -> Result<BTreeMap<PathBuf, &[u8]>, String> {
    if prompts.len() > MAX_PROMPTS {
        return Err("Managed prompt count exceeded the size limit.".to_string());
    }
    let mut total_bytes = 0_usize;
    let mut ids = HashSet::new();
    let mut normalized_paths = HashSet::new();
    let mut desired = BTreeMap::new();
    for prompt in prompts {
        if !valid_uuid(&prompt.id) || !ids.insert(prompt.id.clone()) {
            return Err("Managed prompt identity is invalid or duplicated.".to_string());
        }
        let content = prompt.content.as_bytes();
        total_bytes = total_bytes.saturating_add(content.len());
        if content.len() > MAX_PROMPT_BYTES
            || total_bytes > MAX_TOTAL_BYTES
            || prompt.content.contains('\0')
        {
            return Err("Managed prompt content exceeded the size limit.".to_string());
        }
        let path = validate_relative_path(&prompt.relative_path)?;
        let normalized = prompt.relative_path.to_lowercase();
        if !normalized_paths.insert(normalized) {
            return Err("Managed prompt paths must be unique.".to_string());
        }
        desired.insert(path, content);
    }
    Ok(desired)
}

fn validate_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.len() > 1_000
        || value.contains('\\')
        || !value.ends_with(".prompt.md")
        || value.starts_with('/')
    {
        return Err("Managed prompt path is invalid.".to_string());
    }
    let path = PathBuf::from(value);
    let components = path.components().collect::<Vec<_>>();
    if components.is_empty()
        || components.len() > 16
        || components.iter().any(|component| match component {
            Component::Normal(value) => {
                let value = value.to_string_lossy();
                value.is_empty()
                    || value.len() > 120
                    || !value.as_bytes()[0].is_ascii_alphanumeric()
                    || !value
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            }
            _ => true,
        })
    {
        return Err("Managed prompt path is invalid.".to_string());
    }
    Ok(path)
}

fn ensure_relative_parent(root: &Path, relative_path: &Path) -> Result<(), String> {
    let mut current = root.to_path_buf();
    if let Some(parent) = relative_path.parent() {
        for component in parent.components() {
            let Component::Normal(name) = component else {
                return Err("Managed prompt path is invalid.".to_string());
            };
            current.push(name);
            ensure_directory(&current)?;
            ensure_contained(root, &current)?;
        }
    }
    Ok(())
}

fn ensure_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => {
            return Err(format!(
                "Managed prompt directory {} is unsafe.",
                path.display()
            ));
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|error| {
                format!(
                    "Failed to create managed prompt directory {}: {error}",
                    path.display()
                )
            })?;
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect managed prompt directory {}: {error}",
                path.display()
            ));
        }
    }
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

fn ensure_contained(root: &Path, path: &Path) -> Result<(), String> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("Failed to resolve {}: {error}", root.display()))?;
    let canonical_path = fs::canonicalize(path)
        .map_err(|error| format!("Failed to resolve {}: {error}", path.display()))?;
    if !canonical_path.starts_with(canonical_root) {
        return Err(format!("Managed prompt path {} is unsafe.", path.display()));
    }
    Ok(())
}

fn collect_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    collect_files_from(root, root, &mut files)?;
    Ok(files)
}

fn collect_files_from(
    root: &Path,
    directory: &Path,
    files: &mut Vec<PathBuf>,
) -> Result<(), String> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
    {
        let entry = entry
            .map_err(|error| format!("Failed to read managed prompt directory entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!("Managed prompt path {} is unsafe.", path.display()));
        }
        if metadata.is_dir() {
            ensure_contained(root, &path)?;
            collect_files_from(root, &path, files)?;
        } else if metadata.is_file() {
            files.push(
                path.strip_prefix(root)
                    .map_err(|_| "Managed prompt path escaped its root.".to_string())?
                    .to_path_buf(),
            );
        } else {
            return Err(format!("Managed prompt path {} is unsafe.", path.display()));
        }
    }
    Ok(())
}

fn remove_empty_directories(root: &Path, directory: &Path) -> Result<(), String> {
    let children = fs::read_dir(directory)
        .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Failed to read managed prompt directory entry: {error}"))?;
    for child in children {
        let metadata = fs::symlink_metadata(&child)
            .map_err(|error| format!("Failed to inspect {}: {error}", child.display()))?;
        if metadata.is_dir() && !metadata.file_type().is_symlink() {
            ensure_contained(root, &child)?;
            remove_empty_directories(root, &child)?;
        }
    }
    if directory != root
        && fs::read_dir(directory)
            .map_err(|error| format!("Failed to read {}: {error}", directory.display()))?
            .next()
            .is_none()
    {
        fs::remove_dir(directory)
            .map_err(|error| format!("Failed to remove {}: {error}", directory.display()))?;
    }
    Ok(())
}

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    const MANAGER_ID: &str = "manager_MDEyMzQ1Njc4OTAxMjM0NTY3";

    #[test]
    fn synchronizes_exact_owned_set_without_changing_local_prompts() {
        let root = temporary_directory("exact");
        fs::create_dir_all(&root).expect("root should be created");
        fs::write(root.join("local.prompt.md"), "local").expect("local prompt should be written");
        synchronize_at(&root, MANAGER_ID, &[prompt("reviews/one.prompt.md", "one")])
            .expect("first synchronization should succeed");
        synchronize_at(&root, MANAGER_ID, &[prompt("two.prompt.md", "two")])
            .expect("second synchronization should succeed");

        assert_eq!(
            fs::read_to_string(root.join("local.prompt.md")).expect("local prompt should remain"),
            "local"
        );
        let managed = root.join(".fleet-managed").join(MANAGER_ID);
        assert!(!managed.join("reviews/one.prompt.md").exists());
        assert_eq!(
            fs::read_to_string(managed.join("two.prompt.md")).expect("managed prompt should exist"),
            "two"
        );
        fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn rejects_paths_outside_the_managed_root() {
        let root = temporary_directory("traversal");
        fs::create_dir_all(&root).expect("root should be created");
        let result = synchronize_at(&root, MANAGER_ID, &[prompt("../outside.prompt.md", "bad")]);

        assert!(result.is_err());
        assert!(!root
            .parent()
            .expect("root should have a parent")
            .join("outside.prompt.md")
            .exists());
        fs::remove_dir_all(root).expect("test directory should be removed");
    }

    fn prompt(relative_path: &str, content: &str) -> FleetManagedPrompt {
        FleetManagedPrompt {
            id: "123e4567-e89b-12d3-a456-426614174000".to_string(),
            relative_path: relative_path.to_string(),
            content: content.to_string(),
        }
    }

    fn temporary_directory(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "machdoch-managed-prompts-{label}-{}-{nonce}",
            std::process::id()
        ))
    }
}
