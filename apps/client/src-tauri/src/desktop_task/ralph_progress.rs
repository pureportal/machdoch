use std::collections::VecDeque;

use serde::Serialize;
use serde_json::Value;

const MAX_PROGRESS_EVENTS: usize = 160;
const MAX_PROGRESS_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RalphTaskProgressEvent {
    timestamp: u64,
    progress: Value,
}

#[derive(Default)]
pub(super) struct RalphTaskProgress {
    events: VecDeque<(RalphTaskProgressEvent, usize)>,
    retained_bytes: usize,
    last_timestamp: u64,
}

impl RalphTaskProgress {
    pub(super) fn record(&mut self, progress: &Value, timestamp: u64) -> u64 {
        let timestamp = timestamp.max(self.last_timestamp.saturating_add(1));
        self.last_timestamp = timestamp;
        let bytes = progress.to_string().len();
        if bytes > MAX_PROGRESS_BYTES {
            return timestamp;
        }
        while self.events.len() >= MAX_PROGRESS_EVENTS
            || self.retained_bytes + bytes > MAX_PROGRESS_BYTES
        {
            let Some((_, removed_bytes)) = self.events.pop_front() else {
                break;
            };
            self.retained_bytes -= removed_bytes;
        }
        self.events.push_back((
            RalphTaskProgressEvent {
                timestamp,
                progress: progress.clone(),
            },
            bytes,
        ));
        self.retained_bytes += bytes;
        timestamp
    }

    pub(super) fn snapshot(&self) -> Vec<RalphTaskProgressEvent> {
        self.events.iter().map(|(event, _)| event.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{RalphTaskProgress, MAX_PROGRESS_BYTES, MAX_PROGRESS_EVENTS};

    #[test]
    fn snapshots_preserve_order_when_events_share_a_clock_tick() {
        let mut progress = RalphTaskProgress::default();
        assert_eq!(progress.record(&json!({"block": "start"}), 10), 10);
        assert_eq!(progress.record(&json!({"block": "prompt"}), 10), 11);
        let snapshot = progress.snapshot();
        assert_eq!(snapshot[0].timestamp, 10);
        assert_eq!(snapshot[1].timestamp, 11);
        assert_eq!(snapshot[1].progress["block"], "prompt");
    }

    #[test]
    fn snapshots_bound_event_count_and_bytes_while_retaining_newest_progress() {
        let mut progress = RalphTaskProgress::default();
        for index in 0..MAX_PROGRESS_EVENTS + 10 {
            progress.record(&json!({"index": index}), index as u64);
        }
        assert_eq!(progress.snapshot().len(), MAX_PROGRESS_EVENTS);
        let large = json!({"content": "x".repeat(MAX_PROGRESS_BYTES / 2)});
        progress.record(&large, 1000);
        progress.record(&large, 1001);
        assert_eq!(progress.snapshot().len(), 1);
        assert!(progress.retained_bytes <= MAX_PROGRESS_BYTES);
        assert_eq!(progress.snapshot()[0].timestamp, 1001);
        progress.record(&json!({"content": "x".repeat(MAX_PROGRESS_BYTES)}), 1002);
        assert_eq!(progress.snapshot()[0].timestamp, 1001);
    }
}
