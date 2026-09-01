use std::{
    collections::HashSet,
    time::{SystemTime, UNIX_EPOCH},
};

use super::settings_types::{
    UserAgentLimitsConfigFile, UserAgentLimitsSettings, UserDesktopSettings,
    UserInternalTaskModelConfigFile, UserInternalTaskModelSettings, UserMemoryEntry,
    UserReviewModelConfigFile, UserReviewModelSettings, UserWorkspaceRunConfigFile,
    UserWorkspaceRunSettings,
};
use super::{is_valid_model_provider, normalize_optional_string};
use crate::runtime_contract_generated::{
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SHORTCUT,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS, DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS,
    DEFAULT_MAX_EXECUTOR_TURNS, DEFAULT_USER_AGENT_LIMITS_INFINITE,
    DEFAULT_USER_INTERNAL_TASK_MODEL_REASONING, DEFAULT_USER_REVIEW_MODEL_MODE,
    DEFAULT_WORKSPACE_RUN_HEALTH_CHECK_FAILURE_THRESHOLD,
    DEFAULT_WORKSPACE_RUN_HEALTH_CHECK_INTERVAL_MS, DEFAULT_WORKSPACE_RUN_HEALTH_CHECK_TIMEOUT_MS,
    DEFAULT_WORKSPACE_RUN_SEQUENTIAL_READINESS_TIMEOUT_MS, DEFAULT_WORKSPACE_RUN_STARTUP_DELAY_MS,
    MAX_CONFIGURED_AUTOPILOT_ITERATIONS, MAX_CONFIGURED_EXECUTOR_TURNS,
    MAX_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    MAX_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    MAX_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    MAX_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    MAX_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES, MAX_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
    MAX_WORKSPACE_RUN_HEALTH_CHECK_FAILURE_THRESHOLD, MAX_WORKSPACE_RUN_HEALTH_CHECK_INTERVAL_MS,
    MAX_WORKSPACE_RUN_HEALTH_CHECK_TIMEOUT_MS, MAX_WORKSPACE_RUN_SEQUENTIAL_READINESS_TIMEOUT_MS,
    MAX_WORKSPACE_RUN_STARTUP_DELAY_MS, MIN_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    MIN_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    MIN_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    MIN_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    MIN_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES, MIN_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
    MIN_WORKSPACE_RUN_HEALTH_CHECK_FAILURE_THRESHOLD, MIN_WORKSPACE_RUN_HEALTH_CHECK_INTERVAL_MS,
    MIN_WORKSPACE_RUN_HEALTH_CHECK_TIMEOUT_MS, MIN_WORKSPACE_RUN_SEQUENTIAL_READINESS_TIMEOUT_MS,
    MIN_WORKSPACE_RUN_STARTUP_DELAY_MS, REASONING_MODES, USER_REVIEW_MODEL_MODES,
};

const MAX_GLOBAL_MEMORY_ENTRIES: usize = 40;
const MAX_WORKSPACE_MEMORY_ENTRIES: usize = 64;
const MAX_MEMORY_CONTENT_LENGTH: usize = 280;
const MAX_MEMORY_SEARCH_TERMS: usize = 8;
const MAX_MEMORY_SEARCH_TERM_LENGTH: usize = 48;

pub(super) fn clamp_assistant_bubble_hide_seconds(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
        MAX_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    )
}

pub(super) fn clamp_quick_voice_silence_seconds(value: f64) -> f64 {
    if !value.is_finite() {
        return DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS;
    }

    ((value * 10.0).round() / 10.0).clamp(
        MIN_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
        MAX_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
    )
}

pub(super) fn clamp_quick_voice_message_limit(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
        MAX_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
    )
}

pub(super) fn clamp_ai_context_message_limit(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
        MAX_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    )
}

pub(super) fn clamp_inactive_session_archive_days(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
        MAX_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    )
}

pub(super) fn clamp_archived_session_retention_days(value: u32) -> u32 {
    value.clamp(
        MIN_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
        MAX_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    )
}

pub(super) fn clamp_executor_turn_limit(value: u32) -> u32 {
    value.clamp(1, MAX_CONFIGURED_EXECUTOR_TURNS)
}

pub(super) fn clamp_autopilot_iteration_limit(value: u32) -> u32 {
    value.clamp(1, MAX_CONFIGURED_AUTOPILOT_ITERATIONS)
}

