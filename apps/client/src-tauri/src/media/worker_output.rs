use super::MediaResult;
use serde::Deserialize;
use std::{io::Read, sync::mpsc::SyncSender};

#[derive(Deserialize)]
pub(super) struct WorkerProgress {
    pub(super) stage: String,
    pub(super) progress: f64,
}

pub(super) fn drain(
    mut stream: impl Read,
    limit: usize,
    progress: Option<SyncSender<WorkerProgress>>,
) -> MediaResult<Vec<u8>> {
    let mut retained = Vec::new();
    let mut line = Vec::new();
    let mut overflow = false;
    let mut buffer = [0; 8192];
    loop {
        let count = stream
            .read(&mut buffer)
            .map_err(|error| format!("Could not read generation output: {error}"))?;
        if count == 0 {
            break;
        }
        if let Some(sender) = &progress {
            for byte in &buffer[..count] {
                if *byte == b'\n' {
                    if let Some(payload) = line.strip_prefix(b"MACHDOCH_PROGRESS ") {
                        if let Ok(event) = serde_json::from_slice::<WorkerProgress>(payload) {
                            if event.progress.is_finite()
                                && (0.0..=1.0).contains(&event.progress)
                                && event.stage.len() <= 160
                            {
                                let _ = sender.try_send(event);
                            }
                        }
                    }
                    line.clear();
                } else if line.len() < 8192 {
                    line.push(*byte);
                }
            }
        }
        retained.extend_from_slice(&buffer[..count]);
        if retained.len() > limit {
            overflow = true;
            retained.drain(..retained.len() - limit);
        }
    }
    if overflow && progress.is_none() {
        return Err("Generation returned an oversized response".to_string());
    }
    Ok(retained)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn drains_verbose_diagnostics_and_extracts_progress() {
        let (sender, receiver) = std::sync::mpsc::sync_channel(8);
        let mut bytes = vec![b'x'; 512_000];
        bytes.extend_from_slice(
            b"\nMACHDOCH_PROGRESS {\"stage\":\"Sampling 2/8\",\"progress\":0.4}\n",
        );
        let retained = drain(bytes.as_slice(), 256_000, Some(sender)).unwrap();
        assert_eq!(retained.len(), 256_000);
        assert_eq!(receiver.try_recv().unwrap().stage, "Sampling 2/8");
        assert!(drain(vec![0; 1024].as_slice(), 512, None).is_err());
    }
}
