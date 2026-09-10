use super::{
    commit_state_change_at_paths, load_snapshot_at_path, persist_snapshot_at_paths,
    ShellStateCompareAndSwapResponse, ShellStateSnapshot,
};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

struct Storage {
    directory: PathBuf,
    snapshot: PathBuf,
    revision: PathBuf,
}

impl Storage {
    fn new(name: &str) -> Self {
        let (_, directory) = super::tests::temporary_snapshot_path(name);
        let storage = Self {
            snapshot: directory.join("snapshot.json"),
            revision: directory.join("snapshot.revision"),
            directory,
        };
        persist_snapshot_at_paths(
            &storage.snapshot,
            &storage.revision,
            &ShellStateSnapshot {
                state: json!({"preserved": "original"}),
                revision: 7,
            },
        )
        .expect("initial snapshot and revision should persist");
        storage
    }

    fn load(&self) -> ShellStateSnapshot {
        load_snapshot_at_path(&self.snapshot, Value::Null).expect("fresh snapshot should load")
    }

    async fn patch(
        &self,
        cache: &mut Option<ShellStateSnapshot>,
        expected_revision: u64,
        key: &'static str,
    ) -> Result<ShellStateCompareAndSwapResponse, String> {
        commit_state_change_at_paths(
            self.snapshot.clone(),
            self.revision.clone(),
            cache,
            expected_revision,
            move |current| {
                let mut requested = current.clone();
                requested[key] = json!(true);
                requested
            },
        )
        .await
    }
}

impl Drop for Storage {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.directory).expect("isolated test storage should be removed");
    }
}

async fn directory_sync_failure_case(warm_cache: bool) {
    let storage = Storage::new("directory-sync-failure");
    let mut cache = warm_cache.then(|| storage.load());
    let failure = crate::atomic_file::durability_faults::Failure::at(&storage.snapshot);
    let error = storage.patch(&mut cache, 7, "saved").await.unwrap_err();
    let cached = cache.clone();
    let fresh = storage.load();
    let bytes = fs::read(&storage.snapshot).unwrap();
    let stale = storage.patch(&mut cache, 7, "stale").await.unwrap();
    assert_eq!(fs::read(&storage.snapshot).unwrap(), bytes);
    let current_error = storage
        .patch(&mut cache, 8, "also_saved")
        .await
        .unwrap_err();
    let current_cache = cache.clone();
    let current_fresh = storage.load();
    assert_eq!(fs::read_to_string(&storage.revision).unwrap(), "7");
    drop(failure);
    let recovered = storage.patch(&mut cache, 9, "recovered").await.unwrap();
    let recovered_fresh = storage.load();
    println!("directory sync warm={warm_cache}: error={error}; cached={cached:?}; fresh={fresh:?}; stale={stale:?}; current_error={current_error}; current_cache={current_cache:?}; recovery={recovered:?}");
    assert_eq!(fresh.revision, 8);
    assert_eq!(fresh.state["saved"], true);
    assert!(!stale.committed);
    assert_eq!(stale.revision, 8);
    assert_eq!(stale.state.as_ref(), Some(&fresh.state));
    assert_eq!(current_fresh.revision, 9);
    assert!(recovered.committed);
    assert_eq!(recovered.revision, 10);
    assert_eq!(recovered_fresh.state["preserved"], "original");
    for key in ["saved", "also_saved", "recovered"] {
        assert_eq!(recovered_fresh.state[key], true);
    }
    assert_eq!(recovered_fresh.state["stale"], Value::Null);
    assert_eq!(cache.as_ref().unwrap().state, recovered_fresh.state);
    assert_eq!(cache.as_ref().unwrap().revision, recovered_fresh.revision);
    assert_eq!(fs::read_to_string(&storage.revision).unwrap(), "10");
    assert!(error.contains("snapshot was saved at revision 8"));
    assert!(error.contains("injected directory sync failure"));
    assert!(current_error.contains("snapshot was saved at revision 9"));
    assert_eq!(cached.as_ref().unwrap().revision, fresh.revision);
    assert_eq!(cached.as_ref().unwrap().state, fresh.state);
    assert_eq!(
        current_cache.as_ref().unwrap().revision,
        current_fresh.revision
    );
    assert_eq!(current_cache.as_ref().unwrap().state, current_fresh.state);
}

#[tokio::test]
async fn directory_sync_failure_reconciles_warm_cache() {
    directory_sync_failure_case(true).await;
}

#[tokio::test]
async fn directory_sync_failure_reconciles_cold_cache() {
    directory_sync_failure_case(false).await;
}

