use std::{collections::HashMap, path::PathBuf};

use super::{
    env::has_configured_value,
    get_audio_provider_availability, get_web_search_provider_availability, load_global_env,
    normalize_optional_string, resolve_audio_active_provider, resolve_web_search_active_provider,
    settings::{
        normalize_user_agent_limits_settings, normalize_user_agent_limits_settings_input,
        normalize_user_memory_entries, normalize_user_review_model_settings,
        normalize_user_review_model_settings_input,
    },
    settings_types::{
        UserAgentLimitsSettings, UserConfigFile, UserMemorySettings, UserReviewModelSettings,
        UserSpeechToTextSettings, UserVoiceSettings, UserWebSearchSettings,
    },
    user_config::{load_user_config_file, write_user_config_file},
};
use crate::runtime_contract_generated::{
    AGENT_CLI_PROVIDERS, AGENT_CLI_PROVIDER_ENV_KEYS, PROVIDER_ENV_KEYS, USER_API_PROVIDERS,
    USER_AUDIO_AI_PROVIDERS, USER_WEB_SEARCH_PROVIDERS, VALID_WEB_SEARCH_PROVIDERS,
    WEB_SEARCH_ENV_KEYS,
};

fn is_user_api_provider(value: &str) -> bool {
    USER_API_PROVIDERS.contains(&value)
}

fn user_api_provider_description() -> String {
    USER_API_PROVIDERS.join(", ")
}

fn is_agent_cli_provider(value: &str) -> bool {
    AGENT_CLI_PROVIDERS.contains(&value)
}

fn is_user_web_search_provider(value: &str) -> bool {
    USER_WEB_SEARCH_PROVIDERS.contains(&value)
}

fn is_user_audio_ai_provider(value: &str) -> bool {
    USER_AUDIO_AI_PROVIDERS.contains(&value)
}

fn is_valid_web_search_provider(value: &str) -> bool {
    VALID_WEB_SEARCH_PROVIDERS.contains(&value)
}

fn update_user_config(update: impl FnOnce(&mut UserConfigFile)) -> Result<PathBuf, String> {
    let (mut config, config_path) = load_user_config_file()?;
    update(&mut config);
    write_user_config_file(&config, &config_path)?;
    Ok(config_path)
}

pub(super) fn load_user_api_keys() -> Result<HashMap<String, String>, String> {
    let (config, _) = load_user_config_file()?;

    Ok(config
        .api_keys
        .into_iter()
        .filter_map(|(provider, value)| {
            let normalized_provider = normalize_optional_string(Some(provider.as_str()))?;
            let normalized_value = normalize_optional_string(Some(value.as_str()))?;

            if is_user_api_provider(&normalized_provider)
                && has_configured_value(Some(normalized_value.as_str()))
            {
                Some((normalized_provider, normalized_value))
            } else {
                None
            }
        })
        .collect())
}

fn load_user_agent_cli_paths() -> Result<HashMap<String, String>, String> {
    let (config, _) = load_user_config_file()?;

    Ok(config
        .agent_cli_paths
        .into_iter()
        .filter_map(|(provider, value)| {
            let normalized_provider = normalize_optional_string(Some(provider.as_str()))?;
            let normalized_value = normalize_optional_string(Some(value.as_str()))?;

            if is_agent_cli_provider(&normalized_provider) {
                Some((normalized_provider, normalized_value))
            } else {
                None
            }
        })
        .collect())
}

fn load_user_web_search_api_keys() -> Result<HashMap<String, String>, String> {
    let (config, _) = load_user_config_file()?;

    Ok(config
        .web_search
        .api_keys
        .into_iter()
        .filter_map(|(provider, value)| {
            let normalized_provider = normalize_optional_string(Some(provider.as_str()))?;
            let normalized_value = normalize_optional_string(Some(value.as_str()))?;

            if is_user_web_search_provider(&normalized_provider)
                && has_configured_value(Some(normalized_value.as_str()))
            {
                Some((normalized_provider, normalized_value))
            } else {
                None
            }
        })
        .collect())
}

