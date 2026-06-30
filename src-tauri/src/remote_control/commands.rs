use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};

use super::{
    now_millis, MAX_COMMAND_TEXT_CHARS, MAX_REMOTE_SHORT_TEXT_CHARS, MAX_REMOTE_TEXT_CHARS,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteControlCommandEvent {
    pub(super) command_id: String,
    pub(super) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) attachment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) context_pack_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) run_id: Option<String>,
    pub(super) created_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteCommandRecord {
    command_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    prompt_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    target_preview: Option<String>,
    created_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteCommandRequest {
    pub(super) kind: String,
    pub(super) task_id: Option<String>,
    pub(super) session_id: Option<String>,
    pub(super) prompt: Option<String>,
    pub(super) title: Option<String>,
    pub(super) tags: Option<Vec<String>>,
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
    pub(super) mode: Option<String>,
    pub(super) workspace: Option<String>,
    pub(super) enabled: Option<bool>,
    pub(super) attachment_id: Option<String>,
    pub(super) context_pack_id: Option<String>,
    pub(super) message_id: Option<String>,
    pub(super) job_id: Option<String>,
    pub(super) run_id: Option<String>,
}

pub(super) fn normalize_command(
    request: RemoteCommandRequest,
) -> Result<RemoteControlCommandEvent, String> {
    let kind = request.kind.trim().to_ascii_lowercase();
    let allowed = matches!(
        kind.as_str(),
        "cancel"
            | "retry"
            | "continue"
            | "follow-up"
            | "create-session"
            | "activate-session"
            | "archive-session"
            | "pin-session"
            | "duplicate-session"
            | "branch-session"
            | "delete-session"
            | "rename-session"
            | "tag-session"
            | "clear-session-history"
            | "update-draft"
            | "set-session-model"
            | "set-session-mode"
            | "set-session-memory"
            | "set-global-memory"
            | "set-ui-control"
            | "remove-attachment"
            | "clear-attachments"
            | "apply-context-pack"
            | "delete-context-pack"
            | "save-message-context-pack"
            | "speak-message"
            | "stop-speaking"
            | "scheduler-trigger"
            | "scheduler-pause"
            | "scheduler-resume"
            | "scheduler-delete"
            | "scheduler-retry-run"
            | "scheduler-cancel-run"
    );

    if !allowed {
        return Err("Unsupported Mission Control command.".to_string());
    }

    let task_id = optional_trimmed_string(request.task_id.as_deref());
    let session_id = optional_trimmed_string(request.session_id.as_deref());

    if matches!(kind.as_str(), "cancel" | "retry" | "continue") && task_id.is_none() {
        return Err("This Mission Control command requires a taskId.".to_string());
    }

    if requires_session_id(&kind) && session_id.is_none() {
        return Err("This Mission Control command requires a sessionId.".to_string());
    }

    let prompt = optional_truncated_text(request.prompt.as_deref(), MAX_COMMAND_TEXT_CHARS);
    if kind == "follow-up" && prompt.is_none() {
        return Err("Queued follow-up commands require a prompt.".to_string());
    }

    let title = optional_truncated_text(request.title.as_deref(), MAX_REMOTE_SHORT_TEXT_CHARS);
    if kind == "rename-session" && title.is_none() {
        return Err("Renaming a session requires a title.".to_string());
    }

    let tags = request.tags.map(|tags| {
        tags.into_iter()
            .map(|tag| truncate_chars(tag.trim(), 64))
            .filter(|tag| !tag.is_empty())
            .take(24)
            .collect::<Vec<_>>()
    });
    if kind == "tag-session" && tags.is_none() {
        return Err("Tagging a session requires tags.".to_string());
    }

    let provider =
        optional_truncated_text(request.provider.as_deref(), MAX_REMOTE_SHORT_TEXT_CHARS);
    let model = optional_truncated_text(request.model.as_deref(), MAX_REMOTE_SHORT_TEXT_CHARS);
    if kind == "set-session-model" && (provider.is_none() || model.is_none()) {
        return Err("Model selection requires provider and model.".to_string());
    }

    let mode = optional_truncated_text(request.mode.as_deref(), MAX_REMOTE_SHORT_TEXT_CHARS);
    if kind == "set-session-mode" && !matches!(mode.as_deref(), Some("ask" | "machdoch")) {
        return Err("Session mode must be ask or machdoch.".to_string());
    }

    let workspace = optional_truncated_text(request.workspace.as_deref(), MAX_REMOTE_TEXT_CHARS);
    if matches!(
        kind.as_str(),
        "set-session-memory" | "set-global-memory" | "set-ui-control"
    ) && request.enabled.is_none()
    {
        return Err("This Mission Control command requires an enabled value.".to_string());
    }

    let attachment_id = optional_trimmed_string(request.attachment_id.as_deref());
    if kind == "remove-attachment" && attachment_id.is_none() {
        return Err("Removing an attachment requires an attachmentId.".to_string());
    }

    let context_pack_id = optional_trimmed_string(request.context_pack_id.as_deref());
    if matches!(kind.as_str(), "apply-context-pack" | "delete-context-pack")
        && context_pack_id.is_none()
    {
        return Err("This Mission Control command requires a contextPackId.".to_string());
    }

    let message_id = optional_trimmed_string(request.message_id.as_deref());
    if matches!(kind.as_str(), "save-message-context-pack" | "speak-message")
        && message_id.is_none()
    {
        return Err("This Mission Control command requires a messageId.".to_string());
    }

    let job_id = optional_trimmed_string(request.job_id.as_deref());
    if matches!(
        kind.as_str(),
        "scheduler-trigger" | "scheduler-pause" | "scheduler-resume" | "scheduler-delete"
    ) && job_id.is_none()
    {
        return Err("This Mission Control command requires a jobId.".to_string());
    }

    let run_id = optional_trimmed_string(request.run_id.as_deref());
    if matches!(
        kind.as_str(),
        "scheduler-retry-run" | "scheduler-cancel-run"
    ) && run_id.is_none()
    {
        return Err("This Mission Control command requires a runId.".to_string());
    }

    Ok(RemoteControlCommandEvent {
        command_id: create_command_id(),
        kind,
        task_id,
        session_id,
        prompt,
        title,
        tags,
        provider,
        model,
        mode,
        workspace,
        enabled: request.enabled,
        attachment_id,
        context_pack_id,
        message_id,
        job_id,
        run_id,
        created_at: now_millis(),
    })
}

pub(super) fn create_command_record(event: &RemoteControlCommandEvent) -> RemoteCommandRecord {
    RemoteCommandRecord {
        command_id: event.command_id.clone(),
        kind: event.kind.clone(),
        task_id: event.task_id.clone(),
        session_id: event.session_id.clone(),
        prompt_preview: event
            .prompt
            .as_deref()
            .map(|value| truncate_chars(value, 240)),
        title: event.title.clone(),
        target_preview: create_command_target_preview(event),
        created_at: event.created_at,
    }
}

pub(super) fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    value.chars().take(max_chars).collect::<String>()
}

