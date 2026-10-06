use serde::{de::Error, Deserializer};
use serde_json::Value;

mod transfer;

fn fields<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Option<&'a serde_json::Map<String, Value>> {
    let object = value.as_object()?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return None;
    }
    Some(object)
}

fn text(value: &Value, maximum: usize, nonempty: bool) -> bool {
    value.as_str().is_some_and(|text| {
        (!nonempty || !text.is_empty())
            && !text.contains('\0')
            && text.encode_utf16().count() <= maximum
    })
}

fn integer(value: &Value) -> bool {
    value.as_u64().is_some_and(|number| number <= 3_600_000)
}

fn settings(
    value: &Value,
    booleans: &[&str],
    integers: &[&str],
    strings: &[&str],
    numbers: &[&str],
) -> bool {
    let keys: Vec<_> = booleans
        .iter()
        .chain(integers)
        .chain(strings)
        .chain(numbers)
        .copied()
        .collect();
    fields(value, &keys, &[]).is_some()
        && booleans.iter().all(|key| value[key].is_boolean())
        && integers.iter().all(|key| integer(&value[key]))
        && strings.iter().all(|key| text(&value[key], 240, false))
        && numbers.iter().all(|key| {
            value[key]
                .as_f64()
                .is_some_and(|number| (0.0..=60.0).contains(&number))
        })
}

