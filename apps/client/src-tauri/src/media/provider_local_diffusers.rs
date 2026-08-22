use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write as _,
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime},
};

use rusqlite::{params, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Manager as _};

use crate::child_process::{
    assign_child_process_to_kill_on_close_job, configure_child_process_group,
    terminate_child_process_tree,
};

use super::{
    database, model_addon, model_import,
    provider_openai::{self, GeneratedImageAsset},
    subject_cutout, transform, GenerateMediaImagesRequest, GenerateMediaVideoRequest,
    MediaAnimatedBackgroundConfig, MediaEmbeddingVectorProfile, MediaImageMask,
    MediaImageReference, MediaLoraDenoisingSchedule, MediaLoraTensorProfile,
    MediaModelAddonSelection, MediaModelDescriptor, MediaResult, MediaRuntimePaths,
};

const WORKER_SCHEMA_VERSION: u32 = 5;
// Importing the pinned ROCm stack takes roughly 45 seconds on the reference
// machine and can take materially longer while a hot-reload build is linking
// or Windows is reclaiming memory after generation.
// Treat that startup delay as expected instead of falling through to an
// unrelated global Python installation.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3 * 60);
const MODEL_PROBE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const GENERATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const VIDEO_GENERATION_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
const MAX_WORKER_RESPONSE_BYTES: usize = 2 * 1_024 * 1_024;
const MAX_WORKER_DIAGNOSTIC_BYTES: usize = 256 * 1_024;
const MAX_IMAGE_BYTES: usize = 64 * 1_024 * 1_024;
const MAX_VIDEO_BYTES: usize = 512 * 1_024 * 1_024;
const MAX_DECODED_LOOP_CONTINUITY_RATIO: f64 = 1.25;
const REFERENCE_EDIT_PIXEL_DELTA_THRESHOLD: f64 = 8.0;
const REFERENCE_EDIT_MIN_CHANGED_PIXEL_RATIO: f64 = 0.01;
const REFERENCE_EDIT_MIN_MEAN_ABSOLUTE_DIFFERENCE: f64 = 3.0;
// A nominal 16 GB adapter reports slightly less usable memory after the
// display driver reserves VRAM. Keep the bounded CPU-offload profile honest
// while accepting those adapters instead of requiring a full 16 GiB report.
const MIN_EXPERIMENTAL_VIDEO_MEMORY_BYTES: u64 = 15 * 1_024 * 1_024 * 1_024;
const MIN_HUNYUAN_VIDEO_15_MEMORY_BYTES: u64 = 14 * 1_024 * 1_024 * 1_024;
const MIN_FRAMEPACK_MEMORY_BYTES: u64 = 6 * 1_024 * 1_024 * 1_024;
static RUNTIME_PROBE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static PREFERRED_HIP_VISIBLE_DEVICE: OnceLock<String> = OnceLock::new();
static VERIFIED_MODEL_FILES: OnceLock<Mutex<HashMap<PathBuf, VerifiedModelFile>>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
struct VerifiedModelFile {
    expected_digest: String,
    byte_size: u64,
    modified_at: SystemTime,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDiffusersRuntimeStatus {
    pub(crate) status: String,
    pub(crate) ready: bool,
    pub(crate) worker_version: Option<String>,
    pub(crate) python_version: Option<String>,
    pub(crate) packages: HashMap<String, Option<String>>,
    pub(crate) device: Option<String>,
    pub(crate) device_label: Option<String>,
    pub(crate) device_memory_bytes: Option<u64>,
    pub(crate) physical_memory_bytes: Option<u64>,
    pub(crate) architectures: Vec<String>,
    pub(crate) capabilities: Vec<String>,
    pub(crate) diagnostic: String,
}

impl LocalDiffusersRuntimeStatus {
    fn unavailable(diagnostic: impl Into<String>) -> Self {
        Self {
            status: "unavailable".to_string(),
            ready: false,
            worker_version: None,
            python_version: None,
            packages: HashMap::new(),
            device: None,
            device_label: None,
            device_memory_bytes: None,
            physical_memory_bytes: None,
            architectures: Vec::new(),
            capabilities: Vec::new(),
            diagnostic: diagnostic.into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerProbe {
    schema_version: u32,
    worker_version: String,
    ready: bool,
    python_version: String,
    #[serde(default)]
    packages: HashMap<String, Option<String>>,
    device: Option<String>,
    device_label: Option<String>,
    device_memory_bytes: Option<u64>,
    physical_memory_bytes: Option<u64>,
    #[serde(default)]
    architectures: Vec<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    diagnostic: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerModel<'a> {
    id: &'a str,
    architecture: &'a str,
    package_kind: &'a str,
    path: &'a Path,
    #[serde(skip_serializing_if = "Option::is_none")]
    config_path: Option<&'a Path>,
    revision: &'a str,
    digest: &'a str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerAddon<'a> {
    kind: &'a str,
    addon_id: &'a str,
    enabled: bool,
    path: &'a Path,
    digest: &'a str,
    target_components: &'a [String],
    embedding_vectors: &'a [MediaEmbeddingVectorProfile],
    #[serde(skip_serializing_if = "Option::is_none")]
    lora_profile: Option<&'a MediaLoraTensorProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_encoder_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    denoising_schedule: Option<&'a MediaLoraDenoisingSchedule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    placement: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerGenerationRequest<'a> {
    schema_version: u32,
    model: WorkerModel<'a>,
    prompt: &'a str,
    negative_prompt: &'a str,
    output_count: u32,
    output_format: &'a str,
    model_policy: &'a str,
    aspect_ratio: &'a str,
    seed: u64,
    output_directory: &'a Path,
    addons: Vec<WorkerAddon<'a>>,
    reference_images: Vec<WorkerReferenceImage<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    base_image_path: Option<&'a Path>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edit_mask: Option<&'a MediaImageMask>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pose_image_path: Option<&'a Path>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pose_controlnet_path: Option<&'a Path>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pose_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pose_start: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pose_end: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edit_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    mask_strength: Option<f64>,
    require_chroma_background: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_profile: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerReferenceImage<'a> {
    path: &'a Path,
    role: &'a str,
    influence: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerVideoGenerationRequest<'a> {
    schema_version: u32,
    model: WorkerModel<'a>,
    prompt: &'a str,
    first_frame_path: &'a Path,
    last_frame_path: &'a Path,
    aspect_ratio: &'a str,
    resolution: &'a str,
    num_frames: u32,
    num_inference_steps: u32,
    guidance_scale: f64,
    negative_prompt: &'a str,
    transparent_background: bool,
    loop_mode: &'a str,
    matte_quality: &'a str,
    encoding_quality: &'a str,
    memory_profile: &'a str,
    fps: u32,
    seed: u64,
    experimental_low_memory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    animated_background: Option<&'a MediaAnimatedBackgroundConfig>,
    output_directory: &'a Path,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerModelProbeRequest<'a> {
    schema_version: u32,
    model: WorkerModel<'a>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerOutputRecord {
    index: u32,
    file_name: String,
    seed: u64,
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerGenerationResponse {
    schema_version: u32,
    worker_version: String,
    #[serde(default)]
    packages: HashMap<String, Option<String>>,
    device: String,
    device_label: String,
    device_memory_bytes: Option<u64>,
    prompt: String,
    negative_prompt: String,
    model_policy: String,
    aspect_ratio: String,
    num_inference_steps: u32,
    #[serde(default)]
    addons: Vec<serde_json::Value>,
    #[serde(default)]
    performance: Option<serde_json::Value>,
    #[serde(default)]
    require_chroma_background: bool,
    #[serde(default)]
    edit_conditioning: Option<serde_json::Value>,
    outputs: Vec<WorkerOutputRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalWanOutputProvenance {
    pub(crate) index: u32,
    file_name: String,
    pub(crate) seed: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) frame_count: u32,
    pub(crate) source_frame_count: u32,
    pub(crate) fps: u32,
    pub(crate) duration_seconds: f64,
    pub(crate) alpha_minimum: u32,
    pub(crate) alpha_maximum: u32,
    pub(crate) decoded_alpha_minimum: u32,
    pub(crate) decoded_alpha_maximum: u32,
    pub(crate) decoded_frame_count: u32,
    pub(crate) decoded_loop_endpoint_mae: f64,
    pub(crate) decoded_loop_boundary_reference_mae: f64,
    pub(crate) decoded_loop_boundary_continuity_ratio: f64,
    pub(crate) decoded_alpha_loop_endpoint_mae: f64,
    pub(crate) decoded_alpha_loop_boundary_reference_mae: f64,
    pub(crate) decoded_alpha_loop_boundary_continuity_ratio: f64,
    pub(crate) decoded_rgb_encoding_mae: f64,
    pub(crate) decoded_rgb_encoding_maximum_error: u32,
    pub(crate) loop_mode: String,
    pub(crate) loop_endpoint_mae: f64,
    pub(crate) loop_boundary_reference_mae: f64,
    pub(crate) loop_boundary_continuity_ratio: f64,
    pub(crate) has_alpha: bool,
    pub(crate) matte: Option<serde_json::Value>,
    pub(crate) encoding_quality: String,
    pub(crate) pixel_format: String,
    pub(crate) color_range: String,
    pub(crate) codec: String,
    pub(crate) container: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalWanAnimatedBackgroundEvidence {
    pub(crate) engine: String,
    pub(crate) style: String,
    pub(crate) direction: String,
    pub(crate) color_start: String,
    pub(crate) color_end: String,
    pub(crate) cycles: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalWanCompositeOutputProvenance {
    pub(crate) index: u32,
    file_name: String,
    pub(crate) seed: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) frame_count: u32,
    pub(crate) fps: u32,
    pub(crate) duration_seconds: f64,
    pub(crate) has_alpha: bool,
    pub(crate) loop_mode: String,
    pub(crate) loop_endpoint_mae: f64,
    pub(crate) loop_boundary_reference_mae: f64,
    pub(crate) loop_boundary_continuity_ratio: f64,
    pub(crate) decoded_frame_count: u32,
    pub(crate) decoded_loop_endpoint_mae: f64,
    pub(crate) decoded_loop_boundary_reference_mae: f64,
    pub(crate) decoded_loop_boundary_continuity_ratio: f64,
    pub(crate) decoded_rgb_encoding_mae: f64,
    pub(crate) decoded_rgb_encoding_maximum_error: u32,
    pub(crate) encoding_quality: String,
    pub(crate) pixel_format: String,
    pub(crate) color_range: String,
    pub(crate) codec: String,
    pub(crate) container: String,
    pub(crate) background: LocalWanAnimatedBackgroundEvidence,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalWanEndpointRestorationEvidence {
    pub(crate) engine: String,
    pub(crate) start_frame: u32,
    pub(crate) frame_count: u32,
    pub(crate) exact_endpoint_frame: bool,
    #[serde(default)]
    pub(crate) easing: Option<String>,
    pub(crate) low_percentile: u32,
    pub(crate) high_percentile: u32,
    pub(crate) channel_scales: Vec<f64>,
    pub(crate) channel_offsets: Vec<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerVideoGenerationResponse {
    schema_version: u32,
    worker_version: String,
    #[serde(default)]
    packages: HashMap<String, Option<String>>,
    device: String,
    device_label: String,
    device_memory_bytes: Option<u64>,
    architecture: String,
    #[serde(default)]
    performance: Option<serde_json::Value>,
    conv3d_backend: String,
    conditioning_mode: String,
    #[serde(default)]
    conditioning_framing: Option<serde_json::Value>,
    #[serde(default)]
    endpoint_restoration: Option<LocalWanEndpointRestorationEvidence>,
    #[serde(default)]
    loop_endpoint_restoration: Option<serde_json::Value>,
    prompt: String,
    negative_prompt: String,
    #[serde(default)]
    negative_prompt_applied: bool,
    resolution: String,
    #[serde(default)]
    requested_guidance_scale: Option<f64>,
    guidance_scale: f64,
    #[serde(default)]
    requested_num_inference_steps: Option<u32>,
    num_inference_steps: u32,
    transparent_background: bool,
    model_revision: String,
    model_digest: String,
    output: LocalWanOutputProvenance,
    #[serde(default)]
    composite_output: Option<LocalWanCompositeOutputProvenance>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkerEmbeddingVectorEvidence {
    component: String,
    tensor_key: String,
    vector_count: u32,
    dimension: u32,
    registered_tokens: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerModelProbeResponse {
    schema_version: u32,
    worker_version: String,
    #[serde(default)]
    packages: HashMap<String, Option<String>>,
    ready: bool,
    architecture: String,
    pipeline_class: String,
    #[serde(default)]
    components: Vec<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    device: String,
    device_label: String,
    device_memory_bytes: Option<u64>,
    diagnostic: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerFailure {
    error: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDiffusersProvenance {
    pub(crate) worker_version: String,
    pub(crate) packages: HashMap<String, Option<String>>,
    pub(crate) device: String,
    pub(crate) device_label: String,
    pub(crate) device_memory_bytes: Option<u64>,
    pub(crate) model_revision: String,
    pub(crate) model_digest: String,
    pub(crate) prompt: String,
    pub(crate) negative_prompt: String,
    pub(crate) model_policy: String,
    pub(crate) aspect_ratio: String,
    pub(crate) num_inference_steps: u32,
    pub(crate) addons: Vec<serde_json::Value>,
    pub(crate) performance: Option<serde_json::Value>,
    pub(crate) require_chroma_background: bool,
    pub(crate) edit_conditioning: Option<serde_json::Value>,
    pub(crate) conditioning_sources: Vec<LocalConditioningSource>,
    pub(crate) outputs: Vec<LocalDiffusersOutputProvenance>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalConditioningSource {
    pub(crate) asset_id: String,
    pub(crate) digest: String,
    pub(crate) role: String,
    pub(crate) influence: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalModelRuntimeProbeResult {
    pub(crate) schema_version: u32,
    pub(crate) model_id: String,
    pub(crate) revision: String,
    pub(crate) status: String,
    pub(crate) diagnostic: String,
    pub(crate) checked_at: String,
    pub(crate) worker_version: Option<String>,
    pub(crate) pipeline_class: Option<String>,
    pub(crate) device_label: Option<String>,
    pub(crate) components: Vec<String>,
    pub(crate) capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalDiffusersOutputProvenance {
    pub(crate) index: u32,
    pub(crate) source_index: u32,
    pub(crate) seed: u64,
    pub(crate) branch_id: String,
    pub(crate) output_node_id: String,
    pub(crate) format: String,
    pub(crate) quality: u8,
    pub(crate) jpeg_background: String,
    pub(crate) post_processing: Vec<super::MediaImagePostProcessingOperation>,
}

#[derive(Debug)]
pub(crate) struct LocalGeneratedImageBatch {
    pub(crate) assets: Vec<GeneratedImageAsset>,
    pub(crate) provenance: LocalDiffusersProvenance,
}

#[derive(Debug)]
pub(crate) struct LocalGeneratedVideo {
    pub(crate) digest: String,
    pub(crate) relative_path: String,
    pub(crate) byte_size: u64,
    pub(crate) first_frame_digest: String,
    pub(crate) last_frame_digest: String,
    pub(crate) worker_version: String,
    pub(crate) packages: HashMap<String, Option<String>>,
    pub(crate) device: String,
    pub(crate) device_label: String,
    pub(crate) device_memory_bytes: Option<u64>,
    pub(crate) architecture: String,
    pub(crate) performance: Option<serde_json::Value>,
    pub(crate) conv3d_backend: String,
    pub(crate) conditioning_mode: String,
    pub(crate) conditioning_framing: Option<serde_json::Value>,
    pub(crate) endpoint_restoration: Option<LocalWanEndpointRestorationEvidence>,
    pub(crate) loop_endpoint_restoration: Option<serde_json::Value>,
    pub(crate) model_revision: String,
    pub(crate) model_digest: String,
    pub(crate) prompt: String,
    pub(crate) negative_prompt: String,
    pub(crate) negative_prompt_applied: bool,
    pub(crate) resolution: String,
    pub(crate) guidance_scale: f64,
    pub(crate) num_inference_steps: u32,
    pub(crate) transparent_background: bool,
    pub(crate) memory_profile: String,
    pub(crate) output: LocalWanOutputProvenance,
    pub(crate) composite_digest: Option<String>,
    pub(crate) composite_relative_path: Option<String>,
    pub(crate) composite_byte_size: Option<u64>,
    pub(crate) composite_output: Option<LocalWanCompositeOutputProvenance>,
}

struct InstalledModel {
    id: String,
    architecture: String,
    package_kind: String,
    path: PathBuf,
    config_path: Option<PathBuf>,
    revision: String,
    digest: String,
}

struct ResolvedAddon {
    kind: String,
    id: String,
    path: PathBuf,
    digest: String,
    target_components: Vec<String>,
    embedding_vectors: Vec<MediaEmbeddingVectorProfile>,
    lora_profile: Option<MediaLoraTensorProfile>,
    model_strength: Option<f64>,
    text_encoder_strength: Option<f64>,
    denoising_schedule: Option<MediaLoraDenoisingSchedule>,
    token: Option<String>,
    placement: Option<String>,
}

struct StagingDirectory(PathBuf);

impl Drop for StagingDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn worker_script(app: &AppHandle) -> MediaResult<PathBuf> {
    let resource_path = app
        .path()
        .resource_dir()
        .map_err(|error| format!("failed to resolve application resources: {error}"))?
        .join("python")
        .join("media_diffusers_worker.py");
    if resource_path.is_file() {
        return Ok(resource_path);
    }
    #[cfg(debug_assertions)]
    {
        let development_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("python")
            .join("media_diffusers_worker.py");
        if development_path.is_file() {
            return Ok(development_path);
        }
    }
    Err("The bundled local Diffusers worker is missing; reinstall the application.".to_string())
}

fn python_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        #[cfg(windows)]
        candidates.push(
            resource_dir
                .join("python")
                .join("runtime")
                .join("python.exe"),
        );
        #[cfg(not(windows))]
        candidates.push(
            resource_dir
                .join("python")
                .join("runtime")
                .join("bin")
                .join("python3"),
        );
    }
    #[cfg(debug_assertions)]
    {
        #[cfg(windows)]
        candidates.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("python")
                .join("runtime")
                .join("Scripts")
                .join("python.exe"),
        );
        #[cfg(not(windows))]
        candidates.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("python")
                .join("runtime")
                .join("bin")
                .join("python3"),
        );
    }
    #[cfg(windows)]
    candidates.push(PathBuf::from("python"));
    #[cfg(not(windows))]
    {
        candidates.push(PathBuf::from("python3"));
        candidates.push(PathBuf::from("python"));
    }
    candidates
}

fn run_worker(
    python: &Path,
    script: &Path,
    command: &str,
    stdin: Option<&[u8]>,
    timeout: Duration,
    cancellation: Option<(&MediaRuntimePaths, &str)>,
) -> MediaResult<Output> {
    let mut worker = Command::new(python);
    worker
        .arg("-I")
        .arg("-B")
        .arg(script)
        .arg(command)
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("DO_NOT_TRACK", "1")
        // MIOpen's default exhaustive convolution search can fail VAE decode
        // on RDNA 4 with `miopenStatusUnknownError`. The normal search mode is
        // deterministic for these fixed shapes and succeeds on the reference
        // RX 9070 while retaining GPU execution.
        .env("MIOPEN_FIND_MODE", "2")
        .env_remove("HF_TOKEN")
        .env_remove("HUGGING_FACE_HUB_TOKEN");
    if let Some(index) = PREFERRED_HIP_VISIBLE_DEVICE.get() {
        // On hybrid AMD systems, selecting cuda:N after HIP initializes is not
        // sufficient: large Qwen kernels can still fault while both adapters
        // share the process. Isolate the discrete adapter before Torch loads;
        // it is then exposed to the worker as cuda:0.
        worker
            .env("HIP_VISIBLE_DEVICES", index)
            .env("MACHDOCH_MEDIA_CUDA_DEVICE", "0");
    }
    configure_child_process_group(&mut worker);
    let mut process = worker
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start local Diffusers worker: {error}"))?;
    let _worker_job = assign_child_process_to_kill_on_close_job(&process).map_err(|error| {
        terminate_child_process_tree(&mut process);
        let _ = process.wait();
        format!("failed to isolate local Diffusers worker: {error}")
    })?;
    if let Some(input) = stdin {
        process
            .stdin
            .take()
            .ok_or_else(|| "local Diffusers worker stdin is unavailable".to_string())?
            .write_all(input)
            .map_err(|error| format!("failed to write local Diffusers request: {error}"))?;
    }
    let started = Instant::now();
    let mut next_cancellation_check = started;
    loop {
        if let Some((paths, run_id)) = cancellation {
            if Instant::now() >= next_cancellation_check {
                if database::is_cancellation_requested(paths, run_id)? {
                    terminate_child_process_tree(&mut process);
                    let _ = process.wait();
                    return Err("local Diffusers generation was canceled".to_string());
                }
                next_cancellation_check = Instant::now() + Duration::from_millis(500);
            }
        }
        match process.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                terminate_child_process_tree(&mut process);
                let _ = process.wait();
                return Err("local Diffusers worker exceeded its execution deadline".to_string());
            }
            Err(error) => {
                terminate_child_process_tree(&mut process);
                let _ = process.wait();
                return Err(format!("failed to inspect local Diffusers worker: {error}"));
            }
        }
    }
    let output = process
        .wait_with_output()
        .map_err(|error| format!("failed to collect local Diffusers worker output: {error}"))?;
    if output.stdout.len() > MAX_WORKER_RESPONSE_BYTES
        || output.stderr.len() > MAX_WORKER_DIAGNOSTIC_BYTES
    {
        return Err("local Diffusers worker returned an oversized response".to_string());
    }
    Ok(output)
}

fn probe_with_python(
    app: &AppHandle,
    script: &Path,
) -> (LocalDiffusersRuntimeStatus, Option<PathBuf>) {
    // Importing Torch initializes the GPU runtime. Concurrent probes contend
    // for the same adapter and can make an otherwise healthy pinned runtime
    // miss its deadline. Serialize this short readiness phase, then let the
    // actual generation worker own the device independently.
    let _guard = RUNTIME_PROBE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut diagnostics = Vec::new();
    let mut unavailable_probe = None;
    for python in python_candidates(app) {
        match run_worker(&python, script, "probe", None, PROBE_TIMEOUT, None) {
            Ok(output) => match serde_json::from_slice::<WorkerProbe>(&output.stdout) {
                Ok(probe) if probe.schema_version == WORKER_SCHEMA_VERSION => {
                    let status = LocalDiffusersRuntimeStatus {
                        status: if probe.ready { "ready" } else { "unavailable" }.to_string(),
                        ready: probe.ready,
                        worker_version: Some(probe.worker_version),
                        python_version: Some(probe.python_version),
                        packages: probe.packages,
                        device: probe.device,
                        device_label: probe.device_label,
                        device_memory_bytes: probe.device_memory_bytes,
                        physical_memory_bytes: probe.physical_memory_bytes,
                        architectures: probe.architectures,
                        capabilities: probe.capabilities,
                        diagnostic: probe.diagnostic,
                    };
                    if status.ready {
                        if let Ok(configured) = std::env::var("HIP_VISIBLE_DEVICES") {
                            if !configured.trim().is_empty() {
                                let _ =
                                    PREFERRED_HIP_VISIBLE_DEVICE.set(configured.trim().to_string());
                            }
                        } else if let Some(label) = status
                            .device_label
                            .as_deref()
                            .filter(|label| label.to_ascii_lowercase().contains("amd"))
                        {
                            if let Some((_, suffix)) = label.rsplit_once("(cuda:") {
                                if let Some(index) = suffix.strip_suffix(')') {
                                    if index.chars().all(|character| character.is_ascii_digit()) {
                                        let _ = PREFERRED_HIP_VISIBLE_DEVICE.set(index.to_string());
                                    }
                                }
                            }
                        }
                    }
                    if status.ready {
                        return (status, Some(python));
                    }
                    diagnostics.push(format!("{}: {}", python.display(), status.diagnostic));
                    unavailable_probe.get_or_insert(status);
                }
                Ok(_) => diagnostics.push(format!(
                    "{}: worker returned an unsupported probe schema",
                    python.display()
                )),
                Err(error) => diagnostics.push(format!(
                    "{}: worker probe returned invalid JSON: {error}",
                    python.display()
                )),
            },
            Err(error) => diagnostics.push(format!("{}: {error}", python.display())),
        }
    }
    let diagnostic = if diagnostics.is_empty() {
        "No supported Python runtime was found.".to_string()
    } else {
        diagnostics.join("; ")
    };
    if let Some(mut probe) = unavailable_probe {
        // Do not let an unrelated global Python probe conceal why the pinned
        // managed runtime failed or timed out.
        probe.diagnostic = diagnostic;
        return (probe, None);
    }
    (LocalDiffusersRuntimeStatus::unavailable(diagnostic), None)
}

pub(crate) fn probe(app: &AppHandle) -> LocalDiffusersRuntimeStatus {
    let script = match worker_script(app) {
        Ok(script) => script,
        Err(error) => return LocalDiffusersRuntimeStatus::unavailable(error),
    };
    probe_with_python(app, &script).0
}

fn runtime_fingerprint(runtime: &LocalDiffusersRuntimeStatus) -> Option<String> {
    if !runtime.ready {
        return None;
    }
    let mut packages = runtime.packages.iter().collect::<Vec<_>>();
    packages.sort_by(|left, right| left.0.cmp(right.0));
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-local-diffusers-runtime-v2\0");
    let device_memory = runtime.device_memory_bytes.unwrap_or_default().to_string();
    let device_label = runtime
        .device_label
        .as_deref()
        .map(stable_device_label)
        .unwrap_or("");
    for value in [
        runtime.worker_version.as_deref().unwrap_or(""),
        runtime.python_version.as_deref().unwrap_or(""),
        runtime.device.as_deref().unwrap_or(""),
        device_label,
        device_memory.as_str(),
    ] {
        hasher.update(value.as_bytes());
        hasher.update(b"\0");
    }
    for (name, version) in packages {
        hasher.update(name.as_bytes());
        hasher.update(b"=");
        hasher.update(version.as_deref().unwrap_or("missing").as_bytes());
        hasher.update(b"\0");
    }
    for values in [&runtime.architectures, &runtime.capabilities] {
        let mut values = values.iter().collect::<Vec<_>>();
        values.sort();
        for value in values {
            hasher.update(value.as_bytes());
            hasher.update(b"\0");
        }
        hasher.update(b"\xff");
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// Torch reports an adapter's process-local ordinal in its display label. On a
/// hybrid AMD system the same discrete GPU is `cuda:1` during discovery and
/// becomes `cuda:0` after `HIP_VISIBLE_DEVICES` isolates it for inference.
/// Readiness belongs to the physical adapter/runtime pair, so that unstable
/// ordinal must not invalidate an otherwise identical clean model probe.
fn stable_device_label(label: &str) -> &str {
    let Some((identity, ordinal)) = label.rsplit_once(" (cuda:") else {
        return label;
    };
    let Some(ordinal) = ordinal.strip_suffix(')') else {
        return label;
    };
    if !ordinal.is_empty() && ordinal.chars().all(|character| character.is_ascii_digit()) {
        identity
    } else {
        label
    }
}

fn ready_runtime(
    app: &AppHandle,
    script: &Path,
) -> MediaResult<(LocalDiffusersRuntimeStatus, PathBuf)> {
    let (runtime, python) = probe_with_python(app, script);
    match python {
        Some(python) if runtime.ready => Ok((runtime, python)),
        _ => Err(format!(
            "Local Diffusers runtime is unavailable: {}",
            runtime.diagnostic
        )),
    }
}

pub(crate) fn annotate_catalog_readiness(
    paths: &MediaRuntimePaths,
    runtime: &LocalDiffusersRuntimeStatus,
    models: &mut [MediaModelDescriptor],
) -> MediaResult<()> {
    let fingerprint = runtime_fingerprint(runtime);
    let connection = database::open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT p.revision, p.model_digest, p.runtime_fingerprint, p.status,
                    p.diagnostic, p.probed_at, i.manifest_digest
             FROM media_model_runtime_probes p
             JOIN media_model_installations i ON i.model_id = p.model_id
             WHERE p.model_id = ?1",
        )
        .map_err(|error| format!("failed to prepare model readiness query: {error}"))?;
    for model in models {
        if model.provider_id != "local-diffusers" || !model.installed {
            continue;
        }
        let Some(current_fingerprint) = fingerprint.as_deref() else {
            model.runtime_readiness = "runtime-unavailable".to_string();
            model.runtime_readiness_diagnostic = Some(runtime.diagnostic.clone());
            model.runtime_readiness_checked_at = None;
            continue;
        };
        let stored = statement
            .query_row([&model.id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .optional()
            .map_err(|error| format!("failed to read model readiness: {error}"))?;
        let Some((
            revision,
            model_digest,
            stored_fingerprint,
            status,
            diagnostic,
            checked_at,
            installed_digest,
        )) = stored
        else {
            model.runtime_readiness = "unverified".to_string();
            model.runtime_readiness_diagnostic = Some(
                "Run Verify model once before using this checkpoint for generation.".to_string(),
            );
            continue;
        };
        if model.installed_revision.as_deref() != Some(revision.as_str())
            || model_digest != installed_digest
            || stored_fingerprint != current_fingerprint
        {
            model.runtime_readiness = "unverified".to_string();
            model.runtime_readiness_diagnostic = Some(
                "The model or local runtime changed; verify this checkpoint again.".to_string(),
            );
            model.runtime_readiness_checked_at = Some(checked_at);
            continue;
        }
        model.runtime_readiness = status;
        model.runtime_readiness_diagnostic = Some(diagnostic);
        model.runtime_readiness_checked_at = Some(checked_at);
    }
    Ok(())
}

fn safe_managed_path(root: &Path, relative_path: &str) -> MediaResult<PathBuf> {
    let relative = Path::new(relative_path);
    if relative_path.is_empty()
        || relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("managed model path is invalid".to_string());
    }
    let root = fs::canonicalize(root)
        .map_err(|error| format!("failed to resolve the model store: {error}"))?;
    let candidate = fs::canonicalize(root.join(relative))
        .map_err(|error| format!("failed to resolve the installed model package: {error}"))?;
    if !candidate.starts_with(&root) {
        return Err("installed model package escaped the model store".to_string());
    }
    Ok(candidate)
}

fn resolve_managed_addon_file(models_root: &Path, relative_path: &str) -> MediaResult<PathBuf> {
    let addon_root = safe_managed_path(models_root, relative_path)?;
    safe_managed_path(&addon_root, "addon.safetensors")
}

fn validate_model_tree(root: &Path) -> MediaResult<()> {
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("failed to resolve local model package: {error}"))?;
    let mut pending = vec![canonical_root.clone()];
    let mut entries = 0_usize;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|error| format!("failed to inspect local model package: {error}"))?
        {
            let entry = entry
                .map_err(|error| format!("failed to inspect local model package entry: {error}"))?;
            entries += 1;
            if entries > 4_096 {
                return Err("local model package contains too many filesystem entries".to_string());
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("failed to inspect local model package entry: {error}"))?;
            if metadata.file_type().is_symlink() {
                return Err("local model package contains a symbolic link".to_string());
            }
            let canonical = fs::canonicalize(&path)
                .map_err(|error| format!("failed to resolve local model package entry: {error}"))?;
            if !canonical.starts_with(&canonical_root) {
                return Err("local model package entry escaped the managed revision".to_string());
            }
            if metadata.is_dir() {
                pending.push(canonical);
            } else if !metadata.is_file() {
                return Err("local model package contains a non-file entry".to_string());
            }
        }
    }
    Ok(())
}

fn verify_model_file(path: &Path, expected_digest: &str) -> MediaResult<()> {
    let mut verified_files = VERIFIED_MODEL_FILES
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let initial_metadata = fs::metadata(path)
        .map_err(|error| format!("failed to inspect installed model file: {error}"))?;
    let initial_modified_at = initial_metadata
        .modified()
        .map_err(|error| format!("failed to inspect installed model timestamp: {error}"))?;
    let current = VerifiedModelFile {
        expected_digest: expected_digest.to_string(),
        byte_size: initial_metadata.len(),
        modified_at: initial_modified_at,
    };
    if verified_files.get(path) == Some(&current) {
        return Ok(());
    }

    let (byte_size, observed_digest) = model_import::hash_file(path)?;
    if byte_size == 0 || observed_digest != expected_digest {
        return Err(
            "the installed single-file model failed its content-addressed integrity check"
                .to_string(),
        );
    }
    let verified_metadata = fs::metadata(path)
        .map_err(|error| format!("failed to reinspect installed model file: {error}"))?;
    let verified_modified_at = verified_metadata
        .modified()
        .map_err(|error| format!("failed to reinspect installed model timestamp: {error}"))?;
    if verified_metadata.len() != current.byte_size || verified_modified_at != current.modified_at {
        return Err("the installed model changed during integrity verification".to_string());
    }
    verified_files.insert(path.to_path_buf(), current);
    Ok(())
}

fn installed_model(paths: &MediaRuntimePaths, model_id: &str) -> MediaResult<InstalledModel> {
    let connection = database::open(paths)?;
    let row = connection
        .query_row(
            "SELECT m.id, m.architecture, m.package_type, i.revision, i.manifest_digest, i.relative_path
             FROM media_models m
             JOIN media_model_installations i ON i.model_id = m.id
             WHERE m.id = ?1 AND m.provider_id = 'local-diffusers' AND m.target = 'local'
               AND m.lifecycle != 'removed' AND i.status = 'installed'",
            [model_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("failed to resolve local diffusion model: {error}"))?
        .ok_or_else(|| "the selected local diffusion model is not installed".to_string())?;
    let architecture = row.1.ok_or_else(|| {
        "the selected local diffusion model has no architecture identity".to_string()
    })?;
    let relative_path = row
        .5
        .ok_or_else(|| "the selected local diffusion model has no managed path".to_string())?;
    let package_root = safe_managed_path(&paths.models_root()?, &relative_path)?;
    let (package_kind, path, config_path) = match row.2.as_str() {
        "diffusers" => ("diffusers-directory".to_string(), package_root, None),
        "safetensors" => (
            "single-file".to_string(),
            safe_managed_path(&package_root, "checkpoint.safetensors")?,
            {
                let candidate = package_root.join("config");
                if candidate.exists() {
                    let candidate = safe_managed_path(&package_root, "config")?;
                    validate_model_tree(&candidate)?;
                    Some(candidate)
                } else {
                    None
                }
            },
        ),
        _ => return Err("the selected model package is not executable by Diffusers".to_string()),
    };
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("failed to inspect local model package: {error}"))?;
    if metadata.file_type().is_symlink()
        || (package_kind == "single-file" && !metadata.is_file())
        || (package_kind == "diffusers-directory" && !metadata.is_dir())
    {
        return Err("the installed model package has an unsafe shape".to_string());
    }
    if package_kind == "single-file" {
        verify_model_file(&path, &row.4)?;
    } else {
        validate_model_tree(&path)?;
    }
    Ok(InstalledModel {
        id: row.0,
        architecture,
        package_kind,
        path,
        config_path,
        revision: row.3,
        digest: row.4,
    })
}

struct ModelProbeRecord<'a> {
    runtime_fingerprint: &'a str,
    status: &'a str,
    worker_version: &'a str,
    pipeline_class: Option<&'a str>,
    device_label: Option<&'a str>,
    diagnostic: &'a str,
    checked_at: &'a str,
}

fn record_model_probe(
    paths: &MediaRuntimePaths,
    model: &InstalledModel,
    record: ModelProbeRecord<'_>,
) -> MediaResult<()> {
    let connection = database::open(paths)?;
    connection
        .execute(
            "INSERT INTO media_model_runtime_probes(
               model_id, revision, model_digest, runtime_fingerprint, status,
               worker_version, pipeline_class, device_label, diagnostic, probed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(model_id) DO UPDATE SET
               revision = excluded.revision,
               model_digest = excluded.model_digest,
               runtime_fingerprint = excluded.runtime_fingerprint,
               status = excluded.status,
               worker_version = excluded.worker_version,
               pipeline_class = excluded.pipeline_class,
               device_label = excluded.device_label,
               diagnostic = excluded.diagnostic,
               probed_at = excluded.probed_at",
            params![
                model.id,
                model.revision,
                model.digest,
                record.runtime_fingerprint,
                record.status,
                record.worker_version,
                record.pipeline_class,
                record.device_label,
                record.diagnostic,
                record.checked_at,
            ],
        )
        .map_err(|error| format!("failed to persist model runtime readiness: {error}"))?;
    Ok(())
}

fn persist_failed_model_probe(
    paths: &MediaRuntimePaths,
    model: &InstalledModel,
    runtime_fingerprint: &str,
    runtime: &LocalDiffusersRuntimeStatus,
    diagnostic: String,
    checked_at: &str,
    pipeline_class: Option<&str>,
) -> MediaResult<LocalModelRuntimeProbeResult> {
    let worker_version = runtime.worker_version.as_deref().unwrap_or("unknown");
    record_model_probe(
        paths,
        model,
        ModelProbeRecord {
            runtime_fingerprint,
            status: "failed",
            worker_version,
            pipeline_class,
            device_label: runtime.device_label.as_deref(),
            diagnostic: &diagnostic,
            checked_at,
        },
    )?;
    Ok(LocalModelRuntimeProbeResult {
        schema_version: 1,
        model_id: model.id.clone(),
        revision: model.revision.clone(),
        status: "failed".to_string(),
        diagnostic,
        checked_at: checked_at.to_string(),
        worker_version: runtime.worker_version.clone(),
        pipeline_class: pipeline_class.map(ToOwned::to_owned),
        device_label: runtime.device_label.clone(),
        components: Vec::new(),
        capabilities: Vec::new(),
    })
}

pub(crate) fn probe_model(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    model_id: &str,
) -> MediaResult<LocalModelRuntimeProbeResult> {
    let model = installed_model(paths, model_id)?;
    let checked_at = database::now();
    let script = worker_script(app)?;
    let (runtime, python) = probe_with_python(app, &script);
    let Some(fingerprint) = runtime_fingerprint(&runtime) else {
        return Ok(LocalModelRuntimeProbeResult {
            schema_version: 1,
            model_id: model.id,
            revision: model.revision,
            status: "unavailable".to_string(),
            diagnostic: runtime.diagnostic,
            checked_at,
            worker_version: runtime.worker_version,
            pipeline_class: None,
            device_label: runtime.device_label,
            components: Vec::new(),
            capabilities: Vec::new(),
        });
    };
    let python = python.ok_or_else(|| {
        "The pinned local Diffusers runtime passed readiness without identifying its interpreter."
            .to_string()
    })?;
    let request = WorkerModelProbeRequest {
        schema_version: WORKER_SCHEMA_VERSION,
        model: WorkerModel {
            id: &model.id,
            architecture: &model.architecture,
            package_kind: &model.package_kind,
            path: &model.path,
            config_path: model.config_path.as_deref(),
            revision: &model.revision,
            digest: &model.digest,
        },
    };
    let encoded = serde_json::to_vec(&request)
        .map_err(|error| format!("failed to encode model readiness request: {error}"))?;
    let output = run_worker(
        &python,
        &script,
        "probe-model",
        Some(&encoded),
        MODEL_PROBE_TIMEOUT,
        None,
    )?;
    let failure = if output.status.success() {
        None
    } else if let Ok(failure) = serde_json::from_slice::<WorkerFailure>(&output.stdout) {
        Some(worker_failure_with_diagnostics(
            failure.error,
            &output.stderr,
        ))
    } else {
        let diagnostic = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Some(if diagnostic.is_empty() {
            format!("model readiness worker exited with {}", output.status)
        } else {
            format!("model readiness worker failed: {diagnostic}")
        })
    };
    if let Some(diagnostic) = failure {
        return persist_failed_model_probe(
            paths,
            &model,
            &fingerprint,
            &runtime,
            diagnostic,
            &checked_at,
            None,
        );
    }
    let response = match serde_json::from_slice::<WorkerModelProbeResponse>(&output.stdout) {
        Ok(response) => response,
        Err(error) => {
            return persist_failed_model_probe(
                paths,
                &model,
                &fingerprint,
                &runtime,
                format!("model readiness worker returned invalid JSON: {error}"),
                &checked_at,
                None,
            )
        }
    };
    let expects_textual_inversion = matches!(
        model.architecture.as_str(),
        "stable-diffusion-1" | "stable-diffusion-2" | "stable-diffusion-xl" | "flux-1"
    );
    let response_is_valid = response.schema_version == WORKER_SCHEMA_VERSION
        && response.ready
        && response.worker_version == runtime.worker_version.as_deref().unwrap_or("")
        && response.packages == runtime.packages
        && response.architecture == model.architecture
        && response.device == runtime.device.as_deref().unwrap_or("")
        && response.device_label == runtime.device_label.as_deref().unwrap_or("")
        && response.device_memory_bytes == runtime.device_memory_bytes
        && !response.pipeline_class.trim().is_empty()
        && response.pipeline_class.len() <= 256
        && !response.components.is_empty()
        && response.components.len() <= 64
        && response.capabilities.contains(&"lora".to_string())
        && response.capabilities.contains(&"multi-lora".to_string())
        && (!expects_textual_inversion
            || response
                .capabilities
                .contains(&"textual-inversion".to_string()));
    if !response_is_valid {
        return persist_failed_model_probe(
            paths,
            &model,
            &fingerprint,
            &runtime,
            "model readiness worker returned inconsistent runtime evidence".to_string(),
            &checked_at,
            Some(&response.pipeline_class),
        );
    }
    record_model_probe(
        paths,
        &model,
        ModelProbeRecord {
            runtime_fingerprint: &fingerprint,
            status: "ready",
            worker_version: &response.worker_version,
            pipeline_class: Some(&response.pipeline_class),
            device_label: Some(&response.device_label),
            diagnostic: &response.diagnostic,
            checked_at: &checked_at,
        },
    )?;
    Ok(LocalModelRuntimeProbeResult {
        schema_version: 1,
        model_id: model.id,
        revision: model.revision,
        status: "ready".to_string(),
        diagnostic: response.diagnostic,
        checked_at,
        worker_version: Some(response.worker_version),
        pipeline_class: Some(response.pipeline_class),
        device_label: Some(response.device_label),
        components: response.components,
        capabilities: response.capabilities,
    })
}

fn ensure_model_is_probe_ready(
    paths: &MediaRuntimePaths,
    model: &InstalledModel,
    runtime: &LocalDiffusersRuntimeStatus,
) -> MediaResult<()> {
    let fingerprint = runtime_fingerprint(runtime).ok_or_else(|| runtime.diagnostic.clone())?;
    let connection = database::open(paths)?;
    let ready = connection
        .query_row(
            "SELECT 1 FROM media_model_runtime_probes
             WHERE model_id = ?1 AND revision = ?2 AND model_digest = ?3
               AND runtime_fingerprint = ?4 AND status = 'ready'",
            params![model.id, model.revision, model.digest, fingerprint],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("failed to check model runtime readiness: {error}"))?
        .is_some();
    if !ready {
        return Err(
            "Verify this local model in Models before generation; its checkpoint/runtime combination has not passed a clean offline load."
                .to_string(),
        );
    }
    Ok(())
}

fn resolve_addons(
    paths: &MediaRuntimePaths,
    model: &InstalledModel,
    selections: &[MediaModelAddonSelection],
) -> MediaResult<Vec<ResolvedAddon>> {
    let connection = database::open(paths)?;
    let models_root = paths.models_root()?;
    let mut resolved = Vec::new();
    let mut seen_ids = HashSet::new();
    let mut seen_tokens = HashSet::new();
    let mut kind_counts = HashMap::<String, u32>::new();
    for selection in selections.iter().filter(|selection| selection.enabled()) {
        let addon_id = selection.addon_id();
        if !seen_ids.insert(addon_id.to_string()) {
            return Err("each model add-on may be selected only once".to_string());
        }
        let row = connection
            .query_row(
                "SELECT kind, architecture, target_components_json, embedding_vectors_json,
                        lora_profile_json, digest, header_digest, byte_size, relative_path
                 FROM media_model_addons WHERE id = ?1",
                [addon_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, String>(8)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("failed to resolve model add-on: {error}"))?
            .ok_or_else(|| format!("model add-on {addon_id} is not installed"))?;
        if row.0 != selection.kind() || row.1 != model.architecture {
            return Err(format!(
                "model add-on {addon_id} does not match the selected model architecture"
            ));
        }
        let target_components = serde_json::from_str::<Vec<String>>(&row.2)
            .map_err(|error| format!("failed to decode model add-on targets: {error}"))?;
        let embedding_vectors = serde_json::from_str::<Vec<MediaEmbeddingVectorProfile>>(&row.3)
            .map_err(|error| format!("failed to decode embedding vector profiles: {error}"))?;
        let lora_profile = row
            .4
            .as_deref()
            .map(serde_json::from_str::<MediaLoraTensorProfile>)
            .transpose()
            .map_err(|error| format!("failed to decode LoRA tensor profile: {error}"))?;
        let capability =
            model_addon::capabilities_for_model("local-diffusers", Some(&model.architecture))
                .into_iter()
                .find(|capability| capability.kind == row.0)
                .ok_or_else(|| {
                    "the selected model does not support this add-on kind".to_string()
                })?;
        let kind_count = kind_counts.entry(row.0.clone()).or_default();
        *kind_count += 1;
        if *kind_count > capability.max_active {
            return Err(format!(
                "the selected model supports at most {} active {} add-ons",
                capability.max_active, row.0
            ));
        }
        if target_components
            .iter()
            .any(|component| !capability.target_components.contains(component))
        {
            return Err(format!(
                "model add-on {addon_id} targets unsupported model components"
            ));
        }
        let path = resolve_managed_addon_file(&models_root, &row.8)?;
        let tensor_profile =
            model_addon::verify_managed_addon_header(&path, &row.0, &row.6, row.7.max(0) as u64)?;
        if tensor_profile.architecture != model.architecture
            || tensor_profile.target_components != target_components
            || tensor_profile.embedding_vectors != embedding_vectors
            || tensor_profile.lora_profile != lora_profile
        {
            return Err(format!(
                "model add-on {addon_id} does not match its tensor-verified catalog profile"
            ));
        }
        let (byte_size, observed_digest) = model_import::hash_file(&path)?;
        if byte_size == 0 || observed_digest != row.5 {
            return Err(format!(
                "model add-on {addon_id} failed its content-addressed integrity check"
            ));
        }
        if row.0 == "lora" && !embedding_vectors.is_empty() {
            return Err(format!(
                "model add-on {addon_id} has embedding vectors but is registered as a LoRA"
            ));
        }
        if row.0 == "textual-inversion" {
            if lora_profile.is_some() {
                return Err(format!(
                    "model add-on {addon_id} has a LoRA tensor profile but is registered as textual inversion"
                ));
            }
            let profile_components = embedding_vectors
                .iter()
                .map(|profile| profile.component.clone())
                .collect::<Vec<_>>();
            let unique_tensor_keys = embedding_vectors
                .iter()
                .map(|profile| profile.tensor_key.as_str())
                .collect::<HashSet<_>>();
            if embedding_vectors.is_empty()
                || profile_components != target_components
                || unique_tensor_keys.len() != embedding_vectors.len()
                || embedding_vectors.iter().any(|profile| {
                    profile.tensor_key.trim().is_empty()
                        || profile.vector_count == 0
                        || profile.dimension < 64
                })
            {
                return Err(format!(
                    "model add-on {addon_id} has an invalid embedding vector profile"
                ));
            }
        }
        if row.0 == "lora"
            && lora_profile.as_ref().is_none_or(|profile| {
                !matches!(profile.algorithm.as_str(), "lora" | "locon" | "dora")
                    || !matches!(
                        profile.dialect.as_str(),
                        "kohya" | "diffusers-peft" | "generic"
                    )
                    || profile.rank_minimum == 0
                    || profile.rank_minimum > profile.rank_maximum
                    || profile.rank_maximum > 4_096
                    || profile.heterogeneous_ranks != (profile.rank_minimum != profile.rank_maximum)
                    || profile.target_module_count == 0
                    || profile.convolution_target_count > profile.target_module_count
                    || profile.magnitude_vector_count > profile.target_module_count
                    || profile.network_alpha_count > profile.target_module_count
                    || (profile.algorithm == "lora"
                        && (profile.convolution_target_count > 0
                            || profile.magnitude_vector_count > 0))
                    || (profile.algorithm == "locon"
                        && (profile.convolution_target_count == 0
                            || profile.magnitude_vector_count > 0))
                    || (profile.algorithm == "dora" && profile.magnitude_vector_count == 0)
            })
        {
            return Err(format!(
                "model add-on {addon_id} has an invalid LoRA tensor profile"
            ));
        }
        if row.0 == "lora"
            && matches!(
                model.architecture.as_str(),
                "stable-diffusion-3" | "flux-2" | "krea-2"
            )
            && lora_profile
                .as_ref()
                .is_some_and(|profile| profile.convolution_target_count > 0)
        {
            return Err(format!(
                "model add-on {addon_id} contains convolutional weights that the selected transformer pipeline cannot load"
            ));
        }
        let (model_strength, text_encoder_strength, denoising_schedule, token, placement) =
            match selection {
                MediaModelAddonSelection::Lora {
                    model_strength,
                    text_encoder_strength,
                    denoising_schedule,
                    ..
                } => {
                    if text_encoder_strength.is_some()
                        && !capability.supports_separate_component_strengths
                    {
                        return Err(
                        "the selected model does not expose separate text-encoder LoRA strength"
                            .to_string(),
                    );
                    }
                    if text_encoder_strength.is_some()
                        && !target_components.iter().any(|component| {
                            component == "text-encoder" || component == "text-encoder-2"
                        })
                    {
                        return Err(
                            "the selected LoRA does not contain text-encoder weights".to_string()
                        );
                    }
                    if denoising_schedule.is_some() && !capability.supports_denoising_schedules {
                        return Err(
                            "the selected model does not support scheduled LoRA activation"
                                .to_string(),
                        );
                    }
                    if denoising_schedule.is_some()
                        && (target_components.len() != 1 || target_components[0] != "denoiser")
                    {
                        return Err(
                            "scheduled LoRA activation requires denoiser-only adapter weights"
                                .to_string(),
                        );
                    }
                    (
                        Some(*model_strength),
                        *text_encoder_strength,
                        denoising_schedule.clone(),
                        None,
                        None,
                    )
                }
                MediaModelAddonSelection::TextualInversion {
                    token, placement, ..
                } => {
                    if model.architecture == "flux-1" && placement != "positive" {
                        return Err(
                        "FLUX.1 textual-inversion tokens are supported only in the positive prompt channel"
                            .to_string(),
                    );
                    }
                    if !seen_tokens.insert(token.to_lowercase()) {
                        return Err("textual-inversion token aliases must be unique".to_string());
                    }
                    (
                        None,
                        None,
                        None,
                        Some(token.clone()),
                        Some(placement.clone()),
                    )
                }
            };
        resolved.push(ResolvedAddon {
            kind: row.0,
            id: addon_id.to_string(),
            path,
            digest: row.5,
            target_components,
            embedding_vectors,
            lora_profile,
            model_strength,
            text_encoder_strength,
            denoising_schedule,
            token,
            placement,
        });
    }
    Ok(resolved)
}

fn runnable_model_ids_for_architecture(
    paths: &MediaRuntimePaths,
    runtime: &LocalDiffusersRuntimeStatus,
    required_architecture: Option<&str>,
) -> MediaResult<Vec<String>> {
    if !runtime.ready {
        return Ok(Vec::new());
    }
    let fingerprint = runtime_fingerprint(runtime)
        .ok_or_else(|| "local Diffusers runtime fingerprint is unavailable".to_string())?;
    let connection = database::open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT m.id, m.architecture FROM media_models m
             JOIN media_model_installations i ON i.model_id = m.id
             JOIN media_model_runtime_probes p ON p.model_id = m.id
             WHERE m.provider_id = 'local-diffusers' AND m.target = 'local'
               AND m.lifecycle != 'removed' AND i.status = 'installed'
               AND p.status = 'ready' AND p.revision = i.revision
               AND p.model_digest = i.manifest_digest AND p.runtime_fingerprint = ?1
             ORDER BY m.id",
        )
        .map_err(|error| format!("failed to prepare runnable model query: {error}"))?;
    let candidates = statement
        .query_map([fingerprint], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| format!("failed to query runnable local models: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode runnable local models: {error}"))?;
    let mut runnable = Vec::new();
    for (model_id, architecture) in candidates {
        let Some(architecture) = architecture else {
            continue;
        };
        if !runtime.architectures.contains(&architecture)
            || required_architecture.is_some_and(|required| required != architecture)
        {
            continue;
        }
        let Ok(model) = installed_model(paths, &model_id) else {
            continue;
        };
        if model.architecture == architecture {
            runnable.push(model_id);
        }
    }
    Ok(runnable)
}

pub(crate) fn runnable_model_ids(
    paths: &MediaRuntimePaths,
    runtime: &LocalDiffusersRuntimeStatus,
) -> MediaResult<Vec<String>> {
    runnable_model_ids_for_architecture(paths, runtime, None)
}

pub(crate) fn runnable_reference_model_ids(
    paths: &MediaRuntimePaths,
    runtime: &LocalDiffusersRuntimeStatus,
) -> MediaResult<Vec<String>> {
    if !runtime
        .capabilities
        .contains(&"local-image-edit".to_string())
    {
        return Ok(Vec::new());
    }
    Ok(runnable_model_ids(paths, runtime)?
        .into_iter()
        .filter(|model_id| {
            installed_model(paths, model_id).is_ok_and(|model| {
                matches!(
                    model.architecture.as_str(),
                    "stable-diffusion-1"
                        | "stable-diffusion-2"
                        | "stable-diffusion-xl"
                        | "flux-1"
                        | "flux-2"
                )
            })
        })
        .collect())
}

pub(crate) fn runnable_inpainting_model_ids(
    paths: &MediaRuntimePaths,
    runtime: &LocalDiffusersRuntimeStatus,
) -> MediaResult<Vec<String>> {
    if !runtime
        .capabilities
        .contains(&"masked-region-inpainting".to_string())
    {
        return Ok(Vec::new());
    }
    Ok(runnable_reference_model_ids(paths, runtime)?
        .into_iter()
        .filter(|model_id| {
            installed_model(paths, model_id).is_ok_and(|model| {
                matches!(
                    model.architecture.as_str(),
                    "stable-diffusion-1"
                        | "stable-diffusion-2"
                        | "stable-diffusion-xl"
                        | "flux-1"
                        | "flux-2"
                )
            })
        })
        .collect())
}

fn openpose_controlnet_path(
    paths: &MediaRuntimePaths,
    architecture: &str,
) -> MediaResult<Option<PathBuf>> {
    let profile = match architecture {
        "stable-diffusion-1" => "sd15",
        "stable-diffusion-2" => "sd2",
        "stable-diffusion-xl" => "sdxl",
        _ => return Ok(None),
    };
    let root = paths.models_root()?;
    let relative = format!("controlnet/openpose/{profile}");
    let unresolved_directory = root.join(&relative);
    let Ok(metadata) = fs::symlink_metadata(&unresolved_directory) else {
        return Ok(None);
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Ok(None);
    }
    let directory = safe_managed_path(&root, &relative)?;
    let config = directory.join("config.json");
    if !config.is_file() {
        return Ok(None);
    }
    let has_weights = fs::read_dir(&directory)
        .map_err(|error| format!("failed to inspect OpenPose ControlNet: {error}"))?
        .filter_map(Result::ok)
        .any(|entry| {
            entry.file_type().is_ok_and(|kind| kind.is_file())
                && entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("diffusion_pytorch_model")
                && entry
                    .path()
                    .extension()
                    .is_some_and(|suffix| suffix == "safetensors")
        });
    Ok(has_weights.then_some(directory))
}

pub(crate) fn runnable_pose_model_ids(
    paths: &MediaRuntimePaths,
    runtime: &LocalDiffusersRuntimeStatus,
) -> MediaResult<Vec<String>> {
    if !runtime
        .capabilities
        .contains(&"openpose-controlnet".to_string())
    {
        return Ok(Vec::new());
    }
    let mut models = Vec::new();
    for model_id in runnable_model_ids(paths, runtime)? {
        let Ok(model) = installed_model(paths, &model_id) else {
            continue;
        };
        if openpose_controlnet_path(paths, &model.architecture)?.is_some() {
            models.push(model_id);
        }
    }
    Ok(models)
}

fn create_staging_directory(paths: &MediaRuntimePaths) -> MediaResult<StagingDirectory> {
    let root = paths
        .database
        .parent()
        .ok_or_else(|| "Media Studio storage path has no parent directory".to_string())?
        .join("worker-staging")
        .join("local-diffusers");
    fs::create_dir_all(&root)
        .map_err(|error| format!("failed to prepare local generation staging: {error}"))?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random)
        .map_err(|error| format!("failed to create local generation staging id: {error}"))?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let path = root.join(format!("{}-{suffix}", std::process::id()));
    fs::create_dir(&path)
        .map_err(|error| format!("failed to create local generation staging: {error}"))?;
    Ok(StagingDirectory(path))
}

fn decode_generation_response(output: &Output) -> MediaResult<WorkerGenerationResponse> {
    if !output.status.success() {
        if let Ok(failure) = serde_json::from_slice::<WorkerFailure>(&output.stdout) {
            return Err(worker_failure_with_diagnostics(
                failure.error,
                &output.stderr,
            ));
        }
        let diagnostic = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if diagnostic.is_empty() {
            format!("local Diffusers worker exited with {}", output.status)
        } else {
            format!("local Diffusers worker failed: {diagnostic}")
        });
    }
    let response = serde_json::from_slice::<WorkerGenerationResponse>(&output.stdout)
        .map_err(|error| format!("local Diffusers worker returned invalid JSON: {error}"))?;
    if response.schema_version != WORKER_SCHEMA_VERSION {
        return Err("local Diffusers worker returned an unsupported schema".to_string());
    }
    Ok(response)
}

fn worker_failure_with_diagnostics(summary: String, stderr: &[u8]) -> String {
    const MAX_DETAIL_CHARS: usize = 4_096;

    let diagnostic = String::from_utf8_lossy(stderr).trim().to_string();
    if diagnostic.is_empty() || summary.contains(&diagnostic) {
        return summary;
    }
    let detail_reversed = diagnostic
        .chars()
        .rev()
        .take(MAX_DETAIL_CHARS)
        .collect::<String>();
    let detail = detail_reversed.chars().rev().collect::<String>();
    format!("{summary}\nWorker diagnostics (tail):\n{detail}")
}

fn append_prompt_token(prompt: &str, token: &str) -> String {
    if prompt
        .split_whitespace()
        .any(|candidate| candidate == token)
    {
        prompt.to_string()
    } else if prompt.trim().is_empty() {
        token.to_string()
    } else {
        format!("{}, {token}", prompt.trim_end())
    }
}

fn registered_embedding_tokens(token: &str, vector_count: u32) -> Vec<String> {
    std::iter::once(token.to_string())
        .chain((1..vector_count).map(|index| format!("{token}_{index}")))
        .collect()
}

fn validate_generation_evidence(
    response: &WorkerGenerationResponse,
    runtime: &LocalDiffusersRuntimeStatus,
    request_prompt: &str,
    request_negative_prompt: &str,
    addons: &[ResolvedAddon],
) -> MediaResult<()> {
    if response.worker_version != runtime.worker_version.as_deref().unwrap_or("")
        || response.packages != runtime.packages
        || response.device != runtime.device.as_deref().unwrap_or("")
        || response.device_label != runtime.device_label.as_deref().unwrap_or("")
        || response.device_memory_bytes != runtime.device_memory_bytes
    {
        return Err(
            "local Diffusers generation returned evidence from a different runtime".to_string(),
        );
    }
    if response.addons.len() != addons.len() {
        return Err(
            "local Diffusers generation did not confirm the exact requested add-on stack"
                .to_string(),
        );
    }
    let mut expected_prompt = request_prompt.to_string();
    let mut expected_negative_prompt = request_negative_prompt.to_string();
    for (index, (evidence, addon)) in response.addons.iter().zip(addons).enumerate() {
        let object = evidence
            .as_object()
            .ok_or_else(|| format!("local Diffusers add-on evidence {index} is not an object"))?;
        let text = |key: &str| object.get(key).and_then(serde_json::Value::as_str);
        if text("kind") != Some(addon.kind.as_str())
            || text("addonId") != Some(addon.id.as_str())
            || text("digest") != Some(addon.digest.as_str())
        {
            return Err(format!(
                "local Diffusers add-on evidence {index} does not match the requested immutable resource"
            ));
        }
        let loaded_components = object
            .get("loadedComponents")
            .cloned()
            .and_then(|value| serde_json::from_value::<Vec<String>>(value).ok())
            .ok_or_else(|| {
                format!("local Diffusers add-on evidence {index} has no component inventory")
            })?;
        if loaded_components != addon.target_components {
            return Err(format!(
                "local Diffusers add-on evidence {index} does not match the inspected component inventory"
            ));
        }
        match addon.kind.as_str() {
            "lora" => {
                let expected_adapter_name = format!("machdoch_{}", &addon.digest[..16]);
                let lora_profile = object
                    .get("loraProfile")
                    .cloned()
                    .and_then(|value| serde_json::from_value::<MediaLoraTensorProfile>(value).ok());
                let evidence_schedule = object
                    .get("denoisingSchedule")
                    .cloned()
                    .ok_or_else(|| {
                        format!(
                            "local Diffusers LoRA evidence {index} has no denoising schedule"
                        )
                    })
                    .and_then(|value| {
                        serde_json::from_value::<Option<MediaLoraDenoisingSchedule>>(value)
                            .map_err(|_| {
                                format!(
                                    "local Diffusers LoRA evidence {index} has an invalid denoising schedule"
                                )
                            })
                    })?;
                if lora_profile.as_ref() != addon.lora_profile.as_ref()
                    || text("adapterName") != Some(expected_adapter_name.as_str())
                    || object
                        .get("modelStrength")
                        .and_then(serde_json::Value::as_f64)
                        != addon.model_strength
                    || object
                        .get("textEncoderStrength")
                        .and_then(serde_json::Value::as_f64)
                        != addon.text_encoder_strength
                    || evidence_schedule != addon.denoising_schedule
                    || object
                        .get("scheduleApplied")
                        .and_then(serde_json::Value::as_bool)
                        != Some(addon.denoising_schedule.is_some())
                {
                    return Err(format!(
                        "local Diffusers LoRA evidence {index} does not match the requested adapter weights"
                    ));
                }
            }
            "textual-inversion" => {
                if text("token") != addon.token.as_deref()
                    || text("placement") != addon.placement.as_deref()
                {
                    return Err(format!(
                        "local Diffusers embedding evidence {index} does not match the requested token placement"
                    ));
                }
                let token = addon.token.as_deref().ok_or_else(|| {
                    "resolved textual-inversion add-on has no token alias".to_string()
                })?;
                let embedding_vectors = object
                    .get("embeddingVectors")
                    .cloned()
                    .and_then(|value| {
                        serde_json::from_value::<Vec<WorkerEmbeddingVectorEvidence>>(value).ok()
                    })
                    .ok_or_else(|| {
                        format!("local Diffusers embedding evidence {index} has no vector profile")
                    })?;
                if embedding_vectors.len() != addon.embedding_vectors.len()
                    || embedding_vectors.iter().zip(&addon.embedding_vectors).any(
                        |(evidence, expected)| {
                            evidence.component != expected.component
                                || evidence.tensor_key != expected.tensor_key
                                || evidence.vector_count != expected.vector_count
                                || evidence.dimension != expected.dimension
                                || evidence.registered_tokens
                                    != registered_embedding_tokens(token, expected.vector_count)
                        },
                    )
                {
                    return Err(format!(
                        "local Diffusers embedding evidence {index} does not match the inspected vectors and registered token aliases"
                    ));
                }
                match addon.placement.as_deref() {
                    Some("positive") => {
                        expected_prompt = append_prompt_token(&expected_prompt, token)
                    }
                    Some("negative") => {
                        expected_negative_prompt =
                            append_prompt_token(&expected_negative_prompt, token)
                    }
                    Some("both") => {
                        expected_prompt = append_prompt_token(&expected_prompt, token);
                        expected_negative_prompt =
                            append_prompt_token(&expected_negative_prompt, token);
                    }
                    _ => return Err("resolved embedding has an invalid placement".to_string()),
                }
            }
            _ => return Err("resolved model add-on has an unsupported kind".to_string()),
        }
    }
    if response.prompt != expected_prompt || response.negative_prompt != expected_negative_prompt {
        return Err(
            "local Diffusers generation did not confirm the exact compiled prompt channels"
                .to_string(),
        );
    }
    Ok(())
}

#[derive(Clone, Copy)]
struct EditConditioningEvidenceExpectation<'a> {
    architecture: &'a str,
    references: &'a [MediaImageReference],
    reference_digests: &'a [&'a str],
    base_digest: Option<&'a str>,
    pose_digest: Option<&'a str>,
    has_mask: bool,
    edit_strength: Option<f64>,
    mask_strength: Option<f64>,
    requires_reference_binding: bool,
    requires_visible_reference_change: bool,
}

fn validate_flux2_reference_binding(
    object: &serde_json::Map<String, serde_json::Value>,
    expected: &EditConditioningEvidenceExpectation<'_>,
) -> MediaResult<()> {
    if !expected.requires_reference_binding {
        if !matches!(
            object.get("referenceBinding"),
            None | Some(serde_json::Value::Null)
        ) {
            return Err(
                "local Diffusers generation returned unexpected FLUX.2 reference-binding evidence"
                    .to_string(),
            );
        }
        return Ok(());
    }
    let binding = object
        .get("referenceBinding")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            "local Diffusers generation did not confirm indexed FLUX.2 reference roles".to_string()
        })?;
    if binding.get("mode").and_then(serde_json::Value::as_str) != Some("indexed-role-prompt-v1")
        || binding
            .get("requiresVisibleChange")
            .and_then(serde_json::Value::as_bool)
            != Some(expected.requires_visible_reference_change)
    {
        return Err(
            "local Diffusers generation returned invalid FLUX.2 reference-binding evidence"
                .to_string(),
        );
    }
    let inputs = binding
        .get("inputs")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "local Diffusers FLUX.2 reference-binding evidence has no input list".to_string()
        })?;
    let base_offset = usize::from(expected.base_digest.is_some());
    if inputs.len() != expected.references.len() + base_offset {
        return Err(
            "local Diffusers FLUX.2 reference-binding evidence has an unexpected input count"
                .to_string(),
        );
    }
    for (index, input) in inputs.iter().enumerate() {
        let input = input.as_object().ok_or_else(|| {
            format!("local Diffusers FLUX.2 reference-binding input {index} is not an object")
        })?;
        let expected_role = if base_offset == 1 && index == 0 {
            "base"
        } else {
            expected.references[index - base_offset].role.as_str()
        };
        if input.get("imageIndex").and_then(serde_json::Value::as_u64) != Some((index + 1) as u64)
            || input.get("role").and_then(serde_json::Value::as_str) != Some(expected_role)
        {
            return Err(format!(
                "local Diffusers FLUX.2 reference-binding input {index} does not match the staged role order"
            ));
        }
    }
    Ok(())
}

fn validate_visible_reference_change(
    object: &serde_json::Map<String, serde_json::Value>,
    expected: &EditConditioningEvidenceExpectation<'_>,
) -> MediaResult<()> {
    if !expected.requires_visible_reference_change {
        if !matches!(
            object.get("changeMap"),
            None | Some(serde_json::Value::Null)
        ) {
            return Err(
                "local Diffusers generation returned unexpected source-change evidence".to_string(),
            );
        }
        return Ok(());
    }
    let outputs = object
        .get("changeMap")
        .and_then(serde_json::Value::as_object)
        .and_then(|change_map| change_map.get("outputs"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "local Diffusers generation did not confirm material source-image change".to_string()
        })?;
    if outputs.is_empty() {
        return Err("local Diffusers source-change evidence has no generated outputs".to_string());
    }
    let expected_scope = if expected.has_mask { "mask" } else { "image" };
    for (index, output) in outputs.iter().enumerate() {
        let output = output.as_object().ok_or_else(|| {
            format!("local Diffusers source-change output {index} is not an object")
        })?;
        let active_pixels = output
            .get("activePixels")
            .and_then(serde_json::Value::as_u64)
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                format!("local Diffusers source-change output {index} has no active pixels")
            })?;
        let changed_pixels = output
            .get("changedPixels")
            .and_then(serde_json::Value::as_u64)
            .filter(|value| *value <= active_pixels)
            .ok_or_else(|| {
                format!("local Diffusers source-change output {index} has invalid changed pixels")
            })?;
        let changed_ratio = output
            .get("changedPixelRatio")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
            .ok_or_else(|| {
                format!("local Diffusers source-change output {index} has invalid changed ratio")
            })?;
        let mean_difference = output
            .get("meanAbsoluteDifference")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or_else(|| {
                format!("local Diffusers source-change output {index} has invalid pixel difference")
            })?;
        let evidence_matches_algorithm = output.get("scope").and_then(serde_json::Value::as_str)
            == Some(expected_scope)
            && output
                .get("pixelDeltaThreshold")
                .and_then(serde_json::Value::as_f64)
                .is_some_and(|value| {
                    (value - REFERENCE_EDIT_PIXEL_DELTA_THRESHOLD).abs() <= f64::EPSILON
                })
            && output
                .get("minimumChangedPixelRatio")
                .and_then(serde_json::Value::as_f64)
                .is_some_and(|value| {
                    (value - REFERENCE_EDIT_MIN_CHANGED_PIXEL_RATIO).abs() <= f64::EPSILON
                })
            && output
                .get("minimumMeanAbsoluteDifference")
                .and_then(serde_json::Value::as_f64)
                .is_some_and(|value| {
                    (value - REFERENCE_EDIT_MIN_MEAN_ABSOLUTE_DIFFERENCE).abs() <= f64::EPSILON
                });
        if !evidence_matches_algorithm
            || changed_ratio < REFERENCE_EDIT_MIN_CHANGED_PIXEL_RATIO
            || mean_difference < REFERENCE_EDIT_MIN_MEAN_ABSOLUTE_DIFFERENCE
            || changed_pixels == 0
        {
            return Err(format!(
                "local Diffusers source-change output {index} did not materially change the source image"
            ));
        }
    }
    Ok(())
}

