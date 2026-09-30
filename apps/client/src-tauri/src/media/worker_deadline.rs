use std::time::{Duration, Instant};

use super::worker_output::WorkerProgress;

pub(super) struct WorkerDeadline {
    timeout: Duration,
    tracks_progress: bool,
    last_activity: Instant,
    last_progress: Option<(String, f64)>,
}

impl WorkerDeadline {
    pub(super) fn new(command: &str, timeout: Duration, started: Instant) -> Self {
        Self {
            timeout,
            tracks_progress: matches!(command, "generate" | "generate-video"),
            last_activity: started,
            last_progress: None,
        }
    }

    pub(super) fn record_progress(&mut self, event: &WorkerProgress, now: Instant) {
        if !self.tracks_progress {
            return;
        }
        let advances = self
            .last_progress
            .as_ref()
            .is_none_or(|(stage, progress)| stage != &event.stage || event.progress > *progress);
        if advances {
            self.last_activity = now;
            self.last_progress = Some((event.stage.clone(), event.progress));
        }
    }

    pub(super) fn expired(&self, now: Instant) -> bool {
        now.duration_since(self.last_activity) >= self.timeout
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_continues_while_progress_advances_past_the_initial_deadline() {
        for command in ["generate", "generate-video"] {
            let started = Instant::now();
            let mut deadline = WorkerDeadline::new(command, Duration::from_secs(30), started);
            for step in 1..=12 {
                let now = started + Duration::from_secs(step * 20);
                assert!(!deadline.expired(now));
                deadline.record_progress(
                    &WorkerProgress {
                        stage: "Sampling".into(),
                        progress: step as f64 / 12.0,
                    },
                    now,
                );
            }
            assert!(deadline.expired(started + Duration::from_secs(270)));
        }
    }

    #[test]
    fn repeated_or_regressing_progress_does_not_extend_the_deadline() {
        let started = Instant::now();
        let mut deadline = WorkerDeadline::new("generate", Duration::from_secs(30), started);
        for (seconds, progress) in [(5, 0.2), (20, 0.2), (30, 0.1)] {
            deadline.record_progress(
                &WorkerProgress {
                    stage: "Loading image model".into(),
                    progress,
                },
                started + Duration::from_secs(seconds),
            );
        }
        assert!(deadline.expired(started + Duration::from_secs(35)));
    }

    #[test]
    fn stage_changes_and_later_images_extend_the_deadline() {
        let started = Instant::now();
        let mut deadline = WorkerDeadline::new("generate", Duration::from_secs(30), started);
        for (seconds, stage, progress) in [
            (20, "Loading image model", 0.08),
            (40, "Preparing image", 0.08),
            (60, "Sampling 1/12", 0.3),
            (80, "Saving image", 0.9),
            (100, "Sampling 1/12", 0.6),
        ] {
            let now = started + Duration::from_secs(seconds);
            assert!(!deadline.expired(now));
            deadline.record_progress(
                &WorkerProgress {
                    stage: stage.into(),
                    progress,
                },
                now,
            );
        }
        assert!(!deadline.expired(started + Duration::from_secs(120)));
        assert!(deadline.expired(started + Duration::from_secs(130)));
    }

    #[test]
    fn missing_progress_and_other_commands_keep_the_original_deadline() {
        for command in ["generate", "probe", "probe-model", "memory", "canny"] {
            let started = Instant::now();
            let mut deadline = WorkerDeadline::new(command, Duration::from_secs(30), started);
            if command != "generate" {
                deadline.record_progress(
                    &WorkerProgress {
                        stage: "Loading".into(),
                        progress: 0.5,
                    },
                    started + Duration::from_secs(20),
                );
            }
            assert!(!deadline.expired(started + Duration::from_secs(29)));
            assert!(deadline.expired(started + Duration::from_secs(30)));
        }
    }
}
