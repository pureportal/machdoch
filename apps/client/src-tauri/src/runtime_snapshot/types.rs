use serde::Serialize;

use crate::ui_control::UiControlAvailability;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub(super) workspace_root: String,
    pub(super) workspace_config_path: Option<String>,
    pub(super) default_mode: String,
    pub(super) default_reasoning: String,
    pub(super) mode: String,
    pub(super) provider: String,
    pub(super) model: String,
    pub(super) reasoning: String,
    pub(super) offline: bool,
    pub(super) agent_limits: RuntimeAgentLimits,
    pub(super) compatibility: RuntimeCompatibilityConfig,
    pub(super) provider_availability: Vec<ProviderAvailability>,
    pub(super) web_search: RuntimeWebSearchConfig,
    pub(super) review_model: RuntimeReviewModelConfig,
    pub(super) ui_control: UiControlAvailability,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCompatibilityConfig {
    pub(super) discover_github_customizations: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAgentLimits {
    pub(super) executor_turns: Option<u32>,
    pub(super) autopilot_executor_iterations: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderAvailability {
    pub(super) provider: String,
    pub(super) configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCatalogSnapshot {
    pub(super) generated_at: u64,
    pub(super) providers: Vec<ProviderModelCatalogProvider>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelCatalogProvider {
    pub(super) provider: String,
    pub(super) source: String,
    pub(super) available: bool,
    pub(super) error: Option<String>,
    pub(super) models: Vec<ProviderRuntimeModel>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeModel {
    pub(super) id: String,
    pub(super) label: Option<String>,
    pub(super) stage: Option<String>,
    pub(super) release_date: Option<String>,
    pub(super) recommended_for: Vec<String>,
    pub(super) capabilities: ProviderRuntimeModelCapabilities,
    pub(super) warnings: Vec<String>,
    pub(super) source: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRuntimeModelCapabilities {
    pub(super) image_input: Option<bool>,
    pub(super) tool_use: Option<bool>,
    pub(super) reasoning: Option<bool>,
    pub(super) streaming: Option<bool>,
    pub(super) context_window_tokens: Option<u64>,
    pub(super) max_output_tokens: Option<u64>,
    pub(super) voice: Option<bool>,
    pub(super) computer_use: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchProviderAvailability {
    pub(super) provider: String,
    pub(super) configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProviderAvailability {
    pub(super) provider: String,
    pub(super) configured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeWebSearchConfig {
    pub(super) active_provider: String,
    pub(super) provider_availability: Vec<WebSearchProviderAvailability>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReviewModelConfig {
    pub(super) mode: String,
    pub(super) provider: Option<String>,
    pub(super) model: Option<String>,
}
