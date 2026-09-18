use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

use super::super::{
    provider_local_diffusers::{self, LocalDiffusersRuntimeStatus},
    MediaResult,
};
use super::{download, process, Manifest, SetupPhase, SetupStatus, RUNTIME_USE};

const INSTALL_TIMEOUT: Duration = Duration::from_secs(90 * 60);
const DETECTION_TIMEOUT: Duration = Duration::from_secs(3 * 60);
const REQUIREMENTS: &str = include_str!("../../../python/media_diffusers_requirements.txt");

pub(crate) fn python_path(root: &Path) -> PathBuf {
    root.join("environment").join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    })
}

fn uv_command(uv: &Path, root: &Path) -> Command {
    let mut command = Command::new(uv);
    for (key, _) in std::env::vars_os() {
        let normalized = key.to_string_lossy().to_ascii_uppercase();
        if normalized.starts_with("UV_")
            || normalized.starts_with("PIP_")
            || normalized.starts_with("PYTHON")
            || normalized == "VIRTUAL_ENV"
            || normalized == "CONDA_PREFIX"
        {
            command.env_remove(key);
        }
    }
    command
        .current_dir(root)
        .args(["--no-config", "--no-progress", "--color", "never"])
        .env("UV_PYTHON_INSTALL_DIR", root.join("python"))
        .env("UV_CACHE_DIR", root.join("cache"))
        .env("UV_PYTHON_INSTALL_BIN", "0")
        .env("UV_PYTHON_INSTALL_REGISTRY", "0")
        .env("UV_HTTP_TIMEOUT", "120")
        .env("UV_CONCURRENT_DOWNLOADS", "3");
    command
}

fn install_packages(uv: &Path, root: &Path, index: &str, packages: &[String]) -> MediaResult<()> {
    process::run(
        uv_command(uv, root)
            .args(["pip", "install", "--python"])
            .arg(python_path(root))
            .args([
                "--only-binary",
                "torch,torchvision,numpy,pillow,safetensors,sentencepiece,opencv-python-headless",
                "--index",
                index,
                "--default-index",
                "https://pypi.org/simple",
            ])
            .args(packages),
        INSTALL_TIMEOUT,
    )?;
    Ok(())
}

fn detect_accelerator() -> MediaResult<&'static str> {
    if cfg!(target_os = "macos") {
        return Ok("metal");
    }
    #[cfg(windows)]
    let vendors = process::run(Command::new("powershell.exe").args([
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object -ExpandProperty PNPDeviceID",
    ]), Duration::from_secs(30))?;
    #[cfg(not(windows))]
    let vendors = {
        let mut vendors = String::new();
        for entry in fs::read_dir("/sys/class/drm")
            .map_err(|error| format!("Could not inspect graphics hardware: {error}"))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path().join("device/vendor");
            if path.is_file() {
                vendors.push_str(&fs::read_to_string(path).map_err(|error| error.to_string())?);
            }
        }
        vendors
    };
    Ok(select_accelerator(&vendors))
}

pub(super) fn select_accelerator(vendors: &str) -> &'static str {
    let vendors = vendors.to_ascii_lowercase();
    if vendors.contains("ven_10de") || vendors.contains("0x10de") {
        "nvidia"
    } else if vendors.contains("ven_1002") || vendors.contains("0x1002") {
        "amd"
    } else {
        "cpu"
    }
}

fn amd_device(root: &Path) -> MediaResult<String> {
    let output = process::run(Command::new(python_path(root)).args([
        "-I", "-B", "-c",
        "import torch; devices = [torch.cuda.get_device_properties(i) for i in range(torch.cuda.device_count())]; print(max(devices, key=lambda device: device.total_memory).gcnArchName.split(':')[0])",
    ]), DETECTION_TIMEOUT).map_err(|error| format!("Graphics detection failed: {error}"))?;
    let target = output.trim();
    if !target.starts_with("gfx")
        || !(6..=8).contains(&target.len())
        || !target[3..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(format!(
            "AMD graphics device could not be identified: {target}"
        ));
    }
    Ok(target.to_string())
}

pub(crate) fn validate_directory(path: &Path) -> MediaResult<()> {
    if path.exists()
        && fs::symlink_metadata(path)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
    {
        return Err("The Media Studio setup directory cannot be a symbolic link".to_string());
    }
    fs::create_dir_all(path).map_err(|error| format!("Could not create setup directory: {error}"))
}