pub(super) fn normalize_user_agent_limits_settings(
    settings: &UserAgentLimitsConfigFile,
) -> UserAgentLimitsSettings {
    UserAgentLimitsSettings {
        infinite: settings
            .infinite
            .unwrap_or(DEFAULT_USER_AGENT_LIMITS_INFINITE),
        executor_turns: settings
            .executor_turns
            .map(clamp_executor_turn_limit)
            .unwrap_or(DEFAULT_MAX_EXECUTOR_TURNS),
        autopilot_executor_iterations: settings
            .autopilot_executor_iterations
            .map(clamp_autopilot_iteration_limit)
            .unwrap_or(DEFAULT_MAX_AUTOPILOT_EXECUTOR_ITERATIONS),
    }
}

pub(super) fn normalize_user_agent_limits_settings_input(
    settings: &UserAgentLimitsSettings,
) -> UserAgentLimitsSettings {
    UserAgentLimitsSettings {
        infinite: settings.infinite,
        executor_turns: clamp_executor_turn_limit(settings.executor_turns),
        autopilot_executor_iterations: clamp_autopilot_iteration_limit(
            settings.autopilot_executor_iterations,
        ),
    }
}

pub(super) fn normalize_user_workspace_run_settings(
    settings: &UserWorkspaceRunConfigFile,
) -> UserWorkspaceRunSettings {
    let health_check_interval_ms = settings
        .health_check_interval_ms
        .map(|value| {
            value.clamp(
                MIN_WORKSPACE_RUN_HEALTH_CHECK_INTERVAL_MS,
                MAX_WORKSPACE_RUN_HEALTH_CHECK_INTERVAL_MS,
            )
        })
        .unwrap_or(DEFAULT_WORKSPACE_RUN_HEALTH_CHECK_INTERVAL_MS);
    let health_check_timeout_ms = settings
        .health_check_timeout_ms
        .map(|value| {
            value.clamp(
                MIN_WORKSPACE_RUN_HEALTH_CHECK_TIMEOUT_MS,
                MAX_WORKSPACE_RUN_HEALTH_CHECK_TIMEOUT_MS,
            )
        })
        .unwrap_or(DEFAULT_WORKSPACE_RUN_HEALTH_CHECK_TIMEOUT_MS)
        .min(health_check_interval_ms);

    UserWorkspaceRunSettings {
        startup_delay_ms: settings
            .startup_delay_ms
            .map(|value| {
                value.clamp(
                    MIN_WORKSPACE_RUN_STARTUP_DELAY_MS,
                    MAX_WORKSPACE_RUN_STARTUP_DELAY_MS,
                )
            })
            .unwrap_or(DEFAULT_WORKSPACE_RUN_STARTUP_DELAY_MS),
        health_check_interval_ms,
        health_check_timeout_ms,
        health_check_failure_threshold: settings
            .health_check_failure_threshold
            .map(|value| {
                value.clamp(
                    MIN_WORKSPACE_RUN_HEALTH_CHECK_FAILURE_THRESHOLD,
                    MAX_WORKSPACE_RUN_HEALTH_CHECK_FAILURE_THRESHOLD,
                )
            })
            .unwrap_or(DEFAULT_WORKSPACE_RUN_HEALTH_CHECK_FAILURE_THRESHOLD),
        sequential_readiness_timeout_ms: settings
            .sequential_readiness_timeout_ms
            .map(|value| {
                value.clamp(
                    MIN_WORKSPACE_RUN_SEQUENTIAL_READINESS_TIMEOUT_MS,
                    MAX_WORKSPACE_RUN_SEQUENTIAL_READINESS_TIMEOUT_MS,
                )
            })
            .unwrap_or(DEFAULT_WORKSPACE_RUN_SEQUENTIAL_READINESS_TIMEOUT_MS),
    }
}

pub(super) fn normalize_user_workspace_run_settings_input(
    settings: &UserWorkspaceRunSettings,
) -> UserWorkspaceRunSettings {
    normalize_user_workspace_run_settings(&UserWorkspaceRunConfigFile {
        startup_delay_ms: Some(settings.startup_delay_ms),
        health_check_interval_ms: Some(settings.health_check_interval_ms),
        health_check_timeout_ms: Some(settings.health_check_timeout_ms),
        health_check_failure_threshold: Some(settings.health_check_failure_threshold),
        sequential_readiness_timeout_ms: Some(settings.sequential_readiness_timeout_ms),
    })
}

