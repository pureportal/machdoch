mod categories;
mod contract;
mod discovery;
mod protocol;
mod session;
mod transaction;

use tauri::{AppHandle, State};

pub(crate) use session::SettingsTransferState;

use contract::{
    ConnectSettingsTransferRequest, SettingsTransferStatus, StartSettingsReceiveRequest,
    StartSettingsTransferRequest,
};

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    transaction::recover_pending_transaction(app)
}

#[tauri::command]
pub(crate) fn get_settings_transfer_status(
    state: State<'_, SettingsTransferState>,
) -> SettingsTransferStatus {
    state.status()
}

#[tauri::command]
pub(crate) async fn get_settings_transfer_catalog(
    app: AppHandle,
    state: State<'_, SettingsTransferState>,
) -> Result<SettingsTransferStatus, String> {
    session::inspect_catalog(app, &state).await
}

#[tauri::command]
pub(crate) async fn start_settings_transfer(
    app: AppHandle,
    state: State<'_, SettingsTransferState>,
    request: StartSettingsTransferRequest,
) -> Result<SettingsTransferStatus, String> {
    session::start_send(app, state.inner().clone(), request).await
}

#[tauri::command]
pub(crate) async fn start_settings_receive(
    app: AppHandle,
    state: State<'_, SettingsTransferState>,
    request: StartSettingsReceiveRequest,
) -> Result<SettingsTransferStatus, String> {
    session::start_receive(app, state.inner().clone(), request).await
}

#[tauri::command]
pub(crate) fn connect_settings_transfer(
    state: State<'_, SettingsTransferState>,
    request: ConnectSettingsTransferRequest,
) -> Result<(), String> {
    session::connect(&state, request)
}

#[tauri::command]
pub(crate) fn confirm_settings_transfer_pairing(
    state: State<'_, SettingsTransferState>,
) -> Result<(), String> {
    session::confirm_pairing(&state)
}

#[tauri::command]
pub(crate) fn approve_settings_transfer(
    state: State<'_, SettingsTransferState>,
) -> Result<(), String> {
    session::approve(&state)
}

#[tauri::command]
pub(crate) async fn stop_settings_transfer(
    app: AppHandle,
    state: State<'_, SettingsTransferState>,
) -> Result<SettingsTransferStatus, String> {
    let state = state.inner().clone();
    Ok(session::stop(app, &state).await)
}
