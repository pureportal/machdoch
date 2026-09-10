use super::*;
use std::process::Command;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

const CASE_ENV: &str = "MACHDOCH_SETTINGS_RECOVERY_CASE";
const TRANSACTION_ID: &str = "persisted-recovery-test-transaction";
const CONFIG_FILES: [&str; 2] = ["user-config.json", "mcp.json"];
const ORIGINAL: &[u8] = b" \r\n{\"text\":\"Gr\xc3\xbc\xc3\x9fe\"}\r\n\xff\x00";
const IMPORTED: &[u8] = b"{\"imported\":true}\n";

fn original_bytes(state: usize) -> Option<&'static [u8]> {
    match state {
        0 | 3 => Some(ORIGINAL),
        1 => None,
        2 => Some(b""),
        _ => panic!("invalid fixture state"),
    }
}

fn isolated_cases(name: &str, cases: Vec<Vec<usize>>, run: impl Fn(&[usize])) {
    if let Ok(case) = std::env::var(CASE_ENV) {
        run(&serde_json::from_str::<Vec<usize>>(&case).unwrap());
        return;
    }
    let mut failures = Vec::new();
    for case in cases {
        let root = super::tests::temporary_test_root(name);
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("settings_transfer::transaction::persisted_recovery_tests::{name}"),
                "--nocapture",
            ])
            .env("MACHDOCH_USER_CONFIG_DIR", &root)
            .env(CASE_ENV, serde_json::to_string(&case).unwrap())
            .output()
            .expect("recovery subprocess should run");
        if root.exists() {
            fs::remove_dir_all(&root).expect("isolated test root should be removable");
        }
        if !output.status.success() {
            failures.push(format!(
                "{case:?}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

struct Fixture {
    app: tauri::App<MockRuntime>,
    root: PathBuf,
    backup: ResourceBackup,
    journal: TransactionJournal,
}

impl Fixture {
    fn new(states: &[usize], phase: JournalPhase) -> Self {
        let root = get_user_config_directory().unwrap();
        secure_directory(&root).unwrap();
        let app = mock_builder().build(mock_context(noop_assets())).unwrap();
        let mut categories = BTreeSet::from([SettingsCategoryId::GlobalPrompts]);
        for (index, category) in [SettingsCategoryId::ApiKeys, SettingsCategoryId::GlobalMcp]
            .into_iter()
            .enumerate()
        {
            if states[index] != 0 {
                categories.insert(category);
            }
            if let Some(bytes) = original_bytes(states[index]) {
                fs::write(root.join(CONFIG_FILES[index]), bytes).unwrap();
            }
        }
        let backup = capture_backup(app.handle(), &root, &categories).unwrap();
        let journal = TransactionJournal {
            version: JOURNAL_VERSION,
            transaction_id: TRANSACTION_ID.to_string(),
            categories,
            preview_fingerprint: backup_fingerprint(&backup).unwrap(),
            backup_sha256: String::new(),
            post_commit_fingerprint: (phase == JournalPhase::Committed)
                .then(|| sha256_hex(IMPORTED)),
            phase,
        };
        let mut fixture = Self {
            app,
            root,
            backup,
            journal,
        };
        fixture.persist();
        for name in CONFIG_FILES {
            fs::write(fixture.root.join(name), IMPORTED).unwrap();
        }
        let orphan = fixture
            .root
            .join(TRANSACTION_DIRECTORY)
            .join("orphan-stage");
        secure_directory(&orphan).unwrap();
        fs::write(orphan.join(PAYLOAD_FILE), b"synthetic staged secret").unwrap();
        fixture
    }

    fn transaction_root(&self) -> PathBuf {
        self.root.join(TRANSACTION_DIRECTORY).join(TRANSACTION_ID)
    }

    fn persist(&mut self) {
        let raw =
            write_private_json(&self.transaction_root().join(BACKUP_FILE), &self.backup).unwrap();
        self.journal.backup_sha256 = sha256_hex(&raw);
        write_private_json(&self.root.join(JOURNAL_FILE), &self.journal).unwrap();
    }

    fn assert_files(&self, states: &[usize], rollback: bool) {
        for (index, name) in CONFIG_FILES.into_iter().enumerate() {
            let expected = if rollback && states[index] != 0 {
                original_bytes(states[index])
            } else {
                Some(IMPORTED)
            };
            let actual = match fs::read(self.root.join(name)) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => panic!("could not read {name}: {error}"),
            };
            assert_eq!(actual.as_deref(), expected, "{name}");
        }
    }

    fn assert_cleaned(&self) {
        for path in [JOURNAL_FILE, RETIRED_JOURNAL_FILE, TRANSACTION_DIRECTORY] {
            assert!(!self.root.join(path).exists(), "artifact remains: {path}");
        }
    }
}

#[test]
fn persisted_file_states_round_trip() {
    let cases = (0..4)
        .flat_map(|u| (0..4).map(move |m| vec![u, m]))
        .collect();
    isolated_cases("persisted_file_states_round_trip", cases, |states| {
        let fixture = Fixture::new(states, JournalPhase::Committing);
        let loaded = load_backup(&fixture.root, &fixture.journal).unwrap();
        assert_eq!(loaded, fixture.backup);
        assert_eq!(
            backup_fingerprint(&loaded).unwrap(),
            fixture.journal.preview_fingerprint
        );
    });
}

#[test]
fn persisted_recovery_obeys_journal_phase_and_selection() {
    let cases = (0..4)
        .flat_map(|u| (0..4).flat_map(move |m| (0..3).map(move |phase| vec![u, m, phase])))
        .collect();
    isolated_cases(
        "persisted_recovery_obeys_journal_phase_and_selection",
        cases,
        |case| {
            let phase = match case[2] {
                0 => JournalPhase::Prepared,
                1 => JournalPhase::Committing,
                2 => JournalPhase::Committed,
                _ => unreachable!(),
            };
            let fixture = Fixture::new(case, phase);
            for _ in 0..2 {
                recover_pending_transaction(fixture.app.handle()).unwrap();
                fixture.assert_files(case, case[2] == 1);
                fixture.assert_cleaned();
            }
        },
    );
}

#[test]
fn inconsistent_persisted_selections_reject_before_restoration() {
    let cases = (0..2)
        .flat_map(|resource| (0..4).map(move |state| vec![resource, state]))
        .chain(std::iter::once(vec![2, 3]))
        .collect();
    isolated_cases(
        "inconsistent_persisted_selections_reject_before_restoration",
        cases,
        |case| {
            let mut states = [3, 3];
            if case[0] < 2 {
                states[case[0]] = case[1];
            }
            let mut fixture = Fixture::new(&states, JournalPhase::Committing);
            if case[0] < 2 {
                let category =
                    [SettingsCategoryId::ApiKeys, SettingsCategoryId::GlobalMcp][case[0]];
                if case[1] == 0 {
                    fixture.backup.categories.insert(category);
                } else {
                    fixture.backup.categories.remove(&category);
                }
                fixture.journal.categories = fixture.backup.categories.clone();
            } else {
                fixture
                    .journal
                    .categories
                    .remove(&SettingsCategoryId::GlobalMcp);
            }
            fixture.persist();
            let journal = fs::read(fixture.root.join(JOURNAL_FILE)).unwrap();
            let backup = fs::read(fixture.transaction_root().join(BACKUP_FILE)).unwrap();
            for _ in 0..2 {
                let error = recover_pending_transaction(fixture.app.handle()).unwrap_err();
                assert!(error.contains("metadata"), "{error}");
                fixture.assert_files(&states, false);
                assert_eq!(fs::read(fixture.root.join(JOURNAL_FILE)).unwrap(), journal);
                assert_eq!(
                    fs::read(fixture.transaction_root().join(BACKUP_FILE)).unwrap(),
                    backup
                );
            }
        },
    );
}

#[test]
fn failed_persisted_restoration_retains_retry_data() {
    let cases = (0..2)
        .flat_map(|resource| (1..4).map(move |state| vec![resource, state]))
        .collect();
    isolated_cases(
        "failed_persisted_restoration_retains_retry_data",
        cases,
        |case| {
            let mut states = [3, 3];
            states[case[0]] = case[1];
            let fixture = Fixture::new(&states, JournalPhase::Committing);
            let blocked_path = fixture.root.join(CONFIG_FILES[case[0]]);
            fs::remove_file(&blocked_path).unwrap();
            fs::create_dir(&blocked_path).unwrap();
            let journal = fs::read(fixture.root.join(JOURNAL_FILE)).unwrap();
            let backup = fs::read(fixture.transaction_root().join(BACKUP_FILE)).unwrap();
            for _ in 0..2 {
                let error = recover_pending_transaction(fixture.app.handle()).unwrap_err();
                assert!(
                    !error.contains("metadata"),
                    "restoration must be reached: {error}"
                );
                assert!(blocked_path.is_dir());
                assert_eq!(fs::read(fixture.root.join(JOURNAL_FILE)).unwrap(), journal);
                assert_eq!(
                    fs::read(fixture.transaction_root().join(BACKUP_FILE)).unwrap(),
                    backup
                );
                assert!(!fixture.transaction_root().join(PAYLOAD_FILE).exists());
                assert!(!fixture.root.join(RETIRED_JOURNAL_FILE).exists());
            }
            fs::remove_dir(&blocked_path).unwrap();
            for _ in 0..2 {
                recover_pending_transaction(fixture.app.handle()).unwrap();
                fixture.assert_files(&states, true);
                fixture.assert_cleaned();
            }
        },
    );
}
