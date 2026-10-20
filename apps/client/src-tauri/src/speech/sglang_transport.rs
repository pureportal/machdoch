use base64::{engine::general_purpose::STANDARD,Engine};
use futures_util::StreamExt;
use serde_json::{json,Value};
use std::{path::Path,sync::atomic::{AtomicBool,Ordering},time::{Duration,Instant}};
use tokio_util::sync::CancellationToken;
use super::{pcm_spool::{PcmAudio,PcmSpool},sse::SseDecoder};

const IDLE:Duration=Duration::from_secs(120);
const MAX_AUDIO:u64=512*1024*1024;
pub(crate) struct RenderResult{pub audio:PcmAudio,pub provider_response:Value,pub first_audio_ms:Option<f64>}

fn header<'a>(headers:&'a reqwest::header::HeaderMap,name:&str)->Result<&'a str,String>{headers.get(name).and_then(|value|value.to_str().ok()).ok_or_else(||format!("The self-hosted speech response is missing a valid {name} header."))}

pub(crate) async fn render(
    client:&reqwest::Client,url:&str,key:Option<&str>,mut request:Value,output:&Path,cancel:CancellationToken,dispatched:&AtomicBool,
    on_format:impl Fn(u32,u16)->Result<(),String>,
)->Result<RenderResult,String>{
    if cancel.is_cancelled(){return Err("Speech cancelled.".into());}
    if key.is_some_and(|key|key.trim().is_empty()||key.chars().any(char::is_control)){return Err("Save a valid self-hosted speech key without control characters.".into());}
    request["stream"]=json!(true);request["stream_format"]=json!("sse");request["response_format"]=json!("pcm");
    let started=Instant::now();let mut spool:Option<PcmSpool>=None;
    let work=async{
        let mut send=client.post(format!("{url}/v1/audio/speech")).header("accept","text/event-stream").timeout(Duration::from_secs(900)).json(&request);if let Some(key)=key{send=send.bearer_auth(key);}
        dispatched.store(true,Ordering::SeqCst);let response=send.send().await.map_err(|_|"The self-hosted speech runtime could not be reached.")?;
        if !response.status().is_success(){let status=response.status().as_u16();if (400..500).contains(&status)&&status!=408{dispatched.store(false,Ordering::SeqCst);}return Err(match status{401|403=>"The self-hosted speech runtime rejected authentication. Replace its key.",400|422=>"The self-hosted runtime rejected the script or references. Review the job.",404=>"The self-hosted speech endpoint is unavailable. Check its URL and pinned runtime.",429=>"The self-hosted runtime is at capacity. Wait before retrying.",_=>"The self-hosted speech runtime failed. Review the job before retrying."}.into());}
        if !header(response.headers(),"content-type")?.split(';').next().is_some_and(|mime|mime.trim().eq_ignore_ascii_case("text/event-stream")){return Err("The self-hosted runtime did not return the verified speech event stream.".into());}
        let rate=header(response.headers(),"x-sample-rate")?.parse::<u32>().ok().filter(|rate|(8000..=192000).contains(rate)).ok_or("The self-hosted speech sample rate is invalid.")?;
        if header(response.headers(),"x-channels")?!="1"||header(response.headers(),"x-bit-depth")?!="16"{return Err("The self-hosted speech contract requires mono PCM16.".into());}
        let request_id=header(response.headers(),"x-request-id")?.to_string();
        let header_ms=started.elapsed().as_secs_f64()*1000.0;let mut created=PcmSpool::create(output,rate,1)?;created.reserve_header().await?;spool=Some(created);on_format(rate,1)?;
        let mut stream=response.bytes_stream();let mut decoder=SseDecoder::default();let mut terminal=None;let mut bytes=0u64;
        loop{
            let next=tokio::time::timeout(IDLE,stream.next()).await.map_err(|_|"The self-hosted speech stream timed out.")?;let Some(fragment)=next else{break};let fragment=fragment.map_err(|_|"The self-hosted speech stream disconnected before completion.")?;
            for fragment in fragment.chunks(65_536){for event in decoder.push(fragment)?{
                if terminal.is_some(){return Err("The self-hosted speech stream continued after completion.".into());}
                match event["type"].as_str(){
                    Some("speech.audio.delta")=>{let encoded=event["audio"].as_str().ok_or("The self-hosted audio event is missing its samples.")?;let audio=STANDARD.decode(encoded).map_err(|_|"The self-hosted speech audio encoding is invalid.")?;bytes=bytes.checked_add(audio.len() as u64).filter(|bytes|*bytes<=MAX_AUDIO).ok_or("The self-hosted speech output exceeded the local 512 MiB guard.")?;spool.as_mut().ok_or("The speech spool is unavailable.")?.append(&audio).await?;},
                    Some("speech.audio.done")=>{terminal=Some(super::provider_response::sglang(&request_id,&event)?);},
                    Some("error")=>return Err("The self-hosted speech stream reported a generation error. Review the job before retrying.".into()),
                    _=>return Err("The self-hosted speech runtime returned an unsupported event.".into()),
                }
            }}
        }
        decoder.finish()?;let provider_response=terminal.ok_or("The self-hosted speech stream ended without confirming completion.")?;let audio=spool.as_mut().ok_or("The speech spool is unavailable.")?.finish().await?;let first_audio_ms=audio.first_audio_ms.map(|elapsed|elapsed+header_ms);Ok(RenderResult{audio,provider_response,first_audio_ms})
    };
    let result=tokio::select!{biased;_=cancel.cancelled()=>Err("Speech cancelled.".into()),result=tokio::time::timeout(Duration::from_secs(900),work)=>result.unwrap_or_else(|_|Err("The self-hosted speech request timed out.".into()))};
    let result=if cancel.is_cancelled(){Err("Speech cancelled.".into())}else{result};
    if let Some(spool)=&mut spool{if result.is_ok()&&!cancel.is_cancelled(){spool.retain();}else if let Err(cleanup)=spool.discard().await{return Err(format!("{} {cleanup}",result.err().unwrap_or_else(||"Speech cancelled.".into())));}}
    result
}

#[cfg(test)]
#[path="sglang_transport_tests.rs"]
mod tests;
