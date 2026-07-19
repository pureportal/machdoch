use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const PROTOCOL_MAJOR: u16 = 1;
pub(crate) const PROTOCOL_MINOR: u16 = 0;
pub(crate) const CATEGORY_SCHEMA_VERSION: u16 = 1;
pub(crate) const SETTINGS_TRANSFER_EVENT: &str = "machdoch://settings-transfer-state";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SettingsCategoryId {
    #[serde(rename = "credentials.api-keys")]
    ApiKeys,
    #[serde(rename = "preferences.agent-provider")]
    AgentProviderPreferences,
    #[serde(rename = "preferences.desktop-appearance")]
    DesktopAppearance,
    #[serde(rename = "memory.global")]
    GlobalMemory,
    #[serde(rename = "customizations.instructions-global")]
    GlobalInstructions,
    #[serde(rename = "customizations.prompts-global")]
    GlobalPrompts,
    #[serde(rename = "mcp.global")]
    GlobalMcp,
    #[serde(rename = "ralph.flows-global")]
    GlobalRalphFlows,
}

impl SettingsCategoryId {
    pub(crate) const ALL: [Self; 8] = [
        Self::ApiKeys,
        Self::AgentProviderPreferences,
        Self::DesktopAppearance,
        Self::GlobalMemory,
        Self::GlobalInstructions,
        Self::GlobalPrompts,
        Self::GlobalMcp,
        Self::GlobalRalphFlows,
    ];

