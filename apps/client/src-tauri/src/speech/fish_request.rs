use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

pub fn build(
    snapshot: &Value,
    segment: &Value,
    mut reference_audio: impl FnMut(&str) -> Result<Vec<u8>, String>,
) -> Result<Value, String> {
    let profile = &snapshot["profile"];
    super::contracts::validate_profile(profile)?;
    super::contracts::validate_segment_references(segment, profile)?;
    let text = super::contracts::provider_text(segment, profile)?;
    let direction = profile["direction"].as_str().ok_or("The speech direction is invalid.")?;
    let mut request = json!({
        "text": if direction.is_empty() { text } else { format!("[{direction}]{text}") },
        "temperature": profile["temperature"],
        "top_p": profile["topP"],
        "chunk_length": profile["chunkLength"],
        "min_chunk_length": profile["minChunkLength"],
        "latency": profile["latency"]
    });
    if let Some(language) = profile["language"].as_str().filter(|value| !value.is_empty()) {
        request["language"] = json!(language);
    }
    if let Some(normalize) = profile.get("normalize") {
        request["normalize"] = normalize.clone();
    }
    let voices = segment["voiceIds"].as_array().ok_or("The admitted voice binding is missing.")?;
    if !voices.is_empty() {
        request["reference_id"] = json!(voices);
    }
    let references = segment["referenceAssetIds"].as_array().ok_or("The admitted references are missing.")?;
    if !references.is_empty() {
        let mut total = 0usize;
        let mut samples = Vec::with_capacity(references.len());
        for id in references {
            let id = id.as_str().ok_or("The reference ID is invalid.")?;
            let transcript = snapshot["references"][id]["transcript"].as_str()
                .filter(|value| !value.trim().is_empty()).ok_or("The immutable reference transcript is missing.")?;
            let audio = reference_audio(id)?;
            if audio.len() > 16 * 1024 * 1024 {
                return Err("Trim each inline reference below the local 16 MiB upload guard.".into());
            }
            total += audio.len();
            if total > 24 * 1024 * 1024 {
                return Err("Trim the segment's inline references below the local 24 MiB aggregate upload guard.".into());
            }
            samples.push(json!({"audio": STANDARD.encode(audio), "text": transcript}));
        }
        if let Some(groups) = segment["referenceGroups"].as_array() {
            let mut samples = samples.into_iter();
            let mut grouped = Vec::with_capacity(groups.len());
            for group in groups {
                let count = group.as_array().ok_or("The dialogue reference group is invalid.")?.len();
                grouped.push(samples.by_ref().take(count).collect::<Vec<_>>());
            }
            request["references"] = json!(grouped);
            request["reference_id"] = json!((0..groups.len()).map(|index| format!("speaker-{index}")).collect::<Vec<_>>());
        } else {
            request["references"] = json!(samples);
        }
    }
    if request.get("reference_id").is_none() && request.get("references").is_none() {
        return Err("Assign a Fish voice or reference recording before rendering.".into());
    }
    let dictionaries = snapshot["dictionaries"].as_array().ok_or("The dictionary snapshot is invalid.")?;
    super::dictionary_snapshots::validate_set(dictionaries)?;
    if !dictionaries.is_empty() {
        request["pronunciation_dictionary"] = json!(dictionaries.iter().map(|dictionary| {
            let rules = dictionary["rules"].as_array().ok_or("The dictionary rules are missing.")?;
            Ok(json!({"items": rules.iter().map(|rule| json!({
                "key": rule["text"], "value": rule["phonemes"], "case_sensitive": rule["caseSensitive"]
            })).collect::<Vec<_>>()}))
        }).collect::<Result<Vec<_>, String>>()?);
    }
    Ok(request)
}

#[cfg(test)]
#[path = "fish_request_tests.rs"]
mod tests;
