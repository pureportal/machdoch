use std::collections::{BTreeMap, BTreeSet};

use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::{error::Error, fmt};

pub const GATEWAY_PROTOCOL_VERSION: u32 = 4;
pub const PRODUCT_CAPABILITY: &str = "product.v4";
pub const PRODUCT_SNAPSHOT_VERSION: u32 = 5;
pub const MAX_GATEWAY_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_MANAGED_SETTINGS_DELIVERY_BYTES: usize = 18 * 1024 * 1024;
pub const MANAGED_SETTINGS_SCHEMA_VERSION: u8 = 2;
pub const MAX_MANAGED_SETTINGS_COLLECTION_ENTRIES: usize = 128;
pub const MAX_MANAGED_SETTINGS_SECRETS: usize = 128;
pub const MAX_MANAGED_SETTINGS_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedSettingsValidationError(String);

impl fmt::Display for ManagedSettingsValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Error for ManagedSettingsValidationError {}

#[derive(Debug)]
pub enum GatewayPayloadBudgetError {
    Serialization(serde_json::Error),
    Exceeded,
}

impl fmt::Display for GatewayPayloadBudgetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialization(_) => formatter.write_str("Failed to encode gateway message."),
            Self::Exceeded => {
                formatter.write_str("Gateway message exceeds the 4 MiB payload budget.")
            }
        }
    }
}

impl Error for GatewayPayloadBudgetError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Serialization(error) => Some(error),
            Self::Exceeded => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedSettingsDelivery {
    pub schema_version: u8,
    pub manager_id: String,
    pub profile: Option<FleetManagedSettingsProfile>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawFleetManagedSettingsDelivery {
    schema_version: u8,
    manager_id: String,
    profile: Option<FleetManagedSettingsProfile>,
}

impl<'de> Deserialize<'de> for FleetManagedSettingsDelivery {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawFleetManagedSettingsDelivery::deserialize(deserializer)?;
        let delivery = Self {
            schema_version: raw.schema_version,
            manager_id: raw.manager_id,
            profile: raw.profile,
        };
        delivery.validate().map_err(D::Error::custom)?;
        Ok(delivery)
    }
}

