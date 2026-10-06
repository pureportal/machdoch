use serde_json::Value;

use super::{fields, text};

fn categories(value: &Value) -> bool {
    let Some(values) = value.as_array() else {
        return false;
    };
    !values.is_empty()
        && values.len() <= 10
        && values.iter().enumerate().all(|(index, value)| {
            matches!(
                value.as_str(),
                Some(
                    "credentials.api-keys"
                        | "preferences.agent-provider"
                        | "preferences.desktop-appearance"
                        | "preferences.chat-voice"
                        | "memory.global"
                        | "customizations.prompts-global"
                        | "context-packs.global"
                        | "mcp.global"
                        | "ralph.preferences-global"
                        | "ralph.flows-global"
                )
            ) && !values[..index].contains(value)
        })
}

fn token(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 32
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    })
}

pub(super) fn validate(command: &str, args: &Value) -> Option<bool> {
    Some(match command {
        "get_settings_transfer_status"
        | "get_settings_transfer_catalog"
        | "confirm_settings_transfer_pairing"
        | "approve_settings_transfer"
        | "stop_settings_transfer" => fields(args, &[], &[]).is_some(),
        "start_settings_transfer" | "start_settings_receive" => {
            let request = &args["request"];
            fields(args, &["request"], &[]).is_some()
                && fields(request, &["categories", "displayName", "interfaceIds"], &[]).is_some()
                && categories(&request["categories"])
                && text(&request["displayName"], 240, false)
                && request["interfaceIds"]
                    .as_array()
                    .is_some_and(|ids| ids.len() <= 64 && ids.iter().all(|id| text(id, 240, true)))
        }
        "connect_settings_transfer" => {
            let request = &args["request"];
            fields(args, &["request"], &[]).is_some()
                && fields(request, &["discoveredId", "manualCode"], &[]).is_some()
                && ((request["discoveredId"].is_null() && text(&request["manualCode"], 2200, true))
                    || (request["manualCode"].is_null()
                        && text(&request["discoveredId"], 240, true)))
        }
        "export_encrypted_settings_file" | "inspect_encrypted_settings_file" => {
            let request = &args["request"];
            let inspect = command == "inspect_encrypted_settings_file";
            let required = if inspect {
                vec!["operationId", "categories", "sourcePath", "passphrase"]
            } else {
                vec!["categories", "destinationPath", "passphrase"]
            };
            fields(args, &["request"], &[]).is_some()
                && fields(request, &required, &[]).is_some()
                && categories(&request["categories"])
                && text(
                    &request[if inspect {
                        "sourcePath"
                    } else {
                        "destinationPath"
                    }],
                    4096,
                    true,
                )
                && text(&request["passphrase"], 1024, false)
                && request["passphrase"]
                    .as_str()
                    .is_some_and(|value| value.len() <= 1024)
                && (!inspect || token(&request["operationId"]))
        }
        "commit_encrypted_settings_file_import" | "cancel_encrypted_settings_file_import" => {
            let key = if command == "commit_encrypted_settings_file_import" {
                "token"
            } else {
                "operationId"
            };
            fields(args, &["request"], &[]).is_some()
                && fields(&args["request"], &[key], &[]).is_some()
                && token(&args["request"][key])
        }
        _ => return None,
    })
}
