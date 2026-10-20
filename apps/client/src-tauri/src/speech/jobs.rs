use super::{identifier, providers, settings, timestamp, SpeechService};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tauri::Emitter;
use std::sync::atomic::{AtomicBool,Ordering};
use super::job_lifecycle::RunOutcome;

pub async fn retry(service: &Arc<SpeechService>, request: &Value) -> Result<Value, String> {
    let job_id = request["jobId"].as_str().ok_or("Choose a speech job to retry.")?;
    let input = service.with_store(|store| {
        let jobs = store.execute("listJobs", &json!({"owner":request["owner"],"id":job_id,"limit":1}))?;
        let job = jobs.as_array().and_then(|jobs| jobs.iter().find(|job| job["id"] == job_id)).ok_or("This speech job belongs to another owner.")?;
        if !matches!(job["state"].as_str(), Some("failed" | "cancelled" | "uncertain" | "interrupted")) { return Err("Retry a stopped job or generate another take for completed work.".into()); }
        if job["state"] == "uncertain" && request["confirmedUncertain"] != true { return Err("Confirm that retrying an uncertain request may create another provider charge.".into()); }
        let data: String = store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1", [job_id], |row| row.get(0)).map_err(|_| "The original request snapshot is missing.")?;
        let snapshot: Value = serde_json::from_str(&data).map_err(|_| "The original request snapshot is damaged.")?;
        let input=super::admission::retry_input(&snapshot,job_id,request["confirmedUncertain"]==true)?;
        Ok((input,snapshot))
    })?;
    if matches!(input.1["operation"].as_str(),Some("designVoice"|"createVoice")){super::voice_jobs::submit(service,input.1["operation"].as_str().ok_or("The voice operation is missing.")?,input.0)}
    else if input.1["operation"]=="align"{super::timing_jobs::submit(service,input.0).await}
    else if input.1.get("performanceNote").is_some(){
        let snapshot=input.1;
        let request=json!({"profile":snapshot["profile"],"dictionaries":snapshot["dictionaries"],"references":snapshot["references"],"connection":snapshot["connection"]});
        let generation=super::generation::GenerationSnapshot::from_request(&request,snapshot["parentTakeId"].as_str().ok_or("The performance source is missing.")?.into(),snapshot["performanceNote"].as_str().ok_or("The director note is missing.")?.into())?;
        let job=service.with_store(|store|{let settings=settings::settings(store)?;super::admission::admit_generation(store,input.0,settings,timestamp(),identifier()?,generation)})?;
        service.emit(&job);service.wake.notify_one();Ok(job)
    }else{submit(service,input.0)}
}

pub fn regenerate(service:&Arc<SpeechService>,input:Value)->Result<Value,String>{
    let job=service.with_store(|store|{let settings=settings::settings(store)?;super::generation::admit_performance(store,input,settings,timestamp(),identifier()?)})?;
    service.emit(&job);service.wake.notify_one();Ok(job)
}

pub fn compare_voices(service:&Arc<SpeechService>,input:Value)->Result<Value,String>{
    let job=service.with_store(|store|{let settings=settings::settings(store)?;super::voice_comparison::admit(store,input,settings,timestamp(),identifier()?)})?;
    service.emit(&job);service.wake.notify_one();Ok(job)
}

pub fn submit(service: &Arc<SpeechService>, input: Value) -> Result<Value, String> {
    let result = service.with_store(|store| {
        let settings = settings::settings(store)?;
        super::admission::admit(store, input, settings, timestamp(), identifier()?)
    })?;
    service.emit(&result);
    service.wake.notify_one();
    Ok(result)
}

