use super::reference_audio::inspect_wav;
use super::{fish, identifier, settings, SpeechService};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::params;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use std::sync::atomic::{AtomicBool,Ordering};


pub async fn render(service:&Arc<SpeechService>,snapshot:&Value,segment:&Value,cancel:CancellationToken,dispatched:&AtomicBool)->Result<(Value,Value,Value),String>{
    render_input(service,snapshot,segment,cancel,dispatched,None).await
}

pub async fn render_live(service:&Arc<SpeechService>,snapshot:&Value,segment:&Value,cancel:CancellationToken,dispatched:&AtomicBool)->Result<(Value,Value,Value),String>{
    let id=snapshot["jobId"].as_str().ok_or("The live job ID is missing.")?.to_owned();
    let direction=snapshot["profile"]["direction"].as_str().ok_or("The live direction is invalid.")?.to_owned();
    let stream=super::live_jobs::text(service.clone(),id,cancel.clone(),direction);
    render_input(service,snapshot,segment,cancel,dispatched,Some(Box::pin(stream))).await
}

type LiveText=std::pin::Pin<Box<dyn futures_util::Stream<Item=String>+Send>>;

async fn render_input(service:&Arc<SpeechService>,snapshot:&Value,segment:&Value,cancel:CancellationToken,dispatched:&AtomicBool,live:Option<LiveText>)->Result<(Value,Value,Value),String>{
    let started=std::time::Instant::now();
    let mut first_audio_ms=None;
    let profile=&snapshot["profile"];let backend=profile["backend"].as_str().ok_or("Choose a speech backend.")?;
    let text=super::contracts::provider_text(segment,profile)?;
    let temporary=service.with_store(|store|{let root=store.root.join("temporary");std::fs::create_dir_all(&root).map_err(|_|"Speech working storage is unavailable.")?;Ok(root.join(format!("{}.wav",identifier()?)))})?;
    let stream_key=format!("{}:{}",snapshot["jobId"].as_str().ok_or("The speech job ID is missing.")?,segment["id"].as_str().ok_or("The speech segment ID is missing.")?);
    if matches!(backend,"fish-cloud"|"sglang"){service.stream_files.lock().map_err(|_|"The speech stream registry is unavailable.")?.insert(stream_key.clone(),super::stream_read::StreamFile{path:temporary.clone(),sample_rate:if backend=="fish-cloud"{Some(24000)}else{None},channels:if backend=="fish-cloud"{Some(1)}else{None}});}
    let rendering=async{
        let (alignment,duration,rate,channels,provider_response)=match backend{
            "fish-cloud"=>{
                let key=settings::credential(backend)?.ok_or("Save a Fish Audio API key before rendering.")?;
                let mut request=super::fish_request::build(snapshot,segment,|id|reference_audio(service,id))?;
                let result=if let Some(text)=live{
                    request["text"]=json!("");
                    fish::render_live(&key,request,text,&temporary,cancel.clone(),dispatched).await?
                }else{fish::render(&service.client,&key,request,&temporary,cancel.clone(),dispatched).await?};
                first_audio_ms=result.first_audio_ms;
                (json!(result.alignment),result.frames as f64/result.sample_rate as f64,result.sample_rate,result.channels,Value::Null)
            },
            "openai"|"google"=>{
                let model=if backend=="openai"{"gpt-4o-mini-tts"}else{"gemini-3.1-flash-tts-preview"};
                let voice=if backend=="openai"{"cedar"}else{"Kore"};
                if profile["model"]!=model||profile["voiceId"]!=voice{return Err("This provider profile must use its configured assistant model and voice.".to_string())}
                if super::assistant_requests::prepare_segment(segment,profile)?!=*segment{return Err("The pinned assistant request is missing. Submit a new render.".into());}
                let key=settings::credential(backend)?.ok_or("Save the selected speech provider's API key before rendering.")?;
                let rendered=super::assistant_transport::render(&service.client,backend,&key,&segment["assistantRequest"],&temporary,cancel.clone(),dispatched).await?;
                (json!([]),rendered.duration,rendered.sample_rate,rendered.channels,rendered.provider_response)
            },
            "drama3"=>{
                let (duration,rate,channels)=super::drama3::render(service,snapshot,segment,&temporary,cancel.clone()).await?;
                (json!([]),duration,rate,channels,Value::Null)
            },
            "sglang"=>{
                let connection=&snapshot["connection"];let url=connection["url"].as_str().ok_or("Set a self-hosted speech URL.")?;
                if connection["runtimeVersion"].as_str().unwrap_or("").is_empty(){return Err("Pin the self-hosted runtime version before rendering.".to_string())}
                let mut body=json!({"model":"fishaudio/drama-3","input":text,"temperature":profile["temperature"],"top_p":profile["topP"]});
                let direction=profile["direction"].as_str().ok_or("The speech direction is invalid.")?;
                if !direction.is_empty(){body["input"]=json!(format!("[{direction}]{text}"));}
                if !profile["dictionaryIds"].as_array().ok_or("The dictionary selection is invalid.")?.is_empty(){return Err("This runtime's pronunciation-dictionary contract is unverified. Use inline phonemes or the Fish cloud profile.".into());}
                let mut references=Vec::new();
                let mut reference_bytes=0usize;
                for id in segment["referenceAssetIds"].as_array().ok_or("The reference selection is invalid.")? {
                    let id=id.as_str().ok_or("The reference ID is invalid.")?;
                    let pinned=snapshot["references"].get(id).ok_or("The immutable reference transcript is missing.")?;
                    let audio=reference_audio(service,id)?;
                    reference_bytes+=audio.len();
                    if reference_bytes>24*1024*1024{return Err("Trim self-hosted references below the local 24 MiB aggregate upload guard.".into());}
                    references.push(json!({"audio_path":format!("data:audio/wav;base64,{}",STANDARD.encode(audio)),"text":pinned["transcript"]}));
                }
                if !references.is_empty(){body["references"]=json!(references);}
                let key=settings::credential(backend)?;
                let rendered=super::sglang_transport::render(&service.client,url,key.as_deref(),body,&temporary,cancel.clone(),dispatched,|rate,channels|{
                    let mut streams=service.stream_files.lock().map_err(|_|"The speech stream registry is unavailable.")?;
                    let stream=streams.get_mut(&stream_key).ok_or("The active speech stream is missing.")?;stream.sample_rate=Some(rate);stream.channels=Some(channels);Ok(())
                }).await?;
                first_audio_ms=rendered.first_audio_ms;
                (json!([]),rendered.audio.frames as f64/rendered.audio.sample_rate as f64,rendered.audio.sample_rate,rendered.audio.channels,rendered.provider_response)
            },
            _=>return Err("Choose a supported speech backend.".to_string()),
        };
        let asset=super::asset_commit::import(service,&temporary,duration,rate,channels,Some(&cancel),|store,asset| {
            let job_id=snapshot["jobId"].as_str().ok_or("The speech job identity is missing.")?;
            let state:String=store.connection.query_row("SELECT state FROM jobs WHERE id=?1",[job_id],|row|row.get(0)).map_err(|error|error.to_string())?;
            if state!="running" { return Err("The speech job is no longer running.".into()); }
            store.connection.execute("INSERT INTO speech_request_assets(job_id,asset_id) VALUES(?1,?2) ON CONFLICT DO NOTHING",params![job_id,asset["id"].as_str()]).map_err(|error|error.to_string())?;
            Ok(asset)
        })?;
        if matches!(backend,"fish-cloud"|"sglang") {
            let mut streams=service.stream_files.lock().map_err(|_|"The speech stream registry is unavailable.")?;
            if let Some(stream)=streams.get_mut(&stream_key) {
                stream.path=std::path::PathBuf::from(asset["path"].as_str().ok_or("The committed speech audio path is missing.")?);
            }
        }
        Ok((asset,alignment,provider_response))
    };
    let result=if backend=="drama3"{rendering.await}else{tokio::select!{biased;_=cancel.cancelled()=>Err("Speech cancelled.".to_string()),result=rendering=>result}};
    let elapsed=started.elapsed().as_secs_f64()*1000.0;
    if result.is_err(){service.stream_files.lock().map_err(|_|"The speech stream registry is unavailable.")?.remove(&stream_key);}
    if temporary.exists(){std::fs::remove_file(&temporary).map_err(|_|"Speech working audio could not be cleaned up.".to_string())?;}
    let duration=result.as_ref().ok().and_then(|(asset,_,_)|asset["duration"].as_f64());
    service.with_store(|store|store.record_request_measurement(snapshot,segment,"provider",elapsed,first_audio_ms,duration,if result.is_ok(){"completed"}else if cancel.is_cancelled(){"cancelled"}else{"failed"},dispatched.load(Ordering::SeqCst)))?;
    result
}


