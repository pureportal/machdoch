use std::{
    fs::{self, File, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::{
    atomic_file::{write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::with_cooperative_file_lock,
    runtime_snapshot::resolve_workspace_root_path,
};

const DIRECTORY_PAGE_SIZE: usize = 400;
const MAX_DIRECTORY_ENTRIES: usize = 20_000;
const MAX_EDITABLE_FILE_BYTES: u64 = 1024 * 1024;
const BINARY_SCAN_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryEntry {
    name: String,
    path: String,
    kind: String,
    target_kind: Option<String>,
    size: Option<u64>,
    modified_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectoryPage {
    path: String,
    entries: Vec<WorkspaceDirectoryEntry>,
    next_offset: Option<usize>,
    total_entries: usize,
    limit_reached: bool,
    omitted_entries: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileDocument {
    path: String,
    name: String,
    size: u64,
    modified_at: Option<u64>,
    revision: Option<String>,
    kind: String,
    preview_kind: Option<String>,
    language: Option<String>,
    content: Option<String>,
    editable: bool,
    bom: bool,
    reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceFileRequest {
    workspace_root: String,
    relative_path: String,
    content: String,
    expected_revision: String,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    bom: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceFileResult {
    status: String,
    revision: String,
    modified_at: Option<u64>,
    size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceEntryRequest {
    workspace_root: String,
    parent_path: String,
    name: String,
    kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameWorkspaceEntryRequest {
    workspace_root: String,
    relative_path: String,
    name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteWorkspaceEntryRequest {
    workspace_root: String,
    relative_path: String,
    #[serde(default)]
    recursive: bool,
}

fn canonical_workspace_root(workspace_root: &str) -> Result<PathBuf, String> {
    if workspace_root.trim().is_empty() {
        return Err("Select a workspace first.".to_string());
    }

    resolve_workspace_root_path(workspace_root)
}

fn looks_like_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\'))
        || value.starts_with("\\\\")
}

fn validate_relative_path(relative_path: &str, allow_root: bool) -> Result<PathBuf, String> {
    if relative_path.is_empty() || relative_path.chars().any(|character| character == '\0') {
        return Err("Expected a workspace-relative path.".to_string());
    }

    if looks_like_windows_absolute_path(relative_path) {
        return Err("Expected a workspace-relative path, not an absolute path.".to_string());
    }

    let path = PathBuf::from(relative_path);
    if path.is_absolute() {
        return Err("Expected a workspace-relative path, not an absolute path.".to_string());
    }

    for component in path.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err("Parent path traversal is not allowed.".to_string());
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("Expected a workspace-relative path.".to_string());
            }
        }
    }

    if !allow_root
        && path
            .components()
            .all(|component| component == Component::CurDir)
    {
        return Err("The workspace root cannot be changed by this action.".to_string());
    }

    Ok(path)
}

fn ensure_contained(root: &Path, candidate: &Path) -> Result<(), String> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        Err("Refused to access a path outside the workspace.".to_string())
    }
}

fn resolve_existing_path(
    root: &Path,
    relative_path: &str,
    allow_root: bool,
) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative_path, allow_root)?;
    let candidate = root.join(relative).canonicalize().map_err(|error| {
        format!("Unable to resolve `{relative_path}` inside the workspace: {error}")
    })?;
    ensure_contained(root, &candidate)?;
    Ok(candidate)
}

fn path_for_ui(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.is_empty() {
        ".".to_string()
    } else {
        normalized
    }
}

fn relative_path_for_ui(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Unable to create a workspace-relative path.".to_string())?;
    if relative.as_os_str().is_empty() {
        Ok(".".to_string())
    } else {
        Ok(path_for_ui(relative))
    }
}

fn system_time_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn metadata_modified_at(metadata: &fs::Metadata) -> Option<u64> {
    metadata.modified().ok().and_then(system_time_millis)
}

struct DirectoryEntryCandidate {
    name: String,
    sort_name: String,
    path: PathBuf,
    file_type: fs::FileType,
}

impl DirectoryEntryCandidate {
    fn into_entry(self, root: &Path) -> Result<WorkspaceDirectoryEntry, String> {
        let metadata = fs::symlink_metadata(&self.path).ok();
        let (kind, target_kind) = if self.file_type.is_symlink() {
            ("symlink", classify_symlink_target(root, &self.path))
        } else if self.file_type.is_dir() {
            ("directory", None)
        } else if self.file_type.is_file() {
            ("file", None)
        } else {
            ("other", None)
        };
        Ok(WorkspaceDirectoryEntry {
            name: self.name,
            path: relative_path_for_ui(root, &self.path)?,
            size: metadata
                .as_ref()
                .filter(|metadata| metadata.is_file())
                .map(fs::Metadata::len),
            modified_at: metadata.as_ref().and_then(metadata_modified_at),
            kind: kind.to_string(),
            target_kind,
        })
    }
}

fn classify_symlink_target(root: &Path, path: &Path) -> Option<String> {
    let resolved = path.canonicalize().ok()?;
    if ensure_contained(root, &resolved).is_err() {
        return None;
    }
    let metadata = fs::metadata(resolved).ok()?;
    Some(if metadata.is_dir() {
        "directory".to_string()
    } else if metadata.is_file() {
        "file".to_string()
    } else {
        "other".to_string()
    })
}

fn directory_page_window(entry_count: usize, offset: usize) -> (usize, usize, Option<usize>) {
    let start = offset.min(entry_count);
    let end = start.saturating_add(DIRECTORY_PAGE_SIZE).min(entry_count);
    let next_offset = (end < entry_count).then_some(end);
    (start, end, next_offset)
}

fn list_directory_sync(
    workspace_root: &str,
    relative_path: &str,
    offset: usize,
) -> Result<WorkspaceDirectoryPage, String> {
    let root = canonical_workspace_root(workspace_root)?;
    let directory = resolve_existing_path(&root, relative_path, true)?;
    if !directory.is_dir() {
        return Err("Expected a directory to list.".to_string());
    }

    if offset > MAX_DIRECTORY_ENTRIES {
        return Err("The directory page offset is out of range.".to_string());
    }

    let mut entries = Vec::new();
    let mut omitted_entries = 0usize;
    let mut limit_reached = false;
    let mut reader = fs::read_dir(&directory)
        .map_err(|error| format!("Unable to read `{relative_path}`: {error}"))?;

    while let Some(entry_result) = reader.next() {
        if entries.len() >= MAX_DIRECTORY_ENTRIES {
            limit_reached = true;
            omitted_entries += 1 + reader.count();
            break;
        }
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(_) => {
                omitted_entries += 1;
                continue;
            }
        };
        let Some(name) = entry.file_name().to_str().map(ToOwned::to_owned) else {
            omitted_entries += 1;
            continue;
        };
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                omitted_entries += 1;
                continue;
            }
        };
        entries.push(DirectoryEntryCandidate {
            sort_name: name.to_lowercase(),
            name,
            path,
            file_type,
        });
    }

    entries.sort_unstable_by(|left, right| {
        right
            .file_type
            .is_dir()
            .cmp(&left.file_type.is_dir())
            .then_with(|| left.sort_name.cmp(&right.sort_name))
            .then_with(|| left.name.cmp(&right.name))
    });
    let total_entries = entries.len() + omitted_entries;
    let (page_start, page_end, next_offset) = directory_page_window(entries.len(), offset);
    // Only the visible page needs metadata and symlink target resolution.
    let page_entries = entries
        .into_iter()
        .skip(page_start)
        .take(page_end - page_start)
        .map(|entry| entry.into_entry(&root))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(WorkspaceDirectoryPage {
        path: relative_path_for_ui(&root, &directory)?,
        entries: page_entries,
        next_offset,
        total_entries,
        limit_reached,
        omitted_entries,
    })
}

