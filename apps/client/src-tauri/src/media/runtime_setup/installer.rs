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
    environment_python_path(&root.join("environment"))
}

fn environment_python_path(environment: &Path) -> PathBuf {
    environment.join(if cfg!(windows) {
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

fn managed_python_is_valid(
    uv: &Path,
    root: &Path,
    version: &str,
    run: &mut impl FnMut(&mut Command, Duration) -> MediaResult<String>,
) -> bool {
    let Ok(found) = run(
        uv_command(uv, root).args([
            "python",
            "find",
            "--managed-python",
            "--no-python-downloads",
            version,
        ]),
        DETECTION_TIMEOUT,
    ) else {
        return false;
    };
    let Ok(managed_root) = fs::canonicalize(root.join("python")) else {
        return false;
    };
    let Ok(python) = fs::canonicalize(found.trim()) else {
        return false;
    };
    if !python.starts_with(&managed_root) || !python.is_file() {
        return false;
    }
    let actual = run(
        Command::new(python).args([
            "-I",
            "-B",
            "-c",
            "import sys; print('.'.join(map(str, sys.version_info[:3])))",
        ]),
        DETECTION_TIMEOUT,
    );
    matches!(actual, Ok(actual) if actual.trim() == version)
}

pub(super) fn ensure_managed_python(
    uv: &Path,
    root: &Path,
    version: &str,
    mut run: impl FnMut(&mut Command, Duration) -> MediaResult<String>,
) -> MediaResult<()> {
    if managed_python_is_valid(uv, root, version, &mut run) {
        return Ok(());
    }
    run(
        uv_command(uv, root).args([
            "python",
            "install",
            version,
            "--reinstall",
            "--no-bin",
            "--no-registry",
        ]),
        INSTALL_TIMEOUT,
    )?;
    Ok(())
}

fn install_packages(
    uv: &Path,
    root: &Path,
    environment: &Path,
    index: &str,
    packages: &[String],
) -> MediaResult<()> {
    process::run(
        uv_command(uv, root)
            .args(["pip", "install", "--python"])
            .arg(environment_python_path(environment))
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

fn amd_device(environment: &Path) -> MediaResult<String> {
    let output = process::run(Command::new(environment_python_path(environment)).args([
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

pub(super) fn remove_environment_directory(path: &Path) -> MediaResult<()> {
    if !environment_directory_exists(path)? {
        return Ok(());
    }
    fs::remove_dir_all(path)
        .map_err(|error| format!("Could not remove managed environment: {error}"))
}

fn environment_directory_exists(path: &Path) -> MediaResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(format!(
            "Managed environment path is not a directory: {}",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn restore_interrupted_environment(
    root: &Path,
    mut verify: impl FnMut(&Path) -> MediaResult<()>,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    mut remove: impl FnMut(&Path) -> MediaResult<()>,
) -> MediaResult<()> {
    let environment = root.join("environment");
    let backup = root.join("environment.backup");
    if !environment_directory_exists(&backup)? {
        return Ok(());
    }
    if !environment_directory_exists(&environment)? {
        let _guard = RUNTIME_USE
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        rename(&backup, &environment)
            .map_err(|error| format!("Could not restore the previous environment: {error}"))?;
    } else if verify(&environment).is_ok() {
        remove(&backup)?;
    } else {
        let _guard = RUNTIME_USE
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        remove(&environment)?;
        rename(&backup, &environment)
            .map_err(|error| format!("Could not restore the previous environment: {error}"))?;
    }
    Ok(())
}

fn verify_environment(
    environment: &Path,
    worker: &Path,
    accelerator: &str,
) -> MediaResult<LocalDiffusersRuntimeStatus> {
    let runtime = provider_local_diffusers::verify_python_runtime(
        &environment_python_path(environment),
        worker,
    );
    if !runtime.ready {
        return Err(runtime.diagnostic);
    }
    if matches!(accelerator, "amd" | "nvidia") && runtime.device.as_deref() != Some("cuda") {
        return Err("The graphics driver could not start GPU execution".to_string());
    }
    Ok(runtime)
}

pub(super) fn replace_environment<T>(
    root: &Path,
    prepare: impl FnOnce(&Path) -> MediaResult<()>,
    mut verify: impl FnMut(&Path) -> MediaResult<T>,
    mut rename: impl FnMut(&Path, &Path) -> std::io::Result<()>,
    mut remove: impl FnMut(&Path) -> MediaResult<()>,
) -> MediaResult<T> {
    let environment = root.join("environment");
    let staging = root.join("environment.staging");
    let backup = root.join("environment.backup");
    restore_interrupted_environment(
        root,
        |environment| verify(environment).map(|_| ()),
        &mut rename,
        &mut remove,
    )?;
    let had_environment = environment_directory_exists(&environment)?;
    remove(&staging)?;
    let prepared = prepare(&staging).and_then(|_| verify(&staging));
    if let Err(error) = prepared {
        if let Err(cleanup) = remove(&staging) {
            return Err(format!("{error}; staging cleanup failed: {cleanup}"));
        }
        return Err(error);
    }
    let promoted = (|| {
        let _guard = RUNTIME_USE
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if had_environment {
            rename(&environment, &backup)
                .map_err(|error| format!("Could not preserve the previous environment: {error}"))?;
        }
        rename(&staging, &environment)
            .map_err(|error| format!("Could not promote the environment: {error}"))
    })();
    match promoted.and_then(|_| verify(&environment)) {
        Ok(runtime) => {
            if had_environment {
                if let Err(error) = remove(&backup) {
                    eprintln!("Could not remove previous Media Studio environment: {error}");
                }
            }
            Ok(runtime)
        }
        Err(error) => {
            let _guard = RUNTIME_USE
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let recovery = (|| {
                let has_backup = environment_directory_exists(&backup)?;
                if has_backup || !had_environment {
                    if environment_directory_exists(&environment)? {
                        rename(&environment, &staging).map_err(|error| {
                            format!("Could not move the failed environment aside: {error}")
                        })?;
                    }
                    if has_backup {
                        rename(&backup, &environment).map_err(|error| {
                            format!("Could not restore the previous environment: {error}")
                        })?;
                    }
                }
                remove(&staging)
            })();
            if let Err(recovery) = recovery {
                return Err(format!("{error}; recovery failed: {recovery}"));
            }
            Err(error)
        }
    }
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
    if environment_directory_exists(&root.join("environment.backup"))? {
        let accelerator = detect_accelerator()?;
        restore_interrupted_environment(
            &root,
            |environment| verify_environment(environment, worker, accelerator).map(|_| ()),
            |from, to| fs::rename(from, to),
            remove_environment_directory,
        )?;
    }
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
    for directory in ["tools", "python", "cache"] {
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
    ensure_managed_python(&uv, &root, &manifest.python_version, process::run)?;
    drop(guard);
    let runtime = replace_environment(
        &root,
        |environment| {
            process::run(
                uv_command(&uv, &root)
                    .args([
                        "venv",
                        "--relocatable",
                        "--managed-python",
                        "--no-python-downloads",
                        "--python",
                        &manifest.python_version,
                    ])
                    .arg(environment),
                DETECTION_TIMEOUT,
            )?;
            report(SetupStatus::running(SetupPhase::Dependencies));
            install_packages(
                &uv,
                &root,
                environment,
                &bundle.index,
                &[
                    format!("torch=={}", bundle.torch),
                    format!("torchvision=={}", bundle.torchvision),
                ],
            )?;
            if accelerator == "amd" {
                let device = amd_device(environment)?;
                install_packages(
                    &uv,
                    &root,
                    environment,
                    &bundle.index,
                    &[
                        format!("torch[device-{device}]=={}", bundle.torch),
                        format!("torchvision[device-{device}]=={}", bundle.torchvision),
                    ],
                )?;
            }
            let requirements = environment.join("requirements.txt");
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
                    .arg(environment_python_path(environment))
                    .args([
                        "--no-binary",
                        "diffusers",
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
                    .arg(environment_python_path(environment)),
                DETECTION_TIMEOUT,
            )?;
            Ok(())
        },
        |environment| verify_environment(environment, worker, accelerator),
        |from, to| fs::rename(from, to),
        remove_environment_directory,
    )?;
    Ok(runtime)
}
