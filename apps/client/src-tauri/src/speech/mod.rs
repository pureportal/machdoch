use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::sync::Notify;

mod fish;
mod fish_request;
mod stream_read;
mod voice_workflow;
mod voice_workflow_transport;
mod voice_workflow_results;
mod voice_metadata;
mod voice_mutation_transport;
mod active_request;
mod sse;
mod pcm_spool;
mod sglang_transport;
mod drama3;
mod drama3_model;
mod voice_jobs;
mod diagnostics;
mod provider_response;
mod jobs;
mod cache;
mod settings;
mod store;
mod asset_commit;
mod asset_io;
mod voices;
mod exports;
mod providers;
mod analysis;
mod admission;
mod contracts;
mod recordings;
mod reference_audio;
mod wave_file;
mod assistance;
mod audio_import;
mod analysis_cache;
mod live_input;
mod live_jobs;
mod transcript_timing;
mod budget;
mod timing_provider;
mod timing_jobs;
mod performance;
mod generation;
mod voice_comparison;
mod assistant_requests;
mod assistant_transport;
mod google_audio;
mod pcm;
mod take_provenance;
mod dictionary_snapshots;
mod job_lifecycle;
mod job_usage;
mod profile_binding;

pub(crate) fn fish_configured() -> bool { settings::credential("fish-cloud").ok().flatten().is_some() }

pub(super) struct SpeechService {
    pub store: Mutex<store::SpeechStore>,
    pub client: Client,
    pub app: tauri::AppHandle,
    pub cancellations: Mutex<HashMap<String, active_request::ActiveRequest>>,
    pub stream_files: Mutex<HashMap<String, stream_read::StreamFile>>,
    pub wake: Notify,
}

impl SpeechService {
    pub fn with_store<T>(&self, operation: impl FnOnce(&mut store::SpeechStore) -> Result<T, String>) -> Result<T, String> {
        operation(&mut *self.store.lock().map_err(|_| "Speech storage is unavailable. Restart the application.".to_string())?)
    }
    pub fn emit(&self, job: &Value) {
        let sequence = self.with_store(|store| {
            store.connection.execute("INSERT INTO speech_events(owner,job_id,data) VALUES(?1,?2,?3)", rusqlite::params![job["owner"].as_str(),job["id"].as_str(),job.to_string()]).map_err(|_| "Speech job event could not be recorded.")?;
            let sequence = store.connection.last_insert_rowid();
            store.connection.execute("DELETE FROM speech_events WHERE sequence<=?1", [sequence-10_000]).map_err(|_| "Speech event retention could not be applied.")?;
            Ok(sequence)
        });
        match sequence {
            Ok(sequence) => if self.app.emit("machdoch://speech-job", &json!({"owner":job["owner"],"sessionId":job["owner"],"jobId":job["id"],"sequence":sequence,"kind":"job","data":job})).is_err() { eprintln!("Speech job event delivery failed; inspect Jobs for current state."); },
            Err(message) => if self.app.emit("machdoch://speech-error", &json!({"jobId":job["id"],"message":message})).is_err() { eprintln!("Speech event storage and delivery failed; inspect Jobs for current state."); },
        }
    }
}

static SERVICE: OnceLock<Result<Arc<SpeechService>, String>> = OnceLock::new();
static ANALYSIS_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

