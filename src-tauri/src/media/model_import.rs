use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use rusqlite::params;
use serde_json::{Map, Value};
use sha2::{Digest as _, Sha256};

use super::{
    catalog, database, hardware, model_addon, ImportMediaLocalModelRequest,
    MediaLocalModelImportInspection, MediaLocalModelImportResult, MediaResult, MediaRuntimePaths,
};

pub(crate) const USER_MODEL_ID_PREFIX: &str = "local:user:";

const IMPORT_CATALOG_REVISION: &str = "user-import-v1";
const MAX_HEADER_BYTES: u64 = 64 * 1_024 * 1_024;
const COPY_BUFFER_BYTES: usize = 4 * 1_024 * 1_024;
pub(super) const SUPPORTED_ARCHITECTURES: &[&str] = &[
    "stable-diffusion-1",
    "stable-diffusion-2",
    "stable-diffusion-xl",
    "stable-diffusion-3",
    "flux-1",
    "flux-2",
];

pub(super) struct ParsedSafetensorsHeader {
    pub(super) canonical_path: PathBuf,
    pub(super) source_file_name: String,
    pub(super) byte_size: u64,
    pub(super) modified_marker: String,
    pub(super) tensor_count: u32,
    pub(super) tensor_keys: Vec<String>,
    pub(super) tensor_shapes: Map<String, Value>,
    pub(super) metadata: Map<String, Value>,
    pub(super) header_digest: String,
}

struct ArchitectureProfile {
    family: &'static str,
    min_vram_gb: f64,
    speed_score: u32,
    quality_score: u32,
}

