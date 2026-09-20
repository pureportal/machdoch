use std::path::Path;

use serde::Serialize;

use super::{hardware, MediaResult, MediaRuntimePaths};

const LOW_STORAGE_BYTES: u64 = 5 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CivitaiStorage {
    free_bytes: u64,
    required_bytes: u64,
    warning: Option<String>,
    pub blocking_reason: Option<String>,
}

pub(super) fn assess(free_bytes: u64, file_bytes: u64, received: u64) -> CivitaiStorage {
    let required_bytes = file_bytes
        .saturating_mul(210)
        .div_ceil(100)
        .saturating_sub(received);
    let gb = |bytes: u64| bytes as f64 / (1024_u64.pow(3)) as f64;
    let blocking_reason = (free_bytes < required_bytes).then(|| format!(
        "Not enough free space: {:.2} GB available; {:.2} GB needed to download and import. Free up space and retry.",
        gb(free_bytes), gb(required_bytes)
    ));
    let warning = (blocking_reason.is_none()
        && free_bytes.saturating_sub(required_bytes) < LOW_STORAGE_BYTES)
        .then(|| {
            format!(
        "Low disk space: less than 5 GB will remain during this import ({:.2} GB free now).",
        gb(free_bytes)
    )
        });
    CivitaiStorage {
        free_bytes,
        required_bytes,
        warning,
        blocking_reason,
    }
}

pub(super) fn check(path: &Path, file_bytes: u64, received: u64) -> MediaResult<CivitaiStorage> {
    let free_bytes = hardware::available_storage_bytes(path).ok_or_else(|| {
        "Could not check free disk space. Check that the model folder is accessible and retry."
            .to_string()
    })?;
    Ok(assess(free_bytes, file_bytes, received))
}

pub(super) fn inspect(paths: &MediaRuntimePaths, file_bytes: u64) -> MediaResult<CivitaiStorage> {
    if file_bytes == 0 || file_bytes > super::civitai_addon::MAX_RESOURCE_BYTES {
        return Err("Invalid model file size. Refresh the model and retry.".to_string());
    }
    let root = paths.models_root()?;
    std::fs::create_dir_all(&root)
        .map_err(|error| format!("Could not access model storage: {error}"))?;
    check(&root, file_bytes, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_insufficient_space_including_import_copies() {
        assert!(assess(999, 1000, 0).blocking_reason.is_some());
        assert!(assess(2099, 1000, 0).blocking_reason.is_some());
        assert!(assess(2100, 1000, 0).blocking_reason.is_none());
    }

    #[test]
    fn warns_near_capacity_and_accounts_for_downloaded_bytes() {
        assert!(assess(2100 + LOW_STORAGE_BYTES - 1, 1000, 0)
            .warning
            .is_some());
        assert!(assess(2100 + LOW_STORAGE_BYTES, 1000, 0).warning.is_none());
        assert!(assess(1100, 1000, 1000).blocking_reason.is_none());
        assert!(assess(1099, 1000, 1000).blocking_reason.is_some());
    }
}
