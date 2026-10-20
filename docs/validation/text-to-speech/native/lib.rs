#[path = "../../../../apps/client/src-tauri/src/speech/store.rs"]
pub mod store;
#[path = "../../../../apps/client/src-tauri/src/speech/fish.rs"]
pub mod fish;
#[path = "../../../../apps/client/src-tauri/src/speech/fish_request.rs"]
pub mod fish_request;
#[path = "../../../../apps/client/src-tauri/src/speech/stream_read.rs"]
pub mod stream_read;
#[path = "../../../../apps/client/src-tauri/src/speech/voice_workflow.rs"]
pub mod voice_workflow;
#[path = "../../../../apps/client/src-tauri/src/speech/voice_workflow_transport.rs"]
pub mod voice_workflow_transport;
#[path = "../../../../apps/client/src-tauri/src/speech/voice_workflow_results.rs"]
pub mod voice_workflow_results;
#[path = "../../../../apps/client/src-tauri/src/speech/voice_metadata.rs"]
pub mod voice_metadata;
#[path = "../../../../apps/client/src-tauri/src/speech/voice_mutation_transport.rs"]
pub mod voice_mutation_transport;
#[path = "../../../../apps/client/src-tauri/src/speech/active_request.rs"]
pub mod active_request;
#[path = "../../../../apps/client/src-tauri/src/speech/sse.rs"]
pub mod sse;
#[path = "../../../../apps/client/src-tauri/src/speech/pcm_spool.rs"]
pub mod pcm_spool;
#[path = "../../../../apps/client/src-tauri/src/speech/sglang_transport.rs"]
pub mod sglang_transport;
#[path = "../../../../apps/client/src-tauri/src/speech/drama3_model.rs"]
pub mod drama3_model;
#[path = "../../../../apps/client/src-tauri/src/speech/diagnostics.rs"]
pub mod diagnostics;
#[path = "../../../../apps/client/src-tauri/src/speech/provider_response.rs"]
pub mod provider_response;
#[path = "../../../../apps/client/src-tauri/src/speech/analysis.rs"]
pub mod analysis;
#[path = "../../../../apps/client/src-tauri/src/speech/settings.rs"]
pub mod settings;
#[path = "../../../../apps/client/src-tauri/src/speech/cache.rs"]
pub mod cache;
#[path = "../../../../apps/client/src-tauri/src/speech/export_text.rs"]
pub mod export_text;
#[path = "../../../../apps/client/src-tauri/src/speech/contracts.rs"]
pub mod contracts;
#[path = "../../../../apps/client/src-tauri/src/speech/admission.rs"]
pub mod admission;
#[path = "../../../../apps/client/src-tauri/src/speech/performance.rs"]
pub mod performance;
#[path = "../../../../apps/client/src-tauri/src/speech/generation.rs"]
pub mod generation;
#[path = "../../../../apps/client/src-tauri/src/speech/voice_comparison.rs"]
pub mod voice_comparison;
#[path = "../../../../apps/client/src-tauri/src/speech/assistant_requests.rs"]
pub mod assistant_requests;
#[path = "../../../../apps/client/src-tauri/src/speech/assistant_transport.rs"]
pub mod assistant_transport;
#[path = "../../../../apps/client/src-tauri/src/speech/google_audio.rs"]
pub mod google_audio;
#[path = "../../../../apps/client/src-tauri/src/speech/pcm.rs"]
pub mod pcm;
#[path = "../../../../apps/client/src-tauri/src/speech/take_provenance.rs"]
pub mod take_provenance;
#[path = "../../../../apps/client/src-tauri/src/speech/dictionary_snapshots.rs"]
pub mod dictionary_snapshots;
#[path = "../../../../apps/client/src-tauri/src/speech/live_input.rs"]
pub mod live_input;
#[path = "../../../../apps/client/src-tauri/src/speech/transcript_timing.rs"]
pub mod transcript_timing;
#[path = "../../../../apps/client/src-tauri/src/speech/budget.rs"]
pub mod budget;
#[path = "../../../../apps/client/src-tauri/src/speech/job_lifecycle.rs"]
pub mod job_lifecycle;
#[path = "../../../../apps/client/src-tauri/src/speech/job_usage.rs"]
pub mod job_usage;
#[path = "../../../../apps/client/src-tauri/src/speech/profile_binding.rs"]
pub mod profile_binding;
#[path = "../../../../apps/client/src-tauri/src/speech_error.rs"]
pub mod speech_error;
#[path = "../../../../apps/client/src-tauri/src/speech/timing_provider.rs"]
pub mod timing_provider;
#[path = "../../../../apps/client/src-tauri/src/speech/reference_audio.rs"]
pub mod reference_audio;
#[path = "../../../../apps/client/src-tauri/src/speech/wave_file.rs"]
pub mod wave_file;
#[path = "../../../../apps/client/src-tauri/src/speech_remote_assets.rs"]
pub mod remote_assets;
#[path = "../../../../apps/client/src-tauri/src/speech_remote_sessions.rs"]
pub mod remote_sessions;
#[path = "../../../../apps/client/src-tauri/src/storage_space.rs"]
pub mod storage_space;
#[path = "exports_harness.rs"]
pub mod speech;
pub use speech::{identifier, timestamp};

pub struct TestApp;

mod media {
    pub async fn import_speech_asset(_: &super::TestApp, _: &serde_json::Value, _: &str) -> Result<String, String> {
        Err("The focused export fixture does not provide Media Studio.".into())
    }
}

mod runtime_snapshot {
    pub fn load_global_env() -> Result<std::collections::HashMap<String, String>, String> {
        panic!("Credential access is prohibited in the focused settings-validation harness")
    }

    pub fn save_shared_speech_key(_: &str, _: Option<&str>) -> Result<(), String> {
        panic!("Credential mutation is prohibited in the focused settings-validation harness")
    }
}