fn architecture_profile(architecture: &str) -> Option<ArchitectureProfile> {
    match architecture {
        "stable-diffusion-1" => Some(ArchitectureProfile {
            family: "Stable Diffusion 1.x",
            min_vram_gb: 4.0,
            speed_score: 84,
            quality_score: 72,
        }),
        "stable-diffusion-2" => Some(ArchitectureProfile {
            family: "Stable Diffusion 2.x",
            min_vram_gb: 5.0,
            speed_score: 80,
            quality_score: 75,
        }),
        "stable-diffusion-xl" => Some(ArchitectureProfile {
            family: "Stable Diffusion XL",
            min_vram_gb: 8.0,
            speed_score: 70,
            quality_score: 84,
        }),
        "stable-diffusion-3" => Some(ArchitectureProfile {
            family: "Stable Diffusion 3",
            min_vram_gb: 10.0,
            speed_score: 64,
            quality_score: 87,
        }),
        "flux-1" => Some(ArchitectureProfile {
            family: "FLUX.1",
            min_vram_gb: 12.0,
            speed_score: 55,
            quality_score: 91,
        }),
        "flux-2" => Some(ArchitectureProfile {
            family: "FLUX.2",
            min_vram_gb: 13.0,
            speed_score: 58,
            quality_score: 92,
        }),
        _ => None,
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parse_u64(value: &Value) -> Option<u64> {
    value.as_u64()
}

pub(super) fn parse_header(source_path: &str) -> MediaResult<ParsedSafetensorsHeader> {
    let requested_path = Path::new(source_path.trim());
    if source_path.trim().is_empty() {
        return Err("sourcePath is required".to_string());
    }
    if requested_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("safetensors"))
        .unwrap_or(true)
    {
        return Err(
            "only .safetensors checkpoints can be imported; pickle-based .ckpt, .pt, and .bin files are rejected"
                .to_string(),
        );
    }
    let symlink_metadata = fs::symlink_metadata(requested_path)
        .map_err(|error| format!("failed to inspect the selected model file: {error}"))?;
    if symlink_metadata.file_type().is_symlink() || !symlink_metadata.is_file() {
        return Err("the selected model must be a regular, non-symbolic-link file".to_string());
    }
    let canonical_path = fs::canonicalize(requested_path)
        .map_err(|error| format!("failed to resolve the selected model file: {error}"))?;
    let metadata = fs::metadata(&canonical_path)
        .map_err(|error| format!("failed to read model file metadata: {error}"))?;
    let byte_size = metadata.len();
    if byte_size <= 10 {
        return Err("the selected safetensors file is too small to be valid".to_string());
    }
    let modified_marker = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let mut file = File::open(&canonical_path)
        .map_err(|error| format!("failed to open the selected model file: {error}"))?;
    let mut length_bytes = [0_u8; 8];
    file.read_exact(&mut length_bytes)
        .map_err(|error| format!("failed to read the safetensors header length: {error}"))?;
    let header_length = u64::from_le_bytes(length_bytes);
    if header_length == 0
        || header_length > MAX_HEADER_BYTES
        || header_length > byte_size.saturating_sub(8)
    {
        return Err("the safetensors header length is invalid or exceeds 64 MiB".to_string());
    }
    let mut header_bytes = vec![0_u8; header_length as usize];
    file.read_exact(&mut header_bytes)
        .map_err(|error| format!("failed to read the safetensors header: {error}"))?;
    let header = serde_json::from_slice::<Value>(&header_bytes)
        .map_err(|error| format!("the safetensors header is not valid JSON: {error}"))?;
    let entries = header
        .as_object()
        .ok_or_else(|| "the safetensors header must be a JSON object".to_string())?;
    let data_byte_size = byte_size.saturating_sub(8 + header_length);
    let mut tensor_keys = Vec::new();
    let mut tensor_shapes = Map::new();
    let mut safetensors_metadata = Map::new();
    let mut maximum_end_offset = 0_u64;

    for (key, value) in entries {
        if key == "__metadata__" {
            let values = value
                .as_object()
                .ok_or_else(|| "safetensors __metadata__ must be an object".to_string())?;
            for (metadata_key, metadata_value) in values {
                if !metadata_value.is_string() {
                    return Err(format!(
                        "safetensors metadata {metadata_key} must contain a string value"
                    ));
                }
                safetensors_metadata.insert(metadata_key.clone(), metadata_value.clone());
            }
            continue;
        }
        if key.is_empty() {
            return Err("the safetensors header contains an empty tensor name".to_string());
        }
        let descriptor = value
            .as_object()
            .ok_or_else(|| format!("tensor {key} has an invalid descriptor"))?;
        if descriptor
            .get("dtype")
            .and_then(Value::as_str)
            .map(str::is_empty)
            .unwrap_or(true)
        {
            return Err(format!("tensor {key} has no valid dtype"));
        }
        let shape = descriptor
            .get("shape")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("tensor {key} has no valid shape"))?;
        if shape.iter().any(|dimension| dimension.as_u64().is_none()) {
            return Err(format!("tensor {key} has an invalid shape dimension"));
        }
        let offsets = descriptor
            .get("data_offsets")
            .and_then(Value::as_array)
            .filter(|values| values.len() == 2)
            .ok_or_else(|| format!("tensor {key} has invalid data offsets"))?;
        let start = parse_u64(&offsets[0])
            .ok_or_else(|| format!("tensor {key} has an invalid start offset"))?;
        let end = parse_u64(&offsets[1])
            .ok_or_else(|| format!("tensor {key} has an invalid end offset"))?;
        if start > end || end > data_byte_size {
            return Err(format!(
                "tensor {key} points outside the safetensors data section"
            ));
        }
        maximum_end_offset = maximum_end_offset.max(end);
        tensor_keys.push(key.clone());
        tensor_shapes.insert(key.clone(), Value::Array(shape.clone()));
    }
    if tensor_keys.is_empty() {
        return Err("the safetensors file does not contain any tensors".to_string());
    }
    if maximum_end_offset != data_byte_size {
        return Err(
            "the safetensors tensor inventory does not account for the complete data section"
                .to_string(),
        );
    }
    let tensor_count = u32::try_from(tensor_keys.len())
        .map_err(|_| "the safetensors file contains too many tensor entries".to_string())?;
    let source_file_name = canonical_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "the selected model file name is not valid UTF-8".to_string())?
        .to_string();

    Ok(ParsedSafetensorsHeader {
        canonical_path,
        source_file_name,
        byte_size,
        modified_marker,
        tensor_count,
        tensor_keys,
        tensor_shapes,
        metadata: safetensors_metadata,
        header_digest: sha256_hex(&header_bytes),
    })
}

