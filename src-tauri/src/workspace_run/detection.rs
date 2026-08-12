use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
};

use serde_json::Value;

use super::model::{
    CompositeStartOrder, RunConfiguration, RunConfigurationDocument, RunDetection,
    RunDetectionConfidence, RunDetectionResult, RunRestartPolicy, RUN_SCHEMA_VERSION,
};

const IGNORED_DIRECTORIES: &[&str] = &[
    ".git",
    ".machdoch",
    ".cache",
    "node_modules",
    "target",
    "dist",
    "build",
    "coverage",
    ".next",
];
const MAX_PACKAGE_FILES: usize = 32;

pub fn detect_configurations(workspace_root: &Path) -> Result<RunDetectionResult, String> {
    let package_paths = find_package_files(workspace_root)?;
    let mut configurations = Vec::new();
    let mut detections = Vec::new();
    let mut ids = HashSet::new();
    let mut root_orchestrator_id = None;

    for package_path in package_paths {
        if let Some((configuration, detection, orchestrates_workspace)) =
            detect_package_configuration(workspace_root, &package_path)?
        {
            let id = unique_identifier(configuration.id(), &mut ids);
            let configuration = with_identifier(configuration, id.clone());
            let mut detection = detection;
            detection.configuration_id = id;
            if orchestrates_workspace {
                root_orchestrator_id = Some(detection.configuration_id.clone());
            }
            configurations.push(configuration);
            detections.push(detection);
        }
    }

    detect_non_node_configurations(
        workspace_root,
        &mut configurations,
        &mut detections,
        &mut ids,
    )?;

    let primary_configuration_id = if let Some(root_id) = root_orchestrator_id {
        Some(root_id)
    } else if configurations.len() > 1 {
        let children = configurations
            .iter()
            .map(|configuration| configuration.id().to_string())
            .collect::<Vec<_>>();
        let id = unique_identifier("fullstack-start", &mut ids);
        configurations.push(RunConfiguration::Composite {
            id: id.clone(),
            name: "Fullstack Start".to_string(),
            children,
            start_order: CompositeStartOrder::Parallel,
        });
        detections.push(RunDetection {
            configuration_id: id.clone(),
            confidence: RunDetectionConfidence::High,
            evidence: vec!["Multiple runnable applications were detected.".to_string()],
            uncertain_fields: Vec::new(),
        });
        Some(id)
    } else {
        configurations
            .first()
            .map(|configuration| configuration.id().to_string())
    };

    Ok(RunDetectionResult {
        document: RunConfigurationDocument {
            schema_version: RUN_SCHEMA_VERSION,
            primary_configuration_id,
            configurations,
        },
        detections,
    })
}

fn find_package_files(workspace_root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut queue = VecDeque::from([(workspace_root.to_path_buf(), 0_u8)]);
    let mut package_paths = Vec::new();

    while let Some((directory, depth)) = queue.pop_front() {
        let package_path = directory.join("package.json");
        if package_path.is_file() && package_paths.len() < MAX_PACKAGE_FILES {
            package_paths.push(package_path);
        }
        if depth >= 3 || package_paths.len() >= MAX_PACKAGE_FILES {
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if directory == workspace_root => {
                return Err(format!(
                    "Failed to inspect workspace {}: {error}",
                    workspace_root.display()
                ));
            }
            Err(_) => continue,
        };
        let mut child_directories = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if IGNORED_DIRECTORIES.contains(&name.as_ref()) {
                continue;
            }
            if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                child_directories.push(entry.path());
            }
        }
        child_directories.sort();
        queue.extend(child_directories.into_iter().map(|path| (path, depth + 1)));
    }

    package_paths.sort();
    Ok(package_paths)
}

