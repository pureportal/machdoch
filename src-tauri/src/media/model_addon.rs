use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

use rusqlite::{params, OptionalExtension as _};
use serde_json::Value;
use sha2::{Digest as _, Sha256};

use super::{
    database, hardware,
    model_import::{self, ParsedSafetensorsHeader},
    ImportMediaModelAddonRequest, MediaEmbeddingVectorProfile, MediaLoraTensorProfile,
    MediaModelAddonCapability, MediaModelAddonImportInspection, MediaModelAddonImportResult,
    MediaResult, MediaRuntimePaths,
};

pub(crate) const MODEL_ADDON_ID_PREFIX: &str = "local-addon:sha256:";

const MAX_TRIGGER_WORDS: usize = 32;
const MAX_TOKEN_CHARS: usize = 128;
const MAX_EMBEDDING_VECTORS: u32 = 512;
const MAX_EMBEDDING_DIMENSION: u32 = 16_384;
const MAX_LORA_RANK: u32 = 4_096;
const LORA_TENSOR_PAIRS: &[(&str, &str)] = &[
    (".lora_down.weight", ".lora_up.weight"),
    (".lora_a.weight", ".lora_b.weight"),
    (".lora_a.default.weight", ".lora_b.default.weight"),
    (".lora_down.default.weight", ".lora_up.default.weight"),
];
const LORA_MAGNITUDE_SUFFIXES: &[&str] = &[
    ".dora_scale",
    ".dora_scale.weight",
    ".lora_magnitude_vector",
    ".lora_magnitude_vector.weight",
    ".lora_magnitude_vector.default.weight",
];

pub(crate) fn capabilities_for_model(
    provider_id: &str,
    architecture: Option<&str>,
) -> Vec<MediaModelAddonCapability> {
    if provider_id != "local-diffusers" {
        return Vec::new();
    }
    match architecture {
        Some("stable-diffusion-1" | "stable-diffusion-2") => vec![
            MediaModelAddonCapability {
                kind: "lora".to_string(),
                target_components: vec!["denoiser".to_string(), "text-encoder".to_string()],
                max_active: 8,
                supports_separate_component_strengths: true,
                supports_denoising_schedules: true,
            },
            MediaModelAddonCapability {
                kind: "textual-inversion".to_string(),
                target_components: vec!["text-encoder".to_string()],
                max_active: 16,
                supports_separate_component_strengths: false,
                supports_denoising_schedules: false,
            },
        ],
        Some("stable-diffusion-xl") => vec![
            MediaModelAddonCapability {
                kind: "lora".to_string(),
                target_components: vec![
                    "denoiser".to_string(),
                    "text-encoder".to_string(),
                    "text-encoder-2".to_string(),
                ],
                max_active: 8,
                supports_separate_component_strengths: true,
                supports_denoising_schedules: true,
            },
            MediaModelAddonCapability {
                kind: "textual-inversion".to_string(),
                target_components: vec!["text-encoder".to_string(), "text-encoder-2".to_string()],
                max_active: 16,
                supports_separate_component_strengths: false,
                supports_denoising_schedules: false,
            },
        ],
        Some("stable-diffusion-3" | "flux-2") => vec![MediaModelAddonCapability {
            kind: "lora".to_string(),
            target_components: vec!["denoiser".to_string()],
            max_active: 8,
            supports_separate_component_strengths: false,
            supports_denoising_schedules: true,
        }],
        Some("flux-1") => vec![
            MediaModelAddonCapability {
                kind: "lora".to_string(),
                target_components: vec!["denoiser".to_string(), "text-encoder".to_string()],
                max_active: 8,
                supports_separate_component_strengths: true,
                supports_denoising_schedules: true,
            },
            MediaModelAddonCapability {
                kind: "textual-inversion".to_string(),
                target_components: vec!["text-encoder".to_string(), "text-encoder-2".to_string()],
                max_active: 16,
                supports_separate_component_strengths: false,
                supports_denoising_schedules: false,
            },
        ],
        _ => Vec::new(),
    }
}

fn tensor_rank(header: &ParsedSafetensorsHeader, key: &str) -> Option<usize> {
    header
        .tensor_shapes
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::len)
}

fn tensor_last_dimension(header: &ParsedSafetensorsHeader, key: &str) -> Option<u64> {
    header
        .tensor_shapes
        .get(key)
        .and_then(Value::as_array)
        .and_then(|shape| shape.last())
        .and_then(Value::as_u64)
}

fn has_lora_pair(header: &ParsedSafetensorsHeader) -> bool {
    let keys = header
        .tensor_keys
        .iter()
        .map(|key| key.to_lowercase())
        .collect::<HashSet<_>>();
    keys.iter().any(|key| {
        LORA_TENSOR_PAIRS.iter().any(|(left, right)| {
            key.strip_suffix(left)
                .map(|stem| keys.contains(&format!("{stem}{right}")))
                .unwrap_or(false)
        })
    })
}

fn unsupported_lora_algorithm(
    header: &ParsedSafetensorsHeader,
) -> Option<(&'static str, &'static str)> {
    let keys = header
        .tensor_keys
        .iter()
        .map(|key| key.to_lowercase())
        .collect::<Vec<_>>();
    if keys.iter().any(|key| {
        key.contains("hada_w1_a")
            || key.contains("hada_w1_b")
            || key.contains("hada_w2_a")
            || key.contains(".hada_")
    }) {
        return Some(("LoHa", "Hadamard-product adapters"));
    }
    if keys.iter().any(|key| {
        key.contains("lokr_w1")
            || key.contains("lokr_w2")
            || key.contains("lokr_t2")
            || key.contains(".lokr_")
    }) {
        return Some(("LoKr", "Kronecker-product adapters"));
    }
    if keys
        .iter()
        .any(|key| key.contains("oft_blocks") || key.contains("oft_diag") || key.contains(".oft_"))
    {
        return Some(("OFT", "orthogonal fine-tuning adapters"));
    }
    if keys.iter().any(|key| key.ends_with(".lora_mid.weight")) {
        return Some(("CP-decomposed LoCon", "LoCon tensors with lora_mid weights"));
    }
    None
}

fn has_lora_signature(header: &ParsedSafetensorsHeader) -> bool {
    has_lora_pair(header)
        || unsupported_lora_algorithm(header).is_some()
        || header.tensor_keys.iter().any(|key| {
            let key = key.to_lowercase();
            LORA_TENSOR_PAIRS
                .iter()
                .any(|(left, right)| key.ends_with(left) || key.ends_with(right))
                || LORA_MAGNITUDE_SUFFIXES
                    .iter()
                    .any(|suffix| key.ends_with(suffix))
        })
}

fn lora_tensor_shape(header: &ParsedSafetensorsHeader, tensor_key: &str) -> MediaResult<Vec<u64>> {
    let shape = header
        .tensor_shapes
        .get(tensor_key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("LoRA tensor {tensor_key} has no valid shape"))?
        .iter()
        .map(|dimension| {
            dimension
                .as_u64()
                .filter(|dimension| *dimension > 0)
                .ok_or_else(|| format!("LoRA tensor {tensor_key} has an invalid shape"))
        })
        .collect::<MediaResult<Vec<_>>>()?;
    if !matches!(shape.len(), 2 | 4) {
        return Err(format!(
            "LoRA tensor {tensor_key} must be a linear [out, in] or convolutional [out, in, height, width] matrix"
        ));
    }
    Ok(shape)
}

fn lora_component_for_key(key: &str) -> &'static str {
    if key.contains("text_encoder_2") || key.contains("lora_te2") {
        "text-encoder-2"
    } else if key.contains("text_encoder") || key.contains("lora_te") {
        "text-encoder"
    } else {
        "denoiser"
    }
}

