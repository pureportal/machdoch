use super::{prepare, transcribe, transcribe_at, verify_source, MAX_RESPONSE, MAX_UPLOAD};
use crate::speech::exports;
use serde_json::json;
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let identifier: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let directory = Path::new(crate::speech::settings::model_root())
            .join("speech/verification")
            .join(format!("timing-provider-{identifier}"));
        std::fs::create_dir_all(&directory).unwrap();
        Self(directory)
    }

    fn source(&self) -> PathBuf {
        let path = self.0.join("source.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let mut writer = hound::WavWriter::create(&path, spec).unwrap();
        for frame in 0..96_000 {
            let sign = if (24_000..72_000).contains(&frame) { 1.0 } else { -1.0 };
            writer.write_sample(0.25f32 * sign).unwrap();
            writer.write_sample(0.5f32 * sign).unwrap();
        }
        writer.finalize().unwrap();
        path
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).expect("Remove the timing provider test directory");
    }
}

struct Request {
    line: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

struct Part {
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

async fn within<T>(work: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(30), work)
        .await
        .expect("The local timing provider fixture timed out")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(0)
        .build()
        .unwrap()
}

fn headers(text: &str) -> BTreeMap<String, String> {
    text.lines()
        .map(|line| {
            let (name, value) = line.split_once(':').unwrap();
            (name.to_ascii_lowercase(), value.trim().to_owned())
        })
        .collect()
}

async fn read_request(stream: &mut TcpStream) -> Request {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let header_end = loop {
        if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            assert!(index < 65_536);
            break index;
        }
        assert!(bytes.len() < 65_536, "Request headers exceeded the fixture guard");
        let count = stream.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0, "The upload closed before its headers");
        bytes.extend_from_slice(&buffer[..count]);
    };
    let header_text = std::str::from_utf8(&bytes[..header_end]).unwrap();
    let (line, fields) = header_text.split_once("\r\n").unwrap();
    let line = line.to_owned();
    let headers = headers(fields);
    assert!(!headers.contains_key("transfer-encoding"));
    let length: usize = headers["content-length"].parse().unwrap();
    assert!(length <= MAX_UPLOAD as usize + 65_536);
    let mut body = bytes.split_off(header_end + 4);
    while body.len() < length {
        let count = stream.read(&mut buffer).await.unwrap();
        assert_ne!(count, 0, "The upload closed before its declared length");
        body.extend_from_slice(&buffer[..count]);
    }
    assert_eq!(body.len(), length);
    Request { line, headers, body }
}

fn multipart(request: &Request) -> BTreeMap<String, Part> {
    let boundary = request.headers["content-type"]
        .strip_prefix("multipart/form-data; boundary=")
        .unwrap();
    let opening = format!("--{boundary}\r\n");
    let separator = format!("\r\n--{boundary}");
    let closing = format!("--{boundary}--\r\n");
    let mut remaining = request.body.as_slice();
    let mut parts = BTreeMap::new();
    while remaining != closing.as_bytes() {
        remaining = remaining.strip_prefix(opening.as_bytes()).unwrap();
        let header_end = remaining.windows(4).position(|bytes| bytes == b"\r\n\r\n").unwrap();
        let headers = headers(std::str::from_utf8(&remaining[..header_end]).unwrap());
        remaining = &remaining[header_end + 4..];
        let body_end = remaining
            .windows(separator.len())
            .position(|bytes| bytes == separator.as_bytes())
            .unwrap();
        let name = headers["content-disposition"].clone();
        let part = Part { headers, body: remaining[..body_end].to_vec() };
        assert!(parts.insert(name, part).is_none());
        remaining = &remaining[body_end + 2..];
    }
    parts
}

