use std::{
    fs,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    model_import, open_models, ImportMediaLocalModelRequest, MediaLocalModelImportInspection,
    MediaLocalModelImportResult, MediaResult, MediaRuntimePaths,
};

#[cfg(test)]
use super::database;

#[path = "model_package_publish.rs"]
mod publisher;

#[cfg(test)]
#[path = "model_package_import_tests.rs"]
mod tests;

struct PackageInventory {
    root: PathBuf,
    files: Vec<PathBuf>,
    bytes: u64,
    tensor_count: u32,
    review_token: String,
    pipeline: String,
}

fn inventory(source: &Path) -> MediaResult<PackageInventory> {
    if fs::symlink_metadata(source)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Select a regular model folder.".to_string());
    }
    let root = fs::canonicalize(source)
        .map_err(|error| format!("Could not open model folder: {error}"))?;
    let mut files = Vec::new();
    let mut pending = vec![(root.clone(), 0)];
    while let Some((directory, depth)) = pending.pop() {
        if depth > 8 {
            return Err("The model folder is nested too deeply.".to_string());
        }
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Model folders cannot contain symbolic links: {}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                if matches!(entry.file_name().to_str(), Some(".cache" | ".git")) {
                    continue;
                }
                pending.push((path, depth + 1));
            } else if metadata.is_file() {
                let published_student = open_models::profiles().iter().find_map(|profile| {
                    profile.distillation.as_ref().filter(|student| {
                        path == root.join(&student.checkpoint_file)
                            && path.extension().and_then(|extension| extension.to_str())
                                == Some("bin")
                    })
                });
                if let Some(student) = published_student {
                    if model_import::hash_file(&path)?
                        != (
                            student.checkpoint_byte_size,
                            student.checkpoint_sha256.clone(),
                        )
                    {
                        return Err(format!(
                            "Import the published student checkpoint at {}",
                            student.checkpoint_file
                        ));
                    }
                }
                if path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| {
                        published_student.is_none()
                            && matches!(
                                extension,
                                "py" | "pyc" | "bin" | "pt" | "pth" | "ckpt" | "gguf"
                            )
                    })
                {
                    return Err(format!(
                        "Remove executable or unsupported weights from the model folder: {}",
                        path.display()
                    ));
                }
                files.push(path);
                if files.len() > 4_096 {
                    return Err("The model folder contains too many files.".to_string());
                }
            } else {
                return Err("Model folders must contain regular files.".to_string());
            }
        }
    }
    files.sort();
    let mut hasher = Sha256::new();
    hasher.update(root.to_string_lossy().as_bytes());
    let mut bytes = 0_u64;
    let mut tensor_count = 0_u32;
    for path in &files {
        if path.extension().and_then(|extension| extension.to_str()) == Some("safetensors") {
            let header =
                model_import::parse_header(path.to_str().ok_or("Model path must be valid UTF-8")?)?;
            tensor_count = tensor_count
                .checked_add(header.tensor_count)
                .ok_or("The model folder contains too many tensors")?;
        }
        let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
        bytes = bytes
            .checked_add(metadata.len())
            .ok_or("Model folder size exceeds limits")?;
        let relative = path
            .strip_prefix(&root)
            .map_err(|error| error.to_string())?;
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        let modified = metadata
            .modified()
            .map_err(|error| error.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?;
        hasher.update(modified.as_nanos().to_le_bytes());
    }
    let index = read_json(&root.join("model_index.json"))?;
    let pipeline = index
        .get("_class_name")
        .and_then(Value::as_str)
        .ok_or("The model folder has no pipeline class")?
        .to_string();
    if !matches!(
        pipeline.as_str(),
        "StableDiffusionPipeline"
            | "StableDiffusionXLPipeline"
            | "StableDiffusion3Pipeline"
            | "FluxPipeline"
    ) && !open_models::profiles()
        .iter()
        .any(|profile| profile.pipeline == pipeline)
    {
        return Err(format!(
            "Pipeline {pipeline} has no local generation adapter."
        ));
    }
    let h3_student = pipeline == "MiniMaxH3ModularPipeline";
    let sdxl_student = pipeline == "StableDiffusionXLPipeline"
        && open_models::profiles().iter().any(|profile| {
            profile.pipeline == pipeline
                && profile
                    .distillation
                    .as_ref()
                    .is_some_and(|student| files.contains(&root.join(&student.checkpoint_file)))
        });
    if h3_student {
        for name in [
            "transformer",
            "text_encoder",
            "tokenizer",
            "processor",
            "vae",
            "audio_vae",
            "scheduler",
            "audio_scheduler",
        ] {
            if !index
                .get(name)
                .and_then(Value::as_array)
                .is_some_and(|component| {
                    component.len() == 3 && component[0].is_string() && component[1].is_string()
                })
            {
                return Err(format!("Missing MiniMax-H3 component: {name}"));
            }
        }
    }
    for (name, specification) in index.as_object().ok_or("Invalid model index")? {
        let Some(component) = specification.as_array() else {
            continue;
        };
        if component.len() != if h3_student { 3 } else { 2 } {
            return Err(format!("Invalid component {name}"));
        }
        if component[0].is_null() && component[1].is_null() {
            continue;
        }
        let class = component[1].as_str().ok_or("Invalid component class")?;
        if h3_student {
            let loading = component[2]
                .as_object()
                .ok_or("Invalid MiniMax-H3 component specification")?;
            if loading.get("type_hint") != Some(&Value::Array(component[..2].to_vec()))
                || loading.get("subfolder").and_then(Value::as_str) != Some(name.as_str())
                || loading
                    .get("pretrained_model_name_or_path")
                    .and_then(Value::as_str)
                    != Some("MiniMaxAI/MiniMax-H3")
            {
                return Err(format!("Invalid MiniMax-H3 component: {name}"));
            }
            if name == "transformer_ref" {
                if component[0] != "diffusers" || class != "MiniMaxH3Transformer3DModel" {
                    return Err("Invalid MiniMax-H3 reference component".to_string());
                }
                continue;
            }
        }
        let native_audio_component = pipeline == "AudioLDM2Pipeline"
            && matches!(
                (name.as_str(), component[0].as_str(), class),
                (
                    "projection_model",
                    Some("audioldm2"),
                    "AudioLDM2ProjectionModel"
                ) | ("unet", Some("audioldm2"), "AudioLDM2UNet2DConditionModel")
            );
        if !matches!(component[0].as_str(), Some("diffusers" | "transformers"))
            && !native_audio_component
        {
            return Err(format!("Component {name} requires custom repository code."));
        }
        let relative = Path::new(name);
        if relative.components().count() != 1
            || !matches!(relative.components().next(), Some(Component::Normal(_)))
        {
            return Err("The model index contains an unsafe component path.".to_string());
        }
        let component_root = root.join(relative);
        if !component_root.is_dir() {
            return Err(format!("Missing model component: {name}"));
        }
        if class.contains("Scheduler") {
            read_json(&component_root.join("scheduler_config.json"))?;
        } else if class.contains("Tokenizer") {
            read_json(&component_root.join("tokenizer_config.json"))?;
        }
        if class.contains("Model")
            || class.starts_with("Autoencoder")
            || class == "SpeechT5HifiGan"
            || (h3_student && name == "text_encoder")
        {
            let config = read_json(&component_root.join("config.json"))?;
            if h3_student
                && name == "text_encoder"
                && (config["model_type"].as_str() != Some("qwen3_vl")
                    || config["text_config"]["model_type"].as_str() != Some("qwen3_vl_text")
                    || config["text_config"]["num_hidden_layers"].as_u64() != Some(64)
                    || config["text_config"]["hidden_size"].as_u64() != Some(5120))
            {
                return Err("Choose the original MiniMax-H3 Qwen3-VL text encoder.".to_string());
            }
            let weights = files
                .iter()
                .filter(|path| {
                    path.parent() == Some(component_root.as_path())
                        && path.extension().and_then(|extension| extension.to_str())
                            == Some("safetensors")
                })
                .collect::<Vec<_>>();
            if weights.is_empty() && !(sdxl_student && name == "unet") {
                return Err(format!("Missing safetensors weights for {name}"));
            }
            for path in files.iter().filter(|path| {
                path.parent() == Some(component_root.as_path())
                    && path
                        .file_name()
                        .and_then(|file| file.to_str())
                        .is_some_and(|file| file.ends_with(".safetensors.index.json"))
            }) {
                let weight_index = read_json(path)?;
                let map = weight_index
                    .get("weight_map")
                    .and_then(Value::as_object)
                    .ok_or("Invalid weight index")?;
                if map.is_empty() {
                    return Err("The weight index is empty.".to_string());
                }
                for shard in map.values() {
                    let shard = shard.as_str().ok_or("Invalid weight shard")?;
                    if Path::new(shard).components().count() != 1
                        || !shard.ends_with(".safetensors")
                        || !files.contains(&component_root.join(shard))
                    {
                        return Err(format!("Missing or unsafe weight shard: {name}/{shard}"));
                    }
                }
            }
        }
    }
    Ok(PackageInventory {
        root,
        files,
        bytes,
        tensor_count,
        review_token: format!("{:x}", hasher.finalize()),
        pipeline,
    })
}

