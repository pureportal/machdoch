use std::{
    convert::Infallible,
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

use axum::{
    extract::State as AxumState,
    http::{
        header::{CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, REFERRER_POLICY},
        HeaderMap, HeaderValue, Method, StatusCode, Uri,
    },
    response::{
        sse::{Event, KeepAlive},
        Html, IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tauri::{Emitter, Manager};
use tokio::net::TcpListener as TokioTcpListener;

use crate::desktop_task::{request_desktop_task_cancel, DesktopTaskCancelMap};

use super::{
    auth::{
        create_session_cookie, header_to_str, headers_are_authorized,
        headers_have_current_pairing_token, state_changing_headers_allowed,
    },
    commands::{normalize_command, RemoteCommandRequest},
    mission_control_html::mission_control_html,
    status::create_snapshot_locked,
    RemoteControlShared, RemoteControlState, REMOTE_CONTROL_COMMAND_EVENT,
    SERVER_ACCEPT_POLL_INTERVAL, SSE_KEEPALIVE_INTERVAL,
};

#[derive(Clone)]
struct RemoteWebServerState {
    shared: Arc<RemoteControlShared>,
    app_handle: tauri::AppHandle,
    shutdown: Arc<AtomicBool>,
}

pub(super) async fn run_http_server(
    listener: TcpListener,
    shared: Arc<RemoteControlShared>,
    app_handle: tauri::AppHandle,
    shutdown: Arc<AtomicBool>,
) {
    let listener = match TokioTcpListener::from_std(listener) {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("Unable to create Mission Control web listener: {error}");
            shutdown.store(true, Ordering::SeqCst);
            return;
        }
    };
    let state = RemoteWebServerState {
        shared,
        app_handle,
        shutdown: shutdown.clone(),
    };
    let app = Router::new()
        .route("/", get(serve_mission_control_html))
        .route("/api/session", post(create_remote_web_session))
        .route("/api/status", get(get_remote_web_status))
        .route("/api/events", get(stream_remote_web_events))
        .route("/api/command", post(post_remote_web_command))
        .fallback(remote_web_not_found)
        .with_state(state);

    if let Err(error) = axum::serve(listener, app)
        .with_graceful_shutdown(wait_for_remote_web_shutdown(shutdown))
        .await
    {
        eprintln!("Mission Control web server stopped unexpectedly: {error}");
    }
}

async fn wait_for_remote_web_shutdown(shutdown: Arc<AtomicBool>) {
    while !shutdown.load(Ordering::SeqCst) {
        tokio::time::sleep(SERVER_ACCEPT_POLL_INTERVAL).await;
    }
}

async fn serve_mission_control_html() -> Response {
    let mut response = Html(mission_control_html()).into_response();
    add_secure_html_headers(response.headers_mut());
    response
}

async fn create_remote_web_session(
    AxumState(state): AxumState<RemoteWebServerState>,
    headers: HeaderMap,
) -> Response {
    if !headers_have_current_pairing_token(&headers, &state.shared) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Mission Control pairing token is missing or invalid." }),
        );
    }

    if !state_changing_headers_allowed(&headers) {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "Cross-origin Mission Control session rejected." }),
        );
    }

    let control_state = RemoteControlState {
        shared: state.shared.clone(),
    };
    let user_agent = header_to_str(&headers, "user-agent");

    match control_state.create_web_session(user_agent) {
        Ok(session_token) => {
            let mut response = json_response(StatusCode::OK, json!({ "ok": true }));
            match HeaderValue::from_str(&create_session_cookie(&session_token)) {
                Ok(cookie) => {
                    response.headers_mut().insert("Set-Cookie", cookie);
                    response
                }
                Err(_) => json_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    json!({ "error": "Unable to create Mission Control web session cookie." }),
                ),
            }
        }
        Err(error) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": error })),
    }
}

async fn get_remote_web_status(
    AxumState(state): AxumState<RemoteWebServerState>,
    headers: HeaderMap,
) -> Response {
    if !headers_are_authorized(&headers, &state.shared) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Mission Control token is missing or invalid." }),
        );
    }

    let snapshot = {
        let Ok(inner) = state.shared.inner.lock() else {
            return json_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "Mission Control state is unavailable." }),
            );
        };
        create_snapshot_locked(&inner)
    };

    json_response(StatusCode::OK, json!(snapshot))
}

async fn stream_remote_web_events(
    AxumState(state): AxumState<RemoteWebServerState>,
    headers: HeaderMap,
) -> Response {
    if !headers_are_authorized(&headers, &state.shared) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Mission Control token is missing or invalid." }),
        );
    }

    let shared = state.shared.clone();
    let shutdown = state.shutdown.clone();
    let stream = async_stream::stream! {
        let mut last_event_id = 0;

        while !shutdown.load(Ordering::SeqCst) {
            let snapshot = {
                let Ok(inner) = shared.inner.lock() else {
                    break;
                };
                create_snapshot_locked(&inner)
            };

            if snapshot.event_id != last_event_id {
                last_event_id = snapshot.event_id;

                if let Ok(payload) = serde_json::to_string(&snapshot) {
                    yield Ok::<Event, Infallible>(
                        Event::default()
                            .event("snapshot")
                            .id(snapshot.event_id.to_string())
                            .data(payload),
                    );
                }
            }

            tokio::time::sleep(Duration::from_millis(750)).await;
        }
    };

    let mut response = Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(SSE_KEEPALIVE_INTERVAL)
                .text("keep-alive"),
        )
        .into_response();
    add_no_store_header(response.headers_mut());
    response
}

async fn post_remote_web_command(
    AxumState(state): AxumState<RemoteWebServerState>,
    headers: HeaderMap,
    Json(parsed): Json<RemoteCommandRequest>,
) -> Response {
    if !headers_are_authorized(&headers, &state.shared) {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "Mission Control token is missing or invalid." }),
        );
    }

    if !state_changing_headers_allowed(&headers) {
        return json_response(
            StatusCode::FORBIDDEN,
            json!({ "error": "Cross-origin Mission Control command rejected." }),
        );
    }

    let event = match normalize_command(parsed) {
        Ok(event) => event,
        Err(error) => return json_response(StatusCode::BAD_REQUEST, json!({ "error": error })),
    };

    let control_state = RemoteControlState {
        shared: state.shared.clone(),
    };
    control_state.record_command(&event);

    if event.kind == "cancel" {
        if let Some(task_id) = event.task_id.as_deref() {
            let cancel_state = state.app_handle.state::<DesktopTaskCancelMap>();
            request_desktop_task_cancel(&cancel_state, task_id);
        }
    }

    let _ = state
        .app_handle
        .emit(REMOTE_CONTROL_COMMAND_EVENT, event.clone());

    json_response(
        StatusCode::ACCEPTED,
        json!({
            "ok": true,
            "commandId": event.command_id,
        }),
    )
}

async fn remote_web_not_found(method: Method, uri: Uri) -> Response {
    json_response(
        StatusCode::NOT_FOUND,
        json!({
            "error": "Mission Control endpoint not found.",
            "method": method.as_str(),
            "path": uri.path(),
        }),
    )
}

fn json_response(status: StatusCode, body: Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    add_no_store_header(response.headers_mut());
    response
}

fn add_no_store_header(headers: &mut HeaderMap) {
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-store, must-revalidate"),
    );
}

fn add_secure_html_headers(headers: &mut HeaderMap) {
    add_no_store_header(headers);
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
}
