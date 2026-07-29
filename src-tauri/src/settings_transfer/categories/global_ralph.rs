use std::{
    collections::{BTreeSet, HashSet},
    fs,
};

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt as _;
use zeroize::Zeroizing;

use super::{
    create_file_snapshot, create_json_snapshot, is_windows_reparse_point, normalized_model,
    normalized_runtime_provider, nullable_enum, require_exact_keys, required_trimmed_string,
    sha256_hex, validate_runtime_selection, verify_regular_contained_file,
    verify_unlinked_directory_chain, CategorySnapshot, FileSnapshotEntry, SettingsCategoryId,
    MAX_RALPH_FLOW_BYTES, MAX_SAFE_INTEGER, MAX_TOTAL_PLAINTEXT_BYTES,
    RALPH_CORE_VALIDATION_TIMEOUT, RALPH_PREFERENCE_ITEM_COUNT, RALPH_SETTINGS_STORAGE_KEY,
    REASONING_MODES, STORE_FILE,
};
use crate::runtime_snapshot::get_user_config_directory;

fn normalize_runtime_selection(root: &Map<String, Value>, prefix: &str) -> Value {
    let provider_key = format!("{prefix}Provider");
    let model_key = format!("{prefix}Model");
    let reasoning_key = format!("{prefix}Reasoning");
    let provider = normalized_runtime_provider(root.get(&provider_key));
    json!({
        "provider": provider,
        "model": normalized_model(root.get(&model_key), provider),
        "reasoning": nullable_enum(root.get(&reasoning_key), &REASONING_MODES),
    })
}

pub(super) fn preferences_from_store<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    let store = app
        .store(STORE_FILE)
        .map_err(|_| "Global RALPH preferences are unavailable.".to_string())?;
    let root = store
        .get(RALPH_SETTINGS_STORAGE_KEY)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let flow_library_mode = root
        .get("flowLibraryMode")
        .and_then(Value::as_str)
        .filter(|value| ["workspace", "user", "all"].contains(value))
        .unwrap_or("workspace");
    let default_max_transitions = root
        .get("defaultMaxTransitions")
        .and_then(Value::as_u64)
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))
        .map(Value::from)
        .unwrap_or(Value::Null);
    let value = json!({
        "flowLibraryMode": flow_library_mode,
        "generation": normalize_runtime_selection(&root, "generation"),
        "run": normalize_runtime_selection(&root, "run"),
        "defaultMaxTransitions": default_max_transitions,
    });
    validate_preferences(&value)?;
    Ok(value)
}

pub(super) fn snapshot_preferences<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<CategorySnapshot, String> {
    create_json_snapshot(
        SettingsCategoryId::GlobalRalphPreferences,
        preferences_from_store(app)?,
        RALPH_PREFERENCE_ITEM_COUNT,
        false,
    )
}

pub(super) fn validate_preferences(value: &Value) -> Result<(), String> {
    let root = value
        .as_object()
        .ok_or_else(|| "Global RALPH preferences are invalid.".to_string())?;
    require_exact_keys(
        root,
        &[
            "flowLibraryMode",
            "generation",
            "run",
            "defaultMaxTransitions",
        ],
    )?;
    if !root
        .get("flowLibraryMode")
        .and_then(Value::as_str)
        .is_some_and(|value| ["workspace", "user", "all"].contains(&value))
        || !root.get("defaultMaxTransitions").is_some_and(|value| {
            value.is_null()
                || value
                    .as_u64()
                    .is_some_and(|value| (1..=MAX_SAFE_INTEGER).contains(&value))
        })
    {
        return Err("A global RALPH preference is outside its supported range.".to_string());
    }
    validate_runtime_selection(
        root.get("generation")
            .ok_or_else(|| "RALPH generation preferences are missing.".to_string())?,
    )?;
    validate_runtime_selection(
        root.get("run")
            .ok_or_else(|| "RALPH run preferences are missing.".to_string())?,
    )
}

fn is_safe_flow_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

pub(super) fn flow_id_from_path(path: &str) -> Option<&str> {
    let flow_id = path.strip_prefix("flows/")?.strip_suffix(".json")?;
    if flow_id.contains('/') || !is_safe_flow_id(flow_id) {
        return None;
    }
    Some(flow_id)
}

