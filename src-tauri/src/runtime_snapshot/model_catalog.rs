use std::{
    collections::HashMap,
    io::Read,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use super::{
    env::resolve_agent_cli_binary, has_configured_value, normalize_optional_string,
    ProviderModelCatalogProvider, ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub(super) fn create_provider_model_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("Failed to create provider model HTTP client: {error}"))
}

fn sanitize_provider_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        return "Provider model discovery timed out.".to_string();
    }

    if let Some(status) = error.status() {
        return format!("Provider model discovery returned HTTP {status}.");
    }

    "Provider model discovery failed before a response was received.".to_string()
}

fn provider_model_catalog_unavailable(provider: &str, error: &str) -> ProviderModelCatalogProvider {
    ProviderModelCatalogProvider {
        provider: provider.to_string(),
        source: "provider-probe".to_string(),
        available: false,
        error: Some(error.to_string()),
        models: Vec::new(),
    }
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .and_then(|entry| normalize_optional_string(Some(entry)))
}

fn json_u64(value: &serde_json::Value, key: &str) -> Option<u64> {
    value.get(key).and_then(serde_json::Value::as_u64)
}

fn json_date_prefix(value: &serde_json::Value, key: &str) -> Option<String> {
    let raw = json_string(value, key)?;
    let date = raw.get(..10)?;
    let bytes = date.as_bytes();
    let looks_like_date = bytes.get(4) == Some(&b'-')
        && bytes.get(7) == Some(&b'-')
        && date
            .chars()
            .enumerate()
            .all(|(index, character)| index == 4 || index == 7 || character.is_ascii_digit());

    looks_like_date.then(|| date.to_string())
}

fn unix_seconds_to_utc_date(seconds: u64) -> Option<String> {
    let days = i64::try_from(seconds / 86_400).ok()?;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };

    if month <= 2 {
        year += 1;
    }

    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn json_bool_from_keys(value: Option<&serde_json::Value>, keys: &[&str]) -> Option<bool> {
    let object = value?.as_object()?;

    for key in keys {
        if let Some(value) = object.get(*key).and_then(serde_json::Value::as_bool) {
            return Some(value);
        }
    }

    None
}

fn looks_like_dated_snapshot(model_id: &str) -> bool {
    if model_id.len() >= 10 {
        let tail = &model_id[model_id.len() - 10..];
        let bytes = tail.as_bytes();
        let is_hyphenated_date = bytes.get(4) == Some(&b'-')
            && bytes.get(7) == Some(&b'-')
            && tail
                .chars()
                .enumerate()
                .all(|(index, character)| index == 4 || index == 7 || character.is_ascii_digit());

        if is_hyphenated_date {
            return true;
        }
    }

    let Some(tail) = model_id.rsplit('-').next() else {
        return false;
    };

    tail.len() == 8 && tail.chars().all(|character| character.is_ascii_digit())
}

fn is_openai_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if looks_like_dated_snapshot(&normalized) {
        return false;
    }

    if [
        "embedding",
        "moderation",
        "chatgpt",
        "codex",
        "computer-use",
        "dall",
        "image",
        "realtime",
        "search",
        "sora",
        "tts",
        "transcribe",
        "whisper",
    ]
    .iter()
    .any(|excluded| normalized.contains(excluded))
    {
        return false;
    }

    let Some(suffix) = normalized.strip_prefix("gpt-") else {
        return false;
    };
    let mut parts = suffix.split('-');
    let Some(version) = parts.next() else {
        return false;
    };
    let valid_version = !version.is_empty()
        && version
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
        && version.chars().any(|character| character.is_ascii_digit());

    if !valid_version {
        return false;
    }

    match parts.next() {
        None => true,
        Some("mini" | "nano") => parts.next().is_none(),
        Some(_) => false,
    }
}

