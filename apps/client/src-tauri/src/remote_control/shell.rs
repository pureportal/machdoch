use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteShellSnapshot {
    pub(super) version: u32,
    #[serde(default)]
    pub(super) captured_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) active_session_id: Option<String>,
    #[serde(default)]
    pub(super) sessions: Vec<RemoteShellSession>,
    #[serde(default)]
    pub(super) workspaces: Vec<RemoteShellWorkspace>,
    #[serde(default)]
    pub(super) visible_messages: Vec<RemoteShellMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) composer: Option<RemoteShellComposer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) runtime: Option<RemoteShellRuntime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) scheduler: Option<RemoteShellScheduler>,
    #[serde(default)]
    pub(super) context_packs: Vec<RemoteShellContextPack>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) instructions: Option<RemoteShellInstructions>,
    #[serde(default)]
    pub(super) prompt_history: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) voice: Option<RemoteShellVoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) quick_task: Option<RemoteShellQuickTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) media: Option<RemoteShellMedia>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellSession {
    pub(super) id: String,
    pub(super) title: String,
    pub(super) status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace: Option<String>,
    pub(super) provider: String,
    pub(super) model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mode: Option<String>,
    pub(super) effective_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reasoning: Option<String>,
    pub(super) effective_reasoning: String,
    pub(super) created_at: u64,
    pub(super) updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) archived_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) pinned_at: Option<u64>,
    pub(super) tags: Vec<String>,
    pub(super) message_count: usize,
    pub(super) prompt_history_count: usize,
    pub(super) attachment_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) running_task_id: Option<String>,
    pub(super) can_rename: bool,
    pub(super) can_delete: bool,
    pub(super) can_archive: bool,
    pub(super) can_pin: bool,
    pub(super) can_duplicate: bool,
    pub(super) can_branch: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) special_kind: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellWorkspace {
    pub(super) root: String,
    pub(super) label: String,
    pub(super) session_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMessage {
    pub(super) id: String,
    pub(super) role: String,
    pub(super) content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) created_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) task_action: Option<RemoteShellTaskAction>,
    pub(super) presentation: String,
    pub(super) attachments: Vec<RemoteShellAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source: Option<RemoteShellMessageSource>,
    pub(super) actions: RemoteShellMessageActions,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMessageSource {
    pub(super) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mode: Option<String>,
    pub(super) entries: Vec<RemoteShellTraceEntry>,
    pub(super) timeline: Vec<RemoteShellTraceEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellTraceEntry {
    pub(super) label: String,
    pub(super) detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "source",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum RemoteShellAttachment {
    Path {
        id: String,
        kind: String,
        name: String,
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent: Option<String>,
    },
    MediaAsset {
        id: String,
        kind: String,
        name: String,
        workspace_root: String,
        asset_id: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellComposer {
    pub(super) session_id: String,
    pub(super) draft: String,
    pub(super) provider: String,
    pub(super) provider_label: String,
    pub(super) model: String,
    pub(super) model_label: String,
    pub(super) model_catalog_loading: bool,
    pub(super) model_catalog: Vec<RemoteShellModelProvider>,
    pub(super) mode: String,
    pub(super) default_mode: String,
    pub(super) reasoning: String,
    pub(super) default_reasoning: String,
    pub(super) reasoning_options: Vec<String>,
    pub(super) prompt_enhancement_mode: String,
    pub(super) interview_enabled: bool,
    pub(super) interview_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace: Option<String>,
    pub(super) workspace_label: String,
    pub(super) can_send: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
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
pub(super) struct RemoteShellModelProvider {
    pub(super) provider: String,
    pub(super) label: String,
    pub(super) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    pub(super) models: Vec<RemoteShellModel>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellModel {
    pub(super) id: String,
    pub(super) label: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellRuntime {
    pub(super) loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    pub(super) has_any_provider: bool,
    pub(super) provider_statuses: Vec<RemoteShellProviderStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ui_control: Option<RemoteShellRuntimeCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) web_search: Option<RemoteShellRuntimeCapability>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellProviderStatus {
    pub(super) provider: String,
    pub(super) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellRuntimeCapability {
    pub(super) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellScheduler {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace_root: Option<String>,
    pub(super) loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) next_run_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) last_started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) finished_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) next_attempt_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) summary: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellContextPack {
    pub(super) id: String,
    pub(super) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) scope_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace: Option<String>,
    pub(super) instructions_preview: String,
    pub(super) prompt_preview: String,
    pub(super) attachment_count: usize,
    pub(super) variables: Vec<String>,
    pub(super) matched: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) prompt_enhancement_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) interview_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) session_memory_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) use_global_memory: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ui_control_enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellInstructions {
    pub(super) loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    pub(super) profiles: Vec<RemoteShellInstructionProfile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellInstructionProfile {
    pub(super) id: String,
    pub(super) name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) body: Option<String>,
    pub(super) enabled: bool,
    pub(super) global: bool,
    pub(super) tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RemoteShellTaskAction {
    pub(super) kind: RemoteShellTaskActionKind,
    pub(super) objective: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum RemoteShellTaskActionKind {
    RetryTask,
    ContinueTask,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellVoice {
    pub(super) supported: bool,
    pub(super) auto_speak_responses: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) speaking_message_id: Option<String>,
    pub(super) speech_input_supported: bool,
    pub(super) speech_input_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMedia {
    pub(super) loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) runtime_mode: Option<String>,
    pub(super) generation: RemoteShellMediaGeneration,
    pub(super) models: Vec<RemoteShellMediaModel>,
    pub(super) assets: Vec<RemoteShellMediaAsset>,
    pub(super) asset_count: usize,
    pub(super) runs: Vec<RemoteShellMediaRun>,
    pub(super) run_count: usize,
    pub(super) busy: bool,
    pub(super) updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMediaGeneration {
    pub(super) prompt: String,
    pub(super) target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) model_id: Option<String>,
    pub(super) aspect_ratio: String,
    pub(super) output_count: u32,
    pub(super) output_format: String,
    pub(super) transparent_background: bool,
    pub(super) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMediaModel {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) target: String,
    pub(super) targets: Vec<String>,
    pub(super) recommended: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) cost_hint: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMediaAsset {
    pub(super) id: String,
    pub(super) run_id: String,
    pub(super) kind: String,
    pub(super) mime_type: String,
    pub(super) byte_size: u64,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) preview_data_url: Option<String>,
    pub(super) tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RemoteShellMediaRun {
    pub(super) id: String,
    pub(super) status: String,
    pub(super) created_at: String,
    pub(super) updated_at: String,
    pub(super) prompt: String,
    pub(super) model_label: String,
    pub(super) target: Option<String>,
    pub(super) output_count: u32,
    pub(super) progress: f64,
    pub(super) current_step: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
}
