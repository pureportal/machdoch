use super::super::storage::{self, read_config};
use super::*;

struct Fixture {
    root: PathBuf,
    control: PathBuf,
    target: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let root = std::env::temp_dir().join(format!(
            "machdoch-storage-{:x}",
            u128::from_le_bytes(random)
        ));
        let control = root.join("app");
        let target = root.join("disk");
        let source = control.join("media-studio");
        for relative in [
            "models/checkpoints",
            "models/addons",
            "blobs/sha256",
            "empty",
        ] {
            fs::create_dir_all(source.join(relative)).unwrap();
        }
        fs::create_dir_all(&target).unwrap();
        fs::write(
            source.join("models/checkpoints/model.safetensors"),
            b"checkpoint bytes",
        )
        .unwrap();
        fs::write(source.join("models/addons/lora.safetensors"), b"lora bytes").unwrap();
        fs::write(source.join("blobs/sha256/image.png"), b"image bytes").unwrap();
        let connection = rusqlite::Connection::open(source.join("media.sqlite3")).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE assets(name TEXT); INSERT INTO assets VALUES ('model');").unwrap();
        drop(connection);
        Self {
            root,
            control,
            target,
        }
    }

    fn prepare(&self) -> StorageConfig {
        let mut config = read_config(&self.control).unwrap();
        prepare(&self.control, &mut config, &self.target).unwrap();
        config
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn moves_complete_library_and_database_then_resolves_new_storage() {
    let fixture = Fixture::new();
    let mut config = fixture.prepare();
    let source = config.migration.as_ref().unwrap().source.clone();
    execute(&fixture.control, &mut config).unwrap();
    assert!(!source.exists());
    assert!(config.migration.is_none());
    let paths = storage::resolve(&fixture.control).unwrap();
    assert_eq!(
        fs::read(paths.models_root().unwrap().join("addons/lora.safetensors")).unwrap(),
        b"lora bytes"
    );
    assert!(fixture.target.join("empty").is_dir());
    let connection = rusqlite::Connection::open(&paths.database).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT name FROM assets", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "model"
    );
}

#[test]
fn resumes_partial_file_after_restart_and_repairs_invalid_prefix() {
    for corrupt in [false, true] {
        let fixture = Fixture::new();
        let config = fixture.prepare();
        let migration = config.migration.as_ref().unwrap();
        let index = migration
            .files
            .iter()
            .position(|entry| entry.relative == Path::new("models/checkpoints/model.safetensors"))
            .unwrap();
        let temporary = fixture
            .target
            .join("models/checkpoints")
            .join(format!(".machdoch-moving-{}-{index}", migration.identity));
        fs::create_dir_all(temporary.parent().unwrap()).unwrap();
        fs::write(&temporary, if corrupt { b"BAD" } else { b"che" }).unwrap();
        let mut restarted = read_config(&fixture.control).unwrap();
        execute(&fixture.control, &mut restarted).unwrap();
        assert_eq!(
            fs::read(fixture.target.join("models/checkpoints/model.safetensors")).unwrap(),
            b"checkpoint bytes"
        );
        assert!(!temporary.exists());
    }
}

#[test]
fn resumes_after_file_rename_before_journal_update() {
    let fixture = Fixture::new();
    let config = fixture.prepare();
    copy_file(config.migration.as_ref().unwrap(), 0).unwrap();
    let mut restarted = read_config(&fixture.control).unwrap();
    assert!(restarted.migration.as_ref().unwrap().files[0]
        .digest
        .is_none());
    execute(&fixture.control, &mut restarted).unwrap();
    assert!(restarted.migration.is_none());
}

#[test]
fn resumes_after_journal_commit_before_destination_marker_creation() {
    let fixture = Fixture::new();
    fixture.prepare();
    fs::remove_file(fixture.target.join(MARKER)).unwrap();
    let mut restarted = read_config(&fixture.control).unwrap();
    execute(&fixture.control, &mut restarted).unwrap();
    assert!(restarted.migration.is_none());
    assert!(fixture
        .target
        .join("models/addons/lora.safetensors")
        .is_file());
}

