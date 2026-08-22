use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};

use super::{
    format_path_for_ui, AttachmentPathGrantMap, ClipboardImageAttachmentRequest,
    DroppedPathsResolution, MAX_ATTACHMENT_PATH_GRANTS, MAX_CLIPBOARD_IMAGE_ATTACHMENT_BYTES,
};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};

static CLIPBOARD_IMAGE_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

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

#[cfg(unix)]
fn create_clipboard_image_attachment_directory(output_directory: &Path) -> Result<(), String> {
    let mut directory_builder = fs::DirBuilder::new();
    directory_builder.recursive(true);
    directory_builder.mode(0o700);
    directory_builder
        .create(output_directory)
        .map_err(|error| {
            format!(
                "Failed to create clipboard image directory {}: {error}",
                output_directory.display()
            )
        })?;

    secure_clipboard_image_attachment_directory(output_directory)
}

#[cfg(not(unix))]
fn create_clipboard_image_attachment_directory(output_directory: &Path) -> Result<(), String> {
    fs::create_dir_all(output_directory).map_err(|error| {
        format!(
            "Failed to create clipboard image directory {}: {error}",
            output_directory.display()
        )
    })
}

#[cfg(unix)]
fn secure_clipboard_image_attachment_directory(output_directory: &Path) -> Result<(), String> {
    let mut permissions = fs::metadata(output_directory)
        .map_err(|error| {
            format!(
                "Failed to inspect clipboard image directory {}: {error}",
                output_directory.display()
            )
        })?
        .permissions();
    permissions.set_mode(0o700);
    fs::set_permissions(output_directory, permissions).map_err(|error| {
        format!(
            "Failed to secure clipboard image directory {}: {error}",
            output_directory.display()
        )
    })
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

fn build_clipboard_image_attachment_path(
    output_directory: &Path,
    file_stem: &str,
    timestamp_ms: u128,
    process_id: u32,
    extension: &str,
) -> PathBuf {
    let unique_id = CLIPBOARD_IMAGE_FILE_COUNTER.fetch_add(1, Ordering::SeqCst);

    output_directory.join(format!(
        "{file_stem}-{timestamp_ms}-{process_id}-{unique_id}.{extension}"
    ))
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
    create_clipboard_image_attachment_directory(&output_directory)?;

    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let file_stem = sanitize_clipboard_image_file_stem(request.file_name.as_deref());
    let output_path = build_clipboard_image_attachment_path(
        &output_directory,
        &file_stem,
        timestamp_ms,
        std::process::id(),
        extension,
    );

    write_file_atomic(
        &output_path,
        &image_bytes,
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| {
        format!(
            "Failed to save clipboard image attachment {}: {error}",
            output_path.display()
        )
    })?;

    Ok(format_path_for_ui(&output_path))
}

#[cfg(test)]
mod tests {
    use base64::Engine as _;

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

    #[test]
    fn clipboard_image_attachment_paths_are_unique_for_same_millisecond_and_process() {
        let output_directory = std::env::temp_dir();
        let first_path = build_clipboard_image_attachment_path(
            &output_directory,
            "screen-shot",
            1_771_220_400_000,
            42,
            "png",
        );
        let second_path = build_clipboard_image_attachment_path(
            &output_directory,
            "screen-shot",
            1_771_220_400_000,
            42,
            "png",
        );

        assert_ne!(first_path, second_path);
        let first_file_name = first_path
            .file_name()
            .expect("first path should include a filename")
            .to_string_lossy();

        assert!(first_file_name.starts_with("screen-shot-1771220400000-42-"));
        assert!(first_file_name.ends_with(".png"));
        assert_eq!(
            first_path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("png")
        );
    }

    #[test]
    fn repeated_clipboard_image_attachment_saves_return_distinct_paths() {
        let data_base64 = base64::engine::general_purpose::STANDARD.encode([0_u8, 1_u8, 2_u8]);
        let first_path = save_clipboard_image_attachment_sync(ClipboardImageAttachmentRequest {
            data_base64: data_base64.clone(),
            media_type: "image/png".to_string(),
            file_name: Some("same name.png".to_string()),
        })
        .expect("first clipboard image attachment should be saved");
        let second_path = save_clipboard_image_attachment_sync(ClipboardImageAttachmentRequest {
            data_base64,
            media_type: "image/png".to_string(),
            file_name: Some("same name.png".to_string()),
        })
        .expect("second clipboard image attachment should be saved");

        assert_ne!(first_path, second_path);
        assert_eq!(
            fs::read(&first_path).expect("first image should be readable"),
            [0, 1, 2]
        );
        assert_eq!(
            fs::read(&second_path).expect("second image should be readable"),
            [0, 1, 2]
        );

        let _ = fs::remove_file(first_path);
        let _ = fs::remove_file(second_path);
    }

    #[cfg(unix)]
    #[test]
    fn clipboard_image_attachment_save_uses_private_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let data_base64 = base64::engine::general_purpose::STANDARD.encode([0_u8, 1_u8, 2_u8]);
        let saved_path = save_clipboard_image_attachment_sync(ClipboardImageAttachmentRequest {
            data_base64,
            media_type: "image/png".to_string(),
            file_name: Some("private.png".to_string()),
        })
        .expect("clipboard image attachment should be saved");
        let saved_path = PathBuf::from(saved_path);

        assert_eq!(
            fs::metadata(&saved_path)
                .expect("saved image should be inspectable")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(
                saved_path
                    .parent()
                    .expect("saved image should have an output directory")
            )
            .expect("clipboard image directory should be inspectable")
            .permissions()
            .mode()
                & 0o777,
            0o700
        );

        let _ = fs::remove_file(saved_path);
    }

    #[test]
    fn clipboard_image_attachment_rejects_oversized_payloads() {
        let data_base64 =
            base64::engine::general_purpose::STANDARD.encode(vec![0_u8; (20 * 1024 * 1024) + 1]);

        let result = save_clipboard_image_attachment_sync(ClipboardImageAttachmentRequest {
            data_base64,
            media_type: "image/png".to_string(),
            file_name: Some("huge.png".to_string()),
        });

        assert!(result
            .expect_err("oversized clipboard images should be rejected")
            .contains("too large"));
    }
}