fn is_user_review_model_mode(value: &str) -> bool {
    USER_REVIEW_MODEL_MODES.contains(&value)
}

pub(super) fn normalize_user_review_model_settings(
    settings: &UserReviewModelConfigFile,
) -> UserReviewModelSettings {
    let mode = normalize_optional_string(settings.mode.as_deref())
        .filter(|mode| is_user_review_model_mode(mode))
        .unwrap_or_else(|| DEFAULT_USER_REVIEW_MODEL_MODE.to_string());
    let provider = normalize_optional_string(settings.provider.as_deref());
    let model = normalize_optional_string(settings.model.as_deref());

    if mode != "dedicated" {
        return UserReviewModelSettings {
            mode: "base".to_string(),
            provider: None,
            model: None,
        };
    }

    match (provider, model) {
        (Some(provider), Some(model)) if is_valid_model_provider(&provider) => {
            UserReviewModelSettings {
                mode: "dedicated".to_string(),
                provider: Some(provider),
                model: Some(model),
            }
        }
        _ => UserReviewModelSettings {
            mode: "base".to_string(),
            provider: None,
            model: None,
        },
    }
}

pub(super) fn normalize_user_review_model_settings_input(
    settings: &UserReviewModelSettings,
) -> UserReviewModelSettings {
    normalize_user_review_model_settings(&UserReviewModelConfigFile {
        mode: Some(settings.mode.clone()),
        provider: settings.provider.clone(),
        model: settings.model.clone(),
    })
}

pub(super) fn normalize_user_internal_task_model_settings(
    settings: &UserInternalTaskModelConfigFile,
) -> UserInternalTaskModelSettings {
    let provider = normalize_optional_string(settings.provider.as_deref());
    let model = normalize_optional_string(settings.model.as_deref());
    let reasoning = normalize_optional_string(settings.reasoning.as_deref())
        .filter(|reasoning| REASONING_MODES.contains(&reasoning.as_str()))
        .unwrap_or_else(|| DEFAULT_USER_INTERNAL_TASK_MODEL_REASONING.to_string());

    match (provider, model) {
        (Some(provider), Some(model)) if is_valid_model_provider(&provider) => {
            UserInternalTaskModelSettings {
                provider: Some(provider),
                model: Some(model),
                reasoning,
            }
        }
        _ => UserInternalTaskModelSettings {
            provider: None,
            model: None,
            reasoning,
        },
    }
}

pub(super) fn normalize_user_internal_task_model_settings_input(
    settings: &UserInternalTaskModelSettings,
) -> UserInternalTaskModelSettings {
    normalize_user_internal_task_model_settings(&UserInternalTaskModelConfigFile {
        provider: settings.provider.clone(),
        model: settings.model.clone(),
        reasoning: Some(settings.reasoning.clone()),
    })
}

fn normalize_quick_voice_shortcut(value: Option<&str>) -> String {
    normalize_optional_string(value)
        .unwrap_or_else(|| DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SHORTCUT.to_string())
}

pub(super) fn resolve_quick_voice_shortcut(value: Option<&str>) -> String {
    let normalized = normalize_quick_voice_shortcut(value);

    if crate::desktop_shell::validate_quick_voice_shortcut(&normalized).is_ok() {
        normalized
    } else {
        DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SHORTCUT.to_string()
    }
}

