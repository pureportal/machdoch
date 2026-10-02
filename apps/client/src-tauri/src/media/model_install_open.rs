use std::{borrow::Cow, sync::OnceLock};

use serde::Deserialize;

use super::{BuiltinModelManifest, ManifestFile};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSnapshot {
    model_id: String,
    slug: String,
    display_name: String,
    revision: String,
    source_url: String,
    download_root: String,
    license_digest: String,
    license_name: String,
    license_spdx_id: Option<String>,
    license_source_url: String,
    license_requires_acceptance: bool,
    package_description: String,
    files: Vec<FileSnapshot>,
    excluded_paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileSnapshot {
    path: String,
    byte_size: u64,
    sha256: String,
}

pub(super) fn manifests() -> &'static [BuiltinModelManifest] {
    static SNAPSHOTS: OnceLock<Vec<ManifestSnapshot>> = OnceLock::new();
    static MANIFESTS: OnceLock<Vec<BuiltinModelManifest>> = OnceLock::new();
    let snapshots = SNAPSHOTS.get_or_init(|| {
        serde_json::from_str(include_str!("open_model_manifests.json"))
            .expect("bundled media installation manifests must be valid")
    });
    MANIFESTS.get_or_init(|| {
        snapshots
            .iter()
            .map(|snapshot| BuiltinModelManifest {
                model_id: &snapshot.model_id,
                slug: &snapshot.slug,
                display_name: &snapshot.display_name,
                revision: &snapshot.revision,
                source_url: &snapshot.source_url,
                download_root: &snapshot.download_root,
                license_digest: &snapshot.license_digest,
                license_name: &snapshot.license_name,
                license_spdx_id: snapshot.license_spdx_id.as_deref(),
                license_source_url: &snapshot.license_source_url,
                license_requires_acceptance: snapshot.license_requires_acceptance,
                package_description: &snapshot.package_description,
                files: Cow::Owned(
                    snapshot
                        .files
                        .iter()
                        .map(|file| ManifestFile {
                            path: &file.path,
                            byte_size: file.byte_size,
                            sha256: &file.sha256,
                        })
                        .collect(),
                ),
                excluded_paths: Cow::Owned(
                    snapshot.excluded_paths.iter().map(String::as_str).collect(),
                ),
            })
            .collect()
    })
}
