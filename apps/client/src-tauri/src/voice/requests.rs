use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};

use tokio_util::sync::CancellationToken;

struct RequestEntry {
    id: String,
    cancellation: CancellationToken,
    running: bool,
}

static REQUESTS: OnceLock<Mutex<HashMap<String, RequestEntry>>> = OnceLock::new();

fn requests() -> &'static Mutex<HashMap<String, RequestEntry>> {
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn begin(owner: &str, id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Invalid speech transcription request.".to_string());
    }
    let mut requests = requests()
        .lock()
        .map_err(|_| "Speech transcription is unavailable.".to_string())?;
    if requests.get(owner).is_some_and(|entry| entry.id == id) {
        return Err("Speech transcription request already exists.".to_string());
    }
    if let Some(previous) = requests.insert(
        owner.to_string(),
        RequestEntry {
            id: id.to_string(),
            cancellation: CancellationToken::new(),
            running: false,
        },
    ) {
        previous.cancellation.cancel();
    }
    Ok(())
}

pub(super) fn cancel(owner: &str, id: &str) -> Result<(), String> {
    let mut requests = requests()
        .lock()
        .map_err(|_| "Speech transcription is unavailable.".to_string())?;
    if requests.get(owner).is_some_and(|entry| entry.id == id) {
        if let Some(entry) = requests.remove(owner) {
            entry.cancellation.cancel();
        }
    }
    Ok(())
}

pub(super) struct SpeechRequest {
    owner: String,
    id: String,
    pub cancellation: CancellationToken,
}

impl SpeechRequest {
    pub fn acquire(owner: &str, id: &str) -> Result<Self, String> {
        let mut requests = requests()
            .lock()
            .map_err(|_| "Speech transcription is unavailable.".to_string())?;
        let entry = requests
            .get_mut(owner)
            .filter(|entry| entry.id == id && !entry.running)
            .ok_or_else(|| "Speech transcription was cancelled.".to_string())?;
        entry.running = true;
        Ok(Self {
            owner: owner.to_string(),
            id: id.to_string(),
            cancellation: entry.cancellation.clone(),
        })
    }
}

impl Drop for SpeechRequest {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Err(error) = cancel(&self.owner, &self.id) {
            eprintln!("Could not release speech transcription: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_inference_prevents_starting() {
        begin("cancel-before-start", "request").unwrap();
        cancel("cancel-before-start", "request").unwrap();
        assert!(SpeechRequest::acquire("cancel-before-start", "request").is_err());
    }

    #[test]
    fn cancellation_is_scoped_to_window_and_request() {
        begin("window-a", "request").unwrap();
        begin("window-b", "request").unwrap();
        let a = SpeechRequest::acquire("window-a", "request").unwrap();
        let b = SpeechRequest::acquire("window-b", "request").unwrap();
        cancel("window-a", "old-request").unwrap();
        assert!(!a.cancellation.is_cancelled());
        cancel("window-a", "request").unwrap();
        assert!(a.cancellation.is_cancelled());
        assert!(!b.cancellation.is_cancelled());
    }

    #[test]
    fn old_completion_does_not_cancel_a_new_recording() {
        begin("restart", "first").unwrap();
        let first = SpeechRequest::acquire("restart", "first").unwrap();
        assert!(SpeechRequest::acquire("restart", "first").is_err());
        begin("restart", "second").unwrap();
        assert!(first.cancellation.is_cancelled());
        drop(first);
        let second = SpeechRequest::acquire("restart", "second").unwrap();
        assert!(!second.cancellation.is_cancelled());
        let cancellation = second.cancellation.clone();
        drop(second);
        assert!(cancellation.is_cancelled());
        assert!(SpeechRequest::acquire("restart", "second").is_err());
    }
}
