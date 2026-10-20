use super::{identifier, timestamp, SpeechService};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::params;
use serde_json::{json, Value};
use std::io::Write;
use std::sync::Arc;

const MAX_RECORDING_BYTES: u64 = 16 * 1024 * 1024;

#[path="recording_audio.rs"]
mod audio;

fn owner(input: &Value) -> Result<&str, String> {
    input["owner"].as_str().filter(|value| !value.is_empty() && value.len() <= 512 && !value.chars().any(char::is_control)).ok_or("Choose an owning speech session.".into())
}

fn upload(store: &super::store::SpeechStore, input: &Value) -> Result<Value, String> {
    let owner = owner(input)?;
    let id = input["id"].as_str().ok_or("Choose a recording upload.")?;
    let value: String = store.connection.query_row("SELECT data FROM speech_recording_uploads WHERE id=?1 AND owner=?2", params![id,owner], |row| row.get(0)).map_err(|_| "This recording upload is unavailable to this session.")?;
    let data: Value = serde_json::from_str(&value).map_err(|_| "The recording upload metadata is damaged.")?;
    if data["id"] != id || id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) || data["owner"] != owner || data["bytes"].as_u64().is_none_or(|value| value > MAX_RECORDING_BYTES || value < 44) || data["offset"].as_u64().is_none_or(|value| value > data["bytes"].as_u64().unwrap_or(0)) {
        return Err("The recording upload metadata is damaged. Cancel it and start a new import.".into());
    }
    let finishing:bool=store.connection.query_row("SELECT EXISTS(SELECT 1 FROM speech_recording_claims WHERE upload_id=?1 AND julianday(expires_at)>julianday(?2))",params![id,timestamp()],|row|row.get(0)).map_err(|_|"The recording import state could not be read.")?;
    if finishing { return Err("This recording is being imported. Wait for it to finish before writing or cancelling it.".into()); }
    Ok(data)
}

