use std::{
    fs,
    path::Path,
    thread,
    time::{Duration, Instant},
};

use serde_json::Value;

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};

const OWNER_POLL_INTERVAL: Duration = Duration::from_secs(1);
const CANCEL_POLL_INTERVAL: Duration = Duration::from_millis(50);
const OWNER_STOP_TIMEOUT: Duration = Duration::from_secs(30);

pub(super) fn request_owner_stop(path: &Path) -> Result<(), String> {
    write_file_atomic(
        path,
        b"Cancelled by user; stopping the restored Ralph run.",
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| format!("Failed to request that the active Ralph owner stop: {error}"))
}

pub(super) fn observe_live_owner(
    run_id: &str,
    cancellation_path: Option<&Path>,
    is_cancelled: impl Fn() -> bool,
    mut inspect: impl FnMut(Option<Instant>) -> Result<Value, String>,
) -> Result<Value, String> {
    let mut detail: Option<Value> = None;
    let mut stop_requested_at: Option<Instant> = None;
    loop {
        if let Some(observation) = detail.as_ref() {
            if observation["record"]["id"] != run_id {
                return Err("The saved Ralph recovery record belongs to another run.".to_string());
            }
            let effective_status = observation["effectiveStatus"].as_str().ok_or_else(|| {
                "The saved Ralph recovery observation has no ownership status.".to_string()
            })?;
            if !matches!(
                observation["record"]["status"].as_str(),
                Some(
                    "running"
                        | "completed"
                        | "crashed"
                        | "blocked"
                        | "stopped"
                        | "waiting-for-input"
                )
            ) {
                return Err(
                    "The saved Ralph recovery record has an invalid run status.".to_string()
                );
            }
            if !matches!(
                effective_status,
                "running"
                    | "abandoned"
                    | "partial"
                    | "completed"
                    | "crashed"
                    | "blocked"
                    | "stopped"
                    | "waiting-for-input"
            ) {
                return Err(
                    "The saved Ralph recovery observation has an invalid ownership status."
                        .to_string(),
                );
            }
            if observation["record"]["status"] != "running" || effective_status != "running" {
                if stop_requested_at.is_some() {
                    if let Some(path) = cancellation_path {
                        match fs::remove_file(path) {
                            Ok(()) => {}
                            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                            Err(error) => {
                                return Err(format!(
                                    "Failed to remove the Ralph stop request: {error}"
                                ))
                            }
                        }
                    }
                }
                return Ok(detail.unwrap());
            }
        }
        if is_cancelled() && stop_requested_at.is_none() {
            let path = cancellation_path.ok_or_else(|| {
                "The Ralph CLI command was cancelled, but its active owner has no retained cancellation path.".to_string()
            })?;
            request_owner_stop(path)?;
            stop_requested_at = Some(Instant::now());
        }
        if stop_requested_at.is_some_and(|started| started.elapsed() >= OWNER_STOP_TIMEOUT) {
            return Err("The Ralph CLI command was cancelled, but its active owner did not stop within 30 seconds. Its stop request is retained; inspect the saved run before starting more work.".to_string());
        }
        if detail.is_some() {
            let deadline = Instant::now() + OWNER_POLL_INTERVAL;
            while Instant::now() < deadline {
                if is_cancelled() && stop_requested_at.is_none() {
                    break;
                }
                thread::sleep(CANCEL_POLL_INTERVAL);
            }
            if is_cancelled() && stop_requested_at.is_none() {
                continue;
            }
        }
        match inspect(stop_requested_at.map(|started| started + OWNER_STOP_TIMEOUT)) {
            Ok(observation) => detail = Some(observation),
            Err(_) if is_cancelled() && stop_requested_at.is_none() => {}
            Err(_)
                if stop_requested_at
                    .is_some_and(|started| started.elapsed() >= OWNER_STOP_TIMEOUT) => {}
            Err(error) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicBool, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    fn observation(status: &str, effective_status: &str) -> Value {
        json!({ "record": { "id": "run", "status": status }, "effectiveStatus": effective_status })
    }

    fn stop_request_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "machdoch-live-owner-{label}-{}-{}.request",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn retained_completion_needs_only_the_initial_inspection() {
        let mut inspections = 0;
        let detail = observe_live_owner(
            "run",
            None,
            || false,
            |_| {
                inspections += 1;
                Ok(observation("completed", "completed"))
            },
        )
        .unwrap();
        assert_eq!(inspections, 1);
        assert_eq!(detail["record"]["status"], "completed");
    }

    #[test]
    fn a_live_owner_is_observed_until_it_finishes_without_attempting_a_resume() {
        let mut inspections = 0;
        let detail = observe_live_owner(
            "run",
            None,
            || false,
            |_| {
                inspections += 1;
                Ok(observation(
                    if inspections == 3 {
                        "completed"
                    } else {
                        "running"
                    },
                    if inspections == 3 {
                        "completed"
                    } else {
                        "running"
                    },
                ))
            },
        )
        .unwrap();
        assert_eq!(inspections, 3);
        assert_eq!(detail["record"]["status"], "completed");
    }

    #[test]
    fn loss_of_the_owner_returns_the_retained_checkpoint_for_resume() {
        let mut inspections = 0;
        let detail = observe_live_owner(
            "run",
            None,
            || false,
            |_| {
                inspections += 1;
                Ok(observation(
                    "running",
                    if inspections == 1 {
                        "running"
                    } else {
                        "abandoned"
                    },
                ))
            },
        )
        .unwrap();
        assert_eq!(detail["effectiveStatus"], "abandoned");
    }

    #[test]
    fn missing_ownership_and_foreign_records_do_not_trigger_resume() {
        for detail in [
            json!({ "record": { "id": "run", "status": "running" } }),
            observation("running", "unknown"),
            observation("unknown", "running"),
        ] {
            assert!(observe_live_owner("run", None, || false, |_| Ok(detail.clone())).is_err());
        }
        assert!(observe_live_owner(
            "other",
            None,
            || false,
            |_| Ok(observation("running", "running"))
        )
        .is_err());
    }

    #[test]
    fn cancellation_requests_stop_once_and_reconciles_the_stopped_owner() {
        let path = stop_request_path("cancel");
        let cancelled = AtomicBool::new(false);
        let mut inspections = 0;
        let detail = observe_live_owner(
            "run",
            Some(&path),
            || cancelled.load(Ordering::SeqCst),
            |deadline| {
                inspections += 1;
                if inspections == 1 {
                    assert!(deadline.is_none());
                    cancelled.store(true, Ordering::SeqCst);
                    return Ok(observation("running", "running"));
                }
                assert!(deadline.is_some());
                assert_eq!(
                    fs::read_to_string(&path).unwrap(),
                    "Cancelled by user; stopping the restored Ralph run."
                );
                Ok(observation("stopped", "stopped"))
            },
        )
        .unwrap();
        assert_eq!(detail["record"]["status"], "stopped");
        assert_eq!(inspections, 2);
        assert!(!path.exists());
    }

    #[test]
    fn cancellation_during_initial_inspection_still_reaches_the_surviving_owner() {
        let path = stop_request_path("initial-inspection");
        let cancelled = AtomicBool::new(false);
        let mut inspections = 0;
        let detail = observe_live_owner(
            "run",
            Some(&path),
            || cancelled.load(Ordering::SeqCst),
            |deadline| {
                inspections += 1;
                if inspections == 1 {
                    cancelled.store(true, Ordering::SeqCst);
                    return Err("The Ralph CLI command was cancelled.".to_string());
                }
                assert!(deadline.is_some());
                assert!(path.is_file());
                Ok(observation("stopped", "stopped"))
            },
        )
        .unwrap();
        assert_eq!(detail["record"]["status"], "stopped");
        assert_eq!(inspections, 2);
        assert!(!path.exists());
    }

    #[test]
    fn cancellation_without_a_retained_path_and_failed_inspections_are_explicit() {
        assert!(observe_live_owner(
            "run",
            None,
            || true,
            |_| panic!("Cancellation must not start an inspection without its path")
        )
        .unwrap_err()
        .contains("cancelled"));
        assert_eq!(
            observe_live_owner(
                "run",
                None,
                || false,
                |_| Err("inspection failed".to_string())
            )
            .unwrap_err(),
            "inspection failed"
        );
    }

    #[test]
    fn an_unresponsive_owner_retains_its_stop_request_at_the_deadline() {
        let path = stop_request_path("timeout");
        let error = observe_live_owner(
            "run",
            Some(&path),
            || true,
            |deadline| {
                assert!(deadline.is_some());
                Ok(observation("running", "running"))
            },
        )
        .unwrap_err();
        assert!(error.contains("did not stop within 30 seconds"));
        assert!(path.is_file());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_failed_stop_request_does_not_claim_the_owner_stopped() {
        let directory = stop_request_path("write-failure");
        let error = observe_live_owner(
            "run",
            Some(&directory.join("stop.request")),
            || true,
            |_| panic!("A failed cancellation request must not be hidden"),
        )
        .unwrap_err();
        assert!(error.contains("Failed to request"));
    }
}
