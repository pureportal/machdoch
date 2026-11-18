use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use super::{model_import::ParsedSafetensorsHeader, MediaLoraTensorProfile, MediaResult};

const LOKR_TENSORS: &[&str] = &[
    "lokr_w1",
    "lokr_w1_a",
    "lokr_w1_b",
    "lokr_w2",
    "lokr_w2_a",
    "lokr_w2_b",
    "lokr_t2",
];
const LOHA_TENSORS: &[&str] = &[
    "hada_w1_a",
    "hada_w1_b",
    "hada_w2_a",
    "hada_w2_b",
    "hada_t1",
    "hada_t2",
];
const KOHYA_PREFIXES: &[&str] = &[
    "lora_unet_",
    "lora_te_",
    "lora_te1_",
    "lora_te2_",
    "lora_transformer_",
];
const MAX_RANK: u64 = 4_096;

type ModuleShapes = BTreeMap<String, Vec<u64>>;

fn algorithm_tensors(algorithm: &str) -> &'static [&'static str] {
    if algorithm == "lokr" {
        LOKR_TENSORS
    } else {
        LOHA_TENSORS
    }
}

pub(super) fn lycoris_algorithm(
    header: &ParsedSafetensorsHeader,
) -> MediaResult<Option<&'static str>> {
    let mut found = HashSet::new();
    for key in &header.tensor_keys {
        let lower = key.to_lowercase();
        let name = lower.rsplit('.').next().unwrap_or_default();
        if LOKR_TENSORS.contains(&name) {
            found.insert("lokr");
        }
        if LOHA_TENSORS.contains(&name) {
            found.insert("loha");
        }
    }
    if found.len() > 1 {
        return Err("Mixed LyCORIS algorithms are not supported in one add-on".to_string());
    }
    Ok(found.into_iter().next())
}

fn tensor_shape(header: &ParsedSafetensorsHeader, key: &str) -> MediaResult<Vec<u64>> {
    header
        .tensor_shapes
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("LyCORIS tensor {key} has no valid shape"))?
        .iter()
        .map(|dimension| {
            dimension
                .as_u64()
                .ok_or_else(|| format!("LyCORIS tensor {key} has an invalid shape"))
        })
        .collect()
}

fn modules(
    header: &ParsedSafetensorsHeader,
    algorithm: &str,
) -> MediaResult<BTreeMap<String, ModuleShapes>> {
    let tensors = algorithm_tensors(algorithm);
    let mut modules = BTreeMap::<String, ModuleShapes>::new();
    for key in &header.tensor_keys {
        let (stem, name) = key
            .rsplit_once('.')
            .ok_or_else(|| format!("LyCORIS tensor {key} has no module name"))?;
        let name = name.to_lowercase();
        if name != "alpha" && !tensors.contains(&name.as_str()) {
            return Err(format!(
                "{} add-on contains an unsupported tensor: {key}",
                algorithm.to_uppercase()
            ));
        }
        modules
            .entry(stem.to_string())
            .or_default()
            .insert(name, tensor_shape(header, key)?);
    }
    Ok(modules)
}

fn dimension(module: &ModuleShapes, name: &str, axis: usize) -> u64 {
    module
        .get(name)
        .and_then(|shape| shape.get(axis))
        .copied()
        .unwrap_or(0)
}

fn decomposed(module: &ModuleShapes, full: &str, left: &str, right: &str) -> MediaResult<bool> {
    if module.contains_key(full) {
        if module.contains_key(left) || module.contains_key(right) {
            return Err(format!(
                "LyCORIS module stores {full} both whole and decomposed"
            ));
        }
        return Ok(false);
    }
    if module.contains_key(left) && module.contains_key(right) {
        Ok(true)
    } else {
        Err(format!("LyCORIS module is missing {full}"))
    }
}

fn module_rank(algorithm: &str, module: &ModuleShapes) -> MediaResult<u64> {
    if algorithm == "loha" {
        if ["hada_w1_a", "hada_w1_b", "hada_w2_a", "hada_w2_b"]
            .iter()
            .any(|name| !module.contains_key(*name))
        {
            return Err("LoHa module is missing a Hadamard factor".to_string());
        }
        if module.contains_key("hada_t1") != module.contains_key("hada_t2") {
            return Err("LoHa module has an incomplete Tucker core".to_string());
        }
        let rank = dimension(module, "hada_w1_b", 0);
        if dimension(module, "hada_w2_b", 0) != rank {
            return Err("LoHa module has mismatched factor ranks".to_string());
        }
        return Ok(rank);
    }
    let w1_decomposed = decomposed(module, "lokr_w1", "lokr_w1_a", "lokr_w1_b")?;
    if module.contains_key("lokr_t2") && module.contains_key("lokr_w2") {
        return Err("LoKr module has a Tucker core without decomposed factors".to_string());
    }
    let w2_decomposed = decomposed(module, "lokr_w2", "lokr_w2_a", "lokr_w2_b")?;
    let ranks = [
        w1_decomposed.then(|| dimension(module, "lokr_w1_b", 0)),
        w2_decomposed.then(|| dimension(module, "lokr_w2_b", 0)),
    ];
    Ok(ranks
        .into_iter()
        .flatten()
        .max()
        .unwrap_or_else(|| dimension(module, "lokr_w2", 0).min(dimension(module, "lokr_w2", 1))))
}