async fn respond(status: u16, body: Vec<u8>) -> (String, JoinHandle<Request>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let endpoint = format!("http://{}/v1/audio/transcriptions", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = read_request(&mut stream).await;
        let header = format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(header.as_bytes()).await.unwrap();
        if let Err(error) = stream.write_all(&body).await {
            assert!(
                matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                ),
                "Unexpected fixture response write error: {error}"
            );
        }
        request
    });
    (endpoint, server)
}

#[tokio::test]
async fn multipart_posts_pinned_word_timing_fields_and_the_complete_streamed_file() {
    let directory = TestDirectory::new();
    let path = directory.source();
    let audio = std::fs::read(&path).unwrap();
    assert!(audio.len() > 2 * 65_536);
    let client = client();
    for language in [Some("de"), None] {
        let response = json!({
            "text": "Hallo Welt",
            "language": "german",
            "duration": 2.0,
            "words": [
                {"word": "Hallo", "start": 0.125, "end": 0.625},
                {"word": "Welt", "start": 1.0, "end": 1.75}
            ],
            "usage": {"type": "duration", "seconds": 2.0}
        });
        let (endpoint, server) = respond(200, serde_json::to_vec(&response).unwrap()).await;
        let dispatched = AtomicBool::new(false);
        let result = within(transcribe_at(
            &client, &endpoint, "loopback-only-key", &path, language,
            &CancellationToken::new(), &dispatched,
        )).await.unwrap();
        assert_eq!(result, response);
        assert!(dispatched.load(Ordering::SeqCst));
        let request = within(server).await.unwrap();
        assert_eq!(request.line, "POST /v1/audio/transcriptions HTTP/1.1");
        assert_eq!(request.headers["authorization"], "Bearer loopback-only-key");
        assert_eq!(request.headers["content-length"].parse::<usize>().unwrap(), request.body.len());
        let mut parts = multipart(&request);
        assert_eq!(parts.len(), if language.is_some() { 5 } else { 4 });
        let file = parts.remove("form-data; name=\"file\"; filename=\"speech.wav\"").unwrap();
        assert_eq!(file.headers["content-type"], "audio/wav");
        assert_eq!(file.body, audio);
        for (name, expected) in [
            ("model", "whisper-1"),
            ("response_format", "verbose_json"),
            ("timestamp_granularities[]", "word"),
        ] {
            let field = parts.remove(&format!("form-data; name=\"{name}\"")).unwrap();
            assert_eq!(field.body, expected.as_bytes());
        }
        if let Some(language) = language {
            assert_eq!(
                parts.remove("form-data; name=\"language\"").unwrap().body,
                language.as_bytes()
            );
        }
        assert!(parts.is_empty());
    }
}

#[tokio::test]
async fn rejections_sanitize_provider_errors_and_keep_only_uncertain_requests_dispatched() {
    let directory = TestDirectory::new();
    let path = directory.source();
    let client = client();
    let cases = [
        (400, false, "OpenAI speech rejected the speech input. Check its text and settings."),
        (401, false, "OpenAI speech authentication failed. Check the API key and model access."),
        (402, false, "OpenAI speech credit is insufficient. Add credit before retrying."),
        (403, false, "OpenAI speech authentication failed. Check the API key and model access."),
        (404, false, "The OpenAI transcription model is unavailable. Check account access before retrying."),
        (408, true, "OpenAI speech request failed. Review the job before retrying."),
        (422, false, "OpenAI speech rejected the speech input. Check its text and settings."),
        (429, false, "OpenAI speech request quota is exhausted. Wait for other requests before retrying."),
        (503, true, "OpenAI speech service failed. Review usage before retrying."),
    ];
    for (status, expected_dispatched, expected_error) in cases {
        let body = br#"{"error":{"message":"private-provider-diagnostic loopback-only-secret"}}"#.to_vec();
        let (endpoint, server) = respond(status, body).await;
        let dispatched = AtomicBool::new(false);
        let error = within(transcribe_at(
            &client, &endpoint, "loopback-only-secret", &path, None,
            &CancellationToken::new(), &dispatched,
        )).await.unwrap_err();
        within(server).await.unwrap();
        assert_eq!(error, expected_error, "HTTP {status}");
        assert!(!error.contains("loopback-only-secret"));
        assert!(!error.contains("private-provider-diagnostic"));
        assert_eq!(dispatched.load(Ordering::SeqCst), expected_dispatched, "HTTP {status}");
    }
}