fn validate_edit_conditioning_evidence(
    response: &WorkerGenerationResponse,
    expected: &EditConditioningEvidenceExpectation<'_>,
) -> MediaResult<()> {
    let evidence = response.edit_conditioning.as_ref().ok_or_else(|| {
        "local Diffusers generation did not return reference conditioning evidence".to_string()
    })?;
    let object = evidence.as_object().ok_or_else(|| {
        "local Diffusers reference conditioning evidence is not an object".to_string()
    })?;
    let expected_mode = if expected.pose_digest.is_some() && expected.has_mask {
        "controlnet-openpose-soft-inpaint-v1"
    } else if expected.pose_digest.is_some() {
        "controlnet-openpose"
    } else if expected.has_mask && expected.architecture == "flux-2" {
        "flux2-klein-inpaint-v1"
    } else if expected.has_mask {
        "diffusers-soft-inpaint-v1"
    } else if expected.architecture == "flux-2" {
        "flux2-native-reference"
    } else {
        "diffusers-image-to-image"
    };
    if object.get("mode").and_then(serde_json::Value::as_str) != Some(expected_mode) {
        return Err(
            "local Diffusers generation did not confirm the requested native conditioning mode"
                .to_string(),
        );
    }
    let reference_sources = object
        .get("referenceSources")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "local Diffusers reference conditioning evidence has no source list".to_string()
        })?;
    if reference_sources.len() != expected.references.len()
        || expected.reference_digests.len() != expected.references.len()
    {
        return Err(
            "local Diffusers reference conditioning evidence has an unexpected source count"
                .to_string(),
        );
    }
    for (index, ((source, reference), digest)) in reference_sources
        .iter()
        .zip(expected.references)
        .zip(expected.reference_digests)
        .enumerate()
    {
        let source = source.as_object().ok_or_else(|| {
            format!("local Diffusers reference conditioning source {index} is not an object")
        })?;
        if source.get("digest").and_then(serde_json::Value::as_str) != Some(*digest)
            || source.get("role").and_then(serde_json::Value::as_str)
                != Some(reference.role.as_str())
            || source.get("influence").and_then(serde_json::Value::as_f64)
                != Some(reference.influence)
        {
            return Err(format!(
                "local Diffusers reference conditioning source {index} does not match the staged immutable input"
            ));
        }
    }
    let matches_optional_digest = |key: &str, expected: Option<&str>| match expected {
        Some(digest) => object.get(key).and_then(serde_json::Value::as_str) == Some(digest),
        None => matches!(object.get(key), None | Some(serde_json::Value::Null)),
    };
    if !matches_optional_digest("baseDigest", expected.base_digest)
        || !matches_optional_digest("poseDigest", expected.pose_digest)
    {
        return Err(
            "local Diffusers reference conditioning evidence does not match the staged base or pose input"
                .to_string(),
        );
    }
    let mask_bounds = object.get("maskBounds");
    if expected.has_mask {
        if !matches!(mask_bounds, Some(serde_json::Value::Array(bounds)) if bounds.len() == 4 && bounds.iter().all(serde_json::Value::is_number))
        {
            return Err(
                "local Diffusers mask conditioning evidence has invalid bounds".to_string(),
            );
        }
        let expected_mask_strength = expected.mask_strength.ok_or_else(|| {
            "local Diffusers mask edit is missing the compiled mask strength".to_string()
        })?;
        let observed_mask_strength = object
            .get("maskStrength")
            .and_then(serde_json::Value::as_f64);
        if observed_mask_strength
            .is_none_or(|observed| (observed - expected_mask_strength).abs() > f64::EPSILON)
        {
            return Err(
                "local Diffusers mask conditioning did not receive the compiled mask strength"
                    .to_string(),
            );
        }
    } else if !matches!(mask_bounds, None | Some(serde_json::Value::Null)) {
        return Err(
            "local Diffusers generation reported mask conditioning without a mask".to_string(),
        );
    }
    if expected.has_mask && expected.architecture == "flux-2" {
        let expected_edit_strength = expected.edit_strength.ok_or_else(|| {
            "FLUX.2 inpainting is missing the compiled global edit strength".to_string()
        })?;
        let observed_edit_strength = object
            .get("globalEditStrength")
            .and_then(serde_json::Value::as_f64);
        if observed_edit_strength
            .is_none_or(|observed| (observed - expected_edit_strength).abs() > f64::EPSILON)
        {
            return Err(
                "FLUX.2 inpainting did not receive the compiled global edit strength".to_string(),
            );
        }
    } else if !matches!(
        object.get("globalEditStrength"),
        None | Some(serde_json::Value::Null)
    ) {
        return Err(
            "local Diffusers generation reported an unexpected global edit strength".to_string(),
        );
    }
    validate_flux2_reference_binding(object, expected)?;
    validate_visible_reference_change(object, expected)?;
    for key in ["grounding", "sourceTokens"] {
        if !matches!(object.get(key), None | Some(serde_json::Value::Null)) {
            return Err(format!(
                "local Diffusers generation returned unsupported conditioning evidence: {key}"
            ));
        }
    }
    Ok(())
}

