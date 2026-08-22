mod categories;
mod contract;
mod discovery;
mod encrypted_file;
mod protocol;
mod service;
mod session;
mod transaction;

use tauri::{AppHandle, State};

pub(crate) use encrypted_file::SettingsFileTransferState;
pub(crate) use session::SettingsTransferState;

use contract::{
    CancelEncryptedSettingsFileImportRequest, CommitEncryptedSettingsFileImportRequest,
    ConnectSettingsTransferRequest, EncryptedSettingsFileExportResult,
    EncryptedSettingsFileImportResult, EncryptedSettingsFileImportReview,
    ExportEncryptedSettingsFileRequest, InspectEncryptedSettingsFileRequest,
    SettingsTransferStatus, StartSettingsReceiveRequest, StartSettingsTransferRequest,
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
    file_state: State<'_, SettingsFileTransferState>,
    request: StartSettingsTransferRequest,
) -> Result<SettingsTransferStatus, String> {
    session::start_send(
        app,
        state.inner().clone(),
        file_state.inner().clone(),
        request,
    )
    .await
}

#[tauri::command]
pub(crate) async fn start_settings_receive(
    app: AppHandle,
    state: State<'_, SettingsTransferState>,
    file_state: State<'_, SettingsFileTransferState>,
    request: StartSettingsReceiveRequest,
) -> Result<SettingsTransferStatus, String> {
    session::start_receive(
        app,
        state.inner().clone(),
        file_state.inner().clone(),
        request,
    )
    .await
}

#[tauri::command]
pub(crate) async fn export_encrypted_settings_file(
    app: AppHandle,
    state: State<'_, SettingsTransferState>,
    file_state: State<'_, SettingsFileTransferState>,
    request: ExportEncryptedSettingsFileRequest,
) -> Result<EncryptedSettingsFileExportResult, String> {
    encrypted_file::export_encrypted_settings_file(app, state.inner(), file_state.inner(), request)
        .await
}

#[tauri::command]
pub(crate) async fn inspect_encrypted_settings_file(
    app: AppHandle,
    state: State<'_, SettingsTransferState>,
    file_state: State<'_, SettingsFileTransferState>,
    request: InspectEncryptedSettingsFileRequest,
) -> Result<EncryptedSettingsFileImportReview, String> {
    encrypted_file::inspect_encrypted_settings_file(
        app,
        state.inner(),
        file_state.inner().clone(),
        request,
    )
    .await
}

#[tauri::command]
pub(crate) async fn commit_encrypted_settings_file_import(
    app: AppHandle,
    state: State<'_, SettingsTransferState>,
    file_state: State<'_, SettingsFileTransferState>,
    request: CommitEncryptedSettingsFileImportRequest,
) -> Result<EncryptedSettingsFileImportResult, String> {
    encrypted_file::commit_encrypted_settings_file_import(
        app,
        state.inner(),
        file_state.inner(),
        request,
    )
    .await
}

#[tauri::command]
pub(crate) fn cancel_encrypted_settings_file_import(
    file_state: State<'_, SettingsFileTransferState>,
    request: CancelEncryptedSettingsFileImportRequest,
) -> Result<bool, String> {
    encrypted_file::cancel_encrypted_settings_file_import(file_state.inner(), request)
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
