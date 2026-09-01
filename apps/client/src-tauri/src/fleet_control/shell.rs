use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetShellSnapshot {
    pub(super) version: u32,
    #[serde(default)]
    pub(super) captured_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) active_session_id: Option<String>,
    #[serde(default)]
    pub(super) sessions: Vec<FleetShellSession>,
    #[serde(default)]
    pub(super) workspaces: Vec<FleetShellWorkspace>,
    #[serde(default)]
    pub(super) visible_messages: Vec<FleetShellMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) composer: Option<FleetShellComposer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) runtime: Option<FleetShellRuntime>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) scheduler: Option<FleetShellScheduler>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) ralph: Option<FleetShellRalph>,
    #[serde(default)]
    pub(super) context_packs: Vec<FleetShellContextPack>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) instructions: Option<FleetShellInstructions>,
    #[serde(default)]
    pub(super) prompt_history: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) voice: Option<FleetShellVoice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) quick_task: Option<FleetShellQuickTask>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) media: Option<FleetShellMedia>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellSession {
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
pub(super) struct FleetShellWorkspace {
    pub(super) root: String,
    pub(super) label: String,
    pub(super) session_count: usize,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellMessage {
    pub(super) id: String,
    pub(super) role: String,
    pub(super) content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) created_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) task_action: Option<FleetShellTaskAction>,
    pub(super) presentation: String,
    pub(super) attachments: Vec<FleetShellAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) source: Option<FleetShellMessageSource>,
    pub(super) actions: FleetShellMessageActions,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellMessageSource {
    pub(super) kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mode: Option<String>,
    pub(super) entries: Vec<FleetShellTraceEntry>,
    pub(super) timeline: Vec<FleetShellTraceEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellTraceEntry {
    pub(super) label: String,
    pub(super) detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) tone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) timestamp: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellMessageActions {
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
pub(super) enum FleetShellAttachment {
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
pub(super) struct FleetShellComposer {
    pub(super) session_id: String,
    pub(super) draft: String,
    pub(super) provider: String,
    pub(super) provider_label: String,
    pub(super) model: String,
    pub(super) model_label: String,
    pub(super) model_catalog_loading: bool,
    pub(super) model_catalog: Vec<FleetShellModelProvider>,
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
    pub(super) attachments: Vec<FleetShellAttachment>,
    pub(super) chooser_providers: Vec<String>,
    pub(super) matched_context_pack_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellModelProvider {
    pub(super) provider: String,
    pub(super) label: String,
    pub(super) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    pub(super) models: Vec<FleetShellModel>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellModel {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) reasoning_options: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellRuntime {
    pub(super) loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    pub(super) has_any_provider: bool,
    pub(super) provider_statuses: Vec<FleetShellProviderStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reasoning: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) ui_control: Option<FleetShellRuntimeCapability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) web_search: Option<FleetShellRuntimeCapability>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellProviderStatus {
    pub(super) provider: String,
    pub(super) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellRuntimeCapability {
    pub(super) available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellScheduler {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace_root: Option<String>,
    pub(super) loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    pub(super) jobs: Vec<FleetShellSchedulerJob>,
    pub(super) runs: Vec<FleetShellSchedulerRun>,
    pub(super) updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellSchedulerJob {
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
pub(super) struct FleetShellSchedulerRun {
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
pub(super) struct FleetShellRalph {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) workspace_root: Option<String>,
    pub(super) loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    pub(super) flows: Vec<FleetShellRalphFlow>,
    pub(super) runs: Vec<FleetShellRalphRun>,
    pub(super) updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellRalphFlow {
    pub(super) id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) alias: Option<String>,
    pub(super) name: String,
    pub(super) scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) description: Option<String>,
    pub(super) block_count: usize,
    pub(super) edge_count: usize,
    pub(super) variables: Vec<FleetShellRalphVariable>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) max_transitions: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellRalphVariable {
    pub(super) name: String,
    #[serde(rename = "type")]
    pub(super) variable_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) default: Option<String>,
    pub(super) required: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellRalphRun {
    pub(super) id: String,
    pub(super) flow_id: String,
    pub(super) flow_name: String,
    pub(super) scope: String,
    pub(super) status: String,
    pub(super) summary: String,
    pub(super) created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) finished_at: Option<u64>,
    pub(super) block_count: usize,
    pub(super) event_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) task_id: Option<String>,
    pub(super) cancellable: bool,
    pub(super) recoverable: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellContextPack {
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
pub(super) struct FleetShellInstructions {
    pub(super) loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    pub(super) profiles: Vec<FleetShellInstructionProfile>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellInstructionProfile {
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
pub(super) struct FleetShellTaskAction {
    pub(super) kind: FleetShellTaskActionKind,
    pub(super) objective: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum FleetShellTaskActionKind {
    RetryTask,
    ContinueTask,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellVoice {
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
pub(super) struct FleetShellQuickTask {
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
pub(super) struct FleetShellMedia {
    pub(super) loading: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) runtime_mode: Option<String>,
    pub(super) generation: FleetShellMediaGeneration,
    pub(super) models: Vec<FleetShellMediaModel>,
    pub(super) assets: Vec<FleetShellMediaAsset>,
    pub(super) asset_count: usize,
    pub(super) runs: Vec<FleetShellMediaRun>,
    pub(super) run_count: usize,
    pub(super) busy: bool,
    pub(super) updated_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FleetShellMediaGeneration {
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
pub(super) struct FleetShellMediaModel {
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
pub(super) struct FleetShellMediaAsset {
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
pub(super) struct FleetShellMediaRun {
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
