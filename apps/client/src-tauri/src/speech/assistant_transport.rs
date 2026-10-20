use futures_util::StreamExt;
use reqwest::{header::{HeaderName,HeaderValue},Client};
use serde_json::Value;
use std::{path::Path,sync::atomic::{AtomicBool,Ordering},time::Duration};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

const OPENAI_ENDPOINT:&str="https://api.openai.com/v1/audio/speech";
const GOOGLE_ENDPOINT:&str="https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent";

#[derive(Debug)]
pub struct RenderResult{pub duration:f64,pub sample_rate:u32,pub channels:u16,pub provider_response:Value}

pub async fn render(client:&Client,backend:&str,key:&str,request:&Value,output:&Path,cancel:CancellationToken,dispatched:&AtomicBool)->Result<RenderResult,String>{
    let endpoint=match backend{"openai"=>OPENAI_ENDPOINT,"google"=>GOOGLE_ENDPOINT,_=>return Err("Choose a supported assistant speech backend.".into())};
    render_at(client,backend,endpoint,key,request,output,cancel,dispatched).await
}

async fn render_at(client:&Client,backend:&str,endpoint:&str,key:&str,request:&Value,output:&Path,cancel:CancellationToken,dispatched:&AtomicBool)->Result<RenderResult,String>{
    if cancel.is_cancelled(){return Err("Speech cancelled.".into());}
    if key.trim().is_empty()||key.chars().any(char::is_control){return Err("Save a valid API key before rendering speech.".into());}
    let (header,value,limit)=match backend{
        "openai"=>(HeaderName::from_static("authorization"),format!("Bearer {key}"),512*1024*1024),
        "google"=>(HeaderName::from_static("x-goog-api-key"),key.into(),64*1024*1024),
        _=>return Err("Choose a supported assistant speech backend.".into()),
    };
    let value=HeaderValue::from_str(&value).map_err(|_|"Save a valid speech API key without control characters.")?;
    if !request.is_object(){return Err("Supply the pinned speech provider request.".into());}
    let file=std::fs::OpenOptions::new().create_new(true).write(true).open(output).map_err(|_|"Speech output could not be created. Check free disk space and choose an unused path.")?;
    let mut file=tokio::fs::File::from_std(file);
    let receive=async{
        let send=client.post(endpoint).header(header,value).json(request);
        dispatched.store(true,Ordering::SeqCst);
        let response=send.send().await.map_err(|_|"The speech provider connection failed. Review usage before retrying.")?;
        if !response.status().is_success(){
            let status=response.status().as_u16();if (400..500).contains(&status)&&status!=408{dispatched.store(false,Ordering::SeqCst);}
            return Err(crate::speech_error::response_error(if backend=="openai"{"OpenAI"}else{"Google"},status));
        }
        if response.content_length().is_some_and(|value|value>limit as u64){return Err("The speech response exceeds its local size guard. Review usage before retrying.".into());}
        let mut provider_response=if backend=="openai"{super::provider_response::openai(response.headers())?}else{Value::Null};
        let mut stream=response.bytes_stream();let mut count=0usize;
        if backend=="openai"{
            while let Some(chunk)=stream.next().await{
                let chunk=chunk.map_err(|_|"Speech audio was interrupted. Review usage before retrying.")?;
                if chunk.len()>limit-count{return Err("Speech audio exceeded the local 512 MiB response guard.".into());}count+=chunk.len();
                file.write_all(&chunk).await.map_err(|_|"Speech audio could not be saved. Check free disk space.")?;
            }
            file.flush().await.map_err(|_|"Speech audio could not be flushed.")?;file.sync_all().await.map_err(|_|"Speech audio could not be committed.")?;
        }else{
            let mut bytes=Vec::new();
            while let Some(chunk)=stream.next().await{
                let chunk=chunk.map_err(|_|"Google speech response was interrupted. Review usage before retrying.")?;
                if chunk.len()>limit-count{return Err("Google response exceeded the local 64 MiB JSON guard.".into());}count+=chunk.len();bytes.extend_from_slice(&chunk);
            }
            let response:Value=serde_json::from_slice(&bytes).map_err(|_|"Google returned malformed speech response data. Review usage before retrying.")?;drop(bytes);
            provider_response=super::provider_response::google(&response)?;
            let audio=super::google_audio::pcm(&response)?;drop(response);
            let header=super::pcm::wav_header(audio.len() as u64)?;
            file.write_all(&header).await.map_err(|_|"Speech WAV header could not be saved.")?;
            for chunk in audio.chunks(64*1024){file.write_all(chunk).await.map_err(|_|"Speech audio could not be saved. Check free disk space.")?;}
            file.flush().await.map_err(|_|"Speech audio could not be flushed.")?;file.sync_all().await.map_err(|_|"Speech audio could not be committed.")?;
        }
        let path=output.to_owned();let (duration,sample_rate,channels)=tokio::task::spawn_blocking(move||super::reference_audio::inspect_wav(&path)).await.map_err(|_|"Speech audio validation could not finish.")?.map_err(|_|"The provider returned invalid or incomplete WAV audio. Review usage before retrying.".to_string())?;
        Ok(RenderResult{duration,sample_rate,channels,provider_response})
    };
    let result=tokio::select!{biased;_=cancel.cancelled()=>Err("Speech cancelled.".into()),result=tokio::time::timeout(Duration::from_secs(900),receive)=>result.unwrap_or_else(|_|Err("Speech request timed out. Review usage before retrying.".into()))};
    drop(file);
    if result.is_err(){tokio::fs::remove_file(output).await.map_err(|_|"Incomplete speech audio could not be removed. Clean the speech working directory before retrying.")?;}
    result
}

#[cfg(test)]
#[path="assistant_transport_tests.rs"]
mod tests;
