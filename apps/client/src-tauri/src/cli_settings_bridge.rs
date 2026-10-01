use std::{fs, sync::Arc, time::Duration};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_store::StoreExt;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    settings_transfer::categories,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsRequest {
    token: String,
    action: String,
    #[serde(default)]
    setting: String,
    value: Option<Value>,
}

pub(crate) fn initialize(app: &AppHandle) -> Result<(), String> {
    let root = crate::runtime_snapshot::get_user_config_directory()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let mut random = [0u8; 32];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let descriptor = json!({"version": 1, "pid": std::process::id(), "port": port, "token": token});
    write_file_atomic(
        &root.join("cli-settings-bridge.json"),
        serde_json::to_string(&descriptor)
            .map_err(|error| error.to_string())?
            .as_bytes(),
        AtomicWriteOptions::with_unix_mode(0o600),
    )
    .map_err(|error| error.to_string())?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("CLI settings bridge: {error}");
                return;
            }
        };
        let token = Arc::new(token);
        let permits = Arc::new(tokio::sync::Semaphore::new(8));
        while let Ok((stream, address)) = listener.accept().await {
            if !address.ip().is_loopback() {
                continue;
            }
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                continue;
            };
            let app = app.clone();
            let token = token.clone();
            tauri::async_runtime::spawn(async move {
                let _permit = permit;
                let (reader, mut writer) = stream.into_split();
                let mut reader = BufReader::new(reader);
                let mut line = Vec::new();
                let request = tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        let bytes = reader.fill_buf().await.map_err(|error| error.to_string())?;
                        if bytes.is_empty() {
                            return Err("Incomplete settings request".to_string());
                        }
                        let end = bytes.iter().position(|byte| *byte == b'\n');
                        let count = end.map_or(bytes.len(), |end| end + 1);
                        if line.len() + count > 65_536 {
                            return Err("Settings request is too large".to_string());
                        }
                        line.extend_from_slice(&bytes[..count]);
                        reader.consume(count);
                        if end.is_some() {
                            break;
                        }
                    }
                    let request: SettingsRequest = serde_json::from_slice(&line)
                        .map_err(|_| "Invalid settings request".to_string())?;
                    if request.token != *token {
                        return Err("Settings authentication failed".to_string());
                    }
                    Ok(request)
                })
                .await;
                let result = match request {
                    Ok(Ok(request)) => execute(app, request).await,
                    Ok(Err(error)) => Err(error),
                    Err(_) => Err("Settings request timed out".to_string()),
                };
                let response = match result {
                    Ok(value) => json!({"ok": true, "data": value}),
                    Err(error) => json!({"ok": false, "error": error}),
                };
                if let Err(error) = writer.write_all(format!("{response}\n").as_bytes()).await {
                    eprintln!("CLI settings response: {error}");
                }
            });
        }
    });
    Ok(())
}

fn snapshot(app: &AppHandle) -> Result<Value, String> {
    let store = app
        .store(categories::store_file())
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "appearance": store.get(categories::appearance_store_key()).unwrap_or(json!({"version": 1, "theme": "dark", "density": "comfortable", "accent": "sky"})),
        "defaults": categories::chat_voice_preferences_from_sources(app)?,
        "desktop": crate::runtime_snapshot::load_user_desktop_settings(app)?,
        "assets": crate::media::storage::media_get_asset_storage(app.clone()).map_err(|error| format!("{error:?}"))?,
        "civitai": crate::media::civitai_commands::media_civitai_connection().map_err(|error| format!("{error:?}"))?,
    }))
}

