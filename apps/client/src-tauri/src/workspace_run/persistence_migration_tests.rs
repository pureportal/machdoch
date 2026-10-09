use std::sync::{Arc, Barrier};

use serde_json::{json, Value};

use super::{tests::temporary_workspace, *};

fn version_one_document(snake_case: bool) -> Value {
    let mut document = json!({
        "schemaVersion": 1,
        "primaryConfigurationId": "workspace",
        "configurations": [
            {
                "id": "server",
                "name": "Server",
                "kind": "task",
                "command": "echo ready",
                "workingDirectory": "apps/server",
                "environment": { "TOKEN": "stored-value", "LABEL": "café" },
                "hotReload": true,
                "ports": [3000],
                "urls": ["http://localhost:3000"],
                "healthCheck": {
                    "kind": "tcp", "host": "127.0.0.1", "port": 3000,
                    "restartOnFailure": true, "startupDelayMs": 3000,
                    "intervalMs": 5000, "timeoutMs": 2000, "failureThreshold": 3
                },
                "restartPolicy": {
                    "onCrash": true, "maxRestarts": 4, "windowMs": 60000,
                    "backoffMs": 1000, "maxBackoffMs": 30000
                }
            },
            {
                "id": "workspace", "name": "Workspace", "kind": "composite",
                "children": ["server"], "startOrder": "sequence"
            }
        ]
    });
    if snake_case {
        for configuration in document["configurations"].as_array_mut().unwrap() {
            let object = configuration.as_object_mut().unwrap();
            for (current, old) in [
                ("workingDirectory", "working_directory"),
                ("hotReload", "hot_reload"),
                ("healthCheck", "health_check"),
                ("restartPolicy", "restart_policy"),
                ("startOrder", "start_order"),
            ] {
                if let Some(value) = object.remove(current) {
                    object.insert(old.to_string(), value);
                }
            }
        }
    }
    document
}

#[test]
fn migrates_known_version_one_formats_and_persists_current_fields() {
    for snake_case in [false, true] {
        let workspace = temporary_workspace("migration-fields");
        fs::create_dir_all(workspace.join(".machdoch")).unwrap();
        fs::create_dir_all(workspace.join("apps/server")).unwrap();
        let source = version_one_document(snake_case).to_string();
        let path = configuration_path(&workspace);
        fs::write(&path, &source).unwrap();

        let prechecked = precheck_document(&workspace, &source).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), source);
        let loaded = load_document(&workspace).unwrap();
        assert_eq!(loaded, prechecked);
        assert_eq!(loaded.primary_configuration().unwrap().id(), "workspace");
        let saved = fs::read_to_string(&path).unwrap();
        let saved_value: Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(saved_value["schemaVersion"], 2);
        assert!(saved_value.get("primaryConfigurationId").is_none());
        let task = &saved_value["configurations"][0];
        assert_eq!(task["primary"], false);
        assert_eq!(task["workingDirectory"], "apps/server");
        assert_eq!(task["environment"]["TOKEN"], "stored-value");
        assert_eq!(task["environment"]["LABEL"], "café");
        assert_eq!(task["hotReload"], true);
        assert_eq!(task["command"], "echo ready");
        assert_eq!(task["ports"], json!([3000]));
        assert_eq!(task["urls"], json!(["http://localhost:3000"]));
        assert_eq!(task["healthCheck"]["restartOnFailure"], true);
        assert!(task["healthCheck"].get("intervalMs").is_none());
        assert_eq!(task["restartPolicy"]["maxRestarts"], 4);
        assert_eq!(saved_value["configurations"][1]["primary"], true);
        assert_eq!(
            saved_value["configurations"][1]["children"],
            json!(["server"])
        );
        assert_eq!(saved_value["configurations"][1]["startOrder"], "sequence");
        assert!(!saved.contains("working_directory"));

        let formatted = format!(" \n{saved}");
        fs::write(&path, &formatted).unwrap();
        assert_eq!(load_document(&workspace).unwrap(), loaded);
        assert_eq!(fs::read_to_string(&path).unwrap(), formatted);
        fs::remove_dir_all(&workspace).unwrap();
    }
}