pub(super) fn metadata_text(header: &ParsedSafetensorsHeader) -> String {
    header
        .metadata
        .values()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn has_tensor_prefix(header: &ParsedSafetensorsHeader, prefix: &str) -> bool {
    header.tensor_keys.iter().any(|key| key.starts_with(prefix))
}

fn cross_attention_width(header: &ParsedSafetensorsHeader) -> Option<u64> {
    const KEYS: &[&str] = &[
        "model.diffusion_model.input_blocks.1.1.transformer_blocks.0.attn2.to_k.weight",
        "model.diffusion_model.input_blocks.2.1.transformer_blocks.0.attn2.to_k.weight",
    ];
    KEYS.iter().find_map(|key| {
        header
            .tensor_shapes
            .get(*key)
            .and_then(Value::as_array)
            .and_then(|shape| shape.get(1))
            .and_then(Value::as_u64)
    })
}

pub(super) fn detect_architecture(
    header: &ParsedSafetensorsHeader,
) -> (Option<String>, &'static str) {
    let metadata = metadata_text(header);
    let explicit = [
        ("flux-2", ["flux.2", "flux_2", "flux 2"].as_slice()),
        ("flux-1", ["flux.1", "flux_1", "flux 1"].as_slice()),
        (
            "stable-diffusion-xl",
            ["stable-diffusion-xl", "stable diffusion xl", "sdxl"].as_slice(),
        ),
        (
            "stable-diffusion-3",
            ["stable-diffusion-v3", "stable diffusion 3", "sd3"].as_slice(),
        ),
        (
            "stable-diffusion-2",
            ["stable-diffusion-v2", "stable diffusion 2", "sd_v2"].as_slice(),
        ),
        (
            "stable-diffusion-1",
            ["stable-diffusion-v1", "stable diffusion 1", "sd_v1"].as_slice(),
        ),
    ];
    for (architecture, markers) in explicit {
        if markers.iter().any(|marker| metadata.contains(marker)) {
            return (Some(architecture.to_string()), "high");
        }
    }
    if has_tensor_prefix(header, "model.diffusion_model.double_blocks.")
        || has_tensor_prefix(header, "double_blocks.")
        || has_tensor_prefix(header, "transformer.single_transformer_blocks.")
    {
        return (Some("flux-1".to_string()), "medium");
    }
    if has_tensor_prefix(header, "model.diffusion_model.joint_blocks.")
        || has_tensor_prefix(header, "transformer.transformer_blocks.")
    {
        return (Some("stable-diffusion-3".to_string()), "medium");
    }
    if has_tensor_prefix(header, "conditioner.embedders.1.") {
        return (Some("stable-diffusion-xl".to_string()), "medium");
    }
    if has_tensor_prefix(header, "model.diffusion_model.input_blocks.") {
        return match cross_attention_width(header) {
            Some(1_024) => (Some("stable-diffusion-2".to_string()), "medium"),
            Some(768) => (Some("stable-diffusion-1".to_string()), "medium"),
            _ => (Some("stable-diffusion-1".to_string()), "medium"),
        };
    }
    (None, "unknown")
}

fn likely_adapter(header: &ParsedSafetensorsHeader) -> bool {
    let metadata = metadata_text(header);
    metadata.contains("ss_network_module")
        || metadata.contains("lycoris")
        || header
            .tensor_keys
            .iter()
            .take(128)
            .filter(|key| {
                let key = key.to_lowercase();
                key.contains("lora_") || key.contains(".lora_") || key.contains("lycoris")
            })
            .count()
            >= 2
}

pub(super) fn suggested_display_name(header: &ParsedSafetensorsHeader) -> String {
    for key in [
        "modelspec.title",
        "title",
        "ss_output_name",
        "ss_sd_model_name",
    ] {
        if let Some(value) = header.metadata.get(key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() && value.chars().count() <= 120 {
                return value.to_string();
            }
        }
    }
    header
        .canonical_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Imported diffusion model")
        .replace(['_', '-'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(super) fn metadata_summary(header: &ParsedSafetensorsHeader) -> Vec<String> {
    [
        "modelspec.architecture",
        "modelspec.title",
        "ss_base_model_version",
        "ss_sd_model_name",
        "base_model",
    ]
    .iter()
    .filter_map(|key| {
        let value = header.metadata.get(*key)?.as_str()?.trim();
        if value.is_empty() {
            return None;
        }
        let bounded = value.chars().take(160).collect::<String>();
        Some(format!("{key}: {bounded}"))
    })
    .collect()
}

fn inspection_review_token(header: &ParsedSafetensorsHeader) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-local-model-import-review-v1\0");
    for value in [
        header.canonical_path.to_string_lossy().as_ref(),
        &header.byte_size.to_string(),
        &header.modified_marker,
        &header.header_digest,
        &header.tensor_count.to_string(),
    ] {
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

pub(crate) fn inspect(source_path: &str) -> MediaResult<MediaLocalModelImportInspection> {
    let header = parse_header(source_path)?;
    let (detected_architecture, architecture_confidence) = detect_architecture(&header);
    let is_adapter = likely_adapter(&header);
    let mut warnings = vec![
        "Only the data-only safetensors header was inspected; no model code or repository script was executed."
            .to_string(),
        "Architecture detection is advisory. Confirm the base family shown by the model publisher before importing."
            .to_string(),
        "Single-file FLUX checkpoints may still require compatible text encoders, tokenizer, scheduler, and VAE components from their base model."
            .to_string(),
    ];
    if detected_architecture.is_none() {
        warnings.push(
            "The architecture could not be detected from metadata or tensor names; select it manually only if the publisher documents the base model."
                .to_string(),
        );
    }
    let blocking_reason = is_adapter.then(|| {
        "This file appears to be a LoRA or other adapter, not a complete SD/FLUX checkpoint. Adapter import requires a separate base-model compatibility workflow."
            .to_string()
    });
    Ok(MediaLocalModelImportInspection {
        schema_version: 1,
        can_import: blocking_reason.is_none(),
        blocking_reason,
        source_path: header.canonical_path.to_string_lossy().into_owned(),
        source_file_name: header.source_file_name.clone(),
        byte_size: header.byte_size,
        tensor_count: header.tensor_count,
        header_digest: header.header_digest.clone(),
        review_token: inspection_review_token(&header),
        suggested_display_name: suggested_display_name(&header),
        detected_architecture,
        architecture_confidence: architecture_confidence.to_string(),
        metadata_summary: metadata_summary(&header),
        warnings,
    })
}

pub(super) fn validated_text(
    field: &str,
    value: &str,
    maximum_chars: usize,
) -> MediaResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field} is required"));
    }
    if value.chars().count() > maximum_chars {
        return Err(format!("{field} exceeds {maximum_chars} characters"));
    }
    Ok(value.to_string())
}

pub(super) fn validated_source_url(value: Option<&str>) -> MediaResult<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > 2_048 || !value.starts_with("https://") {
        return Err("sourceUrl must be an HTTPS URL no longer than 2048 characters".to_string());
    }
    Ok(Some(value.to_string()))
}

pub(super) fn new_import_id() -> MediaResult<String> {
    let mut random = [0_u8; 12];
    getrandom::fill(&mut random)
        .map_err(|error| format!("failed to create model import id: {error}"))?;
    Ok(format!(
        "model-import-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

pub(super) fn copy_and_hash(
    source: &Path,
    destination: &Path,
    expected_bytes: u64,
) -> MediaResult<String> {
    let mut input = File::open(source)
        .map_err(|error| format!("failed to open the reviewed model file: {error}"))?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| format!("failed to create model import staging file: {error}"))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut byte_size = 0_u64;
    let mut hasher = Sha256::new();
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| format!("failed while reading the model file: {error}"))?;
        if read == 0 {
            break;
        }
        byte_size = byte_size.saturating_add(read as u64);
        if byte_size > expected_bytes {
            return Err("the model file changed while it was being imported".to_string());
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("failed while copying the model file: {error}"))?;
    }
    if byte_size != expected_bytes {
        return Err("the model file changed while it was being imported".to_string());
    }
    output
        .sync_all()
        .map_err(|error| format!("failed to flush the imported model file: {error}"))?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub(super) fn hash_file(path: &Path) -> MediaResult<(u64, String)> {
    let mut file = File::open(path)
        .map_err(|error| format!("failed to open the managed model revision: {error}"))?;
    let mut buffer = vec![0_u8; COPY_BUFFER_BYTES];
    let mut byte_size = 0_u64;
    let mut hasher = Sha256::new();
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("failed to verify the managed model revision: {error}"))?;
        if read == 0 {
            break;
        }
        byte_size = byte_size.saturating_add(read as u64);
        hasher.update(&buffer[..read]);
    }
    Ok((byte_size, format!("{:x}", hasher.finalize())))
}