fn is_anthropic_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if normalized.contains("deprecated") {
        return false;
    }

    let parts = normalized.split('-').collect::<Vec<_>>();

    matches!(
        parts.as_slice(),
        ["claude", "opus" | "sonnet" | "haiku", "4", minor]
            if minor.chars().all(|character| character.is_ascii_digit())
    ) || matches!(
        parts.as_slice(),
        ["claude", "opus" | "sonnet" | "haiku", "4", minor, date]
            if minor.chars().all(|character| character.is_ascii_digit())
                && date.len() == 8
                && date.chars().all(|character| character.is_ascii_digit())
    ) || matches!(
        parts.as_slice(),
        ["claude", "4", minor, "opus" | "sonnet" | "haiku"]
            if minor.chars().all(|character| character.is_ascii_digit())
    )
}

fn is_google_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if !normalized.starts_with("gemini-") || looks_like_dated_snapshot(&normalized) {
        return false;
    }

    if [
        "aqa",
        "audio",
        "banana",
        "customtools",
        "embedding",
        "gemma",
        "imagen",
        "image",
        "learnlm",
        "live",
        "lyria",
        "tts",
        "veo",
    ]
    .iter()
    .any(|excluded| normalized.contains(excluded))
    {
        return false;
    }

    let Some(suffix) = normalized.strip_prefix("gemini-") else {
        return false;
    };
    let parts = suffix.split('-').collect::<Vec<_>>();
    let Some(version) = parts.first() else {
        return false;
    };
    let valid_version = !version.is_empty()
        && version
            .chars()
            .all(|character| character.is_ascii_digit() || character == '.')
        && version.chars().any(|character| character.is_ascii_digit());

    if !valid_version {
        return false;
    }

    match parts.as_slice() {
        [_, "pro" | "flash"] => true,
        [_, "pro" | "flash", "preview"] => true,
        [_, "flash", "lite"] => true,
        [_, "flash", "lite", "preview"] => true,
        _ => false,
    }
}

fn runtime_model_stage(model_id: &str) -> Option<String> {
    let normalized = model_id.to_ascii_lowercase();

    if normalized.contains("deprecated") {
        return Some("deprecated".to_string());
    }

    if normalized.contains("preview") {
        return Some("preview".to_string());
    }

    None
}

fn create_openai_runtime_model(
    model_id: &str,
    release_date: Option<String>,
) -> ProviderRuntimeModel {
    let normalized = model_id.to_ascii_lowercase();
    let voice = false;
    let computer_use = normalized.starts_with("gpt-5.5") || normalized.starts_with("gpt-5.4");
    let latest_text_model = normalized.starts_with("gpt-5");
    let mut recommended_for = Vec::new();

    if latest_text_model {
        recommended_for.push("coding".to_string());
        recommended_for.push("vision".to_string());
    }

    if normalized.contains("mini") || normalized.contains("nano") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    }

    if voice {
        recommended_for.push("voice".to_string());
    }

    if computer_use {
        recommended_for.push("computer-use".to_string());
    }

    ProviderRuntimeModel {
        id: model_id.to_string(),
        label: None,
        stage: runtime_model_stage(model_id),
        release_date,
        description: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(latest_text_model),
            tool_use: Some(true),
            reasoning: Some(
                normalized.starts_with("gpt-5")
                    || normalized.starts_with('o')
                    || normalized.contains("reasoning"),
            ),
            streaming: Some(true),
            context_window_tokens: None,
            max_output_tokens: None,
            voice: Some(voice),
            computer_use: Some(computer_use),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    }
}