pub(crate) fn merge_user_api_keys_into_env(
    values: &mut HashMap<String, String>,
) -> Result<(), String> {
    let api_keys = load_user_api_keys()?;

    for (provider, env_key) in PROVIDER_ENV_KEYS {
        if let Some(value) = api_keys.get(provider) {
            values.insert(env_key.to_string(), value.clone());
        }
    }

    Ok(())
}

pub(crate) fn merge_user_agent_cli_paths_into_env(
    values: &mut HashMap<String, String>,
) -> Result<(), String> {
    let paths = load_user_agent_cli_paths()?;

    for (provider, env_key) in AGENT_CLI_PROVIDER_ENV_KEYS {
        if let Some(value) = paths.get(provider) {
            values.insert(env_key.to_string(), value.clone());
        }
    }

    Ok(())
}

pub(crate) fn merge_user_web_search_api_keys_into_env(
    values: &mut HashMap<String, String>,
) -> Result<(), String> {
    let api_keys = load_user_web_search_api_keys()?;

    for (provider, env_key) in WEB_SEARCH_ENV_KEYS {
        if let Some(value) = api_keys.get(provider) {
            values.insert(env_key.to_string(), value.clone());
        }
    }

    Ok(())
}

pub(super) fn save_user_api_key(provider: &str, api_key: &str) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider)).ok_or_else(|| {
        format!(
            "Expected provider to be one of {}.",
            user_api_provider_description()
        )
    })?;
    let normalized_api_key = normalize_optional_string(Some(api_key))
        .ok_or_else(|| "Expected a non-empty API key.".to_string())?;

    if !is_user_api_provider(&normalized_provider) {
        return Err(format!(
            "Expected provider to be one of {}.",
            user_api_provider_description()
        ));
    }

    update_user_config(|config| {
        config
            .api_keys
            .insert(normalized_provider, normalized_api_key);
    })
}

pub(super) fn load_user_web_search_settings() -> Result<UserWebSearchSettings, String> {
    let (config, _) = load_user_config_file()?;
    let env = load_global_env()?;

    Ok(UserWebSearchSettings {
        active_provider: resolve_web_search_active_provider(
            config.web_search.active_provider.as_deref(),
            &env,
        ),
        api_keys: load_user_web_search_api_keys()?,
        provider_availability: get_web_search_provider_availability(&env),
    })
}

pub(super) fn load_user_voice_settings() -> Result<UserVoiceSettings, String> {
    let (config, _) = load_user_config_file()?;
    let env = load_global_env()?;

    Ok(UserVoiceSettings {
        active_provider: resolve_audio_active_provider(config.voice.active_provider.as_deref()),
        provider_availability: get_audio_provider_availability(&env),
    })
}

pub(super) fn load_user_speech_to_text_settings() -> Result<UserSpeechToTextSettings, String> {
    let (config, _) = load_user_config_file()?;
    let env = load_global_env()?;

    Ok(UserSpeechToTextSettings {
        active_provider: resolve_audio_active_provider(
            config.speech_to_text.active_provider.as_deref(),
        ),
        input_device_id: normalize_optional_string(
            config.speech_to_text.input_device_id.as_deref(),
        ),
        provider_availability: get_audio_provider_availability(&env),
    })
}

pub(super) fn load_user_memory_settings() -> Result<UserMemorySettings, String> {
    let (config, _) = load_user_config_file()?;

    Ok(UserMemorySettings {
        global_enabled: config.memory.global_enabled.unwrap_or(false),
        entries: normalize_user_memory_entries(&config.memory.entries, "global"),
    })
}

pub(super) fn load_user_review_model_settings() -> Result<UserReviewModelSettings, String> {
    let (config, _) = load_user_config_file()?;

    Ok(normalize_user_review_model_settings(&config.review_model))
}

