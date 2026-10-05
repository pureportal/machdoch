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

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Invoke {
        id: String,
        command: String,
        args: Value,
    },
    Read {
        id: String,
        offset: f64,
    },
    Release {
        id: String,
    },
    Events {
        after: f64,
    },
}

fn valid_id(id: &str) -> bool {
    if id == "00000000-0000-0000-0000-000000000000"
        || id.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
    {
        return true;
    }
    let bytes = id.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => (b'1'..=b'8').contains(byte),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        })
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
    let request: Request = serde_json::from_value(value.clone()).map_err(D::Error::custom)?;
    let valid = match request {
        Request::Invoke { id, command, args } => {
            valid_id(&id) && valid_ralph_invocation(&command, &args)
        }
        Request::Read { id, offset } => {
            valid_id(&id)
                && offset >= 0.0
                && offset.fract() == 0.0
                && offset <= (64 * 1024 * 1024) as f64
        }
        Request::Release { id } => valid_id(&id),
        Request::Events { after } => {
            after >= 0.0 && after.fract() == 0.0 && after <= 9_007_199_254_740_991.0
        }
    };
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
