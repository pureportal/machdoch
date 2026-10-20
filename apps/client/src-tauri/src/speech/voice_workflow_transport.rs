use base64::{engine::general_purpose::STANDARD,Engine};
use futures_util::StreamExt;
use reqwest::{Client,multipart};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::sync::atomic::{AtomicBool,Ordering};
use tokio_util::sync::CancellationToken;

pub async fn request(client:&Client,key:&str,snapshot:&Value,read:impl FnMut(&str)->Result<Vec<u8>,String>,cancel:CancellationToken,dispatched:&AtomicBool)->Result<Value,String>{
    let endpoint=if snapshot["operation"]=="designVoice"{"https://api.fish.audio/v1/voice-design"}else{"https://api.fish.audio/model"};
    request_at(client,key,endpoint,snapshot,read,cancel,dispatched).await
}

async fn request_at(client:&Client,key:&str,endpoint:&str,snapshot:&Value,mut read:impl FnMut(&str)->Result<Vec<u8>,String>,cancel:CancellationToken,dispatched:&AtomicBool)->Result<Value,String>{
    if cancel.is_cancelled(){return Err("Voice request cancelled.".into());}
    if key.trim().is_empty()||key.chars().any(char::is_control)||reqwest::header::HeaderValue::from_str(&format!("Bearer {key}")).is_err(){return Err("Save a valid Fish Audio API key before starting voice work.".into());}
    let design=snapshot["operation"]=="designVoice";
    if !design&&snapshot["operation"]!="createVoice"{return Err("Choose a supported Fish voice operation.".into());}
    let mut request=client.post(endpoint).bearer_auth(key);
    if design{
        request=request.header("model","voice-design-1").json(&json!({"instruction":snapshot["input"]["description"],"reference_text":snapshot["input"]["text"],"n":2}));
    }else{
        let mut form=multipart::Form::new().text("type","tts").text("title",snapshot["input"]["name"].as_str().ok_or("The pinned voice name is missing.")?.to_owned())
            .text("train_mode","fast").text("visibility","private").text("enhance_audio_quality","false").text("generate_sample","false");
        let mut total=0usize;
        for (index,reference) in snapshot["references"].as_array().ok_or("The pinned voice references are missing.")?.iter().enumerate(){
            let id=reference["asset"]["id"].as_str().ok_or("The reference identity is missing.")?;
            let bytes=read(id)?;total+=bytes.len();
            if bytes.is_empty()||bytes.len()>16*1024*1024||total>128*1024*1024{return Err("The voice references exceed their admitted upload guards.".into());}
            if format!("{:x}",Sha256::digest(&bytes))!=reference["asset"]["sha256"].as_str().ok_or("The pinned reference hash is missing.")?{return Err("A voice reference changed after admission. Reimport it before creating a voice.".into());}
            form=form.part("voices",multipart::Part::bytes(bytes).file_name(format!("reference-{index}.wav")).mime_str("audio/wav").map_err(|_|"The voice upload could not be prepared.")?)
                .text("texts",reference["transcript"].as_str().ok_or("The pinned reference transcript is missing.")?.to_owned());
        }
        if let Some(signature)=snapshot["candidate"]["voice_design_signature"].as_str(){form=form.text("voice_design_signatures",signature.to_owned());}
        request=request.multipart(form);
    }
    let receive=async{
        dispatched.store(true,Ordering::SeqCst);
        let response=request.send().await.map_err(|_|"The Fish voice connection was interrupted. Review saved results and account usage before retrying.")?;
        if !response.status().is_success(){let status=response.status().as_u16();if (400..500).contains(&status)&&status!=408{dispatched.store(false,Ordering::SeqCst);}return Err(crate::speech_error::response_error("Fish Audio",status));}
        let limit=if design{64*1024*1024}else{8*1024*1024};
        if response.content_length().is_some_and(|length|length>limit as u64){return Err("The Fish voice response exceeds its local size guard. Review account usage before retrying.".into());}
        let mut stream=response.bytes_stream();let mut bytes=Vec::new();
        while let Some(chunk)=stream.next().await{let chunk=chunk.map_err(|_|"The Fish voice response was truncated. Review saved results and usage before retrying.")?;if chunk.len()>limit-bytes.len(){return Err("The Fish voice response exceeded its local size guard.".into());}bytes.extend_from_slice(&chunk);}
        let mut value:Value=serde_json::from_slice(&bytes).map_err(|_|"Fish returned malformed voice data. Review account usage before retrying.")?;
        let response_hash=format!("{:x}",Sha256::digest(bytes));
        if design{
            let candidates=value["candidates"].as_array_mut().filter(|candidates|candidates.len()==2).ok_or("Fish did not return both requested candidates. Review account usage before generating again.")?;
            let mut ids=std::collections::HashSet::new();let mut indexes=std::collections::HashSet::new();
            for candidate in candidates.iter_mut(){
                let id=candidate["id"].as_str().filter(|id|!id.is_empty()&&id.len()<=128&&id.bytes().all(|byte|byte.is_ascii_alphanumeric()||b"_-".contains(&byte))).ok_or("Fish returned an invalid candidate identity.")?;
                if !ids.insert(id.to_owned()){return Err("Fish returned duplicate candidate identities.".into());}
                if candidate.get("text").is_some_and(|text|!text.is_null()&&*text!=snapshot["input"]["text"]){return Err("Fish returned a different preview sentence. Review the request before generating again.".into());}
                let index=candidate["index"].as_u64().ok_or("Fish returned an invalid candidate index.")?;
                if !indexes.insert(index){return Err("Fish returned duplicate candidate indices.".into());}
                let audio=candidate["audio_base64"].as_str().filter(|audio|audio.len()<=24*1024*1024).ok_or("Fish returned invalid or oversized candidate audio.")?;
                let decoded=STANDARD.decode(audio).map_err(|_|"Fish returned invalid candidate audio encoding.")?;
                if decoded.is_empty()||decoded.len()>16*1024*1024{return Err("Fish candidate audio exceeded its local size guard.".into());}
                candidate["responseSha256"]=json!(response_hash);
                let mut metadata=candidate.clone();metadata.as_object_mut().ok_or("The candidate metadata is invalid.")?.remove("audio_base64");
                if serde_json::to_vec(&metadata).map_err(|_|"The candidate metadata could not be encoded.")?.len()>65536{return Err("The candidate metadata exceeded its local size guard.".into());}
            }
            candidates.sort_by_key(|candidate|candidate["index"].as_u64().unwrap());
        }
        Ok(value)
    };
    tokio::select!{biased;_=cancel.cancelled()=>Err("Voice request cancelled.".into()),result=tokio::time::timeout(std::time::Duration::from_secs(180),receive)=>result.unwrap_or_else(|_|Err("The Fish voice request timed out. Review saved results and usage before retrying.".into()))}
}

#[cfg(test)]
#[path="voice_workflow_transport_tests.rs"]
mod tests;
