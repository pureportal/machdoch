use std::{collections::HashMap, time::Duration};

use super::super::normalize_optional_string;
use super::{
    command::run_agent_cli_command,
    normalize::{
        json_bool_from_keys, json_date_prefix, json_string, looks_like_dated_snapshot,
        runtime_model_stage,
    },
    resolve_agent_cli_binary, ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
};

const CANONICAL_REASONING_MODES: [&str; 8] = [
    "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
];

fn json_string_from_keys(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(entry) = json_string(value, key) {
            return Some(entry);
        }
    }

    None
}

fn json_u64_from_keys(value: Option<&serde_json::Value>, keys: &[&str]) -> Option<u64> {
    let value = value?;

    for key in keys {
        if let Some(entry) = value
            .get(*key)
            .and_then(serde_json::Value::as_u64)
            .filter(|entry| *entry > 0)
        {
            return Some(entry);
        }

        if let Some(entry) = json_string(value, key)
            .and_then(|entry| entry.parse::<u64>().ok())
            .filter(|entry| *entry > 0)
        {
            return Some(entry);
        }
    }

    None
}

fn json_string_array_from_keys(
    value: Option<&serde_json::Value>,
    keys: &[&str],
) -> Option<Vec<String>> {
    let value = value?;

    for key in keys {
        let Some(entries) = value.get(*key).and_then(serde_json::Value::as_array) else {
            continue;
        };
        let normalized = entries
            .iter()
            .filter_map(|entry| {
                entry
                    .as_str()
                    .map(str::to_string)
                    .or_else(|| json_string_from_keys(entry, &["effort", "mode", "value", "name"]))
            })
            .map(|entry| entry.trim().to_ascii_lowercase())
            .filter(|entry| CANONICAL_REASONING_MODES.contains(&entry.as_str()))
            .fold(Vec::new(), |mut modes, mode| {
                if !modes.contains(&mode) {
                    modes.push(mode);
                }
                modes
            });

        return Some(normalized);
    }

    None
}

fn codex_reasoning_modes(entry: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let mut modes = json_string_array_from_keys(
        entry,
        &[
            "supportedReasoningLevels",
            "supported_reasoning_levels",
            "supportedReasoningEfforts",
            "supported_reasoning_efforts",
            "reasoningEfforts",
            "reasoning_efforts",
        ],
    )?;
    modes.insert(0, "default".to_string());

    Some(modes)
}

fn is_numeric_model_version(value: &str) -> bool {
    value
        .split('.')
        .all(|part| !part.is_empty() && part.chars().all(|character| character.is_ascii_digit()))
}

fn is_codex_cli_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if normalized == "auto" || looks_like_dated_snapshot(&normalized) {
        return false;
    }

    if let Some(suffix) = normalized.strip_prefix("gpt-") {
        let mut parts = suffix.split('-');
        let Some(version) = parts.next() else {
            return false;
        };

        if !is_numeric_model_version(version) {
            return false;
        }

        let suffix_parts = parts.collect::<Vec<_>>();

        return matches!(
            suffix_parts.as_slice(),
            [] | ["preview"]
                | ["mini" | "nano" | "sol" | "terra" | "luna"]
                | ["mini" | "nano", "preview"]
                | ["codex", ..]
        );
    }

    false
}

fn entry_marks_model_unavailable(entry: Option<&serde_json::Value>) -> bool {
    let lifecycle = entry.and_then(|entry| {
        json_string_from_keys(
            entry,
            &[
                "stage",
                "lifecycle",
                "status",
                "availability",
                "releaseStage",
                "release_stage",
            ],
        )
    });
    let visibility = entry.and_then(|entry| json_string_from_keys(entry, &["visibility"]));

    lifecycle.is_some_and(|value| value.to_ascii_lowercase().contains("deprecated"))
        || visibility
            .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "hide" | "none"))
}

