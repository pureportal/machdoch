use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    command_kinds::{
        command_requirements, is_supported_command, is_supported_reasoning,
        supported_reasoning_modes_label,
    },
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
    pub(super) reasoning: Option<String>,
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
    pub(super) command_id: String,
    pub(super) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) prompt_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) target_preview: Option<String>,
    pub(super) created_at: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteCommandRequest {
    pub(super) command_id: Option<String>,
    pub(super) kind: String,
    pub(super) task_id: Option<String>,
    pub(super) session_id: Option<String>,
    pub(super) prompt: Option<String>,
    pub(super) title: Option<String>,
    pub(super) tags: Option<Vec<String>>,
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
    pub(super) mode: Option<String>,
    pub(super) reasoning: Option<String>,
    pub(super) workspace: Option<String>,
    pub(super) enabled: Option<bool>,
    pub(super) attachment_id: Option<String>,
    pub(super) context_pack_id: Option<String>,
    pub(super) message_id: Option<String>,
    pub(super) job_id: Option<String>,
    pub(super) run_id: Option<String>,
}

struct NormalizedCommandFields {
    task_id: Option<String>,
    session_id: Option<String>,
    prompt: Option<String>,
    title: Option<String>,
    tags: Option<Vec<String>>,
    provider: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    reasoning: Option<String>,
    workspace: Option<String>,
    enabled: Option<bool>,
    attachment_id: Option<String>,
    context_pack_id: Option<String>,
    message_id: Option<String>,
    job_id: Option<String>,
    run_id: Option<String>,
}

pub(super) fn normalize_command(
    request: RemoteCommandRequest,
) -> Result<RemoteControlCommandEvent, String> {
    let kind = request.kind.trim().to_ascii_lowercase();
    let command_id = optional_trimmed_string(request.command_id.as_deref());

    if command_id
        .as_ref()
        .is_some_and(|command_id| command_id.chars().count() > 128)
    {
        return Err("Mission Control command ids cannot exceed 128 characters.".to_string());
    }

    if !is_supported_command(&kind) {
        return Err("Unsupported Mission Control command.".to_string());
    }

    let fields = normalize_command_fields(&kind, request)?;

    Ok(RemoteControlCommandEvent {
        command_id: command_id.unwrap_or_else(create_command_id),
        kind,
        task_id: fields.task_id,
        session_id: fields.session_id,
        prompt: fields.prompt,
        title: fields.title,
        tags: fields.tags,
        provider: fields.provider,
        model: fields.model,
        mode: fields.mode,
        reasoning: fields.reasoning,
        workspace: fields.workspace,
        enabled: fields.enabled,
        attachment_id: fields.attachment_id,
        context_pack_id: fields.context_pack_id,
        message_id: fields.message_id,
        job_id: fields.job_id,
        run_id: fields.run_id,
        created_at: now_millis(),
    })
}

