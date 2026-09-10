use super::*;
use std::process::Command;
use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

const CASE_ENV: &str = "MACHDOCH_SETTINGS_PAYLOAD_CASE";
const TRANSFER_ID: &str = "payload-copy-test-transaction";
const ORIGINAL: &[u8] = b"{\"unselected\":\"preserved\"}\n";

fn isolated(name: &str, run: impl FnOnce()) {
    if std::env::var(CASE_ENV).as_deref() == Ok(name) {
        run();
        return;
    }
    let root = super::tests::temporary_test_root(name);
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("settings_transfer::transaction::payload_tests::{name}"),
        ])
        .env("MACHDOCH_USER_CONFIG_DIR", &root)
        .env(CASE_ENV, name)
        .output()
        .expect("payload subprocess should run");
    if root.exists() {
        fs::remove_dir_all(&root).expect("isolated test root should be removable");
    }
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

struct Fixture {
    app: tauri::App<MockRuntime>,
    root: PathBuf,
    envelope: TransferEnvelope,
    fingerprint: String,
}

impl Fixture {
    fn new() -> Self {
        let root = get_user_config_directory().unwrap();
        secure_directory(&root).unwrap();
        let app = mock_builder()
            .manage(crate::ui_operation::CrossWindowOperationState::default())
            .build(mock_context(noop_assets()))
            .unwrap();
        fs::write(
            root.join("user-config.json"),
            br#"{"apiKeys":{"openai":"synthetic-sensitive-value"},"webSearch":{"apiKeys":{}}}"#,
        )
        .unwrap();
        fs::write(root.join("mcp.json"), b"{}").unwrap();
        let categories =
            BTreeSet::from([SettingsCategoryId::ApiKeys, SettingsCategoryId::GlobalMcp]);
        let snapshots = categories
            .iter()
            .map(|id| match snapshot_category(app.handle(), *id) {
                SnapshotAvailability::Available(snapshot) => snapshot,
                SnapshotAvailability::Unavailable(_) => panic!("fixture snapshot unavailable"),
            })
            .collect();
        fs::write(root.join("user-config.json"), ORIGINAL).unwrap();
        fs::remove_file(root.join("mcp.json")).unwrap();
        let backup = capture_backup(app.handle(), &root, &categories).unwrap();
        Self {
            app,
            root,
            envelope: TransferEnvelope {
                protocol_version: super::super::contract::PROTOCOL_MAJOR,
                transfer_id: TRANSFER_ID.to_string(),
                created_at: 1,
                expires_at: u64::MAX,
                categories: snapshots,
            },
            fingerprint: backup_fingerprint(&backup).unwrap(),
        }
    }

    fn stage(&self) -> TransferEnvelope {
        let bytes = Zeroizing::new(serde_json::to_vec(&self.envelope).unwrap());
        let mut stage = IncomingPayloadStage::create(TRANSFER_ID, bytes.len() as u64).unwrap();
        let stage_root = stage.root.clone();
        assert!(stage_root.join(PAYLOAD_FILE).is_file());
        let split = bytes.len() / 2;
        stage.append(0, &bytes[..split]).unwrap();
        stage.append(split as u64, &bytes[split..]).unwrap();
        let envelope = stage.finish(&sha256_hex(&bytes)).unwrap();
        assert!(envelope == self.envelope, "staging changed the envelope");
        assert!(!stage_root.exists());
        envelope
    }

    fn prepare(&self) -> PreparedTransaction<MockRuntime> {
        prepare_transaction(self.app.handle().clone(), self.stage(), &self.fingerprint)
            .unwrap_or_else(|_| panic!("fixture preparation failed"))
    }

    fn assert_cleaned(&self) {
        for name in [JOURNAL_FILE, RETIRED_JOURNAL_FILE, TRANSACTION_DIRECTORY] {
            assert!(!self.root.join(name).exists(), "artifact remains: {name}");
        }
    }

    fn assert_original(&self) {
        assert!(fs::read(self.root.join("user-config.json")).unwrap() == ORIGINAL);
        assert!(!self.root.join("mcp.json").exists());
    }
}