fn reference_audio(service:&Arc<SpeechService>,id:&str)->Result<Vec<u8>,String>{
    super::asset_io::open(service,id,None)?.read_bytes(16*1024*1024)
}

pub fn import_reference(service:&Arc<SpeechService>,input:&Value)->Result<Value,String>{
    let path=input["path"].as_str().ok_or("Choose a reference recording.")?;
    let transcript=input["transcript"].as_str().filter(|value|!value.trim().is_empty()).ok_or("Add an accurate reference transcript.")?;
    let rights=input["rightsEvidence"].as_str().filter(|value|!value.trim().is_empty()).ok_or("Record the voice owner's permission or applicable rights.")?;
    let path=Path::new(path);let metadata=std::fs::metadata(path).map_err(|_|"The reference recording could not be read.")?;if metadata.len()>64*1024*1024{return Err("Trim the reference below the local 64 MiB import guard.".to_string())}
    let(duration,rate,channels)=inspect_wav(path)?;
    super::asset_commit::import(service,path,duration,rate,channels,None,|store,asset|{store.connection.execute("INSERT INTO speech_references(asset_id,transcript,rights) VALUES(?1,?2,?3) ON CONFLICT(asset_id) DO UPDATE SET transcript=excluded.transcript,rights=excluded.rights",params![asset["id"].as_str(),transcript,rights]).map_err(|error|error.to_string())?;Ok(asset)})
}