fn stored_installation_exists(paths: &MediaRuntimePaths, model_id: &str) -> MediaResult<bool> {
    database::open(paths)?
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM media_model_installations WHERE model_id = ?1 AND status = 'installed')",
            params![model_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("failed to inspect imported model state: {error}"))
}

fn persist_import(
    paths: &MediaRuntimePaths,
    request: &ImportMediaLocalModelRequest,
    inspection: &MediaLocalModelImportInspection,
    digest: &str,
    relative_path: &str,
    imported_at: &str,
) -> MediaResult<()> {
    let profile = architecture_profile(&request.architecture)
        .ok_or_else(|| "architecture is not a supported SD or FLUX family".to_string())?;
    let source_url = validated_source_url(request.source_url.as_deref())?;
    let license_name = validated_text("licenseName", &request.license_name, 256)?;
    let display_name = validated_text("displayName", &request.display_name, 120)?;
    let model_id = format!("{USER_MODEL_ID_PREFIX}{digest}");
    let capabilities = serde_json::to_string(&["text-to-image", "image-to-image"])
        .map_err(|error| format!("failed to encode imported model capabilities: {error}"))?;
    let addon_capabilities = serde_json::to_string(&model_addon::capabilities_for_model(
        "local-diffusers",
        Some(&request.architecture),
    ))
    .map_err(|error| format!("failed to encode imported model add-on capabilities: {error}"))?;
    let catalog_revision = format!("{IMPORT_CATALOG_REVISION}:{digest}");
    let expected_download_gb = inspection.byte_size as f64 / 1_024_f64.powi(3);
    let limitation = "Imported single-file checkpoint. Architecture is user-confirmed and runtime compatibility is validated when loaded. FLUX transformer-only files may require compatible base-model encoders, tokenizer, scheduler, and VAE components.";
    let mut connection = database::open(paths)?;
    catalog::synchronize(&mut connection)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin imported model registration: {error}"))?;
    transaction
        .execute(
            "INSERT INTO media_models(
               id, provider_id, display_name, family, target, lifecycle, lifecycle_checked_at,
               lifecycle_stale_after_seconds, lifecycle_source_url, catalog_revision, capabilities_json,
               architecture, addon_capabilities_json, bundled, package_type, license_name, license_spdx_id, license_source_url,
               license_commercial_use, license_requires_acceptance, recommended, speed_score,
               quality_score, min_vram_gb, expected_download_gb, cost_hint, privacy_summary, limitation, updated_at
             ) VALUES (?1, 'local-diffusers', ?2, ?3, 'local', 'active', ?4, ?5, ?6, ?7, ?8,
               ?9, ?10, 0, 'safetensors', ?11, NULL, ?12, ?13, 0, 0, ?14, ?15, ?16, ?17,
               'No provider charge; uses local GPU time and power.',
               'Prompt, checkpoint weights, and generated pixels remain on this device.', ?18, ?4)
             ON CONFLICT(id) DO UPDATE SET
               display_name = excluded.display_name, family = excluded.family, lifecycle = 'active',
               lifecycle_checked_at = excluded.lifecycle_checked_at,
               lifecycle_source_url = excluded.lifecycle_source_url,
               catalog_revision = excluded.catalog_revision, capabilities_json = excluded.capabilities_json,
               architecture = excluded.architecture,
               addon_capabilities_json = excluded.addon_capabilities_json,
               license_name = excluded.license_name, license_source_url = excluded.license_source_url,
               license_commercial_use = excluded.license_commercial_use,
               speed_score = excluded.speed_score, quality_score = excluded.quality_score,
               min_vram_gb = excluded.min_vram_gb, expected_download_gb = excluded.expected_download_gb,
               limitation = excluded.limitation, updated_at = excluded.updated_at",
            params![
                model_id,
                display_name,
                profile.family,
                imported_at,
                10_i64 * 365 * 24 * 60 * 60,
                source_url.as_deref(),
                catalog_revision,
                capabilities,
                request.architecture,
                addon_capabilities,
                license_name,
                source_url.as_deref().unwrap_or(""),
                request.commercial_use,
                profile.speed_score,
                profile.quality_score,
                profile.min_vram_gb,
                expected_download_gb,
                limitation,
            ],
        )
        .map_err(|error| format!("failed to register imported model metadata: {error}"))?;
    transaction
        .execute(
            "INSERT INTO media_model_installations(
               model_id, revision, status, manifest_digest, bytes_on_disk, installed_at,
               verified_at, error, updated_at, relative_path
             ) VALUES (?1, ?2, 'installed', ?2, ?3, ?4, ?4, NULL, ?4, ?5)
             ON CONFLICT(model_id) DO UPDATE SET revision = excluded.revision, status = 'installed',
               manifest_digest = excluded.manifest_digest, bytes_on_disk = excluded.bytes_on_disk,
               installed_at = excluded.installed_at, verified_at = excluded.verified_at,
               error = NULL, updated_at = excluded.updated_at, relative_path = excluded.relative_path",
            params![model_id, digest, inspection.byte_size as i64, imported_at, relative_path],
        )
        .map_err(|error| format!("failed to publish imported model readiness: {error}"))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO media_model_lifecycle_snapshots(
               model_id, lifecycle, checked_at, source_url, catalog_revision, observed_at
             ) VALUES (?1, 'active', ?2, ?3, ?4, ?2)",
            params![
                model_id,
                imported_at,
                source_url.as_deref(),
                catalog_revision
            ],
        )
        .map_err(|error| format!("failed to snapshot imported model lifecycle: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit imported model registration: {error}"))
}

