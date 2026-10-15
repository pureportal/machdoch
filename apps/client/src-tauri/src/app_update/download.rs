use super::AppUpdateState;
use serde::Serialize;
use std::time::Duration;
use tauri::{ipc::Channel, Manager as _, ResourceId, Runtime, Webview};
use tauri_plugin_updater::Update;

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum DownloadEvent {
    #[serde(rename_all = "camelCase")]
    Started { content_length: Option<u64> },
    #[serde(rename_all = "camelCase")]
    Progress { chunk_length: usize },
}

#[tauri::command]
pub(crate) async fn download_app_update<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
    on_event: Channel<DownloadEvent>,
) -> Result<bool, String> {
    let update = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|error| error.to_string())?;
    let mut update = (*update).clone();
    update.timeout = Some(Duration::from_secs(30 * 60));
    let state = webview.state::<AppUpdateState>();
    let cancellation = {
        let mut guard = state.0.lock().map_err(|_| "Update state is unavailable.")?;
        let session = guard
            .as_mut()
            .ok_or("Prepare the update before downloading.")?;
        if session.downloading || session.downloaded.is_some() {
            return Err("An update download is already running.".to_string());
        }
        session.downloading = true;
        session.cancellation.clone()
    };
    let mut started = false;
    let download = update.download(
        |chunk_length, content_length| {
            if !started {
                started = true;
                let _ = on_event.send(DownloadEvent::Started { content_length });
            }
            let _ = on_event.send(DownloadEvent::Progress { chunk_length });
        },
        || {},
    );
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => None,
        result = download => Some(result),
    };
    let mut guard = state.0.lock().map_err(|_| "Update state is unavailable.")?;
    if cancellation.is_cancelled() {
        return Ok(false);
    }
    let session = guard.as_mut().ok_or("The update session has ended.")?;
    session.downloading = false;
    match result {
        Some(Ok(bytes)) => {
            session.downloaded = Some((rid, bytes));
            Ok(true)
        }
        Some(Err(error)) => Err(error.to_string()),
        None => Ok(false),
    }
}

#[tauri::command]
pub(crate) fn cancel_app_update_download<R: Runtime>(webview: Webview<R>) -> Result<(), String> {
    let state = webview.state::<AppUpdateState>();
    let mut guard = state.0.lock().map_err(|_| "Update state is unavailable.")?;
    if let Some(session) = guard.as_mut() {
        session.cancellation.cancel();
        session.downloaded = None;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn install_app_update<R: Runtime>(
    webview: Webview<R>,
    rid: ResourceId,
) -> Result<(), String> {
    let update = webview
        .resources_table()
        .get::<Update>(rid)
        .map_err(|error| error.to_string())?;
    let bytes = {
        let state = webview.state::<AppUpdateState>();
        let mut guard = state.0.lock().map_err(|_| "Update state is unavailable.")?;
        let session = guard.as_mut().ok_or("The update session has ended.")?;
        if session.cancellation.is_cancelled() {
            return Err("The update download was canceled.".to_string());
        }
        let (download_rid, bytes) = session
            .downloaded
            .take()
            .ok_or("Download the update before installing.")?;
        if download_rid != rid {
            return Err("The downloaded package belongs to another update.".to_string());
        }
        bytes
    };
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "download_tests.rs"]
mod tests;