fn commit_copies(fixture: &Fixture, config: &mut StorageConfig) {
    for index in 0..config.migration.as_ref().unwrap().files.len() {
        let digest = copy_file(config.migration.as_ref().unwrap(), index).unwrap();
        config.migration.as_mut().unwrap().files[index].digest = Some(digest);
    }
    let migration = config.migration.as_mut().unwrap();
    migration.cleaning = true;
    config.root = migration.target.clone();
    config.identity = Some(migration.identity.clone());
    save_config(&fixture.control, config).unwrap();
}

#[test]
fn resumes_cleanup_after_original_file_was_removed() {
    let fixture = Fixture::new();
    let mut config = fixture.prepare();
    commit_copies(&fixture, &mut config);
    let migration = config.migration.as_ref().unwrap();
    fs::remove_file(migration.source.join(&migration.files[0].relative)).unwrap();
    let mut restarted = read_config(&fixture.control).unwrap();
    execute(&fixture.control, &mut restarted).unwrap();
    assert!(storage::resolve(&fixture.control).is_ok());
}

#[test]
fn corrupt_destination_preserves_originals_and_keeps_storage_blocked() {
    let fixture = Fixture::new();
    let mut config = fixture.prepare();
    commit_copies(&fixture, &mut config);
    let migration = config.migration.as_ref().unwrap();
    let original = migration.source.join(&migration.files[0].relative);
    fs::write(
        migration.target.join(&migration.files[0].relative),
        b"corrupt",
    )
    .unwrap();
    assert!(execute(&fixture.control, &mut config).is_err());
    assert!(original.is_file());
    assert!(storage::resolve(&fixture.control).is_err());
}

#[test]
fn refuses_changed_original_during_cleanup() {
    let fixture = Fixture::new();
    let mut config = fixture.prepare();
    commit_copies(&fixture, &mut config);
    let migration = config.migration.as_ref().unwrap();
    let original = migration.source.join(&migration.files[0].relative);
    fs::write(&original, b"new external content").unwrap();
    assert!(execute(&fixture.control, &mut config).is_err());
    assert_eq!(fs::read(original).unwrap(), b"new external content");
}

#[test]
fn rejects_overlapping_and_nonempty_destinations() {
    let fixture = Fixture::new();
    let source = fixture.control.join("media-studio");
    let nested = source.join("nested");
    fs::create_dir(&nested).unwrap();
    for target in [&source, &nested, &fixture.control] {
        assert!(prepare(
            &fixture.control,
            &mut read_config(&fixture.control).unwrap(),
            target
        )
        .is_err());
    }
    fs::write(fixture.target.join("keep.txt"), b"keep").unwrap();
    assert!(prepare(
        &fixture.control,
        &mut read_config(&fixture.control).unwrap(),
        &fixture.target
    )
    .is_err());
    assert_eq!(fs::read(fixture.target.join("keep.txt")).unwrap(), b"keep");
}

#[test]
fn storage_leases_exclude_moves_until_all_clones_finish() {
    let fixture = Fixture::new();
    let paths = storage::resolve(&fixture.control).unwrap();
    let cloned = paths.clone();
    assert!(storage::lock(&fixture.control, true).is_err());
    drop(paths);
    assert!(storage::lock(&fixture.control, true).is_err());
    drop(cloned);
    let exclusive = storage::lock(&fixture.control, true).unwrap();
    assert!(storage::resolve(&fixture.control).is_err());
    assert!(storage::lock(&fixture.control, true).is_err());
    drop(exclusive);
    assert!(storage::resolve(&fixture.control).is_ok());
}

#[test]
fn missing_destination_disk_does_not_recreate_or_use_default_storage() {
    let fixture = Fixture::new();
    let mut config = fixture.prepare();
    execute(&fixture.control, &mut config).unwrap();
    let offline = fixture.root.join("offline");
    fs::rename(&fixture.target, &offline).unwrap();
    assert!(storage::resolve(&fixture.control).is_err());
    assert!(!fixture.target.exists());
    fs::create_dir(&fixture.target).unwrap();
    assert!(storage::resolve(&fixture.control).is_err());
}

#[test]
fn second_move_relocates_previously_configured_storage() {
    let fixture = Fixture::new();
    let mut config = fixture.prepare();
    execute(&fixture.control, &mut config).unwrap();
    let next = fixture.root.join("next-disk");
    fs::create_dir(&next).unwrap();
    prepare(&fixture.control, &mut config, &next).unwrap();
    execute(&fixture.control, &mut config).unwrap();
    assert!(!fixture.target.exists());
    assert!(next.join("models/addons/lora.safetensors").is_file());
}

