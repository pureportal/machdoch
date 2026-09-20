use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;

struct Transfer {
    path: PathBuf,
    touched: Instant,
}

#[derive(Default)]
pub(crate) struct FleetTransferState(Mutex<HashMap<String, Transfer>>);

pub(super) fn execute(app: &tauri::AppHandle, command: &str, args: &Value) -> Result<Value, Value> {
    execute_inner(app, command, args).map_err(|error| json!(error))
}

fn execute_inner(app: &tauri::AppHandle, command: &str, args: &Value) -> Result<Value, String> {
    let id = args
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Expected transfer ID.")?;
    if id.len() != 36
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("Invalid transfer ID.".into());
    }
    let state = app.state::<FleetTransferState>();
    let mut transfers = state
        .0
        .lock()
        .map_err(|_| "Transfer state is unavailable.")?;
    let expired: Vec<String> = transfers
        .iter()
        .filter(|(_, item)| item.touched.elapsed() > Duration::from_secs(3600))
        .map(|(id, _)| id.clone())
        .collect();
    for id in expired {
        if let Some(item) = transfers.remove(&id) {
            if item.path.exists() {
                fs::remove_file(&item.path).map_err(|error| error.to_string())?;
            }
        }
    }
    if command == "media_create_transfer" {
        if transfers.len() >= 16 {
            return Err("Too many file transfers. Finish an import or download first.".into());
        }
        if transfers.contains_key(id) {
            return Err("Transfer ID is already in use.".into());
        }
        let name = args
            .get("name")
            .and_then(Value::as_str)
            .ok_or("Expected filename.")?;
        if name.is_empty()
            || name.len() > 200
            || name.contains(['/', '\\', ':'])
            || name.starts_with('.')
            || name.chars().any(char::is_control)
        {
            return Err("Invalid filename.".into());
        }
        let root = super::MediaRuntimePaths::resolve(app)?
            .database
            .parent()
            .ok_or("Media directory is unavailable.")?
            .join("fleet-transfers");
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        let path = root.join(format!("{id}-{name}"));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        transfers.insert(
            id.to_string(),
            Transfer {
                path: path.clone(),
                touched: Instant::now(),
            },
        );
        return Ok(json!({ "path": path.to_string_lossy() }));
    }
    let transfer = transfers
        .get_mut(id)
        .ok_or("File transfer expired. Select the file again.")?;
    transfer.touched = Instant::now();
    if command == "media_remove_transfer" {
        fs::remove_file(&transfer.path).map_err(|error| error.to_string())?;
        transfers.remove(id);
        return Ok(Value::Null);
    }
    let offset = args
        .get("offset")
        .and_then(Value::as_u64)
        .ok_or("Expected transfer offset.")?;
    if offset > 32 * 1024 * 1024 * 1024 {
        return Err("File transfer exceeds 32 GB.".into());
    }
    if command == "media_write_transfer" {
        let data = args
            .get("data")
            .and_then(Value::as_str)
            .ok_or("Expected file data.")?;
        if data.len() > 524_288 {
            return Err("File chunk is too large.".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|error| error.to_string())?;
        if offset + bytes.len() as u64 > 32 * 1024 * 1024 * 1024 {
            return Err("File transfer exceeds 32 GB.".into());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .open(&transfer.path)
            .map_err(|error| error.to_string())?;
        if file.metadata().map_err(|error| error.to_string())?.len() != offset {
            return Err("File transfer offset changed. Select the file again.".into());
        }
        file.seek(SeekFrom::Start(offset))
            .and_then(|_| file.write_all(&bytes))
            .map_err(|error| error.to_string())?;
        Ok(json!({ "offset": offset + bytes.len() as u64 }))
    } else if command == "media_read_transfer" {
        let mut file = fs::File::open(&transfer.path).map_err(|error| error.to_string())?;
        let total = file.metadata().map_err(|error| error.to_string())?.len();
        if offset > total {
            return Err("Invalid file transfer offset.".into());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| error.to_string())?;
        let mut bytes = vec![0; (total - offset).min(393_216) as usize];
        file.read_exact(&mut bytes)
            .map_err(|error| error.to_string())?;
        Ok(
            json!({ "data": base64::engine::general_purpose::STANDARD.encode(bytes), "total": total }),
        )
    } else {
        Err("Unknown file transfer operation.".into())
    }
}
