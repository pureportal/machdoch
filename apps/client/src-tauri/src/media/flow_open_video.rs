use serde_json::Value;

use super::{config_bool, config_enum, config_multiline_string, MediaFlowNode};
use crate::media::{open_models, MediaResult};

pub(super) fn validate(
    node: &MediaFlowNode,
    profile: Option<&open_models::OpenModelProfile>,
) -> MediaResult<()> {
    config_enum(node, "aspectRatio", &["1:1", "16:9", "9:16", "21:9"])?;
    config_enum(
        node,
        "resolution",
        &["preview-512", "quality-640", "quality-768"],
    )?;
    config_enum(
        node,
        "loopMode",
        &["none", "ping-pong", "seamless", "crossfade"],
    )?;
    for key in [
        "generateAudio",
        "transparentBackground",
        "experimentalLowMemory",
    ] {
        config_bool(node, key)?;
    }
    for (key, minimum, maximum) in [
        ("fps", 1, 60),
        ("numFrames", 1, 362),
        ("numInferenceSteps", 1, 100),
    ] {
        let value = node
            .config
            .get(key)
            .and_then(Value::as_u64)
            .ok_or_else(|| format!("{} requires integer {key}", node.label))?;
        if !(minimum..=maximum).contains(&value) {
            return Err(format!("{key} must be between {minimum} and {maximum}"));
        }
    }
    let guidance = node
        .config
        .get("guidanceScale")
        .and_then(Value::as_f64)
        .ok_or("Guidance must be numeric")?;
    if !guidance.is_finite() || !(0.0..=20.0).contains(&guidance) {
        return Err("Guidance must be between 0 and 20".to_string());
    }
    if let Some(profile) = profile {
        if let Some(error) = open_models::video_settings_error(
            profile,
            node.config["numFrames"].as_u64().unwrap() as u32,
            node.config["numInferenceSteps"].as_u64().unwrap() as u32,
            guidance,
        ) {
            return Err(error);
        }
        if node.config["generateAudio"].as_bool() != Some(profile.audio) {
            return Err(format!(
                "Choose the audio setting for {}",
                profile.display_name
            ));
        }
        if node.config["transparentBackground"] == true {
            return Err("This video model requires opaque output".to_string());
        }
        let loop_mode = node.config["loopMode"].as_str().unwrap();
        if loop_mode == "seamless" || (profile.audio && loop_mode != "none") {
            return Err("Choose a valid loop mode for this video model".to_string());
        }
        if node
            .config
            .get("modelAddons")
            .and_then(Value::as_array)
            .is_some_and(|addons| !addons.is_empty())
        {
            return Err("This video model does not support LoRAs".to_string());
        }
    }
    if let Some(seed) = node.config.get("seed").filter(|seed| !seed.is_null()) {
        if !seed
            .as_u64()
            .is_some_and(|seed| seed <= 9_007_199_254_740_991)
        {
            return Err("Seed must be a JavaScript-safe non-negative integer".to_string());
        }
    }
    if node.config.contains_key("negativePrompt") {
        config_multiline_string(node, "negativePrompt", 8_000, true)?;
        if profile.is_some_and(|profile| !profile.prompt)
            && node.config["negativePrompt"]
                .as_str()
                .is_some_and(|prompt| !prompt.is_empty())
        {
            return Err("This video model does not accept a negative prompt".to_string());
        }
    }
    for (key, values) in [
        ("matteQuality", &["fast", "balanced", "production"][..]),
        (
            "encodingQuality",
            &["draft", "balanced", "production", "lossless"][..],
        ),
        (
            "memoryProfile",
            &["auto", "memory-saver", "balanced", "maximum-speed"][..],
        ),
    ] {
        if node.config.contains_key(key) {
            config_enum(node, key, values)?;
        }
    }
    Ok(())
}