fn normalize_command_fields(
    kind: &str,
    request: RemoteCommandRequest,
) -> Result<NormalizedCommandFields, String> {
    let requirements = command_requirements(kind);
    let task_id = optional_trimmed_string(request.task_id.as_deref());
    let session_id = optional_trimmed_string(request.session_id.as_deref());

    require_value(
        requirements.task_id,
        &task_id,
        "This Mission Control command requires a taskId.",
    )?;

    require_value(
        requirements.session_id,
        &session_id,
        "This Mission Control command requires a sessionId.",
    )?;

    let prompt = optional_truncated_text(request.prompt.as_deref(), MAX_COMMAND_TEXT_CHARS);
    if kind == "follow-up" && prompt.is_none() {
        return Err("Queued follow-up commands require a prompt.".to_string());
    }

    let title = optional_truncated_text(request.title.as_deref(), MAX_REMOTE_SHORT_TEXT_CHARS);
    if kind == "rename-session" && title.is_none() {
        return Err("Renaming a session requires a title.".to_string());
    }

    let tags = normalized_tags(request.tags);
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

    let reasoning =
        optional_truncated_text(request.reasoning.as_deref(), MAX_REMOTE_SHORT_TEXT_CHARS);
    if kind == "set-session-reasoning" && !is_supported_reasoning(reasoning.as_deref()) {
        return Err(format!(
            "Session reasoning must be one of {}.",
            supported_reasoning_modes_label()
        ));
    }

    let workspace = optional_truncated_text(request.workspace.as_deref(), MAX_REMOTE_TEXT_CHARS);
    require_value(
        requirements.enabled,
        &request.enabled,
        "This Mission Control command requires an enabled value.",
    )?;

    let attachment_id = optional_trimmed_string(request.attachment_id.as_deref());
    if kind == "remove-attachment" && attachment_id.is_none() {
        return Err("Removing an attachment requires an attachmentId.".to_string());
    }

    let context_pack_id = optional_trimmed_string(request.context_pack_id.as_deref());
    require_value(
        requirements.context_pack_id,
        &context_pack_id,
        "This Mission Control command requires a contextPackId.",
    )?;

    let message_id = optional_trimmed_string(request.message_id.as_deref());
    require_value(
        requirements.message_id,
        &message_id,
        "This Mission Control command requires a messageId.",
    )?;

    let job_id = optional_trimmed_string(request.job_id.as_deref());
    require_value(
        requirements.job_id,
        &job_id,
        "This Mission Control command requires a jobId.",
    )?;

    let run_id = optional_trimmed_string(request.run_id.as_deref());
    require_value(
        requirements.run_id,
        &run_id,
        "This Mission Control command requires a runId.",
    )?;

    Ok(NormalizedCommandFields {
        task_id,
        session_id,
        prompt,
        title,
        tags,
        provider,
        model,
        mode,
        reasoning,
        workspace,
        enabled: request.enabled,
        attachment_id,
        context_pack_id,
        message_id,
        job_id,
        run_id,
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

pub(super) fn command_payloads_match(
    left: &RemoteControlCommandEvent,
    right: &RemoteControlCommandEvent,
) -> bool {
    left.command_id == right.command_id
        && left.kind == right.kind
        && left.task_id == right.task_id
        && left.session_id == right.session_id
        && left.prompt == right.prompt
        && left.title == right.title
        && left.tags == right.tags
        && left.provider == right.provider
        && left.model == right.model
        && left.mode == right.mode
        && left.reasoning == right.reasoning
        && left.workspace == right.workspace
        && left.enabled == right.enabled
        && left.attachment_id == right.attachment_id
        && left.context_pack_id == right.context_pack_id
        && left.message_id == right.message_id
        && left.job_id == right.job_id
        && left.run_id == right.run_id
}

pub(super) fn command_payload_hash(event: &RemoteControlCommandEvent) -> String {
    let canonical = serde_json::json!({
        "kind": event.kind,
        "taskId": event.task_id,
        "sessionId": event.session_id,
        "prompt": event.prompt,
        "title": event.title,
        "tags": event.tags,
        "provider": event.provider,
        "model": event.model,
        "mode": event.mode,
        "reasoning": event.reasoning,
        "workspace": event.workspace,
        "enabled": event.enabled,
        "attachmentId": event.attachment_id,
        "contextPackId": event.context_pack_id,
        "messageId": event.message_id,
        "jobId": event.job_id,
        "runId": event.run_id,
    });
    let bytes = serde_json::to_vec(&canonical)
        .expect("serializing a remote command payload should not fail");
    URL_SAFE_NO_PAD.encode(Sha256::digest(bytes))
}

pub(super) fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }

    value.chars().take(max_chars).collect::<String>()
}

fn require_value<T>(required: bool, value: &Option<T>, message: &str) -> Result<(), String> {
    if required && value.is_none() {
        return Err(message.to_string());
    }

    Ok(())
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

fn normalized_tags(tags: Option<Vec<String>>) -> Option<Vec<String>> {
    tags.map(|tags| {
        tags.into_iter()
            .map(|tag| truncate_chars(tag.trim(), 64))
            .filter(|tag| !tag.is_empty())
            .take(24)
            .collect::<Vec<_>>()
    })
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
    use super::truncate_chars;

    #[test]
    fn truncate_chars_preserves_character_boundaries() {
        assert_eq!(
            truncate_chars("\u{00e5}\u{00df}\u{00e7}d\u{00e9}", 3),
            "\u{00e5}\u{00df}\u{00e7}"
        );
    }
}