fn stage_conditioning_image(
    paths: &MediaRuntimePaths,
    input_directory: &Path,
    asset_id: &str,
    file_stem: &str,
) -> MediaResult<(database::AssetBlobSource, PathBuf)> {
    let source = database::get_published_image_blob_source(paths, asset_id)?;
    if source.byte_size == 0 || source.byte_size > MAX_IMAGE_BYTES as u64 {
        return Err("The local edit reference exceeds the bounded image input size".to_string());
    }
    let suffix = match source.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => {
            return Err(
                "The local edit reference must be a published PNG, JPEG, or WebP image asset"
                    .to_string(),
            )
        }
    };
    let source_path = safe_managed_path(&paths.blobs, &source.relative_path)?;
    let metadata = fs::symlink_metadata(&source_path)
        .map_err(|error| format!("failed to inspect local edit reference bytes: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != source.byte_size
    {
        return Err("The local edit reference failed its immutable size check".to_string());
    }
    let bytes = fs::read(&source_path)
        .map_err(|error| format!("failed to verify local edit reference bytes: {error}"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != source.digest {
        return Err("The local edit reference failed its immutable digest check".to_string());
    }
    let staged_path = input_directory.join(format!("{file_stem}.{suffix}"));
    fs::copy(&source_path, &staged_path)
        .map_err(|error| format!("failed to stage the local edit reference: {error}"))?;
    Ok((source, staged_path))
}

fn expected_image_inference_steps(architecture: &str, model_policy: &str) -> MediaResult<u32> {
    match (architecture, model_policy) {
        ("flux-2", "fast" | "balanced" | "quality") => Ok(4),
        ("krea-2", "fast") => Ok(8),
        ("krea-2", "balanced") => Ok(10),
        ("krea-2", "quality") => Ok(12),
        (_, "fast") => Ok(16),
        (_, "balanced") => Ok(24),
        (_, "quality") => Ok(32),
        _ => Err("local Diffusers request has an invalid model policy".to_string()),
    }
}

fn image_generation_timeout(_architecture: &str, _has_conditioning: bool) -> Duration {
    GENERATION_TIMEOUT
}

pub(crate) fn generate(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &GenerateMediaImagesRequest,
) -> MediaResult<LocalGeneratedImageBatch> {
    let script = worker_script(app)?;
    let (runtime, python) = ready_runtime(app, &script)?;
    let model = installed_model(paths, &request.model_id)?;
    ensure_model_is_probe_ready(paths, &model, &runtime)?;
    let has_conditioning = !request.reference_images.is_empty()
        || request.base_image_asset_id.is_some()
        || request.pose_image_asset_id.is_some();
    let supported_roles: &[&str] = match model.architecture.as_str() {
        "flux-2" => &["subject", "style", "composition", "palette", "detail"],
        "stable-diffusion-1" | "stable-diffusion-2" | "stable-diffusion-xl" | "flux-1" => {
            &["composition"]
        }
        _ => &[],
    };
    if let Some(reference) = request
        .reference_images
        .iter()
        .find(|reference| !supported_roles.contains(&reference.role.as_str()))
    {
        return Err(format!(
            "{} does not implement {} reference conditioning",
            model.architecture, reference.role
        ));
    }
    let maximum_references = match model.architecture.as_str() {
        "flux-2" => 7,
        "stable-diffusion-1" | "stable-diffusion-2" | "stable-diffusion-xl" | "flux-1" => 1,
        _ => 0,
    };
    if request.reference_images.len() > maximum_references {
        return Err(format!(
            "{} accepts at most {maximum_references} supplemental reference images",
            model.architecture
        ));
    }
    if request.prompt.is_empty() && !has_conditioning {
        return Err("prompt or supported local image conditioning is required".to_string());
    }
    if model.architecture == "krea-2" && has_conditioning {
        return Err(
            "KREA 2 supports text-to-image only; choose FLUX.2 klein for image conditioning"
                .to_string(),
        );
    }
    let addons = resolve_addons(paths, &model, &request.model_addons)?;
    let staging = create_staging_directory(paths)?;
    let input_directory = staging.0.join("input");
    let output_directory = staging.0.join("output");
    fs::create_dir(&input_directory)
        .map_err(|error| format!("failed to prepare local image inputs: {error}"))?;
    fs::create_dir(&output_directory)
        .map_err(|error| format!("failed to prepare local image outputs: {error}"))?;
    let mut staged_references = Vec::with_capacity(request.reference_images.len());
    for (index, reference) in request.reference_images.iter().enumerate() {
        let (source, path) = stage_conditioning_image(
            paths,
            &input_directory,
            &reference.asset_id,
            &format!("reference-{index:02}"),
        )?;
        staged_references.push((reference, source, path));
    }
    let (base_source, base_image_path) = if let Some(asset_id) =
        request.base_image_asset_id.as_deref()
    {
        let (source, path) = stage_conditioning_image(paths, &input_directory, asset_id, "base")?;
        (Some(source), Some(path))
    } else {
        (None, None)
    };
    let (pose_source, pose_image_path) = if let Some(asset_id) =
        request.pose_image_asset_id.as_deref()
    {
        let (source, path) = stage_conditioning_image(paths, &input_directory, asset_id, "pose")?;
        (Some(source), Some(path))
    } else {
        (None, None)
    };
    let pose_controlnet_path = if pose_image_path.is_some() {
        Some(
            openpose_controlnet_path(paths, &model.architecture)?.ok_or_else(|| {
                format!(
                    "No verified OpenPose ControlNet is installed for {}",
                    model.architecture
                )
            })?,
        )
    } else {
        None
    };
    let worker_addons = addons
        .iter()
        .map(|addon| WorkerAddon {
            kind: &addon.kind,
            addon_id: &addon.id,
            enabled: true,
            path: &addon.path,
            digest: &addon.digest,
            target_components: &addon.target_components,
            embedding_vectors: &addon.embedding_vectors,
            lora_profile: addon.lora_profile.as_ref(),
            model_strength: addon.model_strength,
            text_encoder_strength: addon.text_encoder_strength,
            denoising_schedule: addon.denoising_schedule.as_ref(),
            token: addon.token.as_deref(),
            placement: addon.placement.as_deref(),
        })
        .collect();
    let worker_request = WorkerGenerationRequest {
        schema_version: WORKER_SCHEMA_VERSION,
        model: WorkerModel {
            id: &model.id,
            architecture: &model.architecture,
            package_kind: &model.package_kind,
            path: &model.path,
            config_path: model.config_path.as_deref(),
            revision: &model.revision,
            digest: &model.digest,
        },
        prompt: &request.prompt,
        negative_prompt: &request.negative_prompt,
        output_count: request.output_count,
        output_format: &request.output_format,
        model_policy: &request.model_policy,
        aspect_ratio: &request.aspect_ratio,
        seed: request
            .seed
            .ok_or_else(|| "local Diffusers generation requires a resolved seed".to_string())?,
        output_directory: &output_directory,
        addons: worker_addons,
        reference_images: staged_references
            .iter()
            .map(|(reference, _, path)| WorkerReferenceImage {
                path,
                role: &reference.role,
                influence: reference.influence,
            })
            .collect(),
        base_image_path: base_image_path.as_deref(),
        edit_mask: request.edit_mask.as_ref(),
        pose_image_path: pose_image_path.as_deref(),
        pose_controlnet_path: pose_controlnet_path.as_deref(),
        pose_strength: request.pose_strength,
        pose_start: request.pose_start,
        pose_end: request.pose_end,
        edit_strength: request.edit_strength,
        mask_strength: request.mask_strength,
        require_chroma_background: request.require_chroma_background,
        memory_profile: request.memory_profile.as_deref(),
    };
    let encoded = serde_json::to_vec(&worker_request)
        .map_err(|error| format!("failed to encode local Diffusers request: {error}"))?;
    let output = run_worker(
        &python,
        &script,
        "generate",
        Some(&encoded),
        image_generation_timeout(&model.architecture, has_conditioning),
        Some((paths, &request.run_id)),
    )?;
    let response = decode_generation_response(&output)?;
    validate_generation_evidence(
        &response,
        &runtime,
        &request.prompt,
        &request.negative_prompt,
        &addons,
    )?;
    let expected_inference_steps =
        expected_image_inference_steps(model.architecture.as_str(), request.model_policy.as_str())?;
    if response.model_policy != request.model_policy
        || response.aspect_ratio != request.aspect_ratio
        || response.num_inference_steps != expected_inference_steps
    {
        return Err(
            "local Diffusers generation returned inconsistent sampling evidence".to_string(),
        );
    }
    if response.edit_conditioning.is_some() != has_conditioning {
        return Err(
            "local Diffusers generation returned inconsistent reference-edit evidence".to_string(),
        );
    }
    if has_conditioning {
        let reference_digests = staged_references
            .iter()
            .map(|(_, source, _)| source.digest.as_str())
            .collect::<Vec<_>>();
        let expected_conditioning = EditConditioningEvidenceExpectation {
            architecture: &model.architecture,
            references: &request.reference_images,
            reference_digests: &reference_digests,
            base_digest: base_source.as_ref().map(|source| source.digest.as_str()),
            pose_digest: pose_source.as_ref().map(|source| source.digest.as_str()),
            has_mask: request.edit_mask.is_some(),
            edit_strength: request.edit_strength,
            mask_strength: request.mask_strength,
            requires_reference_binding: model.architecture == "flux-2"
                && !request.reference_images.is_empty(),
            requires_visible_reference_change: model.architecture == "flux-2"
                && base_source.is_some()
                && !request.reference_images.is_empty(),
        };
        validate_edit_conditioning_evidence(&response, &expected_conditioning)?;
    }
    if response.require_chroma_background != request.require_chroma_background {
        return Err(
            "local Diffusers generation returned inconsistent chroma-staging evidence".to_string(),
        );
    }
    if response.outputs.len() != request.output_count as usize {
        return Err("local Diffusers worker returned an unexpected output count".to_string());
    }
    let final_output_count = response.outputs.len() * request.output_branches.len();
    let mut assets = Vec::with_capacity(final_output_count);
    let mut output_provenance = Vec::with_capacity(final_output_count);
    for (expected_index, worker_output) in response.outputs.iter().enumerate() {
        let suffix = if request.output_format == "jpeg" {
            "jpg"
        } else {
            &request.output_format
        };
        let expected_name = format!("output-{expected_index:04}.{suffix}");
        if worker_output.index as usize != expected_index
            || worker_output.file_name != expected_name
        {
            return Err("local Diffusers worker returned an invalid output manifest".to_string());
        }
        let output_path = output_directory.join(&expected_name);
        let metadata = fs::symlink_metadata(&output_path)
            .map_err(|error| format!("failed to inspect generated local image: {error}"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > MAX_IMAGE_BYTES as u64
        {
            return Err("local Diffusers worker produced an unsafe image file".to_string());
        }
        let mut bytes = fs::read(&output_path)
            .map_err(|error| format!("failed to read generated local image: {error}"))?;
        let validated =
            provider_openai::validate_image(&bytes, &request.output_format, expected_index)?;
        if validated.width != worker_output.width || validated.height != worker_output.height {
            return Err("local Diffusers output dimensions do not match its manifest".to_string());
        }
        let subject_cutout = if request.transparent_background {
            let cutout = subject_cutout::cutout_encoded(
                paths,
                &bytes,
                &request.output_format,
                &request.subject_cutout_model_priority,
            )?;
            bytes = cutout.bytes;
            Some(cutout.summary)
        } else {
            None
        };
        for (branch_index, branch) in request.output_branches.iter().enumerate() {
            let final_index = expected_index * request.output_branches.len() + branch_index;
            let processed = transform::process_image_output_branch(&bytes, branch)?;
            let validated =
                provider_openai::validate_image(&processed.bytes, &branch.format, final_index)?;
            if validated.mime_type != processed.mime_type
                || validated.width != processed.width
                || validated.height != processed.height
            {
                return Err(
                    "local diffusion output branch failed its encoded image contract".to_string(),
                );
            }
            let digest = format!("{:x}", Sha256::digest(&processed.bytes));
            let relative_path = transform::cas_relative_path(&digest);
            transform::publish_cas_bytes(paths, &relative_path, &digest, &processed.bytes)?;
            assets.push(GeneratedImageAsset {
                digest,
                relative_path: relative_path.to_string_lossy().into_owned(),
                byte_size: processed.bytes.len() as u64,
                mime_type: processed.mime_type,
                width: processed.width,
                height: processed.height,
                output_index: final_index as u32,
                subject_cutout: subject_cutout.clone(),
            });
            output_provenance.push(LocalDiffusersOutputProvenance {
                index: final_index as u32,
                source_index: worker_output.index,
                seed: worker_output.seed,
                branch_id: branch.id.clone(),
                output_node_id: branch.output_node_id.clone(),
                format: branch.format.clone(),
                quality: branch.quality,
                jpeg_background: branch.jpeg_background.clone(),
                post_processing: branch.operations.clone(),
            });
        }
    }
    Ok(LocalGeneratedImageBatch {
        assets,
        provenance: LocalDiffusersProvenance {
            worker_version: response.worker_version,
            packages: response.packages,
            device: response.device,
            device_label: response.device_label,
            device_memory_bytes: response.device_memory_bytes,
            model_revision: model.revision,
            model_digest: model.digest,
            prompt: response.prompt,
            negative_prompt: response.negative_prompt,
            model_policy: response.model_policy,
            aspect_ratio: response.aspect_ratio,
            num_inference_steps: response.num_inference_steps,
            addons: response.addons,
            performance: response.performance,
            require_chroma_background: response.require_chroma_background,
            edit_conditioning: response.edit_conditioning,
            conditioning_sources: staged_references
                .into_iter()
                .map(|(reference, source, _)| LocalConditioningSource {
                    asset_id: reference.asset_id.clone(),
                    digest: source.digest,
                    role: reference.role.clone(),
                    influence: reference.influence,
                })
                .chain(base_source.map(|source| LocalConditioningSource {
                    asset_id: request.base_image_asset_id.clone().unwrap_or_default(),
                    digest: source.digest,
                    role: "base".to_string(),
                    influence: 1.0,
                }))
                .chain(pose_source.map(|source| LocalConditioningSource {
                    asset_id: request.pose_image_asset_id.clone().unwrap_or_default(),
                    digest: source.digest,
                    role: "pose".to_string(),
                    influence: request.pose_strength.unwrap_or(1.0),
                }))
                .collect(),
            outputs: output_provenance,
        },
    })
}

const LTX_MODEL_REVISION: &str = "8984fa25007f376c1a299016d0957a37a2f797bb";
const LTX_13B_CONFIG_REVISION: &str = "7c64400e1861cc0d7b98d570a1926d5408ec60cd";
const LTX_UPSCALER_REVISION: &str = "c96c168c2bd8bbc82c9fe8259e5f89f8b2ea293f";
const LTX_13B_MODEL_ID: &str = "local:ltx-video-0.9.8-13b-distilled-fp8";
const LTX_2B_MODEL_ID: &str = "local:ltx-video-0.9.8-2b-distilled-fp8";
const FRAMEPACK_MODEL_REVISION: &str = "86cef4396041b6002c957852daac4c91aaa47c79";
const FRAMEPACK_BASE_REVISION: &str = "e8c2aaa66fe3742a32c11a6766aecbf07c56e773";
const FRAMEPACK_IMAGE_REVISION: &str = "45b801affc54ff2af4e5daf1b282e0921901db87";
const FRAMEPACK_MODEL_ID: &str = "local:framepack-i2v-hy-13b";
const HUNYUAN_VIDEO_15_MODEL_REVISION: &str = "854c04a4c8a53d990b418c7478f0802c0fc8c726";
const HUNYUAN_VIDEO_15_MODEL_ID: &str = "local:hunyuan-video-1.5-i2v-step-distilled";
const WAN_MODEL_REVISION: &str = "b8fff7315c768468a5333511427288870b2e9635";

fn framepack_download_identity(
    model_root: &Path,
    relative: &Path,
    expected_revision: &str,
) -> MediaResult<String> {
    let relative = relative
        .to_str()
        .ok_or_else(|| "FramePack component path is not valid Unicode".to_string())?
        .replace('\\', "/");
    let (metadata_root, metadata_component) =
        if let Some(transformer_relative) = relative.strip_prefix("transformer/") {
            (
                safe_managed_path(model_root, "transformer")?,
                transformer_relative,
            )
        } else {
            (model_root.to_path_buf(), relative.as_str())
        };
    let metadata_relative = format!(".cache/huggingface/download/{metadata_component}.metadata");
    let metadata_path = safe_managed_path(&metadata_root, &metadata_relative).map_err(|_| {
        format!("FramePack component {relative} has no pinned Hugging Face download metadata")
    })?;
    let metadata = fs::symlink_metadata(&metadata_path)
        .map_err(|error| format!("failed to inspect FramePack metadata for {relative}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4_096 {
        return Err(format!(
            "FramePack download metadata for {relative} is unsafe or invalid"
        ));
    }
    let encoded = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("failed to read FramePack metadata for {relative}: {error}"))?;
    let mut lines = encoded.lines().map(str::trim);
    let revision = lines.next().unwrap_or("");
    let content_identity = lines.next().unwrap_or("");
    if revision != expected_revision {
        return Err(format!(
            "FramePack component {relative} came from revision {revision}; expected {expected_revision}"
        ));
    }
    if !matches!(content_identity.len(), 40 | 64)
        || !content_identity
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!(
            "FramePack component {relative} has invalid download content identity"
        ));
    }
    Ok(content_identity.to_ascii_lowercase())
}

fn ltx_download_identity(
    model_root: &Path,
    relative: &Path,
    expected_revision: &str,
) -> MediaResult<String> {
    let relative = relative
        .to_str()
        .ok_or_else(|| "LTX-Video component path is not valid Unicode".to_string())?
        .replace('\\', "/");
    let (metadata_root, metadata_component) =
        if let Some(upscaler_relative) = relative.strip_prefix("spatial_upscaler/") {
            (
                safe_managed_path(model_root, "spatial_upscaler")?,
                upscaler_relative,
            )
        } else {
            (model_root.to_path_buf(), relative.as_str())
        };
    let metadata_relative = format!(".cache/huggingface/download/{metadata_component}.metadata");
    let metadata_path = safe_managed_path(&metadata_root, &metadata_relative).map_err(|_| {
        format!("LTX-Video component {relative} has no pinned Hugging Face download metadata")
    })?;
    let metadata = fs::symlink_metadata(&metadata_path)
        .map_err(|error| format!("failed to inspect LTX-Video metadata for {relative}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4_096 {
        return Err(format!(
            "LTX-Video download metadata for {relative} is unsafe or invalid"
        ));
    }
    let encoded = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("failed to read LTX-Video metadata for {relative}: {error}"))?;
    let mut lines = encoded.lines().map(str::trim);
    let revision = lines.next().unwrap_or("");
    let content_identity = lines.next().unwrap_or("");
    if revision != expected_revision {
        return Err(format!(
            "LTX-Video component {relative} came from revision {revision}; expected {expected_revision}"
        ));
    }
    if !matches!(content_identity.len(), 40 | 64)
        || !content_identity
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!(
            "LTX-Video component {relative} has invalid download content identity"
        ));
    }
    Ok(content_identity.to_ascii_lowercase())
}

fn ltx_index_shards(model_root: &Path, relative_index: &str) -> MediaResult<Vec<PathBuf>> {
    let index_path = safe_managed_path(model_root, relative_index)?;
    let encoded = fs::read(&index_path).map_err(|error| {
        format!("failed to read LTX-Video model index {relative_index}: {error}")
    })?;
    let index = serde_json::from_slice::<serde_json::Value>(&encoded)
        .map_err(|error| format!("LTX-Video model index {relative_index} is invalid: {error}"))?;
    let weight_map = index
        .get("weight_map")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| format!("LTX-Video model index {relative_index} has no weight_map"))?;
    let parent = Path::new(relative_index)
        .parent()
        .ok_or_else(|| format!("LTX-Video model index {relative_index} has no parent"))?;
    let mut shards = weight_map
        .values()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| {
                    format!("LTX-Video model index {relative_index} has an invalid shard")
                })
                .and_then(|name| {
                    safe_managed_path(model_root, parent.join(name).to_string_lossy().as_ref())
                })
        })
        .collect::<MediaResult<Vec<_>>>()?;
    shards.sort();
    shards.dedup();
    if shards.is_empty() || shards.len() > 64 {
        return Err(format!(
            "LTX-Video model index {relative_index} has an invalid shard inventory"
        ));
    }
    Ok(shards)
}

