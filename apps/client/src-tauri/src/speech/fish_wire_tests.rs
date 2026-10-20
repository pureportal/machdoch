use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct Output(PathBuf);


impl Output {
    fn new() -> Self {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes).unwrap();
        let name: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        Self(std::env::temp_dir().join(format!("speech-wire-{name}.wav")))
    }
}

impl Drop for Output {
    fn drop(&mut self) { let _ = std::fs::remove_file(&self.0); }
}

async fn capture_http(listener: TcpListener, status: u16, truncated: bool) -> (String, Vec<u8>) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut bytes = Vec::new();
    let header_end = loop {
        let mut buffer = [0u8; 1024];
        let count = socket.read(&mut buffer).await.unwrap();
        assert!(count > 0 && bytes.len() < 2 * 1024 * 1024);
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(position) = bytes.windows(4).position(|part| part == b"\r\n\r\n") { break position + 4; }
    };
    let headers = String::from_utf8(bytes[..header_end].to_vec()).unwrap().to_ascii_lowercase();
    let length: usize = headers.lines().find_map(|line| line.strip_prefix("content-length:")).unwrap().trim().parse().unwrap();
    while bytes.len() < header_end + length {
        let mut buffer = [0u8; 1024];
        let count = socket.read(&mut buffer).await.unwrap();
        assert!(count > 0);
        bytes.extend_from_slice(&buffer[..count]);
    }
    let event = json!({"audio_base64":STANDARD.encode([1u8,0,2,0]),"chunk_seq":0,"chunk_audio_offset_sec":0,"alignment":null});
    let body = format!("data: {event}\r\n\r\n");
    socket.write_all(format!("HTTP/1.1 {status} Response\r\ncontent-type: text/event-stream\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",body.len()+if truncated{32}else{0}).as_bytes()).await.unwrap();
    (headers, bytes[header_end..header_end+length].to_vec())
}

async fn sse_round_trip(inline: bool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/tts/stream/with-timestamp",listener.local_addr().unwrap());
    let server = tokio::spawn(capture_http(listener,200,false));
    let mut input = json!({"text":"Hello 世界","model":"drama-3","normalize":false,"language":"es-MX"});
    if inline { input["references"] = json!([{"audio":STANDARD.encode([9u8,8,7]),"text":"A cleared recording"}]); }
    let output = Output::new();
    let mut spool = PcmSpool::create(&output.0,SAMPLE_RATE,CHANNELS).unwrap();
    let received = tokio::time::timeout(Duration::from_secs(5),receive_sse(&reqwest::Client::new(),&endpoint,"wire-test-key",prepare_request(input,false).unwrap(),&mut spool,&AtomicBool::new(false))).await.unwrap();
    let rendered = settle(spool,received,&CancellationToken::new()).await.unwrap();
    assert_eq!(rendered.frames,2);
    let (headers,body)=server.await.unwrap();
    assert!(headers.contains("\r\nmodel: drama-3\r\n"));
    assert!(headers.contains("\r\nauthorization: bearer wire-test-key\r\n"));
    assert!(!headers.lines().next().unwrap().contains("wire-test-key"));
    if inline {
        assert!(headers.contains("content-type: application/msgpack"));
        let decoded=rmpv::decode::read_value(&mut std::io::Cursor::new(body)).unwrap();
        assert_eq!(decoded.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("normalize")).unwrap().1,rmpv::Value::Boolean(false));
        let references=decoded.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("references")).unwrap().1.as_array().unwrap();
        let audio=&references[0].as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("audio")).unwrap().1;
        assert_eq!(audio,&rmpv::Value::Binary(vec![9,8,7]));
    } else {
        assert!(headers.contains("content-type: application/json"));
        let body:Value=serde_json::from_slice(&body).unwrap();
        assert_eq!(body["text"],"Hello 世界");
        assert_eq!(body["normalize"],false);assert_eq!(body["language"],"es-MX");
        assert_eq!(body["format"],"pcm");
        assert!(body.get("model").is_none());
    }
}

#[tokio::test]
async fn rejected_requests_have_specific_recovery_and_ambiguous_streams_keep_billing_uncertainty() {
    for (status,truncated,recovery,uncertain) in [
        (401,false,"authentication",false),
        (402,false,"credit",false),
        (404,false,"voice",false),
        (422,false,"input",false),
        (429,false,"limit",false),
        (503,false,"capacity",true),
        (200,true,"disconnected",true),
    ] {
        let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint=format!("http://{}/v1/tts/stream/with-timestamp",listener.local_addr().unwrap());
        let server=tokio::spawn(capture_http(listener,status,truncated));
        let output=Output::new();
        let mut spool=PcmSpool::create(&output.0,SAMPLE_RATE,CHANNELS).unwrap();
        let dispatched=AtomicBool::new(false);
        let received=receive_sse(&reqwest::Client::new(),&endpoint,"test-key",prepare_request(json!({"text":"Cleared synthetic fixture"}),false).unwrap(),&mut spool,&dispatched).await;
        let error=settle(spool,received,&CancellationToken::new()).await.err().unwrap();
        assert!(error.contains(recovery),"{status}: {error}");
        assert_eq!(dispatched.load(Ordering::SeqCst),uncertain,"{status}");
        assert!(!output.0.exists());
        server.await.unwrap();
    }
}

