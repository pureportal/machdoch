use super::*;
use std::time::Instant;

struct Fixture {
    root: PathBuf,
    paths: MediaRuntimePaths,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(new_job_id().expect("fixture identifier"));
        let paths = MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs").join("sha256"),
        };
        database::initialize(&paths).expect("initialize database");
        let mut connection = database::open(&paths).expect("open database");
        catalog::synchronize(&mut connection).expect("initialize catalog");
        Self { root, paths }
    }

    fn job(&self, id: &str, status: &str) {
        database::open(&self.paths)
            .unwrap()
            .execute(
                "INSERT INTO media_model_install_jobs(id, model_id, revision, status, manifest_digest, license_digest, files_total, bytes_total, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![id, FLUX_MANIFEST.model_id, FLUX_MANIFEST.revision, status, manifest_digest(&FLUX_MANIFEST), FLUX_MANIFEST.license_digest, FLUX_MANIFEST.files.len() as i64, total_bytes(&FLUX_MANIFEST) as i64, database::now()],
            )
            .expect("insert fixture job");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).expect("remove fixture directory");
    }
}

#[tokio::test]
async fn cancellation_before_execution_settles_within_one_second() {
    let fixture = Fixture::new();
    fixture.job("before-start", "queued");
    let request_started = Instant::now();
    let accepted = request_cancellation(&fixture.paths, "before-start").unwrap();
    let request_elapsed = request_started.elapsed();
    assert_eq!(accepted.status, "canceling");
    let accepted_at = Instant::now();
    execute(&fixture.paths, "before-start").await.unwrap();
    assert_eq!(
        get_job(&fixture.paths, "before-start").unwrap().status,
        "canceled"
    );
    let elapsed = accepted_at.elapsed();
    eprintln!("before-start request={request_elapsed:?} settlement={elapsed:?}");
    assert!(elapsed <= Duration::from_secs(1));
    assert!(!fixture
        .paths
        .models_root()
        .unwrap()
        .join("packages")
        .exists());
}

#[test]
fn cancellation_before_activation_prevents_publication() {
    let fixture = Fixture::new();
    fixture.job("before-activation", "verifying");
    assert_eq!(
        request_cancellation(&fixture.paths, "before-activation")
            .unwrap()
            .status,
        "canceling"
    );
    let stage = fixture.root.join("staging");
    fs::create_dir_all(&stage).unwrap();
    assert_eq!(
        activate(&fixture.paths, "before-activation", &stage),
        Err(CANCELED_SENTINEL.to_string())
    );
    mark_canceled(&fixture.paths, "before-activation").unwrap();
    assert_eq!(
        get_job(&fixture.paths, "before-activation").unwrap().status,
        "canceled"
    );
    assert!(stage.exists());
    assert!(!fixture
        .paths
        .models_root()
        .unwrap()
        .join("packages")
        .exists());
}

#[test]
fn repeated_cancellation_preserves_terminal_states_and_other_jobs() {
    let fixture = Fixture::new();
    fixture.job("selected", "downloading");
    fixture.job("other", "downloading");
    for _ in 0..2 {
        assert_eq!(
            request_cancellation(&fixture.paths, "selected")
                .unwrap()
                .status,
            "canceling"
        );
        assert_eq!(
            get_job(&fixture.paths, "other").unwrap().status,
            "downloading"
        );
        assert!(!cancellation_requested(&fixture.paths, "other").unwrap());
    }
    for status in ["canceled", "installed", "failed"] {
        fixture.job(status, status);
        for _ in 0..2 {
            assert_eq!(
                request_cancellation(&fixture.paths, status).unwrap().status,
                status
            );
        }
    }
    fixture.job("activation-won", "activating");
    assert!(request_cancellation(&fixture.paths, "activation-won").is_err());
    assert!(!cancellation_requested(&fixture.paths, "activation-won").unwrap());
}