impl FleetManagedSettingsDelivery {
    pub fn validate(&self) -> Result<(), ManagedSettingsValidationError> {
        if self.schema_version != MANAGED_SETTINGS_SCHEMA_VERSION {
            return Err(managed_settings_error(
                "Managed settings schema version is invalid.",
            ));
        }
        if !valid_managed_identifier(&self.manager_id, "manager") {
            return Err(managed_settings_error(
                "Managed settings manager id is invalid.",
            ));
        }
        if let Some(profile) = &self.profile {
            validate_managed_profile(profile)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedSettingsProfile {
    pub profile_id: String,
    pub name: String,
    pub revision: u64,
    pub document: FleetManagedSettingsDocument,
    pub secrets: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedSettingsDocument {
    pub defaults: FleetManagedDefaults,
    pub agent_limits: FleetManagedAgentLimits,
    pub instructions: Vec<FleetManagedInstruction>,
    pub context_packs: Vec<FleetManagedContextPack>,
    pub prompts: Vec<FleetManagedPrompt>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedDefaults {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub reasoning: Option<String>,
    pub web_search_provider: Option<String>,
    pub theme: Option<String>,
    pub density: Option<String>,
    pub accent: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedAgentLimits {
    pub infinite: Option<bool>,
    pub executor_turns: Option<u32>,
    pub autopilot_executor_iterations: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedInstruction {
    pub id: String,
    pub name: String,
    pub body: String,
    pub enabled: bool,
    pub global: bool,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedContextPackVariable {
    pub name: String,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedContextPack {
    pub id: String,
    pub name: String,
    pub instructions: String,
    pub prompt: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub reasoning: Option<String>,
    pub variables: Vec<FleetManagedContextPackVariable>,
    pub trigger_phrases: Vec<String>,
    pub path_patterns: Vec<String>,
    pub prompt_enhancement_mode: Option<String>,
    pub interview_enabled: Option<bool>,
    pub session_memory_enabled: Option<bool>,
    pub use_global_memory: Option<bool>,
    pub ui_control_enabled: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FleetManagedPrompt {
    pub id: String,
    pub relative_path: String,
    pub content: String,
}

fn managed_settings_error(message: &str) -> ManagedSettingsValidationError {
    ManagedSettingsValidationError(message.to_string())
}

fn valid_managed_identifier(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .and_then(|value| value.strip_prefix('_'))
        .is_some_and(|value| {
            value.len() == 24
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
}

fn valid_managed_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().copied().enumerate().all(|(index, byte)| {
            matches!(index, 8 | 13 | 18 | 23)
                .then_some(byte == b'-')
                .unwrap_or_else(|| byte.is_ascii_hexdigit())
        })
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B')
}

fn valid_managed_text(value: &str, maximum: usize, required: bool) -> bool {
    (!required || !value.is_empty())
        && value.encode_utf16().count() <= maximum
        && !value.contains('\0')
}

fn valid_managed_name(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.encode_utf16().count() <= maximum
        && !value.chars().any(char::is_control)
}

fn valid_managed_list_value(value: &str, maximum: usize) -> bool {
    valid_managed_name(value, maximum)
}

fn valid_managed_optional_text(value: Option<&str>) -> bool {
    value.is_none_or(|value| valid_managed_name(value, 200))
}

fn valid_managed_provider(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        matches!(
            value,
            "openai"
                | "anthropic"
                | "google"
                | "langdock"
                | "codex-cli"
                | "claude-cli"
                | "copilot-cli"
        )
    })
}

fn valid_managed_mode(value: Option<&str>) -> bool {
    value.is_none_or(|value| matches!(value, "ask" | "machdoch"))
}

fn valid_managed_reasoning(value: Option<&str>) -> bool {
    value.is_none_or(|value| {
        matches!(
            value,
            "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        )
    })
}

fn validate_managed_profile(
    profile: &FleetManagedSettingsProfile,
) -> Result<(), ManagedSettingsValidationError> {
    if !valid_managed_identifier(&profile.profile_id, "profile") {
        return Err(managed_settings_error(
            "Managed settings profile id is invalid.",
        ));
    }
    if !valid_managed_name(&profile.name, 120) {
        return Err(managed_settings_error(
            "Managed settings profile name is invalid.",
        ));
    }
    if profile.revision == 0 || profile.revision > MAX_MANAGED_SETTINGS_REVISION {
        return Err(managed_settings_error(
            "Managed settings profile revision is invalid.",
        ));
    }
    if profile.secrets.len() > MAX_MANAGED_SETTINGS_SECRETS
        || profile.secrets.iter().any(|(id, value)| {
            !valid_managed_secret_id(id) || !valid_managed_text(value, 8_192, true)
        })
    {
        return Err(managed_settings_error(
            "Managed settings secrets are invalid.",
        ));
    }
    validate_managed_document(&profile.document)
}

fn valid_managed_secret_id(value: &str) -> bool {
    let mut characters = value.bytes();
    matches!(characters.next(), Some(byte) if byte.is_ascii_lowercase())
        && value.len() <= 64
        && characters.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
}

fn validate_managed_document(
    document: &FleetManagedSettingsDocument,
) -> Result<(), ManagedSettingsValidationError> {
    validate_managed_defaults(&document.defaults)?;
    if document
        .agent_limits
        .executor_turns
        .is_some_and(|value| value == 0 || value > 100_000)
        || document
            .agent_limits
            .autopilot_executor_iterations
            .is_some_and(|value| value == 0 || value > 100_000)
    {
        return Err(managed_settings_error(
            "Managed settings agent limits are invalid.",
        ));
    }
    if document.instructions.len() > MAX_MANAGED_SETTINGS_COLLECTION_ENTRIES
        || document.context_packs.len() > MAX_MANAGED_SETTINGS_COLLECTION_ENTRIES
        || document.prompts.len() > MAX_MANAGED_SETTINGS_COLLECTION_ENTRIES
    {
        return Err(managed_settings_error(
            "Managed settings collection exceeds its limit.",
        ));
    }
    validate_managed_instructions(&document.instructions)?;
    validate_managed_context_packs(&document.context_packs)?;
    validate_managed_prompts(&document.prompts)
}

fn validate_managed_defaults(
    defaults: &FleetManagedDefaults,
) -> Result<(), ManagedSettingsValidationError> {
    if !valid_managed_provider(defaults.provider.as_deref())
        || !valid_managed_optional_text(defaults.model.as_deref())
        || !valid_managed_mode(defaults.mode.as_deref())
        || !valid_managed_reasoning(defaults.reasoning.as_deref())
        || !defaults
            .web_search_provider
            .as_deref()
            .is_none_or(|value| matches!(value, "none" | "perplexity" | "tavily" | "serper"))
        || !defaults
            .theme
            .as_deref()
            .is_none_or(|value| matches!(value, "dark" | "light"))
        || !defaults
            .density
            .as_deref()
            .is_none_or(|value| matches!(value, "comfortable" | "compact"))
        || !defaults
            .accent
            .as_deref()
            .is_none_or(|value| matches!(value, "sky" | "emerald" | "violet" | "amber"))
        || (defaults.model.is_some() && defaults.provider.is_none())
    {
        return Err(managed_settings_error(
            "Managed settings defaults are invalid.",
        ));
    }
    Ok(())
}

fn validate_managed_instructions(
    instructions: &[FleetManagedInstruction],
) -> Result<(), ManagedSettingsValidationError> {
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    for instruction in instructions {
        if !valid_managed_uuid(&instruction.id)
            || !valid_managed_name(&instruction.name, 200)
            || !valid_managed_text(&instruction.body, 128 * 1024, true)
            || instruction.tags.len() > 64
            || instruction
                .tags
                .iter()
                .any(|tag| !valid_managed_list_value(tag, 80) || tag.contains(','))
            || !unique_normalized_values(&instruction.tags)
            || !ids.insert(instruction.id.clone())
            || !names.insert(instruction.name.to_lowercase())
        {
            return Err(managed_settings_error(
                "Managed settings instructions are invalid.",
            ));
        }
    }
    Ok(())
}

fn validate_managed_context_packs(
    context_packs: &[FleetManagedContextPack],
) -> Result<(), ManagedSettingsValidationError> {
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    for pack in context_packs {
        if !valid_managed_uuid(&pack.id)
            || !valid_managed_name(&pack.name, 200)
            || !valid_managed_text(&pack.instructions, 128 * 1024, false)
            || !valid_managed_text(&pack.prompt, 128 * 1024, false)
            || !valid_managed_provider(pack.provider.as_deref())
            || !valid_managed_optional_text(pack.model.as_deref())
            || !valid_managed_mode(pack.mode.as_deref())
            || !valid_managed_reasoning(pack.reasoning.as_deref())
            || (pack.provider.is_some() != pack.model.is_some())
            || (pack.instructions.is_empty() && pack.prompt.is_empty())
            || pack.variables.len() > 64
            || pack.trigger_phrases.len() > 64
            || pack.path_patterns.len() > 64
            || pack
                .trigger_phrases
                .iter()
                .chain(&pack.path_patterns)
                .any(|value| !valid_managed_list_value(value, 500))
            || !valid_managed_prompt_enhancement_mode(pack.prompt_enhancement_mode.as_deref())
            || !valid_managed_variables(&pack.variables)
            || !ids.insert(pack.id.clone())
            || !names.insert(pack.name.to_lowercase())
        {
            return Err(managed_settings_error(
                "Managed settings context packs are invalid.",
            ));
        }
    }
    Ok(())
}

fn valid_managed_prompt_enhancement_mode(value: Option<&str>) -> bool {
    value.is_none_or(|value| matches!(value, "off" | "simple" | "web-search"))
}

fn valid_managed_variables(values: &[FleetManagedContextPackVariable]) -> bool {
    let mut names = BTreeSet::new();
    values.iter().all(|variable| {
        valid_managed_variable_name(&variable.name)
            && variable
                .default_value
                .as_deref()
                .is_none_or(|value| valid_managed_text(value, 8_000, false))
            && names.insert(variable.name.clone())
    })
}

fn valid_managed_variable_name(value: &str) -> bool {
    let mut characters = value.bytes();
    matches!(characters.next(), Some(byte) if byte.is_ascii_alphabetic() || byte == b'_')
        && value.len() <= 80
        && characters.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn validate_managed_prompts(
    prompts: &[FleetManagedPrompt],
) -> Result<(), ManagedSettingsValidationError> {
    let mut ids = BTreeSet::new();
    let mut paths = BTreeSet::new();
    for prompt in prompts {
        if !valid_managed_uuid(&prompt.id)
            || !valid_managed_prompt_path(&prompt.relative_path)
            || !valid_managed_text(&prompt.content, 128 * 1024, true)
            || !ids.insert(prompt.id.clone())
            || !paths.insert(prompt.relative_path.to_lowercase())
        {
            return Err(managed_settings_error(
                "Managed settings prompts are invalid.",
            ));
        }
    }
    Ok(())
}

fn valid_managed_prompt_path(value: &str) -> bool {
    if value.is_empty()
        || value != value.trim()
        || value.len() > 1_000
        || value.contains('\\')
        || value.starts_with('/')
        || !value.ends_with(".prompt.md")
    {
        return false;
    }
    let components = value.split('/').collect::<Vec<_>>();
    components.len() <= 16
        && components.iter().all(|component| {
            *component != "."
                && *component != ".."
                && !component.is_empty()
                && component.len() <= 120
                && component.bytes().enumerate().all(|(index, byte)| {
                    (index == 0 && byte.is_ascii_alphanumeric())
                        || (index > 0
                            && (byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
                })
        })
}

fn unique_normalized_values(values: &[String]) -> bool {
    let mut normalized_values = BTreeSet::new();
    values
        .iter()
        .all(|value| normalized_values.insert(value.to_lowercase()))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FleetManagedSettingsSyncReport {
    Applied {
        manager_id: String,
        profile_id: Option<String>,
        revision: Option<u64>,
    },
    Failed {
        manager_id: String,
        profile_id: Option<String>,
        revision: Option<u64>,
        error: String,
    },
}

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

pub fn serialize_host_message(message: &HostMessage) -> Result<String, GatewayPayloadBudgetError> {
    let payload =
        serde_json::to_string(message).map_err(GatewayPayloadBudgetError::Serialization)?;
    if payload.len() > MAX_GATEWAY_MESSAGE_BYTES {
        return Err(GatewayPayloadBudgetError::Exceeded);
    }
    Ok(payload)
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

#[derive(Debug, Clone, Serialize, PartialEq)]
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
    pub memory_id: Option<String>,
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
    pub flow_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_transitions: Option<u32>,
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
    ForgetSessionMemory,
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
    RalphRun,
    RalphResumeRun,
    GenerateMedia,
    CancelMediaRun,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProductCommand {
    kind: ProductCommandKind,
    #[serde(default)]
    command_id: Option<String>,
    #[serde(default)]
    task_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    prompt_enhancement_mode: Option<String>,
    #[serde(default)]
    interview_enabled: Option<bool>,
    #[serde(default)]
    workspace: Option<String>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    memory_id: Option<String>,
    #[serde(default)]
    attachment_id: Option<String>,
    #[serde(default)]
    context_pack_id: Option<String>,
    #[serde(default)]
    message_id: Option<String>,
    #[serde(default)]
    job_id: Option<String>,
    #[serde(default)]
    run_id: Option<String>,
    #[serde(default)]
    flow_id: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    parameters: Option<BTreeMap<String, String>>,
    #[serde(default)]
    max_transitions: Option<u32>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    aspect_ratio: Option<String>,
    #[serde(default)]
    output_count: Option<u32>,
    #[serde(default)]
    output_format: Option<String>,
    #[serde(default)]
    transparent_background: Option<bool>,
}

impl<'de> Deserialize<'de> for ProductCommand {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let raw = RawProductCommand::deserialize(deserializer)?;
        let command = Self {
            kind: raw.kind,
            command_id: raw.command_id,
            task_id: raw.task_id,
            session_id: raw.session_id,
            prompt: raw.prompt,
            title: raw.title,
            tags: raw.tags,
            provider: raw.provider,
            model: raw.model,
            model_id: raw.model_id,
            mode: raw.mode,
            reasoning: raw.reasoning,
            prompt_enhancement_mode: raw.prompt_enhancement_mode,
            interview_enabled: raw.interview_enabled,
            workspace: raw.workspace,
            enabled: raw.enabled,
            memory_id: raw.memory_id,
            attachment_id: raw.attachment_id,
            context_pack_id: raw.context_pack_id,
            message_id: raw.message_id,
            job_id: raw.job_id,
            run_id: raw.run_id,
            flow_id: raw.flow_id,
            scope: raw.scope,
            parameters: raw.parameters,
            max_transitions: raw.max_transitions,
            target: raw.target,
            aspect_ratio: raw.aspect_ratio,
            output_count: raw.output_count,
            output_format: raw.output_format,
            transparent_background: raw.transparent_background,
        };
        command.validate().map_err(D::Error::custom)?;
        Ok(command)
    }
}

impl ProductCommand {
    fn validate(&self) -> Result<(), String> {
        let mut required = Vec::new();

        match self.kind {
            ProductCommandKind::Cancel
            | ProductCommandKind::Retry
            | ProductCommandKind::Continue
            | ProductCommandKind::CancelPromptEnhancement => {
                required.push(("taskId", self.task_id.is_some()))
            }
            ProductCommandKind::SubmitMessage => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("prompt", self.prompt.is_some()),
                (
                    "promptEnhancementMode",
                    self.prompt_enhancement_mode.is_some(),
                ),
                ("interviewEnabled", self.interview_enabled.is_some()),
            ]),
            ProductCommandKind::CreateSession | ProductCommandKind::StopSpeaking => {}
            ProductCommandKind::ActivateSession
            | ProductCommandKind::ArchiveSession
            | ProductCommandKind::PinSession
            | ProductCommandKind::DuplicateSession
            | ProductCommandKind::BranchSession
            | ProductCommandKind::DeleteSession
            | ProductCommandKind::ClearSessionHistory
            | ProductCommandKind::ClearSessionMode
            | ProductCommandKind::ClearSessionReasoning
            | ProductCommandKind::ClearAttachments
            | ProductCommandKind::ClearSessionWorkspace => {
                required.push(("sessionId", self.session_id.is_some()))
            }
            ProductCommandKind::RenameSession => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("title", self.title.is_some()),
            ]),
            ProductCommandKind::TagSession => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("tags", self.tags.is_some()),
            ]),
            ProductCommandKind::UpdateDraft => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("prompt", self.prompt.is_some()),
            ]),
            ProductCommandKind::SetSessionModel => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("provider", self.provider.is_some()),
                ("model", self.model.is_some()),
            ]),
            ProductCommandKind::SetSessionMode => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("mode", self.mode.is_some()),
            ]),
            ProductCommandKind::SetSessionReasoning => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("reasoning", self.reasoning.is_some()),
            ]),
            ProductCommandKind::SetSessionWorkspace => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("workspace", self.workspace.is_some()),
            ]),
            ProductCommandKind::SetPromptEnhancementMode => required.extend([
                ("sessionId", self.session_id.is_some()),
                (
                    "promptEnhancementMode",
                    self.prompt_enhancement_mode.is_some(),
                ),
            ]),
            ProductCommandKind::SetInterview
            | ProductCommandKind::SetSessionMemory
            | ProductCommandKind::SetGlobalMemory
            | ProductCommandKind::SetUiControl => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("enabled", self.enabled.is_some()),
            ]),
            ProductCommandKind::ForgetSessionMemory => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("memoryId", self.memory_id.is_some()),
            ]),
            ProductCommandKind::RemoveAttachment => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("attachmentId", self.attachment_id.is_some()),
            ]),
            ProductCommandKind::ApplyContextPack => required.extend([
                ("sessionId", self.session_id.is_some()),
                ("contextPackId", self.context_pack_id.is_some()),
            ]),
            ProductCommandKind::DeleteContextPack => {
                required.push(("contextPackId", self.context_pack_id.is_some()));
            }
            ProductCommandKind::SaveMessageContextPack | ProductCommandKind::SpeakMessage => {
                required.extend([
                    ("sessionId", self.session_id.is_some()),
                    ("messageId", self.message_id.is_some()),
                ])
            }
            ProductCommandKind::SchedulerTrigger
            | ProductCommandKind::SchedulerPause
            | ProductCommandKind::SchedulerResume
            | ProductCommandKind::SchedulerDelete => required.extend([
                ("workspace", self.workspace.is_some()),
                ("jobId", self.job_id.is_some()),
            ]),
            ProductCommandKind::SchedulerRetryRun | ProductCommandKind::SchedulerCancelRun => {
                required.extend([
                    ("workspace", self.workspace.is_some()),
                    ("runId", self.run_id.is_some()),
                ])
            }
            ProductCommandKind::RalphRun => required.extend([
                ("workspace", self.workspace.is_some()),
                ("scope", self.scope.is_some()),
                ("provider", self.provider.is_some()),
                ("model", self.model.is_some()),
                ("reasoning", self.reasoning.is_some()),
                ("flowId", self.flow_id.is_some()),
                ("parameters", self.parameters.is_some()),
            ]),
            ProductCommandKind::RalphResumeRun => required.extend([
                ("workspace", self.workspace.is_some()),
                ("scope", self.scope.is_some()),
                ("provider", self.provider.is_some()),
                ("model", self.model.is_some()),
                ("reasoning", self.reasoning.is_some()),
                ("runId", self.run_id.is_some()),
            ]),
            ProductCommandKind::GenerateMedia => required.extend([
                ("prompt", self.prompt.is_some()),
                ("target", self.target.is_some()),
                ("modelId", self.model_id.is_some()),
                ("aspectRatio", self.aspect_ratio.is_some()),
                ("outputCount", self.output_count.is_some()),
                ("outputFormat", self.output_format.is_some()),
                (
                    "transparentBackground",
                    self.transparent_background.is_some(),
                ),
            ]),
            ProductCommandKind::CancelMediaRun => required.push(("runId", self.run_id.is_some())),
        }

        let missing_fields = required
            .into_iter()
            .filter_map(|(field, present)| (!present).then_some(field))
            .collect::<Vec<_>>();
        if !missing_fields.is_empty() {
            return Err(format!(
                "{} command requires {}.",
                self.kind.as_str(),
                missing_fields.join(", ")
            ));
        }

        self.validate_values()
    }

    fn validate_values(&self) -> Result<(), String> {
        let valid = match self.kind {
            ProductCommandKind::Cancel
            | ProductCommandKind::Retry
            | ProductCommandKind::Continue
            | ProductCommandKind::CancelPromptEnhancement => {
                valid_identifier(self.task_id.as_deref())
            }
            ProductCommandKind::SubmitMessage => {
                valid_identifier(self.session_id.as_deref())
                    && valid_command_text(self.prompt.as_deref())
                    && valid_prompt_enhancement_mode(self.prompt_enhancement_mode.as_deref())
            }
            ProductCommandKind::CreateSession => {
                self.workspace.as_deref().is_none_or(valid_workspace)
            }
            ProductCommandKind::ActivateSession
            | ProductCommandKind::ArchiveSession
            | ProductCommandKind::PinSession
            | ProductCommandKind::DuplicateSession
            | ProductCommandKind::BranchSession
            | ProductCommandKind::DeleteSession
            | ProductCommandKind::ClearSessionHistory
            | ProductCommandKind::ClearSessionMode
            | ProductCommandKind::ClearSessionReasoning
            | ProductCommandKind::ClearAttachments
            | ProductCommandKind::ClearSessionWorkspace => {
                valid_identifier(self.session_id.as_deref())
            }
            ProductCommandKind::RenameSession => {
                valid_identifier(self.session_id.as_deref())
                    && valid_short_text(self.title.as_deref())
            }
            ProductCommandKind::TagSession => {
                valid_identifier(self.session_id.as_deref()) && valid_tags(self.tags.as_deref())
            }
            ProductCommandKind::UpdateDraft => {
                valid_identifier(self.session_id.as_deref())
                    && valid_text(self.prompt.as_deref(), 8_000)
            }
            ProductCommandKind::SetSessionModel => {
                valid_identifier(self.session_id.as_deref())
                    && valid_short_text(self.provider.as_deref())
                    && valid_short_text(self.model.as_deref())
            }
            ProductCommandKind::SetSessionMode => {
                valid_identifier(self.session_id.as_deref()) && valid_mode(self.mode.as_deref())
            }
            ProductCommandKind::SetSessionReasoning => {
                valid_identifier(self.session_id.as_deref())
                    && valid_reasoning(self.reasoning.as_deref())
            }
            ProductCommandKind::SetSessionWorkspace => {
                valid_identifier(self.session_id.as_deref())
                    && valid_workspace(self.workspace.as_deref().unwrap())
            }
            ProductCommandKind::SetPromptEnhancementMode => {
                valid_identifier(self.session_id.as_deref())
                    && valid_prompt_enhancement_mode(self.prompt_enhancement_mode.as_deref())
            }
            ProductCommandKind::SetInterview
            | ProductCommandKind::SetSessionMemory
            | ProductCommandKind::SetGlobalMemory
            | ProductCommandKind::SetUiControl => valid_identifier(self.session_id.as_deref()),
            ProductCommandKind::ForgetSessionMemory => {
                valid_identifier(self.session_id.as_deref())
                    && valid_identifier(self.memory_id.as_deref())
            }
            ProductCommandKind::RemoveAttachment => {
                valid_identifier(self.session_id.as_deref())
                    && valid_identifier(self.attachment_id.as_deref())
            }
            ProductCommandKind::ApplyContextPack => {
                valid_identifier(self.session_id.as_deref())
                    && valid_identifier(self.context_pack_id.as_deref())
            }
            ProductCommandKind::DeleteContextPack => {
                valid_identifier(self.context_pack_id.as_deref())
            }
            ProductCommandKind::SaveMessageContextPack | ProductCommandKind::SpeakMessage => {
                valid_identifier(self.session_id.as_deref())
                    && valid_identifier(self.message_id.as_deref())
            }
            ProductCommandKind::StopSpeaking => true,
            ProductCommandKind::SchedulerTrigger
            | ProductCommandKind::SchedulerPause
            | ProductCommandKind::SchedulerResume
            | ProductCommandKind::SchedulerDelete => {
                valid_workspace(self.workspace.as_deref().unwrap())
                    && valid_identifier(self.job_id.as_deref())
            }
            ProductCommandKind::SchedulerRetryRun | ProductCommandKind::SchedulerCancelRun => {
                valid_workspace(self.workspace.as_deref().unwrap())
                    && valid_identifier(self.run_id.as_deref())
            }
            ProductCommandKind::RalphRun => {
                self.valid_ralph_runtime()
                    && valid_identifier(self.flow_id.as_deref())
                    && valid_ralph_parameters(self.parameters.as_ref().unwrap())
            }
            ProductCommandKind::RalphResumeRun => {
                self.valid_ralph_runtime() && valid_identifier(self.run_id.as_deref())
            }
            ProductCommandKind::GenerateMedia => {
                valid_command_text(self.prompt.as_deref())
                    && matches!(self.target.as_deref(), Some("image" | "svg"))
                    && valid_identifier(self.model_id.as_deref())
                    && matches!(
                        self.aspect_ratio.as_deref(),
                        Some("1:1" | "4:5" | "16:9" | "9:16")
                    )
                    && self
                        .output_count
                        .is_some_and(|count| (1..=8).contains(&count))
                    && matches!(
                        self.output_format.as_deref(),
                        Some("png" | "jpeg" | "webp" | "svg")
                    )
            }
            ProductCommandKind::CancelMediaRun => valid_identifier(self.run_id.as_deref()),
        };

        if valid && self.command_id.as_deref().is_none_or(valid_command_id) {
            Ok(())
        } else {
            Err(format!(
                "{} command contains invalid field values.",
                self.kind.as_str()
            ))
        }
    }

    fn valid_ralph_runtime(&self) -> bool {
        valid_workspace(self.workspace.as_deref().unwrap())
            && matches!(self.scope.as_deref(), Some("workspace" | "user"))
            && valid_short_text(self.provider.as_deref())
            && valid_short_text(self.model.as_deref())
            && valid_reasoning(self.reasoning.as_deref())
            && self
                .max_transitions
                .is_none_or(|value| (1..=1_000_000).contains(&value))
    }
}

