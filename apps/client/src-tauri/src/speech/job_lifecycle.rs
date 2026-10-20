use super::store::SpeechStore;
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};

#[derive(Debug,PartialEq,Eq)]
pub enum RunOutcome{Completed,Yielded}

pub fn claim_next(store:&mut SpeechStore,concurrent:u64,now:String)->Result<Option<Value>,String>{
    if !(1..=50).contains(&concurrent){return Err("Configure between 1 and 50 concurrent speech requests.".into());}
    let transaction=store.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
    let paused:bool=transaction.query_row("SELECT paused FROM speech_queue WHERE singleton=1",[],|row|row.get(0)).map_err(|error|error.to_string())?;
    let running:i64=transaction.query_row("SELECT count(*) FROM jobs WHERE state='running'",[],|row|row.get(0)).map_err(|error|error.to_string())?;
    if paused||running>=concurrent as i64{return Ok(None);}
    let data:Option<String>=transaction.query_row("SELECT jobs.data FROM jobs LEFT JOIN speech_dispatch_order AS dispatched ON dispatched.job_id=jobs.id WHERE state='queued' ORDER BY json_extract(jobs.data,'$.priority') DESC,coalesce(dispatched.ordinal,0),jobs.created_at,jobs.id LIMIT 1",[],|row|row.get(0)).optional().map_err(|error|error.to_string())?;
    let Some(data)=data else{return Ok(None)};
    let mut job:Value=serde_json::from_str(&data).map_err(|_|"Speech job metadata is damaged.")?;
    job["state"]=json!("running");job["updatedAt"]=json!(now);
    super::store::generation_metrics::claim(&transaction,&job,&now)?;
    SpeechStore::put_job_in_transaction(&transaction,&job)?;
    transaction.execute("INSERT INTO speech_dispatch_order(job_id,ordinal) VALUES(?1,(SELECT coalesce(max(ordinal),0)+1 FROM speech_dispatch_order)) ON CONFLICT(job_id) DO UPDATE SET ordinal=excluded.ordinal",[job["id"].as_str().ok_or("The speech job identity is missing.")?]).map_err(|error|error.to_string())?;
    transaction.commit().map_err(|error|error.to_string())?;Ok(Some(job))
}

pub fn should_yield(store:&SpeechStore,job:&Value,committed_since_dispatch:bool)->Result<bool,String>{
    if job["completedSegments"]==job["totalSegments"]{return Ok(false);}
    store.connection.query_row("SELECT paused OR EXISTS(SELECT 1 FROM jobs WHERE state='queued' AND (json_extract(data,'$.priority')>?1 OR (?2 AND json_extract(data,'$.priority')=?1))) FROM speech_queue WHERE singleton=1",params![job["priority"].as_i64().ok_or("The speech priority is invalid.")?,committed_since_dispatch],|row|row.get(0)).map_err(|error|error.to_string())
}

pub fn request_cancel(store:&mut SpeechStore,owner:&str,id:&str,now:String)->Result<Value,String>{
    let transaction=store.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
    let data:Option<String>=transaction.query_row("SELECT data FROM jobs WHERE id=?1 AND owner=?2",[id,owner],|row|row.get(0)).optional().map_err(|error|error.to_string())?;
    let mut job:Value=serde_json::from_str(&data.ok_or("The job does not belong to this speech owner.")?).map_err(|_|"Speech job metadata is damaged.")?;
    if !matches!(job["state"].as_str(),Some("queued"|"running"))||job["cancelRequestedAt"].is_string(){return Ok(job);}
    job["cancelRequestedAt"]=json!(now);job["updatedAt"]=json!(now);
    if job["state"]=="queued"{job["state"]=json!("cancelled");super::job_usage::settle(&transaction,&mut job,false)?;}
    SpeechStore::put_job_in_transaction(&transaction,&job)?;transaction.commit().map_err(|error|error.to_string())?;Ok(job)
}

pub fn finish(store:&mut SpeechStore,id:&str,result:Result<RunOutcome,String>,cancelled:bool,dispatched:bool,now:String)->Result<Value,String>{
    let transaction=store.connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|error|error.to_string())?;
    let data:String=transaction.query_row("SELECT data FROM jobs WHERE id=?1",[id],|row|row.get(0)).map_err(|error|error.to_string())?;
    let mut job:Value=serde_json::from_str(&data).map_err(|_|"Speech job metadata is damaged.")?;
    if job["state"]!="running"{return Err("Only the active speech worker can finish this job.".into());}
    let cancelled=cancelled||job["cancelRequestedAt"].is_string();
    let (state,error)=match result{
        Ok(RunOutcome::Completed)=>("completed",None),
        Ok(RunOutcome::Yielded) if !cancelled=>("queued",None),
        Ok(RunOutcome::Yielded)=>("cancelled",Some("Speech cancelled before the next request.".into())),
        Err(error) if dispatched=>("uncertain",Some(format!("{error} The provider may have billed this request; retrying can create another charge."))),
        Err(error) if cancelled=>("cancelled",Some(error)),
        Err(error)=>("failed",Some(error)),
    };
    job["state"]=json!(state);job["updatedAt"]=json!(now);job["error"]=error.map_or(Value::Null,Value::String);
    super::store::generation_metrics::finish(&transaction,id,state,&now)?;
    if state!="queued"{super::job_usage::settle(&transaction,&mut job,state=="uncertain")?;}
    SpeechStore::put_job_in_transaction(&transaction,&job)?;transaction.commit().map_err(|error|error.to_string())?;Ok(job)
}