#[test]
fn migrates_empty_documents_and_version_one_defaults() {
    let workspace = temporary_workspace("migration-defaults");
    fs::create_dir_all(workspace.join(".machdoch")).unwrap();
    let path = configuration_path(&workspace);
    for source in [
        json!({ "schemaVersion": 1, "primaryConfigurationId": null, "configurations": [] }),
        json!({ "schemaVersion": 1, "configurations": [] }),
    ] {
        fs::write(&path, source.to_string()).unwrap();
        assert_eq!(
            load_document(&workspace).unwrap(),
            RunConfigurationDocument::default()
        );
        assert_eq!(
            serde_json::from_str::<Value>(&fs::read_to_string(&path).unwrap()).unwrap()
                ["schemaVersion"],
            2
        );
    }
    let source = json!({
        "schemaVersion": 1, "primaryConfigurationId": "server",
        "configurations": [{"id": "server", "name": "Server", "kind": "task", "command": "echo ready"}]
    });
    fs::write(&path, source.to_string()).unwrap();
    let loaded = load_document(&workspace).unwrap();
    let RunConfiguration::Task {
        primary,
        working_directory,
        hot_reload,
        restart_policy,
        ..
    } = &loaded.configurations[0]
    else {
        panic!("task should remain a task");
    };
    assert!(*primary);
    assert_eq!(working_directory, ".");
    assert!(!hot_reload);
    assert_eq!(restart_policy.max_restarts, 5);
    fs::remove_dir_all(&workspace).unwrap();
}

#[test]
fn rejected_migrations_preserve_the_source_document() {
    let workspace = temporary_workspace("migration-invalid");
    fs::create_dir_all(workspace.join(".machdoch")).unwrap();
    fs::create_dir_all(workspace.join("apps/server")).unwrap();
    let path = configuration_path(&workspace);
    let mut cases = Vec::new();
    for primary in [Value::Null, json!(123), json!("missing")] {
        let mut value = version_one_document(false);
        value["primaryConfigurationId"] = primary;
        cases.push(value);
    }
    let mut missing_primary = version_one_document(false);
    missing_primary
        .as_object_mut()
        .unwrap()
        .remove("primaryConfigurationId");
    cases.push(missing_primary);
    for (field, value) in [
        ("primary", json!(true)),
        ("working_directory", json!(".")),
        ("command", json!("")),
        ("kind", json!("unknown")),
        ("ports", json!([0])),
    ] {
        let mut source = version_one_document(false);
        source["configurations"][0][field] = value;
        cases.push(source);
    }
    for source in cases {
        let raw = source.to_string();
        fs::write(&path, &raw).unwrap();
        assert!(load_document(&workspace).is_err());
        assert!(precheck_document(&workspace, &raw).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }
    fs::remove_dir_all(&workspace).unwrap();
}

#[test]
fn concurrent_loaders_share_the_persisted_migration() {
    let workspace = temporary_workspace("migration-concurrent");
    fs::create_dir_all(workspace.join(".machdoch")).unwrap();
    fs::write(
        configuration_path(&workspace),
        version_one_document(true).to_string(),
    )
    .unwrap();
    let barrier = Arc::new(Barrier::new(8));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let workspace = workspace.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                load_document(&workspace).unwrap()
            })
        })
        .collect();
    let loaded = load_document(&workspace).unwrap();
    for worker in workers {
        assert_eq!(worker.join().unwrap(), loaded);
    }
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(configuration_path(&workspace)).unwrap()).unwrap();
    assert_eq!(saved["schemaVersion"], 2);
    fs::remove_dir_all(&workspace).unwrap();
}