#[test]
fn settings_transfer_directory_sync_failure_reconciles_cache() {
    let storage = Storage::new("settings-transfer-directory-sync-failure");
    let mut cache = Some(storage.load());
    let mut next = cache.as_ref().unwrap().clone();
    next.revision = 8;
    next.state["saved"] = json!(true);
    let failure = crate::atomic_file::durability_faults::Failure::at(&storage.snapshot);
    let error = super::persist_snapshot_and_cache_at_paths(
        &storage.snapshot,
        &storage.revision,
        &mut cache,
        next,
    )
    .unwrap_err();
    let cached = cache.clone();
    let fresh = storage.load();
    drop(failure);
    let mut recovered = fresh.clone();
    recovered.revision = 9;
    recovered.state["recovered"] = json!(true);
    assert_eq!(
        super::persist_snapshot_and_cache_at_paths(
            &storage.snapshot,
            &storage.revision,
            &mut cache,
            recovered,
        )
        .unwrap(),
        9
    );
    assert_eq!(storage.load().state["saved"], true);
    assert_eq!(storage.load().state["recovered"], true);
    assert_eq!(cache.as_ref().unwrap().state, storage.load().state);
    assert_eq!(cache.as_ref().unwrap().revision, storage.load().revision);
    assert_eq!(fs::read_to_string(&storage.revision).unwrap(), "9");
    assert!(error.contains("snapshot was saved at revision 8"));
    assert!(error.contains("injected directory sync failure"));
    assert_eq!(cached.as_ref().unwrap().revision, fresh.revision);
    assert_eq!(cached.as_ref().unwrap().state, fresh.state);
}

#[cfg(windows)]
#[tokio::test]
async fn snapshot_replacement_failure_preserves_authoritative_state_and_cache() {
    use std::os::windows::fs::OpenOptionsExt;

    let storage = Storage::new("snapshot-replacement-failure");
    let original = storage.load();
    let original_bytes = fs::read(&storage.snapshot).unwrap();
    let mut cache = Some(original.clone());
    let replacement_blocker = fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2)
        .open(&storage.snapshot)
        .expect("read/write sharing without delete sharing should block replacement");

    let error = storage.patch(&mut cache, 7, "failed").await.unwrap_err();
    let cached = cache.as_ref().unwrap().clone();
    let fresh = storage.load();
    let unchanged_bytes = fs::read(&storage.snapshot).unwrap();
    let revision_file = fs::read_to_string(&storage.revision).unwrap();
    drop(replacement_blocker);
    let recovered = storage.patch(&mut cache, 7, "recovered").await.unwrap();
    let recovered_fresh = storage.load();
    println!("before replacement: error={error}; cached={cached:?}; fresh={fresh:?}; recovery={recovered:?}");

    assert!(error.contains("Failed to persist the shell-state snapshot"));
    assert!(!error.contains("snapshot was saved"));
    assert_eq!(unchanged_bytes, original_bytes);
    assert_eq!(fresh.state, original.state);
    assert_eq!(fresh.revision, 7);
    assert_eq!(cached.state, original.state);
    assert_eq!(cached.revision, 7);
    assert_eq!(revision_file, "7");
    assert!(recovered.committed);
    assert_eq!(recovered.revision, 8);
    assert_eq!(recovered_fresh.state["preserved"], "original");
    assert_eq!(recovered_fresh.state["failed"], Value::Null);
    assert_eq!(recovered_fresh.state["recovered"], true);
    assert_eq!(cache.as_ref().unwrap().state, recovered_fresh.state);
    assert_eq!(cache.as_ref().unwrap().revision, recovered_fresh.revision);
    assert_eq!(fs::read_to_string(&storage.revision).unwrap(), "8");
}

