use serde::{de::Error, Deserialize, Deserializer};
use serde_json::Value;

pub fn valid_speech_invocation(command: &str, args: &Value) -> bool {
    if command != "speech_execute" { return false; }
    let Some(fields) = args.as_object() else { return false; };
    if fields.len() != 3 || fields.keys().any(|key| !["clientId", "disconnectPolicy", "request"].contains(&key.as_str())) { return false; }
    let Some(client_id) = args["clientId"].as_str() else { return false; };
    let probe = serde_json::json!({"kind":"release","id":client_id});
    if !super::operation::valid_request(&probe, |_,_| false)
        || !matches!(args["disconnectPolicy"].as_str(), Some("cancel" | "retain")) { return false; }
    let Some(request) = args["request"].as_object() else { return false; };
    if request.len() != 2 || !request.contains_key("operation") || !request.contains_key("input") || !args["request"]["input"].is_object() { return false; }
    matches!(args["request"]["operation"].as_str(), Some(
        "assist" | "cancelAssistance" | "settings" | "listProfiles" | "listDictionaries" | "dictionaryRevisions" | "archiveReferences" | "listProjects" | "getProject" | "saveProject" | "duplicateProject" |
        "revisions" | "getRevision" | "restoreRevision" | "listVoices" | "getVoice" | "favoriteVoice" | "listFavoriteVoices" | "listVoiceReviews" | "render" | "regenerate" | "compareVoices" | "align" | "getTiming" | "listTimings" | "resolveTimings" |
        "listJobs" | "cancel" | "readAudio" | "listTakes" | "resolveTakes" | "asset" | "readAsset" | "downloadInfo" | "analyzeAudio" | "beginLive" | "appendLive" |
        "findAnswerAudio" | "saveAnswerAudio" | "takeRequest" | "takeProvenance" | "updateTake" | "queue" | "retry" | "retainPlayback" | "releasePlayback" | "heartbeat" | "disconnect" |
        "saveSettings" | "saveProfile" | "deleteProfile" | "saveDictionary" | "deleteProject" | "createVoice" | "deleteVoice" | "updateVoice" | "recordPlaybackMetrics" | "checkVoiceMutation" | "listVoiceMutations" | "designVoice" | "getVoiceWorkflow" | "getDiagnostics" | "importReference" | "importAudioTrack" | "previewTimeline" | "listTemplates" | "saveTemplate" | "deleteTemplate" | "testConnection" | "mediaHandoff" | "export" | "importProject" |
        "beginRecording" | "writeRecording" | "finishRecording" | "cancelRecording" | "trimReference" | "listRecordingUploads" | "listReferences"
    ))
}

pub fn deserialize_speech_request<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Value, D::Error> {
    let value = Value::deserialize(deserializer)?;
    if value["kind"] == "events" || !super::operation::valid_request(&value, valid_speech_invocation) {
        return Err(D::Error::custom("Invalid speech operation."));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn timing_operations_use_the_strict_existing_speech_envelope(){
        let mut args=json!({"clientId":"12345678-1234-4123-8123-123456789abc","disconnectPolicy":"cancel","request":{"operation":"align","input":{}}});
        for operation in ["listFavoriteVoices","listVoiceMutations","checkVoiceMutation","deleteVoice","updateVoice","recordPlaybackMetrics","getRevision","resolveTakes","getDiagnostics","designVoice","createVoice","getVoiceWorkflow","align","regenerate","compareVoices","takeProvenance","listVoiceReviews","dictionaryRevisions","getTiming","listTimings","resolveTimings"]{args["request"]["operation"]=json!(operation);assert!(valid_speech_invocation("speech_execute",&args));}
        args["request"]["operation"]=json!("inventedTiming");assert!(!valid_speech_invocation("speech_execute",&args));
        args["request"]["operation"]=json!("align");args["request"]["secret"]=json!("rejected");assert!(!valid_speech_invocation("speech_execute",&args));
    }

    #[test]
    fn rejects_credentials_and_unscoped_invocations() {
        let mut args = json!({"clientId":"12345678-1234-4123-8123-123456789abc","disconnectPolicy":"cancel","request":{"operation":"render","input":{}}});
        assert!(valid_speech_invocation("speech_execute", &args));
        args["request"]["operation"] = json!("setConnection");
        assert!(!valid_speech_invocation("speech_execute", &args));
        args["request"]["operation"] = json!("settings");
        args["secret"] = json!("must-not-cross-devices");
        assert!(!valid_speech_invocation("speech_execute", &args));
    }
}
