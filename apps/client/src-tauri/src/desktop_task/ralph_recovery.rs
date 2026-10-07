use std::{
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(super) const RALPH_RUN_ID_ENV: &str = "MACHDOCH_RALPH_RUN_ID";
pub(super) const RALPH_MAX_RECOVERY_FAILURES: usize = 3;
static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(0);

pub(super) struct RalphCommandAttempt<T> {
    pub result: Result<T, String>,
    pub retry_reason: Option<String>,
    pub meaningful_transitions: Option<u64>,
}

pub(super) fn supervise_ralph_command<T>(
    original_arguments: &[String],
    run_id: Option<&str>,
    is_cancelled: impl Fn() -> bool,
    mut execute: impl FnMut(&[String], Option<&str>) -> RalphCommandAttempt<T>,
    mut notify_recovery: impl FnMut(),
) -> Result<T, String> {
    if is_cancelled() {
        return Err("The Ralph CLI command was cancelled.".to_string());
    }
    let mut arguments = original_arguments.to_vec();
    let mut failures = Vec::new();
    let mut meaningful_transitions = None;
    loop {
        if is_cancelled() {
            return Err("The Ralph CLI command was cancelled.".to_string());
        }
        let outcome = execute(&arguments, run_id.as_deref());
        let Some(reason) = outcome
            .retry_reason
            .filter(|_| run_id.is_some() && !is_cancelled())
        else {
            return outcome.result.map_err(|reason| {
                failures.push(reason);
                failures.join("\n")
            });
        };
        if let Some(progress) = outcome.meaningful_transitions {
            if meaningful_transitions.is_some_and(|previous| progress > previous) {
                failures.clear();
            }
            meaningful_transitions = Some(meaningful_transitions.unwrap_or(0).max(progress));
        }
        failures.push(reason.chars().take(4_000).collect::<String>());
        let attempt = failures.len();
        if attempt == RALPH_MAX_RECOVERY_FAILURES {
            return Err(format!(
                "Ralph run {} could not recover after {attempt} attempts without progress. {}",
                run_id.as_deref().unwrap_or_default(),
                failures.join("\n")
            ));
        }
        notify_recovery();
        if !wait_for_ralph_recovery(attempt, &is_cancelled) {
            return outcome.result;
        }
        arguments = recovery_arguments(original_arguments, run_id.as_deref().unwrap_or_default());
    }
}

pub(super) fn inspect_ralph_saved_run<T>(
    is_cancelled: impl Fn() -> bool,
    mut inspect: impl FnMut(&mut bool) -> Result<T, String>,
) -> Result<T, String> {
    let mut failures = Vec::new();
    loop {
        if is_cancelled() {
            return Err("The Ralph CLI command was cancelled.".to_string());
        }
        let mut interrupted_child = false;
        match inspect(&mut interrupted_child) {
            Ok(detail) => return Ok(detail),
            Err(reason) => {
                failures.push(reason.chars().take(4_000).collect::<String>());
                let attempt = failures.len();
                if !interrupted_child || is_cancelled() || attempt == RALPH_MAX_RECOVERY_FAILURES {
                    return Err(failures.join("\n"));
                }
                if !wait_for_ralph_recovery(attempt, &is_cancelled) {
                    return Err("The Ralph CLI command was cancelled.".to_string());
                }
            }
        }
    }
}

fn wait_for_ralph_recovery(attempt: usize, is_cancelled: &impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_millis(recovery_delay_ms(attempt));
    while Instant::now() < deadline {
        if is_cancelled() {
            return false;
        }
        thread::sleep(Duration::from_millis(50));
    }
    !is_cancelled()
}

pub(super) fn recovery_run_id(arguments: &[String]) -> Option<String> {
    match arguments.first()?.as_str() {
        "run"
            if arguments
                .get(1)
                .is_some_and(|subject| !subject.trim().is_empty()) =>
        {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .ok()?
                .as_nanos();
            Some(format!(
                "desktop-{}-{timestamp}-{}",
                std::process::id(),
                NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed)
            ))
        }
        "resume" => arguments
            .get(1)
            .filter(|id| !id.trim().is_empty())
            .map(|id| id.trim().to_string()),
        _ => None,
    }
}