pub(super) fn validate_flow(value: &Value) -> Result<String, String> {
    let root = value
        .as_object()
        .ok_or_else(|| "A RALPH flow must be a JSON object.".to_string())?;
    if root.contains_key("workspaceRoot") || root.contains_key("path") || root.contains_key("scope")
    {
        return Err("A global RALPH flow contains a forbidden scope field.".to_string());
    }
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("A RALPH flow must explicitly use schema version 1.".to_string());
    }
    let id = required_trimmed_string(root.get("id"), "A RALPH flow is missing its id.")?;
    if !is_safe_flow_id(&id) {
        return Err("A RALPH flow has an invalid id.".to_string());
    }
    let _ = required_trimmed_string(root.get("name"), "A RALPH flow is missing its name.")?;
    let blocks = root
        .get("blocks")
        .and_then(Value::as_array)
        .ok_or_else(|| "A RALPH flow must contain a block list.".to_string())?;
    let edges = root
        .get("edges")
        .and_then(Value::as_array)
        .ok_or_else(|| "A RALPH flow must contain an edge list.".to_string())?;
    if blocks.is_empty() || blocks.len() > 250 || edges.len() > 500 {
        return Err("A RALPH flow has an invalid number of blocks or edges.".to_string());
    }
    let mut block_ids = HashSet::new();
    for block in blocks {
        let block = block
            .as_object()
            .ok_or_else(|| "A RALPH flow block is invalid.".to_string())?;
        let block_id =
            required_trimmed_string(block.get("id"), "A RALPH flow block is missing its id.")?;
        let _ =
            required_trimmed_string(block.get("type"), "A RALPH flow block is missing its type.")?;
        if !block_ids.insert(block_id) {
            return Err("A RALPH flow contains duplicate block ids.".to_string());
        }
        if let Some(workspace) = block
            .get("settings")
            .and_then(Value::as_object)
            .and_then(|settings| settings.get("workspace"))
            .and_then(Value::as_object)
        {
            if workspace.get("mode").and_then(Value::as_str) == Some("custom")
                || workspace.get("path").and_then(Value::as_str).is_some()
            {
                return Err("A global RALPH flow declares workspace-specific settings.".to_string());
            }
        }
    }
    for edge in edges {
        let edge = edge
            .as_object()
            .ok_or_else(|| "A RALPH flow edge is invalid.".to_string())?;
        let from =
            required_trimmed_string(edge.get("from"), "A RALPH edge is missing its source.")?;
        let to = required_trimmed_string(edge.get("to"), "A RALPH edge is missing its target.")?;
        if !block_ids.contains(&from) || !block_ids.contains(&to) {
            return Err("A RALPH edge references a missing block.".to_string());
        }
    }
    Ok(id)
}

pub(super) fn validate_flows_with_core(entries: &[FileSnapshotEntry]) -> Result<(), String> {
    let flows = entries
        .iter()
        .filter(|entry| flow_id_from_path(&entry.relative_path).is_some())
        .collect::<Vec<_>>();
    if flows.is_empty() {
        return Ok(());
    }

    let estimated_bytes = flows.iter().try_fold(
        64_usize
            .checked_add(flows.len())
            .ok_or_else(|| "The RALPH validation batch exceeds its transfer bound.".to_string())?,
        |total, entry| {
            total
                .checked_add(entry.utf8_content.len())
                .ok_or_else(|| "The RALPH validation batch exceeds its transfer bound.".to_string())
        },
    )?;
    if estimated_bytes as u64 > MAX_TOTAL_PLAINTEXT_BYTES.saturating_add(64 * 1024) {
        return Err("The RALPH validation batch exceeds its transfer bound.".to_string());
    }
    let mut batch = Zeroizing::new(Vec::with_capacity(estimated_bytes));
    batch.extend_from_slice(b"{\"schemaVersion\":1,\"flows\":[");
    for (index, entry) in flows.iter().enumerate() {
        if index > 0 {
            batch.push(b',');
        }
        batch.extend_from_slice(entry.utf8_content.as_bytes());
    }
    batch.extend_from_slice(b"]}");

    let arguments = vec![
        "--json".to_string(),
        "ralph".to_string(),
        "validate-json".to_string(),
        "--flow-json-file".to_string(),
        "-".to_string(),
    ];
    let response = crate::shared_cli::run_side_effect_free_json_command(
        &arguments,
        batch,
        RALPH_CORE_VALIDATION_TIMEOUT,
    )
    .map_err(|_| "The complete RALPH flow validator could not run safely.".to_string())?;
    let results = response
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            "The complete RALPH flow validator returned an invalid result.".to_string()
        })?;
    if response.get("valid").and_then(Value::as_bool) != Some(true) || results.len() != flows.len()
    {
        return Err("A RALPH flow failed complete parser or graph validation.".to_string());
    }
    for (entry, result) in flows.iter().zip(results) {
        let expected_id = flow_id_from_path(&entry.relative_path).unwrap_or_default();
        if result.get("valid").and_then(Value::as_bool) != Some(true)
            || result.get("id").and_then(Value::as_str) != Some(expected_id)
        {
            return Err("A RALPH flow failed complete parser or graph validation.".to_string());
        }
    }
    Ok(())
}

