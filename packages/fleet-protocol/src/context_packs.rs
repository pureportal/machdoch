use serde_json::{Map, Value};

const OVERRIDES: &[&str] = &["provider", "model", "mode", "reasoning", "promptEnhancementMode", "interviewEnabled", "sessionMemoryEnabled", "useWorkspaceMemory", "useGlobalMemory", "uiControlEnabled"];

fn object<'a>(value: &'a Value, required: &[&str], optional: &[&str]) -> Option<&'a Map<String, Value>> {
    let value = value.as_object()?;
    (required.iter().all(|key| value.contains_key(*key)) && value.keys().all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str()))).then_some(value)
}

fn text(value: &Value, maximum: usize, nonempty: bool, no_nul: bool) -> bool {
    value.as_str().is_some_and(|value| {
        let value = if nonempty { crate::ecmascript_trim(value) } else { value };
        (!nonempty || !value.is_empty()) && value.encode_utf16().count() <= maximum && (!no_nul || !value.contains('\0'))
    })
}

fn strings(value: &Value, count: usize, maximum: usize, nonempty: bool) -> bool {
    value.as_array().is_some_and(|values| values.len() <= count && values.iter().all(|value| text(value, maximum, nonempty, false)))
}

fn integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|value| (0.0..=9_007_199_254_740_991.0).contains(&value) && value.fract() == 0.0)
}

fn variable(value: &Value, allow_string: bool) -> bool {
    (allow_string && text(value, 240, true, false)) || object(value, &["name"], &["defaultValue"]).is_some_and(|value| text(&value["name"], 240, true, false) && value.get("defaultValue").is_none_or(|value| text(value, 128 * 1024, false, true)))
}

pub fn valid_attachment(value: &Value) -> bool {
    match value["source"].as_str() {
        Some("path") => object(value, &["id", "source", "kind", "name", "path"], &["parent"]).is_some_and(|value| {
            text(&value["id"], 240, true, false) && matches!(value["kind"].as_str(), Some("file" | "directory" | "image" | "other")) && text(&value["name"], 12_000, false, false) && text(&value["path"], 12_000, false, false) && value.get("parent").is_none_or(|value| text(value, 12_000, false, false))
        }),
        Some("media-asset") => object(value, &["id", "source", "kind", "name", "workspaceRoot", "assetId"], &["displayName", "rendition"]).is_some_and(|value| {
            text(&value["id"], 240, true, false) && matches!(value["kind"].as_str(), Some("prompt" | "image" | "video" | "audio" | "vector" | "alpha-matte" | "report" | "collection")) && text(&value["name"], 12_000, false, false) && text(&value["workspaceRoot"], 12_000, true, false) && text(&value["assetId"], 240, true, false) && value.get("displayName").is_none_or(|value| text(value, 12_000, false, false)) && value.get("rendition").is_none_or(|value| matches!(value.as_str(), Some("thumbnail" | "preview" | "original")))
        }),
        _ => false,
    }
}

fn content(value: &Map<String, Value>) -> bool {
    text(&value["name"], 240, true, false) && text(&value["instructions"], 128 * 1024, false, true) && text(&value["prompt"], 128 * 1024, false, true) && value["contextAttachments"].as_array().is_some_and(|values| values.len() <= 64 && values.iter().all(valid_attachment))
}

fn overrides(value: &Map<String, Value>) -> bool {
    value.get("provider").is_none_or(|value| matches!(value.as_str(), Some("openai" | "anthropic" | "google" | "langdock" | "codex-cli" | "claude-cli" | "copilot-cli")))
        && value.get("model").is_none_or(|value| text(value, 240, true, false))
        && value.get("mode").is_none_or(|value| matches!(value.as_str(), Some("ask" | "machdoch")))
        && value.get("reasoning").is_none_or(|value| super::valid_reasoning(value.as_str()))
        && value.get("promptEnhancementMode").is_none_or(|value| super::valid_prompt_enhancement_mode(value.as_str()))
        && OVERRIDES[5..].iter().all(|key| value.get(*key).is_none_or(Value::is_boolean))
}

pub fn valid_definition(value: &Value) -> bool {
    let mut optional = OVERRIDES.to_vec();
    optional.push("id");
    object(value, &["name", "scope", "instructions", "prompt", "contextAttachments", "variables", "triggerPhrases", "triggerPathPatterns"], &optional).is_some_and(|value| {
        content(value) && overrides(value) && value.get("id").is_none_or(|value| text(value, 240, true, false)) && matches!(value["scope"].as_str(), Some("workspace" | "global")) && value["variables"].as_array().is_some_and(|values| values.len() <= 64 && values.iter().all(|value| variable(value, true))) && strings(&value["triggerPhrases"], 128, 240, true) && strings(&value["triggerPathPatterns"], 128, 2048, false)
    })
}

pub fn valid_document(value: &Value) -> bool {
    let mut optional = OVERRIDES.to_vec();
    optional.push("lastUsedAt");
    object(value, &["id", "workspace", "name", "instructions", "prompt", "contextAttachments", "variables", "trigger", "createdAt", "updatedAt", "useCount"], &optional).is_some_and(|value| {
        content(value) && overrides(value) && text(&value["id"], 240, true, false) && (value["workspace"].is_null() || text(&value["workspace"], 2048, true, false)) && value["variables"].as_array().is_some_and(|values| values.len() <= 64 && values.iter().all(|value| variable(value, false))) && object(&value["trigger"], &["phrases", "pathPatterns"], &[]).is_some_and(|trigger| strings(&trigger["phrases"], 128, 240, true) && strings(&trigger["pathPatterns"], 128, 2048, false)) && integer(&value["createdAt"]) && integer(&value["updatedAt"]) && integer(&value["useCount"]) && value.get("lastUsedAt").is_none_or(integer)
    })
}

pub fn valid_export(value: &Value) -> bool {
    object(value, &["kind", "version", "exportedAt", "contextPacks"], &[]).is_some_and(|value| value["kind"].as_str() == Some("machdoch.context-packs") && value["version"].as_f64() == Some(1.0) && integer(&value["exportedAt"]) && value["contextPacks"].as_array().is_some_and(|values| values.len() <= 160 && values.iter().all(valid_document)))
}
