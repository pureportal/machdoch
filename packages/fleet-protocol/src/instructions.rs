use std::collections::BTreeSet;

use serde::{de::Error, Deserialize, Deserializer};
use serde_json::Value;

fn action_options(
    group: &str,
    action: &str,
) -> Option<(usize, &'static [&'static str], &'static [&'static str])> {
    let revision = &["--expected-revision"];
    match (group, action) {
        ("profiles", "list") => Some((0, &[], &["--include-content"])),
        ("profiles", "create") => Some((
            0,
            &[
                "--name",
                "--description",
                "--prompt",
                "--metadata-json",
                "--expected-revision",
            ],
            &[],
        )),
        ("profiles", "edit") => Some((
            1,
            &[
                "--name",
                "--description",
                "--prompt",
                "--metadata-json",
                "--expected-revision",
            ],
            &[],
        )),
        ("profiles", "duplicate") => Some((1, &["--name", "--expected-revision"], &[])),
        ("profiles", "delete") => Some((1, revision, &[])),
        ("workspaces", "list") => Some((0, &[], &[])),
        ("workspaces", "configure") => Some((
            1,
            &["--name", "--metadata-json", "--expected-revision"],
            &[],
        )),
        ("workspaces", "relink") => Some((1, &["--path", "--expected-revision"], &[])),
        ("workspaces", "remove") => Some((1, revision, &["--confirm-assignment-removal"])),
        ("assignments", "set") => Some((1, &["--path", "--profile", "--expected-revision"], &[])),
        ("assignments", "remove") => Some((1, &["--path", "--expected-revision"], &[])),
        ("recovery", "status") => Some((0, &[], &[])),
        ("recovery", "restore" | "reset") => Some((0, &["--expected-digest"], &[])),
        _ => None,
    }
}

pub fn valid_instruction_arguments(args: &[String]) -> bool {
    if args.len() < 2
        || args.len() > 256
        || args
            .iter()
            .any(|value| value.contains('\0') || value.encode_utf16().count() > 1_800_000)
        || serde_json::to_string(args)
            .map_or(true, |value| value.encode_utf16().count() > 1_900_000)
    {
        return false;
    }
    let Some((required_positional, values, toggles)) = action_options(&args[0], &args[1]) else {
        return false;
    };
    let mut seen = BTreeSet::new();
    let mut positional = 0;
    let mut index = 2;
    while index < args.len() {
        let argument = args[index].as_str();
        if values.contains(&argument) || toggles.contains(&argument) {
            if !seen.insert(argument) && argument != "--profile" {
                return false;
            }
            if values.contains(&argument) {
                index += 1;
                if index >= args.len() {
                    return false;
                }
            }
        } else if argument.starts_with('-') {
            return false;
        } else {
            positional += 1;
        }
        index += 1;
    }
    positional == required_positional
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

pub fn valid_instruction_invocation(command: &str, args: &Value) -> bool {
    let Ok(args) = serde_json::from_value::<Args>(args.clone()) else {
        return false;
    };
    let workspace = args.request.workspace_root.trim();
    command == "run_instruction_command"
        && !workspace.contains('\0')
        && workspace.encode_utf16().count() <= 2048
        && valid_instruction_arguments(&args.request.arguments)
}

pub fn referenced_workspaces(args: &[String]) -> Vec<&str> {
    if args.first().map(String::as_str) != Some("workspaces") {
        return vec![];
    }
    if args.get(1).map(String::as_str) == Some("relink") {
        return args
            .windows(2)
            .find(|pair| pair[0] == "--path")
            .map(|pair| vec![pair[1].as_str()])
            .unwrap_or_default();
    }
    if args.get(1).map(String::as_str) != Some("configure") {
        return vec![];
    }
    let mut index = 2;
    while index < args.len() {
        if args[index].starts_with("--") {
            index += 2;
        } else {
            return vec![args[index].as_str()];
        }
    }
    vec![]
}

pub(super) fn deserialize_instruction_request<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if !super::operation::valid_request(&value, valid_instruction_invocation) {
        return Err(D::Error::custom("invalid instruction request"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use crate::HostRequest;
    use serde_json::{json, Value};

    #[test]
    fn instruction_requests_match_typescript_conformance() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../fixtures/instruction-editor-conformance.json"
        ))
        .unwrap();
        for entry in cases {
            assert_eq!(
                serde_json::from_value::<HostRequest>(
                    json!({ "type": "instructions", "request": entry["request"] })
                )
                .is_ok(),
                entry["accepted"].as_bool().unwrap(),
                "{}",
                entry["name"]
            );
        }
    }

    #[test]
    fn workspace_options_do_not_hide_a_root() {
        let args = [
            "workspaces",
            "configure",
            "--name",
            "Demo",
            "/projects/demo",
        ]
        .map(str::to_owned);
        assert_eq!(super::referenced_workspaces(&args), ["/projects/demo"]);
    }
}
