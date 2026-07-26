use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use serde_json::Value;

use super::{
    model_addon, model_import, MediaDiscoveredModelArtifact, MediaResult,
    MediaWorkspaceModelDiscovery,
};

const MAX_FILES: usize = 50_000;
const MAX_DEPTH: usize = 12;
const MAX_WARNINGS: usize = 100;
const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;
const WAN_ARCHITECTURE: &str = "wan-2.2-ti2v";
const WAN_MODEL_REVISION: &str = "b8fff7315c768468a5333511427288870b2e9635";
const WAN_REQUIRED_FILES: &[&str] = &[
    "model_index.json",
    "scheduler/scheduler_config.json",
    "text_encoder/config.json",
    "text_encoder/model.safetensors.index.json",
    "tokenizer/special_tokens_map.json",
    "tokenizer/spiece.model",
    "tokenizer/tokenizer.json",
    "tokenizer/tokenizer_config.json",
    "transformer/config.json",
    "transformer/diffusion_pytorch_model.safetensors.index.json",
    "vae/config.json",
    "vae/diffusion_pytorch_model.safetensors",
];

#[derive(Clone, Copy)]
struct DirectoryInventory {
    byte_size: u64,
    file_count: u32,
    truncated: bool,
}

fn relative_display(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

fn directory_inventory(
    root: &Path,
    max_files: usize,
    max_depth: usize,
) -> MediaResult<DirectoryInventory> {
    if max_files == 0 {
        return Ok(DirectoryInventory {
            byte_size: 0,
            file_count: 0,
            truncated: true,
        });
    }
    let mut bytes = 0_u64;
    let mut files = 0_usize;
    let mut truncated = false;
    let mut pending = vec![(root.to_path_buf(), 0_usize)];
    while let Some((directory, depth)) = pending.pop() {
        if depth > max_depth {
            truncated = true;
            continue;
        }
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("failed to inspect {}: {error}", directory.display()))?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                format!(
                    "failed to inspect an entry below {}: {error}",
                    directory.display()
                )
            })?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
                format!("failed to inspect {}: {error}", entry.path().display())
            })?;
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push((entry.path(), depth + 1));
            } else if metadata.is_file() {
                files += 1;
                bytes = bytes.saturating_add(metadata.len());
                if files >= max_files {
                    truncated = true;
                    pending.clear();
                    break;
                }
            }
        }
    }
    Ok(DirectoryInventory {
        byte_size: bytes,
        file_count: files.min(u32::MAX as usize) as u32,
        truncated,
    })
}

fn read_json(path: &Path, label: &str) -> MediaResult<Value> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {label} {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label} {} is not a regular file", path.display()));
    }
    if metadata.len() > MAX_JSON_BYTES {
        return Err(format!(
            "{label} {} exceeds the {} MiB inspection limit",
            path.display(),
            MAX_JSON_BYTES / (1024 * 1024)
        ));
    }
    let encoded = fs::read(path)
        .map_err(|error| format!("failed to read {label} {}: {error}", path.display()))?;
    serde_json::from_slice(&encoded)
        .map_err(|error| format!("{label} {} is invalid JSON: {error}", path.display()))
}

fn regular_nonempty_file(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        !metadata.file_type().is_symlink() && metadata.is_file() && metadata.len() > 0
    })
}

fn regular_file(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|metadata| !metadata.file_type().is_symlink() && metadata.is_file())
}

fn safe_relative_path(root: &Path, relative: &Path) -> MediaResult<PathBuf> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!(
            "model package contains an unsafe relative path: {}",
            relative.display()
        ));
    }
    Ok(root.join(relative))
}

fn indexed_weight_files(directory: &Path, relative_index: &str) -> MediaResult<Vec<String>> {
    let index_path = safe_relative_path(directory, Path::new(relative_index))?;
    let index = read_json(&index_path, "model weight index")?;
    let weight_map = index
        .get("weight_map")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{relative_index} has no weight_map object"))?;
    let parent = Path::new(relative_index)
        .parent()
        .ok_or_else(|| format!("{relative_index} has no parent directory"))?;
    let mut relatives = weight_map
        .values()
        .map(|value| {
            let shard = value
                .as_str()
                .ok_or_else(|| format!("{relative_index} contains a non-string shard name"))?;
            let relative = parent.join(shard);
            safe_relative_path(directory, &relative)?;
            Ok(relative.to_string_lossy().replace('\\', "/"))
        })
        .collect::<MediaResult<Vec<_>>>()?;
    relatives.sort();
    relatives.dedup();
    if relatives.is_empty() || relatives.len() > 64 {
        return Err(format!(
            "{relative_index} declares an invalid shard inventory"
        ));
    }
    Ok(relatives)
}

