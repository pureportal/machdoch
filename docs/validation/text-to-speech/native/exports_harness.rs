use std::sync::Mutex;

pub use crate::settings;
pub use crate::{store, analysis, reference_audio};
use crate::store::SpeechStore;

pub struct SpeechService {
    pub store: Mutex<SpeechStore>,
    pub app: crate::TestApp,
}

impl SpeechService {
    pub fn with_store<T>(&self, operation: impl FnOnce(&mut SpeechStore) -> Result<T, String>) -> Result<T, String> {
        let mut store = self.store.lock().map_err(|_| "The test store is poisoned.")?;
        operation(&mut store)
    }
}

pub fn identifier() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| error.to_string())?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

pub fn timestamp() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }

#[path = "../../../../apps/client/src-tauri/src/speech/exports.rs"]
pub mod exports;
#[path = "../../../../apps/client/src-tauri/src/speech/recordings.rs"]
pub mod recordings;
#[path = "../../../../apps/client/src-tauri/src/speech/audio_import.rs"]
pub mod audio_import;
#[path = "../../../../apps/client/src-tauri/src/speech/asset_commit.rs"]
pub mod asset_commit;
#[path = "../../../../apps/client/src-tauri/src/speech/asset_io.rs"]
pub mod asset_io;
#[path = "../../../../apps/client/src-tauri/src/speech/analysis_cache.rs"]
pub mod analysis_cache;

#[cfg(test)]
#[path = "exports_integration_tests.rs"]
mod tests;
