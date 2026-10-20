use super::*;
use serde_json::json;
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::TcpListener};
use base64::{engine::general_purpose::STANDARD,Engine};

struct Output(std::path::PathBuf);
impl Output{fn new()->Self{let mut bytes=[0u8;16];getrandom::fill(&mut bytes).unwrap();Self(std::env::temp_dir().join(format!("assistant-speech-{:x}.wav",u128::from_le_bytes(bytes))))}}
impl Drop for Output{fn drop(&mut self){if self.0.exists(){std::fs::remove_file(&self.0).unwrap();}}}

async fn capture(listener:TcpListener,status:u16,body:Vec<u8>,declared:Option<usize>)->(String,Value){
    let (mut socket,_)=listener.accept().await.unwrap();let mut bytes=Vec::new();
    let end=loop{let mut fragment=[0u8;1024];let count=socket.read(&mut fragment).await.unwrap();assert!(count>0);bytes.extend_from_slice(&fragment[..count]);if let Some(end)=bytes.windows(4).position(|value|value==b"\r\n\r\n"){break end+4}};
    let headers=String::from_utf8(bytes[..end].to_vec()).unwrap().to_ascii_lowercase();
    let length:usize=headers.lines().find_map(|line|line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
    while bytes.len()<end+length{let mut fragment=[0u8;1024];let count=socket.read(&mut fragment).await.unwrap();assert!(count>0);bytes.extend_from_slice(&fragment[..count]);}
    socket.write_all(format!("HTTP/1.1 {status} Response\r\nx-request-id: captured-request\r\nopenai-processing-ms: 12.5\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",declared.unwrap_or(body.len())).as_bytes()).await.unwrap();
    for fragment in body.chunks(3){if socket.write_all(fragment).await.is_err(){break;}}
    (headers,serde_json::from_slice(&bytes[end..end+length]).unwrap())
}

#[tokio::test]
async fn assistant_transports_post_the_pinned_payload_and_save_validated_audio_without_base64_roundtrips(){
    for backend in ["openai","google"]{
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/speech",listener.local_addr().unwrap());
        let bytes=if backend=="openai"{[super::super::pcm::wav_header(4).unwrap().as_slice(),&[1,0,2,0]].concat()}else{serde_json::to_vec(&json!({"modelVersion":"gemini-3.1-flash-tts-preview","responseId":"captured-google-response","usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":8,"totalTokenCount":11},"candidates":[{"finishReason":"STOP","content":{"parts":[{"inlineData":{"mimeType":"audio/L16;rate=24000","data":STANDARD.encode([1,0])}},{"inlineData":{"mimeType":"audio/L16;rate=24000","data":STANDARD.encode([2,0])}}]}}]})).unwrap()};
        let server=tokio::spawn(capture(listener,200,bytes,None));let output=Output::new();let dispatched=AtomicBool::new(false);let request=json!({"fixture":"exact immutable request"});
        let result=render_at(&Client::new(),backend,&endpoint,"fixture-key",&request,&output.0,CancellationToken::new(),&dispatched).await.unwrap();
        let (duration,rate,channels)=(result.duration,result.sample_rate,result.channels);
        if backend=="openai"{assert_eq!(result.provider_response,json!({"provider":"openai","requestId":"captured-request","processingMs":12.5}));}else{assert_eq!(result.provider_response,json!({"provider":"google","modelVersion":"gemini-3.1-flash-tts-preview","responseId":"captured-google-response","usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":8,"totalTokenCount":11}}));}
        assert_eq!(rate,24_000);assert_eq!(channels,1);assert_eq!(duration,2.0/24_000.0);assert!(dispatched.load(Ordering::SeqCst));assert_eq!(&std::fs::read(&output.0).unwrap()[44..],&[1,0,2,0]);
        let (headers,body)=server.await.unwrap();assert_eq!(body,request);assert!(!headers.lines().next().unwrap().contains("fixture-key"));
        assert!(headers.contains(if backend=="openai"{"authorization: bearer fixture-key"}else{"x-goog-api-key: fixture-key"}));
    }
}

#[tokio::test]
async fn assistant_rejections_are_known_while_truncation_malformed_audio_and_server_failure_keep_billing_uncertainty(){
    for (backend,status,body,declared,uncertain) in [("openai",401,b"private provider content".to_vec(),None,false),("openai",402,Vec::new(),None,false),("openai",429,Vec::new(),None,false),("openai",503,Vec::new(),None,true),("openai",200,b"not WAV".to_vec(),None,true),("openai",200,Vec::new(),Some(512*1024*1024+1),true),("openai",200,b"RIFF".to_vec(),Some(100),true),("google",200,b"{".to_vec(),None,true),("google",200,b"{}".to_vec(),None,true),("google",200,Vec::new(),Some(64*1024*1024+1),true)]{
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/speech",listener.local_addr().unwrap());let server=tokio::spawn(capture(listener,status,body,declared));
        let output=Output::new();let dispatched=AtomicBool::new(false);let error=render_at(&Client::new(),backend,&endpoint,"key",&json!({}),&output.0,CancellationToken::new(),&dispatched).await.unwrap_err();
        assert_eq!(dispatched.load(Ordering::SeqCst),uncertain,"{status}");assert!(!output.0.exists());assert!(!error.contains("private provider content"));server.await.unwrap();
    }
}

#[tokio::test]
async fn assistant_preflight_does_not_dispatch_or_overwrite_and_in_flight_cancellation_closes_the_connection(){
    let output=Output::new();let dispatched=AtomicBool::new(false);
    for key in ["","bad\nkey"]{assert!(render_at(&Client::new(),"openai","http://127.0.0.1:1",key,&json!({}),&output.0,CancellationToken::new(),&dispatched).await.is_err());assert!(!dispatched.load(Ordering::SeqCst));assert!(!output.0.exists());}
    std::fs::write(&output.0,b"preserve").unwrap();assert!(render_at(&Client::new(),"openai","http://127.0.0.1:1","key",&json!({}),&output.0,CancellationToken::new(),&dispatched).await.is_err());assert_eq!(std::fs::read(&output.0).unwrap(),b"preserve");assert!(!dispatched.load(Ordering::SeqCst));std::fs::remove_file(&output.0).unwrap();
    let cancelled=CancellationToken::new();cancelled.cancel();assert!(render_at(&Client::new(),"google","http://127.0.0.1:1","key",&json!({}),&output.0,cancelled,&dispatched).await.is_err());assert!(!dispatched.load(Ordering::SeqCst));
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let endpoint=format!("http://{}/speech",listener.local_addr().unwrap());let (ready,waiting)=tokio::sync::oneshot::channel();
    let server=tokio::spawn(async move{let (mut socket,_)=listener.accept().await.unwrap();let mut bytes=[0u8;4096];assert!(socket.read(&mut bytes).await.unwrap()>0);ready.send(()).unwrap();loop{if socket.read(&mut bytes).await.unwrap()==0{break;}}});
    let cancel=CancellationToken::new();let stopper=cancel.clone();let stop=async move{waiting.await.unwrap();stopper.cancel();};let client=Client::new();let request=json!({});
    let (result,())=tokio::join!(render_at(&client,"google",&endpoint,"key",&request,&output.0,cancel,&dispatched),stop);
    assert!(result.unwrap_err().contains("cancelled"));assert!(dispatched.load(Ordering::SeqCst));assert!(!output.0.exists());tokio::time::timeout(Duration::from_secs(3),server).await.unwrap().unwrap();
}