#[tauri::command]
pub async fn list_workspace_directory(
    workspace_root: String,
    relative_path: String,
    offset: Option<usize>,
) -> Result<WorkspaceDirectoryPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        list_directory_sync(&workspace_root, &relative_path, offset.unwrap_or(0))
    })
    .await
    .map_err(|error| format!("The workspace directory reader stopped unexpectedly: {error}"))?
}

fn extension_lower(path: &Path) -> String {
    path.extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_lowercase()
}

fn text_language(path: &Path) -> Option<&'static str> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if matches!(name.as_str(), "dockerfile" | "makefile" | "justfile") {
        return Some("shell");
    }

    match extension_lower(path).as_str() {
        "js" | "jsx" | "mjs" | "cjs" => Some("javascript"),
        "ts" | "tsx" | "mts" | "cts" => Some("typescript"),
        "json" | "jsonc" | "json5" => Some("json"),
        "md" | "mdx" | "markdown" => Some("markdown"),
        "html" | "htm" | "vue" | "svelte" => Some("html"),
        "css" | "scss" | "sass" | "less" => Some("css"),
        "rs" => Some("rust"),
        "py" | "pyi" => Some("python"),
        "go" => Some("go"),
        "java" | "kt" | "kts" => Some("java"),
        "c" | "h" | "cc" | "cpp" | "cxx" | "hpp" => Some("cpp"),
        "cs" => Some("csharp"),
        "sh" | "bash" | "zsh" | "fish" | "ps1" | "bat" | "cmd" => Some("shell"),
        "yaml" | "yml" => Some("yaml"),
        "toml" => Some("toml"),
        "xml" | "svg" => Some("xml"),
        "sql" => Some("sql"),
        "graphql" | "gql" => Some("graphql"),
        "txt" | "log" | "csv" | "tsv" | "env" | "ini" | "cfg" | "conf" => Some("text"),
        _ => None,
    }
}

