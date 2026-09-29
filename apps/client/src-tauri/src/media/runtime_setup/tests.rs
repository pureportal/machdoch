use std::{
    fs,
    io::{self, Write},
    path::Path,
    process::Command,
    sync::{mpsc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::*;
use crate::atomic_file::{durability_faults, write_file_atomic};

#[test]
fn selects_graphics_bundle_from_hardware() {
    assert_eq!(
        installer::select_accelerator("PCI\\VEN_1002&DEV_7550"),
        "amd"
    );
    assert_eq!(installer::select_accelerator("0x1002\n0x10de"), "nvidia");
    assert_eq!(installer::select_accelerator("PCI\\VEN_8086"), "cpu");
}

#[test]
fn failures_have_recovery_copy_separate_from_diagnostics() {
    for (diagnostic, recovery) in [
        ("Network download failed", "Check your connection"),
        ("Setup process timed out", "Setup took too long"),
        ("No space left on device", "Free up disk space"),
        ("CUDA graphics driver is unavailable", "Update its driver"),
        ("Access is denied", "Check access"),
        ("Unexpected pip exit status 1", "Retry setup"),
    ] {
        let status = SetupStatus::failed(diagnostic.to_string());
        assert!(!status.active());
        assert!(status.message.contains(recovery), "{}", status.message);
        assert_eq!(status.diagnostic.as_deref(), Some(diagnostic));
        assert!(!status.message.contains(diagnostic));
    }
}

#[test]
fn setup_lock_prevents_concurrent_modification() {
    let root = test_root("lock");
    fs::create_dir_all(&root).unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("setup.lock"))
        .unwrap();
    lock.try_lock().unwrap();
    let result = installer::install(&root, Path::new("missing-worker.py"), |_| {});
    assert!(result.unwrap_err().contains("Another Media Studio setup"));
}

#[test]
fn manifest_bundles_match_the_worker_requirements() {
    let manifest: Manifest =
        serde_json::from_str(include_str!("../../../python/media_runtime_manifest.json")).unwrap();
    assert_eq!(manifest.accelerators.len(), 4);
    for archive in manifest.installers.values() {
        assert_eq!(archive.sha256.len(), 64);
        assert!(!Path::new(&archive.executable).is_absolute());
    }
    for bundle in manifest.accelerators.values() {
        assert!(bundle.index.starts_with("https://"));
        assert_eq!(
            bundle.torch.split('+').nth(1),
            bundle.torchvision.split('+').nth(1)
        );
    }
}

fn test_installer_archive(executable: &[u8]) -> (InstallerArchive, Vec<u8>) {
    let archive = InstallerArchive {
        archive: "uv-test.zip".to_string(),
        sha256: String::new(),
        executable: "uv".to_string(),
    };
    let mut zip = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
    zip.start_file("uv", zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(executable).unwrap();
    (archive, zip.finish().unwrap().into_inner())
}

#[test]
fn download_publication_replaces_complete_files() {
    let root = test_root("download-replacement");
    fs::create_dir_all(&root).unwrap();
    let (archive, bytes) = test_installer_archive(b"new executable contents");
    let archive_path = root.join(&archive.archive);
    let executable_path = root.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    fs::write(&archive_path, b"old archive").unwrap();
    fs::write(&executable_path, b"old executable").unwrap();

    download::publish_download(
        Some(&archive_path),
        &executable_path,
        &archive,
        &bytes,
        write_file_atomic,
    )
    .unwrap();

    assert_eq!(fs::read(&archive_path).unwrap(), bytes);
    assert_eq!(
        fs::read(&executable_path).unwrap(),
        b"new executable contents"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&executable_path).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn download_preparation_failures_preserve_existing_files() {
    for fail_archive in [true, false] {
        let root = test_root("download-preparation-failure");
        fs::create_dir_all(&root).unwrap();
        let (archive, bytes) = test_installer_archive(b"new executable contents");
        let archive_path = root.join(&archive.archive);
        let executable_path = root.join(if cfg!(windows) { "uv.exe" } else { "uv" });
        fs::write(&archive_path, b"old archive").unwrap();
        fs::write(&executable_path, b"old executable").unwrap();
        let failed_path = if fail_archive {
            &archive_path
        } else {
            &executable_path
        };
        let failed_prefix = format!(".{}.", failed_path.file_name().unwrap().to_string_lossy());

        let error = download::publish_download(
            Some(&archive_path),
            &executable_path,
            &archive,
            &bytes,
            |path, contents, options| {
                if path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(&failed_prefix)
                {
                    return Err(io::Error::other("injected preparation failure"));
                }
                write_file_atomic(path, contents, options)
            },
        )
        .unwrap_err();

        assert!(error.contains("injected preparation failure"));
        assert_eq!(fs::read(&executable_path).unwrap(), b"old executable");
        assert_eq!(fs::read(&archive_path).unwrap(), b"old archive");
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn download_publication_failure_after_executable_rename_restores_both_files() {
    let root = test_root("download-rename-failure");
    fs::create_dir_all(&root).unwrap();
    let (archive, bytes) = test_installer_archive(b"new executable contents");
    let archive_path = root.join(&archive.archive);
    let executable_path = root.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    fs::write(&archive_path, b"old archive").unwrap();
    fs::write(&executable_path, b"old executable").unwrap();

    let failure = durability_faults::Failure::at(&executable_path);
    let error = download::publish_download(
        Some(&archive_path),
        &executable_path,
        &archive,
        &bytes,
        write_file_atomic,
    )
    .unwrap_err();
    drop(failure);

    assert!(error.contains("injected directory sync failure"));
    assert_eq!(fs::read(&archive_path).unwrap(), b"old archive");
    assert_eq!(fs::read(&executable_path).unwrap(), b"old executable");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_download_is_not_published() {
    let root = test_root("invalid-download");
    fs::create_dir_all(&root).unwrap();
    let (archive, _) = test_installer_archive(b"new executable contents");
    let archive_path = root.join(&archive.archive);
    let executable_path = root.join(if cfg!(windows) { "uv.exe" } else { "uv" });
    fs::write(&archive_path, b"old archive").unwrap();
    fs::write(&executable_path, b"old executable").unwrap();

    assert!(download::publish_download(
        Some(&archive_path),
        &executable_path,
        &archive,
        b"not a zip archive",
        write_file_atomic,
    )
    .is_err());

    assert_eq!(fs::read(&archive_path).unwrap(), b"old archive");
    assert_eq!(fs::read(&executable_path).unwrap(), b"old executable");
    fs::remove_dir_all(root).unwrap();
}

fn test_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "machdoch media setup {name} {}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn replacement_root(name: &str) -> PathBuf {
    let root = test_root(name);
    fs::create_dir_all(root.join("environment")).unwrap();
    fs::write(root.join("environment/marker"), "previous").unwrap();
    root
}

#[test]
fn preparation_and_staged_verification_failures_preserve_the_previous_environment() {
    for fail_during_preparation in [true, false] {
        let root = replacement_root("staging-failure");
        let mut verified = 0;
        let result = installer::replace_environment(
            &root,
            |staging| {
                fs::create_dir(staging).unwrap();
                fs::write(staging.join("marker"), "replacement").unwrap();
                if fail_during_preparation {
                    Err("package install failed".to_string())
                } else {
                    Ok(())
                }
            },
            |_| {
                verified += 1;
                Err::<(), _>("staged verification failed".to_string())
            },
            |from, to| fs::rename(from, to),
            installer::remove_environment_directory,
        );
        assert!(result.is_err());
        assert_eq!(verified, usize::from(!fail_during_preparation));
        assert_eq!(
            fs::read_to_string(root.join("environment/marker")).unwrap(),
            "previous"
        );
        assert!(!root.join("environment.staging").exists());
        assert!(!root.join("environment.backup").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn promotion_failure_restores_the_previous_environment() {
    let root = replacement_root("promotion-failure");
    let mut moves = 0;
    let result = installer::replace_environment(
        &root,
        |staging| {
            fs::create_dir(staging).unwrap();
            fs::write(staging.join("marker"), "replacement").unwrap();
            Ok(())
        },
        |_| Ok(()),
        |from, to| {
            moves += 1;
            if moves == 2 {
                Err(std::io::Error::other("injected promotion failure"))
            } else {
                fs::rename(from, to)
            }
        },
        installer::remove_environment_directory,
    );
    assert!(result.unwrap_err().contains("injected promotion failure"));
    assert_eq!(moves, 3);
    assert_eq!(
        fs::read_to_string(root.join("environment/marker")).unwrap(),
        "previous"
    );
    assert!(!root.join("environment.staging").exists());
    assert!(!root.join("environment.backup").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_promotion_restores_backup_before_repair() {
    let root = replacement_root("interrupted-promotion");
    fs::rename(root.join("environment"), root.join("environment.backup")).unwrap();
    fs::create_dir(root.join("environment.staging")).unwrap();
    fs::write(root.join("environment.staging/marker"), "abandoned").unwrap();

    let result = installer::replace_environment(
        &root,
        |staging| {
            assert_eq!(
                fs::read_to_string(root.join("environment/marker")).unwrap(),
                "previous"
            );
            assert!(!staging.exists());
            Err::<(), _>("injected preparation failure".to_string())
        },
        |_| Ok(()),
        |from, to| fs::rename(from, to),
        installer::remove_environment_directory,
    );
    assert!(result.unwrap_err().contains("injected preparation failure"));
    assert_eq!(
        fs::read_to_string(root.join("environment/marker")).unwrap(),
        "previous"
    );
    assert!(!root.join("environment.backup").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_promotion_is_restored_before_runtime_probe() {
    let root = replacement_root("interrupted-probe");
    fs::rename(root.join("environment"), root.join("environment.backup")).unwrap();
    installer::restore_interrupted_environment(
        &root,
        |_| Ok(()),
        |from, to| fs::rename(from, to),
        installer::remove_environment_directory,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(root.join("environment/marker")).unwrap(),
        "previous"
    );
    assert!(!root.join("environment.backup").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn interrupted_promoted_environment_is_restored_before_failed_repair() {
    let root = replacement_root("interrupted-promoted-verification");
    fs::rename(root.join("environment"), root.join("environment.backup")).unwrap();
    fs::create_dir(root.join("environment")).unwrap();
    fs::write(root.join("environment/marker"), "unverified replacement").unwrap();
    let mut verified = Vec::new();

    let result = installer::replace_environment(
        &root,
        |staging| {
            assert_eq!(
                fs::read_to_string(root.join("environment/marker")).unwrap(),
                "previous"
            );
            assert!(!root.join("environment.backup").exists());
            assert!(!staging.exists());
            Err::<(), _>("injected preparation failure".to_string())
        },
        |environment| {
            verified.push(fs::read_to_string(environment.join("marker")).unwrap());
            Err::<(), _>("promoted runtime failed GPU verification".to_string())
        },
        |from, to| fs::rename(from, to),
        installer::remove_environment_directory,
    );

    assert!(result.unwrap_err().contains("injected preparation failure"));
    assert_eq!(verified, ["unverified replacement"]);
    assert_eq!(
        fs::read_to_string(root.join("environment/marker")).unwrap(),
        "previous"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn failed_backup_cleanup_does_not_block_a_later_repair() {
    let root = replacement_root("backup-cleanup-failure");
    let mut fail_backup_cleanup = true;
    let first = installer::replace_environment(
        &root,
        |staging| {
            fs::create_dir(staging).unwrap();
            fs::write(staging.join("marker"), "first replacement").unwrap();
            Ok(())
        },
        |_| Ok("verified"),
        |from, to| fs::rename(from, to),
        |path| {
            if path.ends_with("environment.backup") && fail_backup_cleanup {
                fail_backup_cleanup = false;
                return Err("injected backup cleanup failure".to_string());
            }
            installer::remove_environment_directory(path)
        },
    );
    assert_eq!(first.unwrap(), "verified");
    assert_eq!(
        fs::read_to_string(root.join("environment/marker")).unwrap(),
        "first replacement"
    );
    assert!(root.join("environment.backup").exists());

    let second = installer::replace_environment(
        &root,
        |staging| {
            assert!(!root.join("environment.backup").exists());
            fs::create_dir(staging).unwrap();
            fs::write(staging.join("marker"), "second replacement").unwrap();
            Ok(())
        },
        |_| Ok("verified again"),
        |from, to| fs::rename(from, to),
        installer::remove_environment_directory,
    );
    assert_eq!(second.unwrap(), "verified again");
    assert_eq!(
        fs::read_to_string(root.join("environment/marker")).unwrap(),
        "second replacement"
    );
    assert!(!root.join("environment.backup").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn promoted_environment_is_verified_and_rolled_back_when_invalid() {
    for promoted_is_valid in [true, false] {
        let root = replacement_root("promoted-verification");
        fs::write(root.join("model.safetensors"), "keep").unwrap();
        let mut verified = Vec::new();
        let result = installer::replace_environment(
            &root,
            |staging| {
                fs::create_dir(staging).unwrap();
                fs::write(staging.join("marker"), "replacement").unwrap();
                Ok(())
            },
            |environment| {
                verified.push(
                    environment
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                );
                if verified.len() == 2 && !promoted_is_valid {
                    Err("promoted runtime failed GPU verification".to_string())
                } else {
                    Ok("verified")
                }
            },
            |from, to| fs::rename(from, to),
            installer::remove_environment_directory,
        );
        assert_eq!(verified, ["environment.staging", "environment"]);
        assert_eq!(result.is_ok(), promoted_is_valid);
        assert_eq!(
            fs::read_to_string(root.join("environment/marker")).unwrap(),
            if promoted_is_valid {
                "replacement"
            } else {
                "previous"
            }
        );
        assert_eq!(
            fs::read_to_string(root.join("model.safetensors")).unwrap(),
            "keep"
        );
        assert!(!root.join("environment.staging").exists());
        assert!(!root.join("environment.backup").exists());
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn fresh_environment_is_verified_after_promotion() {
    let root = test_root("fresh-promotion");
    fs::create_dir(&root).unwrap();
    let mut verified = Vec::new();
    let result = installer::replace_environment(
        &root,
        |staging| {
            fs::create_dir(staging).unwrap();
            fs::write(staging.join("marker"), "replacement").unwrap();
            Ok(())
        },
        |environment| {
            verified.push(
                environment
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
            );
            Ok("verified")
        },
        |from, to| fs::rename(from, to),
        installer::remove_environment_directory,
    );
    assert_eq!(result.unwrap(), "verified");
    assert_eq!(verified, ["environment.staging", "environment"]);
    assert_eq!(
        fs::read_to_string(root.join("environment/marker")).unwrap(),
        "replacement"
    );
    assert!(!root.join("environment.backup").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn runtime_verification_can_acquire_the_use_lock_before_and_after_promotion() {
    let root = replacement_root("real-verification-lock");
    let executable = std::env::current_exe().unwrap();
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut probes = 0;
        let result = installer::replace_environment(
            &root,
            |staging| {
                fs::create_dir(staging).unwrap();
                fs::write(staging.join("marker"), "replacement").unwrap();
                Ok(())
            },
            |_| {
                probes += 1;
                let status = provider_local_diffusers::verify_python_runtime(
                    &executable,
                    Path::new("unused-worker.py"),
                );
                assert!(!status.ready);
                assert_ne!(status.diagnostic, "Media Studio setup is required.");
                Ok(())
            },
            |from, to| {
                assert!(RUNTIME_USE.try_read().is_err());
                fs::rename(from, to)
            },
            installer::remove_environment_directory,
        );
        sender.send((result, probes, root)).unwrap();
    });
    let (result, probes, root) = receiver
        .recv_timeout(Duration::from_secs(15))
        .expect("runtime verification blocked on the use lock");
    result.unwrap();
    assert_eq!(probes, 2);
    assert_eq!(
        fs::read_to_string(root.join("environment/marker")).unwrap(),
        "replacement"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn package_repair_reuses_valid_managed_python() {
    let commands = managed_python_commands("valid", true, "3.12.10", false);
    assert_eq!(commands.len(), 2);
    assert!(commands[0].contains(&"find".to_string()));
    assert!(commands[0].contains(&"--managed-python".to_string()));
    assert!(commands[0].contains(&"--no-python-downloads".to_string()));
    assert!(!commands
        .iter()
        .any(|args| args.contains(&"install".to_string())));
}

#[test]
fn missing_or_invalid_managed_python_is_installed() {
    for (name, found, version, outside) in [
        ("missing", false, "3.12.10", false),
        ("wrong-version", true, "3.12.9", false),
        ("outside", true, "3.12.10", true),
    ] {
        let commands = managed_python_commands(name, found, version, outside);
        assert!(
            commands.last().unwrap().contains(&"install".to_string()),
            "{name}: {commands:?}"
        );
        assert!(commands
            .last()
            .unwrap()
            .contains(&"--reinstall".to_string()));
    }
}

fn managed_python_commands(
    name: &str,
    found: bool,
    version: &str,
    outside: bool,
) -> Vec<Vec<String>> {
    let root = test_root(name);
    let managed_root = root.join("python/cpython-test");
    fs::create_dir_all(&managed_root).unwrap();
    let python = if outside {
        root.join("outside-python.exe")
    } else {
        managed_root.join("python.exe")
    };
    fs::write(&python, b"test executable").unwrap();
    let mut commands = Vec::new();
    installer::ensure_managed_python(Path::new("uv-test"), &root, "3.12.10", |command, _| {
        let args: Vec<String> = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        commands.push(args.clone());
        if args.contains(&"find".to_string()) {
            if found {
                Ok(python.to_string_lossy().into_owned())
            } else {
                Err("Python is missing".to_string())
            }
        } else if args.contains(&"-c".to_string()) {
            Ok(version.to_string())
        } else {
            Ok(String::new())
        }
    })
    .unwrap();
    fs::remove_dir_all(root).unwrap();
    commands
}

#[test]
#[ignore = "Downloads and installs the actual runtime into an isolated temporary directory"]
fn live_fresh_repair_and_already_configured() {
    let root = test_root("live");
    let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("python/media_diffusers_worker.py");
    eprintln!("Isolated runtime: {}", root.display());
    assert!(!python_path(&root).exists());
    let phases = Mutex::new(Vec::new());
    let report = |status: SetupStatus| {
        let mut phases = phases.lock().unwrap();
        if phases.last() != Some(&status.phase) {
            eprintln!("Setup phase: {:?}", status.phase);
            phases.push(status.phase);
        }
    };
    let fresh = installer::install(&root, &worker, report).unwrap();
    assert!(fresh.ready, "{}", fresh.diagnostic);
    assert!(fresh
        .capabilities
        .iter()
        .any(|value| value == "text-to-image" || value == "local-image-edit"));
    assert!(fresh.capabilities.iter().any(|value| value == "vp9-alpha"));
    eprintln!(
        "Fresh setup ready: {:?} {:?}",
        fresh.device_label, fresh.packages
    );
    exercise_repair_and_reuse(&root, &worker, fresh);
}

#[test]
#[ignore = "Repairs an isolated runtime created by the live setup test"]
fn live_repair_and_reuse() {
    let root = fs::canonicalize(PathBuf::from(
        std::env::var_os("MACHDOCH_MEDIA_SETUP_TEST_ROOT")
            .expect("Set the isolated test runtime path"),
    ))
    .unwrap();
    assert!(root.starts_with(fs::canonicalize(std::env::temp_dir()).unwrap()));
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("machdoch media setup live "));
    let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("python/media_diffusers_worker.py");
    let runtime = installer::install(&root, &worker, |status| {
        eprintln!("Check phase: {:?}", status.phase)
    })
    .unwrap();
    exercise_repair_and_reuse(&root, &worker, runtime);
}

fn exercise_repair_and_reuse(
    root: &Path,
    worker: &Path,
    fresh: provider_local_diffusers::LocalDiffusersRuntimeStatus,
) {
    let uv = root
        .join("tools")
        .join(if cfg!(windows) { "uv.exe" } else { "uv" });
    process::run(
        Command::new(&uv)
            .args(["--no-config", "pip", "uninstall", "--python"])
            .arg(python_path(&root))
            .args(["diffusers", "accelerate", "peft", "imageio-ffmpeg"]),
        Duration::from_secs(60),
    )
    .unwrap();
    process::run(
        Command::new(&uv)
            .args(["--no-config", "pip", "install", "--no-deps", "--python"])
            .arg(python_path(&root))
            .args([
                "torch==2.2.2",
                "transformers==4.57.6",
                "sentencepiece==0.2.1",
                "protobuf==7.34.1",
                "safetensors==0.7.0",
                "Pillow==11.3.0",
            ]),
        Duration::from_secs(10 * 60),
    )
    .unwrap();
    let broken = provider_local_diffusers::probe_python(&python_path(&root), &worker);
    assert!(!broken.ready);
    assert!(
        broken.diagnostic.contains("diffusers"),
        "{}",
        broken.diagnostic
    );
    assert!(
        broken.diagnostic.contains("version mismatch"),
        "{}",
        broken.diagnostic
    );
    eprintln!(
        "Screenshot dependency errors reproduced: {}",
        broken.diagnostic
    );
    let repaired = installer::install(&root, &worker, |status| {
        eprintln!("Repair phase: {:?}", status.phase)
    })
    .unwrap();
    assert!(repaired.ready);
    assert_eq!(fresh.packages, repaired.packages);
    eprintln!("Repair passed");

    let sentinel = root.join("environment/already-configured.txt");
    fs::write(&sentinel, "preserve").unwrap();
    let phases = Mutex::new(Vec::new());
    let configured = installer::install(&root, &worker, |status| {
        phases.lock().unwrap().push(status.phase)
    })
    .unwrap();
    assert!(configured.ready);
    assert_eq!(*phases.lock().unwrap(), vec![SetupPhase::Checking]);
    assert!(sentinel.is_file());
    eprintln!("Already configured: verification passed without installation");
}