fn lora_tensor_profile(header: &ParsedSafetensorsHeader) -> MediaResult<MediaLoraTensorProfile> {
    if let Some((algorithm, description)) = unsupported_lora_algorithm(header) {
        return Err(format!(
            "This file contains {algorithm} ({description}), which the pinned Diffusers runner does not safely support. Convert or export it as standard LoRA/LoCon/DoRA safetensors before importing."
        ));
    }

    let lower_to_original = header
        .tensor_keys
        .iter()
        .map(|key| (key.to_lowercase(), key.as_str()))
        .collect::<HashMap<_, _>>();
    if lower_to_original.len() != header.tensor_keys.len() {
        return Err("LoRA tensor keys collide when compared case-insensitively".to_string());
    }
    let magnitude_stems = lower_to_original
        .keys()
        .filter_map(|key| {
            LORA_MAGNITUDE_SUFFIXES
                .iter()
                .find_map(|suffix| key.strip_suffix(suffix))
        })
        .collect::<HashSet<_>>();
    let alpha_stems = lower_to_original
        .keys()
        .filter_map(|key| key.strip_suffix(".alpha"))
        .collect::<HashSet<_>>();
    let mut paired_stems = HashSet::new();
    let mut ranks = Vec::new();
    let mut dialects = HashSet::new();
    let mut convolution_target_count = 0_u32;
    let mut component_counts = HashMap::<&str, (u32, u32)>::new();

    for (lower_key, original_key) in &lower_to_original {
        let Some((left_suffix, right_suffix, stem)) =
            LORA_TENSOR_PAIRS.iter().find_map(|(left, right)| {
                lower_key
                    .strip_suffix(left)
                    .map(|stem| (*left, *right, stem))
            })
        else {
            continue;
        };
        let right_key = format!("{stem}{right_suffix}");
        let right_original = lower_to_original.get(&right_key).ok_or_else(|| {
            format!("LoRA tensor {original_key} has no matching {right_suffix} tensor")
        })?;
        paired_stems.insert(stem);
        let down_shape = lora_tensor_shape(header, original_key)?;
        let up_shape = lora_tensor_shape(header, right_original)?;
        let down_rank = down_shape[0];
        let up_rank = up_shape[1];
        if down_rank != up_rank || down_rank > u64::from(MAX_LORA_RANK) {
            return Err(format!(
                "LoRA module {stem} has incompatible or unsupported ranks ({down_rank} down, {up_rank} up; maximum {MAX_LORA_RANK})"
            ));
        }
        ranks.push(u32::try_from(down_rank).unwrap_or(u32::MAX));
        if down_shape.len() == 4 || up_shape.len() == 4 {
            convolution_target_count = convolution_target_count.saturating_add(1);
        }
        let dialect = if left_suffix.contains("lora_a") {
            "diffusers-peft"
        } else if stem.starts_with("lora_unet_")
            || stem.starts_with("lora_te_")
            || stem.starts_with("lora_te1_")
            || stem.starts_with("lora_te2_")
            || stem.starts_with("lora_transformer_")
        {
            "kohya"
        } else {
            "generic"
        };
        dialects.insert(dialect);
        let component = lora_component_for_key(lower_key);
        let counts = component_counts.entry(component).or_default();
        counts.0 = counts.0.saturating_add(1);
        if magnitude_stems.contains(stem) {
            counts.1 = counts.1.saturating_add(1);
        }
    }

    for lower_key in lower_to_original.keys() {
        for (left_suffix, right_suffix) in LORA_TENSOR_PAIRS {
            if let Some(stem) = lower_key.strip_suffix(right_suffix) {
                if !lower_to_original.contains_key(&format!("{stem}{left_suffix}")) {
                    return Err(format!(
                        "LoRA tensor {lower_key} has no matching {left_suffix} tensor"
                    ));
                }
            }
        }
    }
    if paired_stems.is_empty() {
        return Err("No complete standard LoRA tensor pairs were found".to_string());
    }
    if let Some(stem) = magnitude_stems
        .iter()
        .find(|stem| !paired_stems.contains(**stem))
    {
        return Err(format!(
            "DoRA magnitude tensor for {stem} has no matching LoRA matrix pair"
        ));
    }
    if let Some(stem) = alpha_stems
        .iter()
        .find(|stem| !paired_stems.contains(**stem))
    {
        return Err(format!(
            "LoRA network alpha tensor for {stem} has no matching matrix pair"
        ));
    }
    for stem in &alpha_stems {
        let tensor_key = lower_to_original
            .get(&format!("{stem}.alpha"))
            .expect("known LoRA alpha tensor");
        let shape = header
            .tensor_shapes
            .get(*tensor_key)
            .and_then(Value::as_array)
            .ok_or_else(|| format!("LoRA network alpha {tensor_key} has no valid shape"))?;
        if !(shape.is_empty()
            || (shape.len() == 1 && shape[0].as_u64().is_some_and(|value| value == 1)))
        {
            return Err(format!(
                "LoRA network alpha {tensor_key} must be a scalar tensor"
            ));
        }
    }
    if component_counts
        .iter()
        .any(|(_, (module_count, magnitude_count))| {
            *magnitude_count > 0 && magnitude_count != module_count
        })
    {
        return Err(
            "DoRA magnitude vectors must cover every adapted module within each target component"
                .to_string(),
        );
    }
    if dialects.len() != 1 {
        return Err("Mixed LoRA tensor dialects are not supported in one add-on".to_string());
    }
    ranks.sort_unstable();
    let rank_minimum = ranks[0];
    let rank_maximum = *ranks.last().expect("non-empty LoRA ranks");
    let magnitude_vector_count = u32::try_from(magnitude_stems.len()).unwrap_or(u32::MAX);
    let algorithm = if magnitude_vector_count > 0 {
        "dora"
    } else if convolution_target_count > 0 {
        "locon"
    } else {
        "lora"
    };
    Ok(MediaLoraTensorProfile {
        algorithm: algorithm.to_string(),
        dialect: (*dialects.iter().next().expect("one LoRA dialect")).to_string(),
        rank_minimum,
        rank_maximum,
        heterogeneous_ranks: rank_minimum != rank_maximum,
        target_module_count: u32::try_from(paired_stems.len()).unwrap_or(u32::MAX),
        convolution_target_count,
        magnitude_vector_count,
        network_alpha_count: u32::try_from(alpha_stems.len()).unwrap_or(u32::MAX),
    })
}

fn looks_like_textual_inversion(header: &ParsedSafetensorsHeader) -> bool {
    let metadata = model_import::metadata_text(header);
    let has_known_marker = metadata.contains("textual inversion")
        || metadata.contains("textual_inversion")
        || header.tensor_keys.iter().any(|key| {
            let key = key.to_lowercase();
            key == "emb_params"
                || key == "clip_l"
                || key == "clip_g"
                || key == "t5"
                || key.starts_with("string_to_param")
                || key.starts_with("string_to_token")
        });
    let compact_embedding_inventory = header.tensor_count <= 16
        && header.tensor_keys.iter().all(|key| {
            matches!(tensor_rank(header, key), Some(1 | 2))
                && tensor_last_dimension(header, key).unwrap_or(0) >= 64
        });
    has_known_marker || compact_embedding_inventory
}

fn detect_kind(header: &ParsedSafetensorsHeader) -> Option<&'static str> {
    if has_lora_signature(header) {
        Some("lora")
    } else if looks_like_textual_inversion(header) {
        Some("textual-inversion")
    } else {
        None
    }
}

fn detected_target_components(header: &ParsedSafetensorsHeader, kind: &str) -> Vec<String> {
    let keys = header
        .tensor_keys
        .iter()
        .map(|key| key.to_lowercase())
        .collect::<Vec<_>>();
    let mut components = Vec::new();
    let has_second_encoder = keys.iter().any(|key| {
        key.contains("text_encoder_2") || key.contains("lora_te2") || key == "clip_g" || key == "t5"
    });
    let has_explicit_text_encoder = keys.iter().any(|key| {
        key.contains("text_encoder")
            || key.contains("lora_te")
            || key == "clip_l"
            || key == "emb_params"
            || key.starts_with("string_to_param")
    });
    let has_text_encoder =
        has_explicit_text_encoder || (kind == "textual-inversion" && !has_second_encoder);
    let has_denoiser = kind == "lora"
        && keys.iter().any(|key| {
            key.contains("lora_unet")
                || key.contains("transformer")
                || key.contains("diffusion_model")
                || key.starts_with("unet.")
        });
    if has_denoiser || (kind == "lora" && !has_text_encoder) {
        components.push("denoiser".to_string());
    }
    if has_text_encoder {
        components.push("text-encoder".to_string());
    }
    if has_second_encoder {
        components.push("text-encoder-2".to_string());
    }
    components
}

