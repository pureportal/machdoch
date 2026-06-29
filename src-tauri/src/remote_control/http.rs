use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpStream,
};

use serde_json::Value;

const MAX_HTTP_BODY_BYTES: usize = 64 * 1024;

#[allow(dead_code)]
pub(super) struct HttpRequest {
    pub(super) method: String,
    pub(super) path: String,
    pub(super) headers: HashMap<String, String>,
    pub(super) body: Vec<u8>,
}

#[allow(dead_code)]
pub(super) fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let mut reader = BufReader::new(stream);
    let mut request_line = String::new();

    if reader
        .read_line(&mut request_line)
        .map_err(|error| format!("Unable to read HTTP request: {error}"))?
        == 0
    {
        return Err("Empty HTTP request.".to_string());
    }

    let mut parts = request_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| "HTTP request method is missing.".to_string())?
        .to_string();
    let target = parts
        .next()
        .ok_or_else(|| "HTTP request target is missing.".to_string())?
        .to_string();

    let path = split_target(&target);
    let mut headers = HashMap::new();

    loop {
        let mut header_line = String::new();
        let bytes_read = reader
            .read_line(&mut header_line)
            .map_err(|error| format!("Unable to read HTTP headers: {error}"))?;

        if bytes_read == 0 || header_line == "\r\n" || header_line == "\n" {
            break;
        }

        if let Some((key, value)) = header_line.split_once(':') {
            headers.insert(
                key.trim().to_ascii_lowercase(),
                value.trim().trim_end_matches('\r').to_string(),
            );
        }
    }

    let content_length = headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);

    if content_length > MAX_HTTP_BODY_BYTES {
        return Err("Mission Control request body is too large.".to_string());
    }

    let mut body = vec![0; content_length];

    if content_length > 0 {
        reader
            .read_exact(&mut body)
            .map_err(|error| format!("Unable to read HTTP body: {error}"))?;
    }

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

#[allow(dead_code)]
fn split_target(target: &str) -> String {
    let path_and_query = target.split('#').next().unwrap_or(target);

    if let Some((path, _)) = path_and_query.split_once('?') {
        return path.to_string();
    }

    path_and_query.to_string()
}

#[allow(dead_code)]
pub(super) fn write_html_response(stream: &mut TcpStream, body: String) -> std::io::Result<()> {
    write_response(
        stream,
        200,
        body.into_bytes(),
        &[
            ("Content-Type", "text/html; charset=utf-8"),
            ("Cache-Control", "no-store"),
            (
                "Content-Security-Policy",
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ),
            ("Referrer-Policy", "no-referrer"),
        ],
    )
}

#[allow(dead_code)]
pub(super) fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    body: Value,
    extra_headers: &[(&str, &str)],
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&body).unwrap_or_else(|_| b"{\"error\":\"json\"}".to_vec());
    let mut headers = vec![
        ("Content-Type", "application/json; charset=utf-8"),
        ("Cache-Control", "no-store"),
    ];
    headers.extend_from_slice(extra_headers);
    write_response(stream, status, bytes, &headers)
}

#[allow(dead_code)]
fn write_response(
    stream: &mut TcpStream,
    status: u16,
    body: Vec<u8>,
    headers: &[(&str, &str)],
) -> std::io::Result<()> {
    write_headers(stream, status, headers, Some(body.len()))?;
    stream.write_all(&body)
}

#[allow(dead_code)]
pub(super) fn write_headers(
    stream: &mut TcpStream,
    status: u16,
    headers: &[(&str, &str)],
    content_length: Option<usize>,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    };
    write!(stream, "HTTP/1.1 {status} {reason}\r\n")?;

    for (key, value) in headers {
        write!(stream, "{key}: {value}\r\n")?;
    }

    if let Some(content_length) = content_length {
        write!(stream, "Content-Length: {content_length}\r\n")?;
        write!(stream, "Connection: close\r\n")?;
    }

    write!(stream, "\r\n")
}

#[cfg(test)]
mod tests {
    use super::split_target;

    #[test]
    fn split_target_removes_query_and_fragment() {
        assert_eq!(
            split_target("/api/status?token=secret#pair=secret"),
            "/api/status"
        );
        assert_eq!(split_target("/api/events#pair=secret"), "/api/events");
        assert_eq!(split_target("/"), "/");
    }
}
