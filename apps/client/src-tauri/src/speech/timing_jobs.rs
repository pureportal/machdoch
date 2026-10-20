use super::{exports,identifier,settings,timestamp,timing_provider,transcript_timing,SpeechService};
use serde_json::{json,Value};
use std::path::{Path,PathBuf};
use std::sync::{Arc,atomic::{AtomicBool,Ordering}};
use tokio_util::sync::CancellationToken;
use super::job_lifecycle::RunOutcome;

struct Workspace(PathBuf);
impl Workspace{
    fn create(root:&Path,id:&str)->Result<Self,String>{
        let parent=root.join("temporary");std::fs::create_dir_all(&parent).map_err(|_|"Transcription working storage is unavailable.")?;
        let parent=parent.canonicalize().map_err(|_|"Transcription working storage could not be inspected.")?;
        if !parent.starts_with(root){return Err("Transcription working storage is outside its asset store.".into());}
        let directory=parent.join(format!("timing-{id}"));std::fs::create_dir(&directory).map_err(|_|"A transcription working directory already exists. Review Jobs before retrying.")?;
        Ok(Self(directory))
    }
    fn finish(self)->Result<(),String>{std::fs::remove_dir_all(&self.0).map_err(|_|"Transcription working files could not be removed. Clean expired audio before retrying.".into())}
}
impl Drop for Workspace{fn drop(&mut self){if self.0.exists()&&std::fs::remove_dir_all(&self.0).is_err(){eprintln!("Transcription working cleanup failed; clean expired audio in Text to Speech.");}}}

pub async fn submit(service:&Arc<SpeechService>,input:Value)->Result<Value,String>{
    if input["provider"]!="openai"||input["model"]!=transcript_timing::MODEL{return Err("Choose OpenAI Whisper 1 explicitly for word timestamps.".into());}
    let (_,encoder_sha)=encoder().await?;
    let (preferences,cached)=service.with_store(|store|{
        let take=store.timing_take(input["takeId"].as_str().ok_or("Choose a take for transcription.")?)?;
        let language=transcript_timing::validate_language(&input["language"])?;
        let hash=transcript_timing::request_hash(take["asset"]["sha256"].as_str().ok_or("The take audio identity is unavailable.")?,language,&encoder_sha);
        let resumed=match input["parentJobId"].as_str(){Some(id)=>store.timing_chunks(id)?.len()==transcript_timing::chunks(take["asset"]["duration"].as_f64().ok_or("The take duration is invalid.")?)?.len(),None=>false};
        Ok((settings::raw_settings(store)?,input["reuseCache"]==true&&store.timing_candidate(&take,&hash)?.is_some()||resumed))
    })?;
    let configured=if cached{true}else{
        if preferences["cloudConsent"]!=true||input["cloudConsent"]!=true{return Err("Enable cloud speech requests and confirm sending this audio to OpenAI before transcribing.".into());}
        settings::credential("openai")?.is_some()
    };
    let job=service.with_store(|store|store.admit_timing(input,&preferences,&encoder_sha,configured,timestamp(),identifier()?))?;
    service.emit(&job);service.wake.notify_one();Ok(job)
}

async fn encoder()->Result<(PathBuf,String),String>{
    tokio::task::spawn_blocking(||{let path=exports::encoder()?;let hash=exports::hash_file(&path)?;Ok((path,hash))}).await.map_err(|_|"The pinned transcription encoder could not be verified.")?
}

