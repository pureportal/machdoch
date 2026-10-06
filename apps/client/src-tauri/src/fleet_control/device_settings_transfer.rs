use serde_json::{json, Value};
use tauri::Manager;

use crate::settings_transfer::{self, SettingsFileTransferState, SettingsTransferState};

use super::device_settings::{encoded, parse};

pub(super) async fn invoke(
    app: &tauri::AppHandle,
    command: &str,
    args: &Value,
) -> Result<Value, Value> {
    let state = app.state::<SettingsTransferState>();
    let files = app.state::<SettingsFileTransferState>();
    match command {
        "get_settings_transfer_status" => Ok(json!(
            settings_transfer::get_settings_transfer_status(state)
        )),
        "get_settings_transfer_catalog" => {
            encoded(settings_transfer::get_settings_transfer_catalog(app.clone(), state).await)
        }
        "start_settings_transfer" => encoded(
            settings_transfer::start_settings_transfer(
                app.clone(),
                state,
                files,
                parse(args, "request")?,
            )
            .await,
        ),
        "start_settings_receive" => encoded(
            settings_transfer::start_settings_receive(
                app.clone(),
                state,
                files,
                parse(args, "request")?,
            )
            .await,
        ),
        "connect_settings_transfer" => encoded(settings_transfer::connect_settings_transfer(
            state,
            parse(args, "request")?,
        )),
        "confirm_settings_transfer_pairing" => {
            encoded(settings_transfer::confirm_settings_transfer_pairing(state))
        }
        "approve_settings_transfer" => encoded(settings_transfer::approve_settings_transfer(state)),
        "stop_settings_transfer" => {
            encoded(settings_transfer::stop_settings_transfer(app.clone(), state).await)
        }
        "export_encrypted_settings_file" => {
            crate::media::fleet_transfer::require_transfer_path(
                app,
                args["request"]["destinationPath"]
                    .as_str()
                    .unwrap_or_default(),
                true,
            )
            .map_err(|error| json!(error))?;
            encoded(
                settings_transfer::export_encrypted_settings_file(
                    app.clone(),
                    state,
                    files,
                    parse(args, "request")?,
                )
                .await,
            )
        }
        "inspect_encrypted_settings_file" => {
            crate::media::fleet_transfer::require_transfer_path(
                app,
                args["request"]["sourcePath"].as_str().unwrap_or_default(),
                false,
            )
            .map_err(|error| json!(error))?;
            encoded(
                settings_transfer::inspect_encrypted_settings_file(
                    app.clone(),
                    state,
                    files,
                    parse(args, "request")?,
                )
                .await,
            )
        }
        "commit_encrypted_settings_file_import" => encoded(
            settings_transfer::commit_encrypted_settings_file_import(
                app.clone(),
                state,
                files,
                parse(args, "request")?,
            )
            .await,
        ),
        "cancel_encrypted_settings_file_import" => {
            encoded(settings_transfer::cancel_encrypted_settings_file_import(
                files,
                parse(args, "request")?,
            ))
        }
        _ => Err(json!("Unknown settings transfer operation.")),
    }
}