fn preview_kind(path: &Path) -> Option<&'static str> {
    match extension_lower(path).as_str() {
        "md" | "markdown" => Some("markdown"),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "ico" | "avif" | "svg" => Some("image"),
        "pdf" => Some("pdf"),
        "mp3" | "wav" | "ogg" | "m4a" | "aac" | "flac" => Some("audio"),
        "mp4" | "webm" | "mov" | "m4v" => Some("video"),
        _ => None,
    }
}

fn hash_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_bounded(path: &Path, limit: u64) -> Result<(Vec<u8>, bool), String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Unable to open `{}`: {error}", path.display()))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Unable to read `{}`: {error}", path.display()))?;
    let oversized = bytes.len() as u64 > limit;
    if oversized {
        bytes.truncate(limit as usize);
    }
    Ok((bytes, oversized))
}

fn read_file_sync(
    workspace_root: &str,
    relative_path: &str,
) -> Result<WorkspaceFileDocument, String> {
    let root = canonical_workspace_root(workspace_root)?;
    let path = resolve_existing_path(&root, relative_path, false)?;
    let metadata = fs::metadata(&path)
        .map_err(|error| format!("Unable to inspect `{relative_path}`: {error}"))?;
    if !metadata.is_file() {
        return Err("Expected a file to open.".to_string());
    }

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "This filename cannot be represented as UTF-8.".to_string())?
        .to_string();
    let language = text_language(&path);
    let preview = preview_kind(&path);
    let media_only = preview.is_some() && language.is_none();

    if media_only {
        return Ok(WorkspaceFileDocument {
            path: relative_path_for_ui(&root, &path)?,
            name,
            size: metadata.len(),
            modified_at: metadata_modified_at(&metadata),
            revision: None,
            kind: "media".to_string(),
            preview_kind: preview.map(ToOwned::to_owned),
            language: None,
            content: None,
            editable: false,
            bom: false,
            reason: None,
        });
    }

    let (bytes, oversized) = if metadata.len() > MAX_EDITABLE_FILE_BYTES {
        (Vec::new(), true)
    } else {
        read_bounded(&path, MAX_EDITABLE_FILE_BYTES)?
    };
    if oversized {
        return Ok(WorkspaceFileDocument {
            path: relative_path_for_ui(&root, &path)?,
            name,
            size: metadata.len(),
            modified_at: metadata_modified_at(&metadata),
            revision: None,
            kind: "oversized".to_string(),
            preview_kind: None,
            language: language.map(ToOwned::to_owned),
            content: None,
            editable: false,
            bom: false,
            reason: Some("Files larger than 1 MB open in the system editor.".to_string()),
        });
    }

    if bytes.iter().take(BINARY_SCAN_BYTES).any(|byte| *byte == 0) {
        return Ok(WorkspaceFileDocument {
            path: relative_path_for_ui(&root, &path)?,
            name,
            size: metadata.len(),
            modified_at: metadata_modified_at(&metadata),
            revision: None,
            kind: "binary".to_string(),
            preview_kind: None,
            language: None,
            content: None,
            editable: false,
            bom: false,
            reason: Some("This binary file cannot be edited here.".to_string()),
        });
    }

    let revision = hash_bytes(&bytes);
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let text_bytes = if bom { &bytes[3..] } else { bytes.as_slice() };
    let content = match std::str::from_utf8(text_bytes) {
        Ok(content) => content.to_string(),
        Err(_) => {
            return Ok(WorkspaceFileDocument {
                path: relative_path_for_ui(&root, &path)?,
                name,
                size: metadata.len(),
                modified_at: metadata_modified_at(&metadata),
                revision: None,
                kind: "binary".to_string(),
                preview_kind: None,
                language: None,
                content: None,
                editable: false,
                bom: false,
                reason: Some("Only UTF-8 text files can be edited here.".to_string()),
            });
        }
    };

    Ok(WorkspaceFileDocument {
        path: relative_path_for_ui(&root, &path)?,
        name,
        size: metadata.len(),
        modified_at: metadata_modified_at(&metadata),
        revision: Some(revision),
        kind: "text".to_string(),
        preview_kind: preview.map(ToOwned::to_owned),
        language: Some(language.unwrap_or("text").to_string()),
        content: Some(content),
        editable: true,
        bom,
        reason: None,
    })
}