fn valid_text(value: Option<&str>, maximum_length: usize) -> bool {
    value.is_some_and(|value| value.encode_utf16().count() <= maximum_length)
}

fn valid_trimmed_text(value: Option<&str>, maximum_length: usize) -> bool {
    value.is_some_and(|value| {
        let value = value.trim();
        !value.is_empty() && value.encode_utf16().count() <= maximum_length
    })
}

fn valid_command_id(value: &str) -> bool {
    valid_trimmed_text(Some(value), 128)
}

fn valid_identifier(value: Option<&str>) -> bool {
    valid_trimmed_text(value, 240)
}

fn valid_short_text(value: Option<&str>) -> bool {
    valid_trimmed_text(value, 240)
}

fn valid_command_text(value: Option<&str>) -> bool {
    valid_trimmed_text(value, 8_000)
}

fn valid_workspace(value: &str) -> bool {
    valid_trimmed_text(Some(value), 12_000)
}

fn valid_tags(value: Option<&[String]>) -> bool {
    value.is_some_and(|tags| {
        tags.len() <= 24 && tags.iter().all(|tag| valid_trimmed_text(Some(tag), 64))
    })
}

fn valid_mode(value: Option<&str>) -> bool {
    matches!(value, Some("ask" | "machdoch"))
}