pub async fn test_connection(service:&Arc<SpeechService>,input:&Value)->Result<Value,String>{
    let backend=input["backend"].as_str().ok_or("Choose a speech connection.")?;
    if backend=="drama3"{super::drama3::check(&service.app).await?;return Ok(super::drama3_model::connection());}
    let current=service.with_store(|store|settings::settings(store))?;
    let mut connection=current["connections"].as_array().and_then(|values|values.iter().find(|value|value["backend"]==backend)).cloned().ok_or("Choose a supported speech backend.")?;
    let url=match backend{"fish-cloud"=>"https://api.fish.audio/model?page_size=1".to_string(),"openai"=>"https://api.openai.com/v1/models".to_string(),"google"=>"https://generativelanguage.googleapis.com/v1beta/models".to_string(),"sglang"=>format!("{}/v1/models",connection["url"].as_str().ok_or("Set the runtime URL.")?),_=>return Err("Choose a supported speech backend.".to_string())};
    let mut request=service.client.get(url).timeout(std::time::Duration::from_secs(30));
    if let Some(key)=settings::credential(backend)?{request=if backend=="google"{request.header("x-goog-api-key",key)}else{request.bearer_auth(key)}}
    if backend=="fish-cloud"{request=request.header("model","drama-3")}
    let result=request.send().await;
    match result{Ok(response)=>{connection["healthy"]=json!(response.status().is_success());connection["error"]=if response.status().is_success(){Value::Null}else{json!(format!("Connection test failed (HTTP {}). Check the key and account access.",response.status().as_u16()))};},Err(_)=>{connection["healthy"]=json!(false);connection["error"]=json!("The speech backend could not be reached. Check its URL and network connection.")}}
    Ok(connection)
}
