use super::*;
use super::super::{analysis,asset_commit,asset_io,reference_audio};

pub fn finish(service: &Arc<SpeechService>, input: &Value) -> Result<Value,String> {
    let (data,path,token)=service.with_store(|store| {
        let data=upload(store,input)?;
        if data["offset"]!=data["bytes"] { return Err("Upload the remaining recording bytes before importing.".into()); }
        let id=data["id"].as_str().ok_or("The recording identity is missing.")?;
        let token=identifier()?;
        let transaction=store.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
        transaction.execute("DELETE FROM speech_recording_claims WHERE upload_id=?1 AND julianday(expires_at)<=julianday(?2)",params![id,timestamp()]).map_err(|error|error.to_string())?;
        transaction.execute("INSERT INTO speech_recording_claims VALUES(?1,?2,?3)",params![id,token,(chrono::Utc::now()+chrono::Duration::hours(1)).to_rfc3339()]).map_err(|_|"This recording is already being imported. Wait for it to finish.")?;
        transaction.commit().map_err(|error|error.to_string())?;
        let path=store.root.join(format!("recording-{id}.part"));
        Ok((data,path,token))
    })?;
    let result=(|| {
        let (duration,rate,channels)=reference_audio::inspect_wav(&path)?;
        let quality=analysis::analyze(&path,256)?;
        asset_commit::import(service,&path,duration,rate,channels,None,|store,asset| {
            if asset["sha256"]!=data["sha256"] || asset["bytes"]!=data["bytes"] { return Err("The recording failed its integrity check. Restart the import.".into()); }
            let transaction=store.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
            let valid:bool=transaction.query_row("SELECT EXISTS(SELECT 1 FROM speech_recording_claims c JOIN speech_recording_uploads u ON u.id=c.upload_id WHERE c.upload_id=?1 AND c.token=?2 AND u.owner=?3 AND julianday(c.expires_at)>julianday(?4))",params![data["id"].as_str(),token,owner(input)?,timestamp()],|row|row.get(0)).map_err(|error|error.to_string())?;
            if !valid { return Err("The recording import claim expired or changed. Reload pending recordings before retrying.".into()); }
            transaction.execute("INSERT INTO speech_references(asset_id,transcript,rights) VALUES(?1,?2,?3) ON CONFLICT(asset_id) DO UPDATE SET transcript=excluded.transcript,rights=excluded.rights",params![asset["id"].as_str(),data["transcript"].as_str(),data["rightsEvidence"].as_str()]).map_err(|_|"The reference transcript and permission could not be saved.")?;
            transaction.execute("DELETE FROM speech_recording_uploads WHERE id=?1 AND owner=?2",params![data["id"].as_str(),owner(input)?]).map_err(|error|error.to_string())?;
            transaction.commit().map_err(|error|error.to_string())?;
            Ok(json!({"asset":asset,"originalAsset":asset,"quality":quality,"transcript":data["transcript"],"rightsEvidence":data["rightsEvidence"]}))
        })
    })();
    let released=service.with_store(|store|store.connection.execute("DELETE FROM speech_recording_claims WHERE upload_id=?1 AND token=?2",params![data["id"].as_str(),token]).map(|_|()).map_err(|error|error.to_string()));
    match (result,released) {
        (Ok(value),Ok(())) => {
            std::fs::remove_file(path).map_err(|_|"The reference was imported, but its working copy could not be removed. Refresh saved recordings and clean temporary audio.")?;
            Ok(value)
        }
        (Err(error),Ok(())) | (Ok(_),Err(error)) => Err(error),
        (Err(error),Err(cleanup)) => Err(format!("{error} {cleanup}")),
    }
}

pub fn trim(service: &Arc<SpeechService>, input: &Value) -> Result<Value,String> {
    owner(input)?;
    let id=input["assetId"].as_str().ok_or("Choose a reference recording.")?;
    let from=input["from"].as_f64().ok_or("Choose a trim start.")?;
    let to=input["to"].as_f64().ok_or("Choose a trim end.")?;
    let transcript=input["transcript"].as_str().filter(|value|!value.trim().is_empty()&&value.len()<=65536).ok_or("Enter the transcript for the trimmed recording within 64 KiB.")?;
    let (rights,temporary)=service.with_store(|store| {
        let rights:String=store.connection.query_row("SELECT rights FROM speech_references WHERE asset_id=?1",[id],|row|row.get(0)).map_err(|_|"Record permission for this reference before trimming.")?;
        Ok((rights,store.root.join(format!("reference-trim-{}.wav",identifier()?))))
    })?;
    let source=asset_io::open(service,id,None)?;
    let result=(|| {
        reference_audio::trim(&source.path,&temporary,from,to)?;
        let (duration,rate,channels)=reference_audio::inspect_wav(&temporary)?;
        let quality=analysis::analyze(&temporary,256)?;
        asset_commit::import(service,&temporary,duration,rate,channels,None,|store,asset| {
            let transaction=store.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
            transaction.execute("INSERT INTO speech_references(asset_id,transcript,rights) VALUES(?1,?2,?3) ON CONFLICT(asset_id) DO UPDATE SET transcript=excluded.transcript,rights=excluded.rights",params![asset["id"].as_str(),transcript,rights]).map_err(|_|"The trimmed transcript could not be saved.")?;
            if asset["id"]!=id { transaction.execute("INSERT INTO speech_reference_originals(asset_id,original_asset_id) VALUES(?1,?2) ON CONFLICT DO NOTHING",params![asset["id"].as_str(),id]).map_err(|error|error.to_string())?; }
            transaction.commit().map_err(|error|error.to_string())?;
            Ok(json!({"asset":asset,"originalAsset":source.asset,"quality":quality,"transcript":transcript,"rightsEvidence":rights}))
        })
    })();
    let cleaned=match std::fs::remove_file(&temporary) {
        Ok(()) => Ok(()),
        Err(error) if error.kind()==std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("The trimmed working recording could not be cleaned up.".to_string()),
    };
    match (result,cleaned) {
        (Ok(value),Ok(())) => Ok(value),
        (Err(error),Ok(())) | (Ok(_),Err(error)) => Err(error),
        (Err(error),Err(cleanup)) => Err(format!("{error} {cleanup}")),
    }
}
