use serde::{de::Error, Deserialize, Deserializer};
use serde_json::Value;

const ACTIONS: &[&str] = &[
    "list",
    "create",
    "pause",
    "resume",
    "delete",
    "runs",
    "run-due",
    "inspect-ralph",
    "trigger",
    "retry",
    "cancel",
];
const VALUE_FLAGS: &[&str] = &[
    "--request-id",
    "--name",
    "--cron",
    "--timezone",
    "--interval-ms",
    "--delay-ms",
    "--run-at",
    "--trigger",
    "--trigger-filter",
    "--trigger-recovery-filter",
    "--trigger-firing-mode",
    "--trigger-cooldown-ms",
    "--trigger-repeat-ms",
    "--trigger-debounce-ms",
    "--trigger-dedupe-key-template",
    "--trigger-max-events",
    "--trigger-window-ms",
    "--scheduler-target",
    "--scheduled-ralph-flow",
    "--scheduled-ralph-flow-scope",
    "--scheduled-ralph-run-log-scope",
    "--scheduled-ralph-max-transitions",
    "--scheduled-ralph-profile",
    "--scheduled-ralph-resume-policy",
    "--scheduled-ralph-param",
    "--scheduled-ralph-allowed-root",
    "--scheduled-ralph-allow-commands",
    "--scheduled-ralph-allow-writes",
    "--scheduled-ralph-allow-network",
    "--scheduled-ralph-allow-mcp-tools",
    "--prompt",
    "--prompt-file",
    "--context",
    "--image",
    "--context-pack",
    "--macro",
    "--missed-run-policy",
    "--missed-run-grace-ms",
    "--retry-attempts",
    "--retry-min-ms",
    "--retry-max-ms",
    "--retry-factor",
    "--retry-randomize",
    "--dedupe-key",
    "--ttl-ms",
    "--max-duration-ms",
    "--concurrency-key",
    "--concurrency-limit",
    "--history-limit",
    "--max-catch-up-runs",
    "--mode",
    "--runtime-provider",
    "--model",
    "--reasoning",
];

pub fn valid_scheduler_arguments(args: &[String]) -> bool {
    if args.is_empty() || args.len() > 512 || !ACTIONS.contains(&args[0].as_str()) {
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
        } else {
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
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Args {
    request: CommandRequest,
}

pub fn valid_scheduler_invocation(command: &str, args: &Value) -> bool {
    let Ok(args) = serde_json::from_value::<Args>(args.clone()) else {
        return false;
    };
    let workspace = args.request.workspace_root.trim();
    if workspace.is_empty() || workspace.encode_utf16().count() > 2048 || workspace.contains('\0') {
        return false;
    }
    match command {
        "run_scheduler_command" => valid_scheduler_arguments(&args.request.arguments),
        "run_ralph_command" => {
            matches!(args.request.arguments.as_slice(), [action, flag, scope] if action == "list" && flag == "--scope" && ["workspace", "user"].contains(&scope.as_str()))
        }
        _ => false,
    }
}

pub(super) fn deserialize_scheduler_request<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if !super::operation::valid_request(&value, valid_scheduler_invocation) {
        return Err(D::Error::custom("invalid Scheduler request"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::{valid_scheduler_arguments, VALUE_FLAGS};
    use crate::HostRequest;
    use serde_json::{json, Value};

    #[test]
    fn requests_match_typescript_conformance() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../fixtures/scheduler-editor-conformance.json"
        ))
        .expect("valid fixtures");
        for case in cases {
            let result = serde_json::from_value::<HostRequest>(
                json!({ "type": "scheduler", "request": case["request"] }),
            );
            assert_eq!(
                result.is_ok(),
                case["accepted"].as_bool().expect("boolean expectation"),
                "{}: {result:?}",
                case["name"]
            );
        }
    }

    #[test]
    fn accepts_the_complete_form_options_and_bounds_payloads() {
        let mut args = vec!["create".to_owned()];
        for flag in VALUE_FLAGS {
            args.extend([flag.to_string(), "value".to_owned()]);
        }
        assert!(valid_scheduler_arguments(&args));
        assert!(!valid_scheduler_arguments(&[
            "create".to_owned(),
            "--prompt".to_owned(),
            "x".repeat(1_800_001)
        ]));
    }
}
