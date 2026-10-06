use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};

use crate::runtime_snapshot;

pub(super) fn parse<T: DeserializeOwned>(args: &Value, field: &str) -> Result<T, Value> {
    serde_json::from_value(args[field].clone()).map_err(|error| json!(error.to_string()))
}

pub(super) fn encoded<T: Serialize, E: Serialize>(result: Result<T, E>) -> Result<Value, Value> {
    let value = result.map_err(|error| json!(error))?;
    serde_json::to_value(value).map_err(|error| json!(error.to_string()))
}

pub(crate) async fn invoke(
    app: &tauri::AppHandle,
    command: &str,
    args: &Value,
) -> Result<Value, Value> {
    if !machdoch_fleet_protocol::device_settings::valid_device_settings_invocation(command, args) {
        return Err(json!("Invalid device settings operation."));
    }
    if matches!(
        command,
        "get_device_appearance"
            | "save_device_appearance"
            | "get_device_voice_preferences"
            | "save_device_voice_preferences"
            | "refresh_device_speech_input_devices"
    ) {
        return super::client_requests::invoke(app, command, args).await;
    }
    if command.contains("settings_transfer") || command.contains("encrypted_settings_file") {
        return super::device_settings_transfer::invoke(app, command, args).await;
    }
    let result = match command {
        "get_global_provider_availability" => {
            encoded(runtime_snapshot::get_global_provider_availability().await)
        }
        "get_provider_model_catalog" => {
            encoded(runtime_snapshot::get_provider_model_catalog().await)
        }
        "get_user_provider_api_keys" => {
            encoded(runtime_snapshot::get_user_provider_api_keys().await)
        }
        "get_user_answer_language" => encoded(runtime_snapshot::get_user_answer_language().await),
        "get_user_web_search_settings" => {
            encoded(runtime_snapshot::get_user_web_search_settings().await)
        }
        "get_user_voice_settings" => encoded(runtime_snapshot::get_user_voice_settings().await),
        "get_user_speech_to_text_settings" => {
            encoded(runtime_snapshot::get_user_speech_to_text_settings().await)
        }
        "get_user_memory_settings" => encoded(runtime_snapshot::get_user_memory_settings().await),
        "get_user_agent_limits_settings" => {
            encoded(runtime_snapshot::get_user_agent_limits_settings().await)
        }
        "get_user_workspace_run_settings" => {
            encoded(runtime_snapshot::get_user_workspace_run_settings().await)
        }
        "get_user_review_model_settings" => {
            encoded(runtime_snapshot::get_user_review_model_settings().await)
        }
        "get_user_internal_task_model_settings" => {
            encoded(runtime_snapshot::get_user_internal_task_model_settings().await)
        }
        "get_user_mcp_config_document" => {
            encoded(runtime_snapshot::get_user_mcp_config_document().await)
        }
        "get_user_desktop_settings" => {
            encoded(runtime_snapshot::get_user_desktop_settings(app.clone()).await)
        }
        "save_user_answer_language" => {
            encoded(runtime_snapshot::save_user_answer_language(parse(args, "language")?).await)
        }
        "save_user_provider_api_key" => encoded(
            runtime_snapshot::save_user_provider_api_key(
                parse(args, "provider")?,
                parse(args, "apiKey")?,
            )
            .await,
        ),
        "save_user_web_search_api_key" => encoded(
            runtime_snapshot::save_user_web_search_api_key(
                parse(args, "provider")?,
                parse(args, "apiKey")?,
            )
            .await,
        ),
        "delete_user_provider_api_key" => {
            encoded(runtime_snapshot::delete_user_provider_api_key(parse(args, "provider")?).await)
        }
        "delete_user_web_search_api_key" => encoded(
            runtime_snapshot::delete_user_web_search_api_key(parse(args, "provider")?).await,
        ),
        "save_user_web_search_active_provider" => encoded(
            runtime_snapshot::save_user_web_search_active_provider(parse(args, "provider")?).await,
        ),
        "save_user_voice_active_provider" => encoded(
            runtime_snapshot::save_user_voice_active_provider(parse(args, "provider")?).await,
        ),
        "save_user_speech_to_text_active_provider" => encoded(
            runtime_snapshot::save_user_speech_to_text_active_provider(parse(args, "provider")?)
                .await,
        ),
        "save_user_speech_to_text_input_device" => encoded(
            runtime_snapshot::save_user_speech_to_text_input_device(parse(args, "inputDeviceId")?)
                .await,
        ),
        "save_user_speech_to_text_key_terms" => encoded(
            runtime_snapshot::save_user_speech_to_text_key_terms(parse(args, "keyTerms")?).await,
        ),
        "save_user_speech_to_text_context" => encoded(
            runtime_snapshot::save_user_speech_to_text_context(parse(args, "speechContext")?).await,
        ),
        "save_user_speech_to_text_processing" => encoded(
            runtime_snapshot::save_user_speech_to_text_processing(
                parse(args, "autoTranslateToEnglish")?,
                parse(args, "autoFormat")?,
            )
            .await,
        ),
        "save_user_global_memory_enabled" => encoded(
            runtime_snapshot::save_user_global_memory_enabled(parse(args, "enabled")?).await,
        ),
        "save_user_workspace_memory_default_enabled" => encoded(
            runtime_snapshot::save_user_workspace_memory_default_enabled(parse(args, "enabled")?)
                .await,
        ),
        "forget_user_global_memory_entry" => {
            encoded(runtime_snapshot::forget_user_global_memory_entry(parse(args, "id")?).await)
        }
        "save_user_desktop_settings" => encoded(
            runtime_snapshot::save_user_desktop_settings(app.clone(), parse(args, "settings")?)
                .await,
        ),
        "save_user_agent_limits_settings" => encoded(
            runtime_snapshot::save_user_agent_limits_settings(parse(args, "settings")?).await,
        ),
        "save_user_workspace_run_settings" => encoded(
            runtime_snapshot::save_user_workspace_run_settings(parse(args, "settings")?).await,
        ),
        "save_user_review_model_settings" => encoded(
            runtime_snapshot::save_user_review_model_settings(parse(args, "settings")?).await,
        ),
        "save_user_internal_task_model_settings" => encoded(
            runtime_snapshot::save_user_internal_task_model_settings(parse(args, "settings")?)
                .await,
        ),
        "save_user_mcp_config_document" => encoded(
            runtime_snapshot::save_user_mcp_config_document(
                app.state(),
                parse(args, "raw")?,
                Some(parse(args, "expectedRaw")?),
            )
            .await,
        ),
        _ => return Err(json!("Unknown device settings operation.")),
    }?;
    let kind = match command {
        "save_user_answer_language" => Some("answer-language"),
        "save_user_provider_api_key" | "delete_user_provider_api_key" => Some("provider-keys"),
        "save_user_web_search_api_key"
        | "delete_user_web_search_api_key"
        | "save_user_web_search_active_provider" => Some("web-search"),
        "save_user_voice_active_provider" => Some("voice"),
        "save_user_speech_to_text_active_provider"
        | "save_user_speech_to_text_input_device"
        | "save_user_speech_to_text_key_terms"
        | "save_user_speech_to_text_context"
        | "save_user_speech_to_text_processing" => Some("speech-to-text"),
        "save_user_global_memory_enabled"
        | "save_user_workspace_memory_default_enabled"
        | "forget_user_global_memory_entry" => Some("memory"),
        "save_user_agent_limits_settings" => Some("agent-limits"),
        "save_user_workspace_run_settings" => Some("workspace-run"),
        "save_user_review_model_settings" => Some("review-model"),
        "save_user_internal_task_model_settings" => Some("internal-task-model"),
        "save_user_mcp_config_document" => Some("mcp"),
        _ => None,
    };
    if command == "save_user_desktop_settings" {
        app.emit("machdoch://desktop-settings-changed", &result).map_err(|error| json!(format!("Settings were saved, but the client could not refresh: {error}. Refresh settings.")))?;
    }
    if let Some(kind) = kind {
        app.emit(
            "machdoch://user-settings-changed",
            json!({"kind": kind, "updatedAt": super::now_millis()}),
        )
        .map_err(|error| {
            json!(format!(
                "Settings were saved, but the client could not refresh: {error}. Refresh settings."
            ))
        })?;
    }
    Ok(result)
}