fn requires_session_id(kind: &str) -> bool {
    matches!(
        kind,
        "activate-session"
            | "archive-session"
            | "pin-session"
            | "duplicate-session"
            | "branch-session"
            | "delete-session"
            | "rename-session"
            | "tag-session"
            | "clear-session-history"
            | "update-draft"
            | "set-session-model"
            | "set-session-mode"
            | "set-session-memory"
            | "set-global-memory"
            | "set-ui-control"
            | "remove-attachment"
            | "clear-attachments"
            | "apply-context-pack"
            | "save-message-context-pack"
            | "speak-message"
    )
}

fn optional_trimmed_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn optional_truncated_text(value: Option<&str>, max_chars: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_chars(value, max_chars))
}

fn create_command_target_preview(event: &RemoteControlCommandEvent) -> Option<String> {
    [
        event
            .session_id
            .as_deref()
            .map(|value| format!("session:{value}")),
        event
            .task_id
            .as_deref()
            .map(|value| format!("task:{value}")),
        event.job_id.as_deref().map(|value| format!("job:{value}")),
        event.run_id.as_deref().map(|value| format!("run:{value}")),
        event
            .message_id
            .as_deref()
            .map(|value| format!("message:{value}")),
        event
            .context_pack_id
            .as_deref()
            .map(|value| format!("context-pack:{value}")),
        event
            .attachment_id
            .as_deref()
            .map(|value| format!("attachment:{value}")),
    ]
    .into_iter()
    .flatten()
    .next()
    .map(|value| truncate_chars(&value, MAX_REMOTE_SHORT_TEXT_CHARS))
}