fn framepack_index_shards(model_root: &Path, relative_index: &str) -> MediaResult<Vec<PathBuf>> {
    let index_path = safe_managed_path(model_root, relative_index)?;
    let encoded = fs::read(&index_path).map_err(|error| {
        format!("failed to read FramePack model index {relative_index}: {error}")
    })?;
    let index = serde_json::from_slice::<serde_json::Value>(&encoded)
        .map_err(|error| format!("FramePack model index {relative_index} is invalid: {error}"))?;
    let weight_map = index
        .get("weight_map")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| format!("FramePack model index {relative_index} has no weight_map"))?;
    let parent = Path::new(relative_index)
        .parent()
        .ok_or_else(|| format!("FramePack model index {relative_index} has no parent"))?;
    let mut shards = weight_map
        .values()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| {
                    format!("FramePack model index {relative_index} has an invalid shard")
                })
                .and_then(|name| {
                    safe_managed_path(model_root, parent.join(name).to_string_lossy().as_ref())
                })
        })
        .collect::<MediaResult<Vec<_>>>()?;
    shards.sort();
    shards.dedup();
    if shards.is_empty() || shards.len() > 64 {
        return Err(format!(
            "FramePack model index {relative_index} has an invalid shard inventory"
        ));
    }
    Ok(shards)
}

