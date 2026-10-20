use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::time::Duration;
use std::sync::atomic::{AtomicBool, Ordering};

use futures_util::{SinkExt, Stream, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message,
};
use tokio_util::sync::CancellationToken;

#[path = "transport.rs"]
mod transport;

use transport::{Alignments, LiveEvent, MAX_MESSAGE_BYTES};
use super::sse::SseDecoder;
use super::pcm_spool::PcmSpool;
use super::pcm::{CHANNELS,SAMPLE_RATE};

const MODEL: &str = "drama-3";
const HTTP_URL: &str = "https://api.fish.audio/v1/tts/stream/with-timestamp";
const LIVE_URL: &str = "wss://api.fish.audio/v1/tts/live";
const TIMED_LIVE_URL: &str = "wss://api.fish.audio/v1/tts/live/with-timestamp";
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
const SESSION_TIMEOUT: Duration = Duration::from_secs(900);
const FRAGMENT_BYTES: usize = 64 * 1024;

pub struct RenderResult {
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: u64,
    pub alignment: Vec<Value>,
    pub model: String,
    pub first_audio_ms:Option<f64>,
}

pub async fn render(
    client: &reqwest::Client,
    key: &str,
    request: Value,
    output: &Path,
    cancel: CancellationToken,
    dispatched: &AtomicBool,
) -> Result<RenderResult, String> {
    validate_key(key, &cancel)?;
    let request = prepare_request(request, false)?;
    let mut spool = PcmSpool::create(output,SAMPLE_RATE,CHANNELS)?;
    let rendered = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Speech render cancelled.".into()),
        result = tokio::time::timeout(SESSION_TIMEOUT, receive_sse(client, HTTP_URL, key, request, &mut spool, dispatched)) => {
            result.unwrap_or_else(|_| Err("Fish speech request timed out.".into()))
        }
    };
    settle(spool, rendered, &cancel).await
}

pub async fn render_live<S>(
    key: &str,
    request: Value,
    text: S,
    output: &Path,
    cancel: CancellationToken,
    dispatched: &AtomicBool,
) -> Result<RenderResult, String>
where
    S: Stream<Item = String> + Send,
{
    render_websocket(LIVE_URL, key, request, text, output, cancel, false,dispatched).await
}

pub async fn render_live_with_timestamps<S>(
    key: &str,
    request: Value,
    text: S,
    output: &Path,
    cancel: CancellationToken,
    dispatched: &AtomicBool,
) -> Result<RenderResult, String>
where
    S: Stream<Item = String> + Send,
{
    render_websocket(TIMED_LIVE_URL, key, request, text, output, cancel, true,dispatched).await
}

fn validate_key(key: &str, cancel: &CancellationToken) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("Speech render cancelled.".into());
    }
    if key.trim().is_empty() {
        return Err("Configure a Fish Audio API key before rendering speech.".into());
    }
    Ok(())
}

fn prepare_request(mut request: Value, live: bool) -> Result<Value, String> {
    let object = request.as_object_mut().ok_or("Fish request must be an object.")?;
    if let Some(model) = object.remove("model") {
        if model.as_str() != Some(MODEL) {
            return Err("Fish speech requires the drama-3 model.".into());
        }
    }
    if live {
        if object.get("text").is_some_and(|text| text.as_str() != Some("")) {
            return Err("Send live speech text through the text stream.".into());
        }
        object.insert("text".into(), Value::String(String::new()));
    } else if object.get("text").and_then(Value::as_str).is_none_or(|text| text.trim().is_empty()) {
        return Err("Enter text before rendering speech.".into());
    }
    if object.get("channels").is_some_and(|channels| channels.as_u64() != Some(1)) {
        return Err("Fish speech requires mono PCM audio.".into());
    }
    object.remove("channels");
    object.insert("format".into(), json!("pcm"));
    object.insert("sample_rate".into(), json!(SAMPLE_RATE));
    let maximum = if live { MAX_MESSAGE_BYTES - 128 } else { 32 * 1024 * 1024 };
    if serde_json::to_vec(&request).map_err(|_| "Fish request could not be encoded.")?.len()
        > maximum
    {
        return Err(format!("Fish speech request exceeded the local {} byte transport guard. Shorten the text or trim references.", maximum));
    }
    Ok(request)
}