fn read_json(path: &Path) -> MediaResult<Value> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Missing {}: {error}", path.display()))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 16 * 1_024 * 1_024
    {
        return Err(format!("Invalid model configuration: {}", path.display()));
    }
    serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
        .map_err(|error| format!("Invalid {}: {error}", path.display()))
}

fn flux2_klein_architecture(root: &Path) -> MediaResult<Option<String>> {
    let index = read_json(&root.join("model_index.json"))?;
    let config = read_json(&root.join("transformer/config.json"))?;
    let distilled = match index.get("is_distilled") {
        None => false,
        Some(Value::Bool(distilled)) => *distilled,
        _ => return Err("The FLUX.2 Klein is_distilled value must be a boolean.".to_string()),
    };
    let width = config["num_attention_heads"].as_u64().and_then(|heads| {
        config["attention_head_dim"]
            .as_u64()
            .and_then(|dimension| heads.checked_mul(dimension))
    });
    let inferred = match (width, distilled) {
        (Some(3072), true) => Some("flux-2"),
        (Some(3072), false) => Some("flux-2-klein-base-4b"),
        (Some(4096), true) => Some("flux-2-klein-9b"),
        (Some(4096), false) => Some("flux-2-klein-base-9b"),
        _ => None,
    };
    match index.get("_machdoch_training_architecture") {
        Some(Value::String(architecture))
            if matches!(
                architecture.as_str(),
                "flux-2" | "flux-2-klein-base-4b" | "flux-2-klein-9b" | "flux-2-klein-base-9b"
            ) =>
        {
            let distilled = matches!(architecture.as_str(), "flux-2" | "flux-2-klein-9b");
            if index["is_distilled"].as_bool() != Some(distilled) {
                return Err(
                    "The FLUX.2 Klein training architecture does not match is_distilled."
                        .to_string(),
                );
            }
            if inferred.is_some_and(|variant| variant != architecture) {
                return Err("The FLUX.2 Klein training architecture does not match the transformer configuration.".to_string());
            }
            Ok(Some(architecture.clone()))
        }
        None => Ok(inferred.map(str::to_string)),
        _ => Err("The FLUX.2 Klein training architecture is invalid.".to_string()),
    }
}

