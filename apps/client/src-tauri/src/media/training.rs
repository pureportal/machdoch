use std::{
    fs::{self, File, OpenOptions},
    io::{Cursor, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use image::{ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use sysinfo::{Pid, System};
use tauri::{AppHandle, Manager};

use crate::child_process::{terminate_child_process_tree_by_id, SupervisedChild};

use super::{provider_local_diffusers, runtime_setup, MediaResult, MediaRuntimePaths};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
pub(crate) enum TrainingArchitecture {
    #[serde(rename = "krea-2")]
    Krea2,
    #[serde(rename = "stable-diffusion-xl")]
    StableDiffusionXl,
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
pub(crate) struct TrainingImage {
    path: PathBuf,
    caption: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingImageInspection {
    path: PathBuf,
    width: u32,
    height: u32,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TrainingRequest {
    name: String,
    concept: TrainingConcept,
    trigger_phrase: String,
    images: Vec<TrainingImage>,
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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrainingJob {
    id: String,
    name: String,
    concept: TrainingConcept,
    trigger_phrase: String,
    architecture: TrainingArchitecture,
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
    precision: String,
    resolution: u32,
    rank: u32,
    learning_rate: f64,
    steps: u32,
    checkpoint_interval: u32,
    attention_only: bool,
    four_bit: bool,
    resume: bool,
    seed: u32,
}

impl JobSpec {
    fn new(request: &TrainingRequest, model: TrainingModel) -> Self {
        Self {
            architecture: request.architecture,
            model,
            trigger_phrase: request.trigger_phrase.trim().into(),
            precision: if cfg!(target_os = "macos") {
                "fp16"
            } else {
                "bf16"
            }
            .into(),
            resolution: request.resolution,
            rank: request.rank,
            learning_rate: request.learning_rate,
            steps: request.steps,
            checkpoint_interval: (request.steps / 4).clamp(1, 250),
            attention_only: request.attention_only,
            four_bit: request.four_bit,
            resume: false,
            seed: request.seed,
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

fn runner_script(app: &AppHandle) -> MediaResult<PathBuf> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("python")
        .join("media_training.py");
    if resource.is_file() {
        return Ok(resource);
    }
    #[cfg(debug_assertions)]
    {
        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("media_training.py");
        if development.is_file() {
            return Ok(development);
        }
    }
    Err("The local trainer is missing. Reinstall Media Studio.".into())
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
    if !(3..=50).contains(&request.images.len()) {
        return Err("Choose 3 to 50 images.".into());
    }
    if !(1..=10_000).contains(&request.steps)
        || ![4, 8, 16, 32, 64].contains(&request.rank)
        || ![512, 768, 1024].contains(&request.resolution)
        || !request.learning_rate.is_finite()
        || !(0.00001..=0.001).contains(&request.learning_rate)
    {
        return Err("Check the advanced training settings.".into());
    }
    if request
        .images
        .iter()
        .any(|image| image.caption.chars().count() > 2000)
    {
        return Err("Each caption must be under 2000 characters.".into());
    }
    if request.architecture == TrainingArchitecture::StableDiffusionXl {
        if request
            .model_id
            .as_deref()
            .is_none_or(|id| id.trim().is_empty())
        {
            return Err("Choose an installed SDXL model.".into());
        }
        if request.four_bit || !request.attention_only {
            return Err(
                "SDXL training requires attention-only LoRA without four-bit quantization.".into(),
            );
        }
    }
    Ok(())
}

fn installed_sdxl_model(paths: &MediaRuntimePaths, id: &str) -> MediaResult<TrainingModel> {
    let model = provider_local_diffusers::installed_model(paths, id)?;
    if model.architecture != "stable-diffusion-xl" {
        return Err("The selected model is not SDXL.".into());
    }
    if model.package_kind == "single-file" && model.config_path.is_none() {
        return Err("The installed SDXL configuration is missing. Reinstall the model.".into());
    }
    Ok(TrainingModel {
        id: Some(model.id),
        architecture: TrainingArchitecture::StableDiffusionXl,
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
    match request.architecture {
        TrainingArchitecture::Krea2 => Ok(TrainingModel {
            id: request.model_id.clone(),
            architecture: request.architecture,
            package_kind: "diffusers-directory".into(),
            path: validate_raw_model(&request.model_path)?,
            config_path: None,
            revision: None,
            digest: None,
        }),
        TrainingArchitecture::StableDiffusionXl => {
            let id = request
                .model_id
                .as_deref()
                .ok_or("Choose an installed SDXL model.")?;
            let model = installed_sdxl_model(paths, id)?;
            if !request.model_path.as_os_str().is_empty() {
                let requested_path = request
                    .model_path
                    .canonicalize()
                    .map_err(|error| format!("Could not open the selected SDXL model: {error}"))?;
                if requested_path != model.path {
                    return Err("The selected SDXL path does not match its installed model.".into());
                }
            }
            Ok(model)
        }
    }
}

fn validate_job_model(paths: &MediaRuntimePaths, spec: &JobSpec) -> MediaResult<()> {
    if spec.architecture != spec.model.architecture {
        return Err("The training architecture does not match the saved model.".into());
    }
    match spec.architecture {
        TrainingArchitecture::Krea2 => {
            validate_raw_model(&spec.model.path)?;
        }
        TrainingArchitecture::StableDiffusionXl => {
            let id = spec
                .model
                .id
                .as_deref()
                .ok_or("The saved SDXL model ID is missing.")?;
            if spec.four_bit
                || !spec.attention_only
                || installed_sdxl_model(paths, id)? != spec.model
            {
                return Err("The installed SDXL model or training settings changed. Create a new training job.".into());
            }
        }
    }
    Ok(())
}

fn image_extension(path: &Path, bytes: &[u8]) -> MediaResult<(&'static str, ImageFormat)> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok(("png", ImageFormat::Png)),
        "jpg" | "jpeg" if bytes.starts_with(b"\xff\xd8\xff") => Ok(("jpg", ImageFormat::Jpeg)),
        "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            Ok(("webp", ImageFormat::WebP))
        }
        _ => Err(format!(
            "{} must be a PNG, JPEG, or WebP image.",
            path.display()
        )),
    }
}

fn read_training_image(path: &Path) -> MediaResult<(Vec<u8>, &'static str, u32, u32)> {
    let size = fs::metadata(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?
        .len();
    if size == 0 || size > 20 * 1024 * 1024 {
        return Err(format!("{} must be under 20 MB.", path.display()));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let (extension, format) = image_extension(path, &bytes)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes.as_slice()), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| {
        format!(
            "{} could not be decoded. Choose another image.",
            path.display()
        )
    })?;
    Ok((bytes, extension, decoded.width(), decoded.height()))
}

pub(crate) fn inspect_images(paths: Vec<PathBuf>) -> MediaResult<Vec<TrainingImageInspection>> {
    if paths.len() > 50 {
        return Err("Choose up to 50 images.".into());
    }
    paths
        .into_iter()
        .map(|path| {
            let (_, _, width, height) = read_training_image(&path)?;
            Ok(TrainingImageInspection {
                path,
                width,
                height,
            })
        })
        .collect()
}

fn prepare_dataset(request: &TrainingRequest, directory: &Path) -> MediaResult<()> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create training dataset: {error}"))?;
    let mut metadata = File::create(directory.join("metadata.jsonl"))
        .map_err(|error| format!("Could not create training captions: {error}"))?;
    for (index, image) in request.images.iter().enumerate() {
        let (bytes, extension, _, _) = read_training_image(&image.path)?;
        let file_name = format!("image-{index:03}.{extension}");
        fs::write(directory.join(&file_name), bytes)
            .map_err(|error| format!("Could not copy training image: {error}"))?;
        let trigger = request.trigger_phrase.trim();
        let caption = image.caption.trim();
        let text = if caption.is_empty() {
            trigger.to_string()
        } else if caption.to_lowercase().contains(&trigger.to_lowercase()) {
            caption.to_string()
        } else {
            format!("{caption}, {trigger}")
        };
        writeln!(
            metadata,
            "{}",
            serde_json::json!({ "file_name": file_name, "text": text })
        )
        .map_err(|error| format!("Could not save training captions: {error}"))?;
    }
    Ok(())
}

fn process_for_job(directory: &Path) -> MediaResult<Option<(System, Pid)>> {
    let pid: u32 = match fs::read_to_string(directory.join("pid")) {
        Ok(value) => value
            .trim()
            .parse()
            .map_err(|_| "Training process ID is invalid.")?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read training process ID: {error}")),
    };
    let system = System::new_all();
    let pid = Pid::from_u32(pid);
    let Some(process) = system.process(pid) else {
        return Ok(None);
    };
    let expected = directory.to_string_lossy();
    if !process
        .cmd()
        .iter()
        .any(|argument| argument.to_string_lossy() == expected)
    {
        return Ok(None);
    }
    Ok(Some((system, pid)))
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

fn start_process(app: &AppHandle, paths: &MediaRuntimePaths, directory: &Path) -> MediaResult<()> {
    let python = runtime_setup::python_path(&runtime_setup::root(app)?);
    if !python.is_file() {
        return Err("Install the Media Studio local model runtime before training.".into());
    }
    let script = runner_script(app)?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("training.log"))
        .map_err(|error| format!("Could not open training log: {error}"))?;
    let error_log = log.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(python);
    command
        .arg("-I")
        .arg("-B")
        .arg("-Xutf8")
        .arg(script)
        .arg(directory)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(error_log)
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_DATASETS_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("WANDB_DISABLED", "true")
        .env("DO_NOT_TRACK", "1")
        .env_remove("HF_TOKEN")
        .env_remove("HUGGING_FACE_HUB_TOKEN")
        .env_remove("WANDB_API_KEY");
    provider_local_diffusers::configure_preferred_gpu(&mut command);
    fs::write(
        directory.join("status.json"),
        serde_json::to_vec(&RunnerStatus {
            state: "starting".into(),
            message: None,
        })
        .map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Could not save training status: {error}"))?;
    let (started, receiver) = std::sync::mpsc::sync_channel(1);
    let storage_lease = paths.clone();
    std::thread::spawn(move || {
        let _storage_lease = storage_lease;
        let mut child = match SupervisedChild::spawn(&mut command) {
            Ok(child) => child,
            Err(error) => {
                let _ = started.send(Err(format!("Could not start local training: {error}")));
                return;
            }
        };
        if started.send(Ok(child.id())).is_err() {
            return;
        }
        let _ = child.wait();
    });
    let pid = receiver
        .recv()
        .map_err(|error| format!("Could not start local training: {error}"))??;
    if let Err(error) = fs::write(directory.join("pid"), pid.to_string()) {
        terminate_child_process_tree_by_id(pid);
        return Err(format!("Could not save training process ID: {error}"));
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
        prepare_dataset(&request, &directory.join("dataset"))?;
        let spec = JobSpec::new(&request, model);
        fs::write(
            directory.join("job.json"),
            serde_json::to_vec(&spec).map_err(|error| error.to_string())?,
        )
        .map_err(|error| format!("Could not save training job: {error}"))?;
        if request.four_bit {
            let compute_dtype = if spec.precision == "bf16" {
                "bfloat16"
            } else {
                "float16"
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
    })
}

fn has_checkpoint(directory: &Path, architecture: TrainingArchitecture) -> bool {
    directory.join("output").read_dir().is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            let checkpoint = entry.path();
            let complete = match architecture {
                TrainingArchitecture::StableDiffusionXl => {
                    checkpoint.join("state.pt").is_file()
                        && checkpoint.join("adapter.safetensors").is_file()
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
    let bytes = fs::read(path).ok()?;
    let tail = String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(128 * 1024)..]);
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
    let output = directory
        .join("output")
        .join("pytorch_lora_weights.safetensors");
    let missing_output = runner.state == "completed" && !output.is_file();
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
            Some("Trained LoRA weights are missing. Remove this job and train again.".into())
        } else if state == "failed" {
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
