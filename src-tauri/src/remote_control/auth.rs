use std::sync::Arc;

use axum::http::HeaderMap;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};

use super::{
    http::HttpRequest, now_millis, RemoteControlShared, WEB_SESSION_COOKIE_NAME, WEB_SESSION_TTL_MS,
};

pub(super) fn header_to_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn headers_have_bearer_token(headers: &HeaderMap, token: &str) -> bool {
    header_to_str(headers, "authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

pub(super) fn headers_have_current_pairing_token(
    headers: &HeaderMap,
    shared: &Arc<RemoteControlShared>,
) -> bool {
    let Ok(inner) = shared.inner.lock() else {
        return false;
    };

    let Some(server) = inner.server.as_ref() else {
        return false;
    };

    headers_have_bearer_token(headers, &server.token)
}

fn headers_have_web_session(headers: &HeaderMap, shared: &Arc<RemoteControlShared>) -> bool {
    let Some(session_token) =
        cookie_value_from_header(header_to_str(headers, "cookie"), WEB_SESSION_COOKIE_NAME)
    else {
        return false;
    };

    let Ok(mut inner) = shared.inner.lock() else {
        return false;
    };

    let session_hash = hash_remote_control_token(&session_token);
    let now = now_millis();

    if let Some(device) = inner.config.paired_devices.iter_mut().find(|device| {
        device.expires_at > now
            && constant_time_eq(device.token_hash.as_bytes(), session_hash.as_bytes())
    }) {
        device.last_seen_at = now;
        return true;
    }

    false
}

pub(super) fn headers_are_authorized(
    headers: &HeaderMap,
    shared: &Arc<RemoteControlShared>,
) -> bool {
    headers_have_web_session(headers, shared)
}

pub(super) fn state_changing_headers_allowed(headers: &HeaderMap) -> bool {
    if header_to_str(headers, "x-machdoch-remote") != Some("1") {
        return false;
    }

    if header_to_str(headers, "sec-fetch-site") == Some("cross-site") {
        return false;
    }

    let Some(origin) = header_to_str(headers, "origin") else {
        return true;
    };
    let Some(host) = header_to_str(headers, "host") else {
        return false;
    };

    origin == format!("http://{host}")
}

#[allow(dead_code)]
fn request_has_bearer_token(request: &HttpRequest, token: &str) -> bool {
    request
        .headers
        .get("authorization")
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| constant_time_eq(value.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

#[allow(dead_code)]
pub(super) fn request_has_current_pairing_token(
    request: &HttpRequest,
    shared: &Arc<RemoteControlShared>,
) -> bool {
    let Ok(inner) = shared.inner.lock() else {
        return false;
    };

    let Some(server) = inner.server.as_ref() else {
        return false;
    };

    request_has_bearer_token(request, &server.token)
}

#[allow(dead_code)]
fn request_has_web_session(request: &HttpRequest, shared: &Arc<RemoteControlShared>) -> bool {
    let Some(session_token) = cookie_value(request, WEB_SESSION_COOKIE_NAME) else {
        return false;
    };

    let Ok(inner) = shared.inner.lock() else {
        return false;
    };

    let session_hash = hash_remote_control_token(&session_token);
    let now = now_millis();

    inner.config.paired_devices.iter().any(|device| {
        device.expires_at > now
            && constant_time_eq(device.token_hash.as_bytes(), session_hash.as_bytes())
    })
}

#[allow(dead_code)]
pub(super) fn request_is_authorized(
    request: &HttpRequest,
    shared: &Arc<RemoteControlShared>,
) -> bool {
    request_has_web_session(request, shared)
}

#[allow(dead_code)]
pub(super) fn state_changing_request_is_allowed(request: &HttpRequest) -> bool {
    if request
        .headers
        .get("x-machdoch-remote")
        .map(|value| value == "1")
        .unwrap_or(false)
        == false
    {
        return false;
    }

    if request
        .headers
        .get("sec-fetch-site")
        .map(|value| value == "cross-site")
        .unwrap_or(false)
    {
        return false;
    }

    let Some(origin) = request.headers.get("origin") else {
        return true;
    };
    let Some(host) = request.headers.get("host") else {
        return false;
    };

    origin == &format!("http://{host}")
}

#[allow(dead_code)]
fn cookie_value(request: &HttpRequest, name: &str) -> Option<String> {
    cookie_value_from_header(request.headers.get("cookie").map(String::as_str), name)
}

fn cookie_value_from_header(cookie_header: Option<&str>, name: &str) -> Option<String> {
    cookie_header?.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;

        if key.trim() != name {
            return None;
        }

        Some(value.trim().to_string())
    })
}

pub(super) fn hash_remote_control_token(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

pub(super) fn create_session_cookie(session_token: &str) -> String {
    format!(
        "{WEB_SESSION_COOKIE_NAME}={session_token}; Path=/api; Max-Age={}; HttpOnly; SameSite=Strict",
        WEB_SESSION_TTL_MS / 1_000
    )
}

#[cfg(test)]
pub(super) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    constant_time_eq_impl(left, right)
}

#[cfg(not(test))]
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    constant_time_eq_impl(left, right)
}

fn constant_time_eq_impl(left: &[u8], right: &[u8]) -> bool {
    let max_len = left.len().max(right.len());
    let mut diff = left.len() ^ right.len();

    for index in 0..max_len {
        let left_byte = left.get(index).copied().unwrap_or(0);
        let right_byte = right.get(index).copied().unwrap_or(0);
        diff |= usize::from(left_byte ^ right_byte);
    }

    diff == 0
}