async fn receive_sse(
    client: &reqwest::Client,
    endpoint: &str,
    key: &str,
    request: Value,
    spool: &mut PcmSpool,
    dispatched: &AtomicBool,
) -> Result<Vec<Value>, String> {
    spool.reserve_header().await?;
    let mut transport = client.post(endpoint).bearer_auth(key).header("model", MODEL)
        .header("accept", "text/event-stream");
    if request.get("references").and_then(Value::as_array).is_some_and(|references| !references.is_empty()) {
        let bytes = fish_messagepack(&request)?;
        transport = transport.header("content-type", "application/msgpack").body(bytes);
    } else {
        transport = transport.json(&request);
    }
    dispatched.store(true,Ordering::SeqCst);
    let response = tokio::time::timeout(
        IDLE_TIMEOUT,
        transport.send(),
    ).await.map_err(|_| "Fish connection timed out.")?
        .map_err(|_| "Could not connect to Fish Audio.")?;
    if !response.status().is_success() {
        let status=response.status().as_u16();
        if (400..500).contains(&status)&&status!=408 { dispatched.store(false,Ordering::SeqCst); }
        return Err(match status {
            401|403=>"Fish authentication failed. Replace the API key or check its permissions.".into(),
            402=>"Fish credit is insufficient. Add account credit before retrying.".into(),
            404=>"The Fish voice or endpoint is unavailable. Check the selected voice ID.".into(),
            400|422=>"Fish rejected the speech input. Check the script, references, and generation settings.".into(),
            429=>"Fish account concurrency or rate limit was reached. Wait before retrying.".into(),
            503=>"Fish capacity is unavailable. Check the uncertain request before retrying.".into(),
            _=>format!("Fish speech request failed with HTTP {status}. Review its job before retrying."),
        });
    }
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok()).unwrap_or("");
    if !content_type.split(';').next().is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/event-stream")) {
        return Err("Fish returned an unexpected speech content type.".into());
    }
    let mut stream = response.bytes_stream();
    let mut decoder = SseDecoder::default();
    let mut alignment = Alignments::default();
    loop {
        let next = tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await
            .map_err(|_| "Fish audio stream timed out.")?;
        let Some(next) = next else { break };
        let bytes = next.map_err(|_| "Fish audio stream disconnected before completion.")?;
        for fragment in bytes.chunks(FRAGMENT_BYTES) {
            for message in decoder.push(fragment)? {
                let audio = transport::sse_audio(&message)?;
                alignment.update(&message)?;
                spool.append(&audio).await?;
            }
        }
    }
    decoder.finish()?;
    Ok(alignment.into_timeline())
}

fn inline_reference_bytes(reference:&mut rmpv::Value,depth:u8)->Result<(),String>{
    use base64::Engine;
    if let rmpv::Value::Array(samples)=reference{
        if depth!=0{return Err("Inline references contain too many grouping levels.".into());}
        for sample in samples{inline_reference_bytes(sample,depth+1)?;}
        return Ok(());
    }
    let rmpv::Value::Map(fields)=reference else{return Err("An inline reference is invalid.".into());};
    let audio=fields.iter_mut().find(|(key,_)|key.as_str()==Some("audio")).map(|(_,value)|value).ok_or("Inline reference audio is missing.")?;
    let bytes=base64::engine::general_purpose::STANDARD.decode(audio.as_str().ok_or("Inline reference audio is invalid.")?).map_err(|_|"Inline reference audio encoding is invalid.")?;
    *audio=rmpv::Value::Binary(bytes);
    Ok(())
}

fn fish_messagepack(value:&Value)->Result<Vec<u8>,String>{
    let mut value=rmpv::ext::to_value(value).map_err(|_|"Fish request could not be encoded.")?;
    fn references(value:&mut rmpv::Value)->Result<(),String>{
        let rmpv::Value::Map(fields)=value else{return Err("The Fish request is invalid.".into());};
        for (key,value) in fields{
            if key.as_str()==Some("request"){references(value)?;}
            if key.as_str()==Some("references"){
                if value.is_nil(){continue;}
                let rmpv::Value::Array(samples)=value else{return Err("The inline reference list is invalid.".into());};
                for sample in samples{inline_reference_bytes(sample,0)?;}
            }
        }
        Ok(())
    }
    references(&mut value)?;
    let mut bytes=Vec::new();
    rmpv::encode::write_value(&mut bytes,&value).map_err(|_|"Fish MessagePack could not be encoded.")?;
    Ok(bytes)
}

