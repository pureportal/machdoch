use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteShellSnapshot {
    #[serde(default)]
    pub(super) version: u32,
    #[serde(default)]
    pub(super) captured_at: u64,
    #[serde(default)]
    pub(super) active_session_id: Option<String>,
    #[serde(default)]
    pub(super) sessions: Vec<RemoteShellSession>,
    #[serde(default)]
    pub(super) visible_messages: Vec<RemoteShellMessage>,
    #[serde(default)]
    pub(super) composer: Option<RemoteShellComposer>,
    #[serde(default)]
    pub(super) runtime: Option<RemoteShellRuntime>,
    #[serde(default)]
    pub(super) scheduler: Option<RemoteShellScheduler>,
    #[serde(default)]
    pub(super) context_packs: Vec<RemoteShellContextPack>,
    #[serde(default)]
    pub(super) prompt_history: Vec<String>,
    #[serde(default)]
    pub(super) voice: Option<RemoteShellVoice>,
    #[serde(default)]
    pub(super) quick_task: Option<RemoteShellQuickTask>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellSession {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) status: String,
    pub(super) workspace: Option<String>,
    pub(super) profile: Option<String>,
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) mode: Option<String>,
    pub(super) effective_mode: String,
    pub(super) created_at: u64,
    pub(super) updated_at: u64,
    pub(super) archived_at: Option<u64>,
    pub(super) pinned_at: Option<u64>,
    pub(super) tags: Vec<String>,
    pub(super) message_count: usize,
    pub(super) prompt_history_count: usize,
    pub(super) attachment_count: usize,
    pub(super) running_task_id: Option<String>,
    pub(super) can_rename: bool,
    pub(super) can_delete: bool,
    pub(super) can_archive: bool,
    pub(super) can_pin: bool,
    pub(super) can_duplicate: bool,
    pub(super) can_branch: bool,
    pub(super) special_kind: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMessage {
    pub(super) id: String,
    pub(super) role: String,
    pub(super) content: String,
    pub(super) created_at: Option<u64>,
    pub(super) task_id: Option<String>,
    pub(super) intent: Option<String>,
    pub(super) attachments: Vec<RemoteShellAttachment>,
    pub(super) source: Option<RemoteShellMessageSource>,
    pub(super) actions: RemoteShellMessageActions,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMessageSource {
    pub(super) kind: String,
    pub(super) status: Option<String>,
    pub(super) title: Option<String>,
    pub(super) summary: Option<String>,
    pub(super) mode: Option<String>,
    pub(super) entries: Vec<RemoteShellTraceEntry>,
    pub(super) timeline: Vec<RemoteShellTraceEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellTraceEntry {
    pub(super) label: String,
    pub(super) detail: String,
    pub(super) tone: Option<String>,
    pub(super) timestamp: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMessageActions {
    pub(super) can_retry: bool,
    pub(super) can_continue: bool,
    pub(super) can_save_as_context_pack: bool,
    pub(super) can_speak: bool,
    pub(super) is_speaking: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellAttachment {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) name: String,
    pub(super) path: String,
    pub(super) parent: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellComposer {
    pub(super) session_id: String,
    pub(super) draft: String,
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) mode: String,
    pub(super) default_mode: String,
    pub(super) workspace: Option<String>,
    pub(super) workspace_label: String,
    pub(super) can_send: bool,
    pub(super) send_disabled_reason: Option<String>,
    pub(super) is_executing: bool,
    pub(super) session_memory_enabled: bool,
    pub(super) global_memory_available: bool,
    pub(super) global_memory_enabled: bool,
    pub(super) ui_control_available: bool,
    pub(super) ui_control_enabled: bool,
    pub(super) ui_control_description: String,
    pub(super) attachments: Vec<RemoteShellAttachment>,
    pub(super) chooser_providers: Vec<String>,
    pub(super) matched_context_pack_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellRuntime {
    pub(super) loading: bool,
    pub(super) error: Option<String>,
    pub(super) has_any_provider: bool,
    pub(super) provider_statuses: Vec<RemoteShellProviderStatus>,
    pub(super) mode: Option<String>,
    pub(super) profile: Option<String>,
    pub(super) ui_control: Option<RemoteShellRuntimeCapability>,
    pub(super) web_search: Option<RemoteShellRuntimeCapability>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellProviderStatus {
    pub(super) provider: String,
    pub(super) available: bool,
    pub(super) reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellRuntimeCapability {
    pub(super) available: bool,
    pub(super) reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellScheduler {
    pub(super) workspace_root: Option<String>,
    pub(super) loading: bool,
    pub(super) error: Option<String>,
    pub(super) jobs: Vec<RemoteShellSchedulerJob>,
    pub(super) runs: Vec<RemoteShellSchedulerRun>,
    pub(super) updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellSchedulerJob {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) status: String,
    pub(super) schedule: String,
    pub(super) prompt_preview: String,
    pub(super) next_run_at: Option<u64>,
    pub(super) last_started_at: Option<u64>,
    pub(super) last_finished_at: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellSchedulerRun {
    pub(super) id: String,
    pub(super) job_id: String,
    pub(super) source: String,
    pub(super) status: String,
    pub(super) scheduled_for: u64,
    pub(super) updated_at: u64,
    pub(super) attempt: u32,
    pub(super) max_attempts: u32,
    pub(super) started_at: Option<u64>,
    pub(super) finished_at: Option<u64>,
    pub(super) next_attempt_at: Option<u64>,
    pub(super) error: Option<String>,
    pub(super) summary: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellContextPack {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) workspace: Option<String>,
    pub(super) instructions_preview: String,
    pub(super) prompt_preview: String,
    pub(super) attachment_count: usize,
    pub(super) variables: Vec<String>,
    pub(super) matched: bool,
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
    pub(super) mode: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellVoice {
    pub(super) supported: bool,
    pub(super) auto_speak_responses: bool,
    pub(super) speaking_message_id: Option<String>,
    pub(super) speech_input_supported: bool,
    pub(super) speech_input_enabled: bool,
    pub(super) speech_input_status: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellQuickTask {
    pub(super) status: String,
    pub(super) draft: String,
    pub(super) is_executing: bool,
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) autopilot_enabled: bool,
    pub(super) global_memory_enabled: bool,
    pub(super) ui_control_enabled: bool,
    pub(super) attachment_count: usize,
}
