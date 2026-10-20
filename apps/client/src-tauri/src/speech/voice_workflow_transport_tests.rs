use super::*;
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};

async fn read_request(socket:&mut tokio::net::TcpStream)->(String,Vec<u8>){
    let mut bytes=Vec::new();let end=loop{let mut buffer=[0u8;1024];let count=socket.read(&mut buffer).await.unwrap();assert!(count>0&&bytes.len()<1024*1024);bytes.extend_from_slice(&buffer[..count]);if let Some(end)=bytes.windows(4).position(|bytes|bytes==b"\r\n\r\n"){break end+4;}};
    let headers=String::from_utf8(bytes[..end].to_vec()).unwrap().to_ascii_lowercase();let length:usize=headers.lines().find_map(|line|line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
    while bytes.len()<end+length{let mut buffer=[0u8;1024];let count=socket.read(&mut buffer).await.unwrap();assert!(count>0);bytes.extend_from_slice(&buffer[..count]);}
    (headers,bytes[end..end+length].to_vec())
}

async fn serve(listener:TcpListener,status:u16,response:Value)->(String,Vec<u8>){
    let (mut socket,_)=listener.accept().await.unwrap();let request=read_request(&mut socket).await;let body=response.to_string();socket.write_all(format!("HTTP/1.1 {status} Response\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();request
}

fn design()->Value{json!({"operation":"designVoice","input":{"description":"Warm narrator","text":"Hallo 世界."}})}
fn candidates()->Value{json!({"candidates":(0..2).map(|index|json!({"id":format!("candidate-{index}"),"index":index,"text":"Hallo 世界.","audio_base64":STANDARD.encode([1,2]),"voice_design_signature":format!("signed-{index}")})).collect::<Vec<_>>()})}

#[tokio::test]
async fn voice_workflow_transport_sends_the_separate_design_model_and_retains_both_candidates_and_signatures(){
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/v1/voice-design",listener.local_addr().unwrap());let server=tokio::spawn(serve(listener,200,candidates()));let dispatched=AtomicBool::new(false);
    let response=request_at(&Client::new(),"wire-key",&endpoint,&design(),|_|panic!("Design must not upload references"),CancellationToken::new(),&dispatched).await.unwrap();
    assert_eq!(response["candidates"][0]["voice_design_signature"],"signed-0");assert_eq!(response["candidates"][1]["voice_design_signature"],"signed-1");assert_eq!(response["candidates"][0]["responseSha256"].as_str().unwrap().len(),64);assert!(dispatched.load(Ordering::SeqCst));
    let (headers,body)=server.await.unwrap();assert!(headers.contains("\r\nmodel: voice-design-1\r\n"));assert!(!headers.contains("drama-3"));assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(),json!({"instruction":"Warm narrator","reference_text":"Hallo 世界.","n":2}));
}

#[tokio::test]
async fn voice_workflow_transport_uploads_the_unchanged_signed_candidate_with_private_visibility_and_no_permission_record(){
    let bytes=b"Cleared synthetic WAV bytes";let hash=format!("{:x}",Sha256::digest(bytes));let snapshot=json!({"operation":"createVoice","input":{"name":"Private voice","rightsEvidence":"private-permission-record"},"references":[{"asset":{"id":hash,"sha256":hash},"transcript":"Exact candidate transcript"}],"candidate":{"voice_design_signature":"provider-authenticity-signature"}});
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/model",listener.local_addr().unwrap());let server=tokio::spawn(serve(listener,201,json!({"_id":"created"})));let dispatched=AtomicBool::new(false);
    assert_eq!(request_at(&Client::new(),"wire-key",&endpoint,&snapshot,|id|{assert_eq!(id,hash);Ok(bytes.to_vec())},CancellationToken::new(),&dispatched).await.unwrap()["_id"],"created");
    let (headers,body)=server.await.unwrap();assert!(headers.contains("content-type: multipart/form-data; boundary="));let body=String::from_utf8_lossy(&body);for (field,value) in [("visibility","private"),("train_mode","fast"),("texts","Exact candidate transcript"),("voice_design_signatures","provider-authenticity-signature"),("enhance_audio_quality","false"),("generate_sample","false")]{assert!(body.contains(&format!("name=\"{field}\"\r\n\r\n{value}")),"{field}");}assert!(body.contains("Cleared synthetic WAV bytes"));assert!(!body.contains("private-permission-record"));
    let unsent=AtomicBool::new(false);assert!(request_at(&Client::new(),"wire-key",&endpoint,&snapshot,|_|Ok(vec![9]),CancellationToken::new(),&unsent).await.unwrap_err().contains("changed"));assert!(!unsent.load(Ordering::SeqCst));
}

#[tokio::test]
async fn voice_workflow_transport_classifies_known_rejections_and_ambiguous_or_malformed_results_without_exposing_provider_content(){
    for (status,response,uncertain) in [(402,json!({"message":"private-provider-detail"}),false),(429,json!({"message":"private-provider-detail"}),false),(408,json!({"message":"private-provider-detail"}),true),(503,json!({"message":"private-provider-detail"}),true),(200,json!({"candidates":[]}),true)]{
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/voice-design",listener.local_addr().unwrap());let server=tokio::spawn(serve(listener,status,response));let dispatched=AtomicBool::new(false);
        let error=request_at(&Client::new(),"wire-key",&endpoint,&design(),|_|unreachable!(),CancellationToken::new(),&dispatched).await.unwrap_err();assert!(!error.contains("private-provider-detail"));assert_eq!(dispatched.load(Ordering::SeqCst),uncertain);server.await.unwrap();
    }
}

#[tokio::test]
async fn voice_workflow_transport_cancels_an_inflight_request_and_keeps_its_charge_uncertainty(){
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/voice-design",listener.local_addr().unwrap());let (started,ready)=tokio::sync::oneshot::channel();
    let server=tokio::spawn(async move{let (mut socket,_)=listener.accept().await.unwrap();read_request(&mut socket).await;started.send(()).unwrap();let mut end=[0u8;1];tokio::time::timeout(std::time::Duration::from_secs(5),socket.read(&mut end)).await.unwrap().unwrap()});
    let cancel=CancellationToken::new();let worker_cancel=cancel.clone();let dispatched=std::sync::Arc::new(AtomicBool::new(false));let worker_dispatched=dispatched.clone();
    let worker=tokio::spawn(async move{request_at(&Client::new(),"wire-key",&endpoint,&design(),|_|unreachable!(),worker_cancel,&worker_dispatched).await});ready.await.unwrap();cancel.cancel();assert!(worker.await.unwrap().unwrap_err().contains("cancelled"));assert!(dispatched.load(Ordering::SeqCst));assert_eq!(server.await.unwrap(),0);
}


#[tokio::test]
async fn voice_workflow_transport_accepts_optional_preview_metadata_and_orders_candidates_without_inventing_signatures(){
    let mut response=candidates();
    for candidate in response["candidates"].as_array_mut().unwrap(){candidate.as_object_mut().unwrap().remove("text");candidate.as_object_mut().unwrap().remove("voice_design_signature");}
    response["candidates"].as_array_mut().unwrap().reverse();
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/voice-design",listener.local_addr().unwrap());let server=tokio::spawn(serve(listener,200,response));
    let saved=request_at(&Client::new(),"wire-key",&endpoint,&design(),|_|unreachable!(),CancellationToken::new(),&AtomicBool::new(false)).await.unwrap();server.await.unwrap();
    assert_eq!(saved["candidates"][0]["id"],"candidate-0");assert_eq!(saved["candidates"][1]["id"],"candidate-1");assert!(saved["candidates"][0].get("text").is_none());assert!(saved["candidates"][0].get("voice_design_signature").is_none());
    let bytes=b"Synthetic candidate audio";let hash=format!("{:x}",Sha256::digest(bytes));
    let snapshot=json!({"operation":"createVoice","input":{"name":"Private candidate"},"references":[{"asset":{"id":hash,"sha256":hash},"transcript":"Saved requested preview"}],"candidate":saved["candidates"][0]});
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/model",listener.local_addr().unwrap());let server=tokio::spawn(serve(listener,201,json!({"_id":"created"})));
    request_at(&Client::new(),"wire-key",&endpoint,&snapshot,|_|Ok(bytes.to_vec()),CancellationToken::new(),&AtomicBool::new(false)).await.unwrap();let (_,body)=server.await.unwrap();let body=String::from_utf8_lossy(&body);assert!(body.contains("Saved requested preview"));assert!(!body.contains("voice_design_signatures"));
}