pub(super) fn snapshot_flows() -> Result<CategorySnapshot, String> {
    let global_root = get_user_config_directory()?;
    let flow_root = global_root.join("ralph").join("flows");
    let mut entries = Vec::new();
    let mut flow_ids = BTreeSet::new();
    if verify_unlinked_directory_chain(&global_root, &flow_root)? {
        for entry in fs::read_dir(&flow_root)
            .map_err(|_| "The global RALPH flow directory could not be read.".to_string())?
        {
            let entry =
                entry.map_err(|_| "A global RALPH flow entry could not be read.".to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|_| "A global RALPH flow entry could not be inspected.".to_string())?;
            if metadata.file_type().is_symlink() || is_windows_reparse_point(&metadata) {
                return Err("The global RALPH flow directory contains a linked entry.".to_string());
            }
            if metadata.is_dir() {
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            verify_regular_contained_file(&global_root, &path, MAX_RALPH_FLOW_BYTES)?;
            let content = fs::read_to_string(&path)
                .map_err(|_| "A global RALPH flow must contain valid UTF-8 JSON.".to_string())?;
            let value = serde_json::from_str::<Value>(&content)
                .map_err(|_| "A global RALPH flow contains invalid JSON.".to_string())?;
            let id = validate_flow(&value)?;
            if !flow_ids.insert(id.clone()) {
                return Err("Global RALPH flow ids must be unique.".to_string());
            }
            let expected_file = format!("{id}.json");
            if entry.file_name().to_string_lossy().to_lowercase() != expected_file.to_lowercase() {
                return Err("A global RALPH flow filename does not match its id.".to_string());
            }
            entries.push(FileSnapshotEntry {
                relative_path: format!("flows/{expected_file}"),
                sha256: sha256_hex(content.as_bytes()),
                utf8_content: content,
            });
        }
    }
    entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    create_file_snapshot(SettingsCategoryId::GlobalRalphFlows, entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preferences_reject_workspace_fields() {
        let preferences = json!({
            "flowLibraryMode": "all",
            "generation": {
                "provider": "openai",
                "model": "gpt-test",
                "reasoning": "medium"
            },
            "run": {
                "provider": "codex-cli",
                "model": "gpt-test",
                "reasoning": null
            },
            "defaultMaxTransitions": 100
        });
        assert!(validate_preferences(&preferences).is_ok());
        let mut with_workspace = preferences;
        with_workspace["workspaceRoot"] = json!("C:/poison");
        assert!(validate_preferences(&with_workspace).is_err());
    }

    #[test]
    fn flow_validation_rejects_workspace_specific_settings() {
        let flow = json!({
            "schemaVersion": 1,
            "id": "global-flow",
            "name": "Global flow",
            "blocks": [{
                "id": "start",
                "type": "start",
                "settings": { "workspace": { "mode": "custom", "path": "C:/poison" } }
            }],
            "edges": []
        });
        assert_eq!(
            validate_flow(&flow).expect_err("workspace flow should fail"),
            "A global RALPH flow declares workspace-specific settings."
        );
    }

    #[test]
    fn flow_paths_match_only_the_closed_global_layout() {
        assert_eq!(
            flow_id_from_path("flows/global-flow.json"),
            Some("global-flow")
        );
        for invalid in [
            "flows/nested/global-flow.json",
            "flows/global-flow.yaml",
            "runs/global-flow.json",
            "revisions/global-flow.json",
            "global flow.json",
        ] {
            assert!(
                flow_id_from_path(invalid).is_none(),
                "{invalid} should not match a managed RALPH path"
            );
        }
    }

    #[test]
    fn transfer_uses_the_complete_core_graph_validator() {
        let valid = json!({
            "schemaVersion": 1,
            "id": "transfer-flow",
            "name": "Transfer flow",
            "blocks": [
                { "id": "start", "type": "START", "title": "Start" },
                { "id": "work", "type": "PROMPT", "title": "Work", "prompt": "Do the work." },
                { "id": "done", "type": "END", "title": "Done", "status": "success" }
            ],
            "edges": [
                { "id": "start-work", "from": "start", "fromOutput": "SUCCESS", "to": "work" },
                { "id": "work-done", "from": "work", "fromOutput": "SUCCESS", "to": "done" }
            ]
        })
        .to_string();
        let entry = FileSnapshotEntry {
            relative_path: "flows/transfer-flow.json".to_string(),
            sha256: sha256_hex(valid.as_bytes()),
            utf8_content: valid,
        };
        validate_flows_with_core(std::slice::from_ref(&entry))
            .expect("a complete valid graph should pass the shared validator");

        let invalid = json!({
            "schemaVersion": 1,
            "id": "transfer-flow",
            "name": "Transfer flow",
            "blocks": [
                { "id": "start", "type": "START", "title": "Start" },
                { "id": "second-start", "type": "START", "title": "Second start" }
            ],
            "edges": []
        })
        .to_string();
        let invalid_entry = FileSnapshotEntry {
            relative_path: "flows/transfer-flow.json".to_string(),
            sha256: sha256_hex(invalid.as_bytes()),
            utf8_content: invalid,
        };
        assert!(
            validate_flows_with_core(std::slice::from_ref(&invalid_entry)).is_err(),
            "a graph with two START blocks must fail complete graph validation"
        );
    }
}