async fn execute(app: AppHandle, request: SettingsRequest) -> Result<Value, String> {
    if request.action == "transfer" {
        return transfer(app, request.setting, request.value.unwrap_or(json!({}))).await;
    }
    if request.action == "snapshot" {
        return tauri::async_runtime::spawn_blocking(move || snapshot(&app))
            .await
            .map_err(|error| error.to_string())?;
    }
    if request.action == "action" && request.setting == "desktop.clear-cache" {
        crate::desktop_shell::clear_webview_cache(app)?;
        return Ok(json!("Cache cleared"));
    }
    if request.action == "action" && request.setting == "assets.resume" {
        return serde_json::to_value(
            crate::media::storage::media_resume_asset_storage(app)
                .map_err(|error| format!("{error:?}"))?,
        )
        .map_err(|error| error.to_string());
    }
    if request.action != "set" {
        return Err("Unknown settings action".to_string());
    }
    let value = request.value.ok_or("A setting value is required")?;
    if request.setting == "assets.folder" {
        let folder = value.as_str().ok_or("Choose an asset folder")?.to_string();
        return serde_json::to_value(
            crate::media::storage::media_move_asset_storage(app, folder)
                .await
                .map_err(|error| format!("{error:?}"))?,
        )
        .map_err(|error| error.to_string());
    }
    if request.setting == "civitai.key" {
        let token = value.as_str().ok_or("Enter a Civitai API key")?;
        crate::media::civitai_commands::media_connect_civitai(if token.is_empty() {
            None
        } else {
            Some(token.to_string())
        })
        .await
        .map_err(|error| format!("{error:?}"))?;
        return Ok(json!("configured"));
    }
    if let Some(key) = request
        .setting
        .strip_prefix("desktop.")
        .filter(|_| request.setting != "desktop.running-message-action")
    {
        let current = crate::runtime_snapshot::load_user_desktop_settings(&app)?;
        let mut current = serde_json::to_value(current).map_err(|error| error.to_string())?;
        let object = current.as_object_mut().ok_or("Invalid desktop settings")?;
        if !object.contains_key(key) {
            return Err("Unknown desktop setting".to_string());
        }
        object.insert(key.to_string(), value);
        let settings = serde_json::from_value(current).map_err(|error| error.to_string())?;
        let settings =
            crate::runtime_snapshot::save_user_desktop_settings(app.clone(), settings).await?;
        app.emit("machdoch://desktop-settings-changed", &settings)
            .map_err(|error| error.to_string())?;
        return serde_json::to_value(settings).map_err(|error| error.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || set_preference(&app, &request.setting, value))
        .await
        .map_err(|error| error.to_string())?
}

async fn transfer(app: AppHandle, action: String, value: Value) -> Result<Value, String> {
    use crate::settings_transfer as settings;
    let state = app.state::<settings::SettingsTransferState>();
    let file_state = app.state::<settings::SettingsFileTransferState>();
    let result = match action.as_str() {
        "status" => serde_json::to_value(settings::get_settings_transfer_status(state)),
        "catalog" => {
            serde_json::to_value(settings::get_settings_transfer_catalog(app.clone(), state).await?)
        }
        "send" => serde_json::to_value(
            settings::start_settings_transfer(
                app.clone(),
                state,
                file_state,
                serde_json::from_value(value).map_err(|error| error.to_string())?,
            )
            .await?,
        ),
        "receive" => serde_json::to_value(
            settings::start_settings_receive(
                app.clone(),
                state,
                file_state,
                serde_json::from_value(value).map_err(|error| error.to_string())?,
            )
            .await?,
        ),
        "connect" => {
            settings::connect_settings_transfer(
                state,
                serde_json::from_value(value).map_err(|error| error.to_string())?,
            )?;
            return Ok(json!(true));
        }
        "pair" => {
            settings::confirm_settings_transfer_pairing(state)?;
            return Ok(json!(true));
        }
        "approve" => {
            settings::approve_settings_transfer(state)?;
            return Ok(json!(true));
        }
        "stop" => serde_json::to_value(settings::stop_settings_transfer(app.clone(), state).await?),
        "export" => serde_json::to_value(
            settings::export_encrypted_settings_file(
                app.clone(),
                state,
                file_state,
                serde_json::from_value(value).map_err(|error| error.to_string())?,
            )
            .await?,
        ),
        "inspect" => serde_json::to_value(
            settings::inspect_encrypted_settings_file(
                app.clone(),
                state,
                file_state,
                serde_json::from_value(value).map_err(|error| error.to_string())?,
            )
            .await?,
        ),
        "commit" => serde_json::to_value(
            settings::commit_encrypted_settings_file_import(
                app.clone(),
                state,
                file_state,
                serde_json::from_value(value).map_err(|error| error.to_string())?,
            )
            .await?,
        ),
        "cancel" => serde_json::to_value(settings::cancel_encrypted_settings_file_import(
            file_state,
            serde_json::from_value(value).map_err(|error| error.to_string())?,
        )?),
        _ => return Err("Unknown settings transfer action".to_string()),
    };
    result.map_err(|error| error.to_string())
}

fn set_preference(app: &AppHandle, setting: &str, value: Value) -> Result<Value, String> {
    let store = app
        .store(categories::store_file())
        .map_err(|error| error.to_string())?;
    if let Some(key) = setting.strip_prefix("appearance.") {
        let allowed: &[&str] = match key {
            "theme" => &["dark", "light"],
            "density" => &["comfortable", "compact"],
            "accent" => &["sky", "emerald", "violet", "amber"],
            _ => return Err("Unknown appearance setting".to_string()),
        };
        if !value.as_str().is_some_and(|value| allowed.contains(&value)) {
            return Err("Invalid appearance value".to_string());
        }
        let mut appearance = store.get(categories::appearance_store_key()).unwrap_or(
            json!({"version": 1, "theme": "dark", "density": "comfortable", "accent": "sky"}),
        );
        appearance[key] = value;
        store.set(categories::appearance_store_key(), appearance.clone());
        store.save().map_err(|error| error.to_string())?;
        app.emit(
            "machdoch://appearance-settings-changed",
            json!({"originWindowLabel": "cli"}),
        )
        .map_err(|error| error.to_string())?;
        return Ok(appearance);
    }
    let mut preferences = categories::chat_voice_preferences_from_sources(app)?;
    if let Some(key) = setting.strip_prefix("defaults.") {
        if key == "model" {
            let provider = preferences["newChat"]["provider"]
                .as_str()
                .ok_or("Choose a provider")?
                .to_string();
            preferences["newChat"]["models"][provider] = value;
        } else {
            let keys = [
                "provider",
                "mode",
                "reasoning",
                "sessionMemoryEnabled",
                "useWorkspaceMemory",
                "useGlobalMemory",
                "uiControlEnabled",
            ];
            if !keys.contains(&key) {
                return Err("Unknown new-chat default".to_string());
            }
            preferences["newChat"][key] = value;
            if key == "provider" {
                let provider = preferences["newChat"]["provider"]
                    .as_str()
                    .ok_or("Choose a provider")?
                    .to_string();
                if preferences["newChat"]["models"].get(&provider).is_none() {
                    preferences["newChat"]["models"][&provider] =
                        json!(categories::default_model_for_provider(&provider));
                }
            }
        }
    } else if let Some(key) = setting.strip_prefix("spoken-reply.") {
        if !["autoSpeakResponses", "rate"].contains(&key) {
            return Err("Unknown spoken-reply setting".to_string());
        }
        preferences["voice"][key] = value;
    } else if setting == "desktop.running-message-action" {
        preferences["runningTaskMessageAction"] = value;
    } else {
        return Err("Unknown setting".to_string());
    }
    categories::validate_chat_voice_preferences_value(&preferences)?;
    let revision = crate::shell_state::replace_chat_voice_preferences_for_settings_transfer(
        app,
        &preferences,
    )?;
    store.set(
        categories::running_task_message_action_store_key(),
        preferences["runningTaskMessageAction"].clone(),
    );
    store.save().map_err(|error| error.to_string())?;
    app.emit(
        "machdoch://shell-state-changed",
        json!({"originWindowLabel": "cli", "revision": revision}),
    )
    .map_err(|error| error.to_string())?;
    Ok(preferences)
}