#[tokio::test]
async fn cancellation_closes_an_in_flight_request_and_preserves_dispatch_evidence() {
    let directory = TestDirectory::new();
    let path = directory.source();
    let client = client();
    for partial_response in [false, true] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let endpoint = format!("http://{}/v1/audio/transcriptions", listener.local_addr().unwrap());
        let (ready, received) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            if partial_response {
                stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 4096\r\n\r\n{"
                ).await.unwrap();
            }
            ready.send(()).unwrap();
            let mut buffer = [0u8; 1];
            match stream.read(&mut buffer).await {
                Ok(count) => assert_eq!(count, 0, "Cancellation must close the connection"),
                Err(error) => assert!(
                    matches!(error.kind(), std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted),
                    "Unexpected cancellation socket error: {error}"
                ),
            }
        });
        let cancel = CancellationToken::new();
        let dispatched = AtomicBool::new(false);
        let work = transcribe_at(
            &client, &endpoint, "loopback-only-key", &path, None, &cancel, &dispatched,
        );
        tokio::pin!(work);
        within(async {
            tokio::select! {
                result = &mut work => panic!("The in-flight request finished before cancellation: {result:?}"),
                result = received => result.unwrap(),
            }
        }).await;
        assert!(dispatched.load(Ordering::SeqCst));
        cancel.cancel();
        assert_eq!(within(&mut work).await.unwrap_err(), "Transcription cancelled.");
        assert!(dispatched.load(Ordering::SeqCst));
        within(server).await.unwrap();
    }
}

#[tokio::test]
async fn invalid_and_oversized_responses_keep_dispatch_evidence() {
    let directory = TestDirectory::new();
    let path = directory.source();
    let client = client();
    let oversized = serde_json::to_vec(&json!({"text": "x".repeat(MAX_RESPONSE)})).unwrap();
    for (body, expected_error) in [
        (b"private invalid provider JSON".to_vec(), "The transcription provider returned invalid JSON. Review usage before retrying."),
        (oversized, "The transcription response exceeded its local guard. Align a shorter take."),
    ] {
        let (endpoint, server) = respond(200, body).await;
        let dispatched = AtomicBool::new(false);
        let error = within(transcribe_at(
            &client, &endpoint, "loopback-only-key", &path, None,
            &CancellationToken::new(), &dispatched,
        )).await.unwrap_err();
        within(server).await.unwrap();
        assert_eq!(error, expected_error);
        assert!(dispatched.load(Ordering::SeqCst));
    }
}

#[tokio::test]
async fn preflight_rejects_missing_credentials_empty_and_oversized_uploads_without_dispatch() {
    let directory = TestDirectory::new();
    let path = directory.source();
    let empty = directory.0.join("empty.wav");
    std::fs::write(&empty, []).unwrap();
    let oversized = directory.0.join("oversized.wav");
    std::fs::File::create(&oversized).unwrap().set_len(MAX_UPLOAD + 1).unwrap();
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let endpoint = format!("http://{}/v1/audio/transcriptions", listener.local_addr().unwrap());
    let client = client();
    for (key, file, expected_error) in [
        (" \t", &path, "Configure the OpenAI API key before transcribing audio."),
        ("loopback-only-key", &empty, "Keep each upload within the local 20 MiB guard."),
        ("loopback-only-key", &oversized, "Keep each upload within the local 20 MiB guard."),
    ] {
        let dispatched = AtomicBool::new(false);
        let error = within(transcribe_at(
            &client, &endpoint, key, file, None, &CancellationToken::new(), &dispatched,
        )).await.unwrap_err();
        assert_eq!(error, expected_error);
        assert!(!dispatched.load(Ordering::SeqCst));
    }
    let cancel = CancellationToken::new();
    cancel.cancel();
    let dispatched = AtomicBool::new(false);
    assert_eq!(
        within(transcribe(&client, "loopback-only-key", &path, None, &cancel, &dispatched))
            .await.unwrap_err(),
        "Transcription cancelled."
    );
    assert!(!dispatched.load(Ordering::SeqCst));
    let listener = listener.into_std().unwrap();
    assert_eq!(listener.accept().unwrap_err().kind(), std::io::ErrorKind::WouldBlock);
}

