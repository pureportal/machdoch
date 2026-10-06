use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::child_process::terminate_child_process_tree_by_id;

use super::{provider_local_diffusers, MediaResult, MediaRuntimePaths};

#[path = "training_process.rs"]
mod training_process;

#[path = "training_dataset.rs"]
mod training_dataset;

#[cfg(test)]
use training_dataset::inspect_images;
pub(crate) use training_dataset::inspect_samples;
use training_dataset::{prepare_dataset, validate_settings as validate_dataset_settings};

use training_process::{process_for_job, start_process};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum TrainingArchitecture {
    #[serde(rename = "krea-2")]
    Krea2,
    #[serde(rename = "stable-diffusion-xl")]
    StableDiffusionXl,
    #[serde(rename = "pony")]
    Pony,
    #[serde(rename = "stable-diffusion-1")]
    StableDiffusion1,
    #[serde(rename = "stable-diffusion-2")]
    StableDiffusion2,
    #[serde(rename = "stable-diffusion-3")]
    StableDiffusion3,
    #[serde(rename = "flux-1")]
    Flux1,
    #[serde(rename = "flux-1-dev")]
    Flux1Dev,
    #[serde(rename = "flux-1-schnell")]
    Flux1Schnell,
    #[serde(rename = "flux-2")]
    Flux2,
    #[serde(rename = "flux-2-klein-base-4b")]
    Flux2KleinBase4B,
    #[serde(rename = "flux-2-klein-9b")]
    Flux2Klein9B,
    #[serde(rename = "flux-2-klein-base-9b")]
    Flux2KleinBase9B,
    #[serde(rename = "sana")]
    Sana,
    #[serde(rename = "z-image")]
    ZImage,
    #[serde(rename = "z-image-turbo")]
    ZImageTurbo,
    #[serde(rename = "cogvideox-2b")]
    CogVideoX2B,
    #[serde(rename = "cogvideox-1.5-5b")]
    CogVideoX15_5B,
    #[serde(rename = "cogvideox-1.5-5b-i2v")]
    CogVideoX15_5BI2V,
    #[serde(rename = "wan-2.1-t2v-1.3b")]
    Wan21T2V13B,
}

