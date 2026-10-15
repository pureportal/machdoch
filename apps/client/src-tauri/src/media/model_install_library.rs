use std::{
    collections::{hash_map::DefaultHasher, HashMap},
    fs,
    hash::{Hash, Hasher},
    path::Path,
};

use rusqlite::params;

use super::{
    builtin_manifest, builtin_manifests, database, managed_installation, manifest_digest,
    safe_relative_path, total_bytes, validate_package, BuiltinModelManifest, MediaResult,
    MediaRuntimePaths,
};

pub(in crate::media) fn reconcile_library(
    paths: &MediaRuntimePaths,
    connection: &rusqlite::Connection,
) -> MediaResult<()> {
    static RECONCILE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = RECONCILE_LOCK
        .lock()
        .map_err(|error| format!("Could not scan installed models: {error}"))?;
    let root = paths.configured_models_root()?;
    if !root.is_dir() {
        return Ok(());
    }
    for manifest in builtin_manifests() {
        reconcile_package(&root, connection, manifest)?;
    }
    Ok(())
}

fn reconcile_package(
    root: &Path,
    connection: &rusqlite::Connection,
    manifest: &BuiltinModelManifest,
) -> MediaResult<()> {
    let pointer = root
        .join("packages")
        .join(manifest.slug)
        .join("active.json");
    let metadata = match fs::symlink_metadata(&pointer) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Could not inspect installed model: {error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 16_384 {
        return Ok(());
    }
    let bytes =
        fs::read(&pointer).map_err(|error| format!("Could not read installed model: {error}"))?;
    let Ok(active) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return Ok(());
    };
    let digest = manifest_digest(manifest);
    let relative = format!("packages/{}/revisions/{}", manifest.slug, manifest.revision);
    if active["schemaVersion"] != 1
        || active["modelId"] != manifest.model_id
        || active["revision"] != manifest.revision
        || active["manifestDigest"] != digest
        || active["relativePath"] != relative
    {
        return Ok(());
    }
    let registered = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM media_model_installations WHERE model_id = ?1
         AND status = 'installed' AND revision = ?2 AND manifest_digest = ?3 AND relative_path = ?4)",
        params![manifest.model_id, manifest.revision, digest, relative], |row| row.get::<_, bool>(0)
    ).map_err(|error| error.to_string())?;
    let busy = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM media_model_install_jobs WHERE model_id = ?1
         AND status IN ('queued','downloading','verifying','activating','canceling'))
         OR EXISTS(SELECT 1 FROM media_model_removals WHERE model_id = ?1 AND status IN ('prepared','cleanup-pending'))",
        [manifest.model_id], |row| row.get::<_, bool>(0)
    ).map_err(|error| error.to_string())?;
    if registered || busy {
        return Ok(());
    }
    let package = safe_relative_path(root, &relative)?;
    if validate_package(&package, false, manifest).is_err() {
        return Ok(());
    }
    let timestamp = database::now();
    connection.execute(
        "INSERT INTO media_model_installations(model_id, revision, status, manifest_digest, bytes_on_disk,
         installed_at, verified_at, updated_at, relative_path)
         SELECT ?1, ?2, 'installed', ?3, ?4, ?5, NULL, ?5, ?6 WHERE EXISTS(SELECT 1 FROM media_models WHERE id = ?1)
         ON CONFLICT(model_id) DO UPDATE SET revision = excluded.revision, status = 'installed',
         manifest_digest = excluded.manifest_digest, bytes_on_disk = excluded.bytes_on_disk,
         installed_at = excluded.installed_at, verified_at = excluded.verified_at, error = NULL,
         updated_at = excluded.updated_at, relative_path = excluded.relative_path",
        params![manifest.model_id, manifest.revision, digest, total_bytes(manifest) as i64, timestamp, relative]
    ).map_err(|error| format!("Could not recognize installed model: {error}"))?;
    Ok(())
}