pub(super) fn recovery_arguments(arguments: &[String], run_id: &str) -> Vec<String> {
    let mut resumed = vec![
        "resume".to_string(),
        run_id.to_string(),
        "--retry-current".to_string(),
    ];
    let mut options = arguments.iter().skip(2);
    while let Some(option) = options.next() {
        match option.as_str() {
            "--input-json"
            | "--input-json-file"
            | "--instruction-boundary-policy"
            | "--param"
            | "--params-file" => {
                options.next();
            }
            "--retry-current" | "--isolated" => {}
            _ if option.starts_with("--input-json=")
                || option.starts_with("--input-json-file=")
                || option.starts_with("--instruction-boundary-policy=")
                || option.starts_with("--param=")
                || option.starts_with("--params-file=") => {}
            _ => resumed.push(option.clone()),
        }
    }
    resumed
}

pub(super) fn recovery_inspection_arguments(arguments: &[String], run_id: &str) -> Vec<String> {
    let mut inspected = vec!["run-detail".to_string(), run_id.to_string()];
    let mut options = arguments.iter().skip(2);
    while let Some(option) = options.next() {
        if option == "--scope" {
            if let Some(scope) = options.next() {
                inspected.extend([option.clone(), scope.clone()]);
            }
        } else if option.starts_with("--scope=") {
            inspected.push(option.clone());
        }
    }
    inspected
}

pub(super) fn recovery_delay_ms(attempt: usize) -> u64 {
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| (time.as_nanos() % 251) as u64)
        .unwrap_or(0);
    1_000 * attempt as u64 + jitter
}

#[cfg(test)]
mod tests {
    use super::{
        inspect_ralph_saved_run, recovery_arguments, recovery_delay_ms, recovery_run_id,
        supervise_ralph_command, RalphCommandAttempt,
    };
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn fresh_runs_have_distinct_owned_identifiers() {
        let first = recovery_run_id(&args(&["run", "flow"])).unwrap();
        let second = recovery_run_id(&args(&["run", "flow"])).unwrap();
        assert!(first.starts_with(&format!("desktop-{}-", std::process::id())));
        assert_ne!(first, second);
        assert!(!first.contains(['/', '\\']));
    }

    #[test]
    fn resume_preserves_identity_and_other_commands_have_no_recovery() {
        assert_eq!(
            recovery_run_id(&args(&["resume", " saved-run "])).as_deref(),
            Some("saved-run")
        );
        assert_eq!(
            recovery_run_id(&args(&["resume", "saved-run"])).as_deref(),
            Some("saved-run")
        );
        for values in [
            &["snapshot"][..],
            &["run"][..],
            &["run", " "][..],
            &["resume", ""][..],
        ] {
            assert!(recovery_run_id(&args(values)).is_none());
        }
    }

    #[test]
    fn recovery_preserves_runtime_and_limits_without_resubmitting_input() {
        assert_eq!(
            recovery_arguments(
                &args(&[
                    "resume",
                    "saved-run",
                    "--scope",
                    "user",
                    "--model",
                    "model",
                    "--reasoning",
                    "high",
                    "--max-transitions",
                    "50",
                    "--input-json-file",
                    "temporary.json",
                    "--input-json",
                    "{\"answer\":true}",
                    "--instruction-boundary-policy",
                    "new-boundary",
                    "--retry-current",
                ]),
                "saved-run"
            ),
            args(&[
                "resume",
                "saved-run",
                "--retry-current",
                "--scope",
                "user",
                "--model",
                "model",
                "--reasoning",
                "high",
                "--max-transitions",
                "50"
            ])
        );
    }

    #[test]
    fn recovery_uses_finite_backoff() {
        assert!((1_000..=1_250).contains(&recovery_delay_ms(1)));
        assert!((2_000..=2_250).contains(&recovery_delay_ms(2)));
    }

    #[test]
    fn fresh_run_options_are_recovered_from_the_checkpoint() {
        assert_eq!(
            recovery_arguments(
                &args(&[
                    "run",
                    "flow",
                    "--isolated",
                    "--param",
                    "goal=one",
                    "--params-file",
                    "temporary.json",
                    "--param=other=two",
                    "--input-json={\"answer\":true}",
                    "--scope=user"
                ]),
                "saved-run"
            ),
            args(&["resume", "saved-run", "--retry-current", "--scope=user"])
        );
        assert_eq!(
            super::recovery_inspection_arguments(
                &args(&["run", "flow", "--scope=user", "--model", "model"]),
                "saved-run"
            ),
            args(&["run-detail", "saved-run", "--scope=user"])
        );
    }