fn hunyuan_video_15_download_identity(model_root: &Path, relative: &Path) -> MediaResult<String> {
    let relative = relative
        .to_str()
        .ok_or_else(|| "HunyuanVideo 1.5 component path is not valid Unicode".to_string())?
        .replace('\\', "/");
    let metadata_relative = format!(".cache/huggingface/download/{relative}.metadata");
    let metadata_path = safe_managed_path(model_root, &metadata_relative).map_err(|_| {
        format!("HunyuanVideo 1.5 component {relative} has no pinned Hugging Face metadata")
    })?;
    let metadata = fs::symlink_metadata(&metadata_path).map_err(|error| {
        format!("failed to inspect HunyuanVideo 1.5 metadata for {relative}: {error}")
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4_096 {
        return Err(format!(
            "HunyuanVideo 1.5 download metadata for {relative} is unsafe or invalid"
        ));
    }
    let encoded = fs::read_to_string(&metadata_path).map_err(|error| {
        format!("failed to read HunyuanVideo 1.5 metadata for {relative}: {error}")
    })?;
    let mut lines = encoded.lines().map(str::trim);
    let revision = lines.next().unwrap_or("");
    let content_identity = lines.next().unwrap_or("");
    if revision != HUNYUAN_VIDEO_15_MODEL_REVISION {
        return Err(format!(
            "HunyuanVideo 1.5 component {relative} came from revision {revision}; expected {HUNYUAN_VIDEO_15_MODEL_REVISION}"
        ));
    }
    if !matches!(content_identity.len(), 40 | 64)
        || !content_identity
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!(
            "HunyuanVideo 1.5 component {relative} has invalid download content identity"
        ));
    }
    Ok(content_identity.to_ascii_lowercase())
}

fn hunyuan_video_15_index_shards(
    model_root: &Path,
    relative_index: &str,
) -> MediaResult<Vec<PathBuf>> {
    let index_path = safe_managed_path(model_root, relative_index)?;
    let encoded = fs::read(&index_path).map_err(|error| {
        format!("failed to read HunyuanVideo 1.5 model index {relative_index}: {error}")
    })?;
    let index = serde_json::from_slice::<serde_json::Value>(&encoded).map_err(|error| {
        format!("HunyuanVideo 1.5 model index {relative_index} is invalid: {error}")
    })?;
    let weight_map = index
        .get("weight_map")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| {
            format!("HunyuanVideo 1.5 model index {relative_index} has no weight_map")
        })?;
    let parent = Path::new(relative_index)
        .parent()
        .ok_or_else(|| format!("HunyuanVideo 1.5 model index {relative_index} has no parent"))?;
    let mut shards = weight_map
        .values()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| {
                    format!("HunyuanVideo 1.5 model index {relative_index} has an invalid shard")
                })
                .and_then(|name| {
                    safe_managed_path(model_root, parent.join(name).to_string_lossy().as_ref())
                })
        })
        .collect::<MediaResult<Vec<_>>>()?;
    shards.sort();
    shards.dedup();
    if shards.is_empty() || shards.len() > 64 {
        return Err(format!(
            "HunyuanVideo 1.5 model index {relative_index} has an invalid shard inventory"
        ));
    }
    Ok(shards)
}

fn resolve_hunyuan_video_15_model(workspace_root: &str) -> MediaResult<(PathBuf, String)> {
    let workspace = crate::runtime_snapshot::resolve_workspace_root_path(workspace_root)?;
    let models_root = fs::canonicalize(workspace.join("models"))
        .map_err(|error| format!("failed to resolve workspace models directory: {error}"))?;
    let model_root = super::model_discovery::resolve_workspace_diffusers_package(
        workspace_root,
        "hunyuan-video-1.5-i2v",
        Some("hunyuan-video-1.5-i2v-step-distilled"),
    )?;
    if !model_root.starts_with(&models_root) {
        return Err(
            "HunyuanVideo 1.5 model path escapes the workspace models directory".to_string(),
        );
    }
    let model_index_path = safe_managed_path(&model_root, "model_index.json")?;
    let model_index = fs::read(&model_index_path)
        .map_err(|error| format!("failed to read HunyuanVideo 1.5 model_index.json: {error}"))?;
    let model_index_value = serde_json::from_slice::<serde_json::Value>(&model_index)
        .map_err(|error| format!("HunyuanVideo 1.5 model_index.json is invalid: {error}"))?;
    if model_index_value
        .get("_class_name")
        .and_then(serde_json::Value::as_str)
        != Some("HunyuanVideo15ImageToVideoPipeline")
    {
        return Err(
            "HunyuanVideo 1.5 package does not declare the expected I2V pipeline".to_string(),
        );
    }
    let mut files = vec![
        model_index_path,
        safe_managed_path(&model_root, "scheduler/scheduler_config.json")?,
        safe_managed_path(&model_root, "guider/guider_config.json")?,
        safe_managed_path(&model_root, "text_encoder/config.json")?,
        safe_managed_path(&model_root, "text_encoder/model.safetensors.index.json")?,
        safe_managed_path(&model_root, "text_encoder_2/config.json")?,
        safe_managed_path(&model_root, "text_encoder_2/model.safetensors")?,
        safe_managed_path(&model_root, "tokenizer/tokenizer.json")?,
        safe_managed_path(&model_root, "tokenizer/tokenizer_config.json")?,
        safe_managed_path(&model_root, "tokenizer_2/tokenizer_config.json")?,
        safe_managed_path(&model_root, "transformer/config.json")?,
        safe_managed_path(
            &model_root,
            "transformer/diffusion_pytorch_model.safetensors.index.json",
        )?,
        safe_managed_path(&model_root, "vae/config.json")?,
        safe_managed_path(&model_root, "vae/diffusion_pytorch_model.safetensors")?,
        safe_managed_path(&model_root, "feature_extractor/preprocessor_config.json")?,
        safe_managed_path(&model_root, "image_encoder/config.json")?,
        safe_managed_path(&model_root, "image_encoder/model.safetensors")?,
    ];
    files.extend(hunyuan_video_15_index_shards(
        &model_root,
        "text_encoder/model.safetensors.index.json",
    )?);
    files.extend(hunyuan_video_15_index_shards(
        &model_root,
        "transformer/diffusion_pytorch_model.safetensors.index.json",
    )?);
    files.sort();
    files.dedup();
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-hunyuan-video-1.5-i2v-step-distilled-inventory-v1\0");
    let mut verified_bytes = 0_u64;
    for path in files {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("HunyuanVideo 1.5 package is incomplete: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
            return Err(format!(
                "HunyuanVideo 1.5 package contains an unsafe or empty component: {}",
                path.display()
            ));
        }
        let relative = path
            .strip_prefix(&model_root)
            .map_err(|_| "HunyuanVideo 1.5 component escaped its model package".to_string())?;
        let identity = hunyuan_video_15_download_identity(&model_root, relative)?;
        verified_bytes = verified_bytes.saturating_add(metadata.len());
        hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(identity.as_bytes());
    }
    if verified_bytes < 29 * 1_024 * 1_024 * 1_024 {
        return Err(format!(
            "HunyuanVideo 1.5 package is incomplete: verified components total only {:.2} GiB",
            verified_bytes as f64 / 1_024_f64.powi(3)
        ));
    }
    Ok((model_root, format!("sha256:{:x}", hasher.finalize())))
}