fn cogvideo_architecture(root: &Path, pipeline: &str) -> MediaResult<String> {
    let index = read_json(&root.join("model_index.json"))?;
    let transformer = read_json(&root.join("transformer/config.json"))?;
    let vae = read_json(&root.join("vae/config.json"))?;
    let image_conditioned = pipeline == "CogVideoXImageToVideoPipeline";
    let channels = vae["latent_channels"]
        .as_u64()
        .ok_or("The CogVideoX VAE configuration is missing its latent channels.")?;
    if transformer["in_channels"].as_u64() != Some(channels * if image_conditioned { 2 } else { 1 })
    {
        return Err("The CogVideoX transformer and VAE channels do not match.".into());
    }
    let architecture = match transformer.get("patch_size_t") {
        None | Some(Value::Null) if !image_conditioned => "cogvideox-2b",
        Some(value)
            if value.as_u64() == Some(2)
                && transformer["use_rotary_positional_embeddings"] == true =>
        {
            if image_conditioned {
                "cogvideox-1.5-5b-i2v"
            } else {
                "cogvideox-1.5-5b"
            }
        }
        _ => {
            return Err("Choose a CogVideoX 2B or 1.5 model with matching temporal patches.".into())
        }
    };
    if index
        .get("_machdoch_training_architecture")
        .is_some_and(|value| value.as_str() != Some(architecture))
    {
        return Err("The CogVideoX training architecture does not match its transformer.".into());
    }
    Ok(architecture.into())
}

