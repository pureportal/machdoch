use super::{identifier,timestamp,settings,SpeechService,job_lifecycle::RunOutcome};
use serde_json::Value;
use std::sync::{Arc,atomic::AtomicBool};
use tokio_util::sync::CancellationToken;

pub fn submit(service:&Arc<SpeechService>,operation:&str,input:Value)->Result<Value,String>{
    let job=service.with_store(|store|{let settings=settings::settings(store)?;super::voice_workflow::admit(store,operation,input,settings,timestamp(),identifier()?)})?;
    service.emit(&job);service.wake.notify_one();Ok(job)
}

pub async fn run(service:&Arc<SpeechService>,mut job:Value,snapshot:&Value,cancel:CancellationToken,dispatched:&AtomicBool)->Result<RunOutcome,String>{
    if cancel.is_cancelled(){return Err("Voice request cancelled.".into());}
    if service.with_store(|store|super::job_lifecycle::should_yield(store,&job,false))?{return Ok(RunOutcome::Yielded);}
    let key=settings::credential("fish-cloud")?.ok_or("Save a Fish Audio API key before starting voice work.")?;
    let response=super::voice_workflow_transport::request(&service.client,&key,snapshot,|id|super::asset_io::open(service,id,Some(&cancel))?.read_bytes(16*1024*1024),cancel.clone(),dispatched).await?;
    service.with_store(|store|super::voice_workflow_results::commit(store,&mut job,response,&timestamp()))?;
    service.emit(&job);Ok(RunOutcome::Completed)
}
