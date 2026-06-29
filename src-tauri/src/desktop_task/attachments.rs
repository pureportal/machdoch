use std::{
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use super::{
    format_path_for_ui, AttachmentPathGrantMap, ClipboardImageAttachmentRequest,
    DroppedPathsResolution, MAX_ATTACHMENT_PATH_GRANTS, MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES,
};

pub(super) fn remember_attachment_path_grant(
    grants: &AttachmentPathGrantMap,
    path: &str,
) -> Result<(), String> {
    let normalized_path = path.trim();

    if normalized_path.is_empty() {
        return Ok(());
    }

    let candidate_path = PathBuf::from(normalized_path);

    if !candidate_path.is_absolute() {
        return Ok(());
    }

    let resolved_path = candidate_path
        .canonicalize()
        .map_err(|error| format!("Unable to resolve trusted attachment path `{path}`: {error}"))?;
    let metadata = fs::metadata(&resolved_path).map_err(|error| {
        format!(
            "Unable to inspect trusted attachment path `{}`: {error}",
            resolved_path.display()
        )
    })?;

    if !metadata.is_file() && !metadata.is_dir() {
        return Ok(());
    }

    let mut granted_paths = grants
        .0
        .lock()
        .map_err(|_| "Unable to update trusted attachment paths.".to_string())?;

    if granted_paths.len() >= MAX_ATTACHMENT_PATH_GRANTS {
        if let Some(path_to_remove) = granted_paths.iter().next().cloned() {
            granted_paths.remove(&path_to_remove);
        }
    }

    granted_paths.insert(resolved_path);

    Ok(())
}

pub(super) fn remember_dropped_path_grants(
    grants: &AttachmentPathGrantMap,
    resolution: &DroppedPathsResolution,
) -> Result<(), String> {
    for entry in &resolution.entries {
        remember_attachment_path_grant(grants, &entry.path)?;
    }

    Ok(())
}

pub(super) fn attachment_path_is_granted(
    grants: &AttachmentPathGrantMap,
    path: &Path,
) -> Result<bool, String> {
    let granted_paths = grants
        .0
        .lock()
        .map_err(|_| "Unable to inspect trusted attachment paths.".to_string())?;

    Ok(granted_paths.contains(path))
}

pub(super) fn clipboard_image_attachment_directory() -> PathBuf {
    env::temp_dir().join("machdoch").join("clipboard-images")
}

fn clipboard_image_extension(media_type: &str) -> Option<&'static str> {
    match media_type.trim().to_ascii_lowercase().as_str() {
        "image/gif" => Some("gif"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn sanitize_clipboard_image_file_stem(file_name: Option<&str>) -> String {
    let raw_stem = file_name
        .and_then(|name| Path::new(name).file_stem())
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "clipboard-image".to_string());
    let sanitized: String = raw_stem
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect();
    let normalized = sanitized.trim_matches(&['-', '.'][..]).trim();

    if normalized.is_empty() {
        "clipboard-image".to_string()
    } else {
        normalized.to_string()
    }
}

fn base64_decoded_len_upper_bound(value: &str) -> usize {
    let normalized = value.trim();
    let full_chunks = normalized.len() / 4;
    let remainder = normalized.len() % 4;
    let remainder_bytes = match remainder {
        0 => 0,
        2 => 1,
        3 => 2,
        _ => 3,
    };
    let padding = normalized
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count()
        .min(2);

    full_chunks
        .saturating_mul(3)
        .saturating_add(remainder_bytes)
        .saturating_sub(padding)
}

pub(super) fn save_clipboard_image_attachment_sync(
    request: ClipboardImageAttachmentRequest,
) -> Result<String, String> {
    let extension = clipboard_image_extension(&request.media_type).ok_or_else(|| {
        format!(
            "Unsupported clipboard image media type `{}`.",
            request.media_type.trim()
        )
    })?;
    let encoded_image = request.data_base64.trim();

    if base64_decoded_len_upper_bound(encoded_image) > MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES {
        return Err(format!(
            "Clipboard image data is too large. Maximum supported size is {} MiB.",
            MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }

    let image_bytes = BASE64_STANDARD
        .decode(encoded_image)
        .map_err(|error| format!("Failed to decode clipboard image data: {error}"))?;

    if image_bytes.is_empty() {
        return Err("Clipboard image data was empty.".to_string());
    }

    if image_bytes.len() > MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES {
        return Err(format!(
            "Clipboard image data is too large. Maximum supported size is {} MiB.",
            MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES / (1024 * 1024)
        ));
    }

    let output_directory = clipboard_image_attachment_directory();
    fs::create_dir_all(&output_directory).map_err(|error| {
        format!(
            "Failed to create clipboard image directory {}: {error}",
            output_directory.display()
        )
    })?;

    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let file_stem = sanitize_clipboard_image_file_stem(request.file_name.as_deref());
    let output_path = output_directory.join(format!(
        "{file_stem}-{timestamp_ms}-{}.{}",
        std::process::id(),
        extension
    ));

    fs::write(&output_path, image_bytes).map_err(|error| {
        format!(
            "Failed to save clipboard image attachment {}: {error}",
            output_path.display()
        )
    })?;

    Ok(format_path_for_ui(&output_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clipboard_image_file_stems_are_sanitized() {
        assert_eq!(
            sanitize_clipboard_image_file_stem(Some("screen shot!.png")),
            "screen-shot"
        );
        assert_eq!(
            sanitize_clipboard_image_file_stem(Some("...")),
            "clipboard-image"
        );
    }

    #[test]
    fn clipboard_image_extensions_are_allowlisted() {
        assert_eq!(clipboard_image_extension(" image/PNG "), Some("png"));
        assert_eq!(clipboard_image_extension("text/plain"), None);
    }

    #[test]
    fn base64_decoded_length_upper_bound_handles_padding() {
        assert_eq!(base64_decoded_len_upper_bound("AAAA"), 3);
        assert_eq!(base64_decoded_len_upper_bound("AAA="), 2);
        assert_eq!(base64_decoded_len_upper_bound("AA=="), 1);
    }
}