#[tauri::command]
pub async fn read_workspace_file(
    workspace_root: String,
    relative_path: String,
) -> Result<WorkspaceFileDocument, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_sync(&workspace_root, &relative_path))
        .await
        .map_err(|error| format!("The workspace file reader stopped unexpectedly: {error}"))?
}

fn write_options_for(metadata: &fs::Metadata) -> AtomicWriteOptions {
    #[cfg(unix)]
    {
        AtomicWriteOptions::with_unix_mode(metadata.permissions().mode())
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        AtomicWriteOptions::default()
    }
}

fn save_file_sync(request: SaveWorkspaceFileRequest) -> Result<SaveWorkspaceFileResult, String> {
    let root = canonical_workspace_root(&request.workspace_root)?;
    let path = resolve_existing_path(&root, &request.relative_path, false)?;
    let mut output = Vec::with_capacity(request.content.len() + usize::from(request.bom) * 3);
    if request.bom {
        output.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    output.extend_from_slice(request.content.as_bytes());
    if output.len() as u64 > MAX_EDITABLE_FILE_BYTES {
        return Err("Files larger than 1 MB cannot be saved here.".to_string());
    }

    with_cooperative_file_lock(&path, || {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Unable to inspect `{}`: {error}", path.display()))?;
        if !metadata.is_file() {
            return Err("Expected a file to save.".to_string());
        }
        let (current_bytes, current_oversized) = read_bounded(&path, MAX_EDITABLE_FILE_BYTES)?;
        if current_oversized {
            return Err("The file is now too large to save here.".to_string());
        }
        if current_bytes
            .iter()
            .take(BINARY_SCAN_BYTES)
            .any(|byte| *byte == 0)
            || std::str::from_utf8(if current_bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
                &current_bytes[3..]
            } else {
                &current_bytes
            })
            .is_err()
        {
            return Err("The file is no longer editable UTF-8 text.".to_string());
        }

        let current_revision = hash_bytes(&current_bytes);
        if !request.force && current_revision != request.expected_revision {
            return Ok(SaveWorkspaceFileResult {
                status: "conflict".to_string(),
                revision: current_revision,
                modified_at: metadata_modified_at(&metadata),
                size: metadata.len(),
            });
        }

        write_file_atomic(&path, &output, write_options_for(&metadata))
            .map_err(|error| format!("Unable to save `{}`: {error}", path.display()))?;
        let saved_metadata = fs::metadata(&path)
            .map_err(|error| format!("Unable to inspect the saved file: {error}"))?;
        Ok(SaveWorkspaceFileResult {
            status: "saved".to_string(),
            revision: hash_bytes(&output),
            modified_at: metadata_modified_at(&saved_metadata),
            size: saved_metadata.len(),
        })
    })
}

