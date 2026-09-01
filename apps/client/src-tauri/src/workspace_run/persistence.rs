use std::{
    collections::BTreeMap,
    fs,
    path::{Component, Path, PathBuf},
};

use serde::Deserialize;

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::with_cooperative_file_lock,
};

use super::model::{
    validate_document, validate_schema_version, CompositeStartOrder, RunConfiguration,
    RunConfigurationDocument, RunHealthCheck, RunRestartPolicy, RUN_SCHEMA_VERSION,
};

const MAX_CONFIGURATION_DOCUMENT_BYTES: u64 = 1024 * 1024;
const LEGACY_RUN_SCHEMA_VERSION: u32 = 1;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunConfigurationDocumentHeader {
    schema_version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRunConfigurationDocument {
    primary_configuration_id: Option<String>,
    configurations: Vec<LegacyRunConfiguration>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum LegacyRunConfiguration {
    Task {
        id: String,
        name: String,
        command: String,
        #[serde(
            default = "legacy_default_working_directory",
            alias = "workingDirectory"
        )]
        working_directory: String,
        #[serde(default)]
        environment: BTreeMap<String, String>,
        #[serde(default, alias = "hotReload")]
        hot_reload: bool,
        #[serde(default)]
        ports: Vec<u16>,
        #[serde(default)]
        urls: Vec<String>,
        #[serde(alias = "healthCheck")]
        health_check: Option<Box<RunHealthCheck>>,
        #[serde(default, alias = "restartPolicy")]
        restart_policy: RunRestartPolicy,
    },
    Composite {
        id: String,
        name: String,
        children: Vec<String>,
        #[serde(default, alias = "startOrder")]
        start_order: CompositeStartOrder,
    },
}

enum DeserializeDocumentError {
    Json(serde_json::Error),
    Schema(String),
}

impl LegacyRunConfigurationDocument {
    fn migrate(self) -> RunConfigurationDocument {
        let primary_configuration_id = self.primary_configuration_id;
        let configurations = self
            .configurations
            .into_iter()
            .map(|configuration| configuration.migrate(primary_configuration_id.as_deref()))
            .collect();
        RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations,
        }
    }
}

impl LegacyRunConfiguration {
    fn migrate(self, primary_configuration_id: Option<&str>) -> RunConfiguration {
        match self {
            Self::Task {
                id,
                name,
                command,
                working_directory,
                environment,
                hot_reload,
                ports,
                urls,
                health_check,
                restart_policy,
            } => {
                let primary = primary_configuration_id == Some(id.as_str());
                RunConfiguration::Task {
                    id,
                    name,
                    primary,
                    command,
                    working_directory,
                    environment,
                    hot_reload,
                    ports,
                    urls,
                    health_check,
                    restart_policy,
                }
            }
            Self::Composite {
                id,
                name,
                children,
                start_order,
            } => {
                let primary = primary_configuration_id == Some(id.as_str());
                RunConfiguration::Composite {
                    id,
                    name,
                    primary,
                    children,
                    start_order,
                }
            }
        }
    }
}

fn legacy_default_working_directory() -> String {
    ".".to_string()
}

fn deserialize_document(
    document_json: &str,
) -> Result<RunConfigurationDocument, DeserializeDocumentError> {
    let header = serde_json::from_str::<RunConfigurationDocumentHeader>(document_json)
        .map_err(DeserializeDocumentError::Json)?;
    match header.schema_version {
        LEGACY_RUN_SCHEMA_VERSION => {
            serde_json::from_str::<LegacyRunConfigurationDocument>(document_json)
                .map(LegacyRunConfigurationDocument::migrate)
                .map_err(DeserializeDocumentError::Json)
        }
        RUN_SCHEMA_VERSION => serde_json::from_str::<RunConfigurationDocument>(document_json)
            .map_err(DeserializeDocumentError::Json),
        schema_version => Err(DeserializeDocumentError::Schema(
            validate_schema_version(schema_version)
                .expect_err("non-current schema version should be rejected"),
        )),
    }
}

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
mod tests {
    use std::{
        collections::BTreeMap,
        env, fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::workspace_run::model::{RunRestartPolicy, RUN_SCHEMA_VERSION};

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
    fn loads_empty_schema_version_one_as_the_current_document() {
        let workspace = temporary_workspace("empty-version-one");
        fs::create_dir_all(workspace.join(".machdoch"))
            .expect("configuration directory should be created");
        fs::write(
            configuration_path(&workspace),
            r#"{
                "schemaVersion": 1,
                "primaryConfigurationId": null,
                "configurations": []
            }"#,
        )
        .expect("legacy configuration should be written");

        assert_eq!(
            load_document(&workspace).expect("legacy configuration should load"),
            RunConfigurationDocument::default()
        );
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn precheck_migrates_schema_version_one_fields() {
        let workspace = temporary_workspace("version-one-fields");
        fs::create_dir_all(workspace.join("apps").join("server"))
            .expect("working directory should be created");
        let legacy_document = serde_json::json!({
            "schemaVersion": 1,
            "primaryConfigurationId": "server",
            "configurations": [
                {
                    "id": "server",
                    "name": "Server",
                    "kind": "task",
                    "command": "run-server",
                    "working_directory": "apps/server",
                    "environment": { "MODE": "development" },
                    "hot_reload": true,
                    "ports": [3000],
                    "urls": ["http://localhost:3000"],
                    "health_check": {
                        "kind": "tcp",
                        "host": "127.0.0.1",
                        "port": 3000,
                        "startupDelayMs": 3000,
                        "intervalMs": 5000,
                        "timeoutMs": 2000,
                        "failureThreshold": 3,
                        "restartOnFailure": true
                    },
                    "restart_policy": {
                        "onCrash": true,
                        "maxRestarts": 4,
                        "windowMs": 60000,
                        "backoffMs": 1000,
                        "maxBackoffMs": 30000
                    }
                }
            ]
        })
        .to_string();

        let migrated = precheck_document(&workspace, &legacy_document)
            .expect("legacy configuration should pass precheck");
        assert_eq!(migrated.schema_version, RUN_SCHEMA_VERSION);
        let RunConfiguration::Task {
            primary,
            working_directory,
            hot_reload,
            health_check,
            restart_policy,
            ..
        } = &migrated.configurations[0]
        else {
            panic!("legacy task should remain a task");
        };
        assert!(*primary);
        assert_eq!(working_directory, "apps/server");
        assert!(*hot_reload);
        assert!(health_check
            .as_ref()
            .is_some_and(|health_check| health_check.restart_on_failure));
        assert!(restart_policy.on_crash);
        assert_eq!(restart_policy.max_restarts, 4);

        let serialized =
            serde_json::to_value(migrated).expect("migrated configuration should serialize");
        assert!(serialized.get("primaryConfigurationId").is_none());
        assert_eq!(serialized["configurations"][0]["primary"], true);
        assert!(serialized["configurations"][0]["healthCheck"]
            .get("startupDelayMs")
            .is_none());
        let _ = fs::remove_dir_all(workspace);
    }
}