pub(super) fn save_user_web_search_api_key_value(
    provider: &str,
    api_key: &str,
) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider)).ok_or_else(|| {
        "Expected provider to be one of perplexity, tavily, or serper.".to_string()
    })?;
    let normalized_api_key = normalize_optional_string(Some(api_key))
        .ok_or_else(|| "Expected a non-empty API key.".to_string())?;

    if !is_user_web_search_provider(&normalized_provider) {
        return Err("Expected provider to be one of perplexity, tavily, or serper.".to_string());
    }

    update_user_config(|config| {
        config
            .web_search
            .api_keys
            .insert(normalized_provider, normalized_api_key);
    })
}

pub(super) fn save_user_web_search_active_provider_value(
    provider: &str,
) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider)).ok_or_else(|| {
        "Expected provider to be one of none, perplexity, tavily, or serper.".to_string()
    })?;

    if !is_valid_web_search_provider(&normalized_provider) {
        return Err(
            "Expected provider to be one of none, perplexity, tavily, or serper.".to_string(),
        );
    }

    update_user_config(|config| {
        config.web_search.active_provider = Some(normalized_provider.clone());
    })
}

pub(super) fn save_user_voice_active_provider_value(provider: &str) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider))
        .ok_or_else(|| "Expected provider to be one of none, openai, or google.".to_string())?;

    if !is_user_audio_ai_provider(&normalized_provider) && normalized_provider != "none" {
        return Err("Expected provider to be one of none, openai, or google.".to_string());
    }

    update_user_config(|config| {
        config.voice.active_provider = Some(normalized_provider.clone());
    })
}

pub(super) fn save_user_speech_to_text_active_provider_value(
    provider: &str,
) -> Result<PathBuf, String> {
    let normalized_provider = normalize_optional_string(Some(provider))
        .ok_or_else(|| "Expected provider to be one of none, openai, or google.".to_string())?;

    if !is_user_audio_ai_provider(&normalized_provider) && normalized_provider != "none" {
        return Err("Expected provider to be one of none, openai, or google.".to_string());
    }

    update_user_config(|config| {
        config.speech_to_text.active_provider = Some(normalized_provider.clone());
    })
}

pub(super) fn save_user_speech_to_text_input_device_value(
    input_device_id: Option<&str>,
) -> Result<PathBuf, String> {
    update_user_config(|config| {
        config.speech_to_text.input_device_id = normalize_optional_string(input_device_id);
    })
}

pub(super) fn save_user_global_memory_enabled_value(enabled: bool) -> Result<PathBuf, String> {
    update_user_config(|config| {
        config.memory.global_enabled = Some(enabled);
        config.memory.entries = normalize_user_memory_entries(&config.memory.entries, "global");
    })
}

pub(super) fn load_user_agent_limits_settings() -> Result<UserAgentLimitsSettings, String> {
    let (config, _) = load_user_config_file()?;

    Ok(normalize_user_agent_limits_settings(&config.agent_limits))
}

pub(super) fn save_user_agent_limits_settings_value(
    settings: &UserAgentLimitsSettings,
) -> Result<PathBuf, String> {
    let normalized_settings = normalize_user_agent_limits_settings_input(settings);

    update_user_config(|config| {
        config.agent_limits.infinite = Some(normalized_settings.infinite);
        config.agent_limits.executor_turns = Some(normalized_settings.executor_turns);
        config.agent_limits.autopilot_executor_iterations =
            Some(normalized_settings.autopilot_executor_iterations);
    })
}

pub(super) fn save_user_review_model_settings_value(
    settings: &UserReviewModelSettings,
) -> Result<PathBuf, String> {
    let normalized_settings = normalize_user_review_model_settings_input(settings);

    update_user_config(|config| {
        config.review_model.mode = Some(normalized_settings.mode.clone());
        config.review_model.provider = normalized_settings.provider.clone();
        config.review_model.model = normalized_settings.model.clone();
    })
}