fn valid_reasoning(value: Option<&str>) -> bool {
    matches!(
        value,
        Some(
            "default" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
        )
    )
}

fn valid_prompt_enhancement_mode(value: Option<&str>) -> bool {
    matches!(value, Some("off" | "simple" | "web-search"))
}

fn valid_ralph_parameters(parameters: &BTreeMap<String, String>) -> bool {
    parameters.len() <= 64
        && parameters.iter().all(|(name, value)| {
            valid_trimmed_text(Some(name), 240) && valid_text(Some(value), 8_000)
        })
        && parameters
            .keys()
            .map(|name| name.trim())
            .collect::<BTreeSet<_>>()
            .len()
            == parameters.len()
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
            Self::ForgetSessionMemory => "forget-session-memory",
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
            Self::RalphRun => "ralph-run",
            Self::RalphResumeRun => "ralph-resume-run",
            Self::GenerateMedia => "generate-media",
            Self::CancelMediaRun => "cancel-media-run",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn managed_settings_delivery_json() -> Value {
        serde_json::json!({
            "schemaVersion": MANAGED_SETTINGS_SCHEMA_VERSION,
            "managerId": "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
            "profile": {
                "profileId": "profile_MDEyMzQ1Njc4OTAxMjM0NTY3",
                "name": "Engineering",
                "revision": 1,
                "document": {
                    "defaults": {
                        "provider": "openai",
                        "model": "gpt-5.6",
                        "mode": "machdoch",
                        "reasoning": "high",
                        "webSearchProvider": "tavily",
                        "theme": "dark",
                        "density": "compact",
                        "accent": "sky"
                    },
                    "agentLimits": {
                        "infinite": false,
                        "executorTurns": 20,
                        "autopilotExecutorIterations": 10
                    },
                    "instructions": [{
                        "id": "123e4567-e89b-42d3-a456-426614174000",
                        "name": "Review",
                        "body": "Review carefully.",
                        "enabled": true,
                        "global": true,
                        "tags": ["review"]
                    }],
                    "contextPacks": [{
                        "id": "123e4567-e89b-42d3-a456-426614174001",
                        "name": "Change review",
                        "instructions": "Review carefully.",
                        "prompt": "Review this change.",
                        "provider": "openai",
                        "model": "gpt-5.6",
                        "mode": "ask",
                        "reasoning": "medium",
                        "variables": [{"name": "target", "defaultValue": "src"}],
                        "triggerPhrases": ["review"],
                        "pathPatterns": ["src/**"],
                        "promptEnhancementMode": "web-search",
                        "interviewEnabled": true,
                        "sessionMemoryEnabled": false,
                        "useGlobalMemory": true,
                        "uiControlEnabled": false
                    }],
                    "prompts": [{
                        "id": "123e4567-e89b-42d3-a456-426614174002",
                        "relativePath": "review.prompt.md",
                        "content": "Review this change."
                    }]
                },
                "secrets": {"openai": "secret"}
            }
        })
    }

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
            memory_id: None,
            attachment_id: None,
            context_pack_id: None,
            message_id: None,
            job_id: None,
            run_id: None,
            flow_id: None,
            scope: None,
            parameters: None,
            max_transitions: None,
            target: None,
            aspect_ratio: None,
            output_count: None,
            output_format: None,
            transparent_background: None,
        }
    }

    fn command_payload(kind: &str) -> Value {
        serde_json::json!({
            "kind": kind,
            "commandId": "command-1",
            "taskId": "task-1",
            "sessionId": "session-1",
            "prompt": "Prompt",
            "title": "Title",
            "tags": ["tag"],
            "provider": "openai",
            "model": "gpt-5.6",
            "modelId": "openai:gpt-image-2",
            "mode": "machdoch",
            "reasoning": "high",
            "promptEnhancementMode": "web-search",
            "interviewEnabled": true,
            "workspace": "C:\\workspace",
            "enabled": true,
            "memoryId": "memory-1",
            "attachmentId": "attachment-1",
            "contextPackId": "pack-1",
            "messageId": "message-1",
            "jobId": "job-1",
            "runId": "run-1",
            "flowId": "flow-1",
            "scope": "workspace",
            "parameters": {"environment": "production"},
            "maxTransitions": 48,
            "target": "image",
            "aspectRatio": "1:1",
            "outputCount": 2,
            "outputFormat": "png",
            "transparentBackground": true
        })
    }

    fn assert_command_requires_fields(kind: &str, required_fields: &[&str]) {
        let command = command_payload(kind);
        assert!(
            serde_json::from_value::<ProductCommand>(command.clone()).is_ok(),
            "{kind} command should decode when complete"
        );

        for field in required_fields {
            let mut malformed = command.clone();
            malformed
                .as_object_mut()
                .expect("command should be an object")
                .remove(*field);

            assert!(
                serde_json::from_value::<ProductCommand>(malformed).is_err(),
                "{kind} command should require {field}"
            );
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
                "capabilities": ["product.v4"]
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

    #[test]
    fn ralph_commands_use_the_shared_runtime_fields() {
        let command = serde_json::from_value::<ProductCommand>(serde_json::json!({
            "kind": "ralph-run",
            "commandId": "ralph-1",
            "workspace": "C:\\workspace",
            "scope": "workspace",
            "flowId": "release-flow",
            "parameters": {
                "environment": "production"
            },
            "provider": "openai",
            "model": "gpt-5.6",
            "reasoning": "high",
            "maxTransitions": 48
        }))
        .expect("RALPH command should decode");

        assert_eq!(command.kind, ProductCommandKind::RalphRun);
        assert_eq!(command.flow_id.as_deref(), Some("release-flow"));
        assert_eq!(command.scope.as_deref(), Some("workspace"));
        assert_eq!(command.provider.as_deref(), Some("openai"));
        assert_eq!(command.model.as_deref(), Some("gpt-5.6"));
        assert_eq!(command.reasoning.as_deref(), Some("high"));
        assert_eq!(command.max_transitions, Some(48));
        assert_eq!(
            command
                .parameters
                .as_ref()
                .and_then(|parameters| parameters.get("environment"))
                .map(String::as_str),
            Some("production")
        );
    }

    #[test]
    fn command_decoding_requires_kind_specific_fields() {
        for (kind, required_fields) in [
            ("cancel", &["taskId"][..]),
            ("retry", &["taskId"][..]),
            ("continue", &["taskId"][..]),
            (
                "submit-message",
                &[
                    "sessionId",
                    "prompt",
                    "promptEnhancementMode",
                    "interviewEnabled",
                ][..],
            ),
            ("activate-session", &["sessionId"][..]),
            ("archive-session", &["sessionId"][..]),
            ("pin-session", &["sessionId"][..]),
            ("duplicate-session", &["sessionId"][..]),
            ("branch-session", &["sessionId"][..]),
            ("delete-session", &["sessionId"][..]),
            ("clear-session-history", &["sessionId"][..]),
            ("clear-session-mode", &["sessionId"][..]),
            ("clear-session-reasoning", &["sessionId"][..]),
            ("clear-attachments", &["sessionId"][..]),
            ("rename-session", &["sessionId", "title"][..]),
            ("tag-session", &["sessionId", "tags"][..]),
            ("update-draft", &["sessionId", "prompt"][..]),
            ("set-session-model", &["sessionId", "provider", "model"][..]),
            ("set-session-mode", &["sessionId", "mode"][..]),
            ("set-session-reasoning", &["sessionId", "reasoning"][..]),
            ("set-session-workspace", &["sessionId", "workspace"][..]),
            ("clear-session-workspace", &["sessionId"][..]),
            (
                "set-prompt-enhancement-mode",
                &["sessionId", "promptEnhancementMode"][..],
            ),
            ("set-interview", &["sessionId", "enabled"][..]),
            ("cancel-prompt-enhancement", &["taskId"][..]),
            ("set-session-memory", &["sessionId", "enabled"][..]),
            ("forget-session-memory", &["sessionId", "memoryId"][..]),
            ("set-global-memory", &["sessionId", "enabled"][..]),
            ("set-ui-control", &["sessionId", "enabled"][..]),
            ("remove-attachment", &["sessionId", "attachmentId"][..]),
            ("apply-context-pack", &["sessionId", "contextPackId"][..]),
            ("delete-context-pack", &["contextPackId"][..]),
            ("save-message-context-pack", &["sessionId", "messageId"][..]),
            ("speak-message", &["sessionId", "messageId"][..]),
            ("scheduler-trigger", &["workspace", "jobId"][..]),
            ("scheduler-pause", &["workspace", "jobId"][..]),
            ("scheduler-resume", &["workspace", "jobId"][..]),
            ("scheduler-delete", &["workspace", "jobId"][..]),
            ("scheduler-retry-run", &["workspace", "runId"][..]),
            ("scheduler-cancel-run", &["workspace", "runId"][..]),
            (
                "ralph-run",
                &[
                    "workspace",
                    "scope",
                    "provider",
                    "model",
                    "reasoning",
                    "flowId",
                    "parameters",
                ][..],
            ),
            (
                "ralph-resume-run",
                &[
                    "workspace",
                    "scope",
                    "provider",
                    "model",
                    "reasoning",
                    "runId",
                ][..],
            ),
            (
                "generate-media",
                &[
                    "prompt",
                    "target",
                    "modelId",
                    "aspectRatio",
                    "outputCount",
                    "outputFormat",
                    "transparentBackground",
                ][..],
            ),
            ("cancel-media-run", &["runId"][..]),
        ] {
            assert_command_requires_fields(kind, required_fields);
        }
    }

    #[test]
    fn command_decoding_rejects_unknown_kinds() {
        let command = command_payload("unknown-command");

        assert!(serde_json::from_value::<ProductCommand>(command).is_err());
    }

    #[test]
    fn command_decoding_rejects_invalid_kind_specific_values() {
        for (kind, field, value) in [
            ("ralph-run", "scope", serde_json::json!("global")),
            (
                "ralph-resume-run",
                "reasoning",
                serde_json::json!("extreme"),
            ),
            ("ralph-run", "parameters", serde_json::json!({" ": "value"})),
            ("generate-media", "target", serde_json::json!("video")),
            ("generate-media", "outputCount", serde_json::json!(0)),
            ("generate-media", "outputFormat", serde_json::json!("gif")),
            ("activate-session", "sessionId", serde_json::json!("  ")),
            ("set-session-mode", "mode", serde_json::json!("automatic")),
            (
                "set-session-workspace",
                "workspace",
                serde_json::json!("\t"),
            ),
            ("scheduler-trigger", "workspace", serde_json::json!("  ")),
            ("scheduler-trigger", "jobId", serde_json::json!("")),
        ] {
            let mut command = command_payload(kind);
            command[field] = value;

            assert!(
                serde_json::from_value::<ProductCommand>(command).is_err(),
                "{kind} command should reject invalid {field}"
            );
        }
    }

    fn snapshot_response_with_chunk_size(chunk_size: usize) -> HostMessage {
        HostMessage::Response {
            request_id: "request-1".to_string(),
            response: HostResponse::ProductSnapshot {
                snapshot: serde_json::json!({
                    "payload": "x".repeat(chunk_size),
                }),
            },
        }
    }

    #[test]
    fn gateway_snapshot_payload_at_the_budget_is_accepted() {
        let overhead = serialize_host_message(&snapshot_response_with_chunk_size(0))
            .expect("empty snapshot should encode")
            .len();
        let message = snapshot_response_with_chunk_size(MAX_GATEWAY_MESSAGE_BYTES - overhead);
        let payload =
            serialize_host_message(&message).expect("boundary-sized snapshot should encode");

        assert_eq!(payload.len(), MAX_GATEWAY_MESSAGE_BYTES);
    }

    #[test]
    fn gateway_snapshot_payload_over_the_budget_is_rejected() {
        let overhead = serialize_host_message(&snapshot_response_with_chunk_size(0))
            .expect("empty snapshot should encode")
            .len();
        let message = snapshot_response_with_chunk_size(MAX_GATEWAY_MESSAGE_BYTES - overhead + 1);
        let error =
            serialize_host_message(&message).expect_err("oversized snapshot should be rejected");

        assert_eq!(
            error.to_string(),
            "Gateway message exceeds the 4 MiB payload budget."
        );
    }

    #[test]
    fn managed_settings_delivery_deserializes_when_valid() {
        let delivery = serde_json::from_value::<FleetManagedSettingsDelivery>(
            managed_settings_delivery_json(),
        )
        .expect("managed settings delivery should decode");

        assert_eq!(delivery.schema_version, MANAGED_SETTINGS_SCHEMA_VERSION);
        assert_eq!(
            delivery.profile.as_ref().map(|profile| profile.revision),
            Some(1)
        );
    }

    #[test]
    fn managed_settings_delivery_rejects_invalid_identifiers_and_relationships() {
        let mut invalid_manager = managed_settings_delivery_json();
        invalid_manager["managerId"] = Value::String("manager-not-valid".to_string());

        let mut invalid_uuid = managed_settings_delivery_json();
        invalid_uuid["profile"]["document"]["instructions"][0]["id"] =
            Value::String("not-a-uuid".to_string());

        let mut invalid_defaults = managed_settings_delivery_json();
        invalid_defaults["profile"]["document"]["defaults"]["provider"] = Value::Null;

        let mut invalid_context_pack = managed_settings_delivery_json();
        invalid_context_pack["profile"]["document"]["contextPacks"][0]["model"] = Value::Null;

        assert!(serde_json::from_value::<FleetManagedSettingsDelivery>(invalid_manager).is_err());
        assert!(serde_json::from_value::<FleetManagedSettingsDelivery>(invalid_uuid).is_err());
        assert!(serde_json::from_value::<FleetManagedSettingsDelivery>(invalid_defaults).is_err());
        assert!(
            serde_json::from_value::<FleetManagedSettingsDelivery>(invalid_context_pack).is_err()
        );
    }

    #[test]
    fn managed_settings_delivery_rejects_excessive_collections() {
        let mut delivery = managed_settings_delivery_json();
        let instruction = delivery["profile"]["document"]["instructions"][0].clone();
        let instructions = delivery["profile"]["document"]["instructions"]
            .as_array_mut()
            .expect("instructions should be an array");
        for _ in 1..=MAX_MANAGED_SETTINGS_COLLECTION_ENTRIES {
            instructions.push(instruction.clone());
        }

        assert!(serde_json::from_value::<FleetManagedSettingsDelivery>(delivery).is_err());
    }

    #[test]
    fn managed_settings_delivery_enforces_safe_revision_range() {
        let mut delivery = managed_settings_delivery_json();
        delivery["profile"]["revision"] = serde_json::json!(MAX_MANAGED_SETTINGS_REVISION);

        assert!(serde_json::from_value::<FleetManagedSettingsDelivery>(delivery.clone()).is_ok());

        delivery["profile"]["revision"] = serde_json::json!(MAX_MANAGED_SETTINGS_REVISION + 1);

        assert!(serde_json::from_value::<FleetManagedSettingsDelivery>(delivery).is_err());
    }
}