pub fn valid_device_settings_invocation(command: &str, args: &Value) -> bool {
    if let Some(valid) = transfer::validate(command, args) {
        return valid;
    }
    match command {
        "save_device_appearance" => {
            let value = &args["settings"];
            fields(args, &["settings"], &[]).is_some()
                && fields(value, &["version", "theme", "density", "accent"], &[]).is_some()
                && value["version"] == 1
                && matches!(value["theme"].as_str(), Some("dark" | "light"))
                && matches!(value["density"].as_str(), Some("comfortable" | "compact"))
                && matches!(
                    value["accent"].as_str(),
                    Some("sky" | "emerald" | "violet" | "amber")
                )
        }
        "get_device_appearance"
        | "get_device_voice_preferences"
        | "refresh_device_speech_input_devices" => fields(args, &[], &[]).is_some(),
        "save_device_voice_preferences" => {
            fields(
                args,
                &["preferredVoiceURI", "rate", "autoSpeakResponses"],
                &[],
            )
            .is_some()
                && (args["preferredVoiceURI"].is_null()
                    || text(&args["preferredVoiceURI"], 8192, false))
                && args["rate"]
                    .as_f64()
                    .is_some_and(|value| (0.8..=1.4).contains(&value))
                && args["autoSpeakResponses"].is_boolean()
        }
        "get_global_provider_availability"
        | "get_provider_model_catalog"
        | "get_user_provider_api_keys"
        | "get_user_answer_language"
        | "get_user_web_search_settings"
        | "get_user_voice_settings"
        | "get_user_speech_to_text_settings"
        | "get_user_desktop_settings"
        | "get_user_memory_settings"
        | "get_user_agent_limits_settings"
        | "get_user_workspace_run_settings"
        | "get_user_review_model_settings"
        | "get_user_internal_task_model_settings"
        | "get_user_mcp_config_document" => fields(args, &[], &[]).is_some(),
        "save_user_answer_language" => {
            fields(args, &["language"], &[]).is_some() && text(&args["language"], 8192, false)
        }
        "save_user_provider_api_key" | "save_user_web_search_api_key" => {
            fields(args, &["provider", "apiKey"], &[]).is_some()
                && text(&args["provider"], 240, true)
                && text(&args["apiKey"], 8192, true)
        }
        "delete_user_provider_api_key"
        | "delete_user_web_search_api_key"
        | "save_user_web_search_active_provider"
        | "save_user_voice_active_provider"
        | "save_user_speech_to_text_active_provider" => {
            fields(args, &["provider"], &[]).is_some() && text(&args["provider"], 240, true)
        }
        "save_user_speech_to_text_input_device" => {
            fields(args, &["inputDeviceId"], &[]).is_some()
                && (args["inputDeviceId"].is_null() || text(&args["inputDeviceId"], 8192, false))
        }
        "save_user_speech_to_text_key_terms" => {
            fields(args, &["keyTerms"], &[]).is_some()
                && args["keyTerms"].as_array().is_some_and(|terms| {
                    terms.len() <= 256 && terms.iter().all(|term| text(term, 240, false))
                })
        }
        "save_user_speech_to_text_context" => {
            fields(args, &["speechContext"], &[]).is_some()
                && text(&args["speechContext"], 8192, false)
        }
        "save_user_speech_to_text_processing" => {
            fields(args, &["autoTranslateToEnglish", "autoFormat"], &[]).is_some()
                && args["autoTranslateToEnglish"].is_boolean()
                && args["autoFormat"].is_boolean()
        }
        "save_user_global_memory_enabled" | "save_user_workspace_memory_default_enabled" => {
            fields(args, &["enabled"], &[]).is_some() && args["enabled"].is_boolean()
        }
        "forget_user_global_memory_entry" => {
            fields(args, &["id"], &[]).is_some() && text(&args["id"], 240, true)
        }
        "save_user_desktop_settings" => {
            fields(args, &["settings"], &[]).is_some()
                && settings(
                    &args["settings"],
                    &[
                        "autostartEnabled",
                        "autostartMinimized",
                        "autostartToTray",
                        "alwaysRunAsAdministrator",
                        "adaptiveControllerEnabled",
                        "quickVoiceEnabled",
                    ],
                    &[
                        "aiContextMaxMessages",
                        "chatIdleTimeoutMinutes",
                        "inactiveSessionArchiveDays",
                        "archivedSessionRetentionDays",
                        "quickVoiceMaxMessages",
                    ],
                    &["quickVoiceShortcut"],
                    &["quickVoiceSilenceSeconds"],
                )
        }
        "save_user_agent_limits_settings" => {
            fields(args, &["settings"], &[]).is_some()
                && settings(
                    &args["settings"],
                    &["automaticRetries", "infinite"],
                    &[
                        "retryAttempts",
                        "executorTurns",
                        "autopilotExecutorIterations",
                    ],
                    &[],
                    &[],
                )
        }
        "save_user_workspace_run_settings" => {
            fields(args, &["settings"], &[]).is_some()
                && settings(
                    &args["settings"],
                    &[],
                    &[
                        "startupDelayMs",
                        "healthCheckIntervalMs",
                        "healthCheckTimeoutMs",
                        "healthCheckFailureThreshold",
                        "sequentialReadinessTimeoutMs",
                    ],
                    &[],
                    &[],
                )
        }
        "save_user_review_model_settings" | "save_user_internal_task_model_settings" => {
            let internal = command == "save_user_internal_task_model_settings";
            let key = if internal { "reasoning" } else { "mode" };
            fields(args, &["settings"], &[]).is_some()
                && fields(&args["settings"], &[key], &["provider", "model"]).is_some()
                && if internal {
                    text(&args["settings"][key], 240, true)
                } else {
                    matches!(args["settings"][key].as_str(), Some("base" | "dedicated"))
                }
                && args["settings"]
                    .get("provider")
                    .is_none_or(|value| text(value, 240, true))
                && args["settings"]
                    .get("model")
                    .is_none_or(|value| text(value, 8192, false))
        }
        "save_user_mcp_config_document" => {
            fields(args, &["raw", "expectedRaw"], &[]).is_some()
                && text(&args["raw"], 1_048_576, false)
                && text(&args["expectedRaw"], 1_048_576, false)
        }
        _ => false,
    }
}

pub fn deserialize_device_settings_request<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Value, D::Error> {
    let value = <Value as serde::Deserialize>::deserialize(deserializer)?;
    if !crate::operation::valid_request(&value, valid_device_settings_invocation) {
        return Err(D::Error::custom("Invalid device settings operation."));
    }
    Ok(value)
}