    #[test]
    fn interrupted_commands_resume_the_same_run_without_a_fresh_start() {
        let mut calls = Vec::new();
        let result = supervise_ralph_command(
            &args(&["run", "flow"]),
            Some("saved-run"),
            || false,
            |arguments, run_id| {
                calls.push((arguments.to_vec(), run_id.unwrap().to_string()));
                if calls.len() == 1 {
                    RalphCommandAttempt {
                        result: Err("process interrupted".to_string()),
                        retry_reason: Some("process interrupted".to_string()),
                        meaningful_transitions: None,
                    }
                } else {
                    RalphCommandAttempt {
                        result: Ok("completed"),
                        retry_reason: None,
                        meaningful_transitions: None,
                    }
                }
            },
            || {},
        );
        assert_eq!(result.unwrap(), "completed");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, args(&["run", "flow"]));
        assert_eq!(
            calls[1].0,
            args(&["resume", &calls[0].1, "--retry-current"])
        );
        assert_eq!(calls[0].1, calls[1].1);
    }

    #[test]
    fn persistent_failure_exhausts_three_attempts_and_retains_each_reason() {
        let mut calls = 0;
        let result: Result<(), _> = supervise_ralph_command(
            &args(&["resume", "saved-run"]),
            Some("saved-run"),
            || false,
            |_, _| {
                calls += 1;
                let reason = format!("failure-{calls}");
                RalphCommandAttempt {
                    result: Err(reason.clone()),
                    retry_reason: Some(reason),
                    meaningful_transitions: None,
                }
            },
            || {},
        );
        let message = result.unwrap_err();
        assert_eq!(calls, 3);
        assert!(message.contains("saved-run"));
        for attempt in 1..=3 {
            assert!(message.contains(&format!("failure-{attempt}")));
        }
    }

    #[test]
    fn cancellation_during_backoff_prevents_another_child() {
        let cancelled = AtomicBool::new(false);
        let mut calls = 0;
        let result: Result<(), _> = supervise_ralph_command(
            &args(&["resume", "saved-run"]),
            Some("saved-run"),
            || cancelled.load(Ordering::SeqCst),
            |_, _| {
                calls += 1;
                RalphCommandAttempt {
                    result: Err("interrupted".to_string()),
                    retry_reason: Some("interrupted".to_string()),
                    meaningful_transitions: None,
                }
            },
            || {
                cancelled.store(true, Ordering::SeqCst);
            },
        );
        assert!(result.is_err());
        assert_eq!(calls, 1);
    }

    #[test]
    fn terminal_outcomes_and_permanent_failures_are_not_retried() {
        let mut calls = 0;
        let result = supervise_ralph_command(
            &args(&["run", "flow"]),
            Some("saved-run"),
            || false,
            |_, _| {
                calls += 1;
                RalphCommandAttempt {
                    result: Ok("waiting-for-input"),
                    retry_reason: None,
                    meaningful_transitions: None,
                }
            },
            || panic!("terminal result must not retry"),
        );
        assert_eq!(result.unwrap(), "waiting-for-input");
        assert_eq!(calls, 1);
        let result: Result<(), _> = supervise_ralph_command(
            &args(&["run", "flow"]),
            Some("saved-run"),
            || false,
            |_, _| RalphCommandAttempt {
                result: Err("foreign owner".to_string()),
                retry_reason: None,
                meaningful_transitions: None,
            },
            || panic!("permanent failure must not retry"),
        );
        assert_eq!(result.unwrap_err(), "foreign owner");
    }

    #[test]
    fn durable_progress_between_interruptions_renews_recovery() {
        let mut calls = 0;
        let result = supervise_ralph_command(
            &args(&["resume", "saved-run"]),
            Some("saved-run"),
            || false,
            |arguments, run_id| {
                calls += 1;
                assert_eq!(run_id, Some("saved-run"));
                if calls > 1 {
                    assert_eq!(arguments, args(&["resume", "saved-run", "--retry-current"]));
                }
                RalphCommandAttempt {
                    result: if calls < 5 {
                        Err("interrupted".to_string())
                    } else {
                        Ok("completed")
                    },
                    retry_reason: (calls < 5).then(|| "interrupted".to_string()),
                    meaningful_transitions: Some(calls),
                }
            },
            || {},
        );
        assert_eq!(result.unwrap(), "completed");
        assert_eq!(calls, 5);
    }

    #[test]
    fn unchanged_missing_or_regressed_progress_does_not_renew_recovery() {
        for progress in [
            [Some(4), Some(4), Some(4)],
            [Some(4), None, Some(4)],
            [Some(4), Some(3), Some(4)],
        ] {
            let mut calls = 0;
            let result: Result<(), _> = supervise_ralph_command(
                &args(&["resume", "saved-run"]),
                Some("saved-run"),
                || false,
                |_, _| {
                    let meaningful_transitions = progress[calls];
                    calls += 1;
                    RalphCommandAttempt {
                        result: Err("interrupted".to_string()),
                        retry_reason: Some("interrupted".to_string()),
                        meaningful_transitions,
                    }
                },
                || {},
            );
            assert!(result.unwrap_err().contains("3 attempts without progress"));
            assert_eq!(calls, 3);
        }
    }

    #[test]
    fn exhaustion_retains_only_failures_since_the_last_progress() {
        let mut calls = 0;
        let result: Result<(), _> = supervise_ralph_command(
            &args(&["resume", "saved-run"]),
            Some("saved-run"),
            || false,
            |_, _| {
                calls += 1;
                let reason = format!("failure-{calls}");
                RalphCommandAttempt {
                    result: Err(reason.clone()),
                    retry_reason: Some(reason),
                    meaningful_transitions: Some(calls.min(4)),
                }
            },
            || {},
        );
        let message = result.unwrap_err();
        assert_eq!(calls, 6);
        for attempt in 1..=3 {
            assert!(!message.contains(&format!("failure-{attempt}")));
        }
        for attempt in 4..=6 {
            assert!(message.contains(&format!("failure-{attempt}")));
        }
    }

    #[test]
    fn interrupted_inspection_retries_until_saved_data_is_available() {
        let mut calls = 0;
        let detail = inspect_ralph_saved_run(
            || false,
            |interrupted| {
                calls += 1;
                if calls < 3 {
                    *interrupted = true;
                    Err(format!("inspection-{calls}"))
                } else {
                    Ok("saved completion")
                }
            },
        );
        assert_eq!(detail.unwrap(), "saved completion");
        assert_eq!(calls, 3);
    }

    #[test]
    fn persistent_inspection_interruption_is_bounded_and_retains_each_reason() {
        let mut calls = 0;
        let detail: Result<(), _> = inspect_ralph_saved_run(
            || false,
            |interrupted| {
                calls += 1;
                *interrupted = true;
                Err(format!("inspection-{calls} {}", "x".repeat(5_000)))
            },
        );
        let reason = detail.unwrap_err();
        assert_eq!(calls, 3);
        assert!(reason.chars().count() <= 12_002);
        for attempt in 1..=3 {
            assert!(reason.contains(&format!("inspection-{attempt}")));
        }
    }

    #[test]
    fn permanent_inspection_failure_is_not_retried() {
        let mut calls = 0;
        let detail: Result<(), _> = inspect_ralph_saved_run(
            || false,
            |_| {
                calls += 1;
                Err("saved run does not exist".to_string())
            },
        );
        assert_eq!(detail.unwrap_err(), "saved run does not exist");
        assert_eq!(calls, 1);
    }

    #[test]
    fn cancellation_prevents_saved_run_inspection() {
        let detail: Result<(), _> = inspect_ralph_saved_run(
            || true,
            |_| panic!("cancelled recovery must not launch an inspection"),
        );
        assert_eq!(detail.unwrap_err(), "The Ralph CLI command was cancelled.");
    }

    #[test]
    fn cancellation_during_inspection_backoff_prevents_another_child() {
        let polls = AtomicUsize::new(0);
        let mut calls = 0;
        let detail: Result<(), _> = inspect_ralph_saved_run(
            || polls.fetch_add(1, Ordering::SeqCst) >= 2,
            |interrupted| {
                calls += 1;
                *interrupted = true;
                Err("inspection interrupted".to_string())
            },
        );
        assert_eq!(detail.unwrap_err(), "The Ralph CLI command was cancelled.");
        assert_eq!(calls, 1);
    }
}