#[tokio::test]
async fn grouped_dialogue_references_remain_nested_binary_samples_on_the_wire(){
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint=format!("http://{}/v1/tts/stream/with-timestamp",listener.local_addr().unwrap());
    let server=tokio::spawn(capture_http(listener,200,false));
    let output=Output::new();let mut spool=PcmSpool::create(&output.0,SAMPLE_RATE,CHANNELS).unwrap();
    let request=compiled_reference_dialogue();
    let received=receive_sse(&reqwest::Client::new(),&endpoint,"test-key",prepare_request(request,false).unwrap(),&mut spool,&AtomicBool::new(false)).await;
    settle(spool,received,&CancellationToken::new()).await.unwrap();
    let (_,body)=server.await.unwrap();
    let value=rmpv::decode::read_value(&mut std::io::Cursor::new(body)).unwrap();
    assert_eq!(value.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("reference_id")).unwrap().1,rmpv::Value::Array(vec!["speaker-0".into(),"speaker-1".into()]));
    let groups=value.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("references")).unwrap().1.as_array().unwrap();
    assert_eq!(groups.len(),2);assert_eq!(groups[0].as_array().unwrap().len(),1);assert_eq!(groups[1].as_array().unwrap().len(),2);
    let sample=&groups[1].as_array().unwrap()[1];
    assert_eq!(sample.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("audio")).unwrap().1,rmpv::Value::Binary(vec![5,6]));
}

fn compiled_reference_dialogue()->Value{
    let snapshot=json!({"profile":{"backend":"fish-cloud","model":"drama-3","direction":"","temperature":0.7,"topP":0.7,"chunkLength":300,"minChunkLength":50,"latency":"normal","dictionaryIds":[],"normalize":false},"dictionaries":[],"references":{"a":{"transcript":"First voice"},"b":{"transcript":"Second voice"},"c":{"transcript":"More second voice"}}});
    let segment=json!({"text":"<|speaker:0|>Hello.<|speaker:1|>Hallo.","voiceIds":[],"referenceAssetIds":["a","b","c"],"referenceGroups":[["a"],["b","c"]]});
    super::super::fish_request::build(&snapshot,&segment,|id|Ok(match id{"a"=>vec![1,2],"b"=>vec![3,4],"c"=>vec![5,6],_=>panic!("Unexpected reference")})).unwrap()
}

#[tokio::test]
async fn timestamped_sse_sends_explicit_model_on_wire() { sse_round_trip(false).await; }

#[tokio::test]
async fn inline_reference_is_messagepack_binary_on_wire() { sse_round_trip(true).await; }