fn huggingface_revision(directory: &Path, relative: &str) -> MediaResult<String> {
    let metadata_relative =
        PathBuf::from(format!(".cache/huggingface/download/{relative}.metadata"));
    let metadata_path = safe_relative_path(directory, &metadata_relative)?;
    let metadata = fs::symlink_metadata(&metadata_path).map_err(|_| {
        format!(
            "missing Hugging Face revision metadata for {relative}; re-download the pinned package with snapshot_download"
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4_096 {
        return Err(format!(
            "Hugging Face revision metadata for {relative} is unsafe or invalid"
        ));
    }
    let encoded = fs::read_to_string(&metadata_path).map_err(|error| {
        format!("failed to read Hugging Face revision metadata for {relative}: {error}")
    })?;
    encoded
        .lines()
        .next()
        .map(str::trim)
        .filter(|revision| !revision.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("Hugging Face revision metadata for {relative} is empty"))
}

fn is_wan_22_ti2v_5b(model_index: &Value, transformer_config: &Value) -> bool {
    model_index.get("_class_name").and_then(Value::as_str) == Some("WanPipeline")
        && model_index.get("expand_timesteps").and_then(Value::as_bool) == Some(true)
        && transformer_config
            .get("_class_name")
            .and_then(Value::as_str)
            == Some("WanTransformer3DModel")
        && transformer_config
            .get("in_channels")
            .and_then(Value::as_u64)
            == Some(48)
        && transformer_config
            .get("out_channels")
            .and_then(Value::as_u64)
            == Some(48)
        && transformer_config.get("num_layers").and_then(Value::as_u64) == Some(30)
        && transformer_config
            .get("num_attention_heads")
            .and_then(Value::as_u64)
            == Some(24)
        && transformer_config
            .get("attention_head_dim")
            .and_then(Value::as_u64)
            == Some(128)
        && transformer_config.get("text_dim").and_then(Value::as_u64) == Some(4_096)
}

fn wan_artifact(
    models_root: &Path,
    directory: &Path,
    model_index: &Value,
    inventory: DirectoryInventory,
) -> MediaResult<MediaDiscoveredModelArtifact> {
    let DirectoryInventory {
        byte_size,
        file_count,
        truncated,
    } = inventory;
    let transformer_config_path = directory.join("transformer").join("config.json");
    let transformer_config = match read_json(&transformer_config_path, "Wan transformer config") {
        Ok(config) => config,
        Err(error) => {
            return Ok(MediaDiscoveredModelArtifact {
                path: directory.display().to_string(),
                relative_path: relative_display(models_root, directory),
                display_name: "Wan Diffusers package".to_string(),
                kind: "diffusers-model".to_string(),
                status: "incomplete".to_string(),
                architecture: Some("wan".to_string()),
                byte_size,
                file_count,
                capabilities: Vec::new(),
                diagnostic: error,
            });
        }
    };
    if !is_wan_22_ti2v_5b(model_index, &transformer_config) {
        let layers = transformer_config
            .get("num_layers")
            .and_then(Value::as_u64)
            .map_or_else(|| "unknown".to_string(), |value| value.to_string());
        let heads = transformer_config
            .get("num_attention_heads")
            .and_then(Value::as_u64)
            .map_or_else(|| "unknown".to_string(), |value| value.to_string());
        return Ok(MediaDiscoveredModelArtifact {
            path: directory.display().to_string(),
            relative_path: relative_display(models_root, directory),
            display_name: "Unsupported Wan Diffusers variant".to_string(),
            kind: "diffusers-model".to_string(),
            status: "incompatible".to_string(),
            architecture: Some("wan".to_string()),
            byte_size,
            file_count,
            capabilities: Vec::new(),
            diagnostic: format!(
                "This package declares WanPipeline but does not match the executable Wan2.2 TI2V 5B transformer profile (observed {layers} layers and {heads} attention heads). Add a reviewed runtime profile for this exact variant before execution."
            ),
        });
    }

    let mut required = WAN_REQUIRED_FILES
        .iter()
        .map(|relative| (*relative).to_string())
        .collect::<Vec<_>>();
    let mut package_error = None;
    for index in [
        "text_encoder/model.safetensors.index.json",
        "transformer/diffusion_pytorch_model.safetensors.index.json",
    ] {
        match indexed_weight_files(directory, index) {
            Ok(shards) => required.extend(shards),
            Err(error) => {
                package_error = Some(error);
                break;
            }
        }
    }
    required.sort();
    required.dedup();
    let missing = required
        .iter()
        .filter(|relative| !regular_nonempty_file(&directory.join(relative)))
        .cloned()
        .collect::<Vec<_>>();
    let revision_error = huggingface_revision(directory, "model_index.json")
        .and_then(|revision| {
            if revision == WAN_MODEL_REVISION {
                Ok(())
            } else {
                Err(format!(
                    "this package was downloaded from revision {revision}; the reviewed runtime profile requires {WAN_MODEL_REVISION}"
                ))
            }
        })
        .err();
    let ready =
        !truncated && missing.is_empty() && package_error.is_none() && revision_error.is_none();
    let diagnostic = if ready {
        "Pinned Wan2.2 TI2V 5B Diffusers components and revision metadata are present. The official native profile requires at least 24 GiB VRAM; Machdoch exposes a bounded experimental preview on compatible 16+ GiB adapters.".to_string()
    } else if truncated {
        "Wan package inventory exceeded the bounded discovery limits.".to_string()
    } else if let Some(error) = package_error {
        format!("Wan package index is incomplete or unsafe: {error}.")
    } else if !missing.is_empty() {
        format!(
            "Wan download is incomplete; missing {}.",
            missing.join(", ")
        )
    } else {
        revision_error.unwrap_or_else(|| "Wan package verification failed.".to_string())
    };
    Ok(MediaDiscoveredModelArtifact {
        path: directory.display().to_string(),
        relative_path: relative_display(models_root, directory),
        display_name: "Wan2.2 TI2V 5B".to_string(),
        kind: "diffusers-model".to_string(),
        status: if ready { "ready" } else { "incomplete" }.to_string(),
        architecture: Some(WAN_ARCHITECTURE.to_string()),
        byte_size,
        file_count,
        capabilities: vec![
            "text-to-video".to_string(),
            "image-to-video".to_string(),
            "start-end-to-video".to_string(),
            "transparent-output".to_string(),
            "alpha-video".to_string(),
            "video-composite".to_string(),
        ],
        diagnostic,
    })
}

fn diffusers_artifact(
    models_root: &Path,
    directory: &Path,
    inventory: DirectoryInventory,
) -> MediaResult<MediaDiscoveredModelArtifact> {
    let model_index_path = directory.join("model_index.json");
    let model_index = match read_json(&model_index_path, "Diffusers model index") {
        Ok(index) => index,
        Err(error) => {
            return Ok(MediaDiscoveredModelArtifact {
                path: directory.display().to_string(),
                relative_path: relative_display(models_root, directory),
                display_name: directory
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Invalid Diffusers package")
                    .replace(['_', '-'], " "),
                kind: "diffusers-model".to_string(),
                status: if inventory.truncated {
                    "incomplete"
                } else {
                    "unsupported"
                }
                .to_string(),
                architecture: None,
                byte_size: inventory.byte_size,
                file_count: inventory.file_count,
                capabilities: Vec::new(),
                diagnostic: if inventory.truncated {
                    "The Diffusers package inventory exceeded the remaining bounded discovery budget."
                        .to_string()
                } else {
                    error
                },
            });
        }
    };
    let class_name = model_index
        .get("_class_name")
        .and_then(Value::as_str)
        .unwrap_or("");
    if class_name == "WanPipeline" {
        return wan_artifact(models_root, directory, &model_index, inventory);
    }

    Ok(MediaDiscoveredModelArtifact {
        path: directory.display().to_string(),
        relative_path: relative_display(models_root, directory),
        display_name: directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Diffusers package")
            .replace(['_', '-'], " "),
        kind: "diffusers-model".to_string(),
        status: if inventory.truncated {
            "incomplete"
        } else {
            "unsupported"
        }
        .to_string(),
        architecture: (!class_name.is_empty()).then(|| format!("diffusers:{class_name}")),
        byte_size: inventory.byte_size,
        file_count: inventory.file_count,
        capabilities: Vec::new(),
        diagnostic: if inventory.truncated {
            "The Diffusers package inventory exceeded the remaining bounded discovery budget."
                .to_string()
        } else if class_name.is_empty() {
            "The Diffusers model index does not declare a pipeline class.".to_string()
        } else {
            format!(
                "Diffusers pipeline {class_name} is discoverable but has no registered executable runtime profile."
            )
        },
    })
}

fn krea_runtime_artifact(
    models_root: &Path,
    directory: &Path,
    inventory: DirectoryInventory,
) -> MediaResult<MediaDiscoveredModelArtifact> {
    let required = [
        "qwen3-vl/config.json",
        "qwen3-vl/tokenizer_config.json",
        "qwen3-vl/tokenizer.json",
        "qwen3-vl/model.safetensors.index.json",
        "qwen3-vl/model-00001-of-00002.safetensors",
        "qwen3-vl/model-00002-of-00002.safetensors",
        "qwen-image/vae/config.json",
        "qwen-image/vae/diffusion_pytorch_model.safetensors",
    ];
    let missing = required
        .iter()
        .filter(|relative| !regular_nonempty_file(&directory.join(relative)))
        .copied()
        .collect::<Vec<_>>();
    let ready = missing.is_empty() && inventory.byte_size >= 8_500_000_000 && !inventory.truncated;
    Ok(MediaDiscoveredModelArtifact {
        path: directory.display().to_string(),
        relative_path: relative_display(models_root, directory),
        display_name: "KREA 2 shared runtime".to_string(),
        kind: "source-repository".to_string(),
        status: if ready { "ready" } else { "incomplete" }.to_string(),
        architecture: Some("krea-2".to_string()),
        byte_size: inventory.byte_size,
        file_count: inventory.file_count,
        capabilities: vec!["text-encoding".to_string(), "latent-decoding".to_string()],
        diagnostic: if ready {
            "Pinned Qwen3-VL 4B text-encoder and Qwen-Image VAE components are available for every imported KREA 2 checkpoint.".to_string()
        } else if !missing.is_empty() {
            format!(
                "KREA 2 runtime is incomplete; missing {}.",
                missing.join(", ")
            )
        } else {
            "KREA 2 runtime is truncated or exceeded the bounded discovery inventory.".to_string()
        },
    })
}

fn safetensors_artifact(
    models_root: &Path,
    path: &Path,
) -> MediaResult<MediaDiscoveredModelArtifact> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("model discovery accepts only regular safetensors files".to_string());
    }
    let relative = relative_display(models_root, path);
    let addon_inspection = model_addon::inspect(path.to_string_lossy().as_ref());
    if let Ok(inspection) = addon_inspection.as_ref() {
        // Prefer the inspected tensor inventory over directory and file naming.
        // This also finds textual-inversion embeddings in arbitrary folders.
        if inspection.detected_kind.is_some() {
            return Ok(MediaDiscoveredModelArtifact {
                path: path.display().to_string(),
                relative_path: relative,
                display_name: inspection.suggested_display_name.clone(),
                kind: "model-addon".to_string(),
                status: if inspection.can_import {
                    "importable"
                } else {
                    "unsupported"
                }
                .to_string(),
                architecture: inspection.detected_architecture.clone(),
                byte_size: metadata.len(),
                file_count: 1,
                capabilities: inspection
                    .detected_kind
                    .clone()
                    .into_iter()
                    .collect::<Vec<_>>(),
                diagnostic: if inspection.can_import {
                    format!(
                        "Safe header inspection passed with {} architecture confidence; import it through the reviewed add-on flow before generation.",
                        inspection.architecture_confidence
                    )
                } else {
                    inspection
                        .blocking_reason
                        .clone()
                        .unwrap_or_else(|| "The add-on format is unsupported.".to_string())
                },
            });
        }
    }

    if let Ok(inspection) = model_import::inspect(path.to_string_lossy().as_ref()) {
        return Ok(MediaDiscoveredModelArtifact {
            path: path.display().to_string(),
            relative_path: relative,
            display_name: inspection.suggested_display_name,
            kind: "checkpoint".to_string(),
            status: if inspection.can_import {
                "importable"
            } else {
                "unsupported"
            }
            .to_string(),
            architecture: inspection.detected_architecture,
            byte_size: metadata.len(),
            file_count: 1,
            capabilities: vec!["checkpoint".to_string()],
            diagnostic: inspection.blocking_reason.unwrap_or_else(|| {
                format!(
                    "Safe header inspection passed with {} architecture confidence; import and verify before use.",
                    inspection.architecture_confidence
                )
            }),
        });
    }

    // A single malformed or partially downloaded artifact must not hide every
    // other valid model in the workspace.
    let diagnostic = addon_inspection.err().unwrap_or_else(|| {
        "the tensor inventory is not a supported add-on or checkpoint".to_string()
    });
    let diagnostic = diagnostic.chars().take(800).collect::<String>();
    Ok(MediaDiscoveredModelArtifact {
        path: path.display().to_string(),
        relative_path: relative,
        display_name: path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("Unsupported safetensors artifact")
            .replace(['_', '-'], " "),
        kind: "checkpoint".to_string(),
        status: "unsupported".to_string(),
        architecture: None,
        byte_size: metadata.len(),
        file_count: 1,
        capabilities: Vec::new(),
        diagnostic: format!(
            "Safe header inspection failed for this artifact; the rest of the workspace was still scanned. {diagnostic}"
        ),
    })
}

fn push_warning(warnings: &mut Vec<String>, warning: String) {
    // Retain one extra entry as an omission marker. The result is truncated
    // back to MAX_WARNINGS below and receives a single actionable summary.
    if warnings.len() <= MAX_WARNINGS {
        warnings.push(warning);
    }
}

fn finalize_warnings(
    mut warnings: Vec<String>,
    truncated: bool,
    max_files: usize,
    max_depth: usize,
) -> Vec<String> {
    if truncated {
        warnings.insert(
            0,
            format!(
                "Discovery stopped at {max_files} files or depth {max_depth}; narrow the workspace model layout."
            ),
        );
    }
    if warnings.len() > MAX_WARNINGS {
        warnings.truncate(MAX_WARNINGS);
        warnings.push(
            "Additional model discovery warnings were omitted; narrow the workspace model layout."
                .to_string(),
        );
    }
    warnings
}

fn discover_with_limits(
    workspace_root: &str,
    max_files: usize,
    max_depth: usize,
) -> MediaResult<MediaWorkspaceModelDiscovery> {
    let workspace_root = crate::runtime_snapshot::resolve_workspace_root_path(workspace_root)?;
    let models_root = workspace_root.join("models");
    if !models_root.is_dir() {
        return Ok(MediaWorkspaceModelDiscovery {
            schema_version: 1,
            root_path: models_root.display().to_string(),
            scanned_at: super::database::now(),
            entries: Vec::new(),
            truncated: false,
            warnings: vec!["The workspace has no models directory.".to_string()],
        });
    }
    let models_root = fs::canonicalize(&models_root)
        .map_err(|error| format!("failed to resolve the workspace models directory: {error}"))?;
    let mut entries = Vec::new();
    let mut pending = vec![(models_root.clone(), 0_usize)];
    let mut visited_files = 0_usize;
    let mut truncated = false;
    let mut warnings = Vec::new();
    while let Some((directory, depth)) = pending.pop() {
        if depth > max_depth || visited_files >= max_files {
            truncated = true;
            continue;
        }
        let directory_name = directory
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if directory_name.eq_ignore_ascii_case("runtime")
            && directory
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("krea-2"))
        {
            let inventory = match directory_inventory(
                &directory,
                max_files.saturating_sub(visited_files),
                max_depth.saturating_sub(depth),
            ) {
                Ok(inventory) => inventory,
                Err(error) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Could not inventory KREA runtime package {}: {error}",
                            relative_display(&models_root, &directory)
                        ),
                    );
                    continue;
                }
            };
            visited_files = visited_files.saturating_add(inventory.file_count as usize);
            truncated |= inventory.truncated;
            match krea_runtime_artifact(&models_root, &directory, inventory) {
                Ok(artifact) => entries.push(artifact),
                Err(error) => push_warning(
                    &mut warnings,
                    format!(
                        "Could not inspect KREA runtime package {}: {error}",
                        relative_display(&models_root, &directory)
                    ),
                ),
            }
            continue;
        }
        if regular_file(&directory.join("model_index.json")) {
            let inventory = match directory_inventory(
                &directory,
                max_files.saturating_sub(visited_files),
                max_depth.saturating_sub(depth),
            ) {
                Ok(inventory) => inventory,
                Err(error) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Could not inventory Diffusers package {}: {error}",
                            relative_display(&models_root, &directory)
                        ),
                    );
                    continue;
                }
            };
            visited_files = visited_files.saturating_add(inventory.file_count as usize);
            truncated |= inventory.truncated;
            match diffusers_artifact(&models_root, &directory, inventory) {
                Ok(artifact) => entries.push(artifact),
                Err(error) => push_warning(
                    &mut warnings,
                    format!(
                        "Could not inspect Diffusers package {}: {error}",
                        relative_display(&models_root, &directory)
                    ),
                ),
            }
            continue;
        }
        if directory_name.eq_ignore_ascii_case("Wan-Alpha") {
            let inventory = match directory_inventory(
                &directory,
                max_files.saturating_sub(visited_files),
                max_depth.saturating_sub(depth),
            ) {
                Ok(inventory) => inventory,
                Err(error) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Could not inventory {}: {error}",
                            relative_display(&models_root, &directory)
                        ),
                    );
                    continue;
                }
            };
            visited_files = visited_files.saturating_add(inventory.file_count as usize);
            truncated |= inventory.truncated;
            entries.push(MediaDiscoveredModelArtifact {
                path: directory.display().to_string(),
                relative_path: relative_display(&models_root, &directory),
                display_name: "Wan-Alpha source repository".to_string(),
                kind: "source-repository".to_string(),
                status: "incomplete".to_string(),
                architecture: None,
                byte_size: inventory.byte_size,
                file_count: inventory.file_count,
                capabilities: Vec::new(),
                diagnostic: "Source and training code are present, but no image-to-video checkpoint package is present. This repository cannot execute the Studio video node.".to_string(),
            });
            continue;
        }
        let directory_entries = match fs::read_dir(&directory) {
            Ok(directory_entries) => directory_entries,
            Err(error) => {
                push_warning(
                    &mut warnings,
                    format!(
                        "Could not scan {}: {error}",
                        relative_display(&models_root, &directory)
                    ),
                );
                continue;
            }
        };
        for entry in directory_entries {
            if visited_files >= max_files {
                truncated = true;
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Could not inspect an entry below {}: {error}",
                            relative_display(&models_root, &directory)
                        ),
                    );
                    continue;
                }
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    push_warning(
                        &mut warnings,
                        format!(
                            "Could not inspect {}: {error}",
                            relative_display(&models_root, &path)
                        ),
                    );
                    continue;
                }
            };
            if metadata.file_type().is_symlink() {
                continue;
            }
            if metadata.is_dir() {
                pending.push((path, depth + 1));
            } else if metadata.is_file() {
                visited_files += 1;
                if path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("safetensors"))
                {
                    match safetensors_artifact(&models_root, &path) {
                        Ok(artifact) => entries.push(artifact),
                        Err(error) => push_warning(
                            &mut warnings,
                            format!(
                                "Could not inspect {}: {error}",
                                relative_display(&models_root, &path)
                            ),
                        ),
                    }
                }
            }
        }
    }
    entries.sort_by(|left, right| {
        left.relative_path
            .to_ascii_lowercase()
            .cmp(&right.relative_path.to_ascii_lowercase())
    });
    let warnings = finalize_warnings(warnings, truncated, max_files, max_depth);
    Ok(MediaWorkspaceModelDiscovery {
        schema_version: 1,
        root_path: models_root.display().to_string(),
        scanned_at: super::database::now(),
        entries,
        truncated,
        warnings,
    })
}

