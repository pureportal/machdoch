use serde_json::{Map, Value};

const OVERRIDES: &[&str] = &[
    "contextWindow",
    "provider",
    "model",
    "mode",
    "reasoning",
    "promptEnhancementMode",
    "interviewEnabled",
    "sessionMemoryEnabled",
    "useWorkspaceMemory",
    "useGlobalMemory",
    "uiControlEnabled",
    "temporary",
];

fn object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Option<&'a Map<String, Value>> {
    let value = value.as_object()?;
    (required.iter().all(|key| value.contains_key(*key))
        && value
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str())))
    .then_some(value)
}

fn text(value: &Value, maximum: usize, nonempty: bool) -> bool {
    value.as_str().is_some_and(|value| {
        let value = if nonempty {
            crate::ecmascript_trim(value)
        } else {
            value
        };
        (!nonempty || !value.is_empty())
            && value.encode_utf16().count() <= maximum
    })
}

fn content_text(value: &Value) -> bool {
    value.as_str().is_some_and(|value| !value.contains('\0'))
}

fn strings(value: &Value, count: usize, maximum: usize, nonempty: bool) -> bool {
    value.as_array().is_some_and(|values| {
        values.len() <= count
            && values
                .iter()
                .all(|value| text(value, maximum, nonempty))
    })
}

fn integer(value: &Value) -> bool {
    value.as_f64().is_some_and(|value| {
        (0.0..=9_007_199_254_740_991.0).contains(&value) && value.fract() == 0.0
    })
}

fn variable(value: &Value, allow_string: bool) -> bool {
    (allow_string && text(value, 240, true))
        || object(value, &["name"], &["defaultValue"]).is_some_and(|value| {
            text(&value["name"], 240, true)
                && value
                    .get("defaultValue")
                    .is_none_or(content_text)
        })
}

pub fn valid_attachment(value: &Value) -> bool {
    match value["source"].as_str() {
        Some("path") => object(
            value,
            &["id", "source", "kind", "name", "path"],
            &["parent"],
        )
        .is_some_and(|value| {
            text(&value["id"], 240, true)
                && matches!(
                    value["kind"].as_str(),
                    Some("file" | "directory" | "image" | "other")
                )
                && text(&value["name"], 12_000, false)
                && text(&value["path"], 12_000, false)
                && value
                    .get("parent")
                    .is_none_or(|value| text(value, 12_000, false))
        }),
        Some("media-asset") => object(
            value,
            &["id", "source", "kind", "name", "workspaceRoot", "assetId"],
            &["displayName", "rendition"],
        )
        .is_some_and(|value| {
            text(&value["id"], 240, true)
                && matches!(
                    value["kind"].as_str(),
                    Some(
                        "prompt"
                            | "image"
                            | "video"
                            | "audio"
                            | "vector"
                            | "alpha-matte"
                            | "report"
                            | "collection"
                    )
                )
                && text(&value["name"], 12_000, false)
                && text(&value["workspaceRoot"], 12_000, true)
                && text(&value["assetId"], 240, true)
                && value
                    .get("displayName")
                    .is_none_or(|value| text(value, 12_000, false))
                && value.get("rendition").is_none_or(|value| {
                    matches!(value.as_str(), Some("thumbnail" | "preview" | "original"))
                })
        }),
        _ => false,
    }
}

fn content(value: &Map<String, Value>) -> bool {
    text(&value["name"], 240, true)
        && content_text(&value["instructions"])
        && content_text(&value["prompt"])
        && value["contextAttachments"]
            .as_array()
            .is_some_and(|values| values.len() <= 64 && values.iter().all(valid_attachment))
}

fn overrides(value: &Map<String, Value>) -> bool {
    value.get("provider").is_none_or(|value| {
        matches!(
            value.as_str(),
            Some(
                "openai"
                    | "anthropic"
                    | "google"
                    | "langdock"
                    | "codex-cli"
                    | "claude-cli"
                    | "copilot-cli"
            )
        )
    }) && value
        .get("model")
        .is_none_or(|value| text(value, 240, true))
        && value
            .get("mode")
            .is_none_or(|value| matches!(value.as_str(), Some("ask" | "machdoch")))
        && value
            .get("reasoning")
            .is_none_or(|value| super::valid_reasoning(value.as_str()))
          && value.get("contextWindow").is_none_or(|value| {
              matches!(value.as_str(), Some("lowest" | "default" | "highest"))
          })
        && value
            .get("promptEnhancementMode")
            .is_none_or(|value| super::valid_prompt_enhancement_mode(value.as_str()))
          && OVERRIDES[6..]
            .iter()
            .all(|key| value.get(*key).is_none_or(Value::is_boolean))
}