async fn websocket_round_trip(timestamps: bool) {
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint=format!("ws://{}/v1/tts/live{}",listener.local_addr().unwrap(),if timestamps{"/with-timestamp"}else{""});
    let server=tokio::spawn(async move {
        let (socket,_)=listener.accept().await.unwrap();
        let mut socket=tokio_tungstenite::accept_hdr_async(socket,|request:&tokio_tungstenite::tungstenite::handshake::server::Request,response|{
            assert_eq!(request.headers()["model"],"drama-3");
            assert_eq!(request.headers()["authorization"],"Bearer wire-test-key");
            assert!(!request.uri().to_string().contains("wire-test-key"));
            Ok(response)
        }).await.unwrap();
        let mut events=Vec::new();
        loop {
            let message=socket.next().await.unwrap().unwrap();
            let Message::Binary(bytes)=message else {panic!("Client did not send MessagePack")};
            let raw=rmpv::decode::read_value(&mut std::io::Cursor::new(&bytes)).unwrap();
            let event=raw.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("event")).unwrap().1.as_str().unwrap().to_string();
            if event=="start"{
                let request=&raw.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("request")).unwrap().1;
                assert_eq!(request.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("format")).unwrap().1,rmpv::Value::from("pcm"));
                assert_eq!(request.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("normalize")).unwrap().1,rmpv::Value::Boolean(false));
                assert_eq!(request.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("reference_id")).unwrap().1,rmpv::Value::Array(vec!["speaker-0".into(),"speaker-1".into()]));
                let groups=&request.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("references")).unwrap().1;
                let sample=&groups.as_array().unwrap()[0].as_array().unwrap()[0];
                assert_eq!(sample.as_map().unwrap().iter().find(|(key,_)|key.as_str()==Some("audio")).unwrap().1,rmpv::Value::Binary(vec![1,2]));
            }
            let stopping=event=="stop";
            events.push(event);
            if stopping {break}
        }
        assert_eq!(events,vec!["start","text","flush","text","flush","stop"]);
        let mut audio=vec![(rmpv::Value::from("event"),rmpv::Value::from("audio")),(rmpv::Value::from("audio"),rmpv::Value::Binary(vec![1,0,2,0]))];
        if timestamps {audio.extend([(rmpv::Value::from("alignment"),rmpv::Value::Nil),(rmpv::Value::from("chunk_seq"),rmpv::Value::from(0)),(rmpv::Value::from("chunk_audio_offset_sec"),rmpv::Value::from(0))]);}
        let mut bytes=Vec::new();rmpv::encode::write_value(&mut bytes,&rmpv::Value::Map(audio)).unwrap();
        socket.send(Message::Binary(bytes.into())).await.unwrap();
        socket.send(Message::Binary(rmp_serde::to_vec_named(&json!({"event":"finish","reason":"stop"})).unwrap().into())).await.unwrap();
    });
    let output=Output::new();
    let mut request=compiled_reference_dialogue();request["text"]=json!("");
    let rendered=tokio::time::timeout(Duration::from_secs(5),render_websocket(&endpoint,"wire-test-key",request,futures_util::stream::iter(["Hello ".to_string(),"世界".to_string()]),&output.0,CancellationToken::new(),timestamps,&AtomicBool::new(false))).await.unwrap().unwrap();
    assert_eq!(rendered.frames,2);
    server.await.unwrap();
}

#[tokio::test]
async fn native_websocket_sends_model_and_stop_on_wire() { websocket_round_trip(false).await; }

#[tokio::test]
async fn timed_websocket_sends_model_and_stop_on_wire() { websocket_round_trip(true).await; }

#[tokio::test]
async fn websocket_spools_audio_before_live_text_input_finishes(){
    let listener=TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint=format!("ws://{}/v1/tts/live",listener.local_addr().unwrap());
    let server=tokio::spawn(async move{
        let (socket,_)=listener.accept().await.unwrap();
        let mut socket=tokio_tungstenite::accept_hdr_async(socket,|request:&tokio_tungstenite::tungstenite::handshake::server::Request,response|{assert_eq!(request.headers()["model"],"drama-3");Ok(response)}).await.unwrap();
        let mut flushed=false;
        loop{
            let Message::Binary(bytes)=socket.next().await.unwrap().unwrap()else{panic!("Expected MessagePack live event")};
            let event:Value=rmp_serde::from_slice(&bytes).unwrap();
            if event["event"]=="flush"&&!flushed{
                let audio=rmpv::Value::Map(vec![("event".into(),"audio".into()),("audio".into(),rmpv::Value::Binary(vec![1,0,2,0]))]);
                let mut bytes=Vec::new();rmpv::encode::write_value(&mut bytes,&audio).unwrap();
                socket.send(Message::Binary(bytes.into())).await.unwrap();flushed=true;
            }
            if event["event"]=="stop"{break;}
        }
        assert!(flushed);
        socket.send(Message::Binary(rmp_serde::to_vec_named(&json!({"event":"finish","reason":"stop"})).unwrap().into())).await.unwrap();
    });
    let output=Output::new();let path=output.0.clone();
    let (sender,receiver)=tokio::sync::mpsc::channel::<String>(2);
    sender.send("First sentence. ".into()).await.unwrap();
    let dispatched=std::sync::Arc::new(AtomicBool::new(false));let dispatch_state=dispatched.clone();
    let worker=tokio::spawn(async move{
        let text=futures_util::stream::unfold(receiver,|mut receiver|async move{receiver.recv().await.map(|text|(text,receiver))});
        render_websocket(&endpoint,"wire-test-key",json!({"reference_id":["voice"]}),text,&path,CancellationToken::new(),false,&dispatch_state).await
    });
    tokio::time::timeout(Duration::from_secs(5),async{
        let mut interval=tokio::time::interval(Duration::from_millis(10));
        loop{interval.tick().await;if std::fs::metadata(&output.0).is_ok_and(|metadata|metadata.len()>=48){break;}}
    }).await.expect("PCM must be readable while the text stream remains open");
    assert!(!worker.is_finished());assert!(dispatched.load(Ordering::SeqCst));
    sender.send("Second sentence.".into()).await.unwrap();drop(sender);
    let result=tokio::time::timeout(Duration::from_secs(5),worker).await.unwrap().unwrap().unwrap();
    assert_eq!(result.frames,2);assert_eq!(hound::WavReader::open(&output.0).unwrap().duration(),2);server.await.unwrap();
}