fn detect_package_configuration(
    workspace_root: &Path,
    package_path: &Path,
) -> Result<Option<(RunConfiguration, RunDetection, bool)>, String> {
    let raw = fs::read_to_string(package_path)
        .map_err(|error| format!("Failed to read {}: {error}", package_path.display()))?;
    let package = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("Failed to parse {}: {error}", package_path.display()))?;
    let scripts = package.get("scripts").and_then(Value::as_object);
    let Some((script_name, script_command)) = ["dev", "start", "serve", "watch"]
        .into_iter()
        .find_map(|name| {
            scripts?
                .get(name)
                .and_then(Value::as_str)
                .map(|command| (name, command))
        })
    else {
        return Ok(None);
    };

    let package_directory = package_path.parent().unwrap_or(workspace_root);
    let relative_directory = package_directory
        .strip_prefix(workspace_root)
        .unwrap_or(package_directory);
    let working_directory = if relative_directory.as_os_str().is_empty() {
        ".".to_string()
    } else {
        relative_directory.to_string_lossy().replace('\\', "/")
    };
    let package_name = package
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .or_else(|| {
            package_directory
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "Application".to_string());
    let manager = detect_package_manager(workspace_root, package_directory);
    let command = format!("{manager} run {script_name}");
    let hot_reload = detects_hot_reload(script_name, script_command);
    let orchestrates_workspace =
        package_directory == workspace_root && detects_workspace_orchestration(script_command);
    let ports = detect_explicit_ports(script_command);
    let urls = detect_explicit_urls(script_command);
    let id = sanitize_identifier(&format!("{}-{script_name}", working_directory));
    let name = if working_directory == "." {
        package_name.clone()
    } else {
        format!("{package_name}: {script_name}")
    };
    let mut uncertain_fields = Vec::new();
    if ports.is_empty() && urls.is_empty() {
        uncertain_fields.push("ports".to_string());
        uncertain_fields.push("urls".to_string());
    }
    uncertain_fields.push("healthCheck".to_string());

    Ok(Some((
        RunConfiguration::Task {
            id: id.clone(),
            name,
            command,
            working_directory,
            environment: BTreeMap::new(),
            hot_reload,
            ports,
            urls,
            health_check: None,
            restart_policy: RunRestartPolicy::default(),
        },
        RunDetection {
            configuration_id: id,
            confidence: RunDetectionConfidence::High,
            evidence: vec![format!(
                "{} defines `{script_name}` as `{script_command}`.",
                package_path
                    .strip_prefix(workspace_root)
                    .unwrap_or(package_path)
                    .display()
            )],
            uncertain_fields,
        },
        orchestrates_workspace,
    )))
}

fn detect_non_node_configurations(
    workspace_root: &Path,
    configurations: &mut Vec<RunConfiguration>,
    detections: &mut Vec<RunDetection>,
    ids: &mut HashSet<String>,
) -> Result<(), String> {
    if let Some(compose_name) = [
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
    ]
    .into_iter()
    .find(|name| workspace_root.join(name).is_file())
    {
        let id = unique_identifier("docker-compose", ids);
        configurations.push(RunConfiguration::Task {
            id: id.clone(),
            name: "Docker Compose".to_string(),
            command: "docker compose up".to_string(),
            working_directory: ".".to_string(),
            environment: BTreeMap::new(),
            hot_reload: false,
            ports: Vec::new(),
            urls: Vec::new(),
            health_check: None,
            restart_policy: RunRestartPolicy::default(),
        });
        detections.push(RunDetection {
            configuration_id: id,
            confidence: RunDetectionConfidence::High,
            evidence: vec![format!("{compose_name} exists at the workspace root.")],
            uncertain_fields: vec![
                "ports".to_string(),
                "urls".to_string(),
                "healthCheck".to_string(),
            ],
        });
    }

    if workspace_root.join("Cargo.toml").is_file()
        && workspace_root.join("src").join("main.rs").is_file()
    {
        let id = unique_identifier("cargo-run", ids);
        configurations.push(RunConfiguration::Task {
            id: id.clone(),
            name: "Cargo Run".to_string(),
            command: "cargo run".to_string(),
            working_directory: ".".to_string(),
            environment: BTreeMap::new(),
            hot_reload: false,
            ports: Vec::new(),
            urls: Vec::new(),
            health_check: None,
            restart_policy: RunRestartPolicy::default(),
        });
        detections.push(RunDetection {
            configuration_id: id,
            confidence: RunDetectionConfidence::High,
            evidence: vec!["Cargo.toml and src/main.rs define a Rust binary.".to_string()],
            uncertain_fields: vec![
                "ports".to_string(),
                "urls".to_string(),
                "healthCheck".to_string(),
            ],
        });
    }
    Ok(())
}

fn detect_package_manager(workspace_root: &Path, package_directory: &Path) -> &'static str {
    for directory in [package_directory, workspace_root] {
        if directory.join("pnpm-lock.yaml").is_file() {
            return "pnpm";
        }
        if directory.join("yarn.lock").is_file() {
            return "yarn";
        }
        if directory.join("bun.lock").is_file() || directory.join("bun.lockb").is_file() {
            return "bun";
        }
    }
    "npm"
}