fn embedding_profile_for_tensor(
    header: &ParsedSafetensorsHeader,
    tensor_key: &str,
    component: &str,
) -> MediaResult<MediaEmbeddingVectorProfile> {
    let shape = header
        .tensor_shapes
        .get(tensor_key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("embedding tensor {tensor_key} has no valid shape"))?;
    let (vector_count, dimension) = match shape.as_slice() {
        [dimension] => (1_u64, dimension.as_u64()),
        [vector_count, dimension] => (vector_count.as_u64().unwrap_or(0), dimension.as_u64()),
        _ => {
            return Err(format!(
                "embedding tensor {tensor_key} must have shape [dimension] or [vectors, dimension]"
            ))
        }
    };
    let dimension = dimension.unwrap_or(0);
    let vector_count = u32::try_from(vector_count).unwrap_or(u32::MAX);
    let dimension = u32::try_from(dimension).unwrap_or(u32::MAX);
    if vector_count == 0 || vector_count > MAX_EMBEDDING_VECTORS {
        return Err(format!(
            "embedding tensor {tensor_key} contains an unsupported vector count ({vector_count}; expected 1-{MAX_EMBEDDING_VECTORS})"
        ));
    }
    if !(64..=MAX_EMBEDDING_DIMENSION).contains(&dimension) {
        return Err(format!(
            "embedding tensor {tensor_key} has an unsupported width ({dimension}; expected 64-{MAX_EMBEDDING_DIMENSION})"
        ));
    }
    Ok(MediaEmbeddingVectorProfile {
        component: component.to_string(),
        tensor_key: tensor_key.to_string(),
        vector_count,
        dimension,
    })
}

fn embedding_vector_profiles(
    header: &ParsedSafetensorsHeader,
) -> MediaResult<Vec<MediaEmbeddingVectorProfile>> {
    let explicit = [
        ("clip_l", "text-encoder"),
        ("clip_g", "text-encoder-2"),
        ("t5", "text-encoder-2"),
    ]
    .into_iter()
    .filter(|(key, _)| header.tensor_shapes.contains_key(*key))
    .collect::<Vec<_>>();
    if !explicit.is_empty() {
        let mut components = HashSet::new();
        let mut profiles = Vec::with_capacity(explicit.len());
        for (tensor_key, component) in explicit {
            if !components.insert(component) {
                return Err(
                    "the embedding maps multiple tensors to the same text-encoder slot".to_string(),
                );
            }
            profiles.push(embedding_profile_for_tensor(header, tensor_key, component)?);
        }
        return Ok(profiles);
    }

    let candidate_keys = if header.tensor_shapes.contains_key("emb_params") {
        vec!["emb_params".to_string()]
    } else {
        let string_to_param = header
            .tensor_keys
            .iter()
            .filter(|key| key.to_lowercase().starts_with("string_to_param"))
            .cloned()
            .collect::<Vec<_>>();
        if string_to_param.is_empty() {
            header
                .tensor_keys
                .iter()
                .filter(|key| {
                    matches!(tensor_rank(header, key), Some(1 | 2))
                        && tensor_last_dimension(header, key).unwrap_or(0) >= 64
                })
                .cloned()
                .collect::<Vec<_>>()
        } else {
            string_to_param
        }
    };
    if candidate_keys.len() != 1 {
        return Err(
            "the embedding must contain one unambiguous tensor, or explicit clip_l/clip_g/t5 encoder tensors"
                .to_string(),
        );
    }
    Ok(vec![embedding_profile_for_tensor(
        header,
        &candidate_keys[0],
        "text-encoder",
    )?])
}

fn detect_embedding_architecture(
    header: &ParsedSafetensorsHeader,
) -> (Option<String>, &'static str) {
    let dimensions = header
        .tensor_keys
        .iter()
        .filter_map(|key| tensor_last_dimension(header, key))
        .collect::<HashSet<_>>();
    let keys = header
        .tensor_keys
        .iter()
        .map(|key| key.to_lowercase())
        .collect::<Vec<_>>();
    if keys.iter().any(|key| key == "t5") {
        return (Some("flux-1".to_string()), "medium");
    }
    if keys.iter().any(|key| key == "clip_l" || key == "clip_g") {
        return (Some("stable-diffusion-xl".to_string()), "medium");
    }
    if dimensions.contains(&768) && dimensions.contains(&1280) {
        return (Some("stable-diffusion-xl".to_string()), "medium");
    }
    if dimensions.len() == 1 && dimensions.contains(&1024) {
        return (Some("stable-diffusion-2".to_string()), "medium");
    }
    if dimensions.len() == 1 && dimensions.contains(&768) {
        return (Some("stable-diffusion-1".to_string()), "medium");
    }
    (None, "unknown")
}

fn detect_addon_architecture(
    header: &ParsedSafetensorsHeader,
    kind: Option<&str>,
) -> (Option<String>, &'static str) {
    let detected = model_import::detect_architecture(header);
    if detected.0.is_some() {
        return detected;
    }
    let keys = header
        .tensor_keys
        .iter()
        .map(|key| key.to_lowercase())
        .collect::<Vec<_>>();
    if keys
        .iter()
        .any(|key| key.contains("double_blocks") || key.contains("single_blocks"))
    {
        return (Some("flux-1".to_string()), "medium");
    }
    if kind == Some("textual-inversion") {
        return detect_embedding_architecture(header);
    }
    (None, "unknown")
}

fn bounded_metadata_value(
    header: &ParsedSafetensorsHeader,
    keys: &[&str],
    maximum_chars: usize,
) -> Option<String> {
    keys.iter().find_map(|key| {
        let value = header.metadata.get(*key)?.as_str()?.trim();
        if value.is_empty() {
            return None;
        }
        Some(value.chars().take(maximum_chars).collect())
    })
}

fn base_model_hint(header: &ParsedSafetensorsHeader) -> Option<String> {
    bounded_metadata_value(
        header,
        &[
            "modelspec.base_model",
            "base_model",
            "ss_sd_model_name",
            "ss_base_model_version",
        ],
        256,
    )
}

fn parse_trigger_words(header: &ParsedSafetensorsHeader) -> Vec<String> {
    let Some(value) = bounded_metadata_value(
        header,
        &[
            "modelspec.trigger_words",
            "trigger_words",
            "trainedWords",
            "ss_trigger_words",
        ],
        2_048,
    ) else {
        return Vec::new();
    };
    let parsed = serde_json::from_str::<Value>(&value).ok();
    let candidates = match parsed {
        Some(Value::Array(values)) => values
            .into_iter()
            .filter_map(|entry| entry.as_str().map(ToOwned::to_owned))
            .collect::<Vec<_>>(),
        _ => value
            .split([',', '\n'])
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>(),
    };
    normalize_trigger_words(&candidates).unwrap_or_default()
}

fn suggested_token(header: &ParsedSafetensorsHeader, kind: Option<&str>) -> Option<String> {
    if kind != Some("textual-inversion") {
        return None;
    }
    if let Some(token) = bounded_metadata_value(
        header,
        &["token", "placeholder_token", "modelspec.trigger_phrase"],
        MAX_TOKEN_CHARS,
    ) {
        return validated_token(Some(&token)).ok().flatten();
    }
    header.tensor_keys.iter().find_map(|key| {
        let candidate = key
            .strip_prefix("string_to_param.")
            .or_else(|| key.strip_prefix("string_to_token."))
            .unwrap_or(key);
        if matches!(candidate, "emb_params" | "clip_l" | "clip_g" | "t5") {
            return None;
        }
        validated_token(Some(candidate)).ok().flatten()
    })
}