fn shared_package_is_valid(root: &Path, manifest: &BuiltinModelManifest) -> MediaResult<bool> {
    if validate_package(root, false, manifest).is_err() {
        return Ok(false);
    }
    static CACHE: std::sync::LazyLock<std::sync::Mutex<HashMap<u64, bool>>> =
        std::sync::LazyLock::new(|| std::sync::Mutex::new(HashMap::new()));
    let mut stamp = DefaultHasher::new();
    root.hash(&mut stamp);
    manifest_digest(manifest).hash(&mut stamp);
    for file in manifest.files.iter() {
        let metadata = fs::metadata(root.join(file.path)).map_err(|error| error.to_string())?;
        metadata.len().hash(&mut stamp);
        metadata
            .modified()
            .map_err(|error| error.to_string())?
            .hash(&mut stamp);
    }
    let stamp = stamp.finish();
    let mut cache = CACHE
        .lock()
        .map_err(|error| format!("Could not read model verification cache: {error}"))?;
    if let Some(valid) = cache.get(&stamp) {
        return Ok(*valid);
    }
    let valid = validate_package(root, true, manifest).is_ok();
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(stamp, valid);
    Ok(valid)
}

pub(in crate::media) fn verify_library_model(
    paths: &MediaRuntimePaths,
    model_id: &str,
) -> MediaResult<()> {
    let manifest = builtin_manifest(model_id)?;
    let installation = managed_installation(paths, model_id)?;
    if installation.revision != manifest.revision
        || installation.manifest_digest != manifest_digest(manifest)
    {
        return Err("The installed model revision does not match its configuration. Remove the model and download it again.".into());
    }
    let root = safe_relative_path(&paths.models_root()?, &installation.relative_path)?;
    if !shared_package_is_valid(&root, manifest)? {
        return Err("The model files changed. Remove the model and download it again.".into());
    }
    database::open(paths)?.execute("UPDATE media_model_installations SET verified_at = ?2 WHERE model_id = ?1 AND verified_at IS NULL",
        params![model_id, database::now()]).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{ManifestFile, FLUX_MANIFEST};
    use super::*;
    use std::borrow::Cow;

    #[test]
    fn shared_builtin_packages_are_recognized_quickly_and_verified_before_use() {
        let root = std::env::temp_dir().join(format!(
            "machdoch-shared-models-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let paths = MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs/sha256"),
            _storage_lease: None,
        };
        database::initialize(&paths).unwrap();
        let manifest = BuiltinModelManifest {
            files: Cow::Borrowed(&[ManifestFile {
                path: "weights.safetensors",
                byte_size: 5,
                sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            }]),
            ..FLUX_MANIFEST.clone()
        };
        let models_root = paths.models_root().unwrap();
        let relative = format!("packages/{}/revisions/{}", manifest.slug, manifest.revision);
        let revision = models_root.join(&relative);
        fs::create_dir_all(&revision).unwrap();
        fs::write(revision.join("weights.safetensors"), b"wrong").unwrap();
        let pointer = models_root
            .join("packages")
            .join(manifest.slug)
            .join("active.json");
        fs::write(
            &pointer,
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1, "modelId": manifest.model_id, "revision": manifest.revision,
                "manifestDigest": manifest_digest(&manifest), "relativePath": relative,
            }))
            .unwrap(),
        )
        .unwrap();
        let connection = database::open(&paths).unwrap();
        reconcile_package(&models_root, &connection, &manifest).unwrap();
        let count = || {
            connection
                .query_row(
                    "SELECT COUNT(*) FROM media_model_installations",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap()
        };
        assert_eq!(count(), 1);
        assert!(!shared_package_is_valid(&revision, &manifest).unwrap());
        assert!(connection
            .query_row(
                "SELECT verified_at FROM media_model_installations",
                [],
                |row| row.get::<_, Option<String>>(0)
            )
            .unwrap()
            .is_none());
        fs::write(revision.join("weights.safetensors"), b"hello").unwrap();
        assert!(shared_package_is_valid(&revision, &manifest).unwrap());
        reconcile_package(&models_root, &connection, &manifest).unwrap();
        assert_eq!(count(), 1);
        reconcile_package(&models_root, &connection, &manifest).unwrap();
        assert_eq!(count(), 1);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
