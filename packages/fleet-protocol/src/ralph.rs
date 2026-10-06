use serde::{de::Error, Deserialize, Deserializer};
use serde_json::Value;

const ACTIONS: &[&str] = &[
    "snapshot",
    "list",
    "show",
    "validate",
    "revisions",
    "runs",
    "log",
    "run-detail",
    "save",
    "delete",
    "restore",
    "run",
    "resume",
    "create",
    "interview",
];
const VALUE_FLAGS: &[&str] = &[
    "--scope",
    "--mode",
    "--runtime-provider",
    "--model",
    "--reasoning",
    "--max-transitions",
    "--param",
    "--flow-json",
    "--expected-fingerprint",
    "--revision",
    "--name",
    "--prompt",
    "--existing-flow-json",
    "--flow-target",
    "--generation-mode",
    "--max-rounds",
    "--input-json",
];
const BOOLEAN_FLAGS: &[&str] = &["--trace", "--isolated", "--retry-current"];

pub fn valid_ralph_arguments(args: &[String]) -> bool {
    if args.is_empty() || args.len() > 160 || !ACTIONS.contains(&args[0].as_str()) {
        return false;
    }
    if args
        .iter()
        .any(|value| value.contains('\0') || value.encode_utf16().count() > 1_800_000)
        || serde_json::to_string(args)
            .map_or(true, |value| value.encode_utf16().count() > 1_900_000)
    {
        return false;
    }
    let mut index = 1;
    let mut positional = 0;
    while index < args.len() {
        let value = args[index].as_str();
        if VALUE_FLAGS.contains(&value) {
            index += 1;
            if index >= args.len() {
                return false;
            }
        } else if !BOOLEAN_FLAGS.contains(&value) {
            positional += 1;
            if value.starts_with('-') || positional > 1 {
                return false;
            }
        }
        index += 1;
    }
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CommandRequest {
    workspace_root: String,
    arguments: Vec<String>,
    task_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RunArgs {
    request: CommandRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecentArgs {
    task_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelArgs {
    task_id: String,
}

fn valid_text(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.encode_utf16().count() <= maximum && !value.contains('\0')
}

pub fn valid_ralph_invocation(command: &str, args: &Value) -> bool {
    match command {
        "run_ralph_command" => serde_json::from_value::<RunArgs>(args.clone()).is_ok_and(|args| {
            valid_text(args.request.workspace_root.trim(), 2048)
                && valid_ralph_arguments(&args.request.arguments)
                && args.request.task_id.as_ref().is_none_or(|id| {
                    valid_text(id, 240)
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
                })
        }),
        "get_active_desktop_tasks" | "get_user_internal_task_model_settings" => {
            args.as_object().is_some_and(|args| args.is_empty())
        }
        "get_recent_desktop_task_results" => serde_json::from_value::<RecentArgs>(args.clone())
            .is_ok_and(|args| {
                args.task_ids.len() <= 160 && args.task_ids.iter().all(|id| valid_text(id, 240))
            }),
        "cancel_desktop_task" => serde_json::from_value::<CancelArgs>(args.clone())
            .is_ok_and(|args| valid_text(&args.task_id, 240)),
        _ => false,
    }
}

pub(super) fn deserialize_ralph_request<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    let valid = super::operation::valid_request(&value, valid_ralph_invocation);
    if !valid {
        return Err(D::Error::custom("invalid RALPH request"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use crate::HostRequest;
    use serde_json::{json, Value};

    #[test]
    fn editor_requests_match_typescript_conformance() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../fixtures/ralph-editor-conformance.json"))
                .expect("valid fixtures");
        for case in cases {
            let result = serde_json::from_value::<HostRequest>(
                json!({ "type": "ralph", "request": case["request"] }),
            );
            assert_eq!(
                result.is_ok(),
                case["accepted"].as_bool().expect("boolean expectation"),
                "{}: {result:?}",
                case["name"]
            );
        }
    }
}
