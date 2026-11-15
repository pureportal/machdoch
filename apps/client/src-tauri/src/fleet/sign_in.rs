use base64::Engine;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

const MAX_REQUEST_HEAD_BYTES: usize = 8 * 1024;

pub(super) struct SignInSecrets {
    pub(super) verifier: String,
    pub(super) challenge: String,
    pub(super) state: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum CallbackResult {
    Code(String),
    Denied,
}

impl SignInSecrets {
    pub(super) fn new() -> Result<Self, String> {
        let verifier = random_token(32)?;
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        Ok(Self {
            verifier,
            challenge,
            state: random_token(24)?,
        })
    }
}

fn random_token(length: usize) -> Result<String, String> {
    let mut bytes = vec![0_u8; length];
    getrandom::fill(&mut bytes).map_err(|error| format!("Unable to start sign-in: {error}"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

pub(super) async fn await_callback(
    listener: &TcpListener,
    expected_state: &str,
) -> Result<(TcpStream, CallbackResult), String> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|error| format!("Sign-in could not receive the browser response: {error}"))?;
        let Ok(head) = read_request_head(&mut stream).await else {
            continue;
        };
        match parse_callback(&head, expected_state) {
            Some(result) => return Ok((stream, result)),
            None => {
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    )
                    .await;
            }
        }
    }
}

pub(super) async fn redirect_browser(mut stream: TcpStream, location: &str) {
    let response = format!(
        "HTTP/1.1 303 See Other\r\nLocation: {location}\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn read_request_head(stream: &mut TcpStream) -> Result<String, ()> {
    let mut buffer = Vec::with_capacity(1024);
    let mut chunk = [0_u8; 1024];
    while !buffer.windows(4).any(|window| window == b"\r\n\r\n") {
        let read =
            tokio::time::timeout(std::time::Duration::from_secs(10), stream.read(&mut chunk))
                .await
                .map_err(|_| ())?
                .map_err(|_| ())?;
        if read == 0 || buffer.len() + read > MAX_REQUEST_HEAD_BYTES {
            return Err(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8(buffer).map_err(|_| ())
}

fn parse_callback(head: &str, expected_state: &str) -> Option<CallbackResult> {
    let target = head
        .lines()
        .next()?
        .strip_prefix("GET ")?
        .split(' ')
        .next()?;
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let parameter = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if parameter("state").as_deref() != Some(expected_state) {
        return None;
    }
    if parameter("error").is_some() {
        return Some(CallbackResult::Denied);
    }
    parameter("code").map(CallbackResult::Code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_is_the_sha256_of_the_verifier() {
        let secrets = SignInSecrets::new().unwrap();
        assert_eq!(secrets.verifier.len(), 43);
        assert_eq!(
            secrets.challenge,
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(Sha256::digest(secrets.verifier.as_bytes()))
        );
    }

    #[test]
    fn callbacks_require_the_matching_state() {
        let head = "GET /callback?state=abc&code=mch_enroll_x HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(
            parse_callback(head, "abc"),
            Some(CallbackResult::Code("mch_enroll_x".to_string()))
        );
        assert_eq!(parse_callback(head, "other"), None);
        assert_eq!(
            parse_callback(
                "GET /callback?state=abc&error=access_denied HTTP/1.1\r\n\r\n",
                "abc"
            ),
            Some(CallbackResult::Denied)
        );
        assert_eq!(
            parse_callback("GET /favicon.ico HTTP/1.1\r\n\r\n", "abc"),
            None
        );
        assert_eq!(
            parse_callback("POST /callback?state=abc&code=x HTTP/1.1\r\n\r\n", "abc"),
            None
        );
    }

    #[tokio::test]
    async fn waits_for_the_callback_and_redirects_the_browser() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let browser = tokio::spawn(async move {
            let mut stray = TcpStream::connect(address).await.unwrap();
            stray
                .write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            let mut ignored = Vec::new();
            stray.read_to_end(&mut ignored).await.unwrap();
            let mut stream = TcpStream::connect(address).await.unwrap();
            stream
                .write_all(b"GET /callback?state=s1&code=c1 HTTP/1.1\r\n\r\n")
                .await
                .unwrap();
            let mut response = String::new();
            stream.read_to_string(&mut response).await.unwrap();
            response
        });
        let (stream, result) = await_callback(&listener, "s1").await.unwrap();
        assert_eq!(result, CallbackResult::Code("c1".to_string()));
        redirect_browser(
            stream,
            "https://cloud.example/cloud/signed-in?result=signed-in",
        )
        .await;
        let response = browser.await.unwrap();
        assert!(response.starts_with("HTTP/1.1 303"));
        assert!(
            response.contains("Location: https://cloud.example/cloud/signed-in?result=signed-in")
        );
    }
}
