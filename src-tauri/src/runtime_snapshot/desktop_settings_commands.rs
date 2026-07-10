use std::path::PathBuf;

use tauri_plugin_autostart::ManagerExt as _;

use super::{
    settings::{
        clamp_ai_context_message_limit, clamp_archived_session_retention_days,
        clamp_assistant_bubble_hide_seconds, clamp_inactive_session_archive_days,
        clamp_quick_voice_message_limit, clamp_quick_voice_silence_seconds,
        normalize_user_desktop_settings_input, resolve_quick_voice_shortcut,
    },
    settings_types::{UserDesktopLaunchPreferences, UserDesktopSettings},
    user_config::{load_user_config_file, update_user_config_file},
};
use crate::runtime_contract_generated::{
    DEFAULT_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES,
    DEFAULT_DESKTOP_SETTING_ALWAYS_RUN_AS_ADMINISTRATOR,
    DEFAULT_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_ENABLED,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_HIDE_WHEN_FULLSCREEN,
    DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS,
    DEFAULT_DESKTOP_SETTING_AUTOSTART_MINIMIZED, DEFAULT_DESKTOP_SETTING_AUTOSTART_TO_TRAY,
    DEFAULT_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_ENABLED, DEFAULT_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES,
    DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS,
};

pub(crate) fn load_user_desktop_launch_preferences() -> Result<UserDesktopLaunchPreferences, String>
{
    let (config, _) = load_user_config_file()?;

    Ok(UserDesktopLaunchPreferences {
        autostart_minimized: config
            .desktop
            .autostart_minimized
            .unwrap_or(DEFAULT_DESKTOP_SETTING_AUTOSTART_MINIMIZED),
        autostart_to_tray: config
            .desktop
            .autostart_to_tray
            .unwrap_or(DEFAULT_DESKTOP_SETTING_AUTOSTART_TO_TRAY),
    })
}

pub(crate) fn load_user_desktop_admin_preference() -> Result<bool, String> {
    let (config, _) = load_user_config_file()?;

    Ok(config
        .desktop
        .always_run_as_administrator
        .unwrap_or(DEFAULT_DESKTOP_SETTING_ALWAYS_RUN_AS_ADMINISTRATOR))
}

pub(crate) fn load_user_desktop_settings<R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &M,
) -> Result<UserDesktopSettings, String> {
    let (config, _) = load_user_config_file()?;
    let preferences = load_user_desktop_launch_preferences()?;
    let autostart_enabled = manager
        .autolaunch()
        .is_enabled()
        .map_err(|error| format!("Failed to read the autostart state: {error}"))?;

    Ok(UserDesktopSettings {
        autostart_enabled,
        autostart_minimized: preferences.autostart_minimized,
        autostart_to_tray: preferences.autostart_to_tray,
        always_run_as_administrator: config
            .desktop
            .always_run_as_administrator
            .unwrap_or(DEFAULT_DESKTOP_SETTING_ALWAYS_RUN_AS_ADMINISTRATOR),
        assistant_bubble_enabled: config
            .desktop
            .assistant_bubble_enabled
            .unwrap_or(DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_ENABLED),
        assistant_bubble_hide_when_fullscreen: config
            .desktop
            .assistant_bubble_hide_when_fullscreen
            .unwrap_or(DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_HIDE_WHEN_FULLSCREEN),
        assistant_bubble_temporarily_hide_seconds: clamp_assistant_bubble_hide_seconds(
            config
                .desktop
                .assistant_bubble_temporarily_hide_seconds
                .unwrap_or(DEFAULT_DESKTOP_SETTING_ASSISTANT_BUBBLE_TEMPORARILY_HIDE_SECONDS),
        ),
        ai_context_max_messages: clamp_ai_context_message_limit(
            config
                .desktop
                .ai_context_max_messages
                .unwrap_or(DEFAULT_DESKTOP_SETTING_AI_CONTEXT_MAX_MESSAGES),
        ),
        inactive_session_archive_days: clamp_inactive_session_archive_days(
            config
                .desktop
                .inactive_session_archive_days
                .unwrap_or(DEFAULT_DESKTOP_SETTING_INACTIVE_SESSION_ARCHIVE_DAYS),
        ),
        archived_session_retention_days: clamp_archived_session_retention_days(
            config
                .desktop
                .archived_session_retention_days
                .unwrap_or(DEFAULT_DESKTOP_SETTING_ARCHIVED_SESSION_RETENTION_DAYS),
        ),
        quick_voice_enabled: config
            .desktop
            .quick_voice_enabled
            .unwrap_or(DEFAULT_DESKTOP_SETTING_QUICK_VOICE_ENABLED),
        quick_voice_shortcut: resolve_quick_voice_shortcut(
            config.desktop.quick_voice_shortcut.as_deref(),
        ),
        quick_voice_silence_seconds: clamp_quick_voice_silence_seconds(
            config
                .desktop
                .quick_voice_silence_seconds
                .unwrap_or(DEFAULT_DESKTOP_SETTING_QUICK_VOICE_SILENCE_SECONDS),
        ),
        quick_voice_max_messages: clamp_quick_voice_message_limit(
            config
                .desktop
                .quick_voice_max_messages
                .unwrap_or(DEFAULT_DESKTOP_SETTING_QUICK_VOICE_MAX_MESSAGES),
        ),
    })
}

pub(super) fn save_user_desktop_settings_value<R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &M,
    settings: &UserDesktopSettings,
) -> Result<PathBuf, String> {
    let normalized_settings = normalize_user_desktop_settings_input(settings)?;
    let config_path = update_user_config_file(|config| {
        config.desktop.autostart_minimized = Some(normalized_settings.autostart_minimized);
        config.desktop.autostart_to_tray = Some(normalized_settings.autostart_to_tray);
        config.desktop.always_run_as_administrator =
            Some(normalized_settings.always_run_as_administrator);
        config.desktop.assistant_bubble_enabled =
            Some(normalized_settings.assistant_bubble_enabled);
        config.desktop.assistant_bubble_hide_when_fullscreen =
            Some(normalized_settings.assistant_bubble_hide_when_fullscreen);
        config.desktop.assistant_bubble_temporarily_hide_seconds =
            Some(normalized_settings.assistant_bubble_temporarily_hide_seconds);
        config.desktop.ai_context_max_messages = Some(normalized_settings.ai_context_max_messages);
        config.desktop.inactive_session_archive_days =
            Some(normalized_settings.inactive_session_archive_days);
        config.desktop.archived_session_retention_days =
            Some(normalized_settings.archived_session_retention_days);
        config.desktop.quick_voice_enabled = Some(normalized_settings.quick_voice_enabled);
        config.desktop.quick_voice_shortcut =
            Some(normalized_settings.quick_voice_shortcut.clone());
        config.desktop.quick_voice_silence_seconds =
            Some(normalized_settings.quick_voice_silence_seconds);
        config.desktop.quick_voice_max_messages =
            Some(normalized_settings.quick_voice_max_messages);
    })?;

    let autolaunch = manager.autolaunch();
    let currently_enabled = autolaunch
        .is_enabled()
        .map_err(|error| format!("Failed to read the autostart state: {error}"))?;

    if normalized_settings.autostart_enabled && !currently_enabled {
        autolaunch
            .enable()
            .map_err(|error| format!("Failed to enable autostart: {error}"))?;
    } else if !normalized_settings.autostart_enabled && currently_enabled {
        autolaunch
            .disable()
            .map_err(|error| format!("Failed to disable autostart: {error}"))?;
    }

    Ok(config_path)
}