fn resolve_framepack_model(workspace_root: &str) -> MediaResult<(PathBuf, String)> {
    let workspace = crate::runtime_snapshot::resolve_workspace_root_path(workspace_root)?;
    let models_root = fs::canonicalize(workspace.join("models"))
        .map_err(|error| format!("failed to resolve workspace models directory: {error}"))?;
    let model_root = super::model_discovery::resolve_workspace_diffusers_package(
        workspace_root,
        "framepack-i2v",
        Some("framepack-i2v-hy"),
    )?;
    if !model_root.starts_with(&models_root) {
        return Err("FramePack model path escapes the workspace models directory".to_string());
    }
    let model_index_path = safe_managed_path(&model_root, "model_index.json")?;
    let model_index = fs::read(&model_index_path)
        .map_err(|error| format!("failed to read FramePack model_index.json: {error}"))?;
    let model_index_value = serde_json::from_slice::<serde_json::Value>(&model_index)
        .map_err(|error| format!("FramePack model_index.json is invalid: {error}"))?;
    if model_index_value
        .get("_class_name")
        .and_then(serde_json::Value::as_str)
        != Some("HunyuanVideoPipeline")
    {
        return Err(
            "FramePack package does not declare the expected HunyuanVideoPipeline base".to_string(),
        );
    }
    let mut files = vec![
        model_index_path,
        safe_managed_path(&model_root, "scheduler/scheduler_config.json")?,
        safe_managed_path(&model_root, "text_encoder/config.json")?,
        safe_managed_path(&model_root, "text_encoder/model.safetensors.index.json")?,
        safe_managed_path(&model_root, "text_encoder_2/config.json")?,
        safe_managed_path(&model_root, "text_encoder_2/model.safetensors")?,
        safe_managed_path(&model_root, "tokenizer/tokenizer.json")?,
        safe_managed_path(&model_root, "tokenizer/tokenizer_config.json")?,
        safe_managed_path(&model_root, "tokenizer_2/merges.txt")?,
        safe_managed_path(&model_root, "tokenizer_2/tokenizer_config.json")?,
        safe_managed_path(&model_root, "tokenizer_2/vocab.json")?,
        safe_managed_path(&model_root, "transformer/config.json")?,
        safe_managed_path(
            &model_root,
            "transformer/diffusion_pytorch_model.safetensors.index.json",
        )?,
        safe_managed_path(&model_root, "vae/config.json")?,
        safe_managed_path(&model_root, "vae/diffusion_pytorch_model.safetensors")?,
        safe_managed_path(&model_root, "feature_extractor/preprocessor_config.json")?,
        safe_managed_path(&model_root, "image_encoder/config.json")?,
        safe_managed_path(&model_root, "image_encoder/model.safetensors")?,
    ];
    files.extend(framepack_index_shards(
        &model_root,
        "text_encoder/model.safetensors.index.json",
    )?);
    files.extend(framepack_index_shards(
        &model_root,
        "transformer/diffusion_pytorch_model.safetensors.index.json",
    )?);
    files.sort();
    files.dedup();
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-framepack-i2v-hy-inventory-v1\0");
    let mut verified_bytes = 0_u64;
    for path in files {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("FramePack model package is incomplete: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
            return Err(format!(
                "FramePack package contains an unsafe or empty component: {}",
                path.display()
            ));
        }
        let relative = path
            .strip_prefix(&model_root)
            .map_err(|_| "FramePack component escaped its model package".to_string())?;
        let expected_revision = if relative.starts_with("transformer") {
            FRAMEPACK_MODEL_REVISION
        } else if relative.starts_with("feature_extractor") || relative.starts_with("image_encoder")
        {
            FRAMEPACK_IMAGE_REVISION
        } else {
            FRAMEPACK_BASE_REVISION
        };
        let identity = framepack_download_identity(&model_root, relative, expected_revision)?;
        verified_bytes = verified_bytes.saturating_add(metadata.len());
        hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(identity.as_bytes());
    }
    if verified_bytes < 38 * 1_024 * 1_024 * 1_024 {
        return Err(format!(
            "FramePack package is incomplete: verified components total only {:.2} GiB",
            verified_bytes as f64 / 1_024_f64.powi(3)
        ));
    }
    Ok((model_root, format!("sha256:{:x}", hasher.finalize())))
}

fn resolve_ltx_model(workspace_root: &str) -> MediaResult<(PathBuf, String)> {
    let workspace = crate::runtime_snapshot::resolve_workspace_root_path(workspace_root)?;
    let models_root = fs::canonicalize(workspace.join("models"))
        .map_err(|error| format!("failed to resolve workspace models directory: {error}"))?;
    let model_root = super::model_discovery::resolve_workspace_diffusers_package(
        workspace_root,
        "ltx-video",
        Some("ltx-video-0.9.8"),
    )?;
    if !model_root.starts_with(&models_root) {
        return Err("LTX-Video model path escapes the workspace models directory".to_string());
    }
    let model_index_path = safe_managed_path(&model_root, "model_index.json")?;
    let model_index = fs::read(&model_index_path)
        .map_err(|error| format!("failed to read LTX-Video model_index.json: {error}"))?;
    let model_index_value = serde_json::from_slice::<serde_json::Value>(&model_index)
        .map_err(|error| format!("LTX-Video model_index.json is invalid: {error}"))?;
    if !matches!(
        model_index_value
            .get("_class_name")
            .and_then(serde_json::Value::as_str),
        Some("LTXPipeline") | Some("LTXConditionPipeline")
    ) {
        return Err("LTX-Video package does not declare an expected pipeline class".to_string());
    }
    let mut files = vec![
        model_index_path,
        safe_managed_path(&model_root, "scheduler/scheduler_config.json")?,
        safe_managed_path(&model_root, "spatial_upscaler/model_index.json")?,
        safe_managed_path(&model_root, "spatial_upscaler/latent_upsampler/config.json")?,
        safe_managed_path(
            &model_root,
            "spatial_upscaler/latent_upsampler/diffusion_pytorch_model.safetensors",
        )?,
        safe_managed_path(&model_root, "text_encoder/config.json")?,
        safe_managed_path(&model_root, "text_encoder/model.safetensors.index.json")?,
        safe_managed_path(&model_root, "tokenizer/added_tokens.json")?,
        safe_managed_path(&model_root, "tokenizer/special_tokens_map.json")?,
        safe_managed_path(&model_root, "tokenizer/spiece.model")?,
        safe_managed_path(&model_root, "tokenizer/tokenizer_config.json")?,
        safe_managed_path(&model_root, "transformer/config.json")?,
        safe_managed_path(&model_root, "transformer-13b/config.json")?,
        safe_managed_path(&model_root, "vae/config.json")?,
        safe_managed_path(&model_root, "vae/diffusion_pytorch_model.safetensors")?,
        safe_managed_path(&model_root, "ltxv-2b-0.9.8-distilled-fp8.safetensors")?,
        safe_managed_path(&model_root, "ltxv-13b-0.9.8-distilled-fp8.safetensors")?,
        safe_managed_path(&model_root, "LTX-Video-Open-Weights-License-0.X.txt")?,
    ];
    files.extend(ltx_index_shards(
        &model_root,
        "text_encoder/model.safetensors.index.json",
    )?);
    files.sort();
    files.dedup();
    let mut hasher = Sha256::new();
    hasher.update(LTX_MODEL_REVISION.as_bytes());
    let mut verified_bytes = 0_u64;
    for path in files {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("LTX-Video model package is incomplete: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
            return Err(format!(
                "LTX-Video package contains an unsafe or empty component: {}",
                path.display()
            ));
        }
        let relative = path
            .strip_prefix(&model_root)
            .map_err(|_| "LTX-Video component escaped its model package".to_string())?;
        let expected_revision = if relative.starts_with("spatial_upscaler") {
            LTX_UPSCALER_REVISION
        } else if matches!(
            relative.to_str(),
            Some("transformer-13b/config.json") | Some("scheduler/scheduler_config.json")
        ) {
            LTX_13B_CONFIG_REVISION
        } else {
            LTX_MODEL_REVISION
        };
        let identity = ltx_download_identity(&model_root, relative, expected_revision)?;
        verified_bytes = verified_bytes.saturating_add(metadata.len());
        hasher.update(relative.to_string_lossy().replace('\\', "/").as_bytes());
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(identity.as_bytes());
    }
    if verified_bytes < 35 * 1_024 * 1_024 * 1_024 {
        return Err(format!(
            "LTX-Video package is incomplete: verified components total only {:.2} GiB",
            verified_bytes as f64 / 1_024_f64.powi(3)
        ));
    }
    Ok((model_root, format!("sha256:{:x}", hasher.finalize())))
}

fn wan_download_identity(model_root: &Path, relative: &Path) -> MediaResult<String> {
    let relative = relative
        .to_str()
        .ok_or_else(|| "Wan component path is not valid Unicode".to_string())?
        .replace('\\', "/");
    let metadata_relative = format!(".cache/huggingface/download/{relative}.metadata");
    let metadata_path = safe_managed_path(model_root, &metadata_relative).map_err(|_| {
        format!(
            "Wan component {relative} has no pinned Hugging Face download metadata; re-download revision {WAN_MODEL_REVISION}"
        )
    })?;
    let metadata = fs::symlink_metadata(&metadata_path)
        .map_err(|error| format!("failed to inspect Wan metadata for {relative}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 4_096 {
        return Err(format!(
            "Wan download metadata for {relative} is unsafe or invalid"
        ));
    }
    let encoded = fs::read_to_string(&metadata_path)
        .map_err(|error| format!("failed to read Wan metadata for {relative}: {error}"))?;
    let mut lines = encoded.lines().map(str::trim);
    let revision = lines.next().unwrap_or("");
    let content_identity = lines.next().unwrap_or("");
    if revision != WAN_MODEL_REVISION {
        return Err(format!(
            "Wan component {relative} came from revision {revision}; expected {WAN_MODEL_REVISION}"
        ));
    }
    if !matches!(content_identity.len(), 40 | 64)
        || !content_identity
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(format!(
            "Wan component {relative} has invalid download content identity"
        ));
    }
    Ok(content_identity.to_ascii_lowercase())
}

fn wan_index_shards(model_root: &Path, relative_index: &str) -> MediaResult<Vec<PathBuf>> {
    let index_path = safe_managed_path(model_root, relative_index)?;
    let encoded = fs::read(&index_path)
        .map_err(|error| format!("failed to read Wan model index {relative_index}: {error}"))?;
    let index = serde_json::from_slice::<serde_json::Value>(&encoded)
        .map_err(|error| format!("Wan model index {relative_index} is invalid: {error}"))?;
    let weight_map = index
        .get("weight_map")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| format!("Wan model index {relative_index} has no weight_map"))?;
    let parent = Path::new(relative_index)
        .parent()
        .ok_or_else(|| format!("Wan model index {relative_index} has no parent"))?;
    let mut shards = weight_map
        .values()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| format!("Wan model index {relative_index} has an invalid shard"))
                .and_then(|name| {
                    safe_managed_path(model_root, parent.join(name).to_string_lossy().as_ref())
                })
        })
        .collect::<MediaResult<Vec<_>>>()?;
    shards.sort();
    shards.dedup();
    if shards.is_empty() || shards.len() > 64 {
        return Err(format!(
            "Wan model index {relative_index} has an invalid shard inventory"
        ));
    }
    Ok(shards)
}

fn resolve_wan_model(workspace_root: &str) -> MediaResult<(PathBuf, String)> {
    let workspace = crate::runtime_snapshot::resolve_workspace_root_path(workspace_root)?;
    let models_root = workspace.join("models");
    let models_root = fs::canonicalize(&models_root)
        .map_err(|error| format!("failed to resolve workspace models directory: {error}"))?;
    let model_root = super::model_discovery::resolve_workspace_diffusers_package(
        workspace_root,
        "wan-2.2-ti2v",
        Some("wan-2.2-ti2v-5b"),
    )?;
    if !model_root.starts_with(&models_root) {
        return Err("Wan model path escapes the workspace models directory".to_string());
    }
    let model_index_path = safe_managed_path(&model_root, "model_index.json")?;
    let model_index = fs::read(&model_index_path)
        .map_err(|error| format!("failed to read Wan model_index.json: {error}"))?;
    let model_index_value = serde_json::from_slice::<serde_json::Value>(&model_index)
        .map_err(|error| format!("Wan model_index.json is invalid: {error}"))?;
    if model_index_value
        .get("_class_name")
        .and_then(serde_json::Value::as_str)
        != Some("WanPipeline")
    {
        return Err(
            "Wan model package does not declare the expected WanPipeline class".to_string(),
        );
    }
    let mut files = vec![
        model_index_path,
        safe_managed_path(&model_root, "scheduler/scheduler_config.json")?,
        safe_managed_path(&model_root, "text_encoder/config.json")?,
        safe_managed_path(&model_root, "tokenizer/tokenizer_config.json")?,
        safe_managed_path(&model_root, "tokenizer/special_tokens_map.json")?,
        safe_managed_path(&model_root, "tokenizer/spiece.model")?,
        safe_managed_path(&model_root, "tokenizer/tokenizer.json")?,
        safe_managed_path(&model_root, "transformer/config.json")?,
        safe_managed_path(&model_root, "vae/config.json")?,
        safe_managed_path(&model_root, "vae/diffusion_pytorch_model.safetensors")?,
        safe_managed_path(&model_root, "text_encoder/model.safetensors.index.json")?,
        safe_managed_path(
            &model_root,
            "transformer/diffusion_pytorch_model.safetensors.index.json",
        )?,
    ];
    files.extend(wan_index_shards(
        &model_root,
        "text_encoder/model.safetensors.index.json",
    )?);
    files.extend(wan_index_shards(
        &model_root,
        "transformer/diffusion_pytorch_model.safetensors.index.json",
    )?);
    files.sort();
    files.dedup();
    let mut total_bytes = 0_u64;
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-wan2.2-ti2v-inventory-v1\0");
    hasher.update(WAN_MODEL_REVISION.as_bytes());
    for path in files {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Wan model package is incomplete: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() == 0 {
            return Err(format!(
                "Wan model package contains an unsafe or empty component: {}",
                path.display()
            ));
        }
        let relative = path
            .strip_prefix(&model_root)
            .map_err(|_| "Wan component escaped its model package".to_string())?;
        let content_identity = wan_download_identity(&model_root, relative)?;
        total_bytes = total_bytes.saturating_add(metadata.len());
        hasher.update(relative.to_string_lossy().as_bytes());
        hasher.update(b"\0");
        hasher.update(metadata.len().to_le_bytes());
        hasher.update(b"\0");
        hasher.update(content_identity.as_bytes());
        if path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        {
            hasher.update(
                fs::read(&path)
                    .map_err(|error| format!("failed to verify Wan JSON component: {error}"))?,
            );
        }
    }
    if total_bytes < 30 * 1_024 * 1_024 * 1_024 {
        return Err(format!(
            "Wan model package is incomplete: verified components total only {:.2} GiB",
            total_bytes as f64 / 1_024_f64.powi(3)
        ));
    }
    Ok((model_root, format!("{:x}", hasher.finalize())))
}

fn decode_video_generation_response(output: &Output) -> MediaResult<WorkerVideoGenerationResponse> {
    if !output.status.success() {
        if let Ok(failure) = serde_json::from_slice::<WorkerFailure>(&output.stdout) {
            return Err(worker_failure_with_diagnostics(
                failure.error,
                &output.stderr,
            ));
        }
        let diagnostic = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if diagnostic.is_empty() {
            format!("local WAN worker exited with {}", output.status)
        } else {
            format!(
                "local WAN worker exited with {}: {diagnostic}",
                output.status
            )
        });
    }
    let response = serde_json::from_slice::<WorkerVideoGenerationResponse>(&output.stdout)
        .map_err(|error| format!("local WAN worker returned invalid JSON: {error}"))?;
    if response.schema_version != WORKER_SCHEMA_VERSION {
        return Err("local WAN worker returned an unsupported schema".to_string());
    }
    Ok(response)
}

fn stage_wan_frame(
    paths: &MediaRuntimePaths,
    input_directory: &Path,
    asset_id: &str,
    role: &str,
) -> MediaResult<(database::AssetBlobSource, PathBuf)> {
    let source = database::get_published_image_blob_source(paths, asset_id)?;
    if source.byte_size == 0 || source.byte_size > MAX_IMAGE_BYTES as u64 {
        return Err(format!(
            "The WAN {role} frame exceeds the bounded image input size"
        ));
    }
    let suffix = match source.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => {
            return Err(format!(
                "The WAN {role} frame must be a published PNG, JPEG, or WebP image asset"
            ))
        }
    };
    let source_path = safe_managed_path(&paths.blobs, &source.relative_path)?;
    let source_metadata = fs::symlink_metadata(&source_path)
        .map_err(|error| format!("failed to inspect WAN {role}-frame bytes: {error}"))?;
    if source_metadata.file_type().is_symlink()
        || !source_metadata.is_file()
        || source_metadata.len() != source.byte_size
    {
        return Err(format!(
            "The WAN {role}-frame blob failed its immutable size check"
        ));
    }
    let staged_path = input_directory.join(format!("{role}-frame.{suffix}"));
    fs::copy(&source_path, &staged_path)
        .map_err(|error| format!("failed to stage the WAN {role} frame: {error}"))?;
    Ok((source, staged_path))
}

