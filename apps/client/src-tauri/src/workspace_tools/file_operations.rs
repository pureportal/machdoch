use std::{
    fs::{self, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use base64::Engine as _;
use serde::{Deserialize, Serialize};

use super::files::{
    canonical_workspace_root, delete_entry, entry_without_following_final_symlink,
    parse_entry_path, parse_requested_path, path_for_ui, resolve_existing_path,
};

const MAX_RANGE_BYTES: u64 = 1024 * 1024;
const MAX_UPLOAD_BYTES: u64 = 512 * 1024 * 1024;
const MAX_COPY_NAME_ATTEMPTS: usize = 1_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkspaceEntriesRequest {
    workspace_root: String,
    relative_paths: Vec<String>,
    trash: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryDeletion {
    path: String,
    trashed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TransferMode {
    Copy,
    Move,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyWorkspaceEntriesRequest {
    workspace_root: String,
    sources: Vec<String>,
    target_directory: String,
    mode: TransferMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportWorkspaceEntriesRequest {
    workspace_root: String,
    sources: Vec<String>,
    target_directory: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryTransfer {
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadWorkspaceFileRequest {
    workspace_root: String,
    relative_path: String,
    chunk_base64: String,
    append: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadWorkspaceFileRangeRequest {
    workspace_root: String,
    relative_path: String,
    offset: u64,
    length: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileRange {
    path: String,
    offset: u64,
    bytes_read: u64,
    total_bytes: u64,
    text: String,
    done: bool,
}

fn delete_entries_sync(
    request: DeleteWorkspaceEntriesRequest,
) -> Result<Vec<WorkspaceEntryDeletion>, String> {
    let root = canonical_workspace_root(&request.workspace_root)?;
    Ok(request
        .relative_paths
        .into_iter()
        .map(|path| match delete_entry(&root, &path, request.trash) {
            Ok(trashed) => WorkspaceEntryDeletion {
                path,
                trashed,
                error: None,
            },
            Err(error) => WorkspaceEntryDeletion {
                path,
                trashed: false,
                error: Some(error),
            },
        })
        .collect())
}

#[tauri::command]
pub async fn delete_workspace_entries(
    request: DeleteWorkspaceEntriesRequest,
) -> Result<Vec<WorkspaceEntryDeletion>, String> {
    tauri::async_runtime::spawn_blocking(move || delete_entries_sync(request))
        .await
        .map_err(|error| format!("The workspace entry deleter stopped unexpectedly: {error}"))?
}

fn copy_name(name: &str, attempt: usize) -> String {
    let (stem, extension) = match name.rfind('.') {
        Some(index) if index > 0 => (&name[..index], &name[index..]),
        _ => (name, ""),
    };
    if attempt == 1 {
        format!("{stem} copy{extension}")
    } else {
        format!("{stem} copy {attempt}{extension}")
    }
}

fn free_destination(directory: &Path, name: &str) -> Result<PathBuf, String> {
    let destination = directory.join(name);
    if fs::symlink_metadata(&destination).is_err() {
        return Ok(destination);
    }
    (1..=MAX_COPY_NAME_ATTEMPTS)
        .map(|attempt| directory.join(copy_name(name, attempt)))
        .find(|candidate| fs::symlink_metadata(candidate).is_err())
        .ok_or_else(|| "Unable to find a free name for the copy.".to_string())
}

fn copy_recursively(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("Unable to inspect `{}`: {error}", source.display()))?;
    if metadata.is_dir() {
        fs::create_dir(destination)
            .map_err(|error| format!("Unable to create `{}`: {error}", destination.display()))?;
        for entry in fs::read_dir(source)
            .map_err(|error| format!("Unable to read `{}`: {error}", source.display()))?
        {
            let entry = entry.map_err(|error| format!("Unable to read a folder entry: {error}"))?;
            copy_recursively(&entry.path(), &destination.join(entry.file_name()))?;
        }
        Ok(())
    } else if metadata.is_file() {
        fs::copy(source, destination)
            .map(|_| ())
            .map_err(|error| format!("Unable to copy `{}`: {error}", source.display()))
    } else {
        Err("Links and special files cannot be copied here.".to_string())
    }
}

fn transfer_entry(
    root: &Path,
    target: &Path,
    target_relative: &Path,
    source_path: &str,
    mode: TransferMode,
) -> Result<String, String> {
    let requested = parse_entry_path(source_path)?;
    let source = entry_without_following_final_symlink(root, &requested)?;
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Expected a file or folder.".to_string())?
        .to_string();
    if target.starts_with(&source) {
        return Err("A folder cannot be placed inside itself.".to_string());
    }
    let destination = match mode {
        TransferMode::Copy => free_destination(target, &name)?,
        TransferMode::Move => {
            let destination = target.join(&name);
            if destination == source {
                return Ok(path_for_ui(&requested));
            }
            if fs::symlink_metadata(&destination).is_ok() {
                return Err(format!("`{name}` already exists in the target folder."));
            }
            destination
        }
    };
    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&name)
        .to_string();
    match mode {
        TransferMode::Copy => copy_recursively(&source, &destination)?,
        TransferMode::Move => fs::rename(&source, &destination)
            .map_err(|error| format!("Unable to move `{name}`: {error}"))?,
    }
    Ok(path_for_ui(&target_relative.join(destination_name)))
}

fn transfer_target(root: &Path, target_directory: &str) -> Result<(PathBuf, PathBuf), String> {
    let target_relative = parse_requested_path(target_directory, true)?;
    let target = resolve_existing_path(root, &target_relative)?;
    if !target.is_dir() {
        return Err("Choose a folder as the target.".to_string());
    }
    if !target.starts_with(root) {
        return Err("The target folder is outside the workspace.".to_string());
    }
    Ok((target, target_relative))
}

fn transfer_result(source: String, result: Result<String, String>) -> WorkspaceEntryTransfer {
    match result {
        Ok(path) => WorkspaceEntryTransfer {
            source,
            path: Some(path),
            error: None,
        },
        Err(error) => WorkspaceEntryTransfer {
            source,
            path: None,
            error: Some(error),
        },
    }
}

fn copy_entries_sync(
    request: CopyWorkspaceEntriesRequest,
) -> Result<Vec<WorkspaceEntryTransfer>, String> {
    let root = canonical_workspace_root(&request.workspace_root)?;
    let (target, target_relative) = transfer_target(&root, &request.target_directory)?;
    Ok(request
        .sources
        .into_iter()
        .map(|source| {
            let result = transfer_entry(&root, &target, &target_relative, &source, request.mode);
            transfer_result(source, result)
        })
        .collect())
}

fn import_entry(target: &Path, target_relative: &Path, source: &str) -> Result<String, String> {
    let requested = Path::new(source);
    if !requested.is_absolute() {
        return Err("Expected a full path to import.".to_string());
    }
    let source = fs::canonicalize(requested)
        .map_err(|error| format!("Unable to read `{}`: {error}", requested.display()))?;
    if target.starts_with(&source) {
        return Err("A folder cannot be placed inside itself.".to_string());
    }
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Expected a file or folder.".to_string())?;
    let destination = free_destination(target, name)?;
    copy_recursively(&source, &destination)?;
    let destination_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(name);
    Ok(path_for_ui(&target_relative.join(destination_name)))
}

fn import_entries_sync(
    request: ImportWorkspaceEntriesRequest,
) -> Result<Vec<WorkspaceEntryTransfer>, String> {
    let root = canonical_workspace_root(&request.workspace_root)?;
    let (target, target_relative) = transfer_target(&root, &request.target_directory)?;
    Ok(request
        .sources
        .into_iter()
        .map(|source| {
            let result = import_entry(&target, &target_relative, &source);
            transfer_result(source, result)
        })
        .collect())
}

#[tauri::command]
pub async fn import_workspace_entries(
    request: ImportWorkspaceEntriesRequest,
) -> Result<Vec<WorkspaceEntryTransfer>, String> {
    tauri::async_runtime::spawn_blocking(move || import_entries_sync(request))
        .await
        .map_err(|error| format!("The workspace importer stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn copy_workspace_entries(
    request: CopyWorkspaceEntriesRequest,
) -> Result<Vec<WorkspaceEntryTransfer>, String> {
    tauri::async_runtime::spawn_blocking(move || copy_entries_sync(request))
        .await
        .map_err(|error| format!("The workspace entry copier stopped unexpectedly: {error}"))?
}

fn upload_file_sync(request: UploadWorkspaceFileRequest) -> Result<u64, String> {
    let root = canonical_workspace_root(&request.workspace_root)?;
    let requested = parse_entry_path(&request.relative_path)?;
    let parent_relative = requested.parent().unwrap_or_else(|| Path::new(""));
    let parent = resolve_existing_path(&root, parent_relative)?;
    if !parent.is_dir() || !parent.starts_with(&root) {
        return Err("Choose a folder inside the workspace.".to_string());
    }
    let destination = parent.join(
        requested
            .file_name()
            .ok_or_else(|| "Expected a file name.".to_string())?,
    );
    let chunk = base64::engine::general_purpose::STANDARD
        .decode(&request.chunk_base64)
        .map_err(|_| "The uploaded data is not valid base64.".to_string())?;
    let mut file = if request.append {
        OpenOptions::new().append(true).open(&destination)
    } else {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
    }
    .map_err(|error| match error.kind() {
        std::io::ErrorKind::AlreadyExists => "A file with that name already exists.".to_string(),
        _ => format!("Unable to write the file: {error}"),
    })?;
    let size = file
        .metadata()
        .map_err(|error| format!("Unable to inspect the file: {error}"))?
        .len();
    if size + chunk.len() as u64 > MAX_UPLOAD_BYTES {
        return Err("Files larger than 512 MB cannot be added here.".to_string());
    }
    file.write_all(&chunk)
        .map_err(|error| format!("Unable to write the file: {error}"))?;
    Ok(size + chunk.len() as u64)
}

#[tauri::command]
pub async fn upload_workspace_file(request: UploadWorkspaceFileRequest) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || upload_file_sync(request))
        .await
        .map_err(|error| format!("The workspace file upload stopped unexpectedly: {error}"))?
}

fn utf8_boundary(bytes: &[u8], at_end: bool) -> usize {
    if at_end {
        return bytes.len();
    }
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => bytes.len(),
    }
}

fn read_range_sync(request: ReadWorkspaceFileRangeRequest) -> Result<WorkspaceFileRange, String> {
    let root = canonical_workspace_root(&request.workspace_root)?;
    let requested = parse_requested_path(&request.relative_path, false)?;
    let path = resolve_existing_path(&root, &requested)?;
    let mut file =
        fs::File::open(&path).map_err(|error| format!("Unable to open the file: {error}"))?;
    let total_bytes = file
        .metadata()
        .map_err(|error| format!("Unable to inspect the file: {error}"))?
        .len();
    let offset = request.offset.min(total_bytes);
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("Unable to read the file: {error}"))?;
    let mut bytes = Vec::new();
    file.take(request.length.clamp(1, MAX_RANGE_BYTES))
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Unable to read the file: {error}"))?;
    let reaches_end = offset + bytes.len() as u64 >= total_bytes;
    let usable = utf8_boundary(&bytes, reaches_end);
    bytes.truncate(usable);
    Ok(WorkspaceFileRange {
        path: path_for_ui(&requested),
        offset,
        bytes_read: bytes.len() as u64,
        total_bytes,
        text: String::from_utf8_lossy(&bytes).into_owned(),
        done: offset + bytes.len() as u64 >= total_bytes,
    })
}

#[tauri::command]
pub async fn read_workspace_file_range(
    request: ReadWorkspaceFileRangeRequest,
) -> Result<WorkspaceFileRange, String> {
    tauri::async_runtime::spawn_blocking(move || read_range_sync(request))
        .await
        .map_err(|error| format!("The workspace file reader stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::{env, time::SystemTime};

    use super::*;

    fn workspace(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!("machdoch-file-ops-{name}-{unique}"));
        fs::create_dir_all(&root).expect("the workspace should be created");
        root
    }

    fn text(root: &Path) -> String {
        root.display().to_string()
    }

    #[test]
    fn names_copies_like_file_managers() {
        assert_eq!(copy_name("notes.md", 1), "notes copy.md");
        assert_eq!(copy_name("notes.md", 3), "notes copy 3.md");
        assert_eq!(copy_name(".env", 1), ".env copy");
        assert_eq!(copy_name("folder", 2), "folder copy 2");
    }

    #[test]
    fn copies_moves_and_duplicates_entries() {
        let root = workspace("transfer");
        fs::create_dir_all(root.join("src/nested")).expect("folders should be created");
        fs::write(root.join("src/a.txt"), "a").expect("file should be written");
        fs::write(root.join("src/nested/b.txt"), "b").expect("file should be written");
        fs::create_dir(root.join("target")).expect("target should be created");

        let duplicated = copy_entries_sync(CopyWorkspaceEntriesRequest {
            workspace_root: text(&root),
            sources: vec!["src/a.txt".into()],
            target_directory: "src".into(),
            mode: TransferMode::Copy,
        })
        .expect("duplicate should run");
        assert_eq!(duplicated[0].path.as_deref(), Some("src/a copy.txt"));

        let copied = copy_entries_sync(CopyWorkspaceEntriesRequest {
            workspace_root: text(&root),
            sources: vec!["src/nested".into()],
            target_directory: "target".into(),
            mode: TransferMode::Copy,
        })
        .expect("copy should run");
        assert_eq!(copied[0].path.as_deref(), Some("target/nested"));
        assert_eq!(
            fs::read_to_string(root.join("target/nested/b.txt")).unwrap(),
            "b"
        );

        let moved = copy_entries_sync(CopyWorkspaceEntriesRequest {
            workspace_root: text(&root),
            sources: vec!["src/a.txt".into(), "src".into()],
            target_directory: "src/nested".into(),
            mode: TransferMode::Move,
        })
        .expect("move should run");
        assert_eq!(moved[0].path.as_deref(), Some("src/nested/a.txt"));
        assert!(moved[1].error.is_some());
        assert!(root.join("src/nested/a.txt").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deletes_entries_and_reports_failures() {
        let root = workspace("delete");
        fs::create_dir_all(root.join("folder")).expect("folder should be created");
        fs::write(root.join("folder/a.txt"), "a").expect("file should be written");
        let deleted = delete_entries_sync(DeleteWorkspaceEntriesRequest {
            workspace_root: text(&root),
            relative_paths: vec!["folder".into(), "missing.txt".into()],
            trash: false,
        })
        .expect("delete should run");
        assert!(deleted[0].error.is_none());
        assert!(!deleted[0].trashed);
        assert!(deleted[1].error.is_some());
        assert!(!root.join("folder").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn uploads_in_chunks_and_reads_ranges_on_character_boundaries() {
        let root = workspace("upload");
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let content = "héllo wörld".as_bytes();
        upload_file_sync(UploadWorkspaceFileRequest {
            workspace_root: text(&root),
            relative_path: "upload.txt".into(),
            chunk_base64: encode(&content[..2]),
            append: false,
        })
        .expect("first chunk should write");
        let size = upload_file_sync(UploadWorkspaceFileRequest {
            workspace_root: text(&root),
            relative_path: "upload.txt".into(),
            chunk_base64: encode(&content[2..]),
            append: true,
        })
        .expect("second chunk should append");
        assert_eq!(size, content.len() as u64);
        assert!(upload_file_sync(UploadWorkspaceFileRequest {
            workspace_root: text(&root),
            relative_path: "upload.txt".into(),
            chunk_base64: encode(b"x"),
            append: false,
        })
        .is_err());

        let first = read_range_sync(ReadWorkspaceFileRangeRequest {
            workspace_root: text(&root),
            relative_path: "upload.txt".into(),
            offset: 0,
            length: 2,
        })
        .expect("first range should read");
        assert_eq!(first.text, "h");
        assert_eq!(first.bytes_read, 1);
        assert!(!first.done);
        let rest = read_range_sync(ReadWorkspaceFileRangeRequest {
            workspace_root: text(&root),
            relative_path: "upload.txt".into(),
            offset: first.bytes_read,
            length: 1024,
        })
        .expect("the rest should read");
        assert_eq!(rest.text, "éllo wörld");
        assert!(rest.done);
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn imports_files_and_folders_from_outside_the_workspace() {
        let root = workspace("import-target");
        let outside = workspace("import-source");
        fs::write(outside.join("photo.png"), "png").expect("the file should be written");
        fs::create_dir_all(outside.join("docs")).expect("the folder should be created");
        fs::write(outside.join("docs").join("a.md"), "a").expect("the file should be written");
        fs::write(root.join("photo.png"), "existing").expect("the file should be written");
        let import = |sources: Vec<String>| {
            import_entries_sync(ImportWorkspaceEntriesRequest {
                workspace_root: text(&root),
                sources,
                target_directory: ".".to_string(),
            })
            .expect("the import should run")
        };
        let results = import(vec![
            text(&outside.join("photo.png")),
            text(&outside.join("docs")),
            "relative.txt".to_string(),
        ]);
        assert_eq!(results[0].path.as_deref(), Some("photo copy.png"));
        assert_eq!(results[1].path.as_deref(), Some("docs"));
        assert!(results[2].error.is_some());
        assert_eq!(
            fs::read_to_string(root.join("docs").join("a.md")).unwrap(),
            "a"
        );
        assert_eq!(
            fs::read_to_string(root.join("photo.png")).unwrap(),
            "existing"
        );
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }
}
