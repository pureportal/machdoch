use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

use reqwest::{header, Client, StatusCode};
use rusqlite::{params, OptionalExtension as _};
use sha2::{Digest as _, Sha256};

use super::{
    catalog, database, error::MediaError, hardware, model_import, MediaModelInstallJob,
    MediaModelInstallManifestFile, MediaModelInstallPlan, MediaModelLicense, MediaModelRemovalPlan,
    MediaModelRemovalResult, MediaResult, MediaRuntimePaths, RemoveMediaModelRequest,
    StartMediaModelInstallRequest,
};

const FLUX_MODEL_ID: &str = "local:flux-2-klein-4b";
const FLUX_MODEL_SLUG: &str = "flux-2-klein-4b";
const FLUX_REVISION: &str = "e7b7dc27f91deacad38e78976d1f2b499d76a294";
const FLUX_DOWNLOAD_ROOT: &str = "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B/resolve";
const FLUX_LICENSE_DIGEST: &str =
    "ca02bc51900ab07789d1b70283329e7137f5af98f5161c23a1c81fc38a4af1fe";
const BIREFNET_MODEL_ID: &str = "local:birefnet-matting";
const BIREFNET_MODEL_SLUG: &str = "birefnet-matting";
const BIREFNET_REVISION: &str = "a0cf9925880620000aa2d1948d61bf659ddfdfaa";
const BIREFNET_DOWNLOAD_ROOT: &str = "https://github.com/ZhengPeng7/BiRefNet/releases/download/v1";
const BIREFNET_LICENSE_URL: &str = "https://raw.githubusercontent.com/ZhengPeng7/BiRefNet/a0cf9925880620000aa2d1948d61bf659ddfdfaa/LICENSE";
const BIREFNET_LICENSE_DIGEST: &str =
    "92a7089e0915fc32bc40067560b398f1e6a7a5958abd7d04eda393629a5acefb";
const PROGRESS_WRITE_BYTES: u64 = 32 * 1_024 * 1_024;
const CANCELED_SENTINEL: &str = "model installation canceled";

#[derive(Clone, Copy)]
struct ManifestFile {
    path: &'static str,
    byte_size: u64,
    sha256: &'static str,
}

struct BuiltinModelManifest {
    model_id: &'static str,
    slug: &'static str,
    display_name: &'static str,
    revision: &'static str,
    source_url: &'static str,
    download_root: &'static str,
    license_digest: &'static str,
    license_name: &'static str,
    license_spdx_id: Option<&'static str>,
    license_source_url: &'static str,
    license_requires_acceptance: bool,
    package_description: &'static str,
    files: &'static [ManifestFile],
    excluded_paths: &'static [&'static str],
}

const FLUX_FILES: &[ManifestFile] = &[
    ManifestFile {
        path: "LICENSE.md",
        byte_size: 9_584,
        sha256: "ca02bc51900ab07789d1b70283329e7137f5af98f5161c23a1c81fc38a4af1fe",
    },
    ManifestFile {
        path: "model_index.json",
        byte_size: 446,
        sha256: "51a76cb1cf3ed37423a1128c79c22faee8e6fbe7f5aaeb737f0a258930dbaac0",
    },
    ManifestFile {
        path: "scheduler/scheduler_config.json",
        byte_size: 486,
        sha256: "067afb012cef64553a763447d1efd93daeffcc0123ca7e25b09f8de20b90762e",
    },
    ManifestFile {
        path: "text_encoder/config.json",
        byte_size: 1_536,
        sha256: "214b4c29a0d975e9fddf9994a5673f22cb2c4c5750352f9227c2c3251ebeab40",
    },
    ManifestFile {
        path: "text_encoder/generation_config.json",
        byte_size: 214,
        sha256: "4347b1aeed2b2b78bc059920a0b7f5fec71482e1344952b76d7665d638d71f13",
    },
    ManifestFile {
        path: "text_encoder/model-00001-of-00002.safetensors",
        byte_size: 4_967_215_360,
        sha256: "8c0506e7f4936fa7e26183a4fd8da4e2bdbc5990ba64ae441f965d51228f36ea",
    },
    ManifestFile {
        path: "text_encoder/model-00002-of-00002.safetensors",
        byte_size: 3_077_766_632,
        sha256: "82f2bd839378541b0557bfabaf37c7d3d637071fdcb73302dedd7cf61162ce07",
    },
    ManifestFile {
        path: "text_encoder/model.safetensors.index.json",
        byte_size: 32_855,
        sha256: "06b3d5319b6d76d1a4a2433419180016cfd54ed62d086a5e6567a809f8c82634",
    },
    ManifestFile {
        path: "tokenizer/added_tokens.json",
        byte_size: 707,
        sha256: "c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680",
    },
    ManifestFile {
        path: "tokenizer/chat_template.jinja",
        byte_size: 4_168,
        sha256: "a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8",
    },
    ManifestFile {
        path: "tokenizer/merges.txt",
        byte_size: 1_671_853,
        sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
    },
    ManifestFile {
        path: "tokenizer/special_tokens_map.json",
        byte_size: 613,
        sha256: "76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd",
    },
    ManifestFile {
        path: "tokenizer/tokenizer.json",
        byte_size: 11_422_654,
        sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
    },
    ManifestFile {
        path: "tokenizer/tokenizer_config.json",
        byte_size: 5_404,
        sha256: "443bfa629eb16387a12edbf92a76f6a6f10b2af3b53d87ba1550adfcf45f7fa0",
    },
    ManifestFile {
        path: "tokenizer/vocab.json",
        byte_size: 2_776_833,
        sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
    },
    ManifestFile {
        path: "transformer/config.json",
        byte_size: 541,
        sha256: "09733c74a3da6d17dd0a0472a091a8950c7c6935889c32c16cc800ede05029de",
    },
    ManifestFile {
        path: "transformer/diffusion_pytorch_model.safetensors",
        byte_size: 7_751_109_744,
        sha256: "9f29f9edcfdae452a653ffb51a534ca4decd389952c225724ff3b94042612a6e",
    },
    ManifestFile {
        path: "vae/config.json",
        byte_size: 821,
        sha256: "0d6dfb69ae95a5e2ac9836284bbb63d8b38ce67b25ba2dff380752b2a10ab948",
    },
    ManifestFile {
        path: "vae/diffusion_pytorch_model.safetensors",
        byte_size: 168_120_878,
        sha256: "ca70d2202afe6415bdbcb8793ba8cd99fd159cfe6192381504d6c4d3036e0f04",
    },
];

const FLUX_EXCLUDED_PATHS: &[&str] = &[
    "flux-2-klein-4b.safetensors (duplicate single-file checkpoint)",
    ".gitattributes and repository documentation",
    "example images and community metadata",
];

const BIREFNET_FILES: &[ManifestFile] = &[
    ManifestFile {
        path: "LICENSE",
        byte_size: 1_066,
        sha256: BIREFNET_LICENSE_DIGEST,
    },
    ManifestFile {
        path: "BiRefNet-matting-epoch_100.onnx",
        byte_size: 972_667_742,
        sha256: "6065d27c615ea27308f5b88598dd8db116eb07436c7a323ca40d13b2866c309e",
    },
];