fn create_anthropic_runtime_model(entry: &serde_json::Value) -> Option<ProviderRuntimeModel> {
    let id = json_string(entry, "id")?;
    let display_name =
        json_string(entry, "display_name").or_else(|| json_string(entry, "displayName"));
    let capabilities = entry.get("capabilities");
    let normalized = id.to_ascii_lowercase();
    let image_input = json_bool_from_keys(
        capabilities,
        &["vision", "image_input", "imageInput", "images"],
    )
    .unwrap_or(true);
    let tool_use = json_bool_from_keys(
        capabilities,
        &["tool_use", "toolUse", "function_calling", "functionCalling"],
    )
    .unwrap_or(true);
    let reasoning = json_bool_from_keys(
        capabilities,
        &[
            "reasoning",
            "thinking",
            "extended_thinking",
            "extendedThinking",
            "adaptive_thinking",
            "adaptiveThinking",
        ],
    )
    .unwrap_or_else(|| normalized.contains("opus") || normalized.contains("sonnet"));
    let mut recommended_for = Vec::new();

    if normalized.contains("opus") || normalized.contains("sonnet") {
        recommended_for.push("coding".to_string());
    }

    if normalized.contains("sonnet") || normalized.contains("haiku") {
        recommended_for.push("fast".to_string());
    }

    if normalized.contains("haiku") {
        recommended_for.push("cheap".to_string());
    }

    if image_input {
        recommended_for.push("vision".to_string());
    }

    Some(ProviderRuntimeModel {
        id: id.clone(),
        label: display_name,
        stage: runtime_model_stage(&id),
        release_date: json_date_prefix(entry, "created_at")
            .or_else(|| json_date_prefix(entry, "createdAt")),
        description: None,
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(image_input),
            tool_use: Some(tool_use),
            reasoning: Some(reasoning),
            streaming: Some(true),
            context_window_tokens: json_u64(entry, "max_input_tokens")
                .or_else(|| json_u64(entry, "maxInputTokens")),
            max_output_tokens: json_u64(entry, "max_tokens")
                .or_else(|| json_u64(entry, "maxTokens")),
            voice: Some(false),
            computer_use: Some(false),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    })
}

fn create_google_runtime_model(entry: &serde_json::Value) -> Option<ProviderRuntimeModel> {
    let resource_name = json_string(entry, "name")?;
    let id = json_string(entry, "baseModelId").unwrap_or_else(|| {
        resource_name
            .strip_prefix("models/")
            .unwrap_or(resource_name.as_str())
            .to_string()
    });
    let methods = entry
        .get("supportedGenerationMethods")
        .and_then(serde_json::Value::as_array)
        .map(|methods| {
            methods
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if !methods.iter().any(|method| method == "generateContent") {
        return None;
    }

    let normalized = id.to_ascii_lowercase();
    let voice = normalized.contains("tts") || normalized.contains("audio");
    let image_input = !voice
        && !normalized.contains("embedding")
        && !normalized.contains("imagen")
        && !normalized.contains("veo");
    let reasoning = entry
        .get("thinking")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or_else(|| normalized.contains("pro") || normalized.contains("2.5"));
    let mut recommended_for = Vec::new();

    if reasoning || normalized.contains("pro") {
        recommended_for.push("coding".to_string());
    }

    if normalized.contains("flash") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    }

    if image_input {
        recommended_for.push("vision".to_string());
    }

    if voice {
        recommended_for.push("voice".to_string());
    }

    Some(ProviderRuntimeModel {
        id,
        label: json_string(entry, "displayName"),
        stage: runtime_model_stage(&resource_name),
        release_date: None,
        description: json_string(entry, "description"),
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(image_input),
            tool_use: Some(true),
            reasoning: Some(reasoning),
            streaming: Some(true),
            context_window_tokens: json_u64(entry, "inputTokenLimit"),
            max_output_tokens: json_u64(entry, "outputTokenLimit"),
            voice: Some(voice),
            computer_use: Some(false),
        },
        warnings: Vec::new(),
        source: "provider-api".to_string(),
    })
}

struct AgentCliCommandOutput {
    exit_code: Option<i32>,
    stdout: String,
    stderr: String,
}