#[tauri::command]
pub async fn save_workspace_file(
    request: SaveWorkspaceFileRequest,
) -> Result<SaveWorkspaceFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || save_file_sync(request))
        .await
        .map_err(|error| format!("The workspace file writer stopped unexpectedly: {error}"))?
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.trim() != name || name == "." || name == ".." {
        return Err("Enter a valid file or folder name.".to_string());
    }
    if name.chars().count() > 255
        || name
            .chars()
            .any(|character| character.is_control() || matches!(character, '/' | '\\' | '\0'))
    {
        return Err("The name contains unsupported characters.".to_string());
    }

    #[cfg(windows)]
    {
        if name.ends_with(['.', ' '])
            || name
                .chars()
                .any(|character| matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        {
            return Err("The name contains characters Windows does not allow.".to_string());
        }
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || stem.strip_prefix("COM").is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
            || stem.strip_prefix("LPT").is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
        if reserved {
            return Err("That name is reserved by Windows.".to_string());
        }
    }

    Ok(())
}

fn create_entry_sync(request: CreateWorkspaceEntryRequest) -> Result<String, String> {
    validate_entry_name(&request.name)?;
    let root = canonical_workspace_root(&request.workspace_root)?;
    let parent = resolve_existing_path(&root, &request.parent_path, true)?;
    if !parent.is_dir() {
        return Err("Choose a folder for the new entry.".to_string());
    }
    let destination = parent.join(&request.name);
    if destination.exists() || fs::symlink_metadata(&destination).is_ok() {
        return Err("An entry with that name already exists.".to_string());
    }

    match request.kind.as_str() {
        "file" => {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|error| format!("Unable to create the file: {error}"))?;
        }
        "directory" => fs::create_dir(&destination)
            .map_err(|error| format!("Unable to create the folder: {error}"))?,
        _ => return Err("Expected a file or folder.".to_string()),
    }

    relative_path_for_ui(&root, &destination)
}

#[tauri::command]
pub async fn create_workspace_entry(
    request: CreateWorkspaceEntryRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || create_entry_sync(request))
        .await
        .map_err(|error| format!("The workspace entry creator stopped unexpectedly: {error}"))?
}

fn contained_entry_without_following_final_symlink(
    root: &Path,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative_path, false)?;
    let file_name = relative
        .file_name()
        .ok_or_else(|| "Expected a file or folder.".to_string())?;
    let parent_relative = relative.parent().unwrap_or_else(|| Path::new("."));
    let parent = root
        .join(parent_relative)
        .canonicalize()
        .map_err(|error| format!("Unable to resolve the entry's parent folder: {error}"))?;
    ensure_contained(root, &parent)?;
    let entry = parent.join(file_name);
    fs::symlink_metadata(&entry).map_err(|error| {
        format!("Unable to inspect `{relative_path}` inside the workspace: {error}")
    })?;
    Ok(entry)
}

fn rename_entry_sync(request: RenameWorkspaceEntryRequest) -> Result<String, String> {
    validate_entry_name(&request.name)?;
    let root = canonical_workspace_root(&request.workspace_root)?;
    let source = contained_entry_without_following_final_symlink(&root, &request.relative_path)?;
    let parent = source
        .parent()
        .ok_or_else(|| "Unable to resolve the entry's parent folder.".to_string())?;
    let destination = parent.join(&request.name);
    if destination == source {
        return relative_path_for_ui(&root, &source);
    }
    if destination.exists() || fs::symlink_metadata(&destination).is_ok() {
        return Err("An entry with that name already exists.".to_string());
    }
    fs::rename(&source, &destination)
        .map_err(|error| format!("Unable to rename the entry: {error}"))?;
    relative_path_for_ui(&root, &destination)
}

#[tauri::command]
pub async fn rename_workspace_entry(
    request: RenameWorkspaceEntryRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || rename_entry_sync(request))
        .await
        .map_err(|error| format!("The workspace entry renamer stopped unexpectedly: {error}"))?
}

fn remove_symlink(path: &Path) -> std::io::Result<()> {
    match fs::metadata(path) {
        Ok(metadata) if metadata.is_dir() => fs::remove_dir(path),
        _ => fs::remove_file(path),
    }
}

