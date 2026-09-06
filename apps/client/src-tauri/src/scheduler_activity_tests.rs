use std::{
    env, fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use super::{
    get_scheduler_activity, read_scheduler_activity, read_workspace_activity,
    MAX_SCHEDULER_STATE_BYTES, SCHEDULER_ACTIVITY_READER,
};

struct TestWorkspace(PathBuf);

impl TestWorkspace {
    fn new() -> Self {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "machdoch-scheduler-activity-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn root(&self) -> String {
        self.0.to_string_lossy().to_string()
    }

    fn write_state(&self, runs: Value) -> Vec<u8> {
        let content = serde_json::to_vec(&json!({
            "schema": "machdoch.smartScheduler",
            "schemaVersion": 2,
            "createdAt": 1,
            "updatedAt": 2,
            "jobs": [],
            "events": [],
            "mutationReceipts": [],
            "runs": runs,
        }))
        .unwrap();
        fs::create_dir_all(self.0.join(".machdoch")).unwrap();
        fs::write(self.0.join(".machdoch/scheduler.json"), &content).unwrap();
        content
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let path = self.0.canonicalize().unwrap();
        assert!(path.starts_with(env::temp_dir().canonicalize().unwrap()));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("machdoch-scheduler-activity-"));
        fs::remove_dir_all(path).unwrap();
    }
}

#[test]
fn activity_reads_all_workspaces_once_without_changing_scheduler_files() {
    let first = TestWorkspace::new();
    let second = TestWorkspace::new();
    let original = first.write_state(json!([{
        "id": "run-1", "status": "running", "summary": "private result"
    }]));
    second.write_state(json!([{"id": "run-1", "status": "timed_out"}]));
    fs::create_dir(first.0.join(".machdoch/scheduler.json.lock")).unwrap();

    let result = read_scheduler_activity(vec![first.root(), second.root(), first.root()]);

    assert_eq!(
        serde_json::to_value(result).unwrap(),
        json!([
            {"workspaceRoot": first.root(), "runs": [{"id": "run-1", "status": "running"}]},
            {"workspaceRoot": second.root(), "runs": [{"id": "run-1", "status": "timed_out"}]}
        ])
    );
    assert_eq!(
        fs::read(first.0.join(".machdoch/scheduler.json")).unwrap(),
        original
    );
    assert!(first.0.join(".machdoch/scheduler.json.lock").is_dir());
}

#[test]
fn activity_does_not_create_scheduler_state_for_unused_workspaces() {
    let workspace = TestWorkspace::new();
    assert!(read_workspace_activity(&workspace.root())
        .unwrap()
        .is_empty());
    assert!(!workspace.0.join(".machdoch").exists());
}

#[test]
fn activity_keeps_successful_workspaces_when_another_state_is_invalid() {
    let invalid = TestWorkspace::new();
    let valid = TestWorkspace::new();
    invalid.write_state(json!([]));
    fs::write(invalid.0.join(".machdoch/scheduler.json"), "{").unwrap();
    valid.write_state(json!([{"id": "run-2", "status": "queued"}]));

    let result =
        serde_json::to_value(read_scheduler_activity(vec![invalid.root(), valid.root()])).unwrap();

    assert!(result[0]["error"]
        .as_str()
        .unwrap()
        .contains("Invalid scheduler activity"));
    assert!(result[0].get("runs").is_none());
    assert_eq!(result[1]["runs"][0]["status"], "queued");
}

#[test]
fn activity_rejects_unsupported_schemas_and_invalid_run_records() {
    let workspace = TestWorkspace::new();
    for runs in [
        json!([{"id": "run-1", "status": "unknown"}]),
        json!([{"id": "", "status": "running"}]),
        json!([{"status": "running"}]),
    ] {
        workspace.write_state(runs);
        assert!(read_workspace_activity(&workspace.root()).is_err());
    }
    for (schema, version) in [("machdoch.smartScheduler", 1), ("other", 2)] {
        workspace.write_state(json!([]));
        fs::write(
            workspace.0.join(".machdoch/scheduler.json"),
            serde_json::to_vec(&json!({"schema": schema, "schemaVersion": version, "runs": []}))
                .unwrap(),
        )
        .unwrap();
        assert!(read_workspace_activity(&workspace.root()).is_err());
    }
}

#[test]
fn activity_distinguishes_an_unavailable_workspace_from_an_empty_scheduler() {
    let workspace = TestWorkspace::new();
    let missing = workspace.0.join("missing");
    assert!(read_workspace_activity(&missing.to_string_lossy()).is_err());
}

#[test]
fn activity_bounds_the_amount_of_state_read() {
    let workspace = TestWorkspace::new();
    workspace.write_state(json!([]));
    let file = fs::OpenOptions::new()
        .write(true)
        .open(workspace.0.join(".machdoch/scheduler.json"))
        .unwrap();
    file.set_len(MAX_SCHEDULER_STATE_BYTES + 1).unwrap();
    assert!(read_workspace_activity(&workspace.root())
        .unwrap_err()
        .contains("read limit"));
}

#[tokio::test]
async fn activity_rejects_overlapping_reads_instead_of_queueing_workers() {
    let permit = SCHEDULER_ACTIVITY_READER.try_acquire().unwrap();
    assert!(get_scheduler_activity(Vec::new())
        .await
        .unwrap_err()
        .contains("still in progress"));
    drop(permit);
    assert!(get_scheduler_activity(Vec::new()).await.unwrap().is_empty());
}
