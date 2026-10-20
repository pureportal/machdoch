use super::{reference_audio::inspect_wav,store::SpeechStore};
use base64::{engine::general_purpose::STANDARD,Engine};
use rusqlite::params;
use serde_json::{json,Value};
use std::io::Write;

pub fn commit(store:&mut SpeechStore,job:&mut Value,response:Value,now:&str)->Result<(),String>{
    let id=job["id"].as_str().ok_or("The voice job identity is missing.")?.to_owned();
    let design=job["kind"]=="voice-design";
    let mut candidates=Vec::new();
    let voice=if design{
        let preview:String=store.connection.query_row("SELECT json_extract(snapshot,'$.input.text') FROM speech_requests WHERE job_id=?1",[&id],|row|row.get(0)).map_err(|error|error.to_string())?;
        let directory=store.root.join("temporary");std::fs::create_dir_all(&directory).map_err(|_|"Voice working storage is unavailable.")?;
        for (index,candidate) in response["candidates"].as_array().ok_or("The design response is damaged.")?.iter().enumerate(){
            let bytes=STANDARD.decode(candidate["audio_base64"].as_str().ok_or("The candidate audio is missing.")?).map_err(|_|"The candidate audio encoding is invalid.")?;
            let temporary=directory.join(format!("voice-{id}-{index}.wav"));
            let mut file=std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_|"Voice working audio could not be created. Check free disk space and expired working files.")?;
            let save=(||{
                file.write_all(&bytes).map_err(|_|"Voice working audio could not be saved. Check free disk space.")?;
                file.sync_all().map_err(|_|"Voice working audio could not be committed.")?;
                let (duration,rate,channels)=inspect_wav(&temporary)?;
                if candidate["sample_rate"].as_u64()!=Some(rate as u64)||candidate["duration_ms"].as_f64().is_none_or(|reported|!reported.is_finite()||(reported-duration*1000.0).abs()>1.0){return Err("Fish candidate metadata differs from its actual audio. Review account usage before generating again.".into());}
                store.put_asset(&temporary,"audio/wav",duration,rate,channels)
            })();
            drop(file);let cleaned=std::fs::remove_file(&temporary).map_err(|_|"Voice working audio could not be removed. Clean expired working audio before retrying.");
            let asset=match(save,cleaned){(Ok(asset),Ok(()))=>asset,(Err(error),Ok(()))=>return Err(error),(Ok(_),Err(error))=>return Err(error.into()),(Err(error),Err(cleanup))=>return Err(format!("{error} {cleanup}"))};
            let mut metadata=candidate.clone();metadata.as_object_mut().ok_or("The candidate metadata is invalid.")?.remove("audio_base64");
            candidates.push(json!({"id":candidate["id"],"assetId":asset["id"],"previewText":preview,"metadata":metadata}));
        }
        Value::Null
    }else{super::voice_metadata::normalize(&response,false,now)?};
    let result=json!({"jobId":id,"kind":job["kind"],"createdAt":now,"candidates":candidates,"voice":voice});
    super::store::bounded_record(&result)?;
    let transaction=store.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
    let actual:String=transaction.query_row("SELECT data FROM jobs WHERE id=?1",[&id],|row|row.get(0)).map_err(|error|error.to_string())?;
    let mut actual:Value=serde_json::from_str(&actual).map_err(|_|"The voice job metadata is damaged.")?;
    if actual["state"]!="running"||actual["kind"]!=job["kind"]||actual["owner"]!=job["owner"]{return Err("Only the active voice worker can commit its result.".into());}
    if !voice.is_null(){SpeechStore::record_voice_observation(&transaction,&voice)?;}
    for candidate in &candidates{
        transaction.execute("INSERT INTO speech_design_candidates(id,asset_id,metadata) VALUES(?1,?2,?3)",params![candidate["id"].as_str(),candidate["assetId"].as_str(),candidate["metadata"].to_string()]).map_err(|_|"A design candidate identity is already stored. Review saved results before generating again.")?;
        transaction.execute("INSERT INTO speech_design_origins(candidate_id,job_id) VALUES(?1,?2)",params![candidate["id"].as_str(),id]).map_err(|error|error.to_string())?;
    }
    transaction.execute("INSERT INTO speech_voice_workflow_results(job_id,data) VALUES(?1,?2)",params![id,result.to_string()]).map_err(|error|error.to_string())?;
    actual["completedSegments"]=json!(1);actual["updatedAt"]=json!(now);
    SpeechStore::put_job_in_transaction(&transaction,&actual)?;
    transaction.commit().map_err(|error|error.to_string())?;*job=actual;Ok(())
}