pub(crate) fn import_reviewed(
    paths: &MediaRuntimePaths,
    request: &ImportMediaLocalModelRequest,
) -> MediaResult<MediaLocalModelImportResult> {
    if !request.confirm_rights {
        return Err(
            "confirmRights is required after reviewing the model source and license".to_string(),
        );
    }
    if !SUPPORTED_ARCHITECTURES.contains(&request.architecture.as_str()) {
        return Err("architecture is not a supported SD or FLUX family".to_string());
    }
    if !matches!(
        request.commercial_use.as_str(),
        "allowed" | "review-required"
    ) {
        return Err("commercialUse must be allowed or review-required".to_string());
    }
    validated_text("displayName", &request.display_name, 120)?;
    validated_text("licenseName", &request.license_name, 256)?;
    validated_source_url(request.source_url.as_deref())?;

    let inspection = inspect(&request.source_path)?;
    if !inspection.can_import {
        return Err(inspection.blocking_reason.unwrap_or_else(|| {
            "the selected safetensors file cannot be imported as a complete model".to_string()
        }));
    }
    if request.review_token != inspection.review_token {
        return Err(
            "the selected model file changed; inspect it again before importing".to_string(),
        );
    }
    let required_bytes = inspection.byte_size.saturating_mul(105).div_ceil(100);
    let models_root = paths.models_root()?;
    fs::create_dir_all(&models_root)
        .map_err(|error| format!("failed to prepare model storage: {error}"))?;
    if hardware::available_storage_bytes(&models_root).map(|available| available < required_bytes)
        == Some(true)
    {
        return Err("the Media Studio model volume does not have enough free space".to_string());
    }

    let import_id = new_import_id()?;
    let stage_root = models_root.join("staging").join(&import_id);
    let stage_repository = stage_root.join("repository");
    fs::create_dir_all(&stage_repository)
        .map_err(|error| format!("failed to prepare model import staging: {error}"))?;
    let staged_checkpoint = stage_repository.join("checkpoint.safetensors");
    let copy_result = copy_and_hash(
        Path::new(&inspection.source_path),
        &staged_checkpoint,
        inspection.byte_size,
    );
    let digest = match copy_result {
        Ok(digest) => digest,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage_root);
            return Err(error);
        }
    };
    if let Err(error) = parse_header(staged_checkpoint.to_string_lossy().as_ref()) {
        let quarantine_root = models_root.join("quarantine").join(&import_id);
        fs::create_dir_all(
            quarantine_root
                .parent()
                .ok_or_else(|| "model quarantine path has no parent".to_string())?,
        )
        .map_err(|fs_error| format!("failed to prepare model quarantine: {fs_error}"))?;
        fs::rename(&stage_root, &quarantine_root)
            .map_err(|fs_error| format!("failed to quarantine invalid model data: {fs_error}"))?;
        return Err(format!(
            "the copied safetensors file failed verification and was quarantined: {error}"
        ));
    }

    let model_id = format!("{USER_MODEL_ID_PREFIX}{digest}");
    let slug = format!("user-{}", &digest[..32]);
    let relative_path = format!("packages/{slug}/revisions/{digest}");
    let revision_root = models_root
        .join("packages")
        .join(&slug)
        .join("revisions")
        .join(&digest);
    let package_root = models_root.join("packages").join(&slug);
    let already_installed = stored_installation_exists(paths, &model_id)?;
    if revision_root.exists() {
        let existing = revision_root.join("checkpoint.safetensors");
        let (existing_bytes, existing_digest) = hash_file(&existing)?;
        if existing_bytes != inspection.byte_size || existing_digest != digest {
            let _ = fs::remove_dir_all(&stage_root);
            return Err(
                "the managed model revision conflicts with the imported digest".to_string(),
            );
        }
        fs::remove_dir_all(&stage_root)
            .map_err(|error| format!("failed to clean duplicate model staging data: {error}"))?;
    } else {
        fs::create_dir_all(
            revision_root
                .parent()
                .ok_or_else(|| "model revision path has no parent".to_string())?,
        )
        .map_err(|error| format!("failed to prepare model revision storage: {error}"))?;
        fs::rename(&stage_repository, &revision_root)
            .map_err(|error| format!("failed to atomically activate imported model: {error}"))?;
        let _ = fs::remove_dir_all(&stage_root);
    }

    let imported_at = database::now();
    let active_pointer = serde_json::json!({
        "schemaVersion": 1,
        "modelId": model_id,
        "revision": digest,
        "manifestDigest": digest,
        "relativePath": relative_path,
        "checkpointFile": "checkpoint.safetensors",
        "architecture": request.architecture,
        "activatedAt": imported_at,
    });
    fs::create_dir_all(&package_root)
        .map_err(|error| format!("failed to prepare imported model package: {error}"))?;
    crate::atomic_file::write_file_atomic(
        &package_root.join("active.json"),
        &serde_json::to_vec_pretty(&active_pointer)
            .map_err(|error| format!("failed to encode imported model pointer: {error}"))?,
        crate::atomic_file::AtomicWriteOptions::default(),
    )
    .map_err(|error| format!("failed to publish imported model pointer: {error}"))?;
    persist_import(
        paths,
        request,
        &inspection,
        &digest,
        &relative_path,
        &imported_at,
    )?;
    let profile = architecture_profile(&request.architecture)
        .ok_or_else(|| "architecture is not a supported SD or FLUX family".to_string())?;
    Ok(MediaLocalModelImportResult {
        schema_version: 1,
        model_id,
        display_name: request.display_name.trim().to_string(),
        family: profile.family.to_string(),
        revision: digest.clone(),
        digest,
        byte_size: inspection.byte_size,
        target_label: format!("models/{relative_path}/checkpoint.safetensors"),
        imported_at,
        already_installed,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;
    use crate::media::{model_install, RemoveMediaModelRequest};

    fn temp_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        std::env::temp_dir().join(format!("machdoch-model-import-{name}-{unique}.safetensors"))
    }

    fn test_paths(name: &str) -> (PathBuf, MediaRuntimePaths) {
        let source = temp_path(name);
        let root = source.with_extension("store");
        let paths = MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs").join("sha256"),
        };
        (root, paths)
    }

    fn write_safetensors(path: &Path, entries: Value, data: &[u8]) {
        let mut header = serde_json::to_vec(&entries).expect("header should encode");
        while (8 + header.len()) % 8 != 0 {
            header.push(b' ');
        }
        let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
        bytes.extend(header);
        bytes.extend(data);
        fs::write(path, bytes).expect("fixture should be written");
    }

    #[test]
    fn inspects_sdxl_safetensors_without_reading_model_code() {
        let path = temp_path("sdxl");
        write_safetensors(
            &path,
            serde_json::json!({
                "__metadata__": {
                    "modelspec.title": "Community XL",
                    "modelspec.architecture": "stable-diffusion-xl-v1-base"
                },
                "conditioner.embedders.1.model.weight": {
                    "dtype": "F32",
                    "shape": [1],
                    "data_offsets": [0, 4]
                }
            }),
            &[0, 0, 0, 0],
        );

        let inspection = inspect(path.to_string_lossy().as_ref()).expect("inspection should pass");
        assert!(inspection.can_import);
        assert_eq!(
            inspection.detected_architecture.as_deref(),
            Some("stable-diffusion-xl")
        );
        assert_eq!(inspection.suggested_display_name, "Community XL");
        assert_eq!(inspection.tensor_count, 1);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn blocks_lora_files_from_full_model_import() {
        let path = temp_path("lora");
        write_safetensors(
            &path,
            serde_json::json!({
                "__metadata__": { "ss_network_module": "networks.lora" },
                "lora_unet_block.lora_up.weight": {
                    "dtype": "F32", "shape": [1], "data_offsets": [0, 4]
                },
                "lora_unet_block.lora_down.weight": {
                    "dtype": "F32", "shape": [1], "data_offsets": [4, 8]
                }
            }),
            &[0, 0, 0, 0, 0, 0, 0, 0],
        );

        let inspection = inspect(path.to_string_lossy().as_ref()).expect("inspection should pass");
        assert!(!inspection.can_import);
        assert!(inspection
            .blocking_reason
            .expect("reason should exist")
            .contains("LoRA"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_tensor_offsets_outside_the_data_section() {
        let path = temp_path("offset");
        write_safetensors(
            &path,
            serde_json::json!({
                "model.weight": {
                    "dtype": "F32", "shape": [2], "data_offsets": [0, 8]
                }
            }),
            &[0, 0, 0, 0],
        );

        let error = inspect(path.to_string_lossy().as_ref()).expect_err("inspection should fail");
        assert!(error.contains("outside the safetensors data section"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn imports_catalogs_and_removes_a_reviewed_checkpoint() {
        let source = temp_path("managed");
        let (root, paths) = test_paths("managed");
        fs::create_dir_all(&root).expect("model store should be created");
        write_safetensors(
            &source,
            serde_json::json!({
                "__metadata__": {
                    "modelspec.title": "Managed XL",
                    "modelspec.architecture": "stable-diffusion-xl-v1-base"
                },
                "conditioner.embedders.1.model.weight": {
                    "dtype": "F32", "shape": [1], "data_offsets": [0, 4]
                }
            }),
            &[0, 0, 0, 0],
        );
        database::initialize(&paths).expect("database should initialize");
        let inspection =
            inspect(source.to_string_lossy().as_ref()).expect("inspection should pass");
        let result = import_reviewed(
            &paths,
            &ImportMediaLocalModelRequest {
                source_path: inspection.source_path.clone(),
                review_token: inspection.review_token,
                display_name: "Managed XL".to_string(),
                architecture: "stable-diffusion-xl".to_string(),
                source_url: Some("https://civitai.com/models/123".to_string()),
                license_name: "Publisher terms".to_string(),
                commercial_use: "review-required".to_string(),
                confirm_rights: true,
            },
        )
        .expect("model should import");

        assert!(result.model_id.starts_with(USER_MODEL_ID_PREFIX));
        assert!(!result.already_installed);
        let mut connection = database::open(&paths).expect("database should open");
        catalog::synchronize(&mut connection).expect("catalog sync should preserve user models");
        let catalog =
            catalog::snapshot(&connection, &Default::default()).expect("catalog should load");
        let imported = catalog
            .models
            .iter()
            .find(|model| model.id == result.model_id)
            .expect("imported model should be cataloged");
        assert!(imported.user_imported);
        assert!(imported.installed);
        assert_eq!(imported.package_type, "safetensors");

        let removal_plan = model_install::plan_removal(&paths, &result.model_id)
            .expect("imported model removal should be planned");
        let removal = model_install::remove(
            &paths,
            &RemoveMediaModelRequest {
                model_id: result.model_id,
                confirmation_token: removal_plan.confirmation_token,
                confirm_removal: true,
            },
        )
        .expect("imported model should be removed");
        assert_eq!(removal.reclaimed_bytes, result.byte_size);

        let _ = fs::remove_file(source);
        let _ = fs::remove_dir_all(root);
    }
}