impl TrainingArchitecture {
    fn is_video(self) -> bool {
        matches!(
            self,
            Self::CogVideoX2B | Self::CogVideoX15_5B | Self::CogVideoX15_5BI2V | Self::Wan21T2V13B
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TrainingVideoSettings {
    width: u32,
    height: u32,
    frames: u32,
    fps: u32,
    image_dropout: f64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrainingMethod {
    Lora,
    Finetune,
    Embedding,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrainingPrecision {
    Bf16,
    Fp16,
    Float32,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrainingOptimizer {
    Adamw,
    Adafactor,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrainingWeightPrecision {
    Bf16,
    Float32,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrainingLrSchedule {
    Constant,
    Linear,
    Cosine,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TrainingOptions {
    pub method: TrainingMethod,
    pub precision: TrainingPrecision,
    pub optimizer: TrainingOptimizer,
    pub trainable_precision: TrainingWeightPrecision,
    pub batch_size: u32,
    pub gradient_accumulation: u32,
    pub lr_scheduler: TrainingLrSchedule,
    pub warmup_steps: u32,
    pub weight_decay: f64,
    pub max_grad_norm: f64,
    pub snr_gamma: f64,
    pub noise_offset: f64,
    pub lora_dropout: f64,
    pub guidance_scale: f64,
    pub checkpoint_interval: u32,
    pub checkpoint_retention: u32,
    pub gradient_checkpointing: bool,
    pub preserve_aspect_ratio: bool,
    pub initializer_token: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TrainingConcept {
    Style,
    Face,
    Character,
    Object,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TrainingSample {
    path: PathBuf,
    caption: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingSampleInspection {
    path: PathBuf,
    width: u32,
    height: u32,
    duration_seconds: Option<f64>,
    fps: Option<f64>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TrainingRequest {
    name: String,
    concept: TrainingConcept,
    trigger_phrase: String,
    samples: Vec<TrainingSample>,
    architecture: TrainingArchitecture,
    model_id: Option<String>,
    model_path: PathBuf,
    steps: u32,
    learning_rate: f64,
    resolution: u32,
    rank: u32,
    attention_only: bool,
    four_bit: bool,
    seed: u32,
    options: TrainingOptions,
    video: Option<TrainingVideoSettings>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingJob {
    id: String,
    name: String,
    concept: TrainingConcept,
    trigger_phrase: String,
    architecture: TrainingArchitecture,
    method: TrainingMethod,
    base_model_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct RunnerStatus {
    state: String,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingStatus {
    state: String,
    message: Option<String>,
    output_path: Option<PathBuf>,
    can_resume: bool,
    completed_steps: Option<u32>,
    total_steps: u32,
    progress: Option<TrainingProgress>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrainingProgress {
    completed_steps: u32,
    total_steps: u32,
    loss: f64,
    learning_rate: f64,
    elapsed_seconds: f64,
    remaining_seconds: f64,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrainingModel {
    id: Option<String>,
    architecture: TrainingArchitecture,
    package_kind: String,
    path: PathBuf,
    config_path: Option<PathBuf>,
    revision: Option<String>,
    digest: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct JobSpec {
    architecture: TrainingArchitecture,
    model: TrainingModel,
    trigger_phrase: String,
    resolution: u32,
    rank: u32,
    learning_rate: f64,
    steps: u32,
    attention_only: bool,
    four_bit: bool,
    resume: bool,
    seed: u32,
    options: TrainingOptions,
    video: Option<TrainingVideoSettings>,
}

impl JobSpec {
    fn new(request: &TrainingRequest, model: TrainingModel) -> Self {
        Self {
            architecture: request.architecture,
            model,
            trigger_phrase: request.trigger_phrase.trim().into(),
            resolution: request.resolution,
            rank: request.rank,
            learning_rate: request.learning_rate,
            steps: request.steps,
            attention_only: request.attention_only,
            four_bit: request.four_bit,
            resume: false,
            seed: request.seed,
            options: request.options.clone(),
            video: request.video.clone(),
        }
    }
}

fn job_directory(paths: &MediaRuntimePaths, id: &str) -> MediaResult<PathBuf> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("Invalid training job ID.".into());
    }
    Ok(paths.models_root()?.join("training").join(id))
}

fn validate_raw_model(path: &Path) -> MediaResult<PathBuf> {
    let root = path
        .canonicalize()
        .map_err(|_| "Choose a local KREA 2 RAW model folder.".to_string())?;
    if !root.is_dir() {
        return Err("Choose a local KREA 2 RAW model folder.".into());
    }
    let index: serde_json::Value = serde_json::from_slice(
        &fs::read(root.join("model_index.json"))
            .map_err(|_| "The selected folder has no Diffusers model_index.json.".to_string())?,
    )
    .map_err(|_| "The selected model_index.json is invalid.".to_string())?;
    if index["_class_name"].as_str() != Some("Krea2Pipeline") {
        return Err("Choose a Diffusers KREA 2 RAW model folder.".into());
    }
    if index["is_distilled"].as_bool() != Some(false) {
        return Err("Choose KREA 2 RAW for training, not Turbo.".into());
    }
    for component in ["transformer", "text_encoder", "vae"] {
        let has_weights = root.join(component).read_dir().is_ok_and(|entries| {
            entries.flatten().any(|entry| {
                entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "safetensors")
                    && entry
                        .metadata()
                        .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
            })
        });
        if !has_weights {
            return Err(format!(
                "The KREA 2 RAW model is missing {component} weights."
            ));
        }
    }
    for file in [
        "tokenizer/tokenizer.json",
        "scheduler/scheduler_config.json",
    ] {
        if !root.join(file).is_file() {
            return Err(format!("The KREA 2 RAW model is missing {file}."));
        }
    }
    Ok(root)
}

fn validate_request(request: &TrainingRequest) -> MediaResult<()> {
    if request.name.trim().is_empty() || request.name.chars().count() > 100 {
        return Err("Enter a name of up to 100 characters.".into());
    }
    if request.trigger_phrase.trim().is_empty() || request.trigger_phrase.chars().count() > 120 {
        return Err("Enter a trigger phrase of up to 120 characters.".into());
    }
    if !(3..=50).contains(&request.samples.len()) {
        return Err("Choose 3 to 50 training samples.".into());
    }
    if !(1..=10_000).contains(&request.steps)
        || ![4, 8, 16, 32, 64].contains(&request.rank)
        || ![512, 768, 1024].contains(&request.resolution)
        || !request.learning_rate.is_finite()
        || !(0.000001..=0.01).contains(&request.learning_rate)
    {
        return Err("Check the advanced training settings.".into());
    }
    if request
        .samples
        .iter()
        .any(|image| image.caption.chars().count() > 2000)
    {
        return Err("Each caption must be under 2000 characters.".into());
    }
    validate_options(request)?;
    validate_dataset_settings(request)?;
    if request.architecture != TrainingArchitecture::Krea2 {
        if request
            .model_id
            .as_deref()
            .is_none_or(|id| id.trim().is_empty())
        {
            return Err("Choose an installed base model.".into());
        }
        if request.four_bit {
            return Err("Training requires unquantized base weights.".into());
        }
    }
    Ok(())
}

fn validate_options(request: &TrainingRequest) -> MediaResult<()> {
    let options = &request.options;
    if !(1..=16).contains(&options.batch_size)
        || !(1..=64).contains(&options.gradient_accumulation)
        || options.warmup_steps > request.steps
        || !(1..=10_000).contains(&options.checkpoint_interval)
        || !(1..=20).contains(&options.checkpoint_retention)
        || [
            (options.weight_decay, 0.0, 1.0),
            (options.max_grad_norm, 0.0, 100.0),
            (options.snr_gamma, 0.0, 100.0),
            (options.noise_offset, 0.0, 1.0),
            (options.lora_dropout, 0.0, 0.5),
            (options.guidance_scale, 0.0, 20.0),
        ]
        .iter()
        .any(|(value, minimum, maximum)| !value.is_finite() || value < minimum || value > maximum)
    {
        return Err("Check the advanced training settings.".into());
    }
    if options.trainable_precision == TrainingWeightPrecision::Bf16
        && (options.method != TrainingMethod::Finetune
            || options.optimizer != TrainingOptimizer::Adafactor
            || options.precision != TrainingPrecision::Bf16)
    {
        return Err(
            "BF16 trainable weights require finetuning with Adafactor and BF16 precision.".into(),
        );
    }
    if options.optimizer == TrainingOptimizer::Adafactor && options.max_grad_norm != 0.0 {
        return Err("Disable gradient clipping when using Adafactor.".into());
    }
    if options.method == TrainingMethod::Embedding
        && (request.trigger_phrase.chars().any(char::is_whitespace)
            || options.initializer_token.trim().is_empty()
            || options.initializer_token.chars().count() > 120)
    {
        return Err("Use an embedding token without spaces and enter an initializer word.".into());
    }
    if request.architecture == TrainingArchitecture::Krea2
        && (options.method != TrainingMethod::Lora
            || options.optimizer != TrainingOptimizer::Adamw
            || options.trainable_precision != TrainingWeightPrecision::Float32
            || options.preserve_aspect_ratio
            || options.snr_gamma != 0.0
            || options.noise_offset != 0.0
            || options.lora_dropout != 0.0)
    {
        return Err("These training settings are unavailable for KREA 2 RAW.".into());
    }
    if matches!(
        request.architecture,
        TrainingArchitecture::StableDiffusion3
            | TrainingArchitecture::Flux1
            | TrainingArchitecture::Flux1Dev
            | TrainingArchitecture::Flux1Schnell
            | TrainingArchitecture::Flux2
            | TrainingArchitecture::Flux2KleinBase4B
            | TrainingArchitecture::Flux2Klein9B
            | TrainingArchitecture::Flux2KleinBase9B
            | TrainingArchitecture::Sana
            | TrainingArchitecture::ZImage
            | TrainingArchitecture::ZImageTurbo
    ) && options.snr_gamma != 0.0
    {
        return Err("Min-SNR weighting is unavailable for this flow-matching trainer.".into());
    }
    Ok(())
}

fn installed_training_model(paths: &MediaRuntimePaths, id: &str) -> MediaResult<TrainingModel> {
    let model = provider_local_diffusers::installed_model(paths, id)?;
    let architecture = match model.architecture.as_str() {
        "krea-2-raw" => {
            validate_raw_model(&model.path)?;
            TrainingArchitecture::Krea2
        }
        "krea-2" => return Err("Choose KREA 2 RAW for training, not Turbo.".into()),
        _ => serde_json::from_value(serde_json::Value::String(model.architecture.clone()))
            .map_err(|_| "The selected model has no integrated training runtime.".to_string())?,
    };
    if model.package_kind == "single-file" && model.config_path.is_none() {
        return Err("The base model configuration is missing. Reinstall the model.".into());
    }
    Ok(TrainingModel {
        id: Some(model.id),
        architecture,
        package_kind: model.package_kind,
        path: model.path,
        config_path: model.config_path,
        revision: Some(model.revision),
        digest: Some(model.digest),
    })
}

fn resolve_model(
    paths: &MediaRuntimePaths,
    request: &TrainingRequest,
) -> MediaResult<TrainingModel> {
    if request.architecture == TrainingArchitecture::Krea2 && request.model_id.is_none() {
        return Ok(TrainingModel {
            id: request.model_id.clone(),
            architecture: request.architecture,
            package_kind: "diffusers-directory".into(),
            path: validate_raw_model(&request.model_path)?,
            config_path: None,
            revision: None,
            digest: None,
        });
    }
    let id = request
        .model_id
        .as_deref()
        .ok_or("Choose an installed base model.")?;
    let model = installed_training_model(paths, id)?;
    if model.architecture != request.architecture {
        return Err("The base model does not match the selected architecture.".into());
    }
    if !request.model_path.as_os_str().is_empty() {
        let requested_path = request
            .model_path
            .canonicalize()
            .map_err(|error| format!("Could not open the selected base model: {error}"))?;
        if requested_path != model.path {
            return Err("The selected path does not match its installed model.".into());
        }
    }
    Ok(model)
}

fn validate_job_model(paths: &MediaRuntimePaths, spec: &JobSpec) -> MediaResult<()> {
    if spec.architecture != spec.model.architecture {
        return Err("The training architecture does not match the saved model.".into());
    }
    if spec.architecture == TrainingArchitecture::Krea2 && spec.model.id.is_none() {
        validate_raw_model(&spec.model.path)?;
    } else {
        let id = spec
            .model
            .id
            .as_deref()
            .ok_or("The saved base model ID is missing.")?;
        if (spec.four_bit && spec.architecture != TrainingArchitecture::Krea2)
            || installed_training_model(paths, id)? != spec.model
        {
            return Err(
                "The installed base model or training settings changed. Create a new training job."
                    .into(),
            );
        }
    }
    Ok(())
}

pub(super) fn ensure_idle(storage_root: &Path) -> MediaResult<()> {
    let directory = storage_root.join("models").join("training");
    if !directory.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        if entry.path().is_dir() && process_for_job(&entry.path())?.is_some() {
            return Err("Stop local training before moving Media Studio assets.".into());
        }
    }
    Ok(())
}

pub(crate) fn submit(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: TrainingRequest,
) -> MediaResult<TrainingJob> {
    validate_request(&request)?;
    let model = resolve_model(paths, &request)?;
    let base_model_id = if request.architecture == TrainingArchitecture::Krea2 {
        None
    } else {
        model.id.clone()
    };
    let root = paths.models_root()?.join("training");
    fs::create_dir_all(&root)
        .map_err(|error| format!("Could not create training folder: {error}"))?;
    for entry in fs::read_dir(&root)
        .map_err(|error| error.to_string())?
        .flatten()
    {
        if entry.path().is_dir() && process_for_job(&entry.path())?.is_some() {
            return Err("Another local training job is running.".into());
        }
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let id = format!("training-{stamp}-{}", std::process::id());
    let directory = job_directory(paths, &id)?;
    fs::create_dir(&directory)
        .map_err(|error| format!("Could not create training job: {error}"))?;
    let result = (|| {
        prepare_dataset(Some(app), &request, &directory.join("dataset"))?;
        let spec = JobSpec::new(&request, model);
        fs::write(
            directory.join("job.json"),
            serde_json::to_vec(&spec).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("Could not save training job: {error}"))?;
        if request.four_bit {
            let compute_dtype = match spec.options.precision {
                TrainingPrecision::Bf16 => "bfloat16",
                TrainingPrecision::Fp16 => "float16",
                TrainingPrecision::Float32 => "float32",
            };
            let quantization = serde_json::json!({
                "load_in_4bit": true,
                "bnb_4bit_quant_type": "nf4",
                "bnb_4bit_use_double_quant": true,
                "bnb_4bit_compute_dtype": compute_dtype,
            });
            fs::write(
                directory.join("quantization.json"),
                quantization.to_string(),
            )
            .map_err(|error| format!("Could not save quantization settings: {error}"))?;
        }
        validate_job_model(paths, &spec)?;
        start_process(app, paths, &directory)
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&directory);
        return Err(error);
    }
    Ok(TrainingJob {
        id,
        name: request.name.trim().into(),
        concept: request.concept,
        trigger_phrase: request.trigger_phrase.trim().into(),
        architecture: request.architecture,
        method: request.options.method,
        base_model_id,
    })
}

fn has_checkpoint(directory: &Path, architecture: TrainingArchitecture) -> bool {
    directory.join("output").read_dir().is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let checkpoint = entry.path();
            let complete = match architecture {
                TrainingArchitecture::StableDiffusionXl
                | TrainingArchitecture::Pony
                | TrainingArchitecture::StableDiffusion1
                | TrainingArchitecture::StableDiffusion2
                | TrainingArchitecture::StableDiffusion3
                | TrainingArchitecture::Flux1
                | TrainingArchitecture::Flux1Dev
                | TrainingArchitecture::Flux1Schnell
                | TrainingArchitecture::Flux2
                | TrainingArchitecture::Flux2KleinBase4B
                | TrainingArchitecture::Flux2Klein9B
                | TrainingArchitecture::Flux2KleinBase9B
                | TrainingArchitecture::Sana
                | TrainingArchitecture::ZImage
                | TrainingArchitecture::ZImageTurbo
                | TrainingArchitecture::CogVideoX2B
                | TrainingArchitecture::CogVideoX15_5B
                | TrainingArchitecture::CogVideoX15_5BI2V
                | TrainingArchitecture::Wan21T2V13B => {
                    checkpoint.join("state.pt").is_file()
                        && checkpoint.join("weights.safetensors").is_file()
                }
                TrainingArchitecture::Krea2 => checkpoint
                    .join("pytorch_lora_weights.safetensors")
                    .is_file(),
            };
            complete
                && checkpoint.is_dir()
                && entry
                    .file_name()
                    .to_str()
                    .and_then(|name| name.strip_prefix("checkpoint-"))
                    .is_some_and(|step| step.parse::<u32>().is_ok())
        })
    })
}

fn completed_steps_from_log(path: &Path) -> Option<u32> {
    let mut file = File::open(path).ok()?;
    let start = file.metadata().ok()?.len().saturating_sub(128 * 1024);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let tail = String::from_utf8_lossy(&bytes);
    tail.split("Steps:")
        .skip(1)
        .filter_map(|segment| {
            segment.split_whitespace().find_map(|token| {
                let (completed, total) = token
                    .trim_matches(|character: char| !character.is_ascii_digit() && character != '/')
                    .split_once('/')?;
                total.parse::<u32>().ok()?;
                completed.parse::<u32>().ok()
            })
        })
        .last()
}

pub(crate) fn status(paths: &MediaRuntimePaths, id: &str) -> MediaResult<TrainingStatus> {
    let directory = job_directory(paths, id)?;
    let spec: JobSpec = serde_json::from_slice(
        &fs::read(directory.join("job.json"))
            .map_err(|error| format!("Could not read training job: {error}"))?,
    )
    .map_err(|error| format!("Training job is invalid: {error}"))?;
    let runner = match fs::read(directory.join("status.json")) {
        Ok(bytes) => serde_json::from_slice::<RunnerStatus>(&bytes)
            .map_err(|error| format!("Could not read training status: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => RunnerStatus {
            state: "starting".into(),
            message: None,
        },
        Err(error) => return Err(format!("Could not read training status: {error}")),
    };
    let output = directory.join("output").join(match spec.options.method {
        TrainingMethod::Lora => "pytorch_lora_weights.safetensors",
        TrainingMethod::Embedding => "learned_embeds.safetensors",
        TrainingMethod::Finetune => "model",
    });
    let output_exists = if spec.options.method == TrainingMethod::Finetune {
        output.join("model_index.json").is_file()
    } else {
        output.is_file()
    };
    let missing_output = runner.state == "completed" && !output_exists;
    let state = if missing_output {
        "failed".to_string()
    } else if ["starting", "running"].contains(&runner.state.as_str())
        && process_for_job(&directory)?.is_none()
    {
        "interrupted".to_string()
    } else {
        runner.state
    };
    let can_resume = ["interrupted", "failed", "cancelled"].contains(&state.as_str())
        && has_checkpoint(&directory, spec.architecture);
    Ok(TrainingStatus {
        message: if missing_output {
            Some("Trained weights are missing. Remove this job and train again.".into())
        } else if matches!(state.as_str(), "failed" | "running") {
            runner.message
        } else {
            None
        },
        output_path: (state == "completed").then_some(output),
        completed_steps: if state == "completed" {
            Some(spec.steps)
        } else {
            completed_steps_from_log(&directory.join("training.log"))
        },
        total_steps: spec.steps,
        progress: if directory.join("progress.json").is_file() {
            Some(
                serde_json::from_slice(
                    &fs::read(directory.join("progress.json"))
                        .map_err(|error| format!("Could not read training progress: {error}"))?,
                )
                .map_err(|error| format!("Training progress is invalid: {error}"))?,
            )
        } else {
            None
        },
        state,
        can_resume,
    })
}

pub(crate) fn cancel(paths: &MediaRuntimePaths, id: &str) -> MediaResult<()> {
    let directory = job_directory(paths, id)?;
    if let Some((_, pid)) = process_for_job(&directory)? {
        if !terminate_child_process_tree_by_id(pid.as_u32()) {
            return Err("Could not stop local training.".into());
        }
    }
    fs::write(
        directory.join("status.json"),
        br#"{"state":"cancelled","message":null}"#,
    )
    .map_err(|error| format!("Could not save training status: {error}"))
}

pub(crate) fn resume(app: &AppHandle, paths: &MediaRuntimePaths, id: &str) -> MediaResult<()> {
    let directory = job_directory(paths, id)?;
    if process_for_job(&directory)?.is_some() {
        return Err("Training is already running.".into());
    }
    for entry in fs::read_dir(paths.models_root()?.join("training"))
        .map_err(|error| format!("Could not read training jobs: {error}"))?
        .flatten()
    {
        if entry.path() != directory
            && entry.path().is_dir()
            && process_for_job(&entry.path())?.is_some()
        {
            return Err("Another local training job is running.".into());
        }
    }
    if !status(paths, id)?.can_resume {
        return Err("This job has no resumable training checkpoint.".into());
    }
    let mut spec: JobSpec = serde_json::from_slice(
        &fs::read(directory.join("job.json"))
            .map_err(|error| format!("Could not read training job: {error}"))?,
    )
    .map_err(|error| format!("Training job is invalid: {error}"))?;
    validate_job_model(paths, &spec)?;
    spec.resume = true;
    fs::write(
        directory.join("job.json"),
        serde_json::to_vec(&spec).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Could not save training job: {error}"))?;
    start_process(app, paths, &directory)
}

pub(crate) fn remove_job(paths: &MediaRuntimePaths, id: &str) -> MediaResult<()> {
    let directory = job_directory(paths, id)?;
    if process_for_job(&directory)?.is_some() {
        return Err("Stop training before removing the job.".into());
    }
    fs::remove_dir_all(directory)
        .map_err(|error| format!("Could not remove training files: {error}"))
}

#[cfg(test)]
#[path = "training_tests.rs"]
mod tests;