fn delete_entry_sync(request: DeleteWorkspaceEntryRequest) -> Result<(), String> {
    let root = canonical_workspace_root(&request.workspace_root)?;
    let path = contained_entry_without_following_final_symlink(&root, &request.relative_path)?;
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Unable to inspect the entry: {error}"))?;

    if metadata.file_type().is_symlink() {
        return remove_symlink(&path)
            .map_err(|error| format!("Unable to delete the link: {error}"));
    }

    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Unable to resolve the entry: {error}"))?;
    ensure_contained(&root, &canonical)?;
    if metadata.is_dir() {
        if request.recursive {
            fs::remove_dir_all(&canonical)
                .map_err(|error| format!("Unable to delete the folder: {error}"))
        } else {
            fs::remove_dir(&canonical).map_err(|error| {
                if error.kind() == std::io::ErrorKind::DirectoryNotEmpty {
                    "The folder is not empty.".to_string()
                } else {
                    format!("Unable to delete the folder: {error}")
                }
            })
        }
    } else if metadata.is_file() {
        fs::remove_file(&canonical).map_err(|error| format!("Unable to delete the file: {error}"))
    } else {
        Err("This entry type cannot be deleted here.".to_string())
    }
}

#[tauri::command]
pub async fn delete_workspace_entry(request: DeleteWorkspaceEntryRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_entry_sync(request))
        .await
        .map_err(|error| format!("The workspace entry deleter stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    fn test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("machdoch-workspace-tools-{name}-{unique}"))
    }

    fn create_workspace(name: &str) -> PathBuf {
        let root = test_directory(name);
        fs::create_dir_all(&root).expect("test workspace should be created");
        root
    }

    #[test]
    fn directory_pages_stop_at_the_retained_entry_limit() {
        assert_eq!(
            directory_page_window(20_000, 19_600),
            (19_600, 20_000, None)
        );
        assert_eq!(
            directory_page_window(20_000, 20_000),
            (20_000, 20_000, None)
        );
        assert_eq!(directory_page_window(401, 0), (0, 400, Some(400)));
        assert_eq!(directory_page_window(401, 400), (400, 401, None));
    }

    #[test]
    fn directory_listing_is_sorted_and_paged() {
        let root = create_workspace("listing");
        fs::write(root.join("z.txt"), "z").expect("file should write");
        fs::write(root.join("a.txt"), "a").expect("file should write");
        fs::write(root.join(".hidden"), "hidden").expect("hidden file should write");
        fs::create_dir(root.join("folder")).expect("folder should create");

        let page = list_directory_sync(root.to_string_lossy().as_ref(), ".", 0)
            .expect("directory should list");
        assert_eq!(
            page.entries
                .iter()
                .map(|entry| entry.name.as_str())
                .collect::<Vec<_>>(),
            vec!["folder", ".hidden", "a.txt", "z.txt"]
        );
        assert_eq!(page.total_entries, 4);
        assert_eq!(page.next_offset, None);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn directory_listing_pages_large_collections_without_duplicates() {
        let root = create_workspace("pagination");
        for index in 0..=DIRECTORY_PAGE_SIZE {
            fs::write(root.join(format!("file-{index:04}.txt")), index.to_string())
                .expect("paged fixture should write");
        }

        let first = list_directory_sync(root.to_string_lossy().as_ref(), ".", 0)
            .expect("first page should list");
        let second = list_directory_sync(
            root.to_string_lossy().as_ref(),
            ".",
            first.next_offset.expect("a second page should exist"),
        )
        .expect("second page should list");
        assert_eq!(first.entries.len(), DIRECTORY_PAGE_SIZE);
        assert_eq!(second.entries.len(), 1);
        assert_eq!(second.entries[0].name, "file-0400.txt");
        assert_eq!(second.entries[0].size, Some(3));
        assert!(second.entries[0].modified_at.is_some());
        assert_eq!(first.total_entries, DIRECTORY_PAGE_SIZE + 1);
        assert!(first
            .entries
            .iter()
            .all(|entry| second.entries.iter().all(|next| next.path != entry.path)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn file_save_detects_external_revision_changes() {
        let root = create_workspace("conflict");
        let file = root.join("draft.ts");
        fs::write(&file, "const value = 1;\n").expect("file should write");
        let document =
            read_file_sync(root.to_string_lossy().as_ref(), "draft.ts").expect("file should read");
        fs::write(&file, "const value = 2;\n").expect("external edit should write");

        let conflict = save_file_sync(SaveWorkspaceFileRequest {
            workspace_root: root.to_string_lossy().into_owned(),
            relative_path: "draft.ts".to_string(),
            content: "const value = 3;\n".to_string(),
            expected_revision: document.revision.expect("revision should exist"),
            force: false,
            bom: false,
        })
        .expect("conflict should be returned");
        assert_eq!(conflict.status, "conflict");
        assert_eq!(
            fs::read_to_string(&file).expect("file should remain readable"),
            "const value = 2;\n"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn create_rename_and_delete_stay_in_workspace() {
        let root = create_workspace("operations");
        let workspace_root = root.to_string_lossy().into_owned();
        let created = create_entry_sync(CreateWorkspaceEntryRequest {
            workspace_root: workspace_root.clone(),
            parent_path: ".".to_string(),
            name: "notes.txt".to_string(),
            kind: "file".to_string(),
        })
        .expect("file should create");
        assert_eq!(created, "notes.txt");
        let renamed = rename_entry_sync(RenameWorkspaceEntryRequest {
            workspace_root: workspace_root.clone(),
            relative_path: created,
            name: "plan.txt".to_string(),
        })
        .expect("file should rename");
        assert_eq!(renamed, "plan.txt");
        delete_entry_sync(DeleteWorkspaceEntryRequest {
            workspace_root,
            relative_path: renamed,
            recursive: false,
        })
        .expect("file should delete");
        assert!(!root.join("plan.txt").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_boundaries_reject_parent_and_absolute_paths() {
        let root = create_workspace("boundary");
        let workspace_root = root.to_string_lossy();
        let parent_error = list_directory_sync(workspace_root.as_ref(), "../", 0)
            .expect_err("parent traversal should fail");
        assert!(parent_error.contains("traversal"));
        let absolute_error = read_file_sync(workspace_root.as_ref(), r"C:\outside.txt")
            .expect_err("Windows absolute path should fail on every host");
        assert!(absolute_error.contains("absolute"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_and_binary_files_are_not_editable() {
        let root = create_workspace("classification");
        fs::write(root.join("binary.dat"), [0_u8, 1, 2, 3]).expect("binary should write");
        let binary = read_file_sync(root.to_string_lossy().as_ref(), "binary.dat")
            .expect("binary result should load");
        assert_eq!(binary.kind, "binary");
        assert!(!binary.editable);

        let oversized_content = vec![b'a'; MAX_EDITABLE_FILE_BYTES as usize + 1];
        fs::write(root.join("large.txt"), oversized_content).expect("large file should write");
        let oversized = read_file_sync(root.to_string_lossy().as_ref(), "large.txt")
            .expect("oversized result should load");
        assert_eq!(oversized.kind, "oversized");
        assert!(!oversized.editable);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn utf8_bom_and_preview_kinds_are_preserved() {
        let root = create_workspace("bom-preview");
        let file = root.join("notes.md");
        fs::write(&file, b"\xef\xbb\xbf# Before\n").expect("BOM fixture should write");
        let document = read_file_sync(root.to_string_lossy().as_ref(), "notes.md")
            .expect("BOM file should read");
        assert!(document.bom);
        assert_eq!(document.preview_kind.as_deref(), Some("markdown"));
        save_file_sync(SaveWorkspaceFileRequest {
            workspace_root: root.to_string_lossy().into_owned(),
            relative_path: "notes.md".to_string(),
            content: "# After\n".to_string(),
            expected_revision: document.revision.expect("revision should exist"),
            force: false,
            bom: document.bom,
        })
        .expect("BOM file should save");
        assert_eq!(
            fs::read(&file).expect("saved BOM file should read"),
            b"\xef\xbb\xbf# After\n"
        );

        for (name, expected) in [
            ("image.png", "image"),
            ("document.pdf", "pdf"),
            ("sound.flac", "audio"),
            ("movie.webm", "video"),
        ] {
            assert_eq!(preview_kind(Path::new(name)), Some(expected));
        }
        assert_eq!(preview_kind(Path::new("archive.zip")), None);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_targets_outside_workspace_are_not_read() {
        let root = create_workspace("symlink-root");
        let outside = create_workspace("symlink-outside");
        let outside_file = outside.join("secret.txt");
        fs::write(&outside_file, "outside").expect("outside file should write");
        std::os::unix::fs::symlink(&outside_file, root.join("linked.txt"))
            .expect("symlink should create");
        let error = read_file_sync(root.to_string_lossy().as_ref(), "linked.txt")
            .expect_err("outside symlink should be rejected");
        assert!(error.contains("outside"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }
}
