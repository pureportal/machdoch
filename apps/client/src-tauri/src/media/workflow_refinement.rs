use super::*;

pub(super) fn image_fingerprint(image: &DynamicImage) -> String {
    let mut hash = Sha256::new();
    hash.update(image.width().to_le_bytes());
    hash.update(image.height().to_le_bytes());
    hash.update(image.to_rgba8().as_raw());
    format!("{:x}", hash.finalize())
}

pub(super) fn prompt_feedback(report: &MediaQualityReport) -> String {
    let criteria: Vec<_> = report
        .observations
        .iter()
        .filter(|item| item.metric_id == "visual.criteria" && item.status == "observed")
        .filter_map(|item| item.value.as_ref()?.get("checks")?.as_array())
        .flatten()
        .filter(|check| check["verdict"] == "fail")
        .filter_map(|check| check["criterion"].as_str())
        .map(|criterion| format!("- {criterion}"))
        .collect();
    if criteria.is_empty() {
        String::new()
    } else {
        format!("Required corrections:\n{}", criteria.join("\n"))
    }
}
