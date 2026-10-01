use std::{fs, path::PathBuf};

use super::{
    allow_file_preview_source, ensure_file_preview_path, process::open_path_in_system_shell,
    read_file_preview_sync, FilePreviewReadResult,
};

pub(super) fn resolve_local_path(path: &str) -> Result<PathBuf, String> {
    let candidate = PathBuf::from(path);

    if !candidate.is_absolute() {
        return Err("Expected an absolute file path.".to_string());
    }

    fs::canonicalize(candidate).map_err(|error| format!("Unable to find path `{path}`: {error}"))
}

#[tauri::command]
pub async fn resolve_local_file_preview_path(
    app_handle: tauri::AppHandle,
    path: String,
) -> Result<String, String> {
    let preview_path = tauri::async_runtime::spawn_blocking(move || {
        ensure_file_preview_path(resolve_local_path(&path)?)
    })
    .await
    .map_err(|error| format!("The file preview resolver stopped unexpectedly. {error}"))??;

    allow_file_preview_source(&app_handle, &preview_path)
}

#[tauri::command]
pub async fn read_local_file_preview(path: String) -> Result<FilePreviewReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_preview_sync(resolve_local_path(&path)?))
        .await
        .map_err(|error| format!("The file preview reader stopped unexpectedly. {error}"))?
}

#[tauri::command]
pub async fn reveal_local_file(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        open_path_in_system_shell(&resolve_local_path(&path)?)
    })
    .await
    .map_err(|error| format!("The file opener stopped unexpectedly. {error}"))?
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn local_file_links_resolve_existing_files_outside_the_workspace() {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "machdoch-file-link-test-{}-{timestamp}",
            std::process::id()
        ));
        fs::create_dir(&directory).unwrap();
        let file = directory.join("My preview.txt");
        fs::write(&file, "Generated preview").unwrap();

        assert_eq!(
            resolve_local_path(file.to_str().unwrap()).unwrap(),
            file.canonicalize().unwrap()
        );
        assert_eq!(
            read_file_preview_sync(resolve_local_path(file.to_str().unwrap()).unwrap())
                .unwrap()
                .content,
            "Generated preview"
        );
        assert_eq!(
            resolve_local_path(directory.to_str().unwrap()).unwrap(),
            directory.canonicalize().unwrap()
        );
        assert!(read_file_preview_sync(directory.clone()).is_err());
        assert!(resolve_local_path(directory.join("missing.png").to_str().unwrap()).is_err());
        assert!(resolve_local_path("relative/preview.png").is_err());
        fs::remove_file(file).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