pub fn read_audio(service:&Arc<SpeechService>,input:&Value)->Result<Value,String>{
    use base64::{engine::general_purpose::STANDARD,Engine};
    use std::io::{Read,Seek,SeekFrom};
    let job_id=input["jobId"].as_str().ok_or("Choose a speech job.")?;
    let segment_id=input["segmentId"].as_str().ok_or("Choose a speech segment.")?;
    let offset=input["offset"].as_u64().filter(|value|value%2==0).ok_or("Use a complete PCM sample offset.")?;
    let maximum=input["maxBytes"].as_u64().filter(|value|(2..=65536).contains(value)&&value%2==0).ok_or("Read between 2 and 65,536 PCM bytes.")?;
    let (path,finished,data_offset,data_length,rate,channels)=service.with_store(|store|{
        let owner=input["owner"].as_str().ok_or("Choose the speech stream owner.")?;
        if let Some(id)=super::stream_read::completed_asset(store,owner,job_id,segment_id)?{
            let path=store.root.join("blobs").join(&id[..2]).join(id);let reader=super::wave_file::WaveReader::open(&path)?;let spec=reader.spec();
            if spec.sample_format!=hound::SampleFormat::Int||spec.bits_per_sample!=16||!(1..=2).contains(&spec.channels){return Err("This completed audio does not match streaming PCM16. Play the completed file instead.".into());}
            return Ok((Some(path),true,reader.data_offset(),Some(reader.sample_count()*2),Some(spec.sample_rate),Some(spec.channels)));
        }
        let stream=service.stream_files.lock().map_err(|_|"The speech stream registry is unavailable.")?.get(&format!("{job_id}:{segment_id}")).cloned();
        Ok(match stream{Some(stream)=>((stream.sample_rate.is_some()&&stream.channels.is_some()&&stream.path.exists()).then_some(stream.path),false,44,None,stream.sample_rate,stream.channels),None=>(None,false,44,None,None,None)})
    })?;
    let Some(path)=path else{return Ok(json!({"audioBase64":"","nextOffset":offset,"complete":false,"sampleRate":rate,"channels":channels}))};
    let frame_bytes=u64::from(channels.ok_or("The speech stream format is not ready.")?)*2;
    let mut file=match std::fs::File::open(path){Ok(file)=>file,Err(error) if !finished&&error.kind()==std::io::ErrorKind::NotFound=>return Ok(json!({"audioBase64":"","nextOffset":offset,"complete":false,"sampleRate":rate,"channels":channels})),Err(_)=>return Err("The speech stream file is unavailable.".into())};let length=data_length.unwrap_or(file.metadata().map_err(|_|"The speech stream metadata is unavailable.")?.len().saturating_sub(data_offset));let available=length-length%frame_bytes;
    if offset%frame_bytes!=0||finished&&length%frame_bytes!=0{return Err("The speech stream ended or was read with an incomplete channel frame.".to_string())}
    if offset>available{return Err("The speech read offset exceeds the available audio.".to_string())}
    let count=(maximum.min(available-offset)/frame_bytes*frame_bytes) as usize;let mut bytes=vec![0u8;count];file.seek(SeekFrom::Start(data_offset+offset)).map_err(|_|"The speech stream could not be positioned.")?;file.read_exact(&mut bytes).map_err(|_|"The speech stream was interrupted.")?;
    Ok(json!({"audioBase64":STANDARD.encode(bytes),"nextOffset":offset+count as u64,"complete":finished&&offset+count as u64==available,"sampleRate":rate,"channels":channels}))
}


pub fn cancel(service:&Arc<SpeechService>,input:&Value)->Result<Value,String>{
    let entered=std::time::Instant::now();
    let id=input["jobId"].as_str().ok_or("Choose a speech job.")?;
    let owner=input["owner"].as_str().ok_or("Choose the speech job owner.")?;
    if let Some(active)=service.cancellations.lock().map_err(|_|"Speech cancellation is unavailable.")?.get_mut(id){active.cancel(owner,entered)?;}
    let result=service.with_store(|store|{
        let job=super::job_lifecycle::request_cancel(store,owner,id,timestamp())?;
        if job["state"]=="running"{if let Some(active)=service.cancellations.lock().map_err(|_|"Speech cancellation is unavailable.")?.get_mut(id){active.cancel(owner,entered)?;}}
        Ok(job)
    })?;
    service.emit(&result);service.wake.notify_one();Ok(result)
}

