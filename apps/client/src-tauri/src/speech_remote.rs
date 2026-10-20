use std::collections::{HashMap, HashSet};
use std::sync::{Arc,Mutex, OnceLock};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
#[path="speech_remote_assets.rs"]
mod remote_assets;
use remote_assets::VerifiedAsset;

#[path="speech_remote_sessions.rs"]
mod remote_sessions;
use remote_sessions::{Session,expire_session,epoch_session,authorize_take,authorize_playback,complete_session_operation};

static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();
static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn touch(app: &tauri::AppHandle, client: &str, cancel_on_disconnect: bool) -> Result<u64, String> {
    let mut sessions = sessions().lock().map_err(|_| "Remote speech sessions are unavailable.")?;
    if let Some(session) = sessions.get_mut(client) {
        session.touched = Instant::now();
        session.cancel_on_disconnect = cancel_on_disconnect;
        return Ok(session.epoch);
    }
    if sessions.len() >= 128 { return Err("Close an inactive remote speech session and retry.".into()); }
    let epoch = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed);
    sessions.insert(client.to_string(), Session::new(epoch,cancel_on_disconnect));
    let app = app.clone();
    let client = client.to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let policy = {
                let Ok(mut sessions) = self::sessions().lock() else { return; };
                let Some(session) = sessions.get(&client) else { return; };
                if session.epoch != epoch { return; }
                if session.touched.elapsed() < Duration::from_secs(45) { continue; }
                expire_session(&mut sessions, &client, epoch)
            };
            if let Some(session)=policy { retired_cleanup(app.clone(),client.clone(),if session.cancel_on_disconnect{session.jobs}else{HashSet::new()},session.playback_leases); }
            return;
        }
    });
    Ok(epoch)
}

async fn cleanup_retired(app: &tauri::AppHandle, client: &str, ids: &HashSet<String>, leases:&HashSet<String>) -> Result<(), String> {
    let owner = format!("remote:{client}");
    let jobs = if ids.is_empty(){json!([])}else{crate::speech::execute_internal(app, "listJobs", json!({"owner":owner})).await?};
    let mut failures=0;
    for job in jobs.as_array().ok_or("Remote speech job list is invalid.")? {
        if job["id"].as_str().is_some_and(|id|ids.contains(id)) && matches!(job["state"].as_str(), Some("queued" | "running")) {
            if crate::speech::execute_internal(app, "cancel", json!({"jobId":job["id"],"owner":owner})).await.is_err() { failures+=1; }
        }
    }
    for id in leases{if crate::speech::execute_internal(app,"releasePlayback",json!({"id":id,"owner":owner})).await.is_err(){failures+=1;}}
    if failures>0 {Err(format!("{failures} disconnected speech operations could not be released. Cleanup will retry; inspect Jobs on the owning device."))}else{Ok(())}
}

fn retired_cleanup(app: tauri::AppHandle, client:String, jobs:HashSet<String>,leases:HashSet<String>) {
    tauri::async_runtime::spawn(async move {
        let mut delay=Duration::from_millis(250);
        loop {
            match cleanup_retired(&app,&client,&jobs,&leases).await {
                Ok(())=>return,
                Err(message)=>{
                    use tauri::Emitter;
                    if app.emit("machdoch://speech-error",json!({"message":message})).is_err() { eprintln!("Disconnected speech cleanup failed; inspect Jobs on the owning device."); }
                }
            }
            tokio::time::sleep(delay).await;
            delay=(delay*2).min(Duration::from_secs(30));
        }
    });
}

fn grant_assets(value: &Value, assets: &mut HashSet<String>) {
    if value["sha256"].is_string() && value["mimeType"].is_string() {
        if let Some(id) = value["id"].as_str() { assets.insert(id.to_string()); }
    }
    if let Some(ids)=value["referenceAssetIds"].as_array(){for id in ids{if let Some(id)=id.as_str(){assets.insert(id.to_string());}}}
    if let Some(tracks)=value["backgroundTracks"].as_array(){for track in tracks{if let Some(id)=track["assetId"].as_str(){assets.insert(id.to_string());}}}
    match value {
        Value::Object(fields) => for value in fields.values() { grant_assets(value, assets); },
        Value::Array(values) => for value in values { grant_assets(value, assets); },
        _ => {},
    }
}

fn redact_paths(value: &mut Value) {
    match value {
        Value::Object(fields) => {
            if fields.contains_key("sha256") && fields.contains_key("path") {
                fields.insert("path".into(), json!(format!("speech-asset:{}", fields["id"].as_str().unwrap_or_default())));
            }
            for value in fields.values_mut() { redact_paths(value); }
        },
        Value::Array(values) => for value in values { redact_paths(value); },
        _ => {},
    }
}