fn inspection_review_token(
    header: &ParsedSafetensorsHeader,
    kind: Option<&str>,
    architecture: Option<&str>,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-model-addon-import-review-v1\0");
    for value in [
        header.canonical_path.to_string_lossy().as_ref(),
        &header.byte_size.to_string(),
        &header.modified_marker,
        &header.header_digest,
        &header.tensor_count.to_string(),
        kind.unwrap_or("unknown"),
        architecture.unwrap_or("unknown"),
    ] {
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

pub(crate) fn inspect(source_path: &str) -> MediaResult<MediaModelAddonImportInspection> {
    let header = model_import::parse_header(source_path)?;
    let detected_kind = detect_kind(&header);
    let (detected_architecture, architecture_confidence) =
        detect_addon_architecture(&header, detected_kind);
    let embedding_vectors = if detected_kind == Some("textual-inversion") {
        embedding_vector_profiles(&header)
    } else {
        Ok(Vec::new())
    };
    let lora_profile = if detected_kind == Some("lora") {
        lora_tensor_profile(&header).map(Some)
    } else {
        Ok(None)
    };
    let target_components = match &embedding_vectors {
        Ok(profiles) if !profiles.is_empty() => profiles
            .iter()
            .map(|profile| profile.component.clone())
            .collect(),
        _ => detected_kind
            .map(|kind| detected_target_components(&header, kind))
            .unwrap_or_default(),
    };
    let blocking_reason = if detected_kind.is_none() {
        Some(
            "This safetensors file is not recognized as a LoRA or textual-inversion embedding. Import complete checkpoints with Import checkpoint instead."
                .to_string(),
        )
    } else {
        embedding_vectors
            .as_ref()
            .err()
            .or_else(|| lora_profile.as_ref().err())
            .cloned()
    };
    let embedding_vectors = embedding_vectors.unwrap_or_default();
    let lora_profile = lora_profile.unwrap_or(None);
    let mut warnings = vec![
        "Only the data-only safetensors header was inspected; no model code or repository script was executed."
            .to_string(),
        "Architecture detection is advisory. Confirm the exact base family on the publisher page before importing."
            .to_string(),
        "Compatibility is checked again against the selected provider, model architecture, and target components before a run can start."
            .to_string(),
    ];
    if detected_architecture.is_none() {
        warnings.push(
            "The base architecture was not encoded in the file; select it only when the publisher explicitly documents it."
                .to_string(),
        );
    }
    if detected_kind == Some("textual-inversion") {
        warnings.push(
            "Pickle-based .pt/.bin embeddings are intentionally unsupported; re-export them as safetensors in a trusted environment."
                .to_string(),
        );
        if !embedding_vectors.is_empty() {
            warnings.push(
                "The exact encoder slot, tensor key, vector count, and embedding width will be verified again after runtime loading."
                    .to_string(),
            );
        }
    }
    if detected_kind == Some("lora") && lora_profile.is_some() {
        warnings.push(
            "The LoRA algorithm, tensor dialect, ranks, convolution targets, and DoRA magnitude-vector coverage will be verified again before runtime loading."
                .to_string(),
        );
    }
    Ok(MediaModelAddonImportInspection {
        schema_version: 1,
        can_import: blocking_reason.is_none(),
        blocking_reason,
        source_path: header.canonical_path.to_string_lossy().into_owned(),
        source_file_name: header.source_file_name.clone(),
        byte_size: header.byte_size,
        tensor_count: header.tensor_count,
        header_digest: header.header_digest.clone(),
        review_token: inspection_review_token(
            &header,
            detected_kind,
            detected_architecture.as_deref(),
        ),
        suggested_display_name: model_import::suggested_display_name(&header),
        detected_kind: detected_kind.map(ToOwned::to_owned),
        detected_architecture,
        architecture_confidence: architecture_confidence.to_string(),
        target_components,
        embedding_vectors,
        lora_profile,
        base_model_hint: base_model_hint(&header),
        suggested_trigger_words: parse_trigger_words(&header),
        suggested_token: suggested_token(&header, detected_kind),
        metadata_summary: model_import::metadata_summary(&header),
        warnings,
    })
}

fn validated_token(value: Option<&str>) -> MediaResult<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if value.chars().count() > MAX_TOKEN_CHARS
        || value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
    {
        return Err(
            "token must be a single non-empty token no longer than 128 characters".to_string(),
        );
    }
    Ok(Some(value.to_string()))
}

fn normalize_trigger_words(values: &[String]) -> MediaResult<Vec<String>> {
    if values.len() > MAX_TRIGGER_WORDS {
        return Err(format!(
            "triggerWords cannot contain more than {MAX_TRIGGER_WORDS} entries"
        ));
    }
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        if value.chars().count() > MAX_TOKEN_CHARS
            || value.chars().any(|character| character.is_control())
        {
            return Err(
                "each trigger word must be no longer than 128 characters and contain no control characters"
                    .to_string(),
            );
        }
        if seen.insert(value.to_lowercase()) {
            normalized.push(value.to_string());
        }
    }
    Ok(normalized)
}

fn validate_request(
    request: &ImportMediaModelAddonRequest,
    inspection: &MediaModelAddonImportInspection,
) -> MediaResult<(String, String, Vec<String>, Option<String>, Option<String>)> {
    if !request.confirm_rights {
        return Err(
            "confirmRights is required after reviewing the add-on source and license".to_string(),
        );
    }
    if !matches!(request.kind.as_str(), "lora" | "textual-inversion") {
        return Err("kind must be lora or textual-inversion".to_string());
    }
    if inspection.detected_kind.as_deref() != Some(request.kind.as_str()) {
        return Err("the selected add-on kind does not match the inspected tensors".to_string());
    }
    if request.kind == "textual-inversion"
        && inspection.detected_architecture.as_deref().is_some()
        && inspection.detected_architecture.as_deref() != Some(request.architecture.as_str())
    {
        return Err(
            "the selected architecture does not match the embedding tensor dimensions and encoder slots"
                .to_string(),
        );
    }
    if !model_import::SUPPORTED_ARCHITECTURES.contains(&request.architecture.as_str()) {
        return Err("architecture is not a supported SD or FLUX family".to_string());
    }
    let capability = capabilities_for_model("local-diffusers", Some(&request.architecture))
        .into_iter()
        .find(|candidate| candidate.kind == request.kind)
        .ok_or_else(|| {
            format!(
                "{} does not support {} add-ons in the managed runtime",
                request.architecture, request.kind
            )
        })?;
    if inspection
        .target_components
        .iter()
        .any(|component| !capability.target_components.contains(component))
    {
        return Err(
            "the add-on targets model components that are incompatible with the selected architecture"
                .to_string(),
        );
    }
    if !matches!(
        request.commercial_use.as_str(),
        "allowed" | "review-required"
    ) {
        return Err("commercialUse must be allowed or review-required".to_string());
    }
    let display_name = model_import::validated_text("displayName", &request.display_name, 120)?;
    let license_name = model_import::validated_text("licenseName", &request.license_name, 256)?;
    let source_url = model_import::validated_source_url(request.source_url.as_deref())?;
    let trigger_words = normalize_trigger_words(&request.trigger_words)?;
    let token = validated_token(request.token.as_deref())?;
    if request.kind == "textual-inversion" && token.is_none() {
        return Err("token is required for textual-inversion embeddings".to_string());
    }
    if request.kind == "lora" && token.is_some() {
        return Err("token is only valid for textual-inversion embeddings".to_string());
    }
    Ok((display_name, license_name, trigger_words, token, source_url))
}

fn stored_addon_exists(paths: &MediaRuntimePaths, digest: &str) -> MediaResult<bool> {
    database::open(paths)?
        .query_row(
            "SELECT 1 FROM media_model_addons WHERE digest = ?1",
            params![digest],
            |_| Ok(true),
        )
        .optional()
        .map(|value| value.unwrap_or(false))
        .map_err(|error| format!("failed to inspect imported model add-on state: {error}"))
}

#[derive(Debug, Clone)]
struct ManagedAddonRemoval {
    id: String,
    display_name: String,
    kind: String,
    digest: String,
    byte_size: u64,
    relative_path: String,
}