#[test]
fn rejects_unsafe_manifest_paths_and_low_space() {
    let fixture = Fixture::new();
    for relative in ["../outside", "/outside"] {
        assert!(checked_path(&fixture.target, Path::new(relative), true).is_err());
    }
    assert!(require_space(&fixture.target, u64::MAX).is_err());
}

#[test]
fn crash_worker() {
    let Ok(control) = std::env::var("MACHDOCH_STORAGE_CRASH_TEST") else {
        return;
    };
    let control = PathBuf::from(control);
    let _lease = storage::lock(&control, true).unwrap();
    let mut config = read_config(&control).unwrap();
    match std::env::var("MACHDOCH_STORAGE_CRASH_PHASE")
        .unwrap()
        .as_str()
    {
        "partial" => {
            let migration = config.migration.as_ref().unwrap();
            let relative = migration.files[0]
                .relative
                .with_file_name(format!(".machdoch-moving-{}-0", migration.identity));
            let temporary = checked_path(&migration.target, &relative, true).unwrap();
            let source = fs::read(migration.source.join(&migration.files[0].relative)).unwrap();
            let mut file = File::create(temporary).unwrap();
            file.write_all(&source[..source.len() / 2]).unwrap();
            file.sync_all().unwrap();
        }
        "renamed" => {
            copy_file(config.migration.as_ref().unwrap(), 0).unwrap();
        }
        "cleanup" => {
            for index in 0..config.migration.as_ref().unwrap().files.len() {
                let digest = copy_file(config.migration.as_ref().unwrap(), index).unwrap();
                config.migration.as_mut().unwrap().files[index].digest = Some(digest);
            }
            let migration = config.migration.as_mut().unwrap();
            migration.cleaning = true;
            config.root = migration.target.clone();
            config.identity = Some(migration.identity.clone());
            save_config(&control, &config).unwrap();
            let migration = config.migration.as_ref().unwrap();
            fs::remove_file(migration.source.join(&migration.files[0].relative)).unwrap();
        }
        _ => panic!("Unknown crash phase"),
    }
    std::process::exit(73);
}

#[test]
fn process_exit_releases_lock_and_recovers_each_commit_boundary() {
    for phase in ["partial", "renamed", "cleanup"] {
        let fixture = Fixture::new();
        fixture.prepare();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "media::storage_migration::tests::crash_worker",
                "--nocapture",
            ])
            .env("MACHDOCH_STORAGE_CRASH_TEST", &fixture.control)
            .env("MACHDOCH_STORAGE_CRASH_PHASE", phase)
            .output()
            .unwrap();
        assert_eq!(
            result.status.code(),
            Some(73),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let _lease = storage::lock(&fixture.control, true).unwrap();
        let mut restarted = read_config(&fixture.control).unwrap();
        execute(&fixture.control, &mut restarted).unwrap();
        assert!(restarted.migration.is_none());
        assert_eq!(
            fs::read(fixture.target.join("models/checkpoints/model.safetensors")).unwrap(),
            b"checkpoint bytes"
        );
    }
}

#[test]
#[ignore = "requires MACHDOCH_STORAGE_TEST_DISK pointing to a second writable volume"]
fn moves_library_to_another_volume_and_back() {
    let mut fixture = Fixture::new();
    let disk = PathBuf::from(std::env::var("MACHDOCH_STORAGE_TEST_DISK").unwrap());
    assert!(disk.is_absolute());
    assert_ne!(disk.components().next(), fixture.root.components().next());
    let target = disk.join(fixture.root.file_name().unwrap());
    fs::create_dir(&target).unwrap();
    fixture.target = target.clone();
    let mut config = fixture.prepare();
    execute(&fixture.control, &mut config).unwrap();
    assert_eq!(
        fs::read(target.join("models/addons/lora.safetensors")).unwrap(),
        b"lora bytes"
    );
    let returned = fixture.root.join("returned");
    fs::create_dir(&returned).unwrap();
    prepare(&fixture.control, &mut config, &returned).unwrap();
    execute(&fixture.control, &mut config).unwrap();
    assert!(!target.exists());
    assert!(returned
        .join("models/checkpoints/model.safetensors")
        .exists());
}