#[test]
fn prepared_directory_contains_only_rollback_data() {
    isolated("prepared_directory_contains_only_rollback_data", || {
        let fixture = Fixture::new();
        let transaction = fixture.prepare();
        let directory = fixture.root.join(TRANSACTION_DIRECTORY).join(TRANSFER_ID);
        let entries = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<BTreeSet<_>>();
        let journal = load_journal(&fixture.root, &fixture.root.join(JOURNAL_FILE)).unwrap();
        assert_eq!(journal.phase, JournalPhase::Prepared);
        assert!(load_backup(&fixture.root, &journal).unwrap() == transaction.backup);
        discard_prepared_transaction(transaction).unwrap();
        fixture.assert_cleaned();
        assert_eq!(
            entries,
            BTreeSet::from([std::ffi::OsString::from(BACKUP_FILE)])
        );
    });
}

#[test]
fn staged_envelope_commits_selected_values_and_cleans_up() {
    isolated(
        "staged_envelope_commits_selected_values_and_cleans_up",
        || {
            let fixture = Fixture::new();
            let outcome = fixture
                .prepare()
                .commit(|| panic!("unexpected rollback"))
                .unwrap_or_else(|_| panic!("fixture commit failed"));
            assert!(!outcome.recovery_cleanup_pending);
            verify_import(fixture.app.handle(), &fixture.envelope).unwrap();
            let config: Value =
                serde_json::from_slice(&fs::read(fixture.root.join("user-config.json")).unwrap())
                    .unwrap();
            assert!(config["unselected"] == "preserved");
            fixture.assert_cleaned();
        },
    );
}

#[test]
fn cancellation_and_staging_rejection_remove_payloads_and_allow_retry() {
    isolated(
        "cancellation_and_staging_rejection_remove_payloads_and_allow_retry",
        || {
            let fixture = Fixture::new();
            let bytes = Zeroizing::new(serde_json::to_vec(&fixture.envelope).unwrap());
            for case in 0..4 {
                let mut stage =
                    IncomingPayloadStage::create(TRANSFER_ID, bytes.len() as u64).unwrap();
                let directory = stage.root.clone();
                if case < 2 {
                    stage.append(0, &bytes[..bytes.len() / 2]).unwrap();
                    if case == 0 {
                        drop(stage);
                    } else {
                        assert!(stage.finish(&sha256_hex(&bytes)).is_err());
                    }
                } else {
                    let input = if case == 2 {
                        bytes.to_vec()
                    } else {
                        vec![b'x'; bytes.len()]
                    };
                    stage.append(0, &input).unwrap();
                    let digest = if case == 2 {
                        "0".repeat(64)
                    } else {
                        sha256_hex(&input)
                    };
                    assert!(stage.finish(&digest).is_err());
                }
                assert!(!directory.exists());
            }
            for _ in 0..2 {
                discard_prepared_transaction(fixture.prepare()).unwrap();
                fixture.assert_cleaned();
                fixture.assert_original();
            }
        },
    );
}

#[test]
fn preparation_persistence_failures_clean_up_and_allow_retry() {
    isolated(
        "preparation_persistence_failures_clean_up_and_allow_retry",
        || {
            let fixture = Fixture::new();
            let transaction_root = fixture.root.join(TRANSACTION_DIRECTORY).join(TRANSFER_ID);
            for path in [
                transaction_root.join(BACKUP_FILE),
                fixture.root.join(JOURNAL_FILE),
            ] {
                let failure = crate::atomic_file::durability_faults::Failure::at(&path);
                assert!(prepare_transaction(
                    fixture.app.handle().clone(),
                    fixture.stage(),
                    &fixture.fingerprint
                )
                .is_err());
                assert!(!transaction_root.exists());
                assert!(!fixture.root.join(JOURNAL_FILE).exists());
                assert!(fs::read_dir(fixture.root.join(TRANSACTION_DIRECTORY))
                    .unwrap()
                    .next()
                    .is_none());
                fixture.assert_original();
                drop(failure);
                discard_prepared_transaction(fixture.prepare()).unwrap();
                fixture.assert_cleaned();
            }
        },
    );
}
