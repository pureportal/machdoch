use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use rusqlite::OptionalExtension;

pub fn admitted_take(store:&super::store::SpeechStore,snapshot:&Value,segment:&Value,hash:&str,take_index:u64)->Result<Option<Value>,String>{
    let cached_id=snapshot["cachedTakes"].as_object().ok_or("The admitted cache selection is missing.")?.get(segment["id"].as_str().ok_or("The speech segment identity is missing.")?).and_then(Value::as_str).filter(|_|take_index==0);
    let Some(id)=cached_id else{return Ok(None);};
    let data:Option<String>=store.connection.query_row("SELECT data FROM takes WHERE id=?1 AND json_extract(data,'$.requestHash')=?2 AND NOT EXISTS(SELECT 1 FROM speech_cache_evictions e WHERE e.asset_id=takes.asset_id)",rusqlite::params![id,hash],|row|row.get(0)).optional().map_err(|error|error.to_string())?;
    let take:Value=serde_json::from_str(&data.ok_or("The audio reserved for cache reuse is unavailable. Submit a new render to estimate generation cost.")?).map_err(|_|"Speech cache metadata is damaged.")?;
    store.asset_path(take["asset"]["id"].as_str().ok_or("The cached asset identity is missing.")?)?;
    Ok(Some(take))
}

pub fn request_hash(segment: &Value, profile: &Value, dictionaries: &Value, references: &Value, connection: &Value) -> Result<String, String> {
    let mut generation = profile.as_object().ok_or("The speech profile snapshot is invalid.")?.clone();
    for field in ["id", "name", "playbackRate"] { generation.remove(field); }
    let reference_ids = segment["referenceAssetIds"].as_array().ok_or("The reference snapshot is invalid.")?;
    let pinned: Vec<&Value> = reference_ids.iter().map(|id| {
        references.get(id.as_str().ok_or("A reference ID is invalid.")?).ok_or("A reference snapshot is missing.")
    }).collect::<Result<_, _>>()?;
    let mut material = json!({
        "text": segment["text"], "voiceIds": segment["voiceIds"], "references": pinned, "referenceGroups":segment["referenceGroups"],
        "profile": generation, "dictionaries": dictionaries,
        "connection": {"url":connection["url"],"runtimeVersion":connection["runtimeVersion"],"model":connection["model"]}
    });
    if let Some(fragments)=segment.get("liveFragments"){material["liveInput"]=json!({"transport":"fish-live-v1","fragments":fragments});}
    if let Some(request)=segment.get("assistantRequest"){material["assistantRequest"]=request.clone();}
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(&material).map_err(|_| "The speech snapshot could not be hashed.")?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_identity_uses_generation_material_and_pinned_reference_transcripts() {
        let segment = json!({"id":"node-a","text":"Hello","voiceIds":["voice-1"],"referenceAssetIds":["asset-1"]});
        let profile = json!({"id":"profile-1","name":"Narrator","playbackRate":1,"backend":"fish-cloud","model":"drama-3","temperature":0.7});
        let references = json!({"asset-1":{"assetId":"asset-1","transcript":"Hello","rights":"Permission recorded"}});
        let connection = json!({"model":"drama-3","configured":true,"healthy":null});
        let original = request_hash(&segment,&profile,&json!([]),&references,&connection).unwrap();
        let mut moved=segment.clone();moved["id"]=json!("node-b");
        let mut renamed=profile.clone();renamed["name"]=json!("Renamed");renamed["playbackRate"]=json!(1.25);
        let mut tested=connection.clone();tested["healthy"]=json!(true);
        assert_eq!(original,request_hash(&moved,&renamed,&json!([]),&references,&tested).unwrap());
        for field in ["transcript","rights"] {
            let mut changed=references.clone();changed["asset-1"][field]=json!("Changed");
            assert_ne!(original,request_hash(&segment,&profile,&json!([]),&changed,&connection).unwrap());
        }
        let mut changed=profile.clone();changed["temperature"]=json!(0.5);
        assert_ne!(original,request_hash(&segment,&changed,&json!([]),&references,&connection).unwrap());
        assert!(request_hash(&segment,&profile,&json!([]),&json!({}),&connection).is_err());
    }
}