pub(super) fn normalize_user_desktop_settings_input(
    settings: &UserDesktopSettings,
) -> Result<UserDesktopSettings, String> {
    let quick_voice_shortcut =
        normalize_quick_voice_shortcut(Some(settings.quick_voice_shortcut.as_str()));

    crate::desktop_shell::validate_quick_voice_shortcut(&quick_voice_shortcut)?;

    Ok(UserDesktopSettings {
        autostart_enabled: settings.autostart_enabled,
        autostart_minimized: settings.autostart_minimized,
        autostart_to_tray: settings.autostart_to_tray,
        always_run_as_administrator: settings.always_run_as_administrator,
        assistant_bubble_enabled: settings.assistant_bubble_enabled,
        assistant_bubble_hide_when_fullscreen: settings.assistant_bubble_hide_when_fullscreen,
        assistant_bubble_temporarily_hide_seconds: clamp_assistant_bubble_hide_seconds(
            settings.assistant_bubble_temporarily_hide_seconds,
        ),
        ai_context_max_messages: clamp_ai_context_message_limit(settings.ai_context_max_messages),
        inactive_session_archive_days: clamp_inactive_session_archive_days(
            settings.inactive_session_archive_days,
        ),
        archived_session_retention_days: clamp_archived_session_retention_days(
            settings.archived_session_retention_days,
        ),
        quick_voice_enabled: settings.quick_voice_enabled,
        quick_voice_shortcut,
        quick_voice_silence_seconds: clamp_quick_voice_silence_seconds(
            settings.quick_voice_silence_seconds,
        ),
        quick_voice_max_messages: clamp_quick_voice_message_limit(
            settings.quick_voice_max_messages,
        ),
    })
}

pub(super) fn create_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_memory_content(value: &str) -> Option<String> {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();

    if trimmed.is_empty() {
        return None;
    }

    if trimmed.len() <= MAX_MEMORY_CONTENT_LENGTH {
        return Some(trimmed.to_string());
    }

    let end = MAX_MEMORY_CONTENT_LENGTH.saturating_sub(1);
    let prefix = trimmed.chars().take(end).collect::<String>();
    Some(format!("{}…", prefix))
}

fn normalize_memory_key(value: &str, content: &str) -> String {
    let source = normalize_optional_string(Some(value)).unwrap_or_else(|| content.to_string());
    let mut normalized = String::new();
    let mut separated = false;

    for character in source.to_lowercase().chars() {
        if character.is_alphanumeric() {
            normalized.push(character);
            separated = false;
        } else if !separated && !normalized.is_empty() {
            normalized.push('-');
            separated = true;
        }
    }

    normalized.trim_matches('-').chars().take(96).collect()
}

fn normalize_memory_kind(value: &str) -> String {
    match value {
        "preference" | "constraint" | "decision" | "fact" | "workaround" => value.to_string(),
        _ => "fact".to_string(),
    }
}

fn normalize_memory_statement(content: &str) -> String {
    let prefix = "the user prefers";
    if !content.to_lowercase().starts_with(prefix) {
        return content.to_string();
    }

    let remainder = content[prefix.len()..].trim_start();
    if let Some(labeled) = remainder.strip_prefix(':') {
        return labeled.trim_start().to_string();
    }

    if remainder.is_empty() {
        content.to_string()
    } else {
        format!("Prefers {remainder}")
    }
}

fn normalize_memory_search_terms(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();

    values
        .iter()
        .filter_map(|value| normalize_optional_string(Some(value.as_str())))
        .map(|value| {
            value
                .chars()
                .take(MAX_MEMORY_SEARCH_TERM_LENGTH)
                .collect::<String>()
        })
        .filter(|value| seen.insert(value.to_lowercase()))
        .take(MAX_MEMORY_SEARCH_TERMS)
        .collect()
}