const BIREFNET_EXCLUDED_PATHS: &[&str] = &[
    "training checkpoints, datasets, and repository source code",
    "third-party ONNX conversions and quantized variants",
];

const FLUX_MANIFEST: BuiltinModelManifest = BuiltinModelManifest {
    model_id: FLUX_MODEL_ID,
    slug: FLUX_MODEL_SLUG,
    display_name: "FLUX.2 klein 4B",
    revision: FLUX_REVISION,
    source_url: "https://huggingface.co/black-forest-labs/FLUX.2-klein-4B",
    download_root: FLUX_DOWNLOAD_ROOT,
    license_digest: FLUX_LICENSE_DIGEST,
    license_name: "Apache License 2.0",
    license_spdx_id: Some("Apache-2.0"),
    license_source_url: "https://www.apache.org/licenses/LICENSE-2.0",
    license_requires_acceptance: true,
    package_description: "pinned Diffusers allowlist",
    files: FLUX_FILES,
    excluded_paths: FLUX_EXCLUDED_PATHS,
};

const BIREFNET_MANIFEST: BuiltinModelManifest = BuiltinModelManifest {
    model_id: BIREFNET_MODEL_ID,
    slug: BIREFNET_MODEL_SLUG,
    display_name: "BiRefNet Matting",
    revision: BIREFNET_REVISION,
    source_url: "https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1",
    download_root: BIREFNET_DOWNLOAD_ROOT,
    license_digest: BIREFNET_LICENSE_DIGEST,
    license_name: "MIT License",
    license_spdx_id: Some("MIT"),
    license_source_url: "https://github.com/ZhengPeng7/BiRefNet/blob/a0cf9925880620000aa2d1948d61bf659ddfdfaa/LICENSE",
    license_requires_acceptance: true,
    package_description: "official BiRefNet matting ONNX release and license",
    files: BIREFNET_FILES,
    excluded_paths: BIREFNET_EXCLUDED_PATHS,
};

const BUILTIN_MANIFESTS: &[&BuiltinModelManifest] = &[&FLUX_MANIFEST, &BIREFNET_MANIFEST];

fn builtin_manifest(model_id: &str) -> MediaResult<&'static BuiltinModelManifest> {
    BUILTIN_MANIFESTS
        .iter()
        .copied()
        .find(|manifest| manifest.model_id == model_id)
        .ok_or_else(|| "this model does not have a managed installation manifest".to_string())
}

fn total_bytes(manifest: &BuiltinModelManifest) -> u64 {
    manifest.files.iter().map(|file| file.byte_size).sum()
}

