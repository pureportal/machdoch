use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::with_cooperative_file_lock,
};

use super::model::{validate_document, RunConfiguration, RunConfigurationDocument};

const MAX_CONFIGURATION_DOCUMENT_BYTES: u64 = 1024 * 1024;

pub fn configuration_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".machdoch").join("run.json")
}

pub fn load_document(workspace_root: &Path) -> Result<RunConfigurationDocument, String> {
    let path = configuration_path(workspace_root);
    if !path.exists() {
        return Ok(RunConfigurationDocument::default());
    }
    let size = fs::metadata(&path)
        .map_err(|error| format!("Failed to inspect {}: {error}", path.display()))?
        .len();
    if size > MAX_CONFIGURATION_DOCUMENT_BYTES {
        return Err(format!(
            "Run configuration {} exceeds the 1 MB limit.",
            path.display()
        ));
    }

    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let document = serde_json::from_str::<RunConfigurationDocument>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", path.display()))?;
    validate_document(&document)?;
    Ok(document)
}

pub fn save_document(
    workspace_root: &Path,
    document: &RunConfigurationDocument,
) -> Result<PathBuf, String> {
    validate_document(document)?;
    validate_working_directories(workspace_root, document)?;
    let path = configuration_path(workspace_root);
    with_cooperative_file_lock(&path, || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
        }
        let serialized = serde_json::to_string_pretty(document)
            .map_err(|error| format!("Failed to serialize run configurations: {error}"))?;
        if serialized.len() as u64 > MAX_CONFIGURATION_DOCUMENT_BYTES {
            return Err("Run configuration exceeds the 1 MB limit.".to_string());
        }
        write_file_atomic(
            &path,
            format!("{serialized}\n").as_bytes(),
            AtomicWriteOptions::default(),
        )
        .map_err(|error| format!("Failed to write {}: {error}", path.display()))
    })?;
    Ok(path)
}

pub fn precheck_document(
    workspace_root: &Path,
    document_json: &str,
) -> Result<RunConfigurationDocument, String> {
    if document_json.len() as u64 > MAX_CONFIGURATION_DOCUMENT_BYTES {
        return Err("Run configuration exceeds the 1 MB limit.".to_string());
    }
    let document = serde_json::from_str::<RunConfigurationDocument>(document_json)
        .map_err(|error| format!("Invalid run configuration JSON: {error}"))?;
    validate_document(&document)?;
    validate_working_directories(workspace_root, &document)?;
    Ok(document)
}

pub fn resolve_working_directory(
    workspace_root: &Path,
    configured_directory: &str,
) -> Result<PathBuf, String> {
    let configured = Path::new(configured_directory.trim());
    if configured.is_absolute()
        || configured
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::Prefix(_)))
    {
        return Err(format!(
            "Run workingDirectory `{configured_directory}` must stay inside the workspace."
        ));
    }

    let candidate = workspace_root.join(configured);
    if !candidate.exists() || !candidate.is_dir() {
        return Err(format!(
            "Run workingDirectory `{configured_directory}` does not exist."
        ));
    }
    let resolved = candidate.canonicalize().map_err(|error| {
        format!("Unable to resolve run workingDirectory `{configured_directory}`: {error}")
    })?;
    if !resolved.starts_with(workspace_root) {
        return Err(format!(
            "Run workingDirectory `{configured_directory}` resolves outside the workspace."
        ));
    }
    Ok(resolved)
}

fn validate_working_directories(
    workspace_root: &Path,
    document: &RunConfigurationDocument,
) -> Result<(), String> {
    for configuration in &document.configurations {
        if let RunConfiguration::Task {
            working_directory, ..
        } = configuration
        {
            resolve_working_directory(workspace_root, working_directory)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::workspace_run::model::RunRestartPolicy;

    fn temporary_workspace(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "machdoch-run-persistence-{}-{}-{name}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&path).expect("temporary workspace should be created");
        path.canonicalize().expect("workspace should canonicalize")
    }

    #[test]
    fn working_directories_are_workspace_relative_on_every_platform() {
        let workspace = temporary_workspace("relative");
        fs::create_dir_all(workspace.join("apps").join("web"))
            .expect("nested working directory should be created");

        let resolved = resolve_working_directory(&workspace, "apps/web")
            .expect("relative directory should resolve");

        assert_eq!(resolved, workspace.join("apps").join("web"));
        assert!(resolve_working_directory(&workspace, "../outside").is_err());
        assert!(resolve_working_directory(&workspace, "missing").is_err());
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn precheck_rejects_invalid_json_and_invalid_workspace_directories() {
        let workspace = temporary_workspace("precheck");
        let invalid_json =
            precheck_document(&workspace, "{").expect_err("invalid JSON should be rejected");
        assert!(invalid_json.contains("Invalid run configuration JSON"));

        let document = RunConfigurationDocument {
            schema_version: 1,
            primary_configuration_id: Some("server".to_string()),
            configurations: vec![RunConfiguration::Task {
                id: "server".to_string(),
                name: "Server".to_string(),
                command: "run-server".to_string(),
                working_directory: "apps/server".to_string(),
                environment: BTreeMap::new(),
                hot_reload: false,
                ports: Vec::new(),
                urls: Vec::new(),
                health_check: None,
                restart_policy: RunRestartPolicy::default(),
            }],
        };
        let serialized =
            serde_json::to_string(&document).expect("run configuration should serialize");
        assert!(precheck_document(&workspace, &serialized).is_err());

        fs::create_dir_all(workspace.join("apps").join("server"))
            .expect("working directory should be created");
        assert_eq!(
            precheck_document(&workspace, &serialized)
                .expect("valid configuration should pass precheck"),
            document
        );
        let _ = fs::remove_dir_all(workspace);
    }
}
