use super::*;
use tokio::{io::{AsyncReadExt,AsyncWriteExt},net::{TcpListener,TcpStream}};

struct Output(std::path::PathBuf);
impl Output{fn new()->Self{Self(std::env::temp_dir().join(format!("speech-sglang-{}.wav",crate::speech::identifier().unwrap())))}}
impl Drop for Output{fn drop(&mut self){if self.0.exists(){std::fs::remove_file(&self.0).unwrap();}}}

async fn request(listener:TcpListener)->(TcpStream,String,Value){
    let (mut socket,_)=listener.accept().await.unwrap();let mut bytes=Vec::new();let mut buffer=[0u8;1024];
    loop{
        let count=socket.read(&mut buffer).await.unwrap();assert!(count>0);bytes.extend_from_slice(&buffer[..count]);assert!(bytes.len()<16384);
        if let Some(end)=bytes.windows(4).position(|window|window==b"\r\n\r\n"){
            let header=String::from_utf8(bytes[..end].to_vec()).unwrap();let length=header.lines().find_map(|line|line.to_ascii_lowercase().strip_prefix("content-length:").map(|value|value.trim().parse::<usize>().unwrap())).unwrap();
            if bytes.len()>=end+4+length{return (socket,header,serde_json::from_slice(&bytes[end+4..end+4+length]).unwrap());}
        }
    }
}

fn headers()->&'static str{"Content-Type: text/event-stream\r\nX-Sample-Rate: 44100\r\nX-Channels: 1\r\nX-Bit-Depth: 16\r\nX-Request-Id: runtime-request\r\n"}
fn done(reason:&str)->String{format!("data: {}\n\n",json!({"type":"speech.audio.done","finish_reason":reason,"usage":{"input_tokens":0,"output_tokens":3,"total_tokens":3}}))}
fn delta(audio:&[u8])->String{format!("data: {}\n\n",json!({"type":"speech.audio.delta","audio":STANDARD.encode(audio)}))}

#[tokio::test]
async fn native_sglang_sse_uses_exact_request_and_sample_headers_and_preserves_returned_usage(){
    let output=Output::new();let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}",listener.local_addr().unwrap());let body=format!("{}{}{}{}",delta(&[0]),delta(&[128,255]),delta(&[127,0,0]),done("stop"));
    let server=tokio::spawn(async move{let (mut socket,header,body_request)=request(listener).await;socket.write_all(format!("HTTP/1.1 200 OK\r\n{}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n",headers()).as_bytes()).await.unwrap();for byte in body.bytes(){socket.write_all(format!("1\r\n{}\r\n",char::from(byte)).as_bytes()).await.unwrap();}socket.write_all(b"0\r\n\r\n").await.unwrap();(header,body_request)});
    let observed=std::sync::Mutex::new(None);let dispatched=AtomicBool::new(false);let result=render(&reqwest::Client::new(),&url,Some("synthetic-key"),json!({"model":"fishaudio/drama-3","input":"Hallo 世界.","references":[{"audio_path":"data:audio/wav;base64,AA==","text":"Reference"}]}),&output.0,CancellationToken::new(),&dispatched,|rate,channels|{*observed.lock().unwrap()=Some((rate,channels));Ok(())}).await.unwrap();
    assert_eq!(*observed.lock().unwrap(),Some((44100,1)));assert_eq!(result.audio.frames,3);assert!(result.first_audio_ms.is_some());assert_eq!(result.provider_response,json!({"provider":"sglang","requestId":"runtime-request","finishReason":"stop","usage":{"input_tokens":0,"output_tokens":3,"total_tokens":3}}));
    let (header,request)=server.await.unwrap();let header=header.to_ascii_lowercase();assert!(header.starts_with("post /v1/audio/speech http/1.1\r\n"));assert!(header.contains("authorization: bearer synthetic-key\r\n"));assert_eq!(request["model"],"fishaudio/drama-3");assert_eq!(request["input"],"Hallo 世界.");assert_eq!(request["stream"],true);assert_eq!(request["stream_format"],"sse");assert_eq!(request["response_format"],"pcm");assert_eq!(super::super::reference_audio::inspect_wav(&output.0).unwrap(),(3.0/44100.0,44100,1));
}

