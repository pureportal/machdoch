use super::{
    flow::{MediaFlowDocument, MediaFlowNode},
    MediaResult,
};
use serde_json::Value;

pub(crate) fn validate_node(node: &MediaFlowNode) -> MediaResult<()> {
    let keys: &[&str] = match node.r#type.as_str() {
        "operation.visual-check" => &[
            "criteria",
            "modelPath",
            "maxPixels",
            "maxTokens",
            "reviewPasses",
            "compareReference",
        ],
        "operation.prepare-mask" => &["editMask", "grow", "feather", "region", "boundaryWidth"],
        "operation.segment" => &[
            "query",
            "selection",
            "invert",
            "modelPath",
            "threshold",
            "grow",
            "feather",
        ],
        "operation.upscale" => &["modelPath", "scale", "tileSize"],
        "task.generate-prompt" => &["instructions", "modelPath", "maxTokens"],
        "control.repeat" => &[
            "startNodeId",
            "maxIterations",
            "seedStep",
            "feedback",
            "inputMode",
            "stopOnRepeatedImage",
        ],
        _ => return Err("Unknown workflow node".into()),
    };
    if node.config.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(format!("{} has an unknown setting", node.label));
    }
    for key in keys {
        if matches!(
            *key,
            "inputMode"
                | "editMask"
                | "reviewPasses"
                | "compareReference"
                | "region"
                | "boundaryWidth"
                | "stopOnRepeatedImage"
        ) && !node.config.contains_key(*key)
        {
            continue;
        }
        let value = node
            .config
            .get(*key)
            .ok_or_else(|| format!("{} requires {key}", node.label))?;
        let valid = match *key {
            "editMask" => {
                value.is_null()
                    || serde_json::from_value::<super::MediaImageMask>(value.clone()).is_ok_and(
                        |mut mask| super::normalize_media_image_mask(&mut mask, None).is_ok(),
                    )
            }
            "criteria" => value.as_str().is_some_and(|v| v.chars().count() <= 4000),
            "inputMode" => value
                .as_str()
                .is_some_and(|v| ["original", "previous"].contains(&v)),
            "modelPath" => value
                .as_str()
                .is_some_and(|v| v.len() <= 2048 && !v.contains(['\0', '\n', '\r'])),
            "instructions" => value
                .as_str()
                .is_some_and(|v| !v.trim().is_empty() && v.chars().count() <= 4000),
            "query" | "startNodeId" => value.as_str().is_some_and(|v| v.len() <= 256),
            "selection" => value
                .as_str()
                .is_some_and(|v| ["all", "largest", "best"].contains(&v)),
            "scale" => value.as_str().is_some_and(|v| ["2", "4"].contains(&v)),
            "region" => value
                .as_str()
                .is_some_and(|v| ["selection", "surroundings", "boundary"].contains(&v)),
            "invert" | "feedback" | "stopOnRepeatedImage" | "compareReference" => {
                value.is_boolean()
            }
            "threshold" => in_range(value, 0.05, 0.95, false),
            "grow" => in_range(value, -64.0, 64.0, true),
            "feather" => in_range(value, 0.0, 32.0, true),
            "boundaryWidth" => in_range(value, 1.0, 64.0, true),
            "reviewPasses" => in_range(value, 1.0, 3.0, true),
            "tileSize" => in_range(value, 64.0, 512.0, true),
            "maxTokens" if node.r#type == "operation.visual-check" => {
                in_range(value, 128.0, 2048.0, true)
            }
            "maxTokens" => in_range(value, 32.0, 1024.0, true),
            "maxPixels" => in_range(value, 65536.0, 2097152.0, true),
            "maxIterations" => in_range(value, 1.0, 20.0, true),
            "seedStep" => in_range(value, 1.0, 1000000.0, true),
            _ => false,
        };
        if !valid {
            return Err(format!("{} has an invalid {key}", node.label));
        }
    }
    Ok(())
}

pub(crate) fn in_range(value: &Value, min: f64, max: f64, integer: bool) -> bool {
    value
        .as_f64()
        .is_some_and(|v| v.is_finite() && v >= min && v <= max && (!integer || v.fract() == 0.0))
}

pub(crate) fn descendants(
    flow: &MediaFlowDocument,
    start: &str,
) -> std::collections::HashSet<String> {
    let mut found = std::collections::HashSet::from([start.to_string()]);
    for _ in 0..flow.nodes.len() {
        let size = found.len();
        for edge in &flow.edges {
            if found.contains(&edge.from_node_id) {
                found.insert(edge.to_node_id.clone());
            }
        }
        if size == found.len() {
            break;
        }
    }
    found
}
