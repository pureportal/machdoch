use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use zeroize::{Zeroize, Zeroizing};

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CloudWorkspaceRequest {
    List {
        refresh: bool,
    },
    Connect {
        origin: String,
        token: String,
        workspace_root: String,
        name: String,
    },
    Reconnect {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
    Disconnect {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        token: Option<String>,
    },
}

impl Drop for CloudWorkspaceRequest {
    fn drop(&mut self) {
        match self {
            Self::Connect { token, .. } => token.zeroize(),
            Self::Reconnect { token, .. } | Self::Disconnect { token, .. } => {
                if let Some(token) = token {
                    token.zeroize();
                }
            }
            Self::List { .. } => {}
        }
    }
}

fn execute(request: CloudWorkspaceRequest) -> Result<Value, String> {
    let input = Zeroizing::new(
        serde_json::to_vec(&request).map_err(|_| "The cloud request could not be encoded.")?,
    );
    drop(request);
    if input.len() > 65536 {
        return Err("The cloud request exceeds 64 KiB.".to_string());
    }
    let result = crate::shared_cli::run_shared_cli_json_command(
        &[
            "cloud".to_string(),
            "request".to_string(),
            "--json".to_string(),
        ],
        input,
        Duration::from_secs(60),
    )?;
    validate_reply(&result)?;
    Ok(result)
}

fn validate_reply(value: &Value) -> Result<(), String> {
    let valid = value
        .as_object()
        .is_some_and(|reply| match value["ok"].as_bool() {
            Some(false) => {
                reply.len() == 2
                    && value["error"]
                        .as_str()
                        .is_some_and(|message| !message.is_empty() && message.len() <= 8000)
            }
            Some(true) => {
                reply.len() == 2
                    && value["connections"].as_array().is_some_and(|connections| {
                        connections.len() <= 100
                            && connections.iter().all(|connection| {
                                let fields = [
                                    "id",
                                    "workspaceId",
                                    "origin",
                                    "workspaceRoot",
                                    "workspaceName",
                                    "projectName",
                                    "profileName",
                                    "status",
                                    "access",
                                ];
                                connection.as_object().is_some_and(|row| {
                                    row.len() == fields.len()
                                        && fields.iter().all(|field| {
                                            row.get(*field).and_then(Value::as_str).is_some_and(
                                                |text| !text.is_empty() && text.len() <= 48000,
                                            )
                                        })
                                })
                            })
                    })
            }
            None => false,
        });
    if valid {
        Ok(())
    } else {
        Err("The cloud connection process returned an invalid response.".to_string())
    }
}

fn authorize_window(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err(
            "Cloud workspace connections can only be managed in the main desktop window."
                .to_string(),
        )
    }
}

#[tauri::command]
pub async fn cloud_workspace_request(
    window: tauri::Window,
    request: CloudWorkspaceRequest,
) -> Result<Value, String> {
    authorize_window(window.label())?;
    tauri::async_runtime::spawn_blocking(move || execute(request))
        .await
        .map_err(|_| "The cloud connection process stopped unexpectedly.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_request_contract_rejects_unknown_fields() {
        assert!(serde_json::from_value::<CloudWorkspaceRequest>(
            serde_json::json!({"action":"list","refresh":false,"token":"unexpected"})
        )
        .is_err());
        let request = serde_json::from_value::<CloudWorkspaceRequest>(serde_json::json!({"action":"connect","origin":"https://cloud.example.test","token":"private-input","workspaceRoot":"workspace","name":"Workspace"})).unwrap();
        assert_eq!(
            serde_json::to_value(&request).unwrap()["workspaceRoot"],
            "workspace"
        );
    }

    #[test]
    fn cloud_bridge_rejects_oversized_input_before_launch() {
        let request = CloudWorkspaceRequest::Connect {
            origin: "https://cloud.example.test".into(),
            token: "a".repeat(70000),
            workspace_root: "workspace".into(),
            name: "Workspace".into(),
        };
        assert!(execute(request).unwrap_err().contains("64 KiB"));
    }

    #[test]
    fn cloud_bridge_restricts_the_caller_and_the_response_fields() {
        assert!(authorize_window("main").is_ok());
        assert!(authorize_window("preview").is_err());
        assert!(
            validate_reply(&serde_json::json!({"ok":true,"connections":[],"token":"private"}))
                .is_err()
        );
        assert!(validate_reply(&serde_json::json!({"ok":false,"error":"Request failed"})).is_ok());
    }

    #[test]
    #[ignore = "Requires the built client CLI and an isolated MACHDOCH_USER_CONFIG_DIR"]
    fn cloud_bridge_uses_the_packaged_cli() {
        assert!(std::env::var("MACHDOCH_USER_CONFIG_DIR").is_ok());
        let result = execute(CloudWorkspaceRequest::List { refresh: false }).unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["connections"], serde_json::json!([]));
    }

    #[test]
    #[ignore = "Requires an isolated native request fixture directory and built CLI"]
    fn cloud_bridge_request_fixture() {
        let directory = std::path::PathBuf::from(
            std::env::var("MACHDOCH_CLOUD_VERIFY_DIRECTORY")
                .expect("Set the native verification directory"),
        );
        assert!(directory.is_absolute());
        assert!(std::env::var("MACHDOCH_USER_CONFIG_DIR").is_ok());
        let bytes = Zeroizing::new(std::fs::read(directory.join("request.json")).unwrap());
        let request: CloudWorkspaceRequest =
            serde_json::from_slice(&bytes).expect("Invalid native cloud fixture");
        let secret = Zeroizing::new(match &request {
            CloudWorkspaceRequest::Connect { token, .. } => token.clone(),
            CloudWorkspaceRequest::Reconnect { token, .. }
            | CloudWorkspaceRequest::Disconnect { token, .. } => token.clone().unwrap_or_default(),
            CloudWorkspaceRequest::List { .. } => String::new(),
        });
        let result = execute(request).expect("Native cloud request failed");
        let encoded = serde_json::to_string(&result).unwrap();
        assert!(
            secret.is_empty() || !encoded.contains(secret.as_str()),
            "Native reply exposed a runner credential"
        );
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join("reply.json"))
            .unwrap();
        file.write_all(encoded.as_bytes()).unwrap();
        file.sync_all().unwrap();
    }
}