pub(super) fn inspect(source: &Path) -> MediaResult<MediaLocalModelImportInspection> {
    let package = inventory(source)?;
    let matches = open_models::profiles()
        .iter()
        .filter(|profile| profile.pipeline == package.pipeline)
        .collect::<Vec<_>>();
    let detected = match package.pipeline.as_str() {
        "StableDiffusionXLPipeline" => Some("stable-diffusion-xl".to_string()),
        "StableDiffusion3Pipeline" => Some("stable-diffusion-3".to_string()),
        "Flux2KleinPipeline" => flux2_klein_architecture(&package.root)?,
        "CogVideoXPipeline" | "CogVideoXImageToVideoPipeline" => {
            Some(cogvideo_architecture(&package.root, &package.pipeline)?)
        }
        "ZImagePipeline" => {
            let index = read_json(&package.root.join("model_index.json"))?;
            match index.get("_machdoch_training_architecture") {
                Some(Value::String(architecture))
                    if matches!(architecture.as_str(), "z-image" | "z-image-turbo") =>
                {
                    Some(architecture.clone())
                }
                None => None,
                _ => return Err("The Z-Image training architecture is invalid.".to_string()),
            }
        }
        "Krea2Pipeline" => {
            let index = read_json(&package.root.join("model_index.json"))?;
            match index["is_distilled"].as_bool() {
                Some(true) => Some("krea-2".to_string()),
                Some(false) => Some("krea-2-raw".to_string()),
                None => return Err("The KREA 2 model index is missing is_distilled.".to_string()),
            }
        }
        "FluxPipeline" => {
            let config = read_json(&package.root.join("transformer/config.json"))?;
            match config["guidance_embeds"].as_bool() {
                Some(true) => Some("flux-1-dev".to_string()),
                Some(false) => Some("flux-1-schnell".to_string()),
                None => {
                    return Err(
                        "The FLUX.1 transformer configuration is missing guidance_embeds."
                            .to_string(),
                    )
                }
            }
        }
        "StableDiffusionPipeline" => {
            let config = read_json(&package.root.join("text_encoder/config.json"))?;
            match config["hidden_size"].as_u64() {
                Some(768) => Some("stable-diffusion-1".to_string()),
                Some(1024) => Some("stable-diffusion-2".to_string()),
                _ => None,
            }
        }
        _ => (matches.len() == 1).then(|| matches[0].architecture.clone()),
    };
    let name = package
        .root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Model")
        .to_string();
    Ok(MediaLocalModelImportInspection {
        schema_version: 1,
        can_import: true,
        blocking_reason: None,
        source_path: package.root.to_string_lossy().into_owned(),
        source_file_name: name.clone(),
        byte_size: package.bytes,
        tensor_count: package.tensor_count,
        header_digest: package.review_token.clone(),
        duplicate: None,
        review_token: package.review_token,
        suggested_display_name: name,
        architecture_confidence: if detected.is_some() {
            "high"
        } else {
            "unknown"
        }
        .to_string(),
        detected_architecture: detected,
        metadata_summary: vec![package.pipeline],
        warnings: Vec::new(),
    })
}

fn validate_student_package(
    package: &PackageInventory,
    profile: &open_models::OpenModelProfile,
) -> MediaResult<()> {
    let student = profile
        .distillation
        .as_ref()
        .ok_or("Select a student model")?;
    if profile.pipeline == "StableDiffusionXLPipeline" {
        for component in [
            "unet",
            "vae",
            "text_encoder",
            "text_encoder_2",
            "tokenizer",
            "tokenizer_2",
            "scheduler",
        ] {
            if !package.root.join(component).is_dir() {
                return Err(format!("Missing SDXL base component: {component}"));
            }
        }
        let config = read_json(&package.root.join("unet/config.json"))?;
        if config["in_channels"] != 4
            || config["out_channels"] != 4
            || config["cross_attention_dim"] != 2048
            || config["addition_embed_type"] != "text_time"
            || config["block_out_channels"] != serde_json::json!([320, 640, 1280])
        {
            return Err("Choose the SDXL base 1.0 components for this student.".to_string());
        }
    }
    let checkpoint = package.root.join(&student.checkpoint_file);
    if !package.files.contains(&checkpoint)
        || model_import::hash_file(&checkpoint)?
            != (
                student.checkpoint_byte_size,
                student.checkpoint_sha256.clone(),
            )
    {
        return Err(format!(
            "Import the published student checkpoint at {}",
            student.checkpoint_file
        ));
    }
    let license_file = if profile.pipeline == "StableDiffusionXLPipeline" {
        "LICENSE.md"
    } else {
        "LICENSE"
    };
    if !package.files.contains(&package.root.join(license_file)) {
        return Err(format!(
            "Include the {} licence at {license_file}.",
            profile.family
        ));
    }
    Ok(())
}