async fn render_websocket<S>(
    endpoint: &str,
    key: &str,
    request: Value,
    text: S,
    output: &Path,
    cancel: CancellationToken,
    timestamps: bool,
    dispatched: &AtomicBool,
) -> Result<RenderResult, String>
where
    S: Stream<Item = String> + Send,
{
    validate_key(key, &cancel)?;
    let request = prepare_request(request, true)?;
    let mut handshake = endpoint.into_client_request().map_err(|_| "Could not prepare Fish WebSocket connection.")?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {key}"))
        .map_err(|_| "Fish Audio API key is invalid.")?;
    authorization.set_sensitive(true);
    handshake.headers_mut().insert("authorization", authorization);
    handshake.headers_mut().insert("model", HeaderValue::from_static(MODEL));
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(MAX_MESSAGE_BYTES);
    config.max_frame_size = Some(MAX_MESSAGE_BYTES);
    let mut spool = PcmSpool::create(output,SAMPLE_RATE,CHANNELS)?;
    let work = async {
        spool.reserve_header().await?;
        let (socket, _) = tokio::time::timeout(
            IDLE_TIMEOUT,
            tokio_tungstenite::connect_async_with_config(handshake, Some(config), true),
        ).await.map_err(|_| "Fish WebSocket connection timed out.")?
            .map_err(|_| "Could not connect to Fish Audio WebSocket.")?;
        let (mut sink, mut source) = socket.split();
        let sender = async {
            dispatched.store(true,Ordering::SeqCst);
            send_event(&mut sink, &json!({"event": "start", "request": request})).await?;
            futures_util::pin_mut!(text);
            let mut sent_text = false;
            while let Some(chunk) = text.next().await {
                if chunk.is_empty() {
                    continue;
                }
                if chunk.len() > MAX_MESSAGE_BYTES / 8 {
                    return Err("Live speech text chunk exceeded the size limit.".into());
                }
                sent_text |= !chunk.trim().is_empty();
                send_event(&mut sink, &json!({"event": "text", "text": chunk})).await?;
                send_event(&mut sink, &json!({"event": "flush"})).await?;
            }
            if !sent_text {
                return Err("Enter text before rendering live speech.".into());
            }
            send_event(&mut sink, &json!({"event": "stop"})).await
        };
        let receiver = async {
            let mut alignment = Alignments::default();
            loop {
                let message = tokio::time::timeout(IDLE_TIMEOUT, source.next()).await
                    .map_err(|_| "Fish WebSocket audio stream timed out.")?
                    .ok_or("Fish WebSocket disconnected before finish.")?
                    .map_err(|_| "Fish WebSocket audio stream failed.")?;
                match message {
                    Message::Binary(bytes) => match transport::live_event(&bytes, timestamps)? {
                        LiveEvent::Audio { bytes, metadata } => {
                            if let Some(metadata) = metadata {
                                alignment.update(&metadata)?;
                            }
                            spool.append(&bytes).await?;
                        }
                        LiveEvent::Finish { metadata } => {
                            if let Some(metadata) = metadata {
                                alignment.update(&metadata)?;
                            }
                            return Ok(alignment.into_timeline());
                        }
                    },
                    Message::Ping(_) | Message::Pong(_) => {}
                    Message::Close(_) => return Err("Fish WebSocket closed before finish.".into()),
                    _ => return Err("Fish returned a non-MessagePack WebSocket message.".into()),
                }
            }
        };
        tokio::pin!(sender, receiver);
        tokio::select! {
            biased;
            sent = &mut sender => {
                sent?;
                receiver.await
            }
            received = &mut receiver => {
                received?;
                Err("Fish finished before the text stream stopped.".into())
            }
        }
    };
    let rendered = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Speech render cancelled.".into()),
        result = tokio::time::timeout(SESSION_TIMEOUT, work) => {
            result.unwrap_or_else(|_| Err("Fish speech session timed out.".into()))
        }
    };
    settle(spool, rendered, &cancel).await
}

async fn send_event<S>(sink: &mut S, event: &Value) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
{
    let bytes = fish_messagepack(event)?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err("Fish live event exceeded the size limit.".into());
    }
    tokio::time::timeout(IDLE_TIMEOUT, sink.send(Message::Binary(bytes.into()))).await
        .map_err(|_| "Fish WebSocket send timed out.")?
        .map_err(|_| "Fish WebSocket disconnected while sending text.".into())
}

async fn settle(
    mut spool: PcmSpool,
    rendered: Result<Vec<Value>, String>,
    cancel: &CancellationToken,
) -> Result<RenderResult, String> {
    let result = match rendered {
        Ok(alignment) => {
            let finalized=tokio::select! {
                biased;
                _ = cancel.cancelled() => Err("Speech render cancelled.".into()),
                result = tokio::time::timeout(IDLE_TIMEOUT, spool.finish()) => {
                    result.unwrap_or_else(|_| Err("Saving the speech WAV timed out.".into()))
                }
            };
            finalized.map(|audio|RenderResult{sample_rate:audio.sample_rate,channels:audio.channels,frames:audio.frames,alignment,model:MODEL.into(),first_audio_ms:audio.first_audio_ms})
        },
        Err(error) => Err(error),
    };
    match result {
        Ok(result) if !cancel.is_cancelled() => {
            spool.retain();
            Ok(result)
        }
        result => {
            let error = result.err().unwrap_or_else(|| "Speech render cancelled.".into());
            match spool.discard().await {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!("{error} {cleanup}")),
            }
        }
    }
}

#[cfg(test)]
#[path = "fish_wire_tests.rs"]
mod wire_tests;