fn codex_image_input(entry: Option<&serde_json::Value>) -> Option<bool> {
    if let Some(explicit) = json_bool_from_keys(
        entry,
        &[
            "imageInput",
            "image_input",
            "supportsImages",
            "supports_images",
            "supportsImageInput",
            "supports_image_input",
        ],
    ) {
        return Some(explicit);
    }

    let entry = entry?;

    for key in ["inputModalities", "input_modalities"] {
        if let Some(modalities) = entry.get(key).and_then(serde_json::Value::as_array) {
            return Some(modalities.iter().any(|modality| {
                modality
                    .as_str()
                    .is_some_and(|modality| modality.eq_ignore_ascii_case("image"))
            }));
        }
    }

    None
}

fn create_codex_cli_runtime_model(
    model_id: &str,
    entry: Option<&serde_json::Value>,
) -> ProviderRuntimeModel {
    let normalized = model_id.to_ascii_lowercase();
    let is_fast_model = normalized.contains("mini")
        || normalized.contains("nano")
        || normalized.contains("luna")
        || normalized.contains("codex-spark")
        || normalized.contains("haiku")
        || normalized.contains("flash");
    let is_text_only_preview = normalized.contains("codex-spark");
    let computer_use = json_bool_from_keys(
        entry,
        &[
            "computerUse",
            "computer_use",
            "supportsComputerUse",
            "supports_computer_use",
        ],
    );
    let mut recommended_for = vec!["coding".to_string()];

    if is_fast_model {
        recommended_for.push("fast".to_string());
    }

    if normalized.contains("mini") || normalized.contains("nano") || normalized.contains("luna") {
        recommended_for.push("cheap".to_string());
    }

    if computer_use == Some(true) {
        recommended_for.push("computer-use".to_string());
    }

    let label = entry
        .and_then(|entry| {
            json_string_from_keys(entry, &["label", "displayName", "display_name", "title"])
        })
        .filter(|label| label.to_ascii_lowercase() != normalized);
    let stage = entry
        .and_then(|entry| json_string_from_keys(entry, &["stage", "lifecycle"]))
        .or_else(|| runtime_model_stage(model_id))
        .or_else(|| is_text_only_preview.then(|| "preview".to_string()));
    let release_date = entry.and_then(|entry| {
        json_date_prefix(entry, "releaseDate")
            .or_else(|| json_date_prefix(entry, "release_date"))
            .or_else(|| json_date_prefix(entry, "createdAt"))
            .or_else(|| json_date_prefix(entry, "created_at"))
    });
    let reasoning_modes = codex_reasoning_modes(entry);
    let default_reasoning_mode = entry
        .and_then(|entry| {
            json_string_from_keys(
                entry,
                &[
                    "defaultReasoningEffort",
                    "default_reasoning_effort",
                    "defaultReasoningLevel",
                    "default_reasoning_level",
                    "defaultReasoningMode",
                    "default_reasoning_mode",
                ],
            )
        })
        .map(|mode| mode.to_ascii_lowercase())
        .filter(|mode| CANONICAL_REASONING_MODES.contains(&mode.as_str()));
    let image_input = codex_image_input(entry).or_else(|| is_text_only_preview.then_some(false));

    if image_input == Some(true) {
        recommended_for.push("vision".to_string());
    }
    ProviderRuntimeModel {
        id: normalized,
        label,
        stage,
        release_date,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input,
            tool_use: Some(true),
            reasoning: reasoning_modes.as_ref().map(|modes| modes.len() > 1),
            streaming: Some(true),
            context_window_tokens: json_u64_from_keys(
                entry,
                &[
                    "contextWindowTokens",
                    "context_window_tokens",
                    "contextWindow",
                    "context_window",
                    "maxInputTokens",
                    "max_input_tokens",
                    "inputTokenLimit",
                ],
            ),
            long_context_window_tokens: json_u64_from_keys(
                entry,
                &["maxContextWindow", "max_context_window"],
            ),
            max_output_tokens: json_u64_from_keys(
                entry,
                &[
                    "maxOutputTokens",
                    "max_output_tokens",
                    "maxTokens",
                    "max_tokens",
                    "outputTokenLimit",
                ],
            ),
            reasoning_modes,
            default_reasoning_mode,
            supported_image_media_types: None,
            voice: Some(false),
            computer_use,
        },
        warnings: if is_text_only_preview {
            vec![
                "Research preview model; verify local Codex CLI availability before production use."
                    .to_string(),
            ]
        } else {
            Vec::new()
        },
        source: "provider-probe".to_string(),
    }
}