pub(super) fn import_reviewed(
    paths: &MediaRuntimePaths,
    request: &ImportMediaLocalModelRequest,
) -> MediaResult<MediaLocalModelImportResult> {
    let expected_pipeline = match request.architecture.as_str() {
        "stable-diffusion-xl" | "pony" => "StableDiffusionXLPipeline",
        "stable-diffusion-1" | "stable-diffusion-2" => "StableDiffusionPipeline",
        "stable-diffusion-3" => "StableDiffusion3Pipeline",
        "flux-1" | "flux-1-dev" | "flux-1-schnell" => "FluxPipeline",
        "flux-2" => "Flux2KleinPipeline",
        "krea-2" => "Krea2Pipeline",
        _ => {
            &open_models::by_architecture(&request.architecture)
                .ok_or("Select a model architecture")?
                .pipeline
        }
    };
    model_import::validated_text("displayName", &request.display_name, 120)?;
    model_import::validated_source_url(request.source_url.as_deref())?;
    model_import::validated_optional_text("licenseName", request.license_name.as_deref(), 256)?;
    let inspection = inspect(Path::new(&request.source_path))?;
    if request.review_token != inspection.review_token {
        return Err("The model folder changed. Inspect it again.".to_string());
    }
    let package = inventory(Path::new(&request.source_path))?;
    if package.pipeline == "StableDiffusionXLPipeline"
        && !package.files.iter().any(|path| {
            path.parent() == Some(package.root.join("unet").as_path())
                && path.extension().and_then(|extension| extension.to_str()) == Some("safetensors")
        })
        && !open_models::by_architecture(&request.architecture)
            .is_some_and(|profile| profile.distillation.is_some())
    {
        return Err("Choose the SDXL student architecture for this folder.".to_string());
    }
    if expected_pipeline != package.pipeline
        || matches!(
            request.architecture.as_str(),
            "stable-diffusion-1"
                | "stable-diffusion-2"
                | "flux-1-dev"
                | "flux-1-schnell"
                | "krea-2"
                | "krea-2-raw"
                | "cogvideox-2b"
                | "cogvideox-1.5-5b"
                | "cogvideox-1.5-5b-i2v"
        ) && inspection.detected_architecture.as_deref() != Some(request.architecture.as_str())
    {
        return Err("The selected architecture does not match the model folder.".to_string());
    }
    if package.pipeline == "ZImagePipeline"
        && inspection
            .detected_architecture
            .as_deref()
            .is_some_and(|architecture| architecture != request.architecture)
    {
        return Err(
            "The selected Z-Image architecture does not match the trained model.".to_string(),
        );
    }
    if package.pipeline == "Flux2KleinPipeline"
        && inspection
            .detected_architecture
            .as_deref()
            .is_some_and(|architecture| architecture != request.architecture)
    {
        return Err(
            "The selected FLUX.2 Klein architecture does not match the model folder.".to_string(),
        );
    }
    if let Some(profile) = open_models::by_architecture(&request.architecture)
        .filter(|profile| profile.distillation.is_some())
    {
        validate_student_package(&package, profile)?;
        if request.commercial_use.as_deref() == Some("allowed") {
            return Err(format!(
                "Review the {} licence before commercial use.",
                profile.family
            ));
        }
    }
    if request
        .commercial_use
        .as_deref()
        .is_some_and(|value| !matches!(value, "allowed" | "review-required"))
    {
        return Err("Invalid commercialUse value".to_string());
    }
    publisher::publish(paths, request, &inspection, &package)
}
