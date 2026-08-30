use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const GATEWAY_PROTOCOL_VERSION: u32 = 4;
pub const PRODUCT_CAPABILITY: &str = "product.v2";
pub const PRODUCT_SNAPSHOT_VERSION: u32 = 3;
pub const MAX_GATEWAY_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ManagerMessage {
    Request {
        request_id: String,
        request: HostRequest,
    },
    Disconnect {
        reason: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostMessage {
    Hello {
        instance_id: String,
        protocol_version: u32,
        product_version: String,
        capabilities: Vec<String>,
    },
    Heartbeat {
        sent_at: u64,
    },
    Response {
        request_id: String,
        response: HostResponse,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostRequest {
    GetProductSnapshot,
    ExecuteProductCommand { command: ProductCommand },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HostResponse {
    ProductSnapshot {
        snapshot: Value,
    },
    CommandAccepted {
        receipt: CommandReceipt,
    },
    Error {
        code: HostErrorCode,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandReceipt {
    pub command_id: String,
    pub duplicate: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HostErrorCode {
    InvalidRequest,
    Conflict,
    Unavailable,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProductCommand {
    pub kind: ProductCommandKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_enhancement_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interview_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_pack_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aspect_ratio: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transparent_background: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProductCommandKind {
    Cancel,
    Retry,
    Continue,
    SubmitMessage,
    CreateSession,
    ActivateSession,
    ArchiveSession,
    PinSession,
    DuplicateSession,
    BranchSession,
    DeleteSession,
    RenameSession,
    TagSession,
    ClearSessionHistory,
    ClearSessionMode,
    ClearSessionReasoning,
    UpdateDraft,
    SetSessionModel,
    SetSessionMode,
    SetSessionReasoning,
    SetSessionWorkspace,
    ClearSessionWorkspace,
    SetPromptEnhancementMode,
    SetInterview,
    CancelPromptEnhancement,
    SetSessionMemory,
    SetGlobalMemory,
    SetUiControl,
    RemoveAttachment,
    ClearAttachments,
    ApplyContextPack,
    DeleteContextPack,
    SaveMessageContextPack,
    SpeakMessage,
    StopSpeaking,
    SchedulerTrigger,
    SchedulerPause,
    SchedulerResume,
    SchedulerDelete,
    SchedulerRetryRun,
    SchedulerCancelRun,
    GenerateMedia,
    CancelMediaRun,
}

impl ProductCommandKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cancel => "cancel",
            Self::Retry => "retry",
            Self::Continue => "continue",
            Self::SubmitMessage => "submit-message",
            Self::CreateSession => "create-session",
            Self::ActivateSession => "activate-session",
            Self::ArchiveSession => "archive-session",
            Self::PinSession => "pin-session",
            Self::DuplicateSession => "duplicate-session",
            Self::BranchSession => "branch-session",
            Self::DeleteSession => "delete-session",
            Self::RenameSession => "rename-session",
            Self::TagSession => "tag-session",
            Self::ClearSessionHistory => "clear-session-history",
            Self::ClearSessionMode => "clear-session-mode",
            Self::ClearSessionReasoning => "clear-session-reasoning",
            Self::UpdateDraft => "update-draft",
            Self::SetSessionModel => "set-session-model",
            Self::SetSessionMode => "set-session-mode",
            Self::SetSessionReasoning => "set-session-reasoning",
            Self::SetSessionWorkspace => "set-session-workspace",
            Self::ClearSessionWorkspace => "clear-session-workspace",
            Self::SetPromptEnhancementMode => "set-prompt-enhancement-mode",
            Self::SetInterview => "set-interview",
            Self::CancelPromptEnhancement => "cancel-prompt-enhancement",
            Self::SetSessionMemory => "set-session-memory",
            Self::SetGlobalMemory => "set-global-memory",
            Self::SetUiControl => "set-ui-control",
            Self::RemoveAttachment => "remove-attachment",
            Self::ClearAttachments => "clear-attachments",
            Self::ApplyContextPack => "apply-context-pack",
            Self::DeleteContextPack => "delete-context-pack",
            Self::SaveMessageContextPack => "save-message-context-pack",
            Self::SpeakMessage => "speak-message",
            Self::StopSpeaking => "stop-speaking",
            Self::SchedulerTrigger => "scheduler-trigger",
            Self::SchedulerPause => "scheduler-pause",
            Self::SchedulerResume => "scheduler-resume",
            Self::SchedulerDelete => "scheduler-delete",
            Self::SchedulerRetryRun => "scheduler-retry-run",
            Self::SchedulerCancelRun => "scheduler-cancel-run",
            Self::GenerateMedia => "generate-media",
            Self::CancelMediaRun => "cancel-media-run",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cancel_command() -> ProductCommand {
        ProductCommand {
            kind: ProductCommandKind::Cancel,
            command_id: Some("command-1".to_string()),
            task_id: Some("task-1".to_string()),
            session_id: None,
            prompt: None,
            title: None,
            tags: None,
            provider: None,
            model: None,
            model_id: None,
            mode: None,
            reasoning: None,
            prompt_enhancement_mode: None,
            interview_enabled: None,
            workspace: None,
            enabled: None,
            attachment_id: None,
            context_pack_id: None,
            message_id: None,
            job_id: None,
            run_id: None,
            target: None,
            aspect_ratio: None,
            output_count: None,
            output_format: None,
            transparent_background: None,
        }
    }

    #[test]
    fn messages_round_trip_with_tagged_json() {
        let message = ManagerMessage::Request {
            request_id: "request-1".to_string(),
            request: HostRequest::ExecuteProductCommand {
                command: cancel_command(),
            },
        };

        let encoded = serde_json::to_string(&message).expect("message should encode");
        let decoded = serde_json::from_str::<ManagerMessage>(&encoded)
            .expect("encoded message should decode");

        assert_eq!(decoded, message);
        assert!(encoded.contains("\"type\":\"executeProductCommand\""));
        assert!(encoded.contains("\"kind\":\"cancel\""));
        assert!(!encoded.contains("request_id"));
    }

    #[test]
    fn hello_uses_the_gateway_field_names() {
        let message = HostMessage::Hello {
            instance_id: "instance-1".to_string(),
            protocol_version: GATEWAY_PROTOCOL_VERSION,
            product_version: "6.3.0".to_string(),
            capabilities: vec![PRODUCT_CAPABILITY.to_string()],
        };

        assert_eq!(
            serde_json::to_value(message).expect("message should encode"),
            serde_json::json!({
                "type": "hello",
                "instanceId": "instance-1",
                "protocolVersion": GATEWAY_PROTOCOL_VERSION,
                "productVersion": "6.3.0",
                "capabilities": ["product.v2"]
            })
        );
    }

    #[test]
    fn media_commands_use_the_shared_recipe_fields() {
        let command = serde_json::from_value::<ProductCommand>(serde_json::json!({
            "kind": "generate-media",
            "commandId": "media-1",
            "prompt": "Create a geometric owl",
            "modelId": "openai:gpt-image-2",
            "target": "image",
            "aspectRatio": "1:1",
            "outputCount": 2,
            "outputFormat": "png",
            "transparentBackground": true
        }))
        .expect("media command should decode");

        assert_eq!(command.kind, ProductCommandKind::GenerateMedia);
        assert_eq!(command.model_id.as_deref(), Some("openai:gpt-image-2"));
        assert_eq!(command.output_count, Some(2));
        assert_eq!(command.transparent_background, Some(true));
    }
}