pub(super) fn remove_managed_environment(root: &Path) -> MediaResult<()> {
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let environment = root.join("environment");
    validate_directory(&environment)?;
    let resolved = fs::canonicalize(&environment).map_err(|error| error.to_string())?;
    if resolved != environment || resolved.parent() != Some(root.as_path()) {
        return Err("The managed environment must remain inside the setup directory".to_string());
    }
    fs::remove_dir_all(&resolved)
        .map_err(|error| format!("Could not rebuild the managed environment: {error}"))
}

pub(crate) fn install(
    root: &Path,
    worker: &Path,
    report: impl Fn(SetupStatus),
) -> MediaResult<LocalDiffusersRuntimeStatus> {
    validate_directory(root)?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("setup.lock"))
        .map_err(|error| error.to_string())?;
    lock.try_lock()
        .map_err(|error| format!("Another Media Studio setup is running: {error}"))?;
    report(SetupStatus::running(SetupPhase::Checking));
    let existing = provider_local_diffusers::verify_python_runtime(&python_path(&root), worker);
    if existing.ready {
        return Ok(existing);
    }
    let manifest: Manifest =
        serde_json::from_str(include_str!("../../../python/media_runtime_manifest.json"))
            .map_err(|error| error.to_string())?;
    let platform = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
    let archive = manifest
        .installers
        .get(&platform)
        .ok_or_else(|| format!("Media Studio setup is not supported on {platform}"))?;
    for directory in ["tools", "python", "environment", "cache"] {
        validate_directory(&root.join(directory))?;
    }
    let accelerator = detect_accelerator()?;
    let bundle = manifest
        .accelerators
        .get(accelerator)
        .ok_or("The graphics bundle is missing")?;
    report(SetupStatus::running(SetupPhase::Downloading));
    let uv = download::install(&root.join("tools"), &manifest.uv_version, archive, &report)?;
    report(SetupStatus::running(SetupPhase::Python));
    let guard = RUNTIME_USE
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    super::super::model_memory::release_idle()?;
    process::run(
        uv_command(&uv, &root).args([
            "python",
            "install",
            &manifest.python_version,
            "--reinstall",
            "--no-bin",
            "--no-registry",
        ]),
        INSTALL_TIMEOUT,
    )?;
    remove_managed_environment(&root)?;
    process::run(
        uv_command(&uv, &root)
            .args([
                "venv",
                "--managed-python",
                "--no-python-downloads",
                "--python",
                &manifest.python_version,
            ])
            .arg(root.join("environment")),
        DETECTION_TIMEOUT,
    )?;
    report(SetupStatus::running(SetupPhase::Dependencies));
    install_packages(
        &uv,
        &root,
        &bundle.index,
        &[
            format!("torch=={}", bundle.torch),
            format!("torchvision=={}", bundle.torchvision),
        ],
    )?;
    if accelerator == "amd" {
        let device = amd_device(&root)?;
        install_packages(
            &uv,
            &root,
            &bundle.index,
            &[
                format!("torch[device-{device}]=={}", bundle.torch),
                format!("torchvision[device-{device}]=={}", bundle.torchvision),
            ],
        )?;
    }
    let requirements = root.join("requirements.txt");
    fs::write(
        &requirements,
        format!(
            "{REQUIREMENTS}\ntorch=={}\ntorchvision=={}\n",
            bundle.torch, bundle.torchvision
        ),
    )
    .map_err(|error| error.to_string())?;
    process::run(
        uv_command(&uv, &root)
            .args(["pip", "install", "--python"])
            .arg(python_path(&root))
            .args([
                "--only-binary",
                ":all:",
                "--default-index",
                "https://pypi.org/simple",
                "--requirements",
            ])
            .arg(requirements),
        INSTALL_TIMEOUT,
    )?;
    report(SetupStatus::running(SetupPhase::Verifying));
    process::run(
        uv_command(&uv, &root)
            .args(["pip", "check", "--python"])
            .arg(python_path(&root)),
        DETECTION_TIMEOUT,
    )?;
    drop(guard);
    let runtime = provider_local_diffusers::verify_python_runtime(&python_path(&root), worker);
    if !runtime.ready {
        return Err(runtime.diagnostic);
    }
    if matches!(accelerator, "amd" | "nvidia") && runtime.device.as_deref() != Some("cuda") {
        return Err("The graphics driver could not start GPU execution".to_string());
    }
    Ok(runtime)
}