fn detects_hot_reload(script_name: &str, command: &str) -> bool {
    if matches!(script_name, "dev" | "watch") {
        return true;
    }
    let normalized = command.to_ascii_lowercase();
    [
        "--watch",
        "vite",
        "next dev",
        "nodemon",
        "webpack serve",
        "tsx watch",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn detects_workspace_orchestration(command: &str) -> bool {
    let normalized = command.to_ascii_lowercase();
    [
        "concurrently",
        "lerna run",
        "npm run all",
        "npm-run-all",
        "nx run-many",
        "pnpm -r",
        "pnpm --recursive",
        "run-p",
        "turbo run",
        "yarn workspaces foreach",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn detect_explicit_ports(command: &str) -> Vec<u16> {
    let tokens = command.split_whitespace().collect::<Vec<_>>();
    let mut ports = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        let value = token
            .strip_prefix("--port=")
            .or_else(|| token.strip_prefix("PORT="))
            .or_else(|| {
                if matches!(*token, "--port" | "-p") {
                    tokens.get(index + 1).copied()
                } else {
                    None
                }
            });
        if let Some(port) = value
            .and_then(clean_numeric_token)
            .and_then(|value| value.parse::<u16>().ok())
        {
            if port > 0 && !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    ports
}

fn clean_numeric_token(value: &str) -> Option<&str> {
    let trimmed = value
        .trim_matches(|character: char| matches!(character, '\'' | '"' | ',' | ';' | '(' | ')'));
    (!trimmed.is_empty() && trimmed.chars().all(|character| character.is_ascii_digit()))
        .then_some(trimmed)
}

fn detect_explicit_urls(command: &str) -> Vec<String> {
    let mut urls = Vec::new();
    for token in command.split_whitespace() {
        let candidate = token.trim_matches(|character: char| {
            matches!(character, '\'' | '"' | ',' | ';' | '(' | ')')
        });
        if (candidate.starts_with("http://") || candidate.starts_with("https://"))
            && reqwest::Url::parse(candidate).is_ok()
            && !urls.iter().any(|url| url == candidate)
        {
            urls.push(candidate.to_string());
        }
    }
    urls
}

fn sanitize_identifier(value: &str) -> String {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches(['-', '.'])
        .to_string();
    if normalized.is_empty() || normalized == "-dev" {
        "application".to_string()
    } else {
        normalized.chars().take(96).collect()
    }
}

fn unique_identifier(value: &str, ids: &mut HashSet<String>) -> String {
    let base = sanitize_identifier(value);
    if ids.insert(base.clone()) {
        return base;
    }
    for suffix in 2..=64 {
        let candidate = format!("{}-{suffix}", base.chars().take(90).collect::<String>());
        if ids.insert(candidate.clone()) {
            return candidate;
        }
    }
    format!("run-{}", ids.len() + 1)
}

fn with_identifier(configuration: RunConfiguration, id: String) -> RunConfiguration {
    match configuration {
        RunConfiguration::Task {
            name,
            command,
            working_directory,
            environment,
            hot_reload,
            ports,
            urls,
            health_check,
            restart_policy,
            ..
        } => RunConfiguration::Task {
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
        },
        RunConfiguration::Composite {
            name,
            children,
            start_order,
            ..
        } => RunConfiguration::Composite {
            id,
            name,
            children,
            start_order,
        },
    }
}

#[cfg(test)]
mod tests {
    use std::{env, fs};

    use super::*;

    fn temporary_workspace(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "machdoch-run-detection-{}-{name}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("temporary workspace should be created");
        path
    }

    #[test]
    fn detects_frontend_backend_and_drafts_fullstack_primary() {
        let workspace = temporary_workspace("fullstack");
        fs::write(workspace.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
            .expect("lockfile should be written");
        for (directory, name, command) in [
            ("frontend", "web", "vite --port 4173"),
            ("backend", "api", "nest start --watch --port 3000"),
        ] {
            let package_directory = workspace.join(directory);
            fs::create_dir_all(&package_directory).expect("package directory should exist");
            fs::write(
                package_directory.join("package.json"),
                serde_json::json!({"name": name, "scripts": {"dev": command}}).to_string(),
            )
            .expect("package should be written");
        }

        let result = detect_configurations(&workspace).expect("detection should succeed");

        assert_eq!(result.document.configurations.len(), 3);
        assert_eq!(
            result.document.primary_configuration_id.as_deref(),
            Some("fullstack-start")
        );
        assert!(result.document.configurations.iter().any(|configuration| {
            matches!(configuration, RunConfiguration::Task { hot_reload: true, ports, .. } if ports.contains(&4173))
        }));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn leaves_unknown_ports_and_health_checks_for_review() {
        let workspace = temporary_workspace("uncertain");
        fs::write(
            workspace.join("package.json"),
            serde_json::json!({"name": "app", "scripts": {"dev": "custom-server"}}).to_string(),
        )
        .expect("package should be written");

        let result = detect_configurations(&workspace).expect("detection should succeed");
        let detection = result.detections.first().expect("detection should exist");

        assert!(detection.uncertain_fields.contains(&"ports".to_string()));
        assert!(detection
            .uncertain_fields
            .contains(&"healthCheck".to_string()));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn detects_node_and_rust_applications_together() {
        let workspace = temporary_workspace("mixed-stack");
        let web = workspace.join("web");
        fs::create_dir_all(&web).expect("web directory should exist");
        fs::write(
            web.join("package.json"),
            serde_json::json!({"name": "web", "scripts": {"dev": "vite"}}).to_string(),
        )
        .expect("package should be written");
        fs::create_dir_all(workspace.join("src")).expect("Rust source should exist");
        fs::write(workspace.join("Cargo.toml"), "[package]\nname='api'\n")
            .expect("manifest should be written");
        fs::write(workspace.join("src").join("main.rs"), "fn main() {}\n")
            .expect("Rust main should be written");

        let result = detect_configurations(&workspace).expect("detection should succeed");

        assert!(result.document.configurations.iter().any(|configuration| {
            matches!(configuration, RunConfiguration::Task { command, .. } if command == "npm run dev")
        }));
        assert!(result.document.configurations.iter().any(|configuration| {
            matches!(configuration, RunConfiguration::Task { command, .. } if command == "cargo run")
        }));
        assert!(result
            .document
            .configurations
            .iter()
            .any(|configuration| { matches!(configuration, RunConfiguration::Composite { .. }) }));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn prefers_a_root_package_orchestrator_without_drafting_duplicate_starts() {
        let workspace = temporary_workspace("root-orchestrator");
        fs::write(
            workspace.join("package.json"),
            serde_json::json!({"name": "root", "scripts": {"dev": "run-p dev:*"}}).to_string(),
        )
        .expect("root package should be written");
        let web = workspace.join("web");
        fs::create_dir_all(&web).expect("web directory should exist");
        fs::write(
            web.join("package.json"),
            serde_json::json!({"name": "web", "scripts": {"dev": "vite"}}).to_string(),
        )
        .expect("web package should be written");

        let result = detect_configurations(&workspace).expect("detection should succeed");

        assert_eq!(
            result.document.primary_configuration_id.as_deref(),
            Some("dev")
        );
        assert!(!result
            .document
            .configurations
            .iter()
            .any(|configuration| { matches!(configuration, RunConfiguration::Composite { .. }) }));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn combines_a_root_application_with_independent_nested_applications() {
        let workspace = temporary_workspace("root-application");
        fs::write(
            workspace.join("package.json"),
            serde_json::json!({"name": "root", "scripts": {"dev": "vite"}}).to_string(),
        )
        .expect("root package should be written");
        let api = workspace.join("api");
        fs::create_dir_all(&api).expect("api directory should exist");
        fs::write(
            api.join("package.json"),
            serde_json::json!({"name": "api", "scripts": {"dev": "node --watch server.js"}})
                .to_string(),
        )
        .expect("api package should be written");

        let result = detect_configurations(&workspace).expect("detection should succeed");

        assert_eq!(
            result.document.primary_configuration_id.as_deref(),
            Some("fullstack-start")
        );
        assert!(result
            .document
            .configurations
            .iter()
            .any(|configuration| { matches!(configuration, RunConfiguration::Composite { .. }) }));
        let _ = fs::remove_dir_all(workspace);
    }

    #[test]
    fn explicit_port_detection_rejects_partial_numeric_tokens() {
        assert_eq!(
            detect_explicit_ports("server --port abc3000"),
            Vec::<u16>::new()
        );
        assert_eq!(detect_explicit_ports("server --port '3000'"), vec![3000]);
    }
}