async fn revision_failure_case(warm_cache: bool) {
    let storage = Storage::new("revision-replacement-failure");
    let mut cache = warm_cache.then(|| storage.load());
    fs::remove_file(&storage.revision).unwrap();
    fs::create_dir(&storage.revision).unwrap();

    let error = storage.patch(&mut cache, 7, "saved").await.unwrap_err();
    let cached_after_failure = cache.clone();
    let fresh_after_failure = storage.load();
    let authoritative_bytes = fs::read(&storage.snapshot).unwrap();
    let stale = storage.patch(&mut cache, 7, "stale").await.unwrap();
    let bytes_after_stale = fs::read(&storage.snapshot).unwrap();
    let current_error = storage
        .patch(&mut cache, 8, "also_saved")
        .await
        .unwrap_err();
    let cached_after_current = cache.clone();
    let fresh_after_current = storage.load();
    assert!(storage.revision.is_dir());
    fs::remove_dir(&storage.revision).unwrap();

    let recovered = storage.patch(&mut cache, 9, "recovered").await.unwrap();
    let recovered_fresh = storage.load();
    println!("revision failure (warm_cache={warm_cache}): error={error}; cached={cached_after_failure:?}; fresh={fresh_after_failure:?}; stale={stale:?}; current_error={current_error}; cached_after_current={cached_after_current:?}; fresh_after_current={fresh_after_current:?}; recovery={recovered:?}; recovered_fresh={recovered_fresh:?}");

    assert_eq!(fresh_after_failure.revision, 8);
    assert_eq!(fresh_after_failure.state["saved"], true);
    assert_eq!(fresh_after_failure.state["preserved"], "original");
    assert!(!stale.committed);
    assert_eq!(stale.revision, 8);
    assert_eq!(stale.state.as_ref(), Some(&fresh_after_failure.state));
    assert_eq!(bytes_after_stale, authoritative_bytes);
    assert_eq!(fresh_after_current.revision, 9);
    assert_eq!(fresh_after_current.state["also_saved"], true);
    assert_eq!(fresh_after_current.state["saved"], true);
    assert!(recovered.committed);
    assert_eq!(recovered.revision, 10);
    assert_eq!(recovered_fresh.revision, 10);
    assert_eq!(recovered_fresh.state["preserved"], "original");
    assert_eq!(recovered_fresh.state["saved"], true);
    assert_eq!(recovered_fresh.state["also_saved"], true);
    assert_eq!(recovered_fresh.state["recovered"], true);
    assert_eq!(recovered_fresh.state["stale"], Value::Null);
    assert_eq!(cache.as_ref().unwrap().state, recovered_fresh.state);
    assert_eq!(cache.as_ref().unwrap().revision, recovered_fresh.revision);
    assert_eq!(fs::read_to_string(&storage.revision).unwrap(), "10");

    let cache_matches = cached_after_failure.as_ref().is_some_and(|cached| {
        cached.state == fresh_after_failure.state && cached.revision == fresh_after_failure.revision
    });
    let current_cache_matches = cached_after_current.as_ref().is_some_and(|cached| {
        cached.state == fresh_after_current.state && cached.revision == fresh_after_current.revision
    });
    let accurate_error = error.contains("snapshot was saved at revision 8")
        && error.contains("Failed to persist the shell-state revision")
        && current_error.contains("snapshot was saved at revision 9");
    assert!(
        cache_matches && current_cache_matches && accurate_error,
        "cache_matches={cache_matches}, current_cache_matches={current_cache_matches}, accurate_error={accurate_error}"
    );
}

#[tokio::test]
async fn revision_failure_reconciles_warm_cache_and_reports_saved_snapshot() {
    revision_failure_case(true).await;
}

#[tokio::test]
async fn revision_failure_populates_cold_cache_and_reports_saved_snapshot() {
    revision_failure_case(false).await;
}

#[test]
fn settings_transfer_revision_failure_reconciles_cache_before_returning_error() {
    let storage = Storage::new("settings-transfer-revision-failure");
    let mut cache = Some(storage.load());
    let mut next = cache.as_ref().unwrap().clone();
    next.revision = 8;
    next.state["saved"] = json!(true);
    fs::remove_file(&storage.revision).unwrap();
    fs::create_dir(&storage.revision).unwrap();

    let error = super::persist_snapshot_and_cache_at_paths(
        &storage.snapshot,
        &storage.revision,
        &mut cache,
        next,
    )
    .unwrap_err();
    let fresh = storage.load();
    assert!(error.contains("snapshot was saved at revision 8"));
    assert!(error.contains("Failed to persist the shell-state revision"));
    assert_eq!(cache.as_ref().unwrap().state, fresh.state);
    assert_eq!(cache.as_ref().unwrap().revision, fresh.revision);
    assert_eq!(fresh.state["saved"], true);

    fs::remove_dir(&storage.revision).unwrap();
    let mut next = cache.as_ref().unwrap().clone();
    next.revision += 1;
    next.state["recovered"] = json!(true);
    assert_eq!(
        super::persist_snapshot_and_cache_at_paths(
            &storage.snapshot,
            &storage.revision,
            &mut cache,
            next,
        )
        .unwrap(),
        9
    );
    let recovered = storage.load();
    assert_eq!(recovered.state["preserved"], "original");
    assert_eq!(recovered.state["saved"], true);
    assert_eq!(recovered.state["recovered"], true);
    assert_eq!(cache.as_ref().unwrap().state, recovered.state);
    assert_eq!(cache.as_ref().unwrap().revision, recovered.revision);
    assert_eq!(fs::read_to_string(&storage.revision).unwrap(), "9");
}