async fn verified_asset(app:&tauri::AppHandle,client:&str,epoch:u64,id:&str)->Result<Arc<VerifiedAsset>,String>{
    let (cached,download)={
        let sessions=sessions().lock().map_err(|_|"Remote speech sessions are unavailable.")?;
        let session=sessions.get(client).filter(|session|session.epoch==epoch).ok_or("Reconnect this speech session before reading audio.")?;
        (session.verified_assets.get(id).cloned(),session.downloads.get(id).cloned())
    };
    if let Some(asset)=cached{return Ok(asset);}
    let metadata=match download{Some(metadata)=>metadata,None=>crate::speech::execute_internal(app,"asset",json!({"id":id})).await?};
    let asset=Arc::new(tauri::async_runtime::spawn_blocking(move||VerifiedAsset::open(metadata)).await.map_err(|_|"Remote speech asset verification could not finish.")??);
    let mut sessions=sessions().lock().map_err(|_|"Remote speech sessions are unavailable.")?;
    let session=epoch_session(&mut sessions,client,epoch)?;
    if let Some(existing)=session.verified_assets.get(id){return Ok(existing.clone());}
    let used:usize=session.verified_assets.values().map(|asset|asset.fingerprint_bytes()).sum();
    if used+asset.fingerprint_bytes()>8*1024*1024{return Err("Reconnect this speech session before opening more audio assets.".into());}
    session.verified_assets.insert(id.to_string(),asset.clone());
    Ok(asset)
}

