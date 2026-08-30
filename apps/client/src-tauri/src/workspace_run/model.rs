use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

pub const RUN_SCHEMA_VERSION: u32 = 2;
pub const RUN_EVENT_NAME: &str = "workspace-run-state-changed";
pub const RUN_LOG_EVENT_NAME: &str = "workspace-run-log-appended";
pub const MAX_LOG_ENTRIES: usize = 400;
pub const MAX_FAILURE_ENTRIES: usize = 12;

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunConfigurationDocument {
    pub schema_version: u32,
    pub configurations: Vec<RunConfiguration>,
}

impl Default for RunConfigurationDocument {
    fn default() -> Self {
        Self {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunConfiguration {
    Task {
        id: String,
        name: String,
        primary: bool,
        command: String,
        #[serde(default = "default_working_directory")]
        working_directory: String,
        #[serde(default)]
        environment: BTreeMap<String, String>,
        #[serde(default)]
        hot_reload: bool,
        #[serde(default)]
        ports: Vec<u16>,
        #[serde(default)]
        urls: Vec<String>,
        health_check: Option<Box<RunHealthCheck>>,
        #[serde(default)]
        restart_policy: RunRestartPolicy,
    },
    Composite {
        id: String,
        name: String,
        primary: bool,
        children: Vec<String>,
        #[serde(default)]
        start_order: CompositeStartOrder,
    },
}

fn default_working_directory() -> String {
    ".".to_string()
}

impl RunConfiguration {
    pub fn id(&self) -> &str {
        match self {
            Self::Task { id, .. } | Self::Composite { id, .. } => id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Task { name, .. } | Self::Composite { name, .. } => name,
        }
    }

    pub fn is_primary(&self) -> bool {
        match self {
            Self::Task { primary, .. } | Self::Composite { primary, .. } => *primary,
        }
    }
}

impl RunConfigurationDocument {
    pub fn primary_configuration(&self) -> Option<&RunConfiguration> {
        self.configurations
            .iter()
            .find(|configuration| configuration.is_primary())
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CompositeStartOrder {
    #[default]
    Parallel,
    Sequence,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunHealthCheck {
    pub kind: RunHealthCheckKind,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub url: Option<String>,
    #[serde(default)]
    pub restart_on_failure: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunHealthCheckKind {
    Tcp,
    Http,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunRestartPolicy {
    #[serde(default)]
    pub on_crash: bool,
    #[serde(default = "default_max_restarts")]
    pub max_restarts: u32,
    #[serde(default = "default_restart_window_ms")]
    pub window_ms: u64,
    #[serde(default = "default_restart_backoff_ms")]
    pub backoff_ms: u64,
    #[serde(default = "default_max_restart_backoff_ms")]
    pub max_backoff_ms: u64,
}

impl Default for RunRestartPolicy {
    fn default() -> Self {
        Self {
            on_crash: false,
            max_restarts: default_max_restarts(),
            window_ms: default_restart_window_ms(),
            backoff_ms: default_restart_backoff_ms(),
            max_backoff_ms: default_max_restart_backoff_ms(),
        }
    }
}

fn default_max_restarts() -> u32 {
    5
}

fn default_restart_window_ms() -> u64 {
    60_000
}

fn default_restart_backoff_ms() -> u64 {
    1_000
}

fn default_max_restart_backoff_ms() -> u64 {
    30_000
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunLifecycleState {
    Stopped,
    Starting,
    Running,
    Unhealthy,
    Restarting,
    Crashed,
    Stopping,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogEntry {
    pub sequence: u64,
    pub at: u64,
    pub stream: RunLogStream,
    pub line: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogUpdate {
    pub configuration_id: String,
    pub started_at: u64,
    pub entry: RunLogEntry,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLogBatch {
    pub workspace_root: String,
    pub entries: Vec<RunLogUpdate>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunLogStream {
    System,
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFailure {
    pub at: u64,
    pub kind: RunFailureKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RunFailureKind {
    Crash,
    Health,
    Launch,
    RestartLimit,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHealthStatus {
    pub state: RunHealthState,
    pub checked_at: Option<u64>,
    pub consecutive_failures: u32,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunHealthState {
    Pending,
    Healthy,
    Failed,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunConfigurationStatus {
    pub configuration: RunConfiguration,
    pub state: RunLifecycleState,
    pub pid: Option<u32>,
    pub started_at: Option<u64>,
    pub stopped_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub restart_count: u32,
    pub health: Option<RunHealthStatus>,
    pub recent_failures: Vec<RunFailure>,
    pub logs: Vec<RunLogEntry>,
    pub children: Vec<RunConfigurationStatus>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunWorkspaceSnapshot {
    pub workspace_root: String,
    pub primary_configuration_id: Option<String>,
    pub configurations: Vec<RunConfigurationStatus>,
}

pub fn validate_document(document: &RunConfigurationDocument) -> Result<(), String> {
    if document.schema_version > RUN_SCHEMA_VERSION {
        return Err(format!(
            "Run configuration schemaVersion {} is newer than supported version {RUN_SCHEMA_VERSION}.",
            document.schema_version
        ));
    }
    if document.schema_version != RUN_SCHEMA_VERSION {
        return Err(format!(
            "Run configuration schemaVersion must be {RUN_SCHEMA_VERSION}."
        ));
    }
    if document.configurations.len() > 64 {
        return Err("A workspace can contain at most 64 run configurations.".to_string());
    }

    let mut ids = HashSet::new();
    for configuration in &document.configurations {
        validate_identifier(configuration.id())?;
        validate_name(configuration.name())?;
        if !ids.insert(configuration.id()) {
            return Err(format!(
                "Run configuration id `{}` is duplicated.",
                configuration.id()
            ));
        }

        match configuration {
            RunConfiguration::Task {
                command,
                working_directory,
                environment,
                ports,
                urls,
                health_check,
                restart_policy,
                ..
            } => {
                if command.trim().is_empty() || command.len() > 8_192 || command.contains('\0') {
                    return Err(format!(
                        "Run configuration `{}` needs a command of at most 8192 characters.",
                        configuration.id()
                    ));
                }
                if working_directory.trim().is_empty()
                    || working_directory.trim() != working_directory
                    || working_directory.len() > 1_024
                    || working_directory.contains('\0')
                {
                    return Err(format!(
                        "Run configuration `{}` needs a workingDirectory.",
                        configuration.id()
                    ));
                }
                if environment.len() > 128
                    || environment.iter().any(|(key, value)| {
                        key.trim().is_empty()
                            || key.len() > 256
                            || value.len() > 8_192
                            || key.contains('\0')
                            || key.contains('=')
                            || value.contains('\0')
                    })
                    || environment
                        .iter()
                        .map(|(key, value)| key.len().saturating_add(value.len()))
                        .sum::<usize>()
                        > 256 * 1024
                {
                    return Err(format!(
                        "Run configuration `{}` contains an invalid environment value.",
                        configuration.id()
                    ));
                }
                if ports.len() > 32
                    || ports.contains(&0)
                    || ports.iter().collect::<HashSet<_>>().len() != ports.len()
                    || urls.len() > 32
                    || urls.iter().any(|url| !is_valid_run_url(url))
                    || urls.iter().collect::<HashSet<_>>().len() != urls.len()
                {
                    return Err(format!(
                        "Run configuration `{}` has invalid ports or URLs.",
                        configuration.id()
                    ));
                }
                validate_restart_policy(configuration.id(), restart_policy)?;
                if let Some(health_check) = health_check {
                    validate_health_check(configuration.id(), health_check)?;
                }
            }
            RunConfiguration::Composite { children, .. } => {
                if children.is_empty() || children.len() > 32 {
                    return Err(format!(
                        "Composite run configuration `{}` needs between 1 and 32 child tasks.",
                        configuration.id()
                    ));
                }
                let unique_children = children.iter().collect::<HashSet<_>>();
                if unique_children.len() != children.len() {
                    return Err(format!(
                        "Composite run configuration `{}` contains duplicate child tasks.",
                        configuration.id()
                    ));
                }
            }
        }
    }

    let by_id = document
        .configurations
        .iter()
        .map(|configuration| (configuration.id(), configuration))
        .collect::<HashMap<_, _>>();

    let primary_count = document
        .configurations
        .iter()
        .filter(|configuration| configuration.is_primary())
        .count();
    if !document.configurations.is_empty() && primary_count != 1 {
        return Err("Choose exactly one primary run configuration.".to_string());
    }

    let mut composite_owners = HashMap::<&str, &str>::new();
    for configuration in &document.configurations {
        if let RunConfiguration::Composite { children, .. } = configuration {
            for child_id in children {
                let child = by_id.get(child_id.as_str()).ok_or_else(|| {
                    format!(
                        "Composite run configuration `{}` references missing child `{child_id}`.",
                        configuration.id()
                    )
                })?;
                if matches!(child, RunConfiguration::Composite { .. }) {
                    return Err(format!(
                        "Composite run configuration `{}` can only contain task configurations.",
                        configuration.id()
                    ));
                }
                if let Some(owner) = composite_owners.insert(child_id, configuration.id()) {
                    return Err(format!(
                        "Run task `{child_id}` belongs to both `{owner}` and `{}`.",
                        configuration.id()
                    ));
                }
            }
        }
    }

    Ok(())
}

fn validate_identifier(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 96
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err(format!("Run configuration id `{value}` is invalid."));
    }
    Ok(())
}

fn validate_name(value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.trim() != value
        || value.chars().count() > 120
        || value.chars().any(char::is_control)
    {
        return Err(
            "Run configuration names must contain between 1 and 120 characters.".to_string(),
        );
    }
    Ok(())
}

fn validate_restart_policy(id: &str, policy: &RunRestartPolicy) -> Result<(), String> {
    if policy.max_restarts > 100
        || !(1_000..=86_400_000).contains(&policy.window_ms)
        || policy.backoff_ms > 300_000
        || policy.max_backoff_ms > 600_000
        || policy.max_backoff_ms < policy.backoff_ms
    {
        return Err(format!(
            "Run configuration `{id}` has an invalid restartPolicy."
        ));
    }
    Ok(())
}

fn validate_health_check(id: &str, health_check: &RunHealthCheck) -> Result<(), String> {
    match health_check.kind {
        RunHealthCheckKind::Tcp => {
            if health_check.port.is_none_or(|port| port == 0) {
                return Err(format!("TCP health check for `{id}` needs a port."));
            }
            if health_check
                .host
                .as_deref()
                .is_some_and(|host| host.len() > 253 || host.contains('\0'))
            {
                return Err(format!("TCP health check host for `{id}` is invalid."));
            }
            Ok(())
        }
        RunHealthCheckKind::Http => {
            let url = health_check
                .url
                .as_deref()
                .ok_or_else(|| format!("HTTP health check for `{id}` needs a URL."))?;
            if url.len() > 2_048 {
                return Err(format!(
                    "HTTP health check URL for `{id}` exceeds 2048 characters."
                ));
            }
            let parsed = reqwest::Url::parse(url)
                .map_err(|_| format!("HTTP health check URL for `{id}` is invalid."))?;
            if !matches!(parsed.scheme(), "http" | "https") {
                return Err(format!(
                    "HTTP health check URL for `{id}` must use http or https."
                ));
            }
            Ok(())
        }
    }
}

fn is_valid_run_url(value: &str) -> bool {
    if value.trim() != value || value.is_empty() || value.len() > 2_048 {
        return false;
    }
    reqwest::Url::parse(value)
        .map(|url| matches!(url.scheme(), "http" | "https"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str) -> RunConfiguration {
        RunConfiguration::Task {
            id: id.to_string(),
            name: id.to_string(),
            primary: false,
            command: "example".to_string(),
            working_directory: ".".to_string(),
            environment: BTreeMap::new(),
            hot_reload: false,
            ports: Vec::new(),
            urls: Vec::new(),
            health_check: None,
            restart_policy: RunRestartPolicy::default(),
        }
    }

    fn primary(mut configuration: RunConfiguration) -> RunConfiguration {
        match &mut configuration {
            RunConfiguration::Task { primary, .. }
            | RunConfiguration::Composite { primary, .. } => *primary = true,
        }
        configuration
    }

    #[test]
    fn validates_task_and_composite_documents() {
        let document = RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![
                task("backend"),
                task("frontend"),
                RunConfiguration::Composite {
                    id: "fullstack".to_string(),
                    name: "Fullstack Start".to_string(),
                    primary: true,
                    children: vec!["backend".to_string(), "frontend".to_string()],
                    start_order: CompositeStartOrder::Parallel,
                },
            ],
        };

        validate_document(&document).expect("valid composite should pass");
    }

    #[test]
    fn requires_exactly_one_primary_configuration() {
        let without_primary = RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![task("application"), task("worker")],
        };
        assert_eq!(
            validate_document(&without_primary),
            Err("Choose exactly one primary run configuration.".to_string())
        );

        let multiple_primary = RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![primary(task("application")), primary(task("worker"))],
        };
        assert_eq!(
            validate_document(&multiple_primary),
            Err("Choose exactly one primary run configuration.".to_string())
        );
    }

    #[test]
    fn serializes_primary_on_camel_case_configurations() {
        let document = RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![primary(task("application"))],
        };

        let serialized = serde_json::to_value(&document).expect("document should serialize");
        assert_eq!(serialized["schemaVersion"], RUN_SCHEMA_VERSION);
        assert_eq!(serialized["configurations"][0]["primary"], true);
        assert_eq!(serialized["configurations"][0]["workingDirectory"], ".");
        assert!(serialized.get("primaryConfigurationId").is_none());
        assert!(serialized["configurations"][0]
            .get("working_directory")
            .is_none());
        assert_eq!(
            serde_json::from_value::<RunConfigurationDocument>(serialized)
                .expect("document should deserialize"),
            document
        );
    }

    #[test]
    fn rejects_missing_and_composite_children() {
        let document = RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![
                RunConfiguration::Composite {
                    id: "inner".to_string(),
                    name: "Inner".to_string(),
                    primary: false,
                    children: vec!["missing".to_string()],
                    start_order: CompositeStartOrder::Parallel,
                },
                RunConfiguration::Composite {
                    id: "outer".to_string(),
                    name: "Outer".to_string(),
                    primary: true,
                    children: vec!["inner".to_string()],
                    start_order: CompositeStartOrder::Parallel,
                },
            ],
        };

        assert!(validate_document(&document).is_err());
    }

    #[test]
    fn rejects_unbounded_restart_settings() {
        let mut configuration = task("server");
        if let RunConfiguration::Task {
            primary,
            health_check,
            restart_policy,
            ..
        } = &mut configuration
        {
            *primary = true;
            *health_check = Some(Box::new(RunHealthCheck {
                kind: RunHealthCheckKind::Tcp,
                host: None,
                port: Some(3000),
                url: None,
                restart_on_failure: true,
            }));
            restart_policy.max_restarts = 101;
        }
        let document = RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![configuration],
        };

        assert!(validate_document(&document).is_err());
    }

    #[test]
    fn rejects_invalid_urls_ports_names_and_shared_composite_children() {
        let mut invalid_task = task("server");
        if let RunConfiguration::Task {
            primary,
            ports,
            urls,
            ..
        } = &mut invalid_task
        {
            *primary = true;
            *ports = vec![0, 3000, 3000];
            *urls = vec!["javascript:alert(1)".to_string()];
        }
        let invalid_document = RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![invalid_task],
        };
        assert!(validate_document(&invalid_document).is_err());

        let shared_document = RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![
                task("server"),
                RunConfiguration::Composite {
                    id: "first".to_string(),
                    name: "First".to_string(),
                    primary: true,
                    children: vec!["server".to_string()],
                    start_order: CompositeStartOrder::Parallel,
                },
                RunConfiguration::Composite {
                    id: "second".to_string(),
                    name: "Second".to_string(),
                    primary: false,
                    children: vec!["server".to_string()],
                    start_order: CompositeStartOrder::Parallel,
                },
            ],
        };
        assert!(validate_document(&shared_document).is_err());

        let mut invalid_name = task("named");
        if let RunConfiguration::Task { name, primary, .. } = &mut invalid_name {
            *name = " Named ".to_string();
            *primary = true;
        }
        assert!(validate_document(&RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            configurations: vec![invalid_name],
        })
        .is_err());
    }
}