fn add_codex_cli_catalog_model(
    by_id: &mut HashMap<String, ProviderRuntimeModel>,
    model_id: &str,
    entry: Option<&serde_json::Value>,
) {
    let Some(normalized) = normalize_optional_string(Some(model_id)) else {
        return;
    };
    let normalized = normalized.to_ascii_lowercase();

    if !is_codex_cli_runtime_model(&normalized) {
        return;
    }

    if entry_marks_model_unavailable(entry) {
        return;
    }

    by_id
        .entry(normalized.clone())
        .or_insert_with(|| create_codex_cli_runtime_model(&normalized, entry));
}

fn parse_json_payload(raw: &str) -> Result<serde_json::Value, String> {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return Err("Codex CLI returned an empty model catalog.".to_string());
    }

    serde_json::from_str(trimmed).or_else(|primary_error| {
        let candidates = [
            (trimmed.find('{'), trimmed.rfind('}')),
            (trimmed.find('['), trimmed.rfind(']')),
        ];

        for (first, last) in candidates {
            if let (Some(first), Some(last)) = (first, last) {
                if first < last {
                    if let Ok(payload) = serde_json::from_str(&trimmed[first..=last]) {
                        return Ok(payload);
                    }
                }
            }
        }

        Err(format!(
            "Failed to parse Codex CLI model catalog JSON: {primary_error}"
        ))
    })
}

pub(super) fn parse_codex_cli_model_catalog(
    raw: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = parse_json_payload(raw)?;
    let mut by_id = HashMap::<String, ProviderRuntimeModel>::new();
    let entries = payload
        .get("models")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Codex CLI model catalog did not contain a models array.".to_string())?;

    for entry in entries {
        if let Some(model_id) = json_string(entry, "slug") {
            add_codex_cli_catalog_model(&mut by_id, &model_id, Some(entry));
        }
    }

    let mut models = by_id.into_values().collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));

    if models.is_empty() {
        return Err("Codex CLI did not return any supported model IDs.".to_string());
    }

    Ok(models)
}

pub(super) fn fetch_codex_cli_model_catalog(
    env: &HashMap<String, String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let Some(binary) = resolve_agent_cli_binary("codex-cli", env) else {
        return Err(
            "Codex CLI binary was not found. Configure MACHDOCH_CODEX_CLI_PATH or install `codex` on PATH."
                .to_string(),
        );
    };
    let attempts: [(&[&str], &str); 2] = [
        (&["debug", "models"], "codex debug models"),
        (
            &["debug", "models", "--bundled"],
            "codex debug models --bundled",
        ),
    ];
    let mut failures = Vec::new();

    for (args, label) in attempts {
        match run_agent_cli_command(&binary, args, env, Duration::from_secs(12)) {
            Ok(output) if output.exit_code == Some(0) => {
                match parse_codex_cli_model_catalog(&output.stdout) {
                    Ok(models) => return Ok(models),
                    Err(error) => failures.push(format!("{label}: {error}")),
                }
            }
            Ok(output) => {
                let detail = normalize_optional_string(Some(output.stderr.as_str()))
                    .or_else(|| normalize_optional_string(Some(output.stdout.as_str())))
                    .unwrap_or_else(|| {
                        format!(
                            "exited with code {}",
                            output
                                .exit_code
                                .map(|code| code.to_string())
                                .unwrap_or_else(|| "unknown".to_string())
                        )
                    });

                failures.push(format!("{label}: {detail}"));
            }
            Err(error) => failures.push(format!("{label}: {error}")),
        }
    }

    Err(format!(
        "Codex CLI model discovery failed. {}",
        failures.join(" ")
    ))
}
