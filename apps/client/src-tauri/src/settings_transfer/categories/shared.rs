use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path},
};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization as _;
use zeroize::{Zeroize as _, Zeroizing};

use super::{
    category_schema_version, CategorySnapshot, CategorySnapshotData, FileSnapshotEntry,
    SettingsCategoryId, SnapshotAvailability,
};

const MAX_RELATIVE_PATH_BYTES: usize = 512;
pub(super) const MAX_RELATIVE_PATH_DEPTH: usize = 12;
const MAX_PATH_COMPONENT_BYTES: usize = 255;

pub(super) fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect()
}

pub(super) fn create_json_snapshot(
    id: SettingsCategoryId,
    value: Value,
    item_count: u32,
    empty: bool,
) -> Result<CategorySnapshot, String> {
    let data = CategorySnapshotData::Json(value);
    create_snapshot(id, data, item_count, empty)
}

pub(super) fn create_file_snapshot(
    id: SettingsCategoryId,
    entries: Vec<FileSnapshotEntry>,
) -> Result<CategorySnapshot, String> {
    let item_count =
        u32::try_from(entries.len()).map_err(|_| "Too many settings files.".to_string())?;
    create_snapshot(
        id,
        CategorySnapshotData::Files(entries),
        item_count,
        item_count == 0,
    )
}

fn create_snapshot(
    id: SettingsCategoryId,
    data: CategorySnapshotData,
    item_count: u32,
    empty: bool,
) -> Result<CategorySnapshot, String> {
    let bytes = Zeroizing::new(
        serde_json::to_vec(&data)
            .map_err(|_| "The selected settings could not be serialized.".to_string())?,
    );
    Ok(CategorySnapshot {
        id,
        schema_version: category_schema_version(id),
        replacement: if empty { "empty" } else { "value" }.to_string(),
        item_count,
        plaintext_bytes: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
        data,
    })
}

pub(crate) fn relative_path_to_wire(relative: &Path) -> Result<String, String> {
    let mut components = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => components.push(
                value
                    .to_str()
                    .ok_or_else(|| "A settings path is not valid UTF-8.".to_string())?,
            ),
            _ => return Err("A settings path is not relative.".to_string()),
        }
    }
    Ok(components.join("/"))
}

fn is_windows_reserved_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .trim_end_matches([' ', '.'])
        .to_ascii_lowercase();
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ["com", "lpt"].iter().any(|prefix| {
            stem.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}

fn contains_windows_forbidden_character(component: &str) -> bool {
    component.chars().any(|character| {
        character <= '\u{1f}' || matches!(character, '<' | '>' | '"' | '|' | '?' | '*')
    })
}

pub(crate) fn validate_wire_path(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.len() > MAX_RELATIVE_PATH_BYTES
        || path.contains('\0')
        || path.contains('\\')
        || path.starts_with('/')
        || path.nfc().collect::<String>() != path
    {
        return Err("A settings entry has an invalid relative path.".to_string());
    }
    let components = path.split('/').collect::<Vec<_>>();
    if components.len() > MAX_RELATIVE_PATH_DEPTH
        || components.iter().any(|component| {
            component.is_empty()
                || component.len() > MAX_PATH_COMPONENT_BYTES
                || matches!(*component, "." | "..")
                || component.contains(':')
                || component.starts_with(' ')
                || component.ends_with([' ', '.'])
                || contains_windows_forbidden_character(component)
                || is_windows_reserved_component(component)
        })
    {
        return Err("A settings entry has an unsafe relative path.".to_string());
    }
    Ok(())
}

pub(crate) fn has_file_ancestor_collision<'a>(aliases: impl IntoIterator<Item = &'a str>) -> bool {
    let aliases = aliases.into_iter().collect::<HashSet<_>>();
    aliases.iter().any(|alias| {
        let mut ancestor = *alias;
        while let Some((parent, _)) = ancestor.rsplit_once('/') {
            if aliases.contains(parent) {
                return true;
            }
            ancestor = parent;
        }
        false
    })
}

pub(crate) fn category_data_json(
    snapshot: &CategorySnapshot,
) -> Result<&Map<String, Value>, String> {
    match &snapshot.data {
        CategorySnapshotData::Json(Value::Object(value)) => Ok(value),
        _ => Err("The category does not contain JSON settings.".to_string()),
    }
}

pub(crate) fn category_file_entries(
    snapshot: &CategorySnapshot,
) -> Result<&[FileSnapshotEntry], String> {
    match &snapshot.data {
        CategorySnapshotData::Files(entries) => Ok(entries),
        _ => Err("The category does not contain settings files.".to_string()),
    }
}

pub(crate) fn zeroize_json_value(value: &mut Value) {
    match value {
        Value::String(value) => value.zeroize(),
        Value::Array(values) => {
            for value in values.iter_mut() {
                zeroize_json_value(value);
            }
            values.clear();
        }
        Value::Object(values) => {
            for (mut key, mut value) in std::mem::take(values) {
                key.zeroize();
                zeroize_json_value(&mut value);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

pub(crate) fn zeroize_snapshot(snapshot: &mut CategorySnapshot) {
    snapshot.replacement.zeroize();
    snapshot.sha256.zeroize();
    match &mut snapshot.data {
        CategorySnapshotData::Json(value) => zeroize_json_value(value),
        CategorySnapshotData::Files(entries) => {
            for entry in entries.iter_mut() {
                entry.relative_path.zeroize();
                entry.utf8_content.zeroize();
                entry.sha256.zeroize();
            }
            entries.clear();
        }
    }
}

pub(crate) fn zeroize_snapshot_availability(snapshot: &mut SnapshotAvailability) {
    if let SnapshotAvailability::Available(snapshot) = snapshot {
        zeroize_snapshot(snapshot);
    }
}

pub(crate) fn zeroize_snapshots(
    snapshots: &mut BTreeMap<SettingsCategoryId, SnapshotAvailability>,
) {
    for snapshot in snapshots.values_mut() {
        zeroize_snapshot_availability(snapshot);
    }
    snapshots.clear();
}

pub(crate) fn zeroize_envelope(envelope: &mut super::super::contract::TransferEnvelope) {
    envelope.transfer_id.zeroize();
    for snapshot in &mut envelope.categories {
        zeroize_snapshot(snapshot);
    }
    envelope.categories.clear();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_paths_reject_traversal_aliases_and_non_normalized_unicode() {
        for invalid in [
            "../secret.md",
            "/absolute.md",
            "C:/secret.md",
            "folder\\secret.md",
            "folder/con.txt",
            "folder/COM¹.log",
            "folder/name. ",
            "folder/ leading.prompt.md",
            "folder/question?.prompt.md",
            "folder/control\u{1f}.prompt.md",
            "folder//file.md",
            "prompts/e\u{301}.prompt.md",
        ] {
            assert!(
                validate_wire_path(invalid).is_err(),
                "{invalid} should fail"
            );
        }
        let oversized_component =
            format!("prompts/{}.prompt.md", "a".repeat(MAX_PATH_COMPONENT_BYTES));
        assert!(validate_wire_path(&oversized_component).is_err());
        assert!(validate_wire_path("prompts/é.prompt.md").is_ok());
    }
}