fn module_dimensions(algorithm: &str, module: &ModuleShapes) -> (u64, u64) {
    if algorithm == "loha" {
        let output_axis = usize::from(module.contains_key("hada_t1"));
        return (
            dimension(module, "hada_w1_b", 1),
            dimension(module, "hada_w1_a", output_axis),
        );
    }
    let (w1_output, w1_input) = if module.contains_key("lokr_w1") {
        (
            dimension(module, "lokr_w1", 0),
            dimension(module, "lokr_w1", 1),
        )
    } else {
        (
            dimension(module, "lokr_w1_a", 0),
            dimension(module, "lokr_w1_b", 1),
        )
    };
    let (w2_output, w2_input) = if module.contains_key("lokr_w2") {
        (
            dimension(module, "lokr_w2", 0),
            dimension(module, "lokr_w2", 1),
        )
    } else if module.contains_key("lokr_t2") {
        (
            dimension(module, "lokr_w2_a", 1),
            dimension(module, "lokr_w2_b", 1),
        )
    } else {
        (
            dimension(module, "lokr_w2_a", 0),
            dimension(module, "lokr_w2_b", 1),
        )
    };
    (w1_input * w2_input, w1_output * w2_output)
}

pub(super) fn lycoris_module_dimensions(
    header: &ParsedSafetensorsHeader,
    key_fragment: &str,
) -> Vec<(u64, u64)> {
    let Ok(Some(algorithm)) = lycoris_algorithm(header) else {
        return Vec::new();
    };
    let Ok(modules) = modules(header, algorithm) else {
        return Vec::new();
    };
    modules
        .iter()
        .filter(|(stem, _)| stem.to_lowercase().contains(key_fragment))
        .map(|(_, module)| module_dimensions(algorithm, module))
        .collect()
}

pub(super) fn lycoris_tensor_profile(
    header: &ParsedSafetensorsHeader,
    algorithm: &str,
) -> MediaResult<MediaLoraTensorProfile> {
    let modules = modules(header, algorithm)?;
    let mut ranks = Vec::with_capacity(modules.len());
    let mut convolution_target_count = 0_u32;
    let mut network_alpha_count = 0_u32;
    let mut dialects = HashSet::new();
    for (stem, module) in &modules {
        let mut factors = module.clone();
        if let Some(alpha) = factors.remove("alpha") {
            if !(alpha.is_empty() || alpha == [1]) {
                return Err(format!("LyCORIS alpha for {stem} must be a scalar tensor"));
            }
            network_alpha_count += 1;
        }
        if factors.is_empty() {
            return Err(format!("LyCORIS alpha for {stem} has no matching factors"));
        }
        if factors
            .values()
            .any(|shape| shape.is_empty() || shape.contains(&0))
        {
            return Err(format!("LyCORIS module {stem} has an invalid shape"));
        }
        let rank = module_rank(algorithm, &factors)?;
        if rank == 0 || rank > MAX_RANK {
            return Err(format!("LyCORIS module {stem} has an unsupported rank"));
        }
        ranks.push(u32::try_from(rank).unwrap_or(u32::MAX));
        if factors.values().any(|shape| shape.len() == 4) {
            convolution_target_count += 1;
        }
        let lower = stem.to_lowercase();
        dialects.insert(
            if KOHYA_PREFIXES
                .iter()
                .any(|prefix| lower.starts_with(prefix))
            {
                "kohya"
            } else {
                "generic"
            },
        );
    }
    if dialects.len() != 1 {
        return Err("Mixed LoRA tensor dialects are not supported in one add-on".to_string());
    }
    let rank_minimum = *ranks.iter().min().expect("LyCORIS modules exist");
    let rank_maximum = *ranks.iter().max().expect("LyCORIS modules exist");
    Ok(MediaLoraTensorProfile {
        algorithm: algorithm.to_string(),
        dialect: (*dialects.iter().next().expect("one LyCORIS dialect")).to_string(),
        rank_minimum,
        rank_maximum,
        heterogeneous_ranks: rank_minimum != rank_maximum,
        target_module_count: u32::try_from(modules.len()).unwrap_or(u32::MAX),
        convolution_target_count,
        magnitude_vector_count: 0,
        network_alpha_count,
    })
}
