#[cfg(not(windows))]
compile_error!("The Windows storage helper requires Windows.");

#[cfg(windows)]
mod storage_mount;
#[cfg(windows)]
mod storage_windows;

#[cfg(windows)]
fn main() {
    use std::io::Read;
    let mut bytes = Vec::new();
    let result = std::io::stdin()
        .lock()
        .take(16385)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())
        .and_then(|_| {
            if bytes.len() > 16384 {
                return Err("Storage request exceeds its limit".to_string());
            }
            let request = serde_json::from_slice(&bytes)
                .map_err(|_| "Invalid storage request".to_string())?;
            storage_windows::execute(request)
        });
    match result {
        Ok(value) => println!("{}", serde_json::json!({"ok":true,"volume":value})),
        Err(error) => {
            println!("{}", serde_json::json!({"ok":false,"error":error}));
            std::process::exit(1);
        }
    }
}
