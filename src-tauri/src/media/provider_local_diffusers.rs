use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Write as _,
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use rusqlite::{params, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Manager as _};

use super::{
    database, model_addon, model_import,
    provider_openai::{self, GeneratedImageAsset},
    subject_cutout, transform, GenerateMediaImagesRequest, MediaEmbeddingVectorProfile,
    MediaLoraDenoisingSchedule, MediaLoraTensorProfile, MediaModelAddonSelection,
    MediaModelDescriptor, MediaResult, MediaRuntimePaths,
};

const WORKER_SCHEMA_VERSION: u32 = 4;
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const MODEL_PROBE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const GENERATION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_WORKER_RESPONSE_BYTES: usize = 2 * 1_024 * 1_024;
const MAX_WORKER_DIAGNOSTIC_BYTES: usize = 256 * 1_024;
const MAX_IMAGE_BYTES: usize = 64 * 1_024 * 1_024;

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
    #[serde(default)]
    addons: Vec<serde_json::Value>,
    outputs: Vec<WorkerOutputRecord>,
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
    pub(crate) addons: Vec<serde_json::Value>,
    pub(crate) outputs: Vec<LocalDiffusersOutputProvenance>,
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
    pub(crate) seed: u64,
}

#[derive(Debug)]
pub(crate) struct LocalGeneratedImageBatch {
    pub(crate) assets: Vec<GeneratedImageAsset>,
    pub(crate) provenance: LocalDiffusersProvenance,
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
    let mut process = Command::new(python)
        .arg("-I")
        .arg("-B")
        .arg(script)
        .arg(command)
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1")
        .env("HF_HUB_DISABLE_TELEMETRY", "1")
        .env("DO_NOT_TRACK", "1")
        .env_remove("HF_TOKEN")
        .env_remove("HUGGING_FACE_HUB_TOKEN")
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start local Diffusers worker: {error}"))?;
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
                    let _ = process.kill();
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
                let _ = process.kill();
                let _ = process.wait();
                return Err("local Diffusers worker exceeded its execution deadline".to_string());
            }
            Err(error) => {
                let _ = process.kill();
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

pub(crate) fn probe(app: &AppHandle) -> LocalDiffusersRuntimeStatus {
    let script = match worker_script(app) {
        Ok(script) => script,
        Err(error) => return LocalDiffusersRuntimeStatus::unavailable(error),
    };
    let mut diagnostics = Vec::new();
    for python in python_candidates(app) {
        match run_worker(&python, &script, "probe", None, PROBE_TIMEOUT, None) {
            Ok(output) => match serde_json::from_slice::<WorkerProbe>(&output.stdout) {
                Ok(probe) if probe.schema_version == WORKER_SCHEMA_VERSION => {
                    return LocalDiffusersRuntimeStatus {
                        status: if probe.ready { "ready" } else { "unavailable" }.to_string(),
                        ready: probe.ready,
                        worker_version: Some(probe.worker_version),
                        python_version: Some(probe.python_version),
                        packages: probe.packages,
                        device: probe.device,
                        device_label: probe.device_label,
                        device_memory_bytes: probe.device_memory_bytes,
                        architectures: probe.architectures,
                        capabilities: probe.capabilities,
                        diagnostic: probe.diagnostic,
                    };
                }
                Ok(_) => {
                    diagnostics.push("worker returned an unsupported probe schema".to_string())
                }
                Err(error) => {
                    diagnostics.push(format!("worker probe returned invalid JSON: {error}"))
                }
            },
            Err(error) => diagnostics.push(error),
        }
    }
    LocalDiffusersRuntimeStatus::unavailable(if diagnostics.is_empty() {
        "No supported Python runtime was found.".to_string()
    } else {
        diagnostics.join("; ")
    })
}

fn runtime_fingerprint(runtime: &LocalDiffusersRuntimeStatus) -> Option<String> {
    if !runtime.ready {
        return None;
    }
    let mut packages = runtime.packages.iter().collect::<Vec<_>>();
    packages.sort_by(|left, right| left.0.cmp(right.0));
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-local-diffusers-runtime-v1\0");
    let device_memory = runtime.device_memory_bytes.unwrap_or_default().to_string();
    for value in [
        runtime.worker_version.as_deref().unwrap_or(""),
        runtime.python_version.as_deref().unwrap_or(""),
        runtime.device.as_deref().unwrap_or(""),
        runtime.device_label.as_deref().unwrap_or(""),
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

fn ready_python(app: &AppHandle, script: &Path) -> MediaResult<PathBuf> {
    let mut diagnostics = Vec::new();
    for candidate in python_candidates(app) {
        match run_worker(&candidate, script, "probe", None, PROBE_TIMEOUT, None) {
            Ok(output) => match serde_json::from_slice::<WorkerProbe>(&output.stdout) {
                Ok(probe) if probe.ready && probe.schema_version == WORKER_SCHEMA_VERSION => {
                    return Ok(candidate);
                }
                Ok(probe) => diagnostics.push(probe.diagnostic),
                Err(error) => diagnostics.push(format!("invalid worker probe: {error}")),
            },
            Err(error) => diagnostics.push(error),
        }
    }
    Err(format!(
        "Local Diffusers runtime is unavailable: {}",
        if diagnostics.is_empty() {
            "no supported Python runtime was found".to_string()
        } else {
            diagnostics.join("; ")
        }
    ))
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
        let (byte_size, observed_digest) = model_import::hash_file(&path)?;
        if byte_size == 0 || observed_digest != row.4 {
            return Err(
                "the installed single-file model failed its content-addressed integrity check"
                    .to_string(),
            );
        }
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

fn record_model_probe(
    paths: &MediaRuntimePaths,
    model: &InstalledModel,
    runtime_fingerprint: &str,
    status: &str,
    worker_version: &str,
    pipeline_class: Option<&str>,
    device_label: Option<&str>,
    diagnostic: &str,
    checked_at: &str,
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
                runtime_fingerprint,
                status,
                worker_version,
                pipeline_class,
                device_label,
                diagnostic,
                checked_at,
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
        runtime_fingerprint,
        "failed",
        worker_version,
        pipeline_class,
        runtime.device_label.as_deref(),
        &diagnostic,
        checked_at,
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
    let runtime = probe(app);
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
    let script = worker_script(app)?;
    let python = ready_python(app, &script)?;
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
        Some(failure.error)
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
        &fingerprint,
        "ready",
        &response.worker_version,
        Some(&response.pipeline_class),
        Some(&response.device_label),
        &response.diagnostic,
        &checked_at,
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
                        lora_profile_json, digest, relative_path
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
        let mut embedding_vectors =
            serde_json::from_str::<Vec<MediaEmbeddingVectorProfile>>(&row.3)
                .map_err(|error| format!("failed to decode embedding vector profiles: {error}"))?;
        let mut lora_profile = row
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
        let addon_root = safe_managed_path(&models_root, &row.6)?;
        let path = safe_managed_path(&addon_root, "addon.safetensors")?;
        let (byte_size, observed_digest) = model_import::hash_file(&path)?;
        if byte_size == 0 || observed_digest != row.5 {
            return Err(format!(
                "model add-on {addon_id} failed its content-addressed integrity check"
            ));
        }
        if row.0 == "textual-inversion" && embedding_vectors.is_empty() {
            let inspection = model_addon::inspect(path.to_string_lossy().as_ref())?;
            if !inspection.can_import
                || inspection.detected_kind.as_deref() != Some("textual-inversion")
                || inspection
                    .detected_architecture
                    .as_deref()
                    .is_some_and(|architecture| architecture != row.1)
                || inspection.target_components != target_components
                || inspection.embedding_vectors.is_empty()
            {
                return Err(format!(
                    "model add-on {addon_id} cannot be upgraded to an exact embedding vector profile; re-import the original safetensors file"
                ));
            }
            embedding_vectors = inspection.embedding_vectors;
            let encoded = serde_json::to_string(&embedding_vectors)
                .map_err(|error| format!("failed to encode embedding vector profiles: {error}"))?;
            connection
                .execute(
                    "UPDATE media_model_addons SET embedding_vectors_json = ?2, updated_at = ?3
                     WHERE id = ?1 AND digest = ?4",
                    params![addon_id, encoded, database::now(), row.5],
                )
                .map_err(|error| format!("failed to upgrade embedding vector profiles: {error}"))?;
        }
        if row.0 == "lora" && lora_profile.is_none() {
            let inspection = model_addon::inspect(path.to_string_lossy().as_ref())?;
            if !inspection.can_import
                || inspection.detected_kind.as_deref() != Some("lora")
                || inspection
                    .detected_architecture
                    .as_deref()
                    .is_some_and(|architecture| architecture != row.1)
                || inspection.target_components != target_components
                || inspection.lora_profile.is_none()
            {
                return Err(format!(
                    "model add-on {addon_id} cannot be upgraded to an exact LoRA tensor profile; re-import the original safetensors file"
                ));
            }
            lora_profile = inspection.lora_profile;
            let encoded = serde_json::to_string(&lora_profile)
                .map_err(|error| format!("failed to encode LoRA tensor profile: {error}"))?;
            connection
                .execute(
                    "UPDATE media_model_addons SET lora_profile_json = ?2, updated_at = ?3
                     WHERE id = ?1 AND digest = ?4",
                    params![addon_id, encoded, database::now(), row.5],
                )
                .map_err(|error| format!("failed to upgrade LoRA tensor profile: {error}"))?;
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

pub(crate) fn runnable_model_ids(
    paths: &MediaRuntimePaths,
    runtime: &LocalDiffusersRuntimeStatus,
) -> MediaResult<Vec<String>> {
    if !runtime.ready {
        return Ok(Vec::new());
    }
    let fingerprint = runtime_fingerprint(runtime)
        .ok_or_else(|| "local Diffusers runtime fingerprint is unavailable".to_string())?;
    let connection = database::open(paths)?;
    let mut statement = connection
        .prepare(
            "SELECT m.id FROM media_models m
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
        .query_map([fingerprint], |row| row.get::<_, String>(0))
        .map_err(|error| format!("failed to query runnable local models: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to decode runnable local models: {error}"))?;
    Ok(candidates
        .into_iter()
        .filter(|model_id| {
            installed_model(paths, model_id)
                .is_ok_and(|model| runtime.architectures.contains(&model.architecture))
        })
        .collect())
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

fn deterministic_seed(request: &GenerateMediaImagesRequest) -> MediaResult<u64> {
    let addons = serde_json::to_vec(&request.model_addons)
        .map_err(|error| format!("failed to encode model add-on stack: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-local-diffusers-seed-v1\0");
    for value in [
        request.run_id.as_bytes(),
        request.flow_revision_id.as_bytes(),
        request.model_id.as_bytes(),
        request.prompt.as_bytes(),
        &addons,
    ] {
        hasher.update(value);
        hasher.update(b"\0");
    }
    let digest = hasher.finalize();
    Ok(u64::from_le_bytes(
        digest[..8]
            .try_into()
            .expect("SHA-256 prefix has eight bytes"),
    ) & ((1_u64 << 53) - 16))
}

fn decode_generation_response(output: &Output) -> MediaResult<WorkerGenerationResponse> {
    if !output.status.success() {
        if let Ok(failure) = serde_json::from_slice::<WorkerFailure>(&output.stdout) {
            return Err(failure.error);
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
    let mut expected_negative_prompt = String::new();
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

pub(crate) fn generate(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &GenerateMediaImagesRequest,
) -> MediaResult<LocalGeneratedImageBatch> {
    let script = worker_script(app)?;
    let runtime = probe(app);
    let python = ready_python(app, &script)?;
    let model = installed_model(paths, &request.model_id)?;
    ensure_model_is_probe_ready(paths, &model, &runtime)?;
    let addons = resolve_addons(paths, &model, &request.model_addons)?;
    let staging = create_staging_directory(paths)?;
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
        negative_prompt: "",
        output_count: request.output_count,
        output_format: &request.output_format,
        model_policy: &request.model_policy,
        aspect_ratio: &request.aspect_ratio,
        seed: deterministic_seed(request)?,
        output_directory: &staging.0,
        addons: worker_addons,
    };
    let encoded = serde_json::to_vec(&worker_request)
        .map_err(|error| format!("failed to encode local Diffusers request: {error}"))?;
    let output = run_worker(
        &python,
        &script,
        "generate",
        Some(&encoded),
        GENERATION_TIMEOUT,
        Some((paths, &request.run_id)),
    )?;
    let response = decode_generation_response(&output)?;
    validate_generation_evidence(&response, &runtime, &request.prompt, &addons)?;
    if response.outputs.len() != request.output_count as usize {
        return Err("local Diffusers worker returned an unexpected output count".to_string());
    }
    let mut assets = Vec::with_capacity(response.outputs.len());
    let mut output_provenance = Vec::with_capacity(response.outputs.len());
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
        let output_path = staging.0.join(&expected_name);
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
        let validated =
            provider_openai::validate_image(&bytes, &request.output_format, expected_index)?;
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let relative_path = transform::cas_relative_path(&digest);
        transform::publish_cas_bytes(paths, &relative_path, &digest, &bytes)?;
        assets.push(GeneratedImageAsset {
            digest,
            relative_path: relative_path.to_string_lossy().into_owned(),
            byte_size: bytes.len() as u64,
            mime_type: validated.mime_type,
            width: validated.width,
            height: validated.height,
            output_index: expected_index as u32,
            subject_cutout,
        });
        output_provenance.push(LocalDiffusersOutputProvenance {
            index: worker_output.index,
            seed: worker_output.seed,
        });
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
            addons: response.addons,
            outputs: output_provenance,
        },
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
            architectures: vec!["stable-diffusion-xl".to_string()],
            capabilities: vec!["lora".to_string(), "textual-inversion".to_string()],
            diagnostic: "ready".to_string(),
        }
    }

    #[test]
    fn rejects_parent_components_in_managed_paths() {
        let root = std::env::temp_dir().join("machdoch-local-diffusers-safe-path");
        fs::create_dir_all(&root).expect("temporary root should exist");
        assert!(safe_managed_path(&root, "../outside").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn worker_request_uses_local_paths_and_ordered_named_addons() {
        let model_path = Path::new("C:/models/base");
        let addon_path = Path::new("C:/models/addon.safetensors");
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
        };
        let value = serde_json::to_value(request).expect("request should encode");
        assert_eq!(value["model"]["path"], "C:/models/base");
        assert_eq!(value["addons"][0]["modelStrength"], 0.8);
        assert_eq!(value["addons"][0]["denoisingSchedule"]["end"], 0.8);
        assert_eq!(value["seed"], 42);
    }

    #[test]
    fn runtime_fingerprint_changes_with_execution_device() {
        let first = ready_runtime();
        let mut second = first.clone();
        second.device_label = Some("Other GPU".to_string());
        assert_ne!(runtime_fingerprint(&first), runtime_fingerprint(&second));
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
            outputs: Vec::new(),
        };
        validate_generation_evidence(&response, &runtime, "portrait", &addons)
            .expect("matching evidence should pass");

        let lora_evidence = response.addons[0].clone();
        response.addons[0]["loraProfile"]["rankMaximum"] = serde_json::json!(16);
        assert!(validate_generation_evidence(&response, &runtime, "portrait", &addons).is_err());
        response.addons[0] = lora_evidence;
        let lora_evidence = response.addons[0].clone();
        response.addons[0]["denoisingSchedule"]["end"] = serde_json::json!(0.9);
        assert!(validate_generation_evidence(&response, &runtime, "portrait", &addons).is_err());
        response.addons[0] = lora_evidence;
        let embedding_evidence = response.addons[1].clone();
        response.addons[1]["embeddingVectors"][0]["registeredTokens"] =
            serde_json::json!(["<concept>"]);
        assert!(validate_generation_evidence(&response, &runtime, "portrait", &addons).is_err());
        response.addons[1] = embedding_evidence;
        response.addons.swap(0, 1);
        assert!(validate_generation_evidence(&response, &runtime, "portrait", &addons).is_err());
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

        fs::write(&checkpoint, b"tampered checkpoint fixture").unwrap();
        assert!(runnable_model_ids(&paths, &runtime).unwrap().is_empty());
        let _ = fs::remove_dir_all(root);
    }
}
