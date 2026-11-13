use super::{app_update_available, AppUpdateState};
use machdoch_fleet_protocol::{AppUpdateStatus, HostErrorCode, HostResponse};
use std::time::Duration;
use tauri::{AppHandle, Emitter as _, Manager as _};
use tauri_plugin_updater::UpdaterExt as _;

pub(crate) const REMOTE_UPDATE_EVENT: &str = "app-update-requested";
const REMOTE_UPDATE_CHECK_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn request_remote_update(app: &AppHandle) -> HostResponse {
    if !app_update_available() {
        return error(
            HostErrorCode::Unavailable,
            "Updates require an installed release build.",
        );
    }
    match app.state::<AppUpdateState>().0.lock() {
        Ok(session) if session.is_some() => {
            return error(HostErrorCode::Conflict, "An update is already in progress.")
        }
        Ok(_) => {}
        Err(_) => return error(HostErrorCode::Internal, "Update state is unavailable."),
    }
    let checked = tauri::async_runtime::block_on(async {
        app.updater_builder()
            .header("Cache-Control", "no-cache")?
            .timeout(REMOTE_UPDATE_CHECK_TIMEOUT)
            .build()?
            .check()
            .await
    });
    match checked {
        Ok(None) => HostResponse::AppUpdate {
            status: AppUpdateStatus::Current,
            version: app.package_info().version.to_string(),
        },
        Ok(Some(update)) => match app.emit(REMOTE_UPDATE_EVENT, ()) {
            Ok(()) => HostResponse::AppUpdate {
                status: AppUpdateStatus::Installing,
                version: update.version,
            },
            Err(failure) => error(
                HostErrorCode::Internal,
                &format!("Could not start the update. {failure}"),
            ),
        },
        Err(failure) => error(
            HostErrorCode::Unavailable,
            &format!("Could not check for updates. {failure}"),
        ),
    }
}

fn error(code: HostErrorCode, message: &str) -> HostResponse {
    HostResponse::Error {
        code,
        message: message.to_string(),
    }
}