    pub(crate) const fn metadata(self) -> CategoryMetadata {
        match self {
            Self::ApiKeys => CategoryMetadata {
                label: "API Keys",
                description: "Persisted provider and web-search credentials.",
                warning: Some("Sensitive values are encrypted in transit and are never shown."),
                default_selected: false,
                sensitive: true,
            },
            Self::AgentProviderPreferences => CategoryMetadata {
                label: "Agent & Provider Preferences",
                description: "Portable provider, voice, speech, review-model, and agent-limit preferences.",
                warning: None,
                default_selected: true,
                sensitive: false,
            },
            Self::DesktopAppearance => CategoryMetadata {
                label: "Desktop & Appearance",
                description: "Theme and portable desktop behavior; device shortcuts and autostart stay local.",
                warning: None,
                default_selected: true,
                sensitive: false,
            },
            Self::GlobalMemory => CategoryMetadata {
                label: "Global Memory",
                description: "The complete global memory collection and its enabled state.",
                warning: Some("May contain personal or confidential information."),
                default_selected: false,
                sensitive: true,
            },
            Self::GlobalInstructions => CategoryMetadata {
                label: "Instruction Files",
                description: "Global instructions.md and conditional instruction documents.",
                warning: Some("Instruction text may contain private operational details."),
                default_selected: true,
                sensitive: true,
            },
            Self::GlobalPrompts => CategoryMetadata {
                label: "Global Prompts",
                description: "All user-level .prompt.md documents.",
                warning: Some("Prompt text may contain private information."),
                default_selected: true,
                sensitive: true,
            },
            Self::GlobalMcp => CategoryMetadata {
                label: "MCP Servers & Registries",
                description: "Global MCP configuration and marketplace registry sources.",
                warning: Some("MCP configuration can contain credentials, commands, URLs, and local paths."),
                default_selected: true,
                sensitive: true,
            },
            Self::GlobalRalphFlows => CategoryMetadata {
                label: "Global RALPH Flows",
                description: "Current global flow definitions and their instruction files.",
                warning: Some("Flows can contain commands, literal secrets, and machine-specific paths."),
                default_selected: true,
                sensitive: true,
            },
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CategoryMetadata {
    pub(crate) label: &'static str,
    pub(crate) description: &'static str,
    pub(crate) warning: Option<&'static str>,
    pub(crate) default_selected: bool,
    pub(crate) sensitive: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TransferMode {
    Send,
    Receive,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TransferPhase {
    Idle,
    Inspecting,
    Advertising,
    Discovering,
    Connecting,
    Pairing,
    Review,
    Transferring,
    Validating,
    Committing,
    RollingBack,
    Completed,
    Cancelled,
    Failed,
}

impl TransferPhase {
    pub(crate) fn is_active(&self) -> bool {
        !matches!(
            self,
            Self::Idle | Self::Completed | Self::Cancelled | Self::Failed
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CategoryAvailabilityState {
    Available,
    Empty,
    Unavailable,
    Unsupported,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CategoryEffect {
    Replace,
    Clear,
    PreserveNotSelected,
    PreserveNotOffered,
    PreserveUnavailable,
    PreserveIncompatible,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CategoryStatus {
    pub(crate) id: SettingsCategoryId,
    pub(crate) label: String,
    pub(crate) description: String,
    pub(crate) warning: Option<String>,
    pub(crate) default_selected: bool,
    pub(crate) sensitive: bool,
    pub(crate) selected: bool,
    pub(crate) availability: CategoryAvailabilityState,
    pub(crate) effect: Option<CategoryEffect>,
    pub(crate) item_count: u32,
    pub(crate) byte_count: u64,
    pub(crate) transferred_bytes: u64,
    pub(crate) transfer_total_bytes: u64,
    pub(crate) current_item_count: Option<u32>,
    pub(crate) reason: Option<String>,
}

impl CategoryStatus {
    pub(crate) fn catalog(id: SettingsCategoryId) -> Self {
        let metadata = id.metadata();
        Self {
            id,
            label: metadata.label.to_string(),
            description: metadata.description.to_string(),
            warning: metadata.warning.map(str::to_string),
            default_selected: metadata.default_selected,
            sensitive: metadata.sensitive,
            selected: false,
            availability: CategoryAvailabilityState::Available,
            effect: None,
            item_count: 0,
            byte_count: 0,
            transferred_bytes: 0,
            transfer_total_bytes: 0,
            current_item_count: None,
            reason: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveredTransferSession {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) protocol_version: u16,
    pub(crate) expires_at: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TransferNetworkInterface {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) addresses: Vec<String>,
    pub(crate) selected: bool,
    pub(crate) recommended: bool,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsTransferStatus {
    pub(crate) mode: Option<TransferMode>,
    pub(crate) phase: TransferPhase,
    pub(crate) session_label: Option<String>,
    pub(crate) peer_name: Option<String>,
    pub(crate) peer_categories: Vec<SettingsCategoryId>,
    pub(crate) effective_categories: Vec<SettingsCategoryId>,
    pub(crate) pairing_code: Option<String>,
    pub(crate) created_at: Option<u64>,
    pub(crate) expires_at: Option<u64>,
    pub(crate) categories: Vec<CategoryStatus>,
    pub(crate) network_interfaces: Vec<TransferNetworkInterface>,
    pub(crate) discovered_sessions: Vec<DiscoveredTransferSession>,
    pub(crate) manual_code: Option<String>,
    pub(crate) qr_svg: Option<String>,
    pub(crate) transferred_bytes: u64,
    pub(crate) total_bytes: u64,
    pub(crate) message: Option<String>,
    pub(crate) error_code: Option<String>,
    pub(crate) completed_locally: bool,
}

impl Default for SettingsTransferStatus {
    fn default() -> Self {
        Self {
            mode: None,
            phase: TransferPhase::Idle,
            session_label: None,
            peer_name: None,
            peer_categories: Vec::new(),
            effective_categories: Vec::new(),
            pairing_code: None,
            created_at: None,
            expires_at: None,
            categories: SettingsCategoryId::ALL
                .into_iter()
                .map(CategoryStatus::catalog)
                .collect(),
            network_interfaces: Vec::new(),
            discovered_sessions: Vec::new(),
            manual_code: None,
            qr_svg: None,
            transferred_bytes: 0,
            total_bytes: 0,
            message: None,
            error_code: None,
            completed_locally: false,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartSettingsTransferRequest {
    pub(crate) categories: BTreeSet<SettingsCategoryId>,
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) interface_ids: BTreeSet<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StartSettingsReceiveRequest {
    pub(crate) categories: BTreeSet<SettingsCategoryId>,
    pub(crate) display_name: String,
    #[serde(default)]
    pub(crate) interface_ids: BTreeSet<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectSettingsTransferRequest {
    pub(crate) discovered_id: Option<String>,
    pub(crate) manual_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FileSnapshotEntry {
    pub(crate) relative_path: String,
    pub(crate) utf8_content: String,
    pub(crate) sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum CategorySnapshotData {
    Json(Value),
    Files(Vec<FileSnapshotEntry>),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CategorySnapshot {
    pub(crate) id: SettingsCategoryId,
    pub(crate) schema_version: u16,
    pub(crate) replacement: String,
    pub(crate) item_count: u32,
    pub(crate) plaintext_bytes: u64,
    pub(crate) sha256: String,
    pub(crate) data: CategorySnapshotData,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SnapshotAvailability {
    Available(CategorySnapshot),
    Unavailable(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OfferedCategory {
    pub(crate) id: SettingsCategoryId,
    pub(crate) schema_version: u16,
    pub(crate) availability: CategoryAvailabilityState,
    pub(crate) item_count: u32,
    pub(crate) plaintext_bytes: u64,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SenderHello {
    pub(crate) display_name: String,
    pub(crate) session_label: String,
    pub(crate) offered: Vec<OfferedCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReceiverHello {
    pub(crate) display_name: String,
    pub(crate) wanted: BTreeSet<SettingsCategoryId>,
    pub(crate) supported: BTreeMap<SettingsCategoryId, Vec<u16>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManifestEntry {
    pub(crate) id: SettingsCategoryId,
    pub(crate) schema_version: u16,
    pub(crate) replacement: String,
    pub(crate) item_count: u32,
    pub(crate) plaintext_bytes: u64,
    pub(crate) sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferManifest {
    pub(crate) effective: BTreeSet<SettingsCategoryId>,
    pub(crate) effective_hash: String,
    pub(crate) entries: Vec<ManifestEntry>,
    pub(crate) total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewCategory {
    pub(crate) id: SettingsCategoryId,
    pub(crate) effect: CategoryEffect,
    pub(crate) incoming_item_count: u32,
    pub(crate) incoming_bytes: u64,
    pub(crate) current_item_count: u32,
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferReview {
    pub(crate) effective_hash: String,
    pub(crate) categories: Vec<ReviewCategory>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PayloadCategoryRange {
    pub(crate) id: SettingsCategoryId,
    pub(crate) start: u64,
    pub(crate) end: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferEnvelope {
    pub(crate) protocol_version: u16,
    pub(crate) transfer_id: String,
    pub(crate) created_at: u64,
    pub(crate) expires_at: u64,
    pub(crate) categories: Vec<CategorySnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManualEndpoint {
    pub(crate) ip: String,
    pub(crate) port: u16,
    pub(crate) scope_id: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ManualRendezvous {
    pub(crate) protocol_version: u16,
    pub(crate) session_label: String,
    pub(crate) sid: String,
    pub(crate) endpoints: Vec<ManualEndpoint>,
    pub(crate) expires_at: u64,
}