fn manifest_digest(manifest: &BuiltinModelManifest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-media-model-manifest-v1\0");
    hasher.update(manifest.model_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(manifest.revision.as_bytes());
    for file in manifest.files {
        hasher.update(b"\0");
        hasher.update(file.path.as_bytes());
        hasher.update(b"\0");
        hasher.update(file.byte_size.to_string().as_bytes());
        hasher.update(b"\0");
        hasher.update(file.sha256.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}

fn review_token(
    manifest: &BuiltinModelManifest,
    manifest_digest: &str,
    required_working_bytes: u64,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-media-model-install-review-v1\0");
    for value in [
        manifest.model_id,
        manifest.revision,
        manifest_digest,
        manifest.license_digest,
        &total_bytes(manifest).to_string(),
        &required_working_bytes.to_string(),
    ] {
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

fn removal_confirmation_token(
    model_id: &str,
    revision: &str,
    manifest_digest: &str,
    byte_size: u64,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-media-model-removal-v1\0");
    for value in [model_id, revision, manifest_digest, &byte_size.to_string()] {
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

struct ManagedInstallation {
    model_id: String,
    display_name: String,
    revision: String,
    manifest_digest: String,
    byte_size: u64,
    relative_path: String,
    package_slug: String,
}

fn managed_package_slug(
    model_id: &str,
    revision: &str,
    relative_path: &str,
) -> MediaResult<String> {
    let components = Path::new(relative_path)
        .components()
        .map(|component| match component {
            Component::Normal(value) => value.to_str().map(str::to_string),
            _ => None,
        })
        .collect::<Option<Vec<_>>>()
        .ok_or_else(|| "the installed model path is not a managed package path".to_string())?;
    if components.len() != 4
        || components[0] != "packages"
        || components[2] != "revisions"
        || components[3] != revision
    {
        return Err("the installed model path is not a managed revision directory".to_string());
    }
    let package_slug = &components[1];
    let is_builtin = BUILTIN_MANIFESTS
        .iter()
        .any(|manifest| model_id == manifest.model_id && package_slug == manifest.slug);
    let is_user_import = model_id.starts_with(model_import::USER_MODEL_ID_PREFIX)
        && package_slug.starts_with("user-");
    if !is_builtin && !is_user_import {
        return Err("the installed model path does not match its managed model id".to_string());
    }
    Ok(package_slug.clone())
}

fn managed_installation(
    paths: &MediaRuntimePaths,
    model_id: &str,
) -> MediaResult<ManagedInstallation> {
    if builtin_manifest(model_id).is_err()
        && !model_id.starts_with(model_import::USER_MODEL_ID_PREFIX)
    {
        return Err("this model is not managed by the local model store".to_string());
    }
    let connection = database::open(paths)?;
    let installation = connection
        .query_row(
            "SELECT m.display_name, m.target, m.bundled, i.revision, i.manifest_digest,
                    i.bytes_on_disk, i.relative_path
             FROM media_models m
             JOIN media_model_installations i ON i.model_id = m.id
             WHERE m.id = ?1 AND i.status = 'installed'",
            params![model_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?.max(0) as u64,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect installed model: {error}"))?
        .ok_or_else(|| "the model is not currently installed".to_string())?;
    if installation.1 != "local" || installation.2 {
        return Err("this model is not removable from the local model store".to_string());
    }
    let relative_path = installation
        .6
        .ok_or_else(|| "the installed model has no managed storage path".to_string())?;
    let package_slug = managed_package_slug(model_id, &installation.3, &relative_path)?;
    Ok(ManagedInstallation {
        model_id: model_id.to_string(),
        display_name: installation.0,
        revision: installation.3,
        manifest_digest: installation.4,
        byte_size: installation.5,
        relative_path,
        package_slug,
    })
}

pub(crate) fn installed_builtin_file(
    paths: &MediaRuntimePaths,
    model_id: &str,
    relative_file: &str,
) -> MediaResult<PathBuf> {
    let manifest = builtin_manifest(model_id)?;
    let expected = manifest
        .files
        .iter()
        .find(|file| file.path == relative_file)
        .ok_or_else(|| {
            "the requested file is not part of the managed model manifest".to_string()
        })?;
    let installation = managed_installation(paths, model_id)?;
    if installation.revision != manifest.revision
        || installation.manifest_digest != manifest_digest(manifest)
    {
        return Err(
            "the installed model revision does not match the supported manifest".to_string(),
        );
    }
    let root = safe_relative_path(&paths.models_root()?, &installation.relative_path)?;
    let path = safe_relative_path(&root, relative_file)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "the installed model file is missing; reinstall the model".to_string())?;
    if !metadata.is_file() || metadata.len() != expected.byte_size {
        return Err(
            "the installed model file failed its size check; reinstall the model".to_string(),
        );
    }
    Ok(path)
}

fn safe_relative_path(root: &Path, value: &str) -> MediaResult<PathBuf> {
    if value.is_empty() || value.contains('\\') {
        return Err("model manifest contains an unsafe file path".to_string());
    }
    let relative = Path::new(value);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("model manifest contains an unsafe file path".to_string());
    }
    Ok(root.join(relative))
}

fn installation_exists(
    paths: &MediaRuntimePaths,
    manifest: &BuiltinModelManifest,
) -> MediaResult<bool> {
    database::open(paths)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM media_model_installations WHERE model_id = ?1 AND status = 'installed' AND revision = ?2)",
            params![manifest.model_id, manifest.revision],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect model installation: {error}"))
}

pub(crate) fn plan(
    paths: &MediaRuntimePaths,
    model_id: &str,
) -> MediaResult<MediaModelInstallPlan> {
    let manifest = builtin_manifest(model_id)?;
    let models_root = paths.models_root()?;
    fs::create_dir_all(&models_root)
        .map_err(|error| format!("failed to prepare model storage: {error}"))?;
    let total_bytes = total_bytes(manifest);
    let required_working_bytes = total_bytes.saturating_mul(112).div_ceil(100);
    let available_bytes = hardware::available_storage_bytes(&models_root);
    let has_sufficient_space = available_bytes.map(|available| available >= required_working_bytes);
    let manifest_digest = manifest_digest(manifest);
    let mut warnings = vec![
        format!(
            "The installer downloads only the {}; no repository code is executed.",
            manifest.package_description
        ),
        "Activation occurs only after every size and SHA-256 check succeeds.".to_string(),
    ];
    if has_sufficient_space == Some(false) {
        warnings.push(
            "The selected media storage volume does not currently have enough free space."
                .to_string(),
        );
    } else if has_sufficient_space.is_none() {
        warnings.push(
            "Free space could not be measured on this platform; verify it before installing."
                .to_string(),
        );
    }
    Ok(MediaModelInstallPlan {
        schema_version: 1,
        model_id: manifest.model_id.to_string(),
        display_name: manifest.display_name.to_string(),
        revision: manifest.revision.to_string(),
        manifest_digest: manifest_digest.clone(),
        license_digest: manifest.license_digest.to_string(),
        review_token: review_token(manifest, &manifest_digest, required_working_bytes),
        source_url: manifest.source_url.to_string(),
        target_label: format!(
            "models/packages/{}/revisions/{}",
            manifest.slug, manifest.revision
        ),
        files: manifest
            .files
            .iter()
            .map(|file| MediaModelInstallManifestFile {
                path: file.path.to_string(),
                byte_size: file.byte_size,
                sha256: file.sha256.to_string(),
            })
            .collect(),
        excluded_paths: manifest
            .excluded_paths
            .iter()
            .map(|value| (*value).to_string())
            .collect(),
        total_bytes,
        required_working_bytes,
        available_bytes,
        has_sufficient_space,
        already_installed: installation_exists(paths, manifest)?,
        license: MediaModelLicense {
            name: manifest.license_name.to_string(),
            spdx_id: manifest.license_spdx_id.map(str::to_string),
            source_url: manifest.license_source_url.to_string(),
            commercial_use: "allowed".to_string(),
            requires_acceptance: manifest.license_requires_acceptance,
        },
        warnings,
    })
}

fn new_job_id() -> MediaResult<String> {
    let mut random = [0_u8; 12];
    getrandom::fill(&mut random)
        .map_err(|error| format!("failed to create model installation id: {error}"))?;
    Ok(format!(
        "model-install-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

pub(crate) fn start(
    paths: &MediaRuntimePaths,
    request: &StartMediaModelInstallRequest,
) -> MediaResult<MediaModelInstallJob> {
    let manifest = builtin_manifest(request.model_id.trim())?;
    let plan = plan(paths, manifest.model_id)?;
    if request.manifest_digest != plan.manifest_digest
        || request.license_digest != plan.license_digest
        || request.review_token != plan.review_token
    {
        return Err("the reviewed model installation plan is stale; review it again".to_string());
    }
    if !request.accept_license {
        return Err("explicit license acceptance is required before installation".to_string());
    }
    if plan.already_installed {
        return Err("this exact model revision is already installed".to_string());
    }
    if plan.has_sufficient_space == Some(false) {
        return Err("the model storage volume does not have enough free space".to_string());
    }

    let mut connection = database::open(paths)?;
    catalog::synchronize(&mut connection)?;
    let active_job = connection
        .query_row(
            "SELECT id FROM media_model_install_jobs WHERE model_id = ?1 AND status IN ('queued','downloading','verifying','activating','canceling') ORDER BY created_at DESC LIMIT 1",
            params![manifest.model_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect active model installations: {error}"))?;
    if let Some(active_job) = active_job {
        return Err(format!("model installation {active_job} is already active"));
    }

    let job_id = new_job_id()?;
    let created_at = database::now();
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model installation: {error}"))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO media_model_license_acceptances(model_id, revision, license_digest, accepted_at) VALUES (?1, ?2, ?3, ?4)",
            params![manifest.model_id, manifest.revision, manifest.license_digest, created_at],
        )
        .map_err(|error| format!("failed to record model license acceptance: {error}"))?;
    transaction
        .execute(
            "INSERT INTO media_model_install_jobs(id, model_id, revision, status, manifest_digest, license_digest, files_total, bytes_total, created_at, updated_at) VALUES (?1, ?2, ?3, 'queued', ?4, ?5, ?6, ?7, ?8, ?8)",
            params![job_id, manifest.model_id, manifest.revision, plan.manifest_digest, manifest.license_digest, manifest.files.len() as i64, plan.total_bytes as i64, created_at],
        )
        .map_err(|error| format!("failed to queue model installation: {error}"))?;
    for file in manifest.files {
        transaction
            .execute(
                "INSERT INTO media_model_install_files(job_id, path, sha256, byte_size, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![job_id, file.path, file.sha256, file.byte_size as i64, created_at],
            )
            .map_err(|error| format!("failed to queue model file: {error}"))?;
    }
    transaction
        .execute(
            "INSERT INTO media_model_installations(model_id, revision, status, manifest_digest, bytes_on_disk, updated_at) VALUES (?1, ?2, 'queued', ?3, 0, ?4) ON CONFLICT(model_id) DO UPDATE SET revision = excluded.revision, status = excluded.status, manifest_digest = excluded.manifest_digest, error = NULL, updated_at = excluded.updated_at",
            params![manifest.model_id, manifest.revision, plan.manifest_digest, created_at],
        )
        .map_err(|error| format!("failed to initialize model installation state: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model installation: {error}"))?;
    get_job(paths, &job_id)
}

fn decode_job(row: &rusqlite::Row<'_>) -> rusqlite::Result<MediaModelInstallJob> {
    let bytes_total = row.get::<_, i64>(7)?.max(0) as u64;
    let bytes_downloaded = row.get::<_, i64>(8)?.max(0) as u64;
    let error = row.get::<_, Option<String>>(10)?;
    let failure = error
        .as_ref()
        .map(|diagnostic| MediaError::from_internal("model_install", diagnostic));
    Ok(MediaModelInstallJob {
        id: row.get(0)?,
        model_id: row.get(1)?,
        revision: row.get(2)?,
        status: row.get(3)?,
        manifest_digest: row.get(4)?,
        files_total: row.get::<_, i64>(5)?.max(0) as u32,
        files_completed: row.get::<_, i64>(6)?.max(0) as u32,
        bytes_total,
        bytes_downloaded,
        progress: if bytes_total == 0 {
            0.0
        } else {
            bytes_downloaded as f64 / bytes_total as f64
        },
        current_file: row.get(9)?,
        error,
        failure,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        completed_at: row.get(13)?,
    })
}

pub(crate) fn get_job(
    paths: &MediaRuntimePaths,
    job_id: &str,
) -> MediaResult<MediaModelInstallJob> {
    database::open(paths)?
        .query_row(
            "SELECT id, model_id, revision, status, manifest_digest, files_total, files_completed, bytes_total, bytes_downloaded, current_file, error, created_at, updated_at, completed_at FROM media_model_install_jobs WHERE id = ?1",
            params![job_id],
            decode_job,
        )
        .optional()
        .map_err(|error| format!("failed to read model installation: {error}"))?
        .ok_or_else(|| "model installation was not found".to_string())
}

pub(crate) fn request_cancellation(
    paths: &MediaRuntimePaths,
    job_id: &str,
) -> MediaResult<MediaModelInstallJob> {
    let connection = database::open(paths)?;
    let changed = connection
        .execute(
            "UPDATE media_model_install_jobs SET cancel_requested = 1, status = CASE WHEN status IN ('queued','downloading','verifying') THEN 'canceling' ELSE status END, updated_at = ?2 WHERE id = ?1 AND status IN ('queued','downloading','verifying','canceling')",
            params![job_id, database::now()],
        )
        .map_err(|error| format!("failed to request model installation cancellation: {error}"))?;
    if changed == 0 {
        let job = get_job(paths, job_id)?;
        if matches!(job.status.as_str(), "installed" | "failed" | "canceled") {
            return Ok(job);
        }
        return Err("model installation can no longer be canceled safely".to_string());
    }
    get_job(paths, job_id)
}

pub(crate) fn plan_removal(
    paths: &MediaRuntimePaths,
    model_id: &str,
) -> MediaResult<MediaModelRemovalPlan> {
    let installation = managed_installation(paths, model_id)?;
    let connection = database::open(paths)?;
    let blocking_job_id = connection
        .query_row(
            "SELECT id FROM media_model_install_jobs WHERE model_id = ?1 AND status IN ('queued','downloading','verifying','activating','canceling') ORDER BY created_at DESC LIMIT 1",
            params![model_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("failed to inspect model installation jobs: {error}"))?;
    Ok(MediaModelRemovalPlan {
        schema_version: 1,
        model_id: installation.model_id.clone(),
        display_name: installation.display_name,
        revision: installation.revision.clone(),
        installed_bytes: installation.byte_size,
        target_label: format!("models/{}", installation.relative_path),
        confirmation_token: removal_confirmation_token(
            &installation.model_id,
            &installation.revision,
            &installation.manifest_digest,
            installation.byte_size,
        ),
        can_remove: blocking_job_id.is_none(),
        blocking_job_id,
        warnings: vec![
            "Saved flows remain intact but will return to model-not-installed preflight until this revision is installed again.".to_string(),
            "Removal is journaled and the active directory is moved atomically before background cleanup.".to_string(),
        ],
    })
}

fn finalize_removal_database(
    paths: &MediaRuntimePaths,
    removal_id: &str,
    model_id: &str,
    completed_at: &str,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model removal commit: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_installations SET status = 'not-installed', bytes_on_disk = 0, installed_at = NULL, verified_at = NULL, relative_path = NULL, error = NULL, updated_at = ?2 WHERE model_id = ?1",
            params![model_id, completed_at],
        )
        .map_err(|error| format!("failed to remove model readiness: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_removals SET status = 'cleanup-pending', updated_at = ?2, completed_at = ?2 WHERE id = ?1",
            params![removal_id, completed_at],
        )
        .map_err(|error| format!("failed to commit model removal journal: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model removal: {error}"))
}

fn cleanup_removal_trash(
    paths: &MediaRuntimePaths,
    removal_id: &str,
    trash_root: &Path,
) -> MediaResult<bool> {
    if trash_root.exists() {
        if let Err(error) = fs::remove_dir_all(trash_root) {
            database::open(paths)?
                .execute(
                    "UPDATE media_model_removals SET status = 'cleanup-pending', error = ?2, updated_at = ?3 WHERE id = ?1",
                    params![removal_id, format!("deferred model cleanup: {error}"), database::now()],
                )
                .map_err(|db_error| format!("failed to defer model cleanup: {db_error}"))?;
            return Ok(true);
        }
    }
    database::open(paths)?
        .execute(
            "UPDATE media_model_removals SET status = 'removed', error = NULL, updated_at = ?2 WHERE id = ?1",
            params![removal_id, database::now()],
        )
        .map_err(|error| format!("failed to finish model cleanup: {error}"))?;
    Ok(false)
}

pub(crate) fn remove(
    paths: &MediaRuntimePaths,
    request: &RemoveMediaModelRequest,
) -> MediaResult<MediaModelRemovalResult> {
    let plan = plan_removal(paths, request.model_id.trim())?;
    if request.confirmation_token != plan.confirmation_token {
        return Err("the reviewed model removal plan is stale; review it again".to_string());
    }
    if !request.confirm_removal {
        return Err("explicit confirmation is required before removing a model".to_string());
    }
    if !plan.can_remove {
        return Err("the model has an active installation job and cannot be removed".to_string());
    }

    let installation = managed_installation(paths, &plan.model_id)?;
    let removal_id = new_job_id()?.replacen("model-install", "model-removal", 1);
    let relative_path = installation.relative_path;
    let trash_relative_path = format!("trash/{removal_id}");
    let models_root = paths.models_root()?;
    let source = safe_relative_path(&models_root, &relative_path)?;
    let trash_root = safe_relative_path(&models_root, &trash_relative_path)?;
    let trash_repository = trash_root.join("repository");
    if !source.is_dir() {
        return Err(
            "the installed model directory is missing; removal was not started".to_string(),
        );
    }
    if plan.model_id == BIREFNET_MODEL_ID {
        super::subject_cutout::release_session()?;
    }
    fs::create_dir_all(&trash_root)
        .map_err(|error| format!("failed to prepare model removal journal: {error}"))?;

    let created_at = database::now();
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model removal: {error}"))?;
    transaction
        .execute(
            "INSERT INTO media_model_removals(id, model_id, revision, status, relative_path, trash_relative_path, byte_size, created_at, updated_at) VALUES (?1, ?2, ?3, 'prepared', ?4, ?5, ?6, ?7, ?7)",
            params![removal_id, plan.model_id, plan.revision, relative_path, trash_relative_path, plan.installed_bytes as i64, created_at],
        )
        .map_err(|error| format!("failed to journal model removal: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_installations SET status = 'removing', updated_at = ?2 WHERE model_id = ?1 AND status = 'installed'",
            params![plan.model_id, created_at],
        )
        .map_err(|error| format!("failed to reserve model removal: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model removal reservation: {error}"))?;

    fs::rename(&source, &trash_repository)
        .map_err(|error| format!("failed to atomically detach model revision: {error}"))?;
    let active_pointer = models_root
        .join("packages")
        .join(&installation.package_slug)
        .join("active.json");
    if active_pointer.exists() {
        fs::rename(&active_pointer, trash_root.join("active.json"))
            .map_err(|error| format!("failed to detach active model pointer: {error}"))?;
    }
    let removed_at = database::now();
    finalize_removal_database(paths, &removal_id, &plan.model_id, &removed_at)?;
    let cleanup_pending = cleanup_removal_trash(paths, &removal_id, &trash_root)?;
    Ok(MediaModelRemovalResult {
        model_id: plan.model_id,
        revision: plan.revision,
        removed_at,
        reclaimed_bytes: if cleanup_pending {
            0
        } else {
            plan.installed_bytes
        },
        cleanup_pending,
    })
}

pub(crate) fn recover_removals(paths: &MediaRuntimePaths) -> MediaResult<()> {
    let connection = database::open(paths)?;
    let removals = {
        let mut statement = connection
            .prepare("SELECT id, model_id, revision, status, relative_path, trash_relative_path FROM media_model_removals WHERE status IN ('prepared','cleanup-pending') ORDER BY created_at")
            .map_err(|error| format!("failed to prepare model removal recovery: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                ))
            })
            .map_err(|error| format!("failed to read model removal recovery: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode model removal recovery: {error}"))?;
        rows
    };
    drop(connection);
    let models_root = paths.models_root()?;
    for (removal_id, model_id, revision, status, relative_path, trash_relative_path) in removals {
        let package_slug = managed_package_slug(&model_id, &revision, &relative_path)?;
        let source = safe_relative_path(&models_root, &relative_path)?;
        let trash_root = safe_relative_path(&models_root, &trash_relative_path)?;
        let trash_repository = trash_root.join("repository");
        if status == "prepared" {
            if source.exists() && trash_repository.exists() {
                return Err(
                    "model removal recovery found both active and detached revisions".to_string(),
                );
            }
            if source.exists() {
                fs::create_dir_all(&trash_root).map_err(|error| {
                    format!("failed to recover model removal directory: {error}")
                })?;
                fs::rename(&source, &trash_repository)
                    .map_err(|error| format!("failed to recover model removal move: {error}"))?;
            }
            if !trash_repository.exists() {
                return Err(
                    "model removal recovery could not locate the active or detached revision"
                        .to_string(),
                );
            }
            let active_pointer = models_root
                .join("packages")
                .join(package_slug)
                .join("active.json");
            if active_pointer.exists() {
                fs::rename(&active_pointer, trash_root.join("active.json")).map_err(|error| {
                    format!("failed to recover active model pointer removal: {error}")
                })?;
            }
            finalize_removal_database(paths, &removal_id, &model_id, &database::now())?;
        }
        let _ = cleanup_removal_trash(paths, &removal_id, &trash_root)?;
    }
    Ok(())
}

pub(crate) fn recover_interrupted(paths: &MediaRuntimePaths) -> MediaResult<Vec<String>> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model installer recovery: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_install_jobs SET status = CASE WHEN cancel_requested = 1 THEN 'canceling' ELSE 'queued' END, current_file = NULL, updated_at = ?1 WHERE status IN ('downloading','verifying','activating','canceling')",
            params![database::now()],
        )
        .map_err(|error| format!("failed to recover model installations: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_install_files SET status = 'pending', updated_at = ?1 WHERE status = 'downloading'",
            params![database::now()],
        )
        .map_err(|error| format!("failed to recover model file downloads: {error}"))?;
    let job_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM media_model_install_jobs WHERE status IN ('queued','canceling') ORDER BY created_at")
            .map_err(|error| format!("failed to prepare recovered model installations: {error}"))?;
        let job_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to read recovered model installations: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode recovered model installations: {error}"))?;
        job_ids
    };
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model installer recovery: {error}"))?;
    Ok(job_ids)
}

pub(crate) fn list_queued_job_ids(paths: &MediaRuntimePaths) -> MediaResult<Vec<String>> {
    let connection = database::open(paths)?;
    let mut statement = connection
        .prepare("SELECT id FROM media_model_install_jobs WHERE status IN ('queued','canceling') ORDER BY created_at")
        .map_err(|error| format!("failed to prepare queued model installations: {error}"))?;
    let job_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to read queued model installations: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode queued model installations: {error}"))?;
    Ok(job_ids)
}

fn cancellation_requested(paths: &MediaRuntimePaths, job_id: &str) -> MediaResult<bool> {
    database::open(paths)?
        .query_row(
            "SELECT cancel_requested FROM media_model_install_jobs WHERE id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect model cancellation state: {error}"))
}

fn set_job_stage(
    paths: &MediaRuntimePaths,
    job_id: &str,
    status: &str,
    current_file: Option<&str>,
) -> MediaResult<()> {
    let job = get_job(paths, job_id)?;
    let connection = database::open(paths)?;
    connection
        .execute(
            "UPDATE media_model_install_jobs SET status = ?2, current_file = ?3, updated_at = ?4 WHERE id = ?1",
            params![job_id, status, current_file, database::now()],
        )
        .map_err(|error| format!("failed to update model installation stage: {error}"))?;
    connection
        .execute(
            "UPDATE media_model_installations SET status = ?2, updated_at = ?3 WHERE model_id = ?1",
            params![job.model_id, status, database::now()],
        )
        .map_err(|error| format!("failed to update model readiness: {error}"))?;
    Ok(())
}

fn update_file_progress(
    paths: &MediaRuntimePaths,
    job_id: &str,
    file: ManifestFile,
    bytes: u64,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model progress update: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_install_files SET status = 'downloading', bytes_downloaded = ?3, updated_at = ?4 WHERE job_id = ?1 AND path = ?2",
            params![job_id, file.path, bytes as i64, database::now()],
        )
        .map_err(|error| format!("failed to update model file progress: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_install_jobs SET bytes_downloaded = (SELECT COALESCE(SUM(bytes_downloaded), 0) FROM media_model_install_files WHERE job_id = ?1), updated_at = ?2 WHERE id = ?1",
            params![job_id, database::now()],
        )
        .map_err(|error| format!("failed to update model download progress: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model download progress: {error}"))
}

fn mark_file_verified(
    paths: &MediaRuntimePaths,
    job_id: &str,
    file: ManifestFile,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model verification update: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_install_files SET status = 'verified', bytes_downloaded = byte_size, error = NULL, updated_at = ?3 WHERE job_id = ?1 AND path = ?2",
            params![job_id, file.path, database::now()],
        )
        .map_err(|error| format!("failed to record verified model file: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_install_jobs SET files_completed = (SELECT COUNT(*) FROM media_model_install_files WHERE job_id = ?1 AND status = 'verified'), bytes_downloaded = (SELECT COALESCE(SUM(bytes_downloaded), 0) FROM media_model_install_files WHERE job_id = ?1), updated_at = ?2 WHERE id = ?1",
            params![job_id, database::now()],
        )
        .map_err(|error| format!("failed to update verified model progress: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model verification: {error}"))
}

fn part_path(destination: &Path) -> PathBuf {
    let mut name = destination.as_os_str().to_os_string();
    name.push(".part");
    PathBuf::from(name)
}

fn hash_existing(path: &Path) -> MediaResult<(u64, Sha256)> {
    let mut file =
        File::open(path).map_err(|error| format!("failed to open partial model file: {error}"))?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = vec![0_u8; 4 * 1_024 * 1_024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to read partial model file: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total = total.saturating_add(read as u64);
    }
    Ok((total, hasher))
}

fn collect_inventory(
    root: &Path,
    directory: &Path,
    files: &mut HashSet<String>,
) -> MediaResult<()> {
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("failed to inspect model package: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to inspect model package entry: {error}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("failed to inspect model package metadata: {error}"))?;
        if metadata.file_type().is_symlink() {
            return Err(
                "model package contains a symbolic link and cannot be activated".to_string(),
            );
        }
        if metadata.is_dir() {
            collect_inventory(root, &path, files)?;
            continue;
        }
        if !metadata.is_file() {
            return Err("model package contains an unsupported filesystem entry".to_string());
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "model package inventory escaped its root".to_string())?;
        let normalized = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        files.insert(normalized);
    }
    Ok(())
}

fn validate_package(
    root: &Path,
    verify_hashes: bool,
    manifest: &BuiltinModelManifest,
) -> MediaResult<()> {
    if !root.is_dir() {
        return Err("verified model staging directory is missing".to_string());
    }
    let mut actual = HashSet::new();
    collect_inventory(root, root, &mut actual)?;
    let expected = manifest
        .files
        .iter()
        .map(|file| file.path)
        .collect::<HashSet<_>>();
    if actual.len() != expected.len() || actual.iter().any(|path| !expected.contains(path.as_str()))
    {
        return Err("model package inventory differs from the reviewed allowlist".to_string());
    }
    for file in manifest.files {
        let path = safe_relative_path(root, file.path)?;
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("failed to inspect verified file {}: {error}", file.path))?;
        if !metadata.is_file() || metadata.len() != file.byte_size {
            return Err(format!(
                "verified file {} has an unexpected size or type",
                file.path
            ));
        }
        if verify_hashes {
            let (_, hasher) = hash_existing(&path)?;
            if format!("{:x}", hasher.finalize()) != file.sha256 {
                return Err(format!("recovery verification failed for {}", file.path));
            }
        }
    }
    Ok(())
}

async fn download_file(
    client: &Client,
    paths: &MediaRuntimePaths,
    job_id: &str,
    stage_root: &Path,
    manifest: &BuiltinModelManifest,
    file: ManifestFile,
) -> MediaResult<()> {
    let destination = safe_relative_path(stage_root, file.path)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create model staging directory: {error}"))?;
    }
    let partial = part_path(&destination);
    if partial.exists()
        && partial
            .metadata()
            .map(|metadata| metadata.len())
            .unwrap_or(u64::MAX)
            > file.byte_size
    {
        fs::remove_file(&partial)
            .map_err(|error| format!("failed to discard oversized partial model file: {error}"))?;
    }

    let (mut offset, mut hasher) = if partial.exists() {
        hash_existing(&partial)?
    } else {
        (0, Sha256::new())
    };
    update_file_progress(paths, job_id, file, offset)?;
    if cancellation_requested(paths, job_id)? {
        return Err(CANCELED_SENTINEL.to_string());
    }

    if offset < file.byte_size {
        let url = if manifest.model_id == BIREFNET_MODEL_ID && file.path == "LICENSE" {
            BIREFNET_LICENSE_URL.to_string()
        } else if manifest.model_id == BIREFNET_MODEL_ID {
            format!("{}/{}", manifest.download_root, file.path)
        } else {
            format!(
                "{}/{}/{}",
                manifest.download_root, manifest.revision, file.path
            )
        };
        let mut request = client.get(&url);
        if offset > 0 {
            request = request.header(header::RANGE, format!("bytes={offset}-"));
        }
        let mut response = request
            .send()
            .await
            .map_err(|error| format!("failed to download {}: {error}", file.path))?;

        if offset > 0 && response.status() != StatusCode::PARTIAL_CONTENT {
            drop(response);
            offset = 0;
            hasher = Sha256::new();
            response =
                client.get(&url).send().await.map_err(|error| {
                    format!("failed to restart {} download: {error}", file.path)
                })?;
        } else if offset > 0 {
            let expected_prefix = format!("bytes {offset}-");
            let range_matches = response
                .headers()
                .get(header::CONTENT_RANGE)
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.starts_with(&expected_prefix));
            if !range_matches {
                return Err(format!(
                    "download server returned an invalid resume range for {}",
                    file.path
                ));
            }
        }
        if !response.status().is_success() {
            return Err(format!(
                "download server returned {} for {}",
                response.status(),
                file.path
            ));
        }

        let mut output = OpenOptions::new()
            .create(true)
            .write(true)
            .append(offset > 0)
            .truncate(offset == 0)
            .open(&partial)
            .map_err(|error| format!("failed to open model staging file: {error}"))?;
        let mut last_persisted = offset;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("failed while downloading {}: {error}", file.path))?
        {
            output
                .write_all(&chunk)
                .map_err(|error| format!("failed to write {}: {error}", file.path))?;
            hasher.update(&chunk);
            offset = offset.saturating_add(chunk.len() as u64);
            if offset > file.byte_size {
                return Err(format!(
                    "downloaded {} exceeds its reviewed size",
                    file.path
                ));
            }
            if offset.saturating_sub(last_persisted) >= PROGRESS_WRITE_BYTES {
                update_file_progress(paths, job_id, file, offset)?;
                last_persisted = offset;
                if cancellation_requested(paths, job_id)? {
                    return Err(CANCELED_SENTINEL.to_string());
                }
            }
        }
        output
            .sync_all()
            .map_err(|error| format!("failed to flush {}: {error}", file.path))?;
    }

    update_file_progress(paths, job_id, file, offset)?;
    set_job_stage(paths, job_id, "verifying", Some(file.path))?;
    if offset != file.byte_size {
        return Err(format!(
            "{} is incomplete: expected {} bytes, received {offset}",
            file.path, file.byte_size
        ));
    }
    let digest = format!("{:x}", hasher.finalize());
    if digest != file.sha256 {
        return Err(format!("SHA-256 verification failed for {}", file.path));
    }
    fs::rename(&partial, &destination).map_err(|error| {
        format!(
            "failed to publish verified staging file {}: {error}",
            file.path
        )
    })?;
    mark_file_verified(paths, job_id, file)
}

fn mark_canceled(paths: &MediaRuntimePaths, job_id: &str) -> MediaResult<()> {
    let job = get_job(paths, job_id)?;
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model cancellation: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_install_jobs SET status = 'canceled', current_file = NULL, completed_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![job_id, database::now()],
        )
        .map_err(|error| format!("failed to cancel model installation: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_installations SET status = 'not-installed', error = NULL, updated_at = ?2 WHERE model_id = ?1",
            params![job.model_id, database::now()],
        )
        .map_err(|error| format!("failed to restore model readiness after cancellation: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model cancellation: {error}"))
}

fn is_integrity_failure(error: &str) -> bool {
    [
        "SHA-256",
        "inventory",
        "unexpected size",
        "symbolic link",
        "unsupported filesystem",
        "exceeds its reviewed size",
        "invalid resume range",
        "recovery verification",
    ]
    .iter()
    .any(|marker| error.contains(marker))
}

fn quarantine_staging(paths: &MediaRuntimePaths, job_id: &str, error: &str) -> MediaResult<bool> {
    if !is_integrity_failure(error) {
        return Ok(false);
    }
    let job = get_job(paths, job_id)?;
    let models_root = paths.models_root()?;
    let staging_root = models_root.join("staging").join(job_id);
    if !staging_root.exists() {
        return Ok(false);
    }
    let quarantine_root = models_root.join("quarantine").join(job_id);
    if quarantine_root.exists() {
        return Err("model quarantine destination already exists".to_string());
    }
    fs::create_dir_all(
        quarantine_root
            .parent()
            .ok_or_else(|| "model quarantine path has no parent".to_string())?,
    )
    .map_err(|fs_error| format!("failed to prepare model quarantine: {fs_error}"))?;
    fs::rename(&staging_root, &quarantine_root)
        .map_err(|fs_error| format!("failed to quarantine unverified model bytes: {fs_error}"))?;
    let report = serde_json::json!({
        "schemaVersion": 1,
        "jobId": job_id,
        "modelId": job.model_id,
        "revision": job.revision,
        "reason": error,
        "quarantinedAt": database::now(),
    });
    crate::atomic_file::write_file_atomic(
        &quarantine_root.join("quarantine.json"),
        &serde_json::to_vec_pretty(&report).map_err(|json_error| {
            format!("failed to encode model quarantine report: {json_error}")
        })?,
        crate::atomic_file::AtomicWriteOptions::default(),
    )
    .map_err(|fs_error| format!("failed to write model quarantine report: {fs_error}"))?;
    Ok(true)
}

fn mark_failed(
    paths: &MediaRuntimePaths,
    job_id: &str,
    error: &str,
    quarantined: bool,
) -> MediaResult<()> {
    let job = get_job(paths, job_id)?;
    let message = error.chars().take(2_000).collect::<String>();
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|db_error| format!("failed to begin model failure update: {db_error}"))?;
    transaction
        .execute(
            "UPDATE media_model_install_jobs SET status = 'failed', error = ?2, current_file = NULL, completed_at = ?3, updated_at = ?3 WHERE id = ?1",
            params![job_id, message, database::now()],
        )
        .map_err(|db_error| format!("failed to record model installation failure: {db_error}"))?;
    transaction
        .execute(
            "UPDATE media_model_installations SET status = ?2, error = ?3, updated_at = ?4 WHERE model_id = ?1",
            params![job.model_id, if quarantined { "quarantined" } else { "failed" }, message, database::now()],
        )
        .map_err(|db_error| format!("failed to record model readiness failure: {db_error}"))?;
    transaction
        .commit()
        .map_err(|db_error| format!("failed to commit model installation failure: {db_error}"))
}

fn activate(paths: &MediaRuntimePaths, job_id: &str, stage_root: &Path) -> MediaResult<()> {
    let job = get_job(paths, job_id)?;
    let manifest = builtin_manifest(&job.model_id)?;
    if job.revision != manifest.revision || job.manifest_digest != manifest_digest(manifest) {
        return Err(
            "the queued model manifest no longer matches the reviewed built-in manifest"
                .to_string(),
        );
    }
    set_job_stage(paths, job_id, "activating", None)?;
    if cancellation_requested(paths, job_id)? {
        return Err(CANCELED_SENTINEL.to_string());
    }
    let models_root = paths.models_root()?;
    let package_root = models_root.join("packages").join(manifest.slug);
    let revision_root = package_root.join("revisions").join(manifest.revision);
    if revision_root.exists() {
        if stage_root.exists() {
            return Err(
                "both staged and activated model packages exist; manual review is required"
                    .to_string(),
            );
        }
        // A process exit can happen after the atomic directory rename but before
        // SQLite is committed. Re-hash the activated tree before completing that
        // interrupted commit; never trust the directory name alone.
        validate_package(&revision_root, true, manifest)?;
    } else {
        validate_package(stage_root, false, manifest)?;
        fs::create_dir_all(
            revision_root
                .parent()
                .ok_or_else(|| "model revision path has no parent".to_string())?,
        )
        .map_err(|error| format!("failed to prepare model revision directory: {error}"))?;
        fs::rename(stage_root, &revision_root)
            .map_err(|error| format!("failed to atomically activate model revision: {error}"))?;
    }
    let manifest_digest = manifest_digest(manifest);
    let activated_at = database::now();
    let active_pointer = serde_json::json!({
        "schemaVersion": 1,
        "modelId": manifest.model_id,
        "revision": manifest.revision,
        "manifestDigest": manifest_digest,
        "relativePath": format!("packages/{}/revisions/{}", manifest.slug, manifest.revision),
        "activatedAt": activated_at,
    });
    fs::create_dir_all(&package_root)
        .map_err(|error| format!("failed to prepare model package directory: {error}"))?;
    crate::atomic_file::write_file_atomic(
        &package_root.join("active.json"),
        &serde_json::to_vec_pretty(&active_pointer)
            .map_err(|error| format!("failed to encode active model pointer: {error}"))?,
        crate::atomic_file::AtomicWriteOptions::default(),
    )
    .map_err(|error| format!("failed to publish active model pointer: {error}"))?;

    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model activation update: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_install_jobs SET status = 'installed', files_completed = files_total, bytes_downloaded = bytes_total, current_file = NULL, error = NULL, completed_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![job_id, activated_at],
        )
        .map_err(|error| format!("failed to complete model installation job: {error}"))?;
    transaction
        .execute(
            "UPDATE media_model_installations SET status = 'installed', bytes_on_disk = ?2, installed_at = ?3, verified_at = ?3, relative_path = ?4, error = NULL, updated_at = ?3 WHERE model_id = ?1",
            params![manifest.model_id, total_bytes(manifest) as i64, activated_at, format!("packages/{}/revisions/{}", manifest.slug, manifest.revision)],
        )
        .map_err(|error| format!("failed to publish installed model readiness: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model activation: {error}"))?;
    Ok(())
}

async fn execute_inner(paths: &MediaRuntimePaths, job_id: &str) -> MediaResult<()> {
    if cancellation_requested(paths, job_id)? {
        return Err(CANCELED_SENTINEL.to_string());
    }
    let job = get_job(paths, job_id)?;
    let manifest = builtin_manifest(&job.model_id)?;
    if job.revision != manifest.revision || job.manifest_digest != manifest_digest(manifest) {
        return Err(
            "the queued model manifest no longer matches the reviewed built-in manifest"
                .to_string(),
        );
    }
    let client = Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(6 * 60 * 60))
        .user_agent(format!(
            "machdoch-media-installer/{}",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .map_err(|error| format!("failed to initialize model download client: {error}"))?;
    let stage_root = paths
        .models_root()?
        .join("staging")
        .join(job_id)
        .join("repository");
    fs::create_dir_all(&stage_root)
        .map_err(|error| format!("failed to create model staging root: {error}"))?;

    for file in manifest.files {
        let file_status = database::open(paths)?
            .query_row(
                "SELECT status FROM media_model_install_files WHERE job_id = ?1 AND path = ?2",
                params![job_id, file.path],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| format!("failed to inspect model file state: {error}"))?;
        if file_status == "verified" {
            continue;
        }
        set_job_stage(paths, job_id, "downloading", Some(file.path))?;
        download_file(&client, paths, job_id, &stage_root, manifest, *file).await?;
    }
    activate(paths, job_id, &stage_root)
}

pub(crate) async fn execute(paths: &MediaRuntimePaths, job_id: &str) -> MediaResult<()> {
    match execute_inner(paths, job_id).await {
        Ok(()) => Ok(()),
        Err(error) if error == CANCELED_SENTINEL => {
            mark_canceled(paths, job_id)?;
            Ok(())
        }
        Err(error) => {
            let quarantined = quarantine_staging(paths, job_id, &error)?;
            mark_failed(paths, job_id, &error, quarantined)?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths(label: &str) -> (PathBuf, MediaRuntimePaths) {
        let root = std::env::temp_dir().join(format!(
            "machdoch-media-model-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let paths = MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs").join("sha256"),
        };
        (root, paths)
    }

    #[test]
    fn pinned_diffusers_manifest_has_expected_reviewed_size() {
        assert_eq!(FLUX_FILES.len(), 19);
        assert_eq!(total_bytes(&FLUX_MANIFEST), 15_980_141_329);
        assert_eq!(
            manifest_digest(&FLUX_MANIFEST),
            "8347f47cece38f870d09ab6cc5f0bec5340d70ee6549bc44e7d767f78e41175b"
        );
        assert_eq!(FLUX_FILES[0].sha256, FLUX_LICENSE_DIGEST);
        assert!(FLUX_FILES.iter().all(|file| file.sha256.len() == 64));
    }

    #[test]
    fn pinned_birefnet_manifest_uses_only_the_official_release_and_license() {
        assert_eq!(BIREFNET_FILES.len(), 2);
        assert_eq!(total_bytes(&BIREFNET_MANIFEST), 972_668_808);
        assert_eq!(BIREFNET_FILES[0].sha256, BIREFNET_LICENSE_DIGEST);
        assert!(BIREFNET_FILES.iter().all(|file| file.sha256.len() == 64));
        assert_eq!(
            manifest_digest(&BIREFNET_MANIFEST),
            "dd8c3ef7eb3b12e12c899c6f5c480d487aa78cf186c203ba75f872c6edd7eda8"
        );
    }

    #[test]
    fn manifest_paths_cannot_escape_staging_root() {
        let root = Path::new("model-stage");
        assert!(safe_relative_path(root, "tokenizer/tokenizer.json").is_ok());
        assert!(safe_relative_path(root, "../secrets.txt").is_err());
        assert!(safe_relative_path(root, "tokenizer\\..\\secrets.txt").is_err());
        assert!(safe_relative_path(root, "/absolute/file").is_err());
    }

    #[test]
    fn review_token_changes_when_reviewed_inputs_change() {
        let digest = manifest_digest(&FLUX_MANIFEST);
        let required = total_bytes(&FLUX_MANIFEST)
            .saturating_mul(112)
            .div_ceil(100);
        assert_eq!(
            review_token(&FLUX_MANIFEST, &digest, required),
            review_token(&FLUX_MANIFEST, &digest, required)
        );
        assert_ne!(
            review_token(&FLUX_MANIFEST, &digest, required),
            review_token(&FLUX_MANIFEST, &digest, required + 1)
        );
        assert_ne!(
            review_token(&FLUX_MANIFEST, &digest, required),
            review_token(&FLUX_MANIFEST, "tampered", required)
        );
    }

    #[test]
    fn reviewed_removal_atomically_detaches_revision_and_updates_catalog_state() {
        let (root, paths) = test_paths("remove");
        database::initialize(&paths).expect("database should initialize");
        let relative_path = format!(
            "packages/{}/revisions/{}",
            FLUX_MANIFEST.slug, FLUX_MANIFEST.revision
        );
        let revision_root = paths
            .models_root()
            .expect("models root")
            .join(&relative_path);
        fs::create_dir_all(&revision_root).expect("revision root should exist");
        fs::write(revision_root.join("fixture.bin"), b"fixture")
            .expect("fixture should be written");
        let package_root = revision_root
            .parent()
            .and_then(Path::parent)
            .expect("package root");
        fs::write(package_root.join("active.json"), b"{}")
            .expect("active pointer should be written");
        database::open(&paths)
            .expect("database should open")
            .execute(
                "INSERT INTO media_model_installations(model_id, revision, status, manifest_digest, bytes_on_disk, installed_at, verified_at, updated_at, relative_path) VALUES (?1, ?2, 'installed', ?3, 7, ?4, ?4, ?4, ?5)",
                params![FLUX_MANIFEST.model_id, FLUX_MANIFEST.revision, manifest_digest(&FLUX_MANIFEST), database::now(), relative_path],
            )
            .expect("installation should be recorded");

        let plan = plan_removal(&paths, FLUX_MANIFEST.model_id).expect("removal should be planned");
        let result = remove(
            &paths,
            &RemoveMediaModelRequest {
                model_id: FLUX_MANIFEST.model_id.to_string(),
                confirmation_token: plan.confirmation_token,
                confirm_removal: true,
            },
        )
        .expect("removal should complete");

        assert_eq!(result.reclaimed_bytes, 7);
        assert!(!revision_root.exists());
        assert!(!package_root.join("active.json").exists());
        let status = database::open(&paths)
            .expect("database should open")
            .query_row(
                "SELECT status FROM media_model_installations WHERE model_id = ?1",
                params![FLUX_MANIFEST.model_id],
                |row| row.get::<_, String>(0),
            )
            .expect("installation state should remain queryable");
        assert_eq!(status, "not-installed");
        let _ = fs::remove_dir_all(root);
    }
}