async fn execute(app: &tauri::AppHandle, args: &Value) -> Result<Value, String> {
    if !machdoch_fleet_protocol::speech::valid_speech_invocation("speech_execute", args) {
        return Err("Invalid remote speech operation.".into());
    }
    let client = args["clientId"].as_str().ok_or("Choose a remote client session.")?;
    let owner = format!("remote:{client}");
    let epoch=touch(app, client, args["disconnectPolicy"] == "cancel")?;
    let operation = args["request"]["operation"].as_str().ok_or("Choose a speech operation.")?;
    let mut input = args["request"]["input"].clone();
    if operation == "heartbeat" { return Ok(Value::Null); }
    if operation == "disconnect" {
        let retired = sessions().lock().map_err(|_| "Remote speech sessions are unavailable.")?.remove(client);
        if let Some(retired)=retired {let jobs=if retired.cancel_on_disconnect{retired.jobs}else{HashSet::new()};
            if let Err(error)=cleanup_retired(app,client,&jobs,&retired.playback_leases).await {retired_cleanup(app.clone(),client.to_string(),jobs,retired.playback_leases);return Err(error);}
        }
        return Ok(Value::Null);
    }
    if matches!(operation, "recordPlaybackMetrics" | "retainPlayback" | "releasePlayback" | "getDiagnostics" | "designVoice" | "createVoice" | "getVoiceWorkflow" | "findAnswerAudio" | "saveAnswerAudio" | "assist" | "cancelAssistance" | "beginLive" | "appendLive" | "render" | "regenerate" | "compareVoices" | "align" | "listJobs" | "cancel" | "readAudio" | "retry" | "beginRecording" | "writeRecording" | "finishRecording" | "cancelRecording" | "trimReference" | "listRecordingUploads") {
        if input.get("owner").is_some_and(|value| value != &owner) { return Err("Use the requesting client's speech owner.".into()); }
        input["owner"] = json!(owner);
    }
    if operation=="retainPlayback"{let mut sessions=sessions().lock().map_err(|_|"Remote speech sessions are unavailable.")?;authorize_playback(epoch_session(&mut sessions,client,epoch)?,&input)?;}
    if matches!(operation, "cancel" | "readAudio" | "retry" | "appendLive") || operation == "listTakes" && input.get("jobId").is_some() {
        let job_id = input["jobId"].as_str().ok_or("Choose a job owned by this client.")?;
        let jobs = crate::speech::execute_internal(app, "listJobs", json!({"owner":owner,"id":job_id,"limit":1})).await?;
        if !jobs.as_array().is_some_and(|jobs| jobs.iter().any(|job| job["id"] == job_id)) {
            return Err("This client does not own the requested speech job.".into());
        }
    }
    if matches!(operation,"resolveTimings"|"resolveTakes") || operation == "listTakes" && input.get("jobId").is_none() {
        let project_id = input["projectId"].as_str().ok_or("Choose a speech project or a job owned by this client.")?;
        crate::speech::execute_internal(app, "getProject", json!({"id":project_id})).await?;
    }
    if matches!(operation, "updateTake" | "takeRequest" | "takeProvenance" | "align" | "regenerate" | "listTimings") {
        let mut sessions = sessions().lock().map_err(|_| "Remote speech sessions are unavailable.")?;
        authorize_take(epoch_session(&mut sessions, client, epoch)?, operation, &input)?;
    }
    if operation=="createVoice"{
        let mut sessions=sessions().lock().map_err(|_|"Remote speech sessions are unavailable.")?;
        let session=epoch_session(&mut sessions,client,epoch)?;
        for id in input["referenceAssetIds"].as_array().ok_or("Choose saved reference recordings or a design candidate.")?{
            if id.as_str().is_none_or(|id|!session.assets.contains(id)){return Err("Open the reference recordings in this client's speech library before uploading them.".into());}
        }
    }
    if matches!(operation, "asset" | "readAsset" | "downloadInfo" | "analyzeAudio" | "trimReference") {
        let id = input[if matches!(operation, "analyzeAudio" | "trimReference") { "assetId" } else { "id" }].as_str().ok_or("Choose an audio asset.")?;
        if !sessions().lock().map_err(|_| "Remote speech sessions are unavailable.")?.get(client).is_some_and(|session| session.assets.contains(id) || matches!(operation, "downloadInfo" | "readAsset") && session.downloads.contains_key(id)) {
            return Err("Open a take from this client's speech job before reading its audio.".into());
        }
    }
    if operation == "downloadInfo" {
        let id = input["id"].as_str().ok_or("Choose an audio asset or export.")?;
        let asset=verified_asset(app,client,epoch,id).await?;
        return Ok(json!({"id":id,"bytes":asset.metadata["bytes"],"mimeType":asset.metadata["mimeType"],"sha256":asset.metadata["sha256"]}));
    }
    if operation == "readAsset" {
        let offset = input["offset"].as_u64().ok_or("Use a nonnegative audio offset.")?;
        let maximum = input["maxBytes"].as_u64().filter(|value| (1..=65_536).contains(value)).ok_or("Read at most 65,536 audio bytes at once.")?;
        let id = input["id"].as_str().ok_or("Choose an audio asset.")?;
        let asset=verified_asset(app,client,epoch,id).await?;
        let result=asset.read(offset,maximum as usize)?;
        if !sessions().lock().map_err(|_|"Remote speech sessions are unavailable.")?.get(client).is_some_and(|session|session.epoch==epoch){return Err("This speech session ended before its audio read completed.".into());}
        return Ok(result);
    }
    let export_format = if operation == "export" { input["format"].as_str().map(String::from) } else { None };
    let playback_id=if matches!(operation,"retainPlayback"|"releasePlayback"){input["id"].as_str().map(str::to_owned)}else{None};
    let mut result = crate::speech::execute_internal(app, operation, input).await?;
    let completion = {
        let mut sessions = sessions().lock().map_err(|_| "Remote speech sessions are unavailable.")?;
        let completed=complete_session_operation(&mut sessions, client, epoch, operation, &result);
        if completed.is_ok()&&operation=="releasePlayback"{if let Some(id)=&playback_id{epoch_session(&mut sessions,client,epoch)?.playback_leases.remove(id);}}
        completed
    };
    if let Err(error) = completion {
        if matches!(operation, "render" | "retry" | "beginLive" | "align" | "regenerate" | "compareVoices" | "designVoice" | "createVoice") {
            if let Some(id) = result["id"].as_str() {
                retired_cleanup(app.clone(), client.to_string(), HashSet::from([id.to_string()]),HashSet::new());
            }
        }
        if operation=="retainPlayback"{if let Some(id)=playback_id{retired_cleanup(app.clone(),client.to_string(),HashSet::new(),HashSet::from([id]));}}
        return Err(error);
    }
    if let Some(format) = export_format {
        let mime = match format.as_str() { "wav"=>"audio/wav", "mp3"=>"audio/mpeg", "opus"=>"audio/ogg", "flac"=>"audio/flac", "m4b"=>"audio/mp4", "archive"=>"application/zip", "json"=>"application/json", "vtt"=>"text/vtt; charset=utf-8", "srt"|"txt"=>"text/plain; charset=utf-8", _=>return Err("Choose a supported export format.".into()) };
        let id = format!("export-{}", crate::speech::identifier()?);
        let mut download = result.clone();
        download["mimeType"] = json!(mime);
        let mut sessions = sessions().lock().map_err(|_| "Remote speech sessions are unavailable.")?;
        let session = epoch_session(&mut sessions,client,epoch)?;
        if session.downloads.len() >= 128 { return Err("Reconnect this speech session before creating more download links.".into()); }
        session.downloads.insert(id.clone(), download);
        result["path"] = json!(format!("speech-export:{id}"));
        return Ok(result);
    }
    if matches!(operation, "listTakes" | "resolveTakes" | "getVoiceWorkflow" | "importReference" | "importAudioTrack" | "previewTimeline" | "listTemplates" | "saveTemplate" | "getProject" | "saveProject" | "duplicateProject" | "findAnswerAudio" | "saveAnswerAudio" | "importProject" | "finishRecording" | "trimReference" | "listReferences") {
        let mut sessions = sessions().lock().map_err(|_| "Remote speech sessions are unavailable.")?;
        {
            let session=epoch_session(&mut sessions,client,epoch)?;
            if session.assets.len() > 10_000 { return Err("Reconnect this remote speech session before loading more takes.".into()); }
            grant_assets(&result, &mut session.assets);
            if matches!(operation,"listTakes"|"resolveTakes") { if let Some(takes) = result.as_array() { for take in takes { if let Some(id) = take["id"].as_str() { session.takes.insert(id.to_string()); } } } }
        }
    }
    redact_paths(&mut result);
    Ok(result)
}

pub(crate) async fn invoke(app: &tauri::AppHandle, command: &str, args: &Value) -> Result<Value, Value> {
    if command != "speech_execute" { return Err(json!("Unsupported speech command.")); }
    execute(app, args).await.map_err(|message| json!(message))
}
