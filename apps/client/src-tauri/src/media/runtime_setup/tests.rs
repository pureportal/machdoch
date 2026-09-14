use std::{
    fs,
    path::Path,
    process::Command,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::*;

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

fn test_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "machdoch media setup {name} {}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

#[test]
fn rebuilds_a_damaged_environment_without_touching_other_storage() {
    let root = test_root("damaged");
    fs::create_dir_all(root.join("environment/Scripts")).unwrap();
    fs::write(root.join("environment/Scripts/partial.txt"), "damaged").unwrap();
    fs::write(root.join("model.safetensors"), "keep").unwrap();
    fs::write(root.join("asset.png"), "keep").unwrap();
    installer::remove_managed_environment(&root).unwrap();
    assert!(!root.join("environment").exists());
    assert_eq!(
        fs::read_to_string(root.join("model.safetensors")).unwrap(),
        "keep"
    );
    assert_eq!(fs::read_to_string(root.join("asset.png")).unwrap(), "keep");
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