pub async fn dispatch(service:Arc<SpeechService>){
    loop{
        tokio::select! { _ = service.wake.notified() => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(1800)) => {} }
        if let Err(message) = service.with_store(|store| {
            let days = settings::raw_settings(store)?["cacheRetentionDays"].as_u64().ok_or("The cache retention setting is invalid.")?;
            let result=store.clean_cache(days,chrono::Utc::now())?;
            if result["pending"]==true {service.wake.notify_one();}
            Ok(())
        }) {
            if service.app.emit("machdoch://speech-error",json!({"message":message})).is_err() { eprintln!("Speech cache cleanup failed. Clean expired audio in Text to Speech settings."); }
        }
        loop{
            let next=service.with_store(|store|{
                let concurrent=settings::raw_settings(store)?["maxConcurrent"].as_u64().ok_or("Configure speech concurrency.")?;
                let Some(job)=super::job_lifecycle::claim_next(store,concurrent,timestamp())? else{return Ok(None)};
                let token=CancellationToken::new();
                let id=job["id"].as_str().ok_or("Invalid speech job ID")?;
                let ordinal=store.connection.query_row("SELECT max(ordinal) FROM speech_dispatch_measurements WHERE job_id=?1",[id],|row|row.get(0)).map_err(|error|error.to_string())?;
                let active=super::active_request::ActiveRequest::new(job["owner"].as_str().ok_or("The speech owner is missing.")?.into(),token.clone(),ordinal);
                service.cancellations.lock().map_err(|_|"Speech cancellation is unavailable.")?.insert(id.to_string(),active);
                Ok(Some((job,token)))
            });
            let (job,token)=match next{Ok(Some(value))=>value,Ok(None)=>break,Err(error)=>{let _=service.app.emit("machdoch://speech-error",json!({"message":error}));break}};
            let worker=service.clone();
            tauri::async_runtime::spawn(async move{
                let id=job["id"].as_str().unwrap_or("").to_string();
                let dispatched=AtomicBool::new(false);
                let result=run(&worker,job.clone(),token.clone(),&dispatched).await;
                let stream_cleanup=worker.stream_files.lock().map(|mut streams|streams.retain(|key,_|!key.starts_with(&format!("{id}:")))).map_err(|_|"Speech stream cleanup is unavailable.");
                let measured=worker.cancellations.lock().map_err(|_|"Speech cancellation cleanup is unavailable.").and_then(|mut active|active.remove(&id).map(|active|active.measurements()).ok_or("The active speech worker measurement is missing."));
                let terminal=worker.with_store(|store|{
                    let finished=super::job_lifecycle::finish(store,&id,result,token.is_cancelled(),dispatched.load(Ordering::SeqCst),timestamp())?;
                    stream_cleanup.map_err(str::to_owned)?;
                    store.finish_dispatch_measurement(&finished,&measured.map_err(str::to_owned)?)?;
                    Ok(finished)
                });
                match terminal{Ok(job)=>worker.emit(&job),Err(error)=>{let _=worker.app.emit("machdoch://speech-error",json!({"jobId":id,"message":error}));}}
                worker.wake.notify_one();
            });
        }
    }
}

