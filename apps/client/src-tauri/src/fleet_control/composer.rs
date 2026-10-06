use serde::{Deserialize, Serialize};

use super::shell::FleetShellAttachment;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FleetPromptHistoryEntry {
    pub(super) index: u32,
    pub(super) prompt: String,
    pub(super) attachments: Vec<FleetShellAttachment>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FleetQueuedMessage {
    pub(super) id: String,
    pub(super) content: String,
    pub(super) attachments: Vec<FleetShellAttachment>,
    pub(super) status: String,
    pub(super) created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) iteration: Option<FleetRequestIteration>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) waiting_for_iteration: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) prompt_enhancement_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(super) failure_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FleetRequestIteration {
    pub(super) group_id: String,
    pub(super) index: u32,
    pub(super) total: u32,
    pub(super) mode: String,
}