pub(crate) fn discover(workspace_root: &str) -> MediaResult<MediaWorkspaceModelDiscovery> {
    discover_with_limits(workspace_root, MAX_FILES, MAX_DEPTH)
}

pub(crate) fn resolve_workspace_diffusers_package(
    workspace_root: &str,
    architecture: &str,
    preferred_relative_path: Option<&str>,
) -> MediaResult<PathBuf> {
    let discovery = discover(workspace_root)?;
    let models_root = fs::canonicalize(&discovery.root_path)
        .map_err(|error| format!("failed to resolve the workspace models directory: {error}"))?;
    let mut ready = discovery
        .entries
        .iter()
        .filter(|artifact| {
            artifact.kind == "diffusers-model"
                && artifact.status == "ready"
                && artifact.architecture.as_deref() == Some(architecture)
        })
        .collect::<Vec<_>>();
    ready.sort_by(|left, right| {
        left.relative_path
            .to_ascii_lowercase()
            .cmp(&right.relative_path.to_ascii_lowercase())
    });

    let selected = preferred_relative_path
        .and_then(|preferred| {
            ready
                .iter()
                .find(|artifact| artifact.relative_path.eq_ignore_ascii_case(preferred))
                .copied()
        })
        .or_else(|| (ready.len() == 1).then(|| ready[0]));
    let selected = if let Some(selected) = selected {
        selected
    } else if ready.is_empty() {
        let diagnostics = discovery
            .entries
            .iter()
            .filter(|artifact| artifact.architecture.as_deref() == Some(architecture))
            .map(|artifact| {
                format!(
                    "{} is {}: {}",
                    artifact.relative_path, artifact.status, artifact.diagnostic
                )
            })
            .collect::<Vec<_>>();
        return Err(if diagnostics.is_empty() {
            format!(
                "No compatible {architecture} Diffusers package was discovered below {}",
                models_root.display()
            )
        } else {
            format!(
                "No ready {architecture} Diffusers package was discovered. {}",
                diagnostics.join(" ")
            )
        });
    } else {
        return Err(format!(
            "Multiple ready {architecture} packages were discovered ({}). Keep the preferred package at {} or leave only one compatible package.",
            ready
                .iter()
                .map(|artifact| artifact.relative_path.as_str())
                .collect::<Vec<_>>()
                .join(", "),
            preferred_relative_path.unwrap_or("<the configured path>")
        ));
    };

    let selected_path = fs::canonicalize(&selected.path).map_err(|error| {
        format!(
            "failed to resolve discovered model package {}: {error}",
            selected.relative_path
        )
    })?;
    if !selected_path.starts_with(&models_root) {
        return Err("discovered model package escapes the workspace models directory".to_string());
    }
    Ok(selected_path)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        discover, discover_with_limits, finalize_warnings, push_warning,
        resolve_workspace_diffusers_package, MAX_WARNINGS, WAN_MODEL_REVISION,
    };

    fn test_workspace() -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "machdoch-model-discovery-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("models").join("misc"))
            .expect("test model directory should be created");
        root
    }

    fn write_safetensors(path: &Path, header: &str, data: &[u8]) {
        let mut encoded = Vec::with_capacity(8 + header.len() + data.len());
        encoded.extend_from_slice(&(header.len() as u64).to_le_bytes());
        encoded.extend_from_slice(header.as_bytes());
        encoded.extend_from_slice(data);
        fs::write(path, encoded).expect("test safetensors should be written");
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("test model parent should be created");
        }
        fs::write(path, bytes).expect("test model file should be written");
    }

    fn write_wan_package(root: &Path, directory_name: &str, num_layers: u64) -> PathBuf {
        let package = root.join("models").join(directory_name);
        write_file(
            &package.join("model_index.json"),
            br#"{"_class_name":"WanPipeline","expand_timesteps":true}"#,
        );
        write_file(
            &package.join("transformer/config.json"),
            format!(
                r#"{{"_class_name":"WanTransformer3DModel","in_channels":48,"out_channels":48,"num_layers":{num_layers},"num_attention_heads":24,"attention_head_dim":128,"text_dim":4096}}"#
            )
            .as_bytes(),
        );
        write_file(
            &package.join("text_encoder/model.safetensors.index.json"),
            br#"{"weight_map":{"encoder.weight":"model-00001-of-00001.safetensors"}}"#,
        );
        write_file(
            &package.join("transformer/diffusion_pytorch_model.safetensors.index.json"),
            br#"{"weight_map":{"transformer.weight":"diffusion_pytorch_model-00001-of-00001.safetensors"}}"#,
        );
        for relative in [
            "scheduler/scheduler_config.json",
            "text_encoder/config.json",
            "tokenizer/special_tokens_map.json",
            "tokenizer/spiece.model",
            "tokenizer/tokenizer.json",
            "tokenizer/tokenizer_config.json",
            "vae/config.json",
            "vae/diffusion_pytorch_model.safetensors",
            "text_encoder/model-00001-of-00001.safetensors",
            "transformer/diffusion_pytorch_model-00001-of-00001.safetensors",
        ] {
            write_file(&package.join(relative), b"test");
        }
        write_file(
            &package.join(".cache/huggingface/download/model_index.json.metadata"),
            format!("{WAN_MODEL_REVISION}\n0000000000000000000000000000000000000000\n0\n")
                .as_bytes(),
        );
        package
    }

    #[test]
    fn discovery_uses_tensor_content_and_isolates_malformed_artifacts() {
        let root = test_workspace();
        let models = root.join("models").join("misc");
        write_safetensors(
            &models.join("character-style.safetensors"),
            r#"{"emb_params":{"dtype":"F32","shape":[1,768],"data_offsets":[0,4]}}"#,
            &[0, 0, 0, 0],
        );
        fs::write(
            models.join("partially-downloaded.safetensors"),
            b"not-a-safetensors-file",
        )
        .expect("malformed test artifact should be written");

        let result = discover(root.to_string_lossy().as_ref())
            .expect("one malformed artifact must not abort discovery");
        let embedding = result
            .entries
            .iter()
            .find(|entry| entry.relative_path.ends_with("character-style.safetensors"))
            .expect("embedding should be discovered by tensor content");
        assert_eq!(embedding.kind, "model-addon");
        assert_eq!(embedding.status, "importable");
        assert_eq!(embedding.capabilities, vec!["textual-inversion"]);

        let malformed = result
            .entries
            .iter()
            .find(|entry| {
                entry
                    .relative_path
                    .ends_with("partially-downloaded.safetensors")
            })
            .expect("malformed artifact should remain discoverable");
        assert_eq!(malformed.status, "unsupported");
        assert!(malformed.diagnostic.contains("rest of the workspace"));

        fs::remove_dir_all(root).expect("test workspace should be removed");
    }

    #[test]
    fn renamed_wan_package_is_identified_by_pipeline_and_transformer_content() {
        let root = test_workspace();
        let package = write_wan_package(&root, "my-downloaded-video-model", 30);

        let result = discover(root.to_string_lossy().as_ref())
            .expect("renamed package should be discovered");
        let artifact = result
            .entries
            .iter()
            .find(|entry| entry.relative_path == "my-downloaded-video-model")
            .expect("renamed Wan package should remain visible");
        assert_eq!(artifact.status, "ready");
        assert_eq!(artifact.architecture.as_deref(), Some("wan-2.2-ti2v"));

        let resolved = resolve_workspace_diffusers_package(
            root.to_string_lossy().as_ref(),
            "wan-2.2-ti2v",
            Some("wan-2.2-ti2v-5b"),
        )
        .expect("the only compatible renamed package should resolve");
        assert_eq!(
            resolved,
            fs::canonicalize(&package).expect("test package should resolve")
        );

        fs::remove_dir_all(root).expect("test workspace should be removed");
    }

    #[test]
    fn a_different_wan_pipeline_variant_is_visible_but_not_executable() {
        let root = test_workspace();
        write_wan_package(&root, "wan-14b-or-future", 40);

        let result = discover(root.to_string_lossy().as_ref())
            .expect("incompatible package should not abort discovery");
        let artifact = result
            .entries
            .iter()
            .find(|entry| entry.relative_path == "wan-14b-or-future")
            .expect("incompatible Wan package should remain visible");
        assert_eq!(artifact.status, "incompatible");
        assert_eq!(artifact.architecture.as_deref(), Some("wan"));
        assert!(artifact.diagnostic.contains("does not match"));

        fs::remove_dir_all(root).expect("test workspace should be removed");
    }

    #[test]
    fn file_limit_stops_inside_one_large_directory() {
        let root = test_workspace();
        let models = root.join("models").join("misc");
        for index in 0..8 {
            write_file(
                &models.join(format!("partial-{index}.safetensors")),
                b"not-a-model",
            );
        }

        let result = discover_with_limits(root.to_string_lossy().as_ref(), 3, 12)
            .expect("bounded discovery should return partial results");
        assert!(result.truncated);
        assert!(result.entries.len() <= 3);
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("stopped at 3 files")));

        fs::remove_dir_all(root).expect("test workspace should be removed");
    }

    #[test]
    fn recognized_package_inventories_share_the_global_file_budget() {
        let root = test_workspace();
        for package_name in ["diffusers-a", "diffusers-b"] {
            let package = root.join("models").join(package_name);
            write_file(&package.join("model_index.json"), b"{invalid-json");
            write_file(&package.join("weights.bin"), b"weights");
        }

        let result = discover_with_limits(root.to_string_lossy().as_ref(), 3, 12)
            .expect("bounded package discovery should return partial results");
        assert!(result.truncated);
        assert_eq!(result.entries.len(), 2);
        assert!(
            result
                .entries
                .iter()
                .map(|entry| entry.file_count as usize)
                .sum::<usize>()
                <= 3
        );
        assert!(result
            .entries
            .iter()
            .any(|entry| entry.diagnostic.contains("bounded discovery budget")));
        assert!(result
            .warnings
            .iter()
            .any(|warning| warning.contains("stopped at 3 files")));

        fs::remove_dir_all(root).expect("test workspace should be removed");
    }

    #[test]
    fn repeated_package_errors_are_bounded_and_summarized() {
        let mut warnings = Vec::new();
        for index in 0..(MAX_WARNINGS + 3) {
            push_warning(&mut warnings, format!("invalid package {index}"));
        }

        let warnings = finalize_warnings(warnings, false, 1_000, 12);
        assert_eq!(warnings.len(), MAX_WARNINGS + 1);
        assert!(warnings
            .last()
            .is_some_and(|warning| warning.contains("warnings were omitted")));
    }
}