pub fn execute(service: &Arc<SpeechService>, operation: &str, input: &Value) -> Result<Value, String> {
    if operation=="finishRecording" { return audio::finish(service,input); }
    if operation=="trimReference" { return audio::trim(service,input); }
    service.with_store(|store| {
        match operation {
            "listReferences" => {
                let offset = input["offset"].as_i64().filter(|value| *value >= 0).ok_or("Use a nonnegative recording offset within the supported range.")?;
                let limit = input["limit"].as_i64().filter(|value| (1..=100).contains(value)).ok_or("Request 1 to 100 saved recordings.")?;
                let total: i64 = store.connection.query_row("SELECT count(*) FROM speech_references", [], |row| row.get(0)).map_err(|_| "The saved recording count is unavailable.")?;
                let records = {
                    let mut statement = store.connection.prepare("SELECT asset_id,transcript,rights FROM speech_references ORDER BY asset_id LIMIT ?1 OFFSET ?2").map_err(|_| "Saved recordings could not be opened.")?;
                    let rows = statement.query_map(params![limit,offset], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,String>(2)?))).map_err(|_| "Saved recordings could not be read.")?;
                    rows.collect::<Result<Vec<_>,_>>().map_err(|_| "A saved recording could not be read.")?
                };
                let mut references = Vec::new();
                for (id, transcript, rights) in records { references.push(json!({"asset":store.execute("asset",&json!({"id":id}))?,"transcript":transcript,"rightsEvidence":rights})); }
                Ok(json!({"references":references,"total":total}))
            },
            "listRecordingUploads" => {
                let mut statement = store.connection.prepare("SELECT data FROM speech_recording_uploads WHERE owner=?1 ORDER BY id").map_err(|_| "Pending recordings could not be opened.")?;
                let rows = statement.query_map([owner(input)?], |row| row.get::<_,String>(0)).map_err(|_| "Pending recordings could not be read.")?;
                let mut result = Vec::new();
                for row in rows { result.push(serde_json::from_str::<Value>(&row.map_err(|_| "A pending recording could not be read.")?).map_err(|_| "A pending recording is damaged.")?); }
                Ok(json!(result))
            },
            "beginRecording" => {
                let owner = owner(input)?;
                let bytes = input["bytes"].as_u64().filter(|value| (44..=MAX_RECORDING_BYTES).contains(value)).ok_or("Choose a WAV recording below the local 16 MiB reference guard.")?;
                let hash = input["sha256"].as_str().filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())).ok_or("Include the recording's SHA-256 digest.")?;
                let transcript = input["transcript"].as_str().filter(|value| !value.trim().is_empty() && value.len() <= 65_536).ok_or("Enter an accurate reference transcript.")?;
                let rights = input["rightsEvidence"].as_str().filter(|value| !value.trim().is_empty() && value.len() <= 32_768).ok_or("Record the voice owner's permission or applicable rights.")?;
                let pending: i64 = store.connection.query_row("SELECT count(*) FROM speech_recording_uploads", [], |row| row.get(0)).map_err(|_| "Recording upload state could not be read.")?;
                if pending >= 32 { return Err("Finish or cancel pending reference imports before starting another.".into()); }
                let id = identifier()?;
                let path = store.root.join(format!("recording-{id}.part"));
                std::fs::OpenOptions::new().create_new(true).write(true).open(&path).map_err(|_| "Recording storage is unavailable. Check free disk space.")?;
                let data = json!({"id":id,"owner":owner,"bytes":bytes,"sha256":hash.to_ascii_lowercase(),"transcript":transcript,"rightsEvidence":rights,"offset":0,"createdAt":timestamp()});
                if store.connection.execute("INSERT INTO speech_recording_uploads(id,owner,data) VALUES(?1,?2,?3)", params![id,owner,data.to_string()]).is_err() {
                    std::fs::remove_file(path).map_err(|_| "The incomplete recording upload could not be removed.")?;
                    return Err("The recording upload could not be saved.".into());
                }
                Ok(json!({"id":id,"offset":0}))
            },
            "writeRecording" => {
                let mut data = upload(store, input)?;
                let offset = input["offset"].as_u64().ok_or("Use a nonnegative recording offset.")?;
                if data["offset"] != offset { return Err("The recording offset changed. Resume from the saved upload position.".into()); }
                let encoded = input["audioBase64"].as_str().filter(|value| value.len() <= 349_528).ok_or("Send at most 256 KiB of recording bytes per chunk.")?;
                let bytes = STANDARD.decode(encoded).map_err(|_| "The recording chunk is not valid base64.")?;
                let next = offset.checked_add(bytes.len() as u64).filter(|next| *next <= data["bytes"].as_u64().unwrap_or(0)).ok_or("The recording exceeded its declared byte length.")?;
                if bytes.is_empty() { return Err("Send a nonempty recording chunk.".into()); }
                let path = store.root.join(format!("recording-{}.part", data["id"].as_str().ok_or("The recording ID is invalid.")?));
                let mut file = std::fs::OpenOptions::new().write(true).open(&path).map_err(|_| "The recording working file is unavailable.")?;
                if file.metadata().map_err(|_| "The recording working file is unavailable.")?.len() < offset { return Err("The recording working file is truncated. Restart the import.".into()); }
                file.set_len(offset).map_err(|_| "The recording working file could not recover its committed position.")?;
                use std::io::{Seek, SeekFrom};
                file.seek(SeekFrom::Start(offset)).map_err(|_| "The recording upload could not seek.")?;
                file.write_all(&bytes).and_then(|_| file.sync_data()).map_err(|_| "The recording chunk could not be saved. Check free disk space.")?;
                data["offset"] = json!(next);
                store.connection.execute("UPDATE speech_recording_uploads SET data=?1 WHERE id=?2 AND owner=?3", params![data.to_string(),data["id"].as_str(),owner(input)?]).map_err(|_| "The recording upload progress could not be saved.")?;
                Ok(json!({"offset":next}))
            },
            "cancelRecording" => {
                let data = upload(store, input)?;
                let path = store.root.join(format!("recording-{}.part", data["id"].as_str().ok_or("The recording ID is invalid.")?));
                if path.exists() { std::fs::remove_file(path).map_err(|_| "The recording working copy could not be removed.")?; }
                store.connection.execute("DELETE FROM speech_recording_uploads WHERE id=?1 AND owner=?2", params![data["id"].as_str(),owner(input)?]).map_err(|_| "The recording upload could not be cancelled.")?;
                Ok(Value::Null)
            },
            _ => Err("Choose a supported recording operation.".into()),
        }
    })
}
