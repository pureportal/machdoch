use super::store::SpeechStore;
use rusqlite::OptionalExtension;
use serde_json::{json,Value};

pub fn apply(segment:&Value,profile:&Value)->Result<Value,String>{
    let mut segment=segment.as_object().ok_or("Supply a compiled speech segment.")?.clone();
    let voices=segment.get("voiceIds").and_then(Value::as_array).ok_or("Supply the segment voice list.")?;
    let references=segment.get("referenceAssetIds").and_then(Value::as_array).ok_or("Supply the segment reference list.")?;
    if voices.is_empty()&&references.is_empty(){
        if let Some(references)=profile.get("referenceAssetIds").and_then(Value::as_array).filter(|references|!references.is_empty()){segment.insert("referenceAssetIds".into(),json!(references));}
        else if let Some(voice)=profile["voiceId"].as_str().filter(|voice|!voice.is_empty()){segment.insert("voiceIds".into(),json!([voice]));}
    }
    if profile["backend"]!="drama3"&&segment["voiceIds"].as_array().is_some_and(Vec::is_empty)&&segment["referenceAssetIds"].as_array().is_some_and(Vec::is_empty){return Err("Assign a voice or reference recordings to this script or its speech profile before rendering.".into());}
    Ok(Value::Object(segment))
}

pub fn validate_defaults(store:&mut SpeechStore,profile:&Value)->Result<(),String>{
    let mut total=0u64;
    for id in profile["referenceAssetIds"].as_array().into_iter().flatten(){
        let id=id.as_str().ok_or("Choose a saved default reference.")?;let asset=store.execute("asset",&json!({"id":id}))?;
        let size=asset["bytes"].as_u64().filter(|size|*size<=16*1024*1024).ok_or("Trim each default reference below the local 16 MiB upload guard.")?;
        total+=size;if total>24*1024*1024{return Err("Trim default references below the local 24 MiB aggregate upload guard.".into());}
        let valid:Option<bool>=store.connection.query_row("SELECT length(trim(transcript))>0 AND length(trim(rights))>0 FROM speech_references WHERE asset_id=?1",[id],|row|row.get(0)).optional().map_err(|error|error.to_string())?;
        if valid!=Some(true){return Err("Record a transcript and permission evidence for every default reference before saving the profile.".into());}
    }
    Ok(())
}