fn service(app: &tauri::AppHandle) -> Result<Arc<SpeechService>, String> {
    SERVICE.get_or_init(|| {
        let root = app.path().app_data_dir().map_err(|_| "Speech storage location is unavailable.".to_string())?.join("speech");
        let mut store = store::SpeechStore::open(root)?;
        let profiles = store.execute("listProfiles", &json!({}))?;
        for (backend, model, voice) in [("drama3","drama-3",""),("openai","gpt-4o-mini-tts","cedar"),("google","gemini-3.1-flash-tts-preview","Kore")] {
            let id = format!("default-{backend}");
            if !profiles.as_array().ok_or("Invalid profile store")?.iter().any(|profile| profile["id"] == id) {
                store.execute("saveProfile", &json!({"profile":{"id":id,"name":if backend=="drama3" {"Drama 3 · Local".to_string()} else {format!("{} assistant",if backend=="openai" {"OpenAI"} else {"Google"})},"backend":backend,"model":model,"voiceId":voice,"direction":"","temperature":0.7,"topP":0.7,"chunkLength":300,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"playbackRate":1.0}}))?;
            }
        }
        let service = Arc::new(SpeechService { store:Mutex::new(store),client:Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(std::time::Duration::from_secs(30)).build().map_err(|_| "Speech network client could not be created.".to_string())?,app:app.clone(),cancellations:Mutex::new(HashMap::new()),stream_files:Mutex::new(HashMap::new()),wake:Notify::new() });
        let dispatcher = service.clone();
        tauri::async_runtime::spawn(async move { jobs::dispatch(dispatcher).await; });
        service.wake.notify_one();
        Ok(service)
    }).clone()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SpeechRequest { operation: String, input: Value }

#[tauri::command]
pub async fn speech_execute(app: tauri::AppHandle, window: tauri::WebviewWindow, request: SpeechRequest) -> Result<Value, String> {
    if !matches!(window.label(), "main" | "quick-voice" | "assistant") { return Err("This window cannot access speech projects.".to_string()); }
    execute_internal(&app, &request.operation, request.input).await
}

pub(crate) async fn execute_internal(app: &tauri::AppHandle, operation: &str, input: Value) -> Result<Value, String> {
    let request = SpeechRequest { operation: operation.to_string(), input };
    let service = service(&app)?;
    let result = match request.operation.as_str() {
        "assist" | "cancelAssistance" => assistance::execute(app, &request.operation, &request.input).await,
        "beginRecording" | "writeRecording" | "finishRecording" | "cancelRecording" | "trimReference" | "listRecordingUploads" | "listReferences" => recordings::execute(&service, &request.operation, &request.input),
        "queue" => {
            let state = service.with_store(|store| store.execute("queue", &request.input))?;
            service.wake.notify_one();
            Ok(state)
        },
        "render" => jobs::submit(&service, request.input),
        "regenerate" => jobs::regenerate(&service,request.input),
        "compareVoices" => jobs::compare_voices(&service,request.input),
        operation @ ("designVoice" | "createVoice") => voice_jobs::submit(&service,operation,request.input),
        "getVoiceWorkflow" => service.with_store(|store|voice_workflow::result(store,&request.input)),
        "getDiagnostics" => service.with_store(|store|{let settings=settings::settings(store)?;diagnostics::collect(store,&settings,&request.input,env!("CARGO_PKG_VERSION"),&timestamp())}),
        "beginLive" => live_jobs::begin(&service,request.input),
        "appendLive" => service.with_store(|store|live_input::append(store,&request.input)),
        "retry" => jobs::retry(&service, &request.input).await,
        "align" => timing_jobs::submit(&service,request.input).await,
        "cancel" => jobs::cancel(&service, &request.input),
        "readAudio" => jobs::read_audio(&service, &request.input),
        "asset" => {
            let id=request.input["id"].as_str().ok_or("Choose an audio asset.")?;
            Ok(asset_io::open(&service,id,None)?.asset.clone())
        },
        "analyzeAudio" => {
            let reuse_cache=match request.input.get("reuseCache"){None=>true,Some(value)=>value.as_bool().ok_or("Choose whether to reuse the audio analysis cache.")?};
            let _slot = ANALYSIS_SLOTS.acquire().await.map_err(|_| "Speech analysis is unavailable.")?;
            let reader=asset_io::open(&service,request.input["assetId"].as_str().ok_or("Choose an audio asset.")?,None)?;
            let path=reader.path.clone();
            let buckets = request.input["buckets"].as_u64().filter(|value| (1..=4096).contains(value)).ok_or("Use 1 to 4,096 waveform buckets.")? as usize;
            let encoder = exports::encoder()?;
            let asset_id = request.input["assetId"].as_str().ok_or("Choose an audio asset.")?;
            let encoder_digest=exports::hash_file(&encoder)?;
            let cache = service.with_store(|store| { let directory = store.root.join("analysis");std::fs::create_dir_all(&directory).map_err(|_|"Audio analysis cache could not be opened.")?;Ok(directory.join(format!("{asset_id}-{buckets}-v3-{encoder_digest}.json"))) })?;
            if reuse_cache&&cache.exists() {
                let value = analysis_cache::read(&cache)?;
                return Ok(value);
            }
            let analysis_path = path.clone();
            let mut measured = tauri::async_runtime::spawn_blocking(move || analysis::analyze(&analysis_path,buckets)).await.map_err(|_| "Speech audio analysis could not finish.".to_string())??;
            measured["loudness"] = analysis::loudness(&path,&encoder).await?;
            analysis_cache::write(&cache,&measured)?;
            Ok(measured)
        },
        operation @ ("runtimeModelStatus" | "runtimeInstallModel" | "runtimeCancelDownload" | "runtimeRemoveModel") => drama3_model::execute(operation, &request.input),
        "settings" => service.with_store(|store| settings::settings(store)),
        "saveSettings" => service.with_store(|store| settings::save_settings(store, &request.input["settings"])),
        "setConnection" => service.with_store(|store| settings::set_connection(store, &request.input)),
        "testConnection" => providers::test_connection(&service, &request.input).await,
        "listVoices" | "getVoice" | "deleteVoice" | "updateVoice" | "checkVoiceMutation" | "favoriteVoice" => voices::execute(&service, &request.operation, request.input).await,
        "importReference" => providers::import_reference(&service, &request.input),
        "importAudioTrack" => audio_import::import(&service,&request.input).await,
        "export" | "previewTimeline" | "importProject" | "mediaHandoff" => exports::execute(&service, &request.operation, &request.input).await,
        operation => {
            service.with_store(|store| store.execute(operation, &request.input))
        }
    }?;
    allow_assets(&app,&result)?;
    Ok(result)
}

fn allow_assets(app: &tauri::AppHandle, value: &Value) -> Result<(), String> {
    if let Some(path) = value.get("path").and_then(Value::as_str) {
        if value.get("sha256").and_then(Value::as_str).is_some() { app.asset_protocol_scope().allow_file(PathBuf::from(path)).map_err(|_| "Speech playback access could not be granted.".to_string())?; }
    }
    match value {
        Value::Array(values) => for value in values { allow_assets(app, value)?; },
        Value::Object(values) => for value in values.values() { if value.is_object() || value.is_array() { allow_assets(app, value)?; } },
        _ => {},
    }
    Ok(())
}

pub(super) fn identifier() -> Result<String,String> {
    let mut bytes = [0u8;16]; getrandom::fill(&mut bytes).map_err(|_| "Speech identifier could not be created.".to_string())?;
    Ok(bytes.iter().map(|byte|format!("{byte:02x}")).collect())
}
pub(super) fn timestamp() -> String { chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true) }