pub(crate) fn generate_video(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &GenerateMediaVideoRequest,
) -> MediaResult<LocalGeneratedVideo> {
    let script = worker_script(app)?;
    let (runtime, python) = ready_runtime(app, &script)?;
    let (architecture, model_revision, model_path, model_digest) = match request.model_id.as_str() {
        HUNYUAN_VIDEO_15_MODEL_ID => {
            let (path, digest) = resolve_hunyuan_video_15_model(&request.workspace_root)?;
            (
                "hunyuan-video-1.5-i2v",
                HUNYUAN_VIDEO_15_MODEL_REVISION,
                path,
                digest,
            )
        }
        FRAMEPACK_MODEL_ID => {
            let (path, digest) = resolve_framepack_model(&request.workspace_root)?;
            ("framepack-i2v", FRAMEPACK_MODEL_REVISION, path, digest)
        }
        LTX_13B_MODEL_ID | LTX_2B_MODEL_ID => {
            let (path, digest) = resolve_ltx_model(&request.workspace_root)?;
            ("ltx-video", LTX_MODEL_REVISION, path, digest)
        }
        "local:wan2.2-ti2v-5b" => {
            let (path, digest) = resolve_wan_model(&request.workspace_root)?;
            ("wan-2.2-ti2v", WAN_MODEL_REVISION, path, digest)
        }
        _ => return Err("The selected model is not an executable local video variant".to_string()),
    };
    if !runtime.ready
        || !runtime.architectures.contains(&architecture.to_string())
        || !runtime.capabilities.contains(&"image-to-video".to_string())
        || (architecture != "hunyuan-video-1.5-i2v"
            && !runtime
                .capabilities
                .contains(&"start-end-to-video".to_string()))
        || !runtime.capabilities.contains(&"vp9-alpha".to_string())
        || (request.animated_background.is_some()
            && !runtime
                .capabilities
                .contains(&"video-composite".to_string()))
    {
        return Err(format!(
            "The local video runtime is not ready: {}",
            runtime.diagnostic
        ));
    }
    if request.model_id == LTX_13B_MODEL_ID
        && (runtime.device.as_deref() == Some("cpu")
            || runtime
                .device_memory_bytes
                .is_some_and(|bytes| bytes < MIN_EXPERIMENTAL_VIDEO_MEMORY_BYTES))
    {
        return Err(
            "LTX-Video 13B requires a nominal 16 GB GPU; select the 2B variant on this hardware."
                .to_string(),
        );
    }
    if request.model_id == FRAMEPACK_MODEL_ID
        && (runtime.device.as_deref() == Some("cpu")
            || runtime
                .device_memory_bytes
                .is_some_and(|bytes| bytes < MIN_FRAMEPACK_MEMORY_BYTES)
            || runtime
                .physical_memory_bytes
                .is_some_and(|bytes| bytes < 30 * 1_024 * 1_024 * 1_024))
    {
        return Err(
            "FramePack 13B requires a bfloat16 GPU with at least 6 GiB usable VRAM and 30 GiB physical RAM; select LTX-Video 2B on this hardware."
                .to_string(),
        );
    }
    if request.model_id == HUNYUAN_VIDEO_15_MODEL_ID
        && (runtime.device.as_deref() == Some("cpu")
            || runtime
                .device_memory_bytes
                .is_some_and(|bytes| bytes < MIN_HUNYUAN_VIDEO_15_MEMORY_BYTES)
            || runtime
                .physical_memory_bytes
                .is_some_and(|bytes| bytes < 30 * 1_024 * 1_024 * 1_024))
    {
        return Err(
            "HunyuanVideo 1.5 I2V requires a bfloat16 GPU with at least 14 GiB usable VRAM and 30 GiB physical RAM; select FramePack or LTX-Video 2B on this hardware."
                .to_string(),
        );
    }
    let staging = create_staging_directory(paths)?;
    let input_directory = staging.0.join("input");
    let output_directory = staging.0.join("output");
    fs::create_dir(&input_directory)
        .map_err(|error| format!("failed to prepare video input staging: {error}"))?;
    fs::create_dir(&output_directory)
        .map_err(|error| format!("failed to prepare video output staging: {error}"))?;
    let (first_source, first_frame_path) = stage_wan_frame(
        paths,
        &input_directory,
        &request.first_frame_asset_id,
        "first",
    )?;
    let (last_source, last_frame_path) = stage_wan_frame(
        paths,
        &input_directory,
        &request.last_frame_asset_id,
        "last",
    )?;
    if architecture == "hunyuan-video-1.5-i2v" && first_source.digest != last_source.digest {
        return Err(
            "HunyuanVideo 1.5 I2V supports one native first-frame reference. Use FramePack or LTX-Video when the first and last references differ."
                .to_string(),
        );
    }
    let worker_request = WorkerVideoGenerationRequest {
        schema_version: WORKER_SCHEMA_VERSION,
        model: WorkerModel {
            id: &request.model_id,
            architecture,
            package_kind: "diffusers-directory",
            path: &model_path,
            config_path: None,
            revision: model_revision,
            digest: &model_digest,
        },
        prompt: &request.prompt,
        first_frame_path: &first_frame_path,
        last_frame_path: &last_frame_path,
        aspect_ratio: &request.aspect_ratio,
        resolution: &request.resolution,
        num_frames: request.num_frames,
        num_inference_steps: request.num_inference_steps,
        guidance_scale: request.guidance_scale,
        negative_prompt: &request.negative_prompt,
        transparent_background: request.transparent_background,
        loop_mode: &request.loop_mode,
        matte_quality: &request.matte_quality,
        encoding_quality: &request.encoding_quality,
        memory_profile: &request.memory_profile,
        fps: request.fps,
        seed: request.seed,
        experimental_low_memory: request.experimental_low_memory,
        animated_background: request.animated_background.as_ref(),
        output_directory: &output_directory,
    };
    let encoded = serde_json::to_vec(&worker_request)
        .map_err(|error| format!("failed to encode the local video request: {error}"))?;
    let output = run_worker(
        &python,
        &script,
        "generate-video",
        Some(&encoded),
        VIDEO_GENERATION_TIMEOUT,
        Some((paths, &request.run_id)),
    )?;
    let response = decode_video_generation_response(&output)?;
    let expected_dimensions = match (
        architecture,
        request.resolution.as_str(),
        request.aspect_ratio.as_str(),
    ) {
        ("hunyuan-video-1.5-i2v", "preview-512", "1:1") => (512, 512),
        ("hunyuan-video-1.5-i2v", "preview-512", "16:9") => (672, 384),
        ("hunyuan-video-1.5-i2v", "preview-512", "9:16") => (384, 672),
        ("hunyuan-video-1.5-i2v", "preview-512", "21:9") => (768, 336),
        ("hunyuan-video-1.5-i2v", "quality-640", "1:1") => (640, 640),
        ("hunyuan-video-1.5-i2v", "quality-640", "16:9") => (848, 480),
        ("hunyuan-video-1.5-i2v", "quality-640", "9:16") => (480, 832),
        ("hunyuan-video-1.5-i2v", "quality-640", "21:9") => (944, 416),
        ("hunyuan-video-1.5-i2v", "quality-768", "1:1") => (768, 768),
        ("hunyuan-video-1.5-i2v", "quality-768", "16:9") => (1_024, 576),
        ("hunyuan-video-1.5-i2v", "quality-768", "9:16") => (576, 1_008),
        ("hunyuan-video-1.5-i2v", "quality-768", "21:9") => (1_152, 496),
        (_, "preview-512", "1:1") => (512, 512),
        (_, "preview-512", "16:9") => (512, 288),
        (_, "preview-512", "9:16") => (288, 512),
        (_, "preview-512", "21:9") => (512, 224),
        (_, "quality-640", "1:1") => (576, 576),
        (_, "quality-640", "16:9") => (640, 352),
        (_, "quality-640", "9:16") => (352, 640),
        (_, "quality-640", "21:9") => (640, 288),
        ("ltx-video", "quality-768", "1:1") => (640, 640),
        ("ltx-video", "quality-768", "16:9") => (768, 448),
        ("ltx-video", "quality-768", "9:16") => (448, 768),
        ("ltx-video", "quality-768", "21:9") => (768, 320),
        (_, "quality-768", "1:1") => (640, 640),
        (_, "quality-768", "16:9") => (768, 432),
        (_, "quality-768", "9:16") => (432, 768),
        (_, "quality-768", "21:9") => (768, 336),
        _ => unreachable!("validated video resolution and aspect ratio"),
    };
    let expected_frame_count = match request.loop_mode.as_str() {
        "ping-pong" => request.num_frames * 2 - 2,
        "seamless" => request.num_frames - 1,
        _ => request.num_frames,
    };
    let expected_pixel_format = if request.transparent_background {
        "yuva420p"
    } else if request.encoding_quality == "lossless" {
        "yuv444p"
    } else {
        "yuv420p"
    };
    let expected_color_range = if expected_pixel_format == "yuv444p" {
        "full"
    } else {
        "limited"
    };
    let expected_composite_pixel_format = if request.encoding_quality == "lossless" {
        "yuv444p"
    } else {
        "yuv420p"
    };
    let expected_composite_color_range = if expected_composite_pixel_format == "yuv444p" {
        "full"
    } else {
        "limited"
    };
    let expected_conditioning_mode = match architecture {
        "hunyuan-video-1.5-i2v" => "hunyuan-video-1.5-native-first-frame",
        "framepack-i2v" => "framepack-inverted-anti-drifting-first-last",
        "ltx-video"
            if request.model_id == LTX_13B_MODEL_ID && request.resolution != "preview-512" =>
        {
            "ltx-native-first-last-keyframes-multiscale"
        }
        "ltx-video" => "ltx-native-first-last-keyframes",
        _ => "first-last-temporal-context-lock-v3",
    };
    let expects_loop_seam = request.loop_mode != "none";
    if response.worker_version != runtime.worker_version.as_deref().unwrap_or("")
        || response.packages != runtime.packages
        || response.device != runtime.device.as_deref().unwrap_or("")
        || response.device_label != runtime.device_label.as_deref().unwrap_or("")
        || response.device_memory_bytes != runtime.device_memory_bytes
        || response.architecture != architecture
        || response.performance.is_none()
        || response.prompt != request.prompt
        || (!request.negative_prompt.is_empty()
            && response.negative_prompt != request.negative_prompt)
        || response.resolution != request.resolution
        || response.requested_guidance_scale != Some(request.guidance_scale)
        || response.guidance_scale
            != if matches!(architecture, "ltx-video" | "hunyuan-video-1.5-i2v") {
                1.0
            } else {
                request.guidance_scale
            }
        || response.requested_num_inference_steps != Some(request.num_inference_steps)
        || response.num_inference_steps
            != match architecture {
                "ltx-video" => 8,
                "hunyuan-video-1.5-i2v" if request.num_inference_steps <= 8 => 8,
                "hunyuan-video-1.5-i2v" => 12,
                _ => request.num_inference_steps,
            }
        || response.transparent_background != request.transparent_background
        || response.model_revision != model_revision
        || response.model_digest != model_digest
        || response.output.index != 0
        || response.output.file_name != "output-0000.webm"
        || (response.output.width, response.output.height) != expected_dimensions
        || response.output.source_frame_count != request.num_frames
        || response.output.frame_count != expected_frame_count
        || response.output.fps != request.fps
        || response.output.loop_mode != request.loop_mode
        || !response.output.loop_endpoint_mae.is_finite()
        || response.output.loop_endpoint_mae < 0.0
        || !response.output.loop_boundary_reference_mae.is_finite()
        || response.output.loop_boundary_reference_mae < 0.0
        || !response.output.loop_boundary_continuity_ratio.is_finite()
        || response.output.loop_boundary_continuity_ratio < 0.0
        || response.output.decoded_frame_count != response.output.frame_count
        || !response.output.decoded_loop_endpoint_mae.is_finite()
        || response.output.decoded_loop_endpoint_mae < 0.0
        || !response
            .output
            .decoded_loop_boundary_reference_mae
            .is_finite()
        || response.output.decoded_loop_boundary_reference_mae < 0.0
        || !response
            .output
            .decoded_loop_boundary_continuity_ratio
            .is_finite()
        || response.output.decoded_loop_boundary_continuity_ratio < 0.0
        || (expects_loop_seam
            && response.output.decoded_loop_boundary_continuity_ratio
                > MAX_DECODED_LOOP_CONTINUITY_RATIO)
        || !response.output.decoded_alpha_loop_endpoint_mae.is_finite()
        || response.output.decoded_alpha_loop_endpoint_mae < 0.0
        || !response
            .output
            .decoded_alpha_loop_boundary_reference_mae
            .is_finite()
        || response.output.decoded_alpha_loop_boundary_reference_mae < 0.0
        || !response
            .output
            .decoded_alpha_loop_boundary_continuity_ratio
            .is_finite()
        || response.output.decoded_alpha_loop_boundary_continuity_ratio < 0.0
        || (expects_loop_seam
            && response.output.decoded_alpha_loop_boundary_continuity_ratio
                > MAX_DECODED_LOOP_CONTINUITY_RATIO)
        || !response.output.decoded_rgb_encoding_mae.is_finite()
        || response.output.decoded_rgb_encoding_mae < 0.0
        || response.output.decoded_rgb_encoding_maximum_error > 255
        || (expected_pixel_format == "yuv444p"
            && response.output.decoded_rgb_encoding_maximum_error > 2)
        || response.output.has_alpha != request.transparent_background
        || (request.transparent_background && response.output.alpha_minimum >= 255)
        || response.output.alpha_maximum != 255
        || (request.transparent_background && response.output.decoded_alpha_minimum >= 255)
        || response.output.decoded_alpha_maximum != 255
        || (!request.transparent_background
            && (response.output.alpha_minimum != 255
                || response.output.decoded_alpha_minimum != 255))
        || response.output.matte.is_some() != request.transparent_background
        || response.output.encoding_quality != request.encoding_quality
        || response.output.pixel_format != expected_pixel_format
        || response.output.color_range != expected_color_range
        || response.output.codec != "vp9"
        || response.output.container != "webm"
        || !matches!(
            response.conv3d_backend.as_str(),
            "aten-native-hip" | "cudnn" | "cpu-native" | "mps-native"
        )
        || response.conditioning_mode != expected_conditioning_mode
        || response.negative_prompt_applied != (architecture == "wan-2.2-ti2v")
        || !response.output.duration_seconds.is_finite()
        || (response.output.duration_seconds
            - f64::from(expected_frame_count) / f64::from(request.fps))
        .abs()
            > 1e-9
    {
        return Err(
            "local video generation returned inconsistent alpha, loop, model, or runtime evidence"
                .to_string(),
        );
    }
    let memory_evidence = response
        .performance
        .as_ref()
        .and_then(|performance| performance.get("gpuMemory"))
        .ok_or_else(|| "local video generation omitted GPU lifecycle evidence".to_string())?;
    let timing_seconds = response
        .performance
        .as_ref()
        .and_then(|performance| performance.get("timingSeconds"))
        .and_then(|timing| timing.get("total"))
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| "local video generation omitted runtime timing evidence".to_string())?;
    if !timing_seconds.is_finite() || timing_seconds <= 0.0 {
        return Err("local video generation returned invalid runtime timing evidence".to_string());
    }
    if memory_evidence
        .get("processIsolation")
        .and_then(serde_json::Value::as_str)
        != Some("one-generation-per-process")
    {
        return Err(
            "local video generation did not prove one-generation-per-process isolation".to_string(),
        );
    }
    if response.device == "cuda" {
        let peak = memory_evidence
            .get("peakAllocatedBytes")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "local video generation omitted peak GPU allocation".to_string())?;
        let released = memory_evidence
            .get("postReleaseAllocatedBytes")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| {
                "local video generation omitted post-release GPU allocation".to_string()
            })?;
        if peak == 0 || released >= peak || released > 1_024 * 1_024 * 1_024 {
            return Err(
                "local video generation did not release model allocations before returning"
                    .to_string(),
            );
        }
    }
    if architecture != "wan-2.2-ti2v" {
        if response.endpoint_restoration.is_some() || response.loop_endpoint_restoration.is_some() {
            return Err(
                "native video conditioning returned unexpected endpoint-restoration evidence"
                    .to_string(),
            );
        }
    } else if first_source.digest == last_source.digest {
        if response.endpoint_restoration.is_some()
            || (request.loop_mode == "seamless") != response.loop_endpoint_restoration.is_some()
        {
            return Err(
                "local WAN same-endpoint generation returned inconsistent loop restoration"
                    .to_string(),
            );
        }
    } else {
        if response.loop_endpoint_restoration.is_some() {
            return Err(
                "local WAN distinct-endpoint generation returned unexpected loop restoration"
                    .to_string(),
            );
        }
        let restoration = response.endpoint_restoration.as_ref().ok_or_else(|| {
            "local WAN distinct-endpoint generation omitted endpoint restoration evidence"
                .to_string()
        })?;
        if restoration.engine != "endpoint-reference-color-and-pixel-restore-v3"
            || restoration.start_frame != request.num_frames - 5
            || restoration.frame_count != 5
            || !restoration.exact_endpoint_frame
            || restoration.easing.as_deref() != Some("smoothstep")
            || restoration.low_percentile != 5
            || restoration.high_percentile != 95
            || restoration.channel_scales.len() != 3
            || restoration.channel_offsets.len() != 3
            || restoration
                .channel_scales
                .iter()
                .any(|value| !value.is_finite() || !(0.75..=2.5).contains(value))
            || restoration
                .channel_offsets
                .iter()
                .any(|value| !value.is_finite() || !(-160.0..=160.0).contains(value))
        {
            return Err(
                "local WAN endpoint restoration returned inconsistent evidence".to_string(),
            );
        }
    }
    match (
        request.animated_background.as_ref(),
        response.composite_output.as_ref(),
    ) {
        (None, None) => {}
        (Some(background), Some(composite)) => {
            if composite.index != 1
                || composite.file_name != "output-0001.webm"
                || composite.seed != response.output.seed
                || (composite.width, composite.height) != expected_dimensions
                || composite.frame_count != response.output.frame_count
                || composite.fps != request.fps
                || composite.has_alpha
                || composite.loop_mode != request.loop_mode
                || !composite.loop_endpoint_mae.is_finite()
                || composite.loop_endpoint_mae < 0.0
                || !composite.loop_boundary_reference_mae.is_finite()
                || composite.loop_boundary_reference_mae < 0.0
                || !composite.loop_boundary_continuity_ratio.is_finite()
                || composite.loop_boundary_continuity_ratio < 0.0
                || composite.decoded_frame_count != composite.frame_count
                || !composite.decoded_loop_endpoint_mae.is_finite()
                || composite.decoded_loop_endpoint_mae < 0.0
                || !composite.decoded_loop_boundary_reference_mae.is_finite()
                || composite.decoded_loop_boundary_reference_mae < 0.0
                || !composite.decoded_loop_boundary_continuity_ratio.is_finite()
                || composite.decoded_loop_boundary_continuity_ratio < 0.0
                || (expects_loop_seam
                    && composite.decoded_loop_boundary_continuity_ratio
                        > MAX_DECODED_LOOP_CONTINUITY_RATIO)
                || !composite.decoded_rgb_encoding_mae.is_finite()
                || composite.decoded_rgb_encoding_mae < 0.0
                || composite.decoded_rgb_encoding_maximum_error > 255
                || (expected_composite_pixel_format == "yuv444p"
                    && composite.decoded_rgb_encoding_maximum_error > 2)
                || composite.encoding_quality != request.encoding_quality
                || composite.pixel_format != expected_composite_pixel_format
                || composite.color_range != expected_composite_color_range
                || composite.codec != "vp9"
                || composite.container != "webm"
                || composite.background.engine
                    != if background.style == "enchanted-beach" {
                        "animated-enchanted-beach-v1"
                    } else {
                        "animated-gradient-v1"
                    }
                || composite.background.style != background.style
                || composite.background.direction != background.direction
                || composite.background.color_start != background.color_start
                || composite.background.color_end != background.color_end
                || composite.background.cycles != background.cycles
                || !composite.duration_seconds.is_finite()
                || (composite.duration_seconds
                    - f64::from(expected_frame_count) / f64::from(request.fps))
                .abs()
                    > 1e-9
            {
                return Err(
                    "local WAN animated composite returned inconsistent frame, loop, or background evidence"
                        .to_string(),
                );
            }
        }
        _ => {
            return Err(
                "local WAN animated composite output did not match the requested graph".to_string(),
            )
        }
    }
    let output_path = output_directory.join("output-0000.webm");
    let metadata = fs::symlink_metadata(&output_path)
        .map_err(|error| format!("failed to inspect generated WAN video: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_VIDEO_BYTES as u64
    {
        return Err("local WAN worker produced an unsafe video file".to_string());
    }
    let bytes = fs::read(&output_path)
        .map_err(|error| format!("failed to read generated WAN video: {error}"))?;
    if bytes.get(..4) != Some(&[0x1a, 0x45, 0xdf, 0xa3]) {
        return Err("local WAN worker produced an invalid WebM container".to_string());
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let relative_path = transform::cas_relative_path(&digest);
    transform::publish_cas_bytes(paths, &relative_path, &digest, &bytes)?;
    let (composite_digest, composite_relative_path, composite_byte_size) =
        if response.composite_output.is_some() {
            let composite_path = output_directory.join("output-0001.webm");
            let metadata = fs::symlink_metadata(&composite_path).map_err(|error| {
                format!("failed to inspect generated WAN composite video: {error}")
            })?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() == 0
                || metadata.len() > MAX_VIDEO_BYTES as u64
            {
                return Err("local WAN worker produced an unsafe composite video file".to_string());
            }
            let composite_bytes = fs::read(&composite_path)
                .map_err(|error| format!("failed to read WAN composite video: {error}"))?;
            if composite_bytes.get(..4) != Some(&[0x1a, 0x45, 0xdf, 0xa3]) {
                return Err(
                    "local WAN worker produced an invalid composite WebM container".to_string(),
                );
            }
            let composite_digest = format!("{:x}", Sha256::digest(&composite_bytes));
            let composite_relative_path = transform::cas_relative_path(&composite_digest);
            transform::publish_cas_bytes(
                paths,
                &composite_relative_path,
                &composite_digest,
                &composite_bytes,
            )?;
            (
                Some(composite_digest),
                Some(composite_relative_path.to_string_lossy().into_owned()),
                Some(composite_bytes.len() as u64),
            )
        } else {
            (None, None, None)
        };
    Ok(LocalGeneratedVideo {
        digest,
        relative_path: relative_path.to_string_lossy().into_owned(),
        byte_size: bytes.len() as u64,
        first_frame_digest: first_source.digest,
        last_frame_digest: last_source.digest,
        worker_version: response.worker_version,
        packages: response.packages,
        device: response.device,
        device_label: response.device_label,
        device_memory_bytes: response.device_memory_bytes,
        architecture: response.architecture,
        performance: response.performance,
        conv3d_backend: response.conv3d_backend,
        conditioning_mode: response.conditioning_mode,
        conditioning_framing: response.conditioning_framing,
        endpoint_restoration: response.endpoint_restoration,
        loop_endpoint_restoration: response.loop_endpoint_restoration,
        model_revision: response.model_revision,
        model_digest: response.model_digest,
        prompt: response.prompt,
        negative_prompt: response.negative_prompt,
        negative_prompt_applied: response.negative_prompt_applied,
        resolution: response.resolution,
        guidance_scale: response.guidance_scale,
        num_inference_steps: response.num_inference_steps,
        transparent_background: response.transparent_background,
        memory_profile: request.memory_profile.clone(),
        output: response.output,
        composite_digest,
        composite_relative_path,
        composite_byte_size,
        composite_output: response.composite_output,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_runtime() -> LocalDiffusersRuntimeStatus {
        LocalDiffusersRuntimeStatus {
            status: "ready".to_string(),
            ready: true,
            worker_version: Some("media-diffusers-worker/1.3.0".to_string()),
            python_version: Some("3.12.0".to_string()),
            packages: HashMap::from([("diffusers".to_string(), Some("0.39.0".to_string()))]),
            device: Some("cuda".to_string()),
            device_label: Some("Test GPU".to_string()),
            device_memory_bytes: Some(16 * 1_024 * 1_024 * 1_024),
            physical_memory_bytes: Some(32 * 1_024 * 1_024 * 1_024),
            architectures: vec!["stable-diffusion-xl".to_string()],
            capabilities: vec!["lora".to_string(), "textual-inversion".to_string()],
            diagnostic: "ready".to_string(),
        }
    }

    #[test]
    fn uses_the_standard_generation_deadline_for_image_backends() {
        assert_eq!(image_generation_timeout("krea-2", true), GENERATION_TIMEOUT);
        assert_eq!(
            image_generation_timeout("krea-2", false),
            GENERATION_TIMEOUT
        );
        assert_eq!(image_generation_timeout("flux-2", true), GENERATION_TIMEOUT);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn worker_timeout_terminates_descendant_processes() {
        let python_is_usable = Command::new("python")
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success());
        if !python_is_usable {
            return;
        }

        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-media-worker-tree-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        let marker = root.join("orphaned-child.txt");
        let script = root.join("worker.py");
        fs::write(
            &script,
            r#"import pathlib
import subprocess
import sys
import time

marker = sys.stdin.read()
subprocess.Popen([
    sys.executable,
    "-I",
    "-c",
    "import pathlib,sys,time; time.sleep(1.5); pathlib.Path(sys.argv[1]).write_text('orphaned', encoding='utf-8')",
    marker,
])
time.sleep(60)
"#,
        )
        .unwrap();

        let marker_text = marker.to_string_lossy().into_owned();
        let error = run_worker(
            Path::new("python"),
            &script,
            "test-timeout",
            Some(marker_text.as_bytes()),
            Duration::from_millis(500),
            None,
        )
        .unwrap_err();
        assert!(error.contains("execution deadline"), "{error}");

        thread::sleep(Duration::from_secs(2));
        let descendant_survived = marker.exists();
        let _ = fs::remove_dir_all(root);
        assert!(
            !descendant_survived,
            "the worker's descendant survived its process-tree timeout"
        );
    }

    #[test]
    fn rejects_parent_components_in_managed_paths() {
        let root = std::env::temp_dir().join("machdoch-local-diffusers-safe-path");
        fs::create_dir_all(&root).expect("temporary root should exist");
        assert!(safe_managed_path(&root, "../outside").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_the_canonical_content_addressed_addon_file() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-managed-addon-path-{}-{unique}",
            std::process::id()
        ));
        let addon_root = root.join("addons/sha256/fixture");
        fs::create_dir_all(&addon_root).expect("add-on directory should exist");
        let addon_file = addon_root.join("addon.safetensors");
        fs::write(&addon_file, b"fixture").expect("add-on fixture should be written");

        assert_eq!(
            resolve_managed_addon_file(&root, "addons/sha256/fixture").unwrap(),
            fs::canonicalize(&addon_file).unwrap()
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn distilled_flux_uses_fixed_sampling_steps_for_every_policy() {
        for policy in ["fast", "balanced", "quality"] {
            assert_eq!(expected_image_inference_steps("flux-2", policy).unwrap(), 4);
        }
        assert!(expected_image_inference_steps("flux-2", "invalid").is_err());
    }

    #[test]
    fn openpose_controlnet_must_match_the_model_family() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-openpose-controlnet-{}-{unique}",
            std::process::id()
        ));
        let paths = MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        };
        let sd2 = root.join("models/controlnet/openpose/sd2");
        fs::create_dir_all(&sd2).expect("controlnet directory should exist");
        fs::write(sd2.join("config.json"), b"{}").expect("config should be written");
        fs::write(sd2.join("diffusion_pytorch_model.safetensors"), b"weights")
            .expect("weights should be written");
        let expected_sd2 = fs::canonicalize(&sd2).expect("controlnet path should resolve");

        assert_eq!(
            openpose_controlnet_path(&paths, "stable-diffusion-2").unwrap(),
            Some(expected_sd2)
        );
        assert!(openpose_controlnet_path(&paths, "stable-diffusion-1")
            .unwrap()
            .is_none());
        assert!(openpose_controlnet_path(&paths, "stable-diffusion-xl")
            .unwrap()
            .is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn wan_download_identity_requires_the_pinned_revision_and_content_id() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock should be available")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-wan-download-identity-{}-{unique}",
            std::process::id()
        ));
        let relative = Path::new("transformer/config.json");
        let component = root.join(relative);
        let metadata = root.join(".cache/huggingface/download/transformer/config.json.metadata");
        fs::create_dir_all(component.parent().unwrap()).unwrap();
        fs::create_dir_all(metadata.parent().unwrap()).unwrap();
        fs::write(&component, b"{}").unwrap();
        fs::write(
            &metadata,
            format!("{WAN_MODEL_REVISION}\n{}\n0\n", "a".repeat(40)),
        )
        .unwrap();

        assert_eq!(
            wan_download_identity(&root, relative).unwrap(),
            "a".repeat(40)
        );
        fs::write(
            &metadata,
            format!("wrong-revision\n{}\n0\n", "b".repeat(64)),
        )
        .unwrap();
        assert!(wan_download_identity(&root, relative)
            .unwrap_err()
            .contains("expected"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn worker_request_uses_local_paths_and_ordered_named_addons() {
        let model_path = Path::new("C:/models/base");
        let addon_path = Path::new("C:/models/addon.safetensors");
        let reference_path = Path::new("C:/inputs/reference.png");
        let output_path = Path::new("C:/models/output");
        let target_components = vec!["denoiser".to_string()];
        let lora_profile = MediaLoraTensorProfile {
            algorithm: "lora".to_string(),
            dialect: "kohya".to_string(),
            rank_minimum: 8,
            rank_maximum: 8,
            heterogeneous_ranks: false,
            target_module_count: 1,
            convolution_target_count: 0,
            magnitude_vector_count: 0,
            network_alpha_count: 0,
        };
        let denoising_schedule = MediaLoraDenoisingSchedule {
            start: 0.1,
            end: 0.8,
        };
        let request = WorkerGenerationRequest {
            schema_version: WORKER_SCHEMA_VERSION,
            model: WorkerModel {
                id: "local:test",
                architecture: "stable-diffusion-xl",
                package_kind: "diffusers-directory",
                path: model_path,
                config_path: None,
                revision: "revision",
                digest: "digest",
            },
            prompt: "portrait",
            negative_prompt: "",
            output_count: 1,
            output_format: "png",
            model_policy: "balanced",
            aspect_ratio: "1:1",
            seed: 42,
            output_directory: output_path,
            addons: vec![WorkerAddon {
                kind: "lora",
                addon_id: "addon:one",
                enabled: true,
                path: addon_path,
                digest: "addon-digest",
                target_components: &target_components,
                embedding_vectors: &[],
                lora_profile: Some(&lora_profile),
                model_strength: Some(0.8),
                text_encoder_strength: None,
                denoising_schedule: Some(&denoising_schedule),
                token: None,
                placement: None,
            }],
            reference_images: vec![WorkerReferenceImage {
                path: reference_path,
                role: "subject",
                influence: 1.0,
            }],
            base_image_path: None,
            edit_mask: None,
            pose_image_path: None,
            pose_controlnet_path: None,
            pose_strength: None,
            pose_start: None,
            pose_end: None,
            edit_strength: Some(0.5),
            mask_strength: Some(0.75),
            require_chroma_background: true,
            memory_profile: Some("memory-saver"),
        };
        let value = serde_json::to_value(request).expect("request should encode");
        assert_eq!(value["model"]["path"], "C:/models/base");
        assert_eq!(value["addons"][0]["modelStrength"], 0.8);
        assert_eq!(value["addons"][0]["denoisingSchedule"]["end"], 0.8);
        assert_eq!(
            value["referenceImages"][0]["path"],
            "C:/inputs/reference.png"
        );
        assert_eq!(value["editStrength"], 0.5);
        assert_eq!(value["maskStrength"], 0.75);
        assert_eq!(value["requireChromaBackground"], true);
        assert_eq!(value["memoryProfile"], "memory-saver");
        assert_eq!(value["seed"], 42);
    }

    #[test]
    fn wan_worker_request_carries_quality_transparency_loop_and_memory_controls() {
        let request = WorkerVideoGenerationRequest {
            schema_version: WORKER_SCHEMA_VERSION,
            model: WorkerModel {
                id: "local:wan2.2-ti2v-5b",
                architecture: "wan-2.2-ti2v",
                package_kind: "diffusers-directory",
                path: Path::new("C:/models/wan"),
                config_path: None,
                revision: "revision",
                digest: "digest",
            },
            prompt: "deliberate character action",
            first_frame_path: Path::new("C:/inputs/first.png"),
            last_frame_path: Path::new("C:/inputs/last.png"),
            aspect_ratio: "21:9",
            resolution: "quality-768",
            num_frames: 33,
            num_inference_steps: 24,
            guidance_scale: 5.5,
            negative_prompt: "identity drift, texture crawl",
            transparent_background: false,
            loop_mode: "none",
            matte_quality: "production",
            encoding_quality: "lossless",
            memory_profile: "memory-saver",
            fps: 24,
            seed: 7,
            experimental_low_memory: true,
            animated_background: None,
            output_directory: Path::new("C:/outputs"),
        };
        let value = serde_json::to_value(request).expect("WAN request should encode");
        assert_eq!(value["aspectRatio"], "21:9");
        assert_eq!(value["resolution"], "quality-768");
        assert_eq!(value["numFrames"], 33);
        assert_eq!(value["numInferenceSteps"], 24);
        assert_eq!(value["guidanceScale"], 5.5);
        assert_eq!(value["negativePrompt"], "identity drift, texture crawl");
        assert_eq!(value["transparentBackground"], false);
        assert_eq!(value["loopMode"], "none");
        assert_eq!(value["matteQuality"], "production");
        assert_eq!(value["encodingQuality"], "lossless");
        assert_eq!(value["memoryProfile"], "memory-saver");
        assert_eq!(value["fps"], 24);
        assert_eq!(value["seed"], 7);
    }

    #[test]
    fn runtime_fingerprint_changes_with_execution_device() {
        let first = ready_runtime();
        let mut second = first.clone();
        second.device_label = Some("Other GPU".to_string());
        assert_ne!(runtime_fingerprint(&first), runtime_fingerprint(&second));
    }

    #[test]
    fn runtime_fingerprint_ignores_process_local_cuda_ordinal() {
        let mut discovered = ready_runtime();
        discovered.device_label = Some("AMD Radeon RX 9070 (cuda:1)".to_string());
        let mut isolated = discovered.clone();
        isolated.device_label = Some("AMD Radeon RX 9070 (cuda:0)".to_string());
        assert_eq!(
            runtime_fingerprint(&discovered),
            runtime_fingerprint(&isolated)
        );

        isolated.device_label = Some("AMD Radeon RX 9060 XT (cuda:0)".to_string());
        assert_ne!(
            runtime_fingerprint(&discovered),
            runtime_fingerprint(&isolated)
        );
    }

    #[test]
    fn generation_evidence_must_match_ordered_addons_and_prompt_channels() {
        let runtime = ready_runtime();
        let lora_digest = "a".repeat(64);
        let embedding_digest = "b".repeat(64);
        let addons = vec![
            ResolvedAddon {
                kind: "lora".to_string(),
                id: "addon:lora".to_string(),
                path: PathBuf::from("C:/models/lora.safetensors"),
                digest: lora_digest.clone(),
                target_components: vec!["denoiser".to_string()],
                embedding_vectors: Vec::new(),
                lora_profile: Some(MediaLoraTensorProfile {
                    algorithm: "lora".to_string(),
                    dialect: "kohya".to_string(),
                    rank_minimum: 8,
                    rank_maximum: 8,
                    heterogeneous_ranks: false,
                    target_module_count: 1,
                    convolution_target_count: 0,
                    magnitude_vector_count: 0,
                    network_alpha_count: 0,
                }),
                model_strength: Some(0.8),
                text_encoder_strength: None,
                denoising_schedule: Some(MediaLoraDenoisingSchedule {
                    start: 0.1,
                    end: 0.8,
                }),
                token: None,
                placement: None,
            },
            ResolvedAddon {
                kind: "textual-inversion".to_string(),
                id: "addon:embedding".to_string(),
                path: PathBuf::from("C:/models/embedding.safetensors"),
                digest: embedding_digest.clone(),
                target_components: vec!["text-encoder".to_string()],
                embedding_vectors: vec![MediaEmbeddingVectorProfile {
                    component: "text-encoder".to_string(),
                    tensor_key: "<concept>".to_string(),
                    vector_count: 3,
                    dimension: 768,
                }],
                lora_profile: None,
                model_strength: None,
                text_encoder_strength: None,
                denoising_schedule: None,
                token: Some("<concept>".to_string()),
                placement: Some("both".to_string()),
            },
        ];
        let mut response = WorkerGenerationResponse {
            schema_version: WORKER_SCHEMA_VERSION,
            worker_version: runtime.worker_version.clone().unwrap(),
            packages: runtime.packages.clone(),
            device: runtime.device.clone().unwrap(),
            device_label: runtime.device_label.clone().unwrap(),
            device_memory_bytes: runtime.device_memory_bytes,
            prompt: "portrait, <concept>".to_string(),
            negative_prompt: "<concept>".to_string(),
            model_policy: "balanced".to_string(),
            aspect_ratio: "1:1".to_string(),
            num_inference_steps: 24,
            addons: vec![
                serde_json::json!({
                    "kind": "lora",
                    "addonId": "addon:lora",
                    "digest": lora_digest,
                    "modelStrength": 0.8,
                    "textEncoderStrength": null,
                    "denoisingSchedule": {"start": 0.1, "end": 0.8},
                    "scheduleApplied": true,
                    "adapterName": "machdoch_aaaaaaaaaaaaaaaa",
                    "loadedComponents": ["denoiser"],
                    "loraProfile": {
                        "algorithm": "lora",
                        "dialect": "kohya",
                        "rankMinimum": 8,
                        "rankMaximum": 8,
                        "heterogeneousRanks": false,
                        "targetModuleCount": 1,
                        "convolutionTargetCount": 0,
                        "magnitudeVectorCount": 0,
                        "networkAlphaCount": 0
                    }
                }),
                serde_json::json!({
                    "kind": "textual-inversion",
                    "addonId": "addon:embedding",
                    "digest": embedding_digest,
                    "token": "<concept>",
                    "placement": "both",
                    "loadedComponents": ["text-encoder"],
                    "embeddingVectors": [{
                        "component": "text-encoder",
                        "tensorKey": "<concept>",
                        "vectorCount": 3,
                        "dimension": 768,
                        "registeredTokens": ["<concept>", "<concept>_1", "<concept>_2"]
                    }]
                }),
            ],
            performance: None,
            require_chroma_background: false,
            edit_conditioning: None,
            outputs: Vec::new(),
        };
        validate_generation_evidence(&response, &runtime, "portrait", "", &addons)
            .expect("matching evidence should pass");

        let lora_evidence = response.addons[0].clone();
        response.addons[0]["loraProfile"]["rankMaximum"] = serde_json::json!(16);
        assert!(
            validate_generation_evidence(&response, &runtime, "portrait", "", &addons).is_err()
        );
        response.addons[0] = lora_evidence;
        let lora_evidence = response.addons[0].clone();
        response.addons[0]["denoisingSchedule"]["end"] = serde_json::json!(0.9);
        assert!(
            validate_generation_evidence(&response, &runtime, "portrait", "", &addons).is_err()
        );
        response.addons[0] = lora_evidence;
        let embedding_evidence = response.addons[1].clone();
        response.addons[1]["embeddingVectors"][0]["registeredTokens"] =
            serde_json::json!(["<concept>"]);
        assert!(
            validate_generation_evidence(&response, &runtime, "portrait", "", &addons).is_err()
        );
        response.addons[1] = embedding_evidence;
        response.addons.swap(0, 1);
        assert!(
            validate_generation_evidence(&response, &runtime, "portrait", "", &addons).is_err()
        );
    }

    #[test]
    fn conditioning_evidence_requires_exact_flux_strengths_and_modes() {
        let runtime = ready_runtime();
        let reference_digest = "a".repeat(64);
        let base_digest = "b".repeat(64);
        let references = vec![MediaImageReference {
            asset_id: "asset:style".to_string(),
            role: "style".to_string(),
            influence: 1.0,
        }];
        let reference_digests = [reference_digest.as_str()];
        let reference_expectation = EditConditioningEvidenceExpectation {
            architecture: "flux-2",
            references: &references,
            reference_digests: &reference_digests,
            base_digest: Some(base_digest.as_str()),
            pose_digest: None,
            has_mask: false,
            edit_strength: None,
            mask_strength: None,
            requires_reference_binding: true,
            requires_visible_reference_change: true,
        };
        let inpaint_expectation = EditConditioningEvidenceExpectation {
            has_mask: true,
            edit_strength: Some(0.7),
            mask_strength: Some(0.45),
            ..reference_expectation
        };
        let mut response = WorkerGenerationResponse {
            schema_version: WORKER_SCHEMA_VERSION,
            worker_version: runtime.worker_version.clone().unwrap(),
            packages: runtime.packages.clone(),
            device: runtime.device.clone().unwrap(),
            device_label: runtime.device_label.clone().unwrap(),
            device_memory_bytes: runtime.device_memory_bytes,
            prompt: "replace the painted clothing".to_string(),
            negative_prompt: "".to_string(),
            model_policy: "balanced".to_string(),
            aspect_ratio: "1:1".to_string(),
            num_inference_steps: 4,
            addons: Vec::new(),
            performance: None,
            require_chroma_background: false,
            edit_conditioning: Some(serde_json::json!({
                "mode": "flux2-native-reference",
                "referenceSources": [
                    {"digest": reference_digest, "role": "style", "influence": 1.0}
                ],
                "baseDigest": base_digest,
                "poseDigest": null,
                "maskBounds": null,
                "globalEditStrength": null,
                "maskStrength": null,
                "referenceBinding": {
                    "mode": "indexed-role-prompt-v1",
                    "inputs": [
                        {"imageIndex": 1, "role": "base"},
                        {"imageIndex": 2, "role": "style"}
                    ],
                    "requiresVisibleChange": true
                },
                "changeMap": {
                    "outputs": [{
                        "scope": "image",
                        "activePixels": 100,
                        "changedPixels": 20,
                        "changedPixelRatio": 0.2,
                        "meanAbsoluteDifference": 4.0,
                        "pixelDeltaThreshold": 8.0,
                        "minimumChangedPixelRatio": 0.01,
                        "minimumMeanAbsoluteDifference": 3.0
                    }]
                }
            })),
            outputs: Vec::new(),
        };
        validate_edit_conditioning_evidence(&response, &reference_expectation)
            .expect("FLUX.2 evidence should confirm its native reference path");

        response.edit_conditioning.as_mut().unwrap()["mode"] =
            serde_json::json!("diffusers-image-to-image");
        assert!(validate_edit_conditioning_evidence(&response, &reference_expectation).is_err());

        response.edit_conditioning = Some(serde_json::json!({
            "mode": "flux2-klein-inpaint-v1",
            "referenceSources": [
                {"digest": reference_digest, "role": "style", "influence": 1.0}
            ],
            "baseDigest": base_digest,
            "poseDigest": null,
            "maskBounds": [10, 12, 42, 48],
            "globalEditStrength": 0.7,
            "maskStrength": 0.45,
            "referenceBinding": {
                "mode": "indexed-role-prompt-v1",
                "inputs": [
                    {"imageIndex": 1, "role": "base"},
                    {"imageIndex": 2, "role": "style"}
                ],
                "requiresVisibleChange": true
            },
            "changeMap": {
                "outputs": [{
                    "scope": "mask",
                    "activePixels": 100,
                    "changedPixels": 20,
                    "changedPixelRatio": 0.2,
                    "meanAbsoluteDifference": 4.0,
                    "pixelDeltaThreshold": 8.0,
                    "minimumChangedPixelRatio": 0.01,
                    "minimumMeanAbsoluteDifference": 3.0
                }]
            }
        }));
        validate_edit_conditioning_evidence(&response, &inpaint_expectation)
            .expect("FLUX.2 inpainting evidence should confirm both strength controls");

        response.edit_conditioning.as_mut().unwrap()["maskStrength"] = serde_json::json!(0.2);
        assert!(validate_edit_conditioning_evidence(&response, &inpaint_expectation).is_err());

        response.edit_conditioning.as_mut().unwrap()["maskStrength"] = serde_json::json!(0.45);
        response.edit_conditioning.as_mut().unwrap()["changeMap"]["outputs"][0]
            ["changedPixelRatio"] = serde_json::json!(0.0);
        assert!(validate_edit_conditioning_evidence(&response, &inpaint_expectation).is_err());

        response.edit_conditioning.as_mut().unwrap()["changeMap"]["outputs"][0]
            ["changedPixelRatio"] = serde_json::json!(0.2);
        response.edit_conditioning.as_mut().unwrap()["referenceBinding"]["inputs"][1]["role"] =
            serde_json::json!("detail");
        assert!(validate_edit_conditioning_evidence(&response, &inpaint_expectation).is_err());

        response.edit_conditioning.as_mut().unwrap()["referenceBinding"]["inputs"][1]["role"] =
            serde_json::json!("style");
        response.edit_conditioning.as_mut().unwrap()["sourceTokens"] = serde_json::json!({});
        assert!(validate_edit_conditioning_evidence(&response, &inpaint_expectation).is_err());
    }

    #[test]
    fn runnable_models_require_matching_probe_and_immutable_checkpoint_bytes() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-local-diffusers-readiness-{}-{unique}",
            std::process::id()
        ));
        let paths = MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs").join("sha256"),
        };
        database::initialize(&paths).expect("database should initialize");
        let model_id = "local:flux-2-klein-4b";
        let relative_path = "packages/readiness/revisions/test";
        let revision_root = paths.models_root().unwrap().join(relative_path);
        fs::create_dir_all(&revision_root).unwrap();
        let checkpoint = revision_root.join("checkpoint.safetensors");
        fs::write(&checkpoint, b"immutable checkpoint fixture").unwrap();
        let (_, digest) = model_import::hash_file(&checkpoint).unwrap();
        let connection = database::open(&paths).unwrap();
        connection
            .execute(
                "UPDATE media_models SET package_type = 'safetensors' WHERE id = ?1",
                [model_id],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO media_model_installations(
                   model_id, revision, status, manifest_digest, bytes_on_disk,
                   installed_at, verified_at, updated_at, relative_path
                 ) VALUES (?1, ?2, 'installed', ?2, 28, ?3, ?3, ?3, ?4)",
                params![model_id, digest, database::now(), relative_path],
            )
            .unwrap();
        let mut runtime = ready_runtime();
        runtime.architectures = vec!["flux-2".to_string()];
        assert!(runnable_model_ids(&paths, &runtime).unwrap().is_empty());

        let fingerprint = runtime_fingerprint(&runtime).unwrap();
        connection
            .execute(
                "INSERT INTO media_model_runtime_probes(
                   model_id, revision, model_digest, runtime_fingerprint, status,
                   worker_version, pipeline_class, device_label, diagnostic, probed_at
                 ) VALUES (?1, ?2, ?2, ?3, 'ready', ?4, 'Flux2Pipeline', ?5, 'ready', ?6)",
                params![
                    model_id,
                    digest,
                    fingerprint,
                    runtime.worker_version.as_deref().unwrap(),
                    runtime.device_label.as_deref().unwrap(),
                    database::now(),
                ],
            )
            .unwrap();
        assert_eq!(
            runnable_model_ids(&paths, &runtime).unwrap(),
            vec![model_id]
        );

        fs::write(&checkpoint, b"tampered checkpoint fixture!").unwrap();
        assert!(runnable_model_ids(&paths, &runtime).unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
