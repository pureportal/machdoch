use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use serde::{Deserialize, Serialize};

use crate::media::{
    ensure_ralph_media_flow_run, inspect_ralph_media_run, RalphMediaFlowRunRequest,
    RalphMediaResolvedInputBinding, RalphMediaRunDetail,
};

const MAX_BRIDGE_REQUEST_BYTES: u64 = 256 * 1024;
const REQUEST_PATH_ENV: &str = "MACHDOCH_MEDIA_BRIDGE_REQUEST_PATH";
const RESPONSE_PATH_ENV: &str = "MACHDOCH_MEDIA_BRIDGE_RESPONSE_PATH";
const TOKEN_ENV: &str = "MACHDOCH_MEDIA_BRIDGE_TOKEN";

fn read_request_id_hint(bytes: &[u8]) -> String {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|value| value.get("requestId")?.as_str().map(str::to_owned))
        .filter(|request_id| !request_id.is_empty() && request_id.len() <= 128)
        .unwrap_or_else(|| "invalid-request".to_string())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
enum RalphMediaBridgeRequest {
    EnsureRun {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "requestId")]
        request_id: String,
        token: String,
        #[serde(rename = "runId")]
        run_id: String,
        #[serde(rename = "flowId")]
        flow_id: String,
        #[serde(rename = "revisionId")]
        revision_id: String,
        #[serde(rename = "inputBindings")]
        input_bindings: HashMap<String, RalphMediaResolvedInputBinding>,
        #[serde(rename = "approvalPolicy")]
        approval_policy: String,
    },
    InspectRun {
        #[serde(rename = "schemaVersion")]
        schema_version: u32,
        #[serde(rename = "requestId")]
        request_id: String,
        token: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
}

impl RalphMediaBridgeRequest {
    fn request_id(&self) -> &str {
        match self {
            Self::EnsureRun { request_id, .. } | Self::InspectRun { request_id, .. } => request_id,
        }
    }

    fn schema_version(&self) -> u32 {
        match self {
            Self::EnsureRun { schema_version, .. } | Self::InspectRun { schema_version, .. } => {
                *schema_version
            }
        }
    }

    fn token(&self) -> &str {
        match self {
            Self::EnsureRun { token, .. } | Self::InspectRun { token, .. } => token,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RalphMediaBridgeResponse<'a> {
    schema_version: u32,
    request_id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<RalphMediaRunDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub(super) struct RalphMediaBridge {
    root: PathBuf,
    request_path: PathBuf,
    response_path: PathBuf,
    token: String,
}

impl RalphMediaBridge {
    pub(super) fn create() -> Result<Self, String> {
        let mut random = [0_u8; 24];
        getrandom::fill(&mut random)
            .map_err(|error| format!("failed to create Ralph media bridge token: {error}"))?;
        let token = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let root = std::env::temp_dir().join(format!("machdoch-ralph-media-{token}"));
        fs::create_dir(&root)
            .map_err(|error| format!("failed to create Ralph media bridge directory: {error}"))?;
        let request_path = root.join("request.json");
        let response_path = root.join("response.json");
        Ok(Self {
            root,
            request_path,
            response_path,
            token,
        })
    }

    pub(super) fn configure_command(&self, command: &mut Command) {
        command.env(REQUEST_PATH_ENV, &self.request_path);
        command.env(RESPONSE_PATH_ENV, &self.response_path);
        command.env(TOKEN_ENV, &self.token);
    }

    pub(super) fn service_pending_request(
        &self,
        app: &tauri::AppHandle,
        workspace_root: &Path,
    ) -> Result<(), String> {
        if !self.request_path.exists() {
            return Ok(());
        }
        let metadata = fs::metadata(&self.request_path)
            .map_err(|error| format!("failed to inspect Ralph media bridge request: {error}"))?;
        if !metadata.is_file() || metadata.len() > MAX_BRIDGE_REQUEST_BYTES {
            let _ = fs::remove_file(&self.request_path);
            return Err("Ralph media bridge request is not a bounded regular file".to_string());
        }
        let bytes = fs::read(&self.request_path)
            .map_err(|error| format!("failed to read Ralph media bridge request: {error}"))?;
        fs::remove_file(&self.request_path)
            .map_err(|error| format!("failed to consume Ralph media bridge request: {error}"))?;
        let request_id_hint = read_request_id_hint(&bytes);
        let parsed = serde_json::from_slice::<RalphMediaBridgeRequest>(&bytes);
        let (request_id, result) = match parsed {
            Ok(request) => {
                let request_id = request.request_id().to_string();
                let result = if request.schema_version() != 1 {
                    Err("Ralph media bridge schemaVersion must be 1".to_string())
                } else if request.token() != self.token {
                    Err("Ralph media bridge authentication failed".to_string())
                } else {
                    match request {
                        RalphMediaBridgeRequest::EnsureRun {
                            run_id,
                            flow_id,
                            revision_id,
                            input_bindings,
                            approval_policy,
                            ..
                        } => ensure_ralph_media_flow_run(
                            app.clone(),
                            workspace_root,
                            RalphMediaFlowRunRequest {
                                run_id,
                                flow_id,
                                revision_id,
                                input_bindings,
                                approval_policy,
                            },
                        ),
                        RalphMediaBridgeRequest::InspectRun { run_id, .. } => {
                            inspect_ralph_media_run(app.clone(), &run_id)
                        }
                    }
                };
                (request_id, result)
            }
            Err(error) => (
                request_id_hint,
                Err(format!("Ralph media bridge request is invalid: {error}")),
            ),
        };
        let response = match result {
            Ok(detail) => RalphMediaBridgeResponse {
                schema_version: 1,
                request_id: &request_id,
                ok: true,
                detail: Some(detail),
                error: None,
            },
            Err(error) => RalphMediaBridgeResponse {
                schema_version: 1,
                request_id: &request_id,
                ok: false,
                detail: None,
                error: Some(error),
            },
        };
        let response_bytes = serde_json::to_vec(&response)
            .map_err(|error| format!("failed to encode Ralph media bridge response: {error}"))?;
        let temporary_path = self.root.join("response.tmp");
        fs::write(&temporary_path, response_bytes)
            .map_err(|error| format!("failed to write Ralph media bridge response: {error}"))?;
        if self.response_path.exists() {
            fs::remove_file(&self.response_path).map_err(|error| {
                format!("failed to replace Ralph media bridge response: {error}")
            })?;
        }
        fs::rename(&temporary_path, &self.response_path)
            .map_err(|error| format!("failed to publish Ralph media bridge response: {error}"))
    }
}

impl Drop for RalphMediaBridge {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(test)]
mod tests {
    use super::read_request_id_hint;

    #[test]
    fn preserves_bounded_request_ids_for_protocol_errors() {
        assert_eq!(
            read_request_id_hint(br#"{"requestId":"request-42","unexpected":true}"#),
            "request-42"
        );
        assert_eq!(
            read_request_id_hint(br#"{"requestId":""}"#),
            "invalid-request"
        );
        assert_eq!(read_request_id_hint(b"not-json"), "invalid-request");
    }
}