pub fn valid_definition(value: &Value) -> bool {
    let mut optional = OVERRIDES.to_vec();
    optional.push("id");
    object(
        value,
        &[
            "name",
            "scope",
            "instructions",
            "prompt",
            "contextAttachments",
            "variables",
            "triggerPhrases",
            "triggerPathPatterns",
        ],
        &optional,
    )
    .is_some_and(|value| {
        content(value)
            && overrides(value)
            && value
                .get("id")
                .is_none_or(|value| text(value, 240, true))
            && matches!(value["scope"].as_str(), Some("workspace" | "global"))
            && value["variables"].as_array().is_some_and(|values| {
                values.len() <= 64 && values.iter().all(|value| variable(value, true))
            })
            && strings(&value["triggerPhrases"], 128, 240, true)
            && strings(&value["triggerPathPatterns"], 128, 2048, false)
    })
}

pub fn valid_document(value: &Value) -> bool {
    let mut optional = OVERRIDES.to_vec();
    optional.push("lastUsedAt");
    object(
        value,
        &[
            "id",
            "workspace",
            "name",
            "instructions",
            "prompt",
            "contextAttachments",
            "variables",
            "trigger",
            "createdAt",
            "updatedAt",
            "useCount",
        ],
        &optional,
    )
    .is_some_and(|value| {
        content(value)
            && overrides(value)
            && text(&value["id"], 240, true)
            && (value["workspace"].is_null() || text(&value["workspace"], 2048, true))
            && value["variables"].as_array().is_some_and(|values| {
                values.len() <= 64 && values.iter().all(|value| variable(value, false))
            })
            && object(&value["trigger"], &["phrases", "pathPatterns"], &[]).is_some_and(|trigger| {
                strings(&trigger["phrases"], 128, 240, true)
                    && strings(&trigger["pathPatterns"], 128, 2048, false)
            })
            && integer(&value["createdAt"])
            && integer(&value["updatedAt"])
            && integer(&value["useCount"])
            && value.get("lastUsedAt").is_none_or(integer)
    })
}

pub fn valid_export(value: &Value) -> bool {
    object(
        value,
        &["kind", "version", "exportedAt", "contextPacks"],
        &[],
    )
    .is_some_and(|value| {
        value["kind"].as_str() == Some("machdoch.context-packs")
            && value["version"].as_f64() == Some(1.0)
            && integer(&value["exportedAt"])
            && value["contextPacks"]
                .as_array()
                .is_some_and(|values| values.len() <= 160 && values.iter().all(valid_document))
    })
}

#[cfg(test)]
mod tests {
    use super::{valid_definition, valid_export};
    use serde_json::json;

    #[test]
    fn long_context_pack_text_is_valid_in_definitions_and_exports() {
        let instructions = format!("Instructions\n{}End", "Grüß 🌿\n".repeat(40_000));
        let prompt = format!("Prompt\n{}End", "日本語\n".repeat(40_000));
        let variables = json!([{ "name": "target", "defaultValue": "x".repeat(200_000) }]);
        let mut definition = json!({
            "name": "Long prompt", "scope": "global", "instructions": instructions, "prompt": prompt,
            "contextAttachments": [], "variables": variables, "triggerPhrases": [], "triggerPathPatterns": []
        });
        let mut archive = json!({
            "kind": "machdoch.context-packs", "version": 1, "exportedAt": 1,
            "contextPacks": [{
                "id": "pack-1", "name": "Long prompt", "workspace": null,
                "instructions": instructions, "prompt": prompt, "contextAttachments": [], "variables": variables,
                "trigger": { "phrases": [], "pathPatterns": [] }, "createdAt": 1, "updatedAt": 1, "useCount": 0
            }]
        });
        assert!(valid_definition(&definition));
        assert!(valid_export(&archive));
        for field in ["prompt", "instructions"] {
            for invalid in [json!(null), json!(12), json!("text\0text")] {
                let previous = definition[field].clone();
                definition[field] = invalid.clone();
                archive["contextPacks"][0][field] = invalid;
                assert!(!valid_definition(&definition));
                assert!(!valid_export(&archive));
                definition[field] = previous.clone();
                archive["contextPacks"][0][field] = previous;
            }
        }
    }

    #[test]
    fn temporary_override_accepts_only_booleans() {
        let mut definition = json!({
            "name": "Commit", "scope": "global", "instructions": "", "prompt": "Commit",
            "contextAttachments": [], "variables": [], "triggerPhrases": [], "triggerPathPatterns": []
        });
        for temporary in [json!(true), json!(false)] {
            definition["temporary"] = temporary;
            assert!(valid_definition(&definition));
        }
        for temporary in [json!("true"), json!(null), json!(1)] {
            definition["temporary"] = temporary;
            assert!(!valid_definition(&definition));
        }
    }
}
