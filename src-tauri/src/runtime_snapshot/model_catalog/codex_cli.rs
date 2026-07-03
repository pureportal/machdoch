use std::{collections::HashMap, time::Duration};

use super::super::normalize_optional_string;
use super::{
    command::run_agent_cli_command,
    normalize::{json_date_prefix, json_string, looks_like_dated_snapshot, runtime_model_stage},
    resolve_agent_cli_binary, ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
};

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
        if let Some(entry) = value.get(*key).and_then(serde_json::Value::as_u64) {
            return Some(entry);
        }

        if let Some(entry) = json_string(value, key).and_then(|entry| entry.parse::<u64>().ok()) {
            return Some(entry);
        }
    }

    None
}

fn is_numeric_model_version(value: &str) -> bool {
    value
        .split('.')
        .all(|part| !part.is_empty() && part.chars().all(|character| character.is_ascii_digit()))
}

fn is_deprecated_codex_cli_model(model_id: &str) -> bool {
    matches!(model_id, "gpt-5.2" | "gpt-5.3-codex")
}

fn is_codex_cli_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if normalized == "auto"
        || is_deprecated_codex_cli_model(&normalized)
        || looks_like_dated_snapshot(&normalized)
    {
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

        return match suffix_parts.as_slice() {
            [] => true,
            ["preview"] => true,
            ["mini"] | ["nano"] => true,
            ["mini" | "nano", "preview"] => true,
            ["codex", ..] => true,
            _ => false,
        };
    }

    false
}

fn entry_marks_model_deprecated(entry: Option<&serde_json::Value>) -> bool {
    entry
        .and_then(|entry| {
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
        })
        .is_some_and(|value| value.to_ascii_lowercase().contains("deprecated"))
}

fn create_codex_cli_runtime_model(
    model_id: &str,
    entry: Option<&serde_json::Value>,
) -> ProviderRuntimeModel {
    let normalized = model_id.to_ascii_lowercase();
    let is_fast_model = normalized.contains("mini")
        || normalized.contains("nano")
        || normalized.contains("codex-spark")
        || normalized.contains("haiku")
        || normalized.contains("flash");
    let is_text_only_preview = normalized.contains("codex-spark");
    let computer_use = normalized.starts_with("gpt-5.5") || normalized.starts_with("gpt-5.4");
    let mut recommended_for = vec!["coding".to_string()];

    if !is_text_only_preview {
        recommended_for.push("vision".to_string());
    }

    if is_fast_model {
        recommended_for.push("fast".to_string());
    }

    if normalized.contains("mini") || normalized.contains("nano") {
        recommended_for.push("cheap".to_string());
    }

    if computer_use {
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
    ProviderRuntimeModel {
        id: normalized,
        label,
        stage,
        release_date,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(!is_text_only_preview),
            tool_use: Some(true),
            reasoning: Some(true),
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
            voice: Some(false),
            computer_use: Some(computer_use),
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

    if entry_marks_model_deprecated(entry) {
        return;
    }

    by_id
        .entry(normalized.clone())
        .or_insert_with(|| create_codex_cli_runtime_model(&normalized, entry));
}

fn collect_codex_cli_catalog_models(
    value: &serde_json::Value,
    by_id: &mut HashMap<String, ProviderRuntimeModel>,
) {
    match value {
        serde_json::Value::Array(entries) => {
            for entry in entries {
                if let Some(model_id) = entry.as_str() {
                    add_codex_cli_catalog_model(by_id, model_id, None);
                } else {
                    collect_codex_cli_catalog_models(entry, by_id);
                }
            }
        }
        serde_json::Value::Object(object) => {
            if let Some(model_id) = json_string_from_keys(
                value,
                &["id", "slug", "model", "modelId", "model_id", "name"],
            ) {
                add_codex_cli_catalog_model(by_id, &model_id, Some(value));
            }

            for key in [
                "models",
                "data",
                "entries",
                "modelCatalog",
                "model_catalog",
                "availableModels",
                "available_models",
            ] {
                if let Some(entry) = object.get(key) {
                    collect_codex_cli_catalog_models(entry, by_id);
                }
            }

            for (key, entry) in object {
                if is_codex_cli_runtime_model(key) {
                    add_codex_cli_catalog_model(by_id, key, Some(entry));
                }

                if entry.is_array() || entry.is_object() {
                    collect_codex_cli_catalog_models(entry, by_id);
                }
            }
        }
        _ => {}
    }
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

    collect_codex_cli_catalog_models(&payload, &mut by_id);

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