fn run_agent_cli_command(
    executable: &Path,
    args: &[&str],
    env_values: &HashMap<String, String>,
    timeout: Duration,
) -> Result<AgentCliCommandOutput, String> {
    let mut command = Command::new(executable);
    command
        .args(args)
        .envs(env_values)
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {}: {error}", executable.display()))?;
    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started_at.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{} timed out while discovering agent CLI models.",
                    executable.display()
                ));
            }
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                return Err(format!(
                    "Failed while waiting for {}: {error}",
                    executable.display()
                ));
            }
        }
    };
    let mut stdout = String::new();
    let mut stderr = String::new();

    if let Some(mut stream) = child.stdout.take() {
        stream
            .read_to_string(&mut stdout)
            .map_err(|error| format!("Failed to read agent CLI stdout: {error}"))?;
    }

    if let Some(mut stream) = child.stderr.take() {
        stream
            .read_to_string(&mut stderr)
            .map_err(|error| format!("Failed to read agent CLI stderr: {error}"))?;
    }

    Ok(AgentCliCommandOutput {
        exit_code: status.code(),
        stdout,
        stderr,
    })
}

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

        return match suffix_parts.as_slice() {
            [] => true,
            ["mini"] | ["nano"] => true,
            ["codex", ..] => true,
            _ => false,
        };
    }

    if normalized.starts_with("claude-") {
        return true;
    }

    normalized.starts_with("gemini-")
        && ![
            "aqa",
            "audio",
            "embedding",
            "imagen",
            "image",
            "live",
            "tts",
            "veo",
        ]
        .iter()
        .any(|part| normalized.contains(part))
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
    let is_cross_provider_model =
        normalized.starts_with("claude-") || normalized.starts_with("gemini-");
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
    let description = entry.and_then(|entry| json_string(entry, "description"));

    ProviderRuntimeModel {
        id: normalized,
        label,
        stage,
        release_date,
        description,
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
        } else if is_cross_provider_model {
            vec![
                "Non-OpenAI Codex CLI models require matching Codex model_provider configuration and credentials."
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

fn parse_codex_cli_model_catalog(raw: &str) -> Result<Vec<ProviderRuntimeModel>, String> {
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

fn fetch_codex_cli_model_catalog(
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

fn is_copilot_cli_runtime_model(model_id: &str) -> bool {
    let normalized = model_id.to_ascii_lowercase();

    if normalized == "auto" {
        return true;
    }

    normalized.starts_with("gpt-")
        || normalized.starts_with("claude-")
        || normalized.starts_with("gemini-")
}

fn create_copilot_cli_runtime_model(model_id: &str) -> ProviderRuntimeModel {
    let normalized = model_id.to_ascii_lowercase();
    let mut recommended_for = vec!["coding".to_string()];

    if normalized.contains("haiku") {
        recommended_for.push("fast".to_string());
        recommended_for.push("cheap".to_string());
    } else if normalized.contains("sonnet") || normalized.contains("gpt-5.2") {
        recommended_for.push("fast".to_string());
    }

    ProviderRuntimeModel {
        id: normalized,
        label: None,
        stage: Some("stable".to_string()),
        release_date: None,
        description: Some(
            "Model option reported by the local GitHub Copilot CLI help output.".to_string(),
        ),
        recommended_for,
        capabilities: ProviderRuntimeModelCapabilities {
            image_input: Some(false),
            tool_use: Some(true),
            reasoning: Some(true),
            streaming: Some(true),
            context_window_tokens: None,
            max_output_tokens: None,
            voice: Some(false),
            computer_use: Some(false),
        },
        warnings: vec![
            "Model availability depends on GitHub Copilot plan and organization policy."
                .to_string(),
        ],
        source: "provider-probe".to_string(),
    }
}

fn collect_copilot_cli_help_model_ids(raw: &str) -> Vec<String> {
    let mut by_id = HashMap::<String, ()>::new();
    let mut token = String::new();
    let flush_token = |token: &mut String, by_id: &mut HashMap<String, ()>| {
        if token.is_empty() {
            return;
        }

        let normalized = token
            .trim_matches(|character: char| !character.is_ascii_alphanumeric())
            .to_ascii_lowercase();

        if is_copilot_cli_runtime_model(&normalized) {
            by_id.entry(normalized).or_insert(());
        }

        token.clear();
    };

    for character in raw.chars() {
        if character.is_ascii_alphanumeric() || character == '-' || character == '.' {
            token.push(character);
        } else {
            flush_token(&mut token, &mut by_id);
        }
    }

    flush_token(&mut token, &mut by_id);

    let mut ids = by_id.into_keys().collect::<Vec<_>>();
    ids.sort_by(|left, right| {
        let left_rank = if left == "auto" { 0 } else { 1 };
        let right_rank = if right == "auto" { 0 } else { 1 };

        left_rank.cmp(&right_rank).then_with(|| left.cmp(right))
    });

    ids
}

fn parse_copilot_cli_model_catalog(raw: &str) -> Result<Vec<ProviderRuntimeModel>, String> {
    let ids = collect_copilot_cli_help_model_ids(raw);

    if ids.is_empty() {
        return Err("Copilot CLI help output did not include any model IDs.".to_string());
    }

    Ok(ids
        .into_iter()
        .map(|id| create_copilot_cli_runtime_model(&id))
        .collect())
}

fn fetch_copilot_cli_model_catalog(
    env: &HashMap<String, String>,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let Some(binary) = resolve_agent_cli_binary("copilot-cli", env) else {
        return Err(
            "Copilot CLI binary was not found. Configure MACHDOCH_COPILOT_CLI_PATH or install `copilot` on PATH."
                .to_string(),
        );
    };
    let attempts: [(&[&str], &str); 2] =
        [(&["help"], "copilot help"), (&["--help"], "copilot --help")];
    let mut failures = Vec::new();

    for (args, label) in attempts {
        match run_agent_cli_command(&binary, args, env, Duration::from_secs(8)) {
            Ok(output) if output.exit_code == Some(0) => {
                let combined_output = format!("{}\n{}", output.stdout, output.stderr);

                match parse_copilot_cli_model_catalog(&combined_output) {
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
        "Copilot CLI model discovery failed. {}",
        failures.join(" ")
    ))
}

async fn fetch_openai_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = client
        .get("https://api.openai.com/v1/models")
        .bearer_auth(api_key)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Failed to parse OpenAI model list: {error}"))?;
    let mut models = payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let id = json_string(entry, "id")?;

                    is_openai_runtime_model(&id).then(|| {
                        create_openai_runtime_model(
                            &id,
                            json_u64(entry, "created").and_then(unix_seconds_to_utc_date),
                        )
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}

async fn fetch_anthropic_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = client
        .get("https://api.anthropic.com/v1/models?limit=1000")
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Failed to parse Anthropic model list: {error}"))?;
    let mut models = payload
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(create_anthropic_runtime_model)
                .filter(|model| is_anthropic_runtime_model(&model.id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}

async fn fetch_google_model_catalog(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<Vec<ProviderRuntimeModel>, String> {
    let payload = client
        .get("https://generativelanguage.googleapis.com/v1beta/models")
        .query(&[("key", api_key), ("pageSize", "1000")])
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(sanitize_provider_error)?
        .json::<serde_json::Value>()
        .await
        .map_err(|error| format!("Failed to parse Google model list: {error}"))?;
    let mut by_id = HashMap::<String, ProviderRuntimeModel>::new();

    if let Some(entries) = payload.get("models").and_then(serde_json::Value::as_array) {
        for model in entries.iter().filter_map(create_google_runtime_model) {
            if is_google_runtime_model(&model.id) {
                by_id.entry(model.id.clone()).or_insert(model);
            }
        }
    }

    let mut models = by_id.into_values().collect::<Vec<_>>();
    models.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(models)
}

pub(super) async fn fetch_provider_model_catalog(
    client: &reqwest::Client,
    env: &HashMap<String, String>,
    provider: &str,
) -> ProviderModelCatalogProvider {
    let (api_key_name, fetch_result) = match provider {
        "openai" => {
            let api_key = env.get("OPENAI_API_KEY").map(String::as_str);
            match api_key.filter(|value| has_configured_value(Some(value))) {
                Some(value) => (
                    "OPENAI_API_KEY",
                    fetch_openai_model_catalog(client, value).await,
                ),
                None => {
                    return provider_model_catalog_unavailable(
                        provider,
                        "OPENAI_API_KEY is not configured.",
                    );
                }
            }
        }
        "anthropic" => {
            let api_key = env.get("ANTHROPIC_API_KEY").map(String::as_str);
            match api_key.filter(|value| has_configured_value(Some(value))) {
                Some(value) => (
                    "ANTHROPIC_API_KEY",
                    fetch_anthropic_model_catalog(client, value).await,
                ),
                None => {
                    return provider_model_catalog_unavailable(
                        provider,
                        "ANTHROPIC_API_KEY is not configured.",
                    );
                }
            }
        }
        "google" => {
            let api_key = env.get("GOOGLE_API_KEY").map(String::as_str);
            match api_key.filter(|value| has_configured_value(Some(value))) {
                Some(value) => (
                    "GOOGLE_API_KEY",
                    fetch_google_model_catalog(client, value).await,
                ),
                None => {
                    return provider_model_catalog_unavailable(
                        provider,
                        "GOOGLE_API_KEY is not configured.",
                    );
                }
            }
        }
        "codex-cli" => match fetch_codex_cli_model_catalog(env) {
            Ok(models) => {
                return ProviderModelCatalogProvider {
                    provider: provider.to_string(),
                    source: "provider-probe".to_string(),
                    available: true,
                    error: None,
                    models,
                };
            }
            Err(error) => {
                return provider_model_catalog_unavailable(provider, &error);
            }
        },
        "copilot-cli" => match fetch_copilot_cli_model_catalog(env) {
            Ok(models) => {
                return ProviderModelCatalogProvider {
                    provider: provider.to_string(),
                    source: "provider-probe".to_string(),
                    available: true,
                    error: None,
                    models,
                };
            }
            Err(error) => {
                return provider_model_catalog_unavailable(provider, &error);
            }
        },
        "claude-cli" => {
            return provider_model_catalog_unavailable(
                provider,
                "Model catalog discovery is delegated to the external CLI and is not queried by Machdoch.",
            );
        }
        _ => {
            return provider_model_catalog_unavailable(provider, "Unsupported provider.");
        }
    };

    match fetch_result {
        Ok(models) => ProviderModelCatalogProvider {
            provider: provider.to_string(),
            source: "provider-api".to_string(),
            available: true,
            error: None,
            models,
        },
        Err(error) => provider_model_catalog_unavailable(
            provider,
            &format!("{api_key_name} is configured, but {error}"),
        ),
    }
}

#[cfg(test)]
mod model_catalog_parser_tests {
    use super::*;

    #[test]
    fn codex_cli_model_catalog_parser_extracts_slugs_and_cross_provider_models() {
        let raw = r#"
        {
            "models": [
                { "slug": "gpt-5.5", "display_name": "GPT-5.5" },
                { "slug": "claude-opus-4-8", "display_name": "Claude Opus 4.8" },
                { "slug": "gemini-3.1-pro-preview", "display_name": "Gemini 3.1 Pro" },
                { "slug": "codex-auto-review", "display_name": "Codex Auto Review" },
                { "slug": "gemini-embedding-001", "display_name": "Gemini Embedding" }
            ]
        }
        "#;
        let model_ids = parse_codex_cli_model_catalog(raw)
            .expect("Codex CLI catalog should include supported model IDs")
            .into_iter()
            .map(|model| model.id)
            .collect::<Vec<_>>();

        assert_eq!(
            model_ids,
            vec!["claude-opus-4-8", "gemini-3.1-pro-preview", "gpt-5.5"]
        );
    }

    #[test]
    fn copilot_cli_help_parser_extracts_models_without_telemetry_keys() {
        let help_output = r#"
            --model=MODEL Set the AI model you want to use. Pass auto to let Copilot pick.
            Examples: copilot -p "Explain" -s --model claude-haiku-4.5
            copilot -p "Fix" --model gpt-5.3-codex --allow-tool write
            copilot -p "Check" --model gemini-3.1-pro-preview --allow-all
            COPILOT_MODEL can be set to gpt-5.2 or claude-sonnet-4.5.
            Telemetry fields include github.copilot.token_limit and github.copilot.aiu.
        "#;
        let model_ids = parse_copilot_cli_model_catalog(help_output)
            .expect("help output should include supported Copilot model IDs")
            .into_iter()
            .map(|model| model.id)
            .collect::<Vec<_>>();

        assert_eq!(
            model_ids,
            vec![
                "auto",
                "claude-haiku-4.5",
                "claude-sonnet-4.5",
                "gemini-3.1-pro-preview",
                "gpt-5.2",
                "gpt-5.3-codex"
            ]
        );
        assert!(!model_ids
            .iter()
            .any(|model_id| model_id.contains("github.copilot")));
    }
}