#[tokio::test]
async fn pinned_ffmpeg_prepares_the_exact_window_as_measured_16khz_mono_pcm16() {
    let directory = TestDirectory::new();
    let source = directory.source();
    let original_hash = exports::hash_file(&source).unwrap();
    let encoder = exports::encoder().expect("Load FFmpeg through the installed integrity manifest");
    let encoder_root = Path::new(crate::speech::settings::model_root())
        .join("speech/encoder").canonicalize().unwrap();
    assert!(encoder.starts_with(&encoder_root));
    let output = directory.0.join("prepared.wav");
    let window = json!({"from": 0.625, "to": 1.375});
    let result = within(prepare(
        &source, &encoder, &output, &window, &CancellationToken::new(),
    )).await.unwrap();
    let mut reader = hound::WavReader::open(&output).unwrap();
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 16_000);
    assert_eq!(spec.channels, 1);
    assert_eq!(spec.bits_per_sample, 16);
    assert_eq!(spec.sample_format, hound::SampleFormat::Int);
    assert_eq!(reader.duration(), 12_000);
    let samples = reader.samples::<i16>().collect::<Result<Vec<_>, _>>().unwrap();
    assert_eq!(samples.len(), 12_000);
    assert!(samples.iter().all(|sample| *sample > 0), "The prepared audio must select the positive source window");
    assert_eq!(result["uploadDuration"], 0.75);
    assert_eq!(result["audioSha256"], exports::hash_file(&output).unwrap());
    assert_eq!(exports::hash_file(&source).unwrap(), original_hash);
    assert!(std::fs::metadata(&output).unwrap().len() < MAX_UPLOAD);
}

#[tokio::test]
async fn verify_source_measures_metadata_rejects_changed_hash_and_honors_cancellation() {
    let directory = TestDirectory::new();
    let source = directory.source();
    let probe = exports::probe().expect("Load FFprobe through the installed integrity manifest");
    let asset = json!({
        "sha256": exports::hash_file(&source).unwrap(),
        "bytes": std::fs::metadata(&source).unwrap().len(),
        "sampleRate": 48_000,
        "channels": 2,
        "duration": 2.0
    });
    within(verify_source(source.clone(), asset.clone(), &probe, &CancellationToken::new()))
        .await.unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        within(verify_source(source.clone(), asset.clone(), &probe, &cancel)).await.unwrap_err(),
        "Transcription cancelled."
    );
    let mut wrong_metadata = asset.clone();
    wrong_metadata["duration"] = json!(2.125);
    assert_eq!(
        within(verify_source(source.clone(), wrong_metadata, &probe, &CancellationToken::new()))
            .await.unwrap_err(),
        "The source audio metadata differs from the saved take. Restore the original asset before transcription."
    );
    let mut bytes = std::fs::read(&source).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    std::fs::write(&source, &bytes).unwrap();
    assert_eq!(bytes.len() as u64, asset["bytes"].as_u64().unwrap());
    assert_ne!(exports::hash_file(&source).unwrap(), asset["sha256"].as_str().unwrap());
    assert_eq!(
        within(verify_source(source, asset, &probe, &CancellationToken::new())).await.unwrap_err(),
        "The source take failed its audio integrity check. Restore the original audio."
    );
}