async fn run(service:&Arc<SpeechService>,mut job:Value,cancel:CancellationToken,dispatched:&AtomicBool)->Result<RunOutcome,String>{
    let id=job["id"].as_str().ok_or("Missing speech job ID")?.to_string();
    let snapshot:Value=service.with_store(|store|{let data:String=store.connection.query_row("SELECT snapshot FROM speech_requests WHERE job_id=?1",[&id],|row|row.get(0)).map_err(|error|error.to_string())?;serde_json::from_str(&data).map_err(|_|"Speech request snapshot is damaged.".to_string())})?;
    if matches!(snapshot["operation"].as_str(),Some("designVoice"|"createVoice")){return super::voice_jobs::run(service,job,&snapshot,cancel,dispatched).await;}
    if snapshot["operation"]=="align"{return super::timing_jobs::run(service,job,&snapshot,cancel,dispatched).await;}
    let input=&snapshot["input"];let profile=&snapshot["profile"];
    let resumed = job["completedSegments"].as_u64().ok_or("The recovered segment count is invalid.")?;
    for take_index in 0..input["takes"].as_u64().ok_or("Invalid take count")?{
        let segments = input["segments"].as_array().ok_or("Invalid speech segments")?;
        for (index, initial_segment) in segments.iter().enumerate(){
            if take_index * segments.len() as u64 + (index as u64) < resumed { continue; }
            if cancel.is_cancelled(){return Err("Speech cancelled.".to_string())}
            if service.with_store(|store|super::job_lifecycle::should_yield(store,&job,take_index*segments.len() as u64+index as u64>resumed))?{return Ok(RunOutcome::Yielded);}
            let live=!snapshot["liveInput"].is_null();
            let live_result=if live{Some(providers::render_live(service,&snapshot,initial_segment,cancel.clone(),dispatched).await?)}else{None};
            let segment=if live{service.with_store(|store|super::live_input::completed_segment(store,&id,initial_segment))?}else{initial_segment.clone()};
            let request_hash=super::cache::request_hash(&segment,profile,&snapshot["dictionaries"],&snapshot["references"],&snapshot["connection"])?;
            let cached=service.with_store(|store|super::cache::admitted_take(store,&snapshot,&segment,&request_hash,take_index))?;
            let observations=super::store::SpeechStore::segment_voice_observations(&snapshot,&segment)?;
            let (asset,alignment,generated_at,reused_from,provider_response,voice_observations)=if let Some((asset,alignment,response))=live_result{
                (asset,alignment,json!(timestamp()),Value::Null,response,observations)
            }else if let Some(cached)=cached{
                let started=std::time::Instant::now();
                let source_audio=super::asset_io::open(service,cached["asset"]["id"].as_str().ok_or("The cached audio identity is missing.")?,Some(&cancel))?;
                let asset=source_audio.asset.clone();
                service.with_store(|store|store.record_request_measurement(&snapshot,&segment,"cache",started.elapsed().as_secs_f64()*1000.0,None,asset["duration"].as_f64(),"completed",false))?;
                (asset,cached["alignment"].clone(),cached["generatedAt"].clone(),cached["id"].clone(),cached["providerResponse"].clone(),cached["voiceObservations"].clone())
            }else{
                let (asset,alignment,response)=providers::render(service,&snapshot,&segment,cancel.clone(),dispatched).await?;
                (asset,alignment,json!(timestamp()),Value::Null,response,observations)
            };
            if cancel.is_cancelled(){return Err("Speech cancelled.".to_string())}
            let mut take=json!({"id":identifier()?,"projectId":job["projectId"],"revisionId":job["revisionId"],"segmentId":segment["id"],"spokenText":segment["spokenText"],"chapter":segment["chapter"],"asset":asset,"createdAt":timestamp(),"generatedAt":generated_at,"reusedFromTakeId":reused_from,"backend":profile["backend"],"model":profile["model"],"requestHash":request_hash,"parentTakeId":snapshot["parentTakeId"],"favorite":false,"rating":null,"note":"","alignment":alignment});
            if !provider_response.is_null(){take["providerResponse"]=provider_response;}
            if !voice_observations.is_null(){take["voiceObservations"]=voice_observations;}
            let mut references=serde_json::Map::new();
            for id in segment["referenceAssetIds"].as_array().ok_or("Invalid segment references")? {
                let id=id.as_str().ok_or("Invalid reference ID")?;
                references.insert(id.to_owned(),snapshot["references"][id].clone());
            }
            let mut request=json!({"segment":segment,"profile":profile,"dictionaries":snapshot["dictionaries"],"references":references,"connection":{"backend":profile["backend"],"model":profile["model"],"url":snapshot["connection"]["url"],"runtimeVersion":snapshot["connection"]["runtimeVersion"]}});
            if let Some(note)=snapshot.get("performanceNote"){request["performanceNote"]=note.clone();}
            service.with_store(|store|{let state:String=store.connection.query_row("SELECT state FROM jobs WHERE id=?1",[&id],|row|row.get(0)).map_err(|error|error.to_string())?;if state!="running"{return Err("Speech job is no longer running.".to_string())}job["takeIds"].as_array_mut().ok_or("Invalid speech take list")?.push(take["id"].clone());job["completedSegments"]=json!(job["completedSegments"].as_u64().unwrap_or(0)+1);job["updatedAt"]=json!(timestamp());store.put_completed_segment(&take,&job,&request)})?;
            dispatched.store(false,Ordering::SeqCst);
            service.stream_files.lock().map_err(|_|"The speech stream registry is unavailable.")?.remove(&format!("{id}:{}",segment["id"].as_str().ok_or("The speech segment identity is missing.")?));
            service.emit(&job);
        }
    }
    Ok(RunOutcome::Completed)
}