pub async fn run(service:&Arc<SpeechService>,mut job:Value,snapshot:&Value,cancel:CancellationToken,dispatched:&AtomicBool)->Result<RunOutcome,String>{
    if cancel.is_cancelled(){return Err("Transcription cancelled.".into());}
    let id=job["id"].as_str().ok_or("The transcription job ID is missing.")?.to_owned();
    if let Some(reused)=snapshot["reusedTimingId"].as_str(){
        let mut result=service.with_store(|store|store.timing(reused))?;
        result["id"]=json!(identifier()?);result["jobId"]=json!(id);result["createdAt"]=json!(timestamp());result["reusedFromTimingId"]=json!(reused);
        job["completedSegments"]=json!(1);job["timingId"]=result["id"].clone();job["updatedAt"]=json!(timestamp());
        service.with_store(|store|store.put_timing(&result,&job))?;service.emit(&job);return Ok(RunOutcome::Completed);
    }
    let take=&snapshot["take"];
    let plan=snapshot["chunks"].as_array().ok_or("The transcription window snapshot is damaged.")?;
    let completed=job["completedSegments"].as_u64().ok_or("The completed transcription count is invalid.")? as usize;
    let pending=plan.get(completed..).ok_or("The transcription recovery position is invalid.")?;
    let mut evidence=service.with_store(|store|store.timing_chunks(&id))?;
    if evidence.len()!=completed{return Err("The transcription recovery log is incomplete.".into());}
    transcript_timing::combine(&evidence,take["asset"]["duration"].as_f64().ok_or("The source duration is invalid.")?)?;
    for (index,chunk) in evidence.iter().enumerate(){if chunk["window"]!=plan[index]{return Err("The recovered transcription window differs from this request.".into());}}
    if !pending.is_empty(){
        let preferences=service.with_store(|store|settings::raw_settings(store))?;
        if preferences["cloudConsent"]!=true||snapshot["input"]["cloudConsent"]!=true{return Err("Cloud speech requests were disabled. Enable them before retrying transcription.".into());}
        transcript_timing::estimate(&snapshot["pricing"],pending,chrono::Utc::now().date_naive())?;
        let (encoder,encoder_sha)=encoder().await?;
        if snapshot["encoderSha256"]!=encoder_sha{return Err("The pinned audio encoder changed. Submit a new transcription job.".into());}
        let probe=tokio::task::spawn_blocking(exports::probe).await.map_err(|_|"The audio probe could not be verified.")??;
        let (source,root)=service.with_store(|store|Ok((store.timing_asset_path(take)?,store.root.clone())))?;
        timing_provider::verify_source(source.clone(),take["asset"].clone(),&probe,&cancel).await?;
        let key=settings::credential("openai")?.ok_or("Configure OpenAI before transcribing audio.")?;
        let work=Workspace::create(&root,&id)?;
        for (index,window) in plan.iter().enumerate().skip(completed){
            if cancel.is_cancelled(){return Err("Transcription cancelled.".into());}
            if service.with_store(|store|super::job_lifecycle::should_yield(store,&job,index>completed))?{return Ok(RunOutcome::Yielded);}
            let upload=work.0.join(format!("{index}.wav"));
            let audio=timing_provider::prepare(&source,&encoder,&upload,window,&cancel).await?;
            let response=timing_provider::transcribe(&service.client,&key,&upload,transcript_timing::validate_language(&snapshot["input"]["language"])? ,&cancel,dispatched).await?;
            let mut chunk=transcript_timing::parse_chunk(&response,window,take["asset"]["duration"].as_f64().ok_or("The source duration is invalid.")?)?;
            chunk["window"]=window.clone();chunk["audioSha256"]=audio["audioSha256"].clone();chunk["uploadDuration"]=audio["uploadDuration"].clone();chunk["receivedAt"]=json!(timestamp());chunk["admittedAt"]=snapshot["admittedAt"].clone();
            if cancel.is_cancelled(){return Err("Transcription cancelled.".into());}
            job["completedSegments"]=json!(index+1);job["updatedAt"]=json!(timestamp());
            service.with_store(|store|store.put_timing_chunk(&job,index,&chunk))?;dispatched.store(false,Ordering::SeqCst);
            evidence.push(chunk);service.emit(&job);
            std::fs::remove_file(&upload).map_err(|_|"The transcription upload could not be removed. Clean expired audio before retrying.")?;
        }
        work.finish()?;
    }
    if cancel.is_cancelled(){return Err("Transcription cancelled.".into());}
    let combined=transcript_timing::combine(&evidence,take["asset"]["duration"].as_f64().ok_or("The source duration is invalid.")?)?;
    let admitted=evidence.first().and_then(|chunk|chunk["admittedAt"].as_str()).ok_or("The transcription admission evidence is missing.")?;
    let measured=evidence.last().and_then(|chunk|chunk["receivedAt"].as_str()).ok_or("The transcription completion evidence is missing.")?;
    let quote_date=chrono::DateTime::parse_from_rfc3339(admitted).map_err(|_|"The transcription quote date is damaged.")?.date_naive();
    let estimate=transcript_timing::estimate(&snapshot["pricing"],plan,quote_date)?;
    let chunks:Vec<Value>=evidence.iter().map(|chunk|json!({"window":chunk["window"],"audioSha256":chunk["audioSha256"],"responseSha256":chunk["responseSha256"],"uploadDuration":chunk["uploadDuration"],"providerText":chunk["providerText"],"language":chunk["language"],"usage":chunk["usage"]})).collect();
    let result=json!({"id":identifier()?,"takeId":take["id"],"assetId":take["asset"]["id"],"assetSha256":take["asset"]["sha256"],"provider":"openai","model":transcript_timing::MODEL,"languageHint":snapshot["input"]["language"],"transcript":combined["transcript"],"words":combined["words"],"createdAt":timestamp(),"measuredAt":measured,"jobId":id,"requestHash":snapshot["requestHash"],"provenance":{"encoderSha256":snapshot["encoderSha256"],"sourceDuration":take["asset"]["duration"],"admittedAt":admitted,"sampleRate":16000,"channels":1,"pipeline":1,"chunks":chunks},"pricing":snapshot["pricing"],"estimatedCost":estimate,"reusedFromTimingId":null});
    job["timingId"]=result["id"].clone();job["updatedAt"]=json!(timestamp());
    service.with_store(|store|store.put_timing(&result,&job))?;service.emit(&job);Ok(RunOutcome::Completed)
}