fn managed_addon_for_removal(
    paths: &MediaRuntimePaths,
    addon_id: &str,
) -> MediaResult<ManagedAddonRemoval> {
    let addon_id = addon_id.trim();
    if addon_id.is_empty() || addon_id.chars().count() > 256 {
        return Err("addonId must contain 1 to 256 characters".to_string());
    }
    database::open(paths)?
        .query_row(
            "SELECT id, display_name, kind, digest, byte_size, relative_path
             FROM media_model_addons WHERE id = ?1",
            params![addon_id],
            |row| {
                Ok(ManagedAddonRemoval {
                    id: row.get(0)?,
                    display_name: row.get(1)?,
                    kind: row.get(2)?,
                    digest: row.get(3)?,
                    byte_size: row.get::<_, i64>(4)?.max(0) as u64,
                    relative_path: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("failed to inspect model add-on removal state: {error}"))?
        .ok_or_else(|| "the model add-on is not installed".to_string())
}

fn value_references_addon(value: &Value, addon_id: &str) -> bool {
    match value {
        Value::Array(values) => values
            .iter()
            .any(|value| value_references_addon(value, addon_id)),
        Value::Object(values) => {
            values.get("addonId").and_then(Value::as_str) == Some(addon_id)
                || values
                    .values()
                    .any(|value| value_references_addon(value, addon_id))
        }
        _ => false,
    }
}

fn referenced_runs(paths: &MediaRuntimePaths, addon_id: &str) -> MediaResult<(Vec<String>, u32)> {
    let connection = database::open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT id, status, plan_snapshot_json FROM runs
             WHERE plan_snapshot_json IS NOT NULL ORDER BY created_at DESC",
        )
        .map_err(|error| format!("failed to prepare add-on run dependencies: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("failed to inspect add-on run dependencies: {error}"))?;
    let mut blocking = Vec::new();
    let mut historical = 0_u32;
    for row in rows {
        let (run_id, status, snapshot_json) =
            row.map_err(|error| format!("failed to read add-on run dependency: {error}"))?;
        let snapshot = serde_json::from_str::<Value>(&snapshot_json)
            .map_err(|error| format!("failed to decode add-on run dependency: {error}"))?;
        if !value_references_addon(&snapshot, addon_id) {
            continue;
        }
        if matches!(status.as_str(), "queued" | "running" | "canceling") {
            blocking.push(run_id);
        } else {
            historical = historical.saturating_add(1);
        }
    }
    blocking.sort();
    Ok((blocking, historical))
}

fn referenced_flows(paths: &MediaRuntimePaths, addon_id: &str) -> MediaResult<Vec<String>> {
    let connection = database::open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT f.id, r.flow_json FROM flows f
             JOIN flow_revisions r ON r.revision_id = f.head_revision_id
             ORDER BY f.id",
        )
        .map_err(|error| format!("failed to prepare add-on flow dependencies: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("failed to inspect add-on flow dependencies: {error}"))?;
    let mut flows = Vec::new();
    for row in rows {
        let (flow_id, flow_json) =
            row.map_err(|error| format!("failed to read add-on flow dependency: {error}"))?;
        let flow = serde_json::from_str::<Value>(&flow_json)
            .map_err(|error| format!("failed to decode add-on flow dependency: {error}"))?;
        if value_references_addon(&flow, addon_id) {
            flows.push(flow_id);
        }
    }
    Ok(flows)
}

fn removal_confirmation_token(
    addon: &ManagedAddonRemoval,
    blocking_run_ids: &[String],
    saved_flow_ids: &[String],
    historical_run_count: u32,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-model-addon-removal-v1\0");
    for value in [
        addon.id.as_str(),
        addon.digest.as_str(),
        addon.relative_path.as_str(),
        &addon.byte_size.to_string(),
        &blocking_run_ids.join("\u{1f}"),
        &saved_flow_ids.join("\u{1f}"),
        &historical_run_count.to_string(),
    ] {
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    format!("{:x}", hasher.finalize())
}

pub(crate) fn plan_removal(
    paths: &MediaRuntimePaths,
    addon_id: &str,
) -> MediaResult<super::MediaModelAddonRemovalPlan> {
    let addon = managed_addon_for_removal(paths, addon_id)?;
    let (blocking_run_ids, historical_run_count) = referenced_runs(paths, &addon.id)?;
    let saved_flow_ids = referenced_flows(paths, &addon.id)?;
    let confirmation_token = removal_confirmation_token(
        &addon,
        &blocking_run_ids,
        &saved_flow_ids,
        historical_run_count,
    );
    let blocking_run_count = blocking_run_ids.len().min(u32::MAX as usize) as u32;
    let saved_flow_count = saved_flow_ids.len().min(u32::MAX as usize) as u32;
    let mut warnings = vec![
        "Historical run provenance is retained after the managed add-on bytes are removed."
            .to_string(),
        "Removal is journaled and the immutable add-on directory is detached before cleanup."
            .to_string(),
    ];
    if saved_flow_count > 0 {
        warnings.push(format!(
            "{saved_flow_count} saved flow(s) will keep their add-on selection but fail preflight until this exact digest is imported again."
        ));
    }
    if blocking_run_count > 0 {
        warnings.push(format!(
            "{blocking_run_count} active run(s) still reference this add-on and must finish or be canceled first."
        ));
    }
    Ok(super::MediaModelAddonRemovalPlan {
        schema_version: 1,
        addon_id: addon.id.clone(),
        display_name: addon.display_name,
        kind: addon.kind,
        digest: addon.digest,
        installed_bytes: addon.byte_size,
        target_label: format!("models/{}", addon.relative_path),
        confirmation_token,
        can_remove: blocking_run_ids.is_empty(),
        blocking_run_count,
        blocking_run_ids: blocking_run_ids.into_iter().take(20).collect(),
        saved_flow_count,
        saved_flow_ids: saved_flow_ids.into_iter().take(20).collect(),
        historical_run_count,
        warnings,
    })
}

fn finalize_removal_database(
    paths: &MediaRuntimePaths,
    removal_id: &str,
    addon_id: &str,
    digest: &str,
    removed_at: &str,
) -> MediaResult<()> {
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model add-on removal commit: {error}"))?;
    let deleted = transaction
        .execute(
            "DELETE FROM media_model_addons WHERE id = ?1 AND digest = ?2",
            params![addon_id, digest],
        )
        .map_err(|error| format!("failed to detach model add-on registry state: {error}"))?;
    if deleted != 1 {
        return Err("model add-on removal no longer matches the reviewed digest".to_string());
    }
    transaction
        .execute(
            "UPDATE media_model_addon_removals
             SET status = 'cleanup-pending', updated_at = ?2, completed_at = ?2
             WHERE id = ?1",
            params![removal_id, removed_at],
        )
        .map_err(|error| format!("failed to commit model add-on removal journal: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model add-on removal: {error}"))
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
                    "UPDATE media_model_addon_removals
                     SET status = 'cleanup-pending', error = ?2, updated_at = ?3 WHERE id = ?1",
                    params![
                        removal_id,
                        format!("deferred add-on cleanup: {error}"),
                        database::now()
                    ],
                )
                .map_err(|db_error| format!("failed to defer model add-on cleanup: {db_error}"))?;
            return Ok(true);
        }
    }
    database::open(paths)?
        .execute(
            "UPDATE media_model_addon_removals
             SET status = 'removed', error = NULL, updated_at = ?2 WHERE id = ?1",
            params![removal_id, database::now()],
        )
        .map_err(|error| format!("failed to finish model add-on cleanup: {error}"))?;
    Ok(false)
}

pub(crate) fn remove(
    paths: &MediaRuntimePaths,
    request: &super::RemoveMediaModelAddonRequest,
) -> MediaResult<super::MediaModelAddonRemovalResult> {
    let plan = plan_removal(paths, &request.addon_id)?;
    if request.confirmation_token != plan.confirmation_token {
        return Err("the reviewed model add-on removal plan is stale; review it again".to_string());
    }
    if !request.confirm_removal {
        return Err("explicit confirmation is required before removing a model add-on".to_string());
    }
    if !plan.can_remove {
        return Err("active runs still reference this model add-on".to_string());
    }
    let addon = managed_addon_for_removal(paths, &plan.addon_id)?;
    let expected_relative_path = format!("addons/sha256/{}", addon.digest);
    if addon.relative_path != expected_relative_path {
        return Err("the model add-on uses an unsafe managed storage path".to_string());
    }
    let models_root = paths.models_root()?;
    let source = models_root.join(&addon.relative_path);
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| format!("failed to inspect managed model add-on bytes: {error}"))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("the managed model add-on directory is missing or unsafe".to_string());
    }
    let addon_file = source.join("addon.safetensors");
    let (byte_size, digest) = model_import::hash_file(&addon_file)?;
    if byte_size != addon.byte_size || digest != addon.digest {
        return Err(
            "the managed model add-on failed integrity verification before removal".to_string(),
        );
    }

    let removal_id = model_import::new_import_id()?.replacen("model-import", "addon-removal", 1);
    let trash_relative_path = format!("addons/trash/{removal_id}");
    let trash_root = models_root.join(&trash_relative_path);
    let trash_repository = trash_root.join("repository");
    fs::create_dir_all(&trash_root)
        .map_err(|error| format!("failed to prepare model add-on removal journal: {error}"))?;
    let created_at = database::now();
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model add-on removal: {error}"))?;
    transaction
        .execute(
            "INSERT INTO media_model_addon_removals(
               id, addon_id, digest, status, relative_path, trash_relative_path,
               byte_size, created_at, updated_at
             ) VALUES (?1, ?2, ?3, 'prepared', ?4, ?5, ?6, ?7, ?7)",
            params![
                removal_id,
                addon.id,
                addon.digest,
                addon.relative_path,
                trash_relative_path,
                addon.byte_size as i64,
                created_at
            ],
        )
        .map_err(|error| format!("failed to journal model add-on removal: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model add-on removal reservation: {error}"))?;

    fs::rename(&source, &trash_repository)
        .map_err(|error| format!("failed to atomically detach model add-on bytes: {error}"))?;
    let removed_at = database::now();
    finalize_removal_database(
        paths,
        &removal_id,
        &plan.addon_id,
        &plan.digest,
        &removed_at,
    )?;
    let cleanup_pending = cleanup_removal_trash(paths, &removal_id, &trash_root)?;
    Ok(super::MediaModelAddonRemovalResult {
        schema_version: 1,
        addon_id: plan.addon_id,
        digest: plan.digest,
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
            .prepare(
                "SELECT id, addon_id, digest, status, relative_path, trash_relative_path
                 FROM media_model_addon_removals
                 WHERE status IN ('prepared', 'cleanup-pending') ORDER BY created_at",
            )
            .map_err(|error| format!("failed to prepare model add-on removal recovery: {error}"))?;
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
            .map_err(|error| format!("failed to read model add-on removal recovery: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode model add-on removal recovery: {error}"))?;
        rows
    };
    drop(connection);
    let models_root = paths.models_root()?;
    for (removal_id, addon_id, digest, status, relative_path, trash_relative_path) in removals {
        if relative_path != format!("addons/sha256/{digest}")
            || !trash_relative_path.starts_with("addons/trash/addon-removal-")
        {
            return Err("model add-on removal recovery found an unsafe path".to_string());
        }
        let source = models_root.join(&relative_path);
        let trash_root = models_root.join(&trash_relative_path);
        let trash_repository = trash_root.join("repository");
        if status == "prepared" {
            if source.exists() && trash_repository.exists() {
                return Err(
                    "model add-on removal recovery found both active and detached bytes"
                        .to_string(),
                );
            }
            if source.exists() {
                fs::create_dir_all(&trash_root).map_err(|error| {
                    format!("failed to recover model add-on removal directory: {error}")
                })?;
                fs::rename(&source, &trash_repository).map_err(|error| {
                    format!("failed to recover model add-on removal move: {error}")
                })?;
            }
            if !trash_repository.exists() {
                return Err(
                    "model add-on removal recovery could not locate active or detached bytes"
                        .to_string(),
                );
            }
            finalize_removal_database(paths, &removal_id, &addon_id, &digest, &database::now())?;
        }
        let _ = cleanup_removal_trash(paths, &removal_id, &trash_root)?;
    }
    Ok(())
}

pub(crate) fn import_reviewed_with_source(
    paths: &MediaRuntimePaths,
    request: &ImportMediaModelAddonRequest,
    source_metadata: Option<&Value>,
) -> MediaResult<MediaModelAddonImportResult> {
    let inspection = inspect(&request.source_path)?;
    if !inspection.can_import {
        return Err(inspection.blocking_reason.clone().unwrap_or_else(|| {
            "the selected safetensors file cannot be imported as a model add-on".to_string()
        }));
    }
    if request.review_token != inspection.review_token {
        return Err(
            "the selected add-on file changed; inspect it again before importing".to_string(),
        );
    }
    let (display_name, license_name, trigger_words, token, source_url) =
        validate_request(request, &inspection)?;
    let required_bytes = inspection.byte_size.saturating_mul(105).div_ceil(100);
    let models_root = paths.models_root()?;
    let addons_root = models_root.join("addons");
    fs::create_dir_all(&addons_root)
        .map_err(|error| format!("failed to prepare model add-on storage: {error}"))?;
    if hardware::available_storage_bytes(&addons_root).map(|available| available < required_bytes)
        == Some(true)
    {
        return Err("the Media Studio model volume does not have enough free space".to_string());
    }

    let import_id = model_import::new_import_id()?;
    let stage_root = addons_root.join("staging").join(&import_id);
    fs::create_dir_all(&stage_root)
        .map_err(|error| format!("failed to prepare add-on import staging: {error}"))?;
    let staged_addon = stage_root.join("addon.safetensors");
    let digest = match model_import::copy_and_hash(
        Path::new(&inspection.source_path),
        &staged_addon,
        inspection.byte_size,
    ) {
        Ok(digest) => digest,
        Err(error) => {
            let _ = fs::remove_dir_all(&stage_root);
            return Err(error);
        }
    };
    let copied_inspection = match inspect(staged_addon.to_string_lossy().as_ref()) {
        Ok(value) if value.detected_kind == inspection.detected_kind => value,
        Ok(_) => {
            let _ = fs::remove_dir_all(&stage_root);
            return Err("the copied add-on changed kind during verification".to_string());
        }
        Err(error) => {
            let quarantine_root = addons_root.join("quarantine").join(&import_id);
            fs::create_dir_all(
                quarantine_root
                    .parent()
                    .ok_or_else(|| "add-on quarantine path has no parent".to_string())?,
            )
            .map_err(|fs_error| format!("failed to prepare add-on quarantine: {fs_error}"))?;
            fs::rename(&stage_root, &quarantine_root).map_err(|fs_error| {
                format!("failed to quarantine invalid add-on data: {fs_error}")
            })?;
            return Err(format!(
                "the copied safetensors file failed verification and was quarantined: {error}"
            ));
        }
    };

    let relative_path = format!("addons/sha256/{digest}");
    let revision_root = models_root.join("addons").join("sha256").join(&digest);
    let already_installed = stored_addon_exists(paths, &digest)?;
    if revision_root.exists() {
        let existing = revision_root.join("addon.safetensors");
        let (existing_bytes, existing_digest) = model_import::hash_file(&existing)?;
        if existing_bytes != inspection.byte_size || existing_digest != digest {
            let _ = fs::remove_dir_all(&stage_root);
            return Err("the managed add-on conflicts with the imported digest".to_string());
        }
        fs::remove_dir_all(&stage_root)
            .map_err(|error| format!("failed to clean duplicate add-on staging data: {error}"))?;
    } else {
        fs::create_dir_all(
            revision_root
                .parent()
                .ok_or_else(|| "add-on revision path has no parent".to_string())?,
        )
        .map_err(|error| format!("failed to prepare add-on revision storage: {error}"))?;
        fs::rename(&stage_root, &revision_root)
            .map_err(|error| format!("failed to atomically activate imported add-on: {error}"))?;
    }

    let addon_id = format!("{MODEL_ADDON_ID_PREFIX}{digest}");
    let imported_at = database::now();
    let target_components_json = serde_json::to_string(&copied_inspection.target_components)
        .map_err(|error| format!("failed to encode add-on target components: {error}"))?;
    let embedding_vectors_json = serde_json::to_string(&copied_inspection.embedding_vectors)
        .map_err(|error| format!("failed to encode embedding vector profiles: {error}"))?;
    let lora_profile_json = copied_inspection
        .lora_profile
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("failed to encode LoRA tensor profile: {error}"))?;
    let trigger_words_json = serde_json::to_string(&trigger_words)
        .map_err(|error| format!("failed to encode add-on trigger words: {error}"))?;
    let source_metadata_json = source_metadata
        .map(serde_json::to_string)
        .transpose()
        .map_err(|error| format!("failed to encode add-on source metadata: {error}"))?;
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin add-on registration: {error}"))?;
    transaction
        .execute(
            "INSERT INTO media_model_addons(
               id, kind, display_name, architecture, architecture_confidence, format,
               target_components_json, embedding_vectors_json, lora_profile_json, base_model_hint,
               trigger_words_json, default_token,
               digest, header_digest, byte_size, relative_path, source_url,
               source_metadata_json, license_name, license_source_url,
               license_commercial_use, imported_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, 'safetensors', ?6, ?7, ?8, ?9, ?10, ?11, ?12,
               ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?21)
             ON CONFLICT(id) DO UPDATE SET
               display_name = excluded.display_name, architecture = excluded.architecture,
               architecture_confidence = excluded.architecture_confidence,
               target_components_json = excluded.target_components_json,
               embedding_vectors_json = excluded.embedding_vectors_json,
               lora_profile_json = excluded.lora_profile_json,
               base_model_hint = excluded.base_model_hint,
               trigger_words_json = excluded.trigger_words_json,
               default_token = excluded.default_token, source_url = excluded.source_url,
               source_metadata_json = COALESCE(
                 excluded.source_metadata_json, media_model_addons.source_metadata_json
               ),
               license_name = excluded.license_name,
               license_source_url = excluded.license_source_url,
               license_commercial_use = excluded.license_commercial_use,
               updated_at = excluded.updated_at",
            params![
                addon_id,
                request.kind,
                display_name,
                request.architecture,
                inspection.architecture_confidence,
                target_components_json,
                embedding_vectors_json,
                lora_profile_json,
                inspection.base_model_hint,
                trigger_words_json,
                token,
                digest,
                inspection.header_digest,
                inspection.byte_size as i64,
                relative_path,
                source_url.as_deref(),
                source_metadata_json,
                license_name,
                source_url.as_deref().unwrap_or(""),
                request.commercial_use,
                imported_at,
            ],
        )
        .map_err(|error| format!("failed to register imported model add-on: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit imported model add-on: {error}"))?;

    Ok(MediaModelAddonImportResult {
        schema_version: 1,
        addon_id,
        kind: request.kind.clone(),
        display_name,
        architecture: request.architecture.clone(),
        digest: digest.clone(),
        byte_size: inspection.byte_size,
        target_label: format!("models/{relative_path}/addon.safetensors"),
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
    use crate::media::catalog;

    fn temp_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be valid")
            .as_nanos();
        std::env::temp_dir().join(format!("machdoch-addon-import-{name}-{unique}.safetensors"))
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
    fn inspects_kohya_lora_without_loading_tensor_payloads() {
        let path = temp_path("lora");
        write_safetensors(
            &path,
            serde_json::json!({
                "__metadata__": {
                    "ss_network_module": "networks.lora",
                    "ss_base_model_version": "sdxl_base_v1-0",
                    "ss_output_name": "Gallery light"
                },
                "lora_unet_block.lora_up.weight": {
                    "dtype": "F32", "shape": [1, 1], "data_offsets": [0, 4]
                },
                "lora_unet_block.lora_down.weight": {
                    "dtype": "F32", "shape": [1, 1], "data_offsets": [4, 8]
                },
                "lora_unet_block.alpha": {
                    "dtype": "F32", "shape": [], "data_offsets": [8, 12]
                }
            }),
            &[0; 12],
        );
        let inspection = inspect(path.to_string_lossy().as_ref()).expect("inspection should pass");
        assert_eq!(inspection.detected_kind.as_deref(), Some("lora"));
        assert_eq!(
            inspection.detected_architecture.as_deref(),
            Some("stable-diffusion-xl")
        );
        assert_eq!(inspection.target_components, vec!["denoiser"]);
        assert_eq!(
            inspection.lora_profile,
            Some(MediaLoraTensorProfile {
                algorithm: "lora".to_string(),
                dialect: "kohya".to_string(),
                rank_minimum: 1,
                rank_maximum: 1,
                heterogeneous_ranks: false,
                target_module_count: 1,
                convolution_target_count: 0,
                magnitude_vector_count: 0,
                network_alpha_count: 1,
            })
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn fingerprints_convolutional_locon_and_dora_tensor_layouts() {
        let locon_path = temp_path("locon");
        write_safetensors(
            &locon_path,
            serde_json::json!({
                "lora_unet_conv.lora_down.weight": {
                    "dtype": "F32", "shape": [8, 16, 3, 3], "data_offsets": [0, 4608]
                },
                "lora_unet_conv.lora_up.weight": {
                    "dtype": "F32", "shape": [32, 8, 1, 1], "data_offsets": [4608, 5632]
                }
            }),
            &vec![0; 5632],
        );
        let locon =
            inspect(locon_path.to_string_lossy().as_ref()).expect("LoCon inspection should pass");
        assert_eq!(
            locon.lora_profile,
            Some(MediaLoraTensorProfile {
                algorithm: "locon".to_string(),
                dialect: "kohya".to_string(),
                rank_minimum: 8,
                rank_maximum: 8,
                heterogeneous_ranks: false,
                target_module_count: 1,
                convolution_target_count: 1,
                magnitude_vector_count: 0,
                network_alpha_count: 0,
            })
        );

        let dora_path = temp_path("dora");
        write_safetensors(
            &dora_path,
            serde_json::json!({
                "lora_unet_block.lora_down.weight": {
                    "dtype": "F32", "shape": [4, 16], "data_offsets": [0, 256]
                },
                "lora_unet_block.lora_up.weight": {
                    "dtype": "F32", "shape": [32, 4], "data_offsets": [256, 768]
                },
                "lora_unet_block.dora_scale": {
                    "dtype": "F32", "shape": [32], "data_offsets": [768, 896]
                }
            }),
            &vec![0; 896],
        );
        let dora =
            inspect(dora_path.to_string_lossy().as_ref()).expect("DoRA inspection should pass");
        assert_eq!(
            dora.lora_profile,
            Some(MediaLoraTensorProfile {
                algorithm: "dora".to_string(),
                dialect: "kohya".to_string(),
                rank_minimum: 4,
                rank_maximum: 4,
                heterogeneous_ranks: false,
                target_module_count: 1,
                convolution_target_count: 0,
                magnitude_vector_count: 1,
                network_alpha_count: 0,
            })
        );
        let _ = fs::remove_file(locon_path);
        let _ = fs::remove_file(dora_path);
    }

    #[test]
    fn blocks_unsupported_adapter_algorithms_and_incomplete_lora_pairs() {
        for (name, key, expected) in [
            ("loha", "lycoris_block.hada_w1_a", "LoHa"),
            ("lokr", "lycoris_block.lokr_w1", "LoKr"),
            ("oft", "lycoris_block.oft_blocks", "OFT"),
            (
                "cp-locon",
                "lora_unet_block.lora_mid.weight",
                "CP-decomposed LoCon",
            ),
        ] {
            let path = temp_path(name);
            write_safetensors(
                &path,
                serde_json::json!({
                    (key): { "dtype": "F32", "shape": [1, 1], "data_offsets": [0, 4] }
                }),
                &[0; 4],
            );
            let inspection = inspect(path.to_string_lossy().as_ref())
                .expect("unsupported adapter inspection should complete");
            assert_eq!(inspection.detected_kind.as_deref(), Some("lora"));
            assert!(!inspection.can_import);
            assert!(inspection
                .blocking_reason
                .as_deref()
                .is_some_and(|reason| reason.contains(expected)));
            let _ = fs::remove_file(path);
        }

        let orphan_path = temp_path("orphan-lora");
        write_safetensors(
            &orphan_path,
            serde_json::json!({
                "lora_unet_block.lora_down.weight": {
                    "dtype": "F32", "shape": [4, 16], "data_offsets": [0, 256]
                }
            }),
            &vec![0; 256],
        );
        let orphan = inspect(orphan_path.to_string_lossy().as_ref())
            .expect("orphan inspection should complete");
        assert!(!orphan.can_import);
        assert!(orphan
            .blocking_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("no matching")));
        let _ = fs::remove_file(orphan_path);
    }

    #[test]
    fn inspects_diffusers_textual_inversion_and_suggests_token() {
        let path = temp_path("embedding");
        write_safetensors(
            &path,
            serde_json::json!({
                "<gallery-light>": {
                    "dtype": "F32", "shape": [3, 768], "data_offsets": [0, 9216]
                }
            }),
            &vec![0; 9216],
        );
        let inspection = inspect(path.to_string_lossy().as_ref()).expect("inspection should pass");
        assert_eq!(
            inspection.detected_kind.as_deref(),
            Some("textual-inversion")
        );
        assert_eq!(
            inspection.suggested_token.as_deref(),
            Some("<gallery-light>")
        );
        assert_eq!(
            inspection.detected_architecture.as_deref(),
            Some("stable-diffusion-1")
        );
        assert_eq!(
            inspection.embedding_vectors,
            vec![MediaEmbeddingVectorProfile {
                component: "text-encoder".to_string(),
                tensor_key: "<gallery-light>".to_string(),
                vector_count: 3,
                dimension: 768,
            }]
        );
        let error = validate_request(
            &ImportMediaModelAddonRequest {
                source_path: inspection.source_path.clone(),
                review_token: inspection.review_token.clone(),
                display_name: "Gallery embedding".to_string(),
                kind: "textual-inversion".to_string(),
                architecture: "stable-diffusion-xl".to_string(),
                trigger_words: Vec::new(),
                token: Some("<gallery-light>".to_string()),
                source_url: None,
                license_name: "Publisher terms".to_string(),
                commercial_use: "review-required".to_string(),
                confirm_rights: true,
            },
            &inspection,
        )
        .expect_err("tensor-derived embedding families must not be overridden");
        assert!(error.contains("tensor dimensions and encoder slots"));
        let _ = fs::remove_file(path);
    }

    #[test]
    fn inspects_sdxl_textual_inversion_targets_per_encoder() {
        let path = temp_path("sdxl-embedding");
        write_safetensors(
            &path,
            serde_json::json!({
                "clip_l": {
                    "dtype": "F32", "shape": [4, 768], "data_offsets": [0, 12288]
                },
                "clip_g": {
                    "dtype": "F32", "shape": [4, 1280], "data_offsets": [12288, 32768]
                }
            }),
            &vec![0; 32768],
        );
        let inspection = inspect(path.to_string_lossy().as_ref()).expect("inspection should pass");
        assert_eq!(
            inspection.detected_architecture.as_deref(),
            Some("stable-diffusion-xl")
        );
        assert_eq!(
            inspection.target_components,
            vec!["text-encoder", "text-encoder-2"]
        );
        assert_eq!(
            inspection.embedding_vectors,
            vec![
                MediaEmbeddingVectorProfile {
                    component: "text-encoder".to_string(),
                    tensor_key: "clip_l".to_string(),
                    vector_count: 4,
                    dimension: 768,
                },
                MediaEmbeddingVectorProfile {
                    component: "text-encoder-2".to_string(),
                    tensor_key: "clip_g".to_string(),
                    vector_count: 4,
                    dimension: 1280,
                },
            ]
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn imports_and_catalogs_exact_embedding_vector_profiles() {
        let source = temp_path("managed-embedding");
        let (root, paths) = test_paths("managed-embedding");
        fs::create_dir_all(&root).expect("store should be created");
        write_safetensors(
            &source,
            serde_json::json!({
                "<gallery-light>": {
                    "dtype": "F32", "shape": [3, 768], "data_offsets": [0, 9216]
                }
            }),
            &vec![0; 9216],
        );
        database::initialize(&paths).expect("database should initialize");
        let inspection =
            inspect(source.to_string_lossy().as_ref()).expect("inspection should pass");
        let expected_profiles = inspection.embedding_vectors.clone();
        let result = import_reviewed_with_source(
            &paths,
            &ImportMediaModelAddonRequest {
                source_path: inspection.source_path.clone(),
                review_token: inspection.review_token,
                display_name: "Gallery concept".to_string(),
                kind: "textual-inversion".to_string(),
                architecture: "stable-diffusion-1".to_string(),
                trigger_words: Vec::new(),
                token: Some("<gallery-light>".to_string()),
                source_url: None,
                license_name: "Publisher terms".to_string(),
                commercial_use: "review-required".to_string(),
                confirm_rights: true,
            },
            None,
        )
        .expect("embedding should import");
        let mut connection = database::open(&paths).expect("database should open");
        catalog::synchronize(&mut connection).expect("catalog should synchronize");
        let snapshot =
            catalog::snapshot(&connection, &Default::default()).expect("catalog should load");
        let addon = snapshot
            .addons
            .iter()
            .find(|addon| addon.id == result.addon_id)
            .expect("embedding should be cataloged");
        assert_eq!(addon.embedding_vectors, expected_profiles);
        let _ = fs::remove_file(source);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn imports_and_catalogs_a_reviewed_lora() {
        let source = temp_path("managed-lora");
        let (root, paths) = test_paths("managed-lora");
        fs::create_dir_all(&root).expect("store should be created");
        write_safetensors(
            &source,
            serde_json::json!({
                "__metadata__": {
                    "ss_network_module": "networks.lora",
                    "ss_base_model_version": "sdxl_base_v1-0"
                },
                "lora_unet_block.lora_up.weight": {
                    "dtype": "F32", "shape": [1, 1], "data_offsets": [0, 4]
                },
                "lora_unet_block.lora_down.weight": {
                    "dtype": "F32", "shape": [1, 1], "data_offsets": [4, 8]
                }
            }),
            &[0; 8],
        );
        database::initialize(&paths).expect("database should initialize");
        let inspection =
            inspect(source.to_string_lossy().as_ref()).expect("inspection should pass");
        let expected_lora_profile = inspection.lora_profile.clone();
        let source_metadata = serde_json::json!({
            "provider": "civitai",
            "metadata": { "modelId": 123, "versionId": 456 }
        });
        let result = import_reviewed_with_source(
            &paths,
            &ImportMediaModelAddonRequest {
                source_path: inspection.source_path.clone(),
                review_token: inspection.review_token,
                display_name: "Gallery light".to_string(),
                kind: "lora".to_string(),
                architecture: "stable-diffusion-xl".to_string(),
                trigger_words: vec!["gallerylight".to_string()],
                token: None,
                source_url: Some("https://civitai.com/models/123".to_string()),
                license_name: "Publisher terms".to_string(),
                commercial_use: "review-required".to_string(),
                confirm_rights: true,
            },
            Some(&source_metadata),
        )
        .expect("LoRA should import");
        assert!(result.addon_id.starts_with(MODEL_ADDON_ID_PREFIX));
        let mut connection = database::open(&paths).expect("database should open");
        catalog::synchronize(&mut connection).expect("catalog should synchronize");
        let snapshot =
            catalog::snapshot(&connection, &Default::default()).expect("catalog should load");
        let addon = snapshot
            .addons
            .iter()
            .find(|addon| addon.id == result.addon_id)
            .expect("add-on should be cataloged");
        assert_eq!(addon.kind, "lora");
        assert_eq!(addon.architecture, "stable-diffusion-xl");
        assert_eq!(addon.trigger_words, vec!["gallerylight"]);
        assert_eq!(addon.lora_profile, expected_lora_profile);
        assert_eq!(addon.source_metadata.as_ref(), Some(&source_metadata));
        let removal_plan = plan_removal(&paths, &result.addon_id)
            .expect("reviewed add-on removal should be planned");
        assert!(removal_plan.can_remove);
        let removal = remove(
            &paths,
            &super::super::RemoveMediaModelAddonRequest {
                addon_id: result.addon_id.clone(),
                confirmation_token: removal_plan.confirmation_token,
                confirm_removal: true,
            },
        )
        .expect("reviewed add-on should be removed");
        assert_eq!(removal.reclaimed_bytes, result.byte_size);
        let refreshed = catalog::snapshot(&connection, &Default::default())
            .expect("catalog should reload after removal");
        assert!(refreshed
            .addons
            .iter()
            .all(|addon| addon.id != result.addon_id));
        let _ = fs::remove_file(source);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detects_nested_addon_dependencies_without_substring_matches() {
        let addon_id = "local-addon:sha256:abc";
        assert!(value_references_addon(
            &serde_json::json!({
                "nodes": [{ "settings": { "modelAddons": [{ "addonId": addon_id }] } }]
            }),
            addon_id,
        ));
        assert!(!value_references_addon(
            &serde_json::json!({ "addonId": format!("{addon_id}-different") }),
            addon_id,
        ));
    }
}