#[tokio::test]
async fn sglang_stream_rejects_unknown_or_truncated_completion_and_invalid_formats_without_a_transport_fallback(){
    for (status,response_headers,body) in [
        (200,headers().to_owned(),delta(&[0,0])),
        (200,headers().to_owned(),format!("{}{}",delta(&[0,0]),done("length"))),
        (200,headers().to_owned(),format!("{}data: {{\"type\":\"error\",\"message\":\"PRIVATE\"}}\n\n",delta(&[0,0]))),
        (200,headers().to_owned(),format!("{}{}",delta(&[0]),done("stop"))),
        (200,headers().to_owned(),format!("{}{}",done("stop"),delta(&[0,0]))),
        (200,headers().to_owned(),"data: {\"type\":\"speech.audio.delta\",\"audio\":\"%%\"}\n\n".into()),
        (200,headers().replace("X-Channels: 1","X-Channels: 2"),format!("{}{}",delta(&[0,0]),done("stop"))),
        (200,headers().replace("text/event-stream","audio/wav"),format!("{}{}",delta(&[0,0]),done("stop"))),
        (401,headers().to_owned(),String::new()),
        (429,headers().to_owned(),String::new()),
    ]{
        let output=Output::new();let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}",listener.local_addr().unwrap());
        let server=tokio::spawn(async move{let (mut socket,_,_)=request(listener).await;socket.write_all(format!("HTTP/1.1 {status} Result\r\n{response_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();});
        let dispatched=AtomicBool::new(false);let error=render(&reqwest::Client::new(),&url,None,json!({"model":"fishaudio/drama-3","input":"Hello"}),&output.0,CancellationToken::new(),&dispatched,|_,_|Ok(())).await.err().expect("Invalid stream must fail");assert!(!error.contains("PRIVATE"));assert!(!output.0.exists());assert_eq!(dispatched.load(Ordering::SeqCst),status==200);server.await.unwrap();
    }
}

#[tokio::test]
async fn self_hosted_pcm_is_readable_before_the_upstream_completion_event(){
    let output=Output::new();let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}",listener.local_addr().unwrap());
    let (release,wait)=tokio::sync::oneshot::channel();
    let server=tokio::spawn(async move{
        let (mut socket,_,_)=request(listener).await;
        socket.write_all(format!("HTTP/1.1 200 OK\r\n{}Transfer-Encoding: chunked\r\n\r\n",headers()).as_bytes()).await.unwrap();
        let first=delta(&[1,0,2,0]);socket.write_all(format!("{:x}\r\n{first}\r\n",first.len()).as_bytes()).await.unwrap();
        wait.await.unwrap();let last=done("stop");socket.write_all(format!("{:x}\r\n{last}\r\n0\r\n\r\n",last.len()).as_bytes()).await.unwrap();
    });
    let path=output.0.clone();let rendering=tokio::spawn(async move{
        let dispatched=AtomicBool::new(false);render(&reqwest::Client::new(),&url,None,json!({"model":"fishaudio/drama-3","input":"Hello"}),&path,CancellationToken::new(),&dispatched,|_,_|Ok(())).await
    });
    let mut poll=tokio::time::interval(Duration::from_millis(10));
    tokio::time::timeout(Duration::from_secs(5),async{
        loop{poll.tick().await;if tokio::fs::metadata(&output.0).await.is_ok_and(|metadata|metadata.len()>=48){break;}assert!(!rendering.is_finished());}
    }).await.unwrap();
    assert!(!rendering.is_finished());assert_eq!(&tokio::fs::read(&output.0).await.unwrap()[44..],[1,0,2,0]);
    release.send(()).unwrap();let result=rendering.await.unwrap().unwrap();assert_eq!(result.audio.frames,2);server.await.unwrap();
    assert_eq!(super::super::reference_audio::inspect_wav(&output.0).unwrap(),(2.0/44100.0,44100,1));
}

#[tokio::test]
async fn cancelling_a_self_hosted_stream_closes_the_upstream_connection_and_removes_working_audio(){
    let output=Output::new();let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();let url=format!("http://{}",listener.local_addr().unwrap());let cancel=CancellationToken::new();
    let server=tokio::spawn(async move{let (mut socket,_,_)=request(listener).await;socket.write_all(format!("HTTP/1.1 200 OK\r\n{}Transfer-Encoding: chunked\r\n\r\n",headers()).as_bytes()).await.unwrap();let mut bytes=[0u8;32];let closed=tokio::time::timeout(Duration::from_secs(5),socket.read(&mut bytes)).await.unwrap();match closed{Ok(count)=>assert_eq!(count,0),Err(error)=>assert!(matches!(error.kind(),std::io::ErrorKind::ConnectionReset|std::io::ErrorKind::ConnectionAborted|std::io::ErrorKind::BrokenPipe))};});
    let (send,receive)=tokio::sync::oneshot::channel();let send=std::sync::Mutex::new(Some(send));let observed=cancel.clone();let cancelling=tokio::spawn(async move{receive.await.unwrap();observed.cancel();});
    let dispatched=AtomicBool::new(false);assert!(render(&reqwest::Client::new(),&url,None,json!({"model":"fishaudio/drama-3","input":"Hello"}),&output.0,cancel,&dispatched,|_,_|{send.lock().unwrap().take().unwrap().send(()).unwrap();Ok(())}).await.is_err());assert!(!output.0.exists());assert!(dispatched.load(Ordering::SeqCst));cancelling.await.unwrap();server.await.unwrap();
}
