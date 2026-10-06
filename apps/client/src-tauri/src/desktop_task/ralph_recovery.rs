use std::{
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub(super) const RALPH_RUN_ID_ENV: &str = "MACHDOCH_RALPH_RUN_ID";
pub(super) const RALPH_MAX_COMMAND_ATTEMPTS: usize = 3;
static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(0);

pub(super) struct RalphCommandAttempt<T> {
    pub result: Result<T, String>,
    pub retry_reason: Option<String>,
}

pub(super) fn supervise_ralph_command<T>(
    original_arguments: &[String],
    is_cancelled: impl Fn() -> bool,
    mut execute: impl FnMut(&[String], Option<&str>) -> RalphCommandAttempt<T>,
    mut notify_recovery: impl FnMut(),
) -> Result<T, String> {
    if is_cancelled() {
        return Err("The Ralph CLI command was cancelled.".to_string());
    }
    let run_id = recovery_run_id(original_arguments);
    let mut arguments = original_arguments.to_vec();
    let mut failures = Vec::new();
    for attempt in 1..=RALPH_MAX_COMMAND_ATTEMPTS {
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
        failures.push(reason.chars().take(4_000).collect::<String>());
        if attempt == RALPH_MAX_COMMAND_ATTEMPTS {
            return Err(format!(
                "Ralph run {} could not recover after {attempt} attempts. {}",
                run_id.as_deref().unwrap_or_default(),
                failures.join("\n")
            ));
        }
        notify_recovery();
        let deadline = Instant::now() + Duration::from_millis(recovery_delay_ms(attempt));
        while Instant::now() < deadline {
            if is_cancelled() {
                return outcome.result;
            }
            thread::sleep(Duration::from_millis(50));
        }
        arguments = recovery_arguments(original_arguments, run_id.as_deref().unwrap_or_default());
    }
    unreachable!()
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
        recovery_arguments, recovery_delay_ms, recovery_run_id, supervise_ralph_command,
        RalphCommandAttempt,
    };
    use std::sync::atomic::{AtomicBool, Ordering};

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
            || false,
            |arguments, run_id| {
                calls.push((arguments.to_vec(), run_id.unwrap().to_string()));
                if calls.len() == 1 {
                    RalphCommandAttempt {
                        result: Err("process interrupted".to_string()),
                        retry_reason: Some("process interrupted".to_string()),
                    }
                } else {
                    RalphCommandAttempt {
                        result: Ok("completed"),
                        retry_reason: None,
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
            || false,
            |_, _| {
                calls += 1;
                let reason = format!("failure-{calls}");
                RalphCommandAttempt {
                    result: Err(reason.clone()),
                    retry_reason: Some(reason),
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
            || cancelled.load(Ordering::SeqCst),
            |_, _| {
                calls += 1;
                RalphCommandAttempt {
                    result: Err("interrupted".to_string()),
                    retry_reason: Some("interrupted".to_string()),
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
            || false,
            |_, _| {
                calls += 1;
                RalphCommandAttempt {
                    result: Ok("waiting-for-input"),
                    retry_reason: None,
                }
            },
            || panic!("terminal result must not retry"),
        );
        assert_eq!(result.unwrap(), "waiting-for-input");
        assert_eq!(calls, 1);
        let result: Result<(), _> = supervise_ralph_command(
            &args(&["run", "flow"]),
            || false,
            |_, _| RalphCommandAttempt {
                result: Err("foreign owner".to_string()),
                retry_reason: None,
            },
            || panic!("permanent failure must not retry"),
        );
        assert_eq!(result.unwrap_err(), "foreign owner");
    }
}