fn create_command_id() -> String {
    let mut bytes = [0_u8; 12];

    if getrandom::fill(&mut bytes).is_ok() {
        return URL_SAFE_NO_PAD.encode(bytes);
    }

    format!("cmd-{}", now_millis())
}

#[cfg(test)]
mod tests {
    use super::super::MAX_COMMAND_TEXT_CHARS;
    use super::{create_command_record, normalize_command, truncate_chars, RemoteCommandRequest};

    fn command_request(kind: &str) -> RemoteCommandRequest {
        RemoteCommandRequest {
            kind: kind.to_string(),
            task_id: None,
            session_id: None,
            prompt: None,
            title: None,
            tags: None,
            provider: None,
            model: None,
            mode: None,
            workspace: None,
            enabled: None,
            attachment_id: None,
            context_pack_id: None,
            message_id: None,
            job_id: None,
            run_id: None,
        }
    }

    #[test]
    fn follow_up_commands_require_prompt_text() {
        let result = normalize_command(RemoteCommandRequest {
            task_id: Some("task-1".to_string()),
            prompt: Some("   ".to_string()),
            ..command_request("follow-up")
        });

        assert!(result.is_err());
    }

    #[test]
    fn approval_decision_commands_are_not_supported() {
        let result = normalize_command(RemoteCommandRequest {
            task_id: Some("task-1".to_string()),
            prompt: None,
            ..command_request("approval-decision")
        });

        assert!(result.is_err());
    }

    #[test]
    fn set_session_mode_accepts_only_supported_modes() {
        let invalid = normalize_command(RemoteCommandRequest {
            session_id: Some("session-1".to_string()),
            mode: Some("auto".to_string()),
            ..command_request("set-session-mode")
        });

        assert!(invalid
            .expect_err("invalid session mode should be rejected")
            .contains("ask or machdoch"));

        let allowed = normalize_command(RemoteCommandRequest {
            session_id: Some("session-1".to_string()),
            mode: Some("ask".to_string()),
            ..command_request("set-session-mode")
        })
        .expect("supported session mode should normalize");

        assert_eq!(allowed.mode.as_deref(), Some("ask"));
    }

    #[test]
    fn follow_up_prompts_are_trimmed_and_truncated() {
        let prompt = format!("  {}  ", "x".repeat(MAX_COMMAND_TEXT_CHARS + 1));
        let event = normalize_command(RemoteCommandRequest {
            task_id: Some("task-1".to_string()),
            prompt: Some(prompt),
            ..command_request("follow-up")
        })
        .expect("valid follow-up command should normalize");

        assert_eq!(
            event.prompt.expect("prompt").chars().count(),
            MAX_COMMAND_TEXT_CHARS
        );
    }

    #[test]
    fn command_records_prefer_session_target_preview() {
        let event = normalize_command(RemoteCommandRequest {
            session_id: Some("session-1".to_string()),
            prompt: Some("queued prompt".to_string()),
            ..command_request("update-draft")
        })
        .expect("valid session command should normalize");
        let record = create_command_record(&event);

        assert_eq!(record.target_preview.as_deref(), Some("session:session-1"));
        assert_eq!(record.prompt_preview.as_deref(), Some("queued prompt"));
    }

    #[test]
    fn truncate_chars_preserves_character_boundaries() {
        assert_eq!(truncate_chars("åßçdé", 3), "åßç");
    }
}
