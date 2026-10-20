use super::*;

pub fn records(project: &Value) -> Result<&[Value], String> {
    match project.get("readingBookmarks") {
        None => Ok(&[]),
        Some(value) => value.as_array().filter(|values| values.len() <= MAX_ITEMS).map(Vec::as_slice)
            .ok_or_else(|| "Keep reading bookmarks within the project record limit.".into()),
    }
}

pub fn validate(project: &Value) -> Result<(), String> {
    let mut ids = HashSet::new();
    for bookmark in records(project)? {
        fields(bookmark, &["id", "label", "takeId", "assetSha256", "seconds"])?;
        unique(&mut ids, identifier(bookmark, "id")?)?;
        if text(bookmark, "label", 1, 1024)?.trim().is_empty() {
            return Err("Enter a reading bookmark name.".into());
        }
        identifier(bookmark, "takeId")?;
        asset_identifier(required(bookmark, "assetSha256")?)?;
        number(bookmark, "seconds", 0.0, f64::MAX)?;
    }
    Ok(())
}

pub fn validate_evidence(bookmark: &Value, take: &Value, project: &Value) -> Result<(), String> {
    if take["projectId"] != project["id"] || bookmark["takeId"] != take["id"]
        || bookmark["assetSha256"] != take["asset"]["sha256"] {
        return Err("A reading bookmark must refer to this project's immutable take audio.".into());
    }
    let duration = take["asset"]["duration"].as_f64().filter(|value| value.is_finite() && *value > 0.0)
        .ok_or("A reading bookmark needs a measured audio duration.")?;
    if bookmark["seconds"].as_f64().is_none_or(|seconds| !seconds.is_finite() || seconds < 0.0 || seconds > duration) {
        return Err("Keep reading bookmarks within their take's measured audio duration.".into());
    }
    Ok(())
}
