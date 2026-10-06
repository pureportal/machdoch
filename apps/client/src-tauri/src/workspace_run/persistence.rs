use std::{
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

use serde::Deserialize;

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::with_cooperative_file_lock,
};

use super::model::{
    validate_document, validate_schema_version, RunConfiguration, RunConfigurationDocument,
};

const MAX_CONFIGURATION_DOCUMENT_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunConfigurationDocumentHeader {
    schema_version: u32,
}

enum DeserializeDocumentError {
    Json(serde_json::Error),
    Schema(String),
}

fn deserialize_document(
    document_json: &str,
) -> Result<RunConfigurationDocument, DeserializeDocumentError> {
    let header = serde_json::from_str::<RunConfigurationDocumentHeader>(document_json)
        .map_err(DeserializeDocumentError::Json)?;
    validate_schema_version(header.schema_version).map_err(DeserializeDocumentError::Schema)?;
    serde_json::from_str::<RunConfigurationDocument>(document_json)
        .map_err(DeserializeDocumentError::Json)
}

pub fn configuration_path(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".machdoch").join("run.json")
}

pub fn load_document(workspace_root: &Path) -> Result<RunConfigurationDocument, String> {
    let path = configuration_path(workspace_root);
    let file = match fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RunConfigurationDocument::default());
        }
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    read_document(file, &path)
}

fn read_document(reader: impl Read, path: &Path) -> Result<RunConfigurationDocument, String> {
    let mut bytes = Vec::new();
    reader
        .take(MAX_CONFIGURATION_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    if bytes.len() as u64 > MAX_CONFIGURATION_DOCUMENT_BYTES {
        return Err(format!(
            "Run configuration {} exceeds the 1 MB limit.",
            path.display()
        ));
    }
    let raw = String::from_utf8(bytes)
        .map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    let document = deserialize_document(&raw).map_err(|error| match error {
        DeserializeDocumentError::Json(error) => {
            format!("Failed to parse {}: {error}", path.display())
        }
        DeserializeDocumentError::Schema(message) => message,
    })?;
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
        let mut serialized = serde_json::to_string_pretty(document)
            .map_err(|error| format!("Failed to serialize run configurations: {error}"))?;
        serialized.push('\n');
        if serialized.len() as u64 > MAX_CONFIGURATION_DOCUMENT_BYTES {
            return Err("Run configuration exceeds the 1 MB limit.".to_string());
        }
        write_file_atomic(&path, serialized.as_bytes(), AtomicWriteOptions::default())
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
    let document = deserialize_document(document_json).map_err(|error| match error {
        DeserializeDocumentError::Json(error) => {
            format!("Invalid run configuration JSON: {error}")
        }
        DeserializeDocumentError::Schema(message) => message,
    })?;
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
#[path = "persistence_byte_budget_tests.rs"]
mod byte_budget_tests;

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        env, fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::workspace_run::model::{RunRestartPolicy, RUN_SCHEMA_VERSION};

    pub(super) fn temporary_workspace(name: &str) -> PathBuf {
        static NEXT_WORKSPACE_ID: AtomicU64 = AtomicU64::new(0);
        let path = env::temp_dir().join(format!(
            "machdoch-run-persistence-{}-{}-{}-{name}",
            std::process::id(),
            NEXT_WORKSPACE_ID.fetch_add(1, Ordering::Relaxed),
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
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![RunConfiguration::Task {
                id: "server".to_string(),
                name: "Server".to_string(),
                primary: true,
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

    #[test]
    fn rejects_non_current_configuration_documents() {
        let workspace = temporary_workspace("non-current-schema");
        fs::create_dir_all(workspace.join(".machdoch"))
            .expect("configuration directory should be created");
        let document = r#"{"schemaVersion":1,"primaryConfigurationId":null,"configurations":[]}"#;
        fs::write(configuration_path(&workspace), document)
            .expect("configuration should be written");
        assert!(load_document(&workspace).is_err());
        assert!(precheck_document(&workspace, document).is_err());
        let _ = fs::remove_dir_all(workspace);
    }
}