pub(super) fn normalize_user_memory_entries(
    entries: &[UserMemoryEntry],
    scope: &str,
) -> Vec<UserMemoryEntry> {
    let mut normalized = Vec::new();

    for (index, entry) in entries.iter().enumerate() {
        let Some(normalized_content) = normalize_memory_content(&entry.content) else {
            continue;
        };
        let kind = normalize_memory_kind(&entry.kind);
        let content = normalize_memory_statement(&normalized_content);

        let created_at = if entry.created_at == 0 {
            create_timestamp_millis()
        } else {
            entry.created_at
        };
        let updated_at = if entry.updated_at == 0 {
            created_at
        } else {
            entry.updated_at
        };
        let normalized_entry = UserMemoryEntry {
            id: normalize_optional_string(Some(entry.id.as_str()))
                .unwrap_or_else(|| format!("{}-memory-{}-{}", scope, updated_at, index)),
            scope: scope.to_string(),
            source_session_id: entry
                .source_session_id
                .as_deref()
                .and_then(|value| normalize_optional_string(Some(value))),
            key: normalize_memory_key(&entry.key, &content),
            kind,
            content: content.clone(),
            search_terms: normalize_memory_search_terms(&entry.search_terms),
            importance: entry.importance.clamp(1, 5),
            confidence: if entry.confidence.is_finite() {
                entry.confidence.clamp(0.0, 1.0)
            } else {
                1.0
            },
            created_at,
            updated_at,
        };
        normalized.push(normalized_entry);
    }

    normalized.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
    let mut keys = HashSet::new();
    let mut contents = HashSet::new();
    normalized.retain(|entry| {
        keys.insert(entry.key.clone()) && contents.insert(entry.content.to_lowercase())
    });
    normalized.truncate(if scope == "workspace" {
        MAX_WORKSPACE_MEMORY_ENTRIES
    } else {
        MAX_GLOBAL_MEMORY_ENTRIES
    });
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_entry(id: &str, key: &str, content: &str, updated_at: u64) -> UserMemoryEntry {
        UserMemoryEntry {
            id: id.to_string(),
            scope: "global".to_string(),
            source_session_id: None,
            key: key.to_string(),
            kind: "preference".to_string(),
            content: content.to_string(),
            search_terms: Vec::new(),
            importance: 4,
            confidence: 0.9,
            created_at: 1,
            updated_at,
        }
    }

    #[test]
    fn memory_normalization_keeps_the_newest_key_and_content() {
        let entries = vec![
            memory_entry("old", "summary-style", "Detailed summaries", 2),
            memory_entry("new", "summary-style", "Compact summaries", 3),
            memory_entry("duplicate", "different-key", "Compact summaries", 1),
        ];

        let normalized = normalize_user_memory_entries(&entries, "global");

        assert_eq!(normalized.len(), 1);
        assert_eq!(normalized[0].id, "new");
        assert_eq!(normalized[0].content, "Compact summaries");
    }

    #[test]
    fn internal_task_model_normalization_preserves_valid_reasoning() {
        let normalized =
            normalize_user_internal_task_model_settings(&UserInternalTaskModelConfigFile {
                provider: Some("codex-cli".to_string()),
                model: Some("gpt-5.6-terra".to_string()),
                reasoning: Some("high".to_string()),
            });

        assert_eq!(normalized.provider.as_deref(), Some("codex-cli"));
        assert_eq!(normalized.model.as_deref(), Some("gpt-5.6-terra"));
        assert_eq!(normalized.reasoning, "high");
    }

    #[test]
    fn internal_task_model_normalization_defaults_invalid_reasoning() {
        let normalized =
            normalize_user_internal_task_model_settings(&UserInternalTaskModelConfigFile {
                provider: Some("openai".to_string()),
                model: Some("gpt-5.5".to_string()),
                reasoning: Some("unsupported".to_string()),
            });

        assert_eq!(normalized.reasoning, "default");
    }

    #[test]
    fn workspace_run_settings_use_increased_defaults_and_bounded_values() {
        let defaults =
            normalize_user_workspace_run_settings(&UserWorkspaceRunConfigFile::default());

        assert_eq!(defaults.startup_delay_ms, 4_000);
        assert_eq!(defaults.health_check_interval_ms, 6_000);
        assert_eq!(defaults.health_check_timeout_ms, 2_500);
        assert_eq!(defaults.health_check_failure_threshold, 3);
        assert_eq!(defaults.sequential_readiness_timeout_ms, 150_000);

        let normalized = normalize_user_workspace_run_settings(&UserWorkspaceRunConfigFile {
            startup_delay_ms: Some(u64::MAX),
            health_check_interval_ms: Some(1_000),
            health_check_timeout_ms: Some(50_000),
            health_check_failure_threshold: Some(0),
            sequential_readiness_timeout_ms: Some(0),
        });

        assert_eq!(normalized.startup_delay_ms, 3_600_000);
        assert_eq!(normalized.health_check_interval_ms, 1_000);
        assert_eq!(normalized.health_check_timeout_ms, 1_000);
        assert_eq!(normalized.health_check_failure_threshold, 1);
        assert_eq!(normalized.sequential_readiness_timeout_ms, 1_000);
    }

    #[test]
    fn memory_normalization_removes_generic_preference_framing() {
        let entries = vec![memory_entry(
            "style",
            "summary-style",
            "The user prefers: Compact summaries",
            1,
        )];

        let normalized = normalize_user_memory_entries(&entries, "global");

        assert_eq!(normalized[0].content, "Compact summaries");
    }
}
