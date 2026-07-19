use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufReader, Read as _, Seek as _, SeekFrom, Write as _},
    path::{Path, PathBuf},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter as _, Manager as _, Runtime};
use tauri_plugin_store::StoreExt as _;
use zeroize::{Zeroize as _, Zeroizing};

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt as _;

use crate::{
    atomic_file::{rename_file_atomic, write_file_atomic, AtomicWriteOptions},
    cooperative_file_lock::{acquire_cooperative_file_lock, CooperativeFileLock},
    runtime_snapshot::{get_user_config_directory, user_config},
};

use super::{
    categories::{
        appearance_store_key, category_data_json, category_file_entries,
        category_resource_lock_paths, has_file_ancestor_collision, marketplace_store_key,
        provider_enrollment_reconcile_lock_path, ralph_flow_id_from_path,
        ralph_instruction_flow_id, relative_path_to_wire, snapshot_category, store_file,
        validate_wire_path, verify_unlinked_directory_chain, zeroize_json_value, zeroize_snapshot,
        zeroize_snapshot_availability, MAX_MCP_BYTES, MAX_RALPH_FLOW_BYTES, MAX_TEXT_FILE_BYTES,
        MAX_TOTAL_ITEMS, MAX_USER_CONFIG_BYTES,
    },
    contract::{CategorySnapshot, SettingsCategoryId, SnapshotAvailability, TransferEnvelope},
};

const TRANSACTION_DIRECTORY: &str = ".settings-transfer";
const JOURNAL_FILE: &str = "settings-transfer-journal.json";
const RETIRED_JOURNAL_FILE: &str = "settings-transfer-journal.retired";
const BACKUP_FILE: &str = "rollback.json";
const PAYLOAD_FILE: &str = "payload.json";
const JOURNAL_VERSION: u16 = 1;
const SETTINGS_IMPORTED_EVENT: &str = "machdoch://settings-imported";
pub(crate) const MAX_WIRE_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024;
const MAX_RECOVERY_BACKUP_BYTES: usize = 96 * 1024 * 1024;
// Base64 expands file-backed resources by roughly one third. Keeping all raw
// rollback resources within 64 MiB leaves room for paths and JSON framing while
// guaranteeing the serialized journal backup remains below its 96 MiB cap.
const MAX_RECOVERY_RAW_BYTES: u64 = 64 * 1024 * 1024;
// The lease covers backup, write, verification, and possible rollback. Keep it
// longer than the connected transfer window so another window cannot begin a
// store write while a slow disk is still completing the journaled transaction.
const STORE_LEASE_MILLIS: u64 = 15 * 60 * 1_000;
const STORE_LEASE_RETRY_COUNT: usize = 250;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileBackupEntry {
    relative_path: String,
    base64_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResourceBackup {
    categories: BTreeSet<SettingsCategoryId>,
    user_config: Option<Option<String>>,
    mcp_config: Option<Option<String>>,
    store_values: BTreeMap<String, Option<Value>>,
    files: BTreeMap<SettingsCategoryId, Vec<FileBackupEntry>>,
}

impl Drop for ResourceBackup {
    fn drop(&mut self) {
        for value in [&mut self.user_config, &mut self.mcp_config] {
            if let Some(Some(value)) = value {
                value.zeroize();
            }
            *value = None;
        }
        for (mut key, value) in std::mem::take(&mut self.store_values) {
            key.zeroize();
            if let Some(mut value) = value {
                zeroize_json_value(&mut value);
            }
        }
        for (_, mut entries) in std::mem::take(&mut self.files) {
            for entry in &mut entries {
                entry.relative_path.zeroize();
                entry.base64_content.zeroize();
            }
            entries.clear();
        }
        self.categories.clear();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum JournalPhase {
    Prepared,
    Committing,
    Committed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransactionJournal {
    version: u16,
    transaction_id: String,
    categories: BTreeSet<SettingsCategoryId>,
    phase: JournalPhase,
    preview_fingerprint: String,
    backup_sha256: String,
    post_commit_fingerprint: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PreviewFingerprint {
    pub(crate) fingerprint: String,
    pub(crate) item_counts: BTreeMap<SettingsCategoryId, u32>,
}

pub(crate) struct CommitOutcome {
    pub(crate) recovery_cleanup_pending: bool,
}

pub(crate) struct PreparedTransaction<R: Runtime> {
    app: AppHandle<R>,
    root: PathBuf,
    journal_path: PathBuf,
    journal: TransactionJournal,
    backup: ResourceBackup,
    envelope: TransferEnvelope,
    _locks: Vec<CooperativeFileLock>,
    _store_leases: Vec<StoreWriteLease<R>>,
}

struct StoreWriteLease<R: Runtime> {
    app: AppHandle<R>,
    operation_id: String,
    token: String,
}

impl<R: Runtime> Drop for StoreWriteLease<R> {
    fn drop(&mut self) {
        let state = self
            .app
            .state::<crate::ui_operation::CrossWindowOperationState>();
        let _ = state.release_internal(&self.operation_id, &self.token);
    }
}

struct TransferEnvelopeGuard(Option<TransferEnvelope>);

impl Drop for TransferEnvelopeGuard {
    fn drop(&mut self) {
        if let Some(mut envelope) = self.0.take() {
            super::categories::zeroize_envelope(&mut envelope);
        }
    }
}

impl<R: Runtime> Drop for PreparedTransaction<R> {
    fn drop(&mut self) {
        super::categories::zeroize_envelope(&mut self.envelope);
    }
}

pub(crate) struct IncomingPayloadStage {
    root: PathBuf,
    file: Option<fs::File>,
    expected_bytes: u64,
    written_bytes: u64,
    digest: Sha256,
}

impl Drop for IncomingPayloadStage {
    fn drop(&mut self) {
        // Windows does not allow remove_dir_all while payload.json is open.
        // Close the handle first so plaintext staging is actually removed.
        drop(self.file.take());
        let _ = cleanup_private_directory(&self.root);
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex_encode(&Sha256::digest(bytes))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|value| format!("{value:02x}")).collect()
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn secure_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|_| "A private settings-transfer directory could not be created.".to_string())?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "A settings-transfer directory could not be inspected.".to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_windows_reparse(&metadata) {
        return Err("A settings-transfer directory is linked or invalid.".to_string());
    }
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path)
            .map_err(|_| "A settings-transfer directory could not be inspected.".to_string())?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)
            .map_err(|_| "A settings-transfer directory could not be secured.".to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
fn is_windows_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_windows_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
fn has_multiple_hard_links(_path: &Path, metadata: &fs::Metadata) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt as _;
    Ok(metadata.nlink() > 1)
}

#[cfg(windows)]
fn has_multiple_hard_links(path: &Path, _metadata: &fs::Metadata) -> Result<bool, String> {
    use std::os::windows::io::AsRawHandle as _;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let file = fs::File::open(path)
        .map_err(|_| "A settings file could not be opened safely.".to_string())?;
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the file owns a valid handle for the duration of the call and
    // `information` points to writable storage of the required Win32 type.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if succeeded == 0 {
        return Err("A settings file's link count could not be inspected.".to_string());
    }
    Ok(information.nNumberOfLinks > 1)
}

#[cfg(not(any(unix, windows)))]
fn has_multiple_hard_links(_path: &Path, _metadata: &fs::Metadata) -> Result<bool, String> {
    Ok(false)
}

fn write_private_json(path: &Path, value: &impl Serialize) -> Result<Zeroizing<Vec<u8>>, String> {
    if let Some(parent) = path.parent() {
        secure_directory(parent)?;
    }
    let mut raw = Zeroizing::new(
        serde_json::to_vec(value)
            .map_err(|_| "Settings-transfer recovery data could not be serialized.".to_string())?,
    );
    raw.push(b'\n');
    write_file_atomic(path, &raw, AtomicWriteOptions::with_unix_mode(0o600))
        .map_err(|_| "Settings-transfer recovery data could not be persisted.".to_string())?;
    Ok(raw)
}

fn cleanup_private_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err("A settings-transfer staging path is linked or invalid.".to_string());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt as _;
                if metadata.file_attributes() & 0x400 != 0 {
                    return Err("A settings-transfer staging path is a reparse point.".to_string());
                }
            }
            fs::remove_dir_all(path)
                .map_err(|_| "Settings-transfer temporary data could not be removed.".to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("A settings-transfer staging path could not be inspected.".to_string()),
    }
}

impl IncomingPayloadStage {
    pub(crate) fn create(transfer_id: &str, expected_bytes: u64) -> Result<Self, String> {
        Self::create_in_config_root(&get_user_config_directory()?, transfer_id, expected_bytes)
    }

    fn create_in_config_root(
        config_root: &Path,
        transfer_id: &str,
        expected_bytes: u64,
    ) -> Result<Self, String> {
        if !valid_transaction_id(transfer_id)
            || expected_bytes == 0
            || expected_bytes > MAX_WIRE_PAYLOAD_BYTES
        {
            return Err("INVALID_PAYLOAD_SIZE".to_string());
        }
        secure_directory(config_root)?;
        let base = config_root.join(TRANSACTION_DIRECTORY);
        secure_directory(&base)?;
        let root = base.join(format!("stage-{transfer_id}"));
        if root.exists() {
            return Err("TRANSFER_REPLAYED".to_string());
        }
        secure_directory(&root)?;
        let path = root.join(PAYLOAD_FILE);
        let mut options = fs::OpenOptions::new();
        options.create_new(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .map_err(|_| "PAYLOAD_STAGING_FAILED".to_string())?;
        Ok(Self {
            root,
            file: Some(file),
            expected_bytes,
            written_bytes: 0,
            digest: Sha256::new(),
        })
    }

    pub(crate) fn append(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        if offset != self.written_bytes
            || bytes.is_empty()
            || self
                .written_bytes
                .checked_add(bytes.len() as u64)
                .is_none_or(|total| total > self.expected_bytes)
        {
            return Err("INVALID_PAYLOAD_CHUNK".to_string());
        }
        self.file
            .as_mut()
            .ok_or_else(|| "PAYLOAD_STAGING_FAILED".to_string())?
            .write_all(bytes)
            .map_err(|_| "PAYLOAD_STAGING_FAILED".to_string())?;
        self.digest.update(bytes);
        self.written_bytes += bytes.len() as u64;
        Ok(())
    }

    pub(crate) fn finish(mut self, expected_sha256: &str) -> Result<TransferEnvelope, String> {
        if self.written_bytes != self.expected_bytes
            || expected_sha256.len() != 64
            || hex_encode(&self.digest.finalize_reset()) != expected_sha256
        {
            return Err("PAYLOAD_COMPLETENESS_FAILED".to_string());
        }
        let parsed = {
            let file = self
                .file
                .as_mut()
                .ok_or_else(|| "PAYLOAD_STAGING_FAILED".to_string())?;
            file.seek(SeekFrom::Start(0))
                .map_err(|_| "PAYLOAD_STAGING_FAILED".to_string())?;
            serde_json::from_reader::<_, TransferEnvelope>(BufReader::new(file))
                .map_err(|_| "INVALID_TRANSFER_PAYLOAD".to_string())
        };
        drop(self.file.take());
        cleanup_private_directory(&self.root).map_err(|_| "PAYLOAD_STAGING_FAILED".to_string())?;
        parsed
    }
}

fn read_optional_file(
    path: &Path,
    root: &Path,
    maximum_bytes: u64,
    remaining_bytes: &mut u64,
) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            verify_existing_regular_file(path, root)?;
            if metadata.len() > maximum_bytes {
                return Err("A receiver settings resource exceeds the rollback limit.".to_string());
            }
            let read_limit = maximum_bytes.min(*remaining_bytes);
            if metadata.len() > read_limit {
                return Err(
                    "The receiver settings exceed the bounded rollback capacity.".to_string(),
                );
            }
            let mut bytes = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
            fs::File::open(path)
                .map_err(|_| "A settings resource could not be backed up.".to_string())?
                .take(read_limit.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|_| "A settings resource could not be backed up.".to_string())?;
            if bytes.len() as u64 > maximum_bytes {
                return Err("A receiver settings resource exceeds the rollback limit.".to_string());
            }
            consume_backup_budget(remaining_bytes, bytes.len() as u64)?;
            Ok(Some(BASE64.encode(bytes)))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("A settings resource could not be inspected for backup.".to_string()),
    }
}

fn verify_existing_regular_file(path: &Path, root: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "A settings file could not be inspected.".to_string())?;
    let multiple_hard_links = has_multiple_hard_links(path, &metadata)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || is_windows_reparse(&metadata)
        || multiple_hard_links
    {
        return Err("A settings path is linked or is not a regular file.".to_string());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "The global settings root could not be resolved.".to_string())?;
    let canonical_path = path
        .canonicalize()
        .map_err(|_| "A settings file could not be resolved.".to_string())?;
    if !canonical_path.starts_with(canonical_root) {
        return Err("A settings file escapes the global settings root.".to_string());
    }
    Ok(())
}

fn is_link(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "A settings entry could not be inspected.".to_string())?;
    if metadata.file_type().is_symlink() {
        return Ok(true);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        Ok(metadata.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    Ok(false)
}

fn collect_matching_files(
    root: &Path,
    scan_root: &Path,
    predicate: impl Fn(&str, bool) -> bool + Copy,
) -> Result<Vec<PathBuf>, String> {
    if !verify_unlinked_directory_chain(root, scan_root)? {
        return Ok(Vec::new());
    }
    let mut pending = vec![scan_root.to_path_buf()];
    let mut matches = Vec::new();
    let mut visited_entries = 0_usize;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory)
            .map_err(|_| "A settings directory could not be read.".to_string())?
        {
            visited_entries = visited_entries.saturating_add(1);
            if visited_entries > MAX_TOTAL_ITEMS.saturating_mul(4) {
                return Err("A receiver settings tree contains too many entries.".to_string());
            }
            let entry = entry.map_err(|_| "A settings entry could not be read.".to_string())?;
            let path = entry.path();
            if is_link(&path)? {
                return Err("A settings tree contains a linked entry.".to_string());
            }
            let metadata = fs::metadata(&path)
                .map_err(|_| "A settings entry could not be inspected.".to_string())?;
            let relative = path
                .strip_prefix(scan_root)
                .map_err(|_| "A settings entry escaped its category root.".to_string())?;
            let relative = relative_path_to_wire(relative)?;
            if metadata.is_dir() {
                validate_wire_path(&relative)?;
                pending.push(path);
            } else if metadata.is_file() && predicate(&relative, false) {
                verify_existing_regular_file(&path, root)?;
                matches.push(path);
            }
        }
    }
    matches.sort();
    Ok(matches)
}

fn managed_files_for_category(
    root: &Path,
    category: SettingsCategoryId,
) -> Result<Vec<PathBuf>, String> {
    match category {
        SettingsCategoryId::GlobalInstructions => {
            let mut files = Vec::new();
            let always = root.join("instructions.md");
            match fs::symlink_metadata(&always) {
                Ok(_) => {
                    verify_existing_regular_file(&always, root)?;
                    files.push(always);
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err("The global instruction path could not be inspected.".to_string())
                }
            }
            files.extend(collect_matching_files(
                root,
                &root.join("instructions"),
                |relative, _| relative.ends_with(".instructions.md"),
            )?);
            Ok(files)
        }
        SettingsCategoryId::GlobalPrompts => {
            collect_matching_files(root, &root.join("prompts"), |relative, _| {
                relative.ends_with(".prompt.md")
            })
        }
        SettingsCategoryId::GlobalRalphFlows => {
            let ralph = root.join("ralph");
            let flow_root = ralph.join("flows");
            let mut flow_ids = Vec::new();
            let mut files = if verify_unlinked_directory_chain(root, &flow_root)? {
                let mut paths = Vec::new();
                for entry in fs::read_dir(&flow_root)
                    .map_err(|_| "The global RALPH flow directory could not be read.".to_string())?
                {
                    let entry = entry
                        .map_err(|_| "A global RALPH flow entry could not be read.".to_string())?;
                    let path = entry.path();
                    if is_link(&path)? {
                        return Err(
                            "The global RALPH flow directory contains a linked entry.".to_string()
                        );
                    }
                    let metadata = fs::metadata(&path).map_err(|_| {
                        "A global RALPH flow entry could not be inspected.".to_string()
                    })?;
                    if metadata.is_dir()
                        || path.extension().and_then(|value| value.to_str()) != Some("json")
                    {
                        continue;
                    }
                    verify_existing_regular_file(&path, root)?;
                    let flow_id = path
                        .file_stem()
                        .and_then(|value| value.to_str())
                        .ok_or_else(|| "A global RALPH flow filename is invalid.".to_string())?
                        .to_string();
                    flow_ids.push(flow_id);
                    paths.push(path);
                }
                paths
            } else {
                Vec::new()
            };
            for flow_id in flow_ids {
                files.extend(collect_matching_files(
                    root,
                    &ralph.join("instructions").join(flow_id),
                    |relative, _| {
                        relative == "instructions.md"
                            || (relative.starts_with("instructions/")
                                && relative.ends_with(".instructions.md"))
                    },
                )?);
            }
            files.sort();
            files.dedup();
            Ok(files)
        }
        _ => Ok(Vec::new()),
    }
}

fn consume_backup_budget(remaining_bytes: &mut u64, bytes: u64) -> Result<(), String> {
    *remaining_bytes = remaining_bytes
        .checked_sub(bytes)
        .ok_or_else(|| "The receiver settings exceed the bounded rollback capacity.".to_string())?;
    Ok(())
}

fn consume_json_backup_budget(
    value: &Option<Value>,
    remaining_bytes: &mut u64,
) -> Result<(), String> {
    if let Some(value) = value {
        let encoded = Zeroizing::new(
            serde_json::to_vec(value)
                .map_err(|_| "Desktop settings rollback data is invalid.".to_string())?,
        );
        consume_backup_budget(remaining_bytes, encoded.len() as u64)?;
    }
    Ok(())
}

fn backup_file_entries(
    root: &Path,
    paths: Vec<PathBuf>,
    remaining_bytes: &mut u64,
) -> Result<Vec<FileBackupEntry>, String> {
    if paths.len() > MAX_TOTAL_ITEMS {
        return Err("The receiver contains too many managed settings files.".to_string());
    }
    paths
        .into_iter()
        .map(|path| {
            let relative =
                relative_path_to_wire(path.strip_prefix(root).map_err(|_| {
                    "A settings file escaped the global settings root.".to_string()
                })?)?;
            validate_wire_path(&relative)?;
            let maximum_bytes =
                if relative.starts_with("ralph/flows/") && relative.ends_with(".json") {
                    MAX_RALPH_FLOW_BYTES
                } else {
                    MAX_TEXT_FILE_BYTES
                };
            let metadata = fs::metadata(&path)
                .map_err(|_| "A settings file could not be inspected for backup.".to_string())?;
            if metadata.len() > maximum_bytes {
                return Err("A receiver settings file exceeds the rollback limit.".to_string());
            }
            let read_limit = maximum_bytes.min(*remaining_bytes);
            if metadata.len() > read_limit {
                return Err(
                    "The receiver settings exceed the bounded rollback capacity.".to_string(),
                );
            }
            let mut bytes = Zeroizing::new(Vec::with_capacity(metadata.len() as usize));
            fs::File::open(&path)
                .map_err(|_| "A settings file could not be backed up.".to_string())?
                .take(read_limit.saturating_add(1))
                .read_to_end(&mut bytes)
                .map_err(|_| "A settings file could not be backed up.".to_string())?;
            if bytes.len() as u64 > maximum_bytes {
                return Err("A receiver settings file exceeds the rollback limit.".to_string());
            }
            consume_backup_budget(remaining_bytes, bytes.len() as u64)?;
            Ok(FileBackupEntry {
                relative_path: relative,
                base64_content: BASE64.encode(bytes),
            })
        })
        .collect()
}

fn uses_user_config(categories: &BTreeSet<SettingsCategoryId>) -> bool {
    categories.iter().any(|category| {
        matches!(
            category,
            SettingsCategoryId::ApiKeys
                | SettingsCategoryId::AgentProviderPreferences
                | SettingsCategoryId::DesktopAppearance
                | SettingsCategoryId::GlobalMemory
        )
    })
}

fn capture_backup<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    categories: &BTreeSet<SettingsCategoryId>,
) -> Result<ResourceBackup, String> {
    let mut remaining_bytes = MAX_RECOVERY_RAW_BYTES;
    let user_config = uses_user_config(categories)
        .then(|| {
            read_optional_file(
                &root.join("user-config.json"),
                root,
                MAX_USER_CONFIG_BYTES,
                &mut remaining_bytes,
            )
        })
        .transpose()?;
    let mcp_config = categories
        .contains(&SettingsCategoryId::GlobalMcp)
        .then(|| {
            read_optional_file(
                &root.join("mcp.json"),
                root,
                MAX_MCP_BYTES,
                &mut remaining_bytes,
            )
        })
        .transpose()?;
    let mut store_values = BTreeMap::new();
    if categories.contains(&SettingsCategoryId::DesktopAppearance)
        || categories.contains(&SettingsCategoryId::GlobalMcp)
    {
        let store = app
            .store(store_file())
            .map_err(|_| "Desktop settings storage is unavailable.".to_string())?;
        if categories.contains(&SettingsCategoryId::DesktopAppearance) {
            let value = store.get(appearance_store_key());
            consume_json_backup_budget(&value, &mut remaining_bytes)?;
            store_values.insert(appearance_store_key().to_string(), value);
        }
        if categories.contains(&SettingsCategoryId::GlobalMcp) {
            let value = store.get(marketplace_store_key());
            consume_json_backup_budget(&value, &mut remaining_bytes)?;
            store_values.insert(marketplace_store_key().to_string(), value);
        }
    }
    let mut files = BTreeMap::new();
    for category in categories.iter().copied().filter(|category| {
        matches!(
            category,
            SettingsCategoryId::GlobalInstructions
                | SettingsCategoryId::GlobalPrompts
                | SettingsCategoryId::GlobalRalphFlows
        )
    }) {
        files.insert(
            category,
            backup_file_entries(
                root,
                managed_files_for_category(root, category)?,
                &mut remaining_bytes,
            )?,
        );
    }
    let backup = ResourceBackup {
        categories: categories.clone(),
        user_config,
        mcp_config,
        store_values,
        files,
    };
    validate_resource_backup(&backup)?;
    Ok(backup)
}

fn validate_encoded_backup(value: &str, maximum_bytes: u64) -> Result<(), String> {
    let maximum_encoded = maximum_bytes
        .saturating_add(2)
        .saturating_div(3)
        .saturating_mul(4);
    if value.len() as u64 > maximum_encoded {
        return Err("Settings rollback data exceeds its resource limit.".to_string());
    }
    let decoded = Zeroizing::new(
        BASE64
            .decode(value)
            .map_err(|_| "Settings rollback data is corrupt.".to_string())?,
    );
    if decoded.len() as u64 > maximum_bytes {
        return Err("Settings rollback data exceeds its resource limit.".to_string());
    }
    Ok(())
}

fn validate_backup_file_path(
    category: SettingsCategoryId,
    relative_path: &str,
) -> Result<(), String> {
    validate_wire_path(relative_path)?;
    let valid = match category {
        SettingsCategoryId::GlobalInstructions => {
            relative_path == "instructions.md"
                || (relative_path.starts_with("instructions/")
                    && relative_path.ends_with(".instructions.md"))
        }
        SettingsCategoryId::GlobalPrompts => {
            relative_path.starts_with("prompts/") && relative_path.ends_with(".prompt.md")
        }
        SettingsCategoryId::GlobalRalphFlows => {
            relative_path.strip_prefix("ralph/").is_some_and(|path| {
                ralph_flow_id_from_path(path).is_some() || ralph_instruction_flow_id(path).is_some()
            })
        }
        _ => false,
    };
    if !valid {
        return Err("Settings rollback data contains an out-of-scope path.".to_string());
    }
    Ok(())
}

fn validate_resource_backup(backup: &ResourceBackup) -> Result<(), String> {
    if backup.categories.is_empty()
        || backup.categories.len() > SettingsCategoryId::ALL.len()
        || backup.user_config.is_some() != uses_user_config(&backup.categories)
        || backup.mcp_config.is_some() != backup.categories.contains(&SettingsCategoryId::GlobalMcp)
    {
        return Err("Settings rollback metadata is inconsistent.".to_string());
    }
    if let Some(Some(value)) = &backup.user_config {
        validate_encoded_backup(value, MAX_USER_CONFIG_BYTES)?;
    }
    if let Some(Some(value)) = &backup.mcp_config {
        validate_encoded_backup(value, MAX_MCP_BYTES)?;
    }

    let mut expected_store_keys = BTreeSet::new();
    if backup
        .categories
        .contains(&SettingsCategoryId::DesktopAppearance)
    {
        expected_store_keys.insert(appearance_store_key());
    }
    if backup.categories.contains(&SettingsCategoryId::GlobalMcp) {
        expected_store_keys.insert(marketplace_store_key());
    }
    if backup
        .store_values
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        != expected_store_keys
    {
        return Err("Settings rollback data contains an out-of-scope store key.".to_string());
    }

    let expected_file_categories = backup
        .categories
        .iter()
        .copied()
        .filter(|category| {
            matches!(
                category,
                SettingsCategoryId::GlobalInstructions
                    | SettingsCategoryId::GlobalPrompts
                    | SettingsCategoryId::GlobalRalphFlows
            )
        })
        .collect::<BTreeSet<_>>();
    if backup.files.keys().copied().collect::<BTreeSet<_>>() != expected_file_categories {
        return Err("Settings rollback file metadata is inconsistent.".to_string());
    }

    let mut total_entries = 0_usize;
    for (category, entries) in &backup.files {
        total_entries = total_entries
            .checked_add(entries.len())
            .ok_or_else(|| "Settings rollback data has too many files.".to_string())?;
        if total_entries > MAX_TOTAL_ITEMS {
            return Err("Settings rollback data has too many files.".to_string());
        }
        let mut aliases = BTreeSet::new();
        let mut ralph_flow_ids = BTreeSet::new();
        for entry in entries {
            validate_backup_file_path(*category, &entry.relative_path)?;
            let alias = entry.relative_path.to_lowercase();
            if !aliases.insert(alias) {
                return Err("Settings rollback data contains colliding paths.".to_string());
            }
            let ralph_path = entry.relative_path.strip_prefix("ralph/");
            let maximum_bytes = if *category == SettingsCategoryId::GlobalRalphFlows
                && ralph_path.and_then(ralph_flow_id_from_path).is_some()
            {
                let flow_id = ralph_path
                    .and_then(ralph_flow_id_from_path)
                    .ok_or_else(|| {
                        "Settings rollback data contains an invalid flow path.".to_string()
                    })?;
                if !ralph_flow_ids.insert(flow_id.to_string()) {
                    return Err("Settings rollback data contains an invalid flow path.".to_string());
                }
                MAX_RALPH_FLOW_BYTES
            } else {
                MAX_TEXT_FILE_BYTES
            };
            validate_encoded_backup(&entry.base64_content, maximum_bytes)?;
        }
        if has_file_ancestor_collision(aliases.iter().map(String::as_str)) {
            return Err(
                "Settings rollback data contains a path nested below another file.".to_string(),
            );
        }
        if *category == SettingsCategoryId::GlobalRalphFlows {
            for entry in entries
                .iter()
                .filter(|entry| entry.relative_path.starts_with("ralph/instructions/"))
            {
                let flow_id = entry
                    .relative_path
                    .strip_prefix("ralph/")
                    .and_then(ralph_instruction_flow_id)
                    .unwrap_or_default();
                if !ralph_flow_ids.contains(flow_id) {
                    return Err(
                        "Settings rollback data contains instructions without a matching flow."
                            .to_string(),
                    );
                }
            }
        }
    }
    Ok(())
}

fn backup_fingerprint(backup: &ResourceBackup) -> Result<String, String> {
    let bytes = Zeroizing::new(
        serde_json::to_vec(backup)
            .map_err(|_| "The receiver settings fingerprint could not be created.".to_string())?,
    );
    if bytes.len() > MAX_RECOVERY_BACKUP_BYTES {
        return Err("The receiver settings exceed the bounded rollback capacity.".to_string());
    }
    Ok(sha256_hex(&bytes))
}

pub(crate) fn capture_preview_fingerprint<R: Runtime>(
    app: &AppHandle<R>,
    categories: &BTreeSet<SettingsCategoryId>,
) -> Result<PreviewFingerprint, String> {
    let root = get_user_config_directory()?;
    secure_directory(&root)?;
    let mut locks = Vec::new();
    if let Some(path) = provider_enrollment_reconcile_lock_path(&root, categories) {
        locks.push(acquire_cooperative_file_lock(&path)?);
    }
    for path in category_resource_lock_paths(&root, categories) {
        locks.push(acquire_cooperative_file_lock(&path)?);
    }
    let backup = capture_backup(app, &root, categories)?;
    let fingerprint = backup_fingerprint(&backup)?;
    let item_counts = categories
        .iter()
        .copied()
        .map(|category| {
            let mut availability = snapshot_category(app, category);
            let count = match &availability {
                SnapshotAvailability::Available(snapshot) => snapshot.item_count,
                SnapshotAvailability::Unavailable(_) => {
                    backup.files.get(&category).map_or(0, |entries| {
                        u32::try_from(entries.len()).unwrap_or(u32::MAX)
                    })
                }
            };
            zeroize_snapshot_availability(&mut availability);
            (category, count)
        })
        .collect();
    let after = capture_backup(app, &root, categories)?;
    if backup_fingerprint(&after)? != fingerprint {
        return Err("SETTINGS_CHANGED_DURING_INSPECTION".to_string());
    }
    drop(locks);
    Ok(PreviewFingerprint {
        fingerprint,
        item_counts,
    })
}

fn lock_paths(root: &Path, categories: &BTreeSet<SettingsCategoryId>) -> Vec<PathBuf> {
    let mut paths = category_resource_lock_paths(root, categories);
    paths.push(root.join(JOURNAL_FILE));
    paths.sort();
    paths.dedup();
    paths
}

fn acquire_transaction_locks(
    root: &Path,
    categories: &BTreeSet<SettingsCategoryId>,
) -> Result<Vec<CooperativeFileLock>, String> {
    let mut locks = Vec::new();
    // Keep this first: the provider daemon holds its coordinator lock while it
    // reads and writes the same resources guarded below.
    if let Some(path) = provider_enrollment_reconcile_lock_path(root, categories) {
        locks.push(acquire_cooperative_file_lock(&path)?);
    }
    for path in lock_paths(root, categories) {
        locks.push(acquire_cooperative_file_lock(&path)?);
    }
    Ok(locks)
}

fn acquire_store_write_leases<R: Runtime>(
    app: &AppHandle<R>,
    categories: &BTreeSet<SettingsCategoryId>,
) -> Result<Vec<StoreWriteLease<R>>, String> {
    let mut operation_ids = Vec::new();
    if categories.contains(&SettingsCategoryId::DesktopAppearance) {
        operation_ids.push(format!("machdoch:store-write:{}", appearance_store_key()));
    }
    if categories.contains(&SettingsCategoryId::GlobalMcp) {
        operation_ids.push(format!("machdoch:store-write:{}", marketplace_store_key()));
    }
    operation_ids.sort();
    operation_ids.dedup();

    let state = app.state::<crate::ui_operation::CrossWindowOperationState>();
    let mut leases = Vec::new();
    for operation_id in operation_ids {
        let mut acquired = None;
        for _ in 0..STORE_LEASE_RETRY_COUNT {
            if let Some(token) = state.try_begin_internal(&operation_id, STORE_LEASE_MILLIS)? {
                acquired = Some(token);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let token = acquired.ok_or_else(|| "STORE_SETTINGS_BUSY".to_string())?;
        leases.push(StoreWriteLease {
            app: app.clone(),
            operation_id,
            token,
        });
    }
    Ok(leases)
}

fn valid_transaction_id(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn prepare_transaction<R: Runtime>(
    app: AppHandle<R>,
    envelope: TransferEnvelope,
    preview_fingerprint: &str,
) -> Result<PreparedTransaction<R>, String> {
    let mut envelope = TransferEnvelopeGuard(Some(envelope));
    let guarded_envelope = envelope
        .0
        .as_ref()
        .ok_or_else(|| "The transfer payload is unavailable.".to_string())?;
    if !valid_transaction_id(&guarded_envelope.transfer_id) {
        return Err("The transfer id is invalid.".to_string());
    }
    let categories = guarded_envelope
        .categories
        .iter()
        .map(|category| category.id)
        .collect::<BTreeSet<_>>();
    if categories.is_empty() || categories.len() != guarded_envelope.categories.len() {
        return Err("The transfer contains no unique categories.".to_string());
    }
    let root = get_user_config_directory()?;
    secure_directory(&root)?;
    let locks = acquire_transaction_locks(&root, &categories)?;
    let store_leases = acquire_store_write_leases(&app, &categories)?;
    let backup = capture_backup(&app, &root, &categories)?;
    let current_fingerprint = backup_fingerprint(&backup)?;
    if current_fingerprint != preview_fingerprint {
        return Err("RECEIVER_SETTINGS_CHANGED".to_string());
    }

    let transaction_base = root.join(TRANSACTION_DIRECTORY);
    secure_directory(&transaction_base)?;
    let transaction_id = guarded_envelope.transfer_id.clone();
    let transaction_root = transaction_base.join(&transaction_id);
    if transaction_root.exists() {
        return Err("A settings transaction with this id already exists.".to_string());
    }
    let journal_path = root.join(JOURNAL_FILE);
    if journal_path.exists() {
        return Err("A previous settings transaction still requires recovery.".to_string());
    }
    secure_directory(&transaction_root)?;
    let persistence = (|| {
        let backup_raw = write_private_json(&transaction_root.join(BACKUP_FILE), &backup)?;
        let backup_sha256 = sha256_hex(&backup_raw);
        let _payload_raw =
            write_private_json(&transaction_root.join(PAYLOAD_FILE), guarded_envelope)?;
        let journal = TransactionJournal {
            version: JOURNAL_VERSION,
            transaction_id: transaction_id.clone(),
            categories,
            phase: JournalPhase::Prepared,
            preview_fingerprint: current_fingerprint,
            backup_sha256,
            post_commit_fingerprint: None,
        };
        let _journal_raw = write_private_json(&journal_path, &journal)?;
        Ok::<_, String>(journal)
    })();
    let journal = match persistence {
        Ok(journal) => journal,
        Err(error) => {
            let _ = fs::remove_file(&journal_path);
            let _ = cleanup_private_directory(&transaction_root);
            return Err(error);
        }
    };
    let envelope = envelope
        .0
        .take()
        .ok_or_else(|| "The transfer payload is unavailable.".to_string())?;

    Ok(PreparedTransaction {
        app,
        root,
        journal_path,
        journal,
        backup,
        envelope,
        _locks: locks,
        _store_leases: store_leases,
    })
}

fn ensure_object_member<'a>(
    root: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    let value = root
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value
        .as_object_mut()
        .expect("the value was normalized to an object")
}

fn replace_member(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    key: &str,
) -> Result<(), String> {
    let value = source
        .get(key)
        .ok_or_else(|| "An imported category is missing a required field.".to_string())?;
    target.insert(key.to_string(), value.clone());
    Ok(())
}

fn apply_api_keys(
    root: &mut Map<String, Value>,
    snapshot: &CategorySnapshot,
) -> Result<(), String> {
    let value = category_data_json(snapshot)?;
    replace_member(root, value, "apiKeys")?;
    let web_search = ensure_object_member(root, "webSearch");
    web_search.insert(
        "apiKeys".to_string(),
        value
            .get("webSearchApiKeys")
            .cloned()
            .ok_or_else(|| "Imported web-search API keys are missing.".to_string())?,
    );
    Ok(())
}

fn apply_agent_provider(
    root: &mut Map<String, Value>,
    snapshot: &CategorySnapshot,
) -> Result<(), String> {
    let value = category_data_json(snapshot)?;
    ensure_object_member(root, "webSearch").insert(
        "activeProvider".to_string(),
        value["webSearchActiveProvider"].clone(),
    );
    ensure_object_member(root, "voice").insert(
        "activeProvider".to_string(),
        value["voiceActiveProvider"].clone(),
    );
    ensure_object_member(root, "speechToText").insert(
        "activeProvider".to_string(),
        value["speechToTextActiveProvider"].clone(),
    );
    replace_member(root, value, "agentLimits")?;
    replace_member(root, value, "reviewModel")?;

    let incoming = value["providerEnrollment"]
        .as_object()
        .ok_or_else(|| "Imported provider enrollment preferences are invalid.".to_string())?;
    let local = ensure_object_member(root, "providerEnrollment");
    for key in [
        "schemaVersion",
        "enabled",
        "instructions",
        "mcp",
        "providers",
    ] {
        replace_member(local, incoming, key)?;
    }
    let incoming_sync = incoming["persistentSync"]
        .as_object()
        .ok_or_else(|| "Imported provider sync preferences are invalid.".to_string())?;
    let local_sync = ensure_object_member(local, "persistentSync");
    for key in [
        "enabled",
        "watch",
        "debounceMs",
        "filesystemConvergenceTargetMs",
        "fullRescanIntervalMs",
        "autoReloadOwnedSessions",
    ] {
        replace_member(local_sync, incoming_sync, key)?;
    }
    Ok(())
}

fn apply_desktop(
    root: &mut Map<String, Value>,
    snapshot: &CategorySnapshot,
) -> Result<Value, String> {
    let value = category_data_json(snapshot)?;
    let incoming = value["desktop"]
        .as_object()
        .ok_or_else(|| "Imported desktop preferences are invalid.".to_string())?;
    let local = ensure_object_member(root, "desktop");
    for key in [
        "assistantBubbleEnabled",
        "assistantBubbleHideWhenFullscreen",
        "assistantBubbleTemporarilyHideSeconds",
        "aiContextMaxMessages",
        "inactiveSessionArchiveDays",
        "archivedSessionRetentionDays",
        "quickVoiceSilenceSeconds",
        "quickVoiceMaxMessages",
    ] {
        replace_member(local, incoming, key)?;
    }
    Ok(value["appearance"].clone())
}

fn apply_memory(root: &mut Map<String, Value>, snapshot: &CategorySnapshot) -> Result<(), String> {
    let value = category_data_json(snapshot)?;
    let local = ensure_object_member(root, "memory");
    replace_member(local, value, "globalEnabled")?;
    let mut preserved = local
        .get("entries")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("scope").and_then(Value::as_str) != Some("global"))
        .cloned()
        .collect::<Vec<_>>();
    let incoming = value
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| "Imported global memory entries are invalid.".to_string())?;
    preserved.extend(incoming.iter().cloned());
    local.insert("entries".to_string(), Value::Array(preserved));
    Ok(())
}

fn apply_user_config_categories(
    root: &Path,
    categories: &[CategorySnapshot],
) -> Result<Option<Value>, String> {
    let path = root.join("user-config.json");
    let mut config = user_config::load_user_config_value_at_path(&path)?;
    let mut appearance = None;
    {
        let config = config
            .as_object_mut()
            .ok_or_else(|| "The receiver user settings are invalid.".to_string())?;
        for snapshot in categories {
            match snapshot.id {
                SettingsCategoryId::ApiKeys => apply_api_keys(config, snapshot)?,
                SettingsCategoryId::AgentProviderPreferences => {
                    apply_agent_provider(config, snapshot)?
                }
                SettingsCategoryId::DesktopAppearance => {
                    appearance = Some(apply_desktop(config, snapshot)?)
                }
                SettingsCategoryId::GlobalMemory => apply_memory(config, snapshot)?,
                _ => {}
            }
        }
    }
    user_config::write_user_config_value_at_path(&config, &path)?;
    Ok(appearance)
}

fn create_parent_secure(root: &Path, path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "A settings destination has no parent directory.".to_string())?;
    let relative = parent
        .strip_prefix(root)
        .map_err(|_| "A settings destination escaped the global settings root.".to_string())?;
    secure_directory(root)?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err("A settings destination contains an unsafe parent path.".to_string());
        };
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata)
                if metadata.is_dir()
                    && !metadata.file_type().is_symlink()
                    && !is_windows_reparse(&metadata) => {}
            Ok(_) => {
                return Err(
                    "A settings destination parent is linked or is not a directory.".to_string(),
                )
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|_| {
                    "A settings destination directory could not be created.".to_string()
                })?;
                secure_directory(&current)?;
            }
            Err(_) => {
                return Err("A settings destination parent could not be inspected.".to_string())
            }
        }
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "The global settings root could not be resolved.".to_string())?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| "A settings destination parent could not be resolved.".to_string())?;
    if !canonical_parent.starts_with(canonical_root) {
        return Err("A settings destination escaped the global settings root.".to_string());
    }
    Ok(())
}

fn write_settings_file(root: &Path, path: &Path, contents: &[u8]) -> Result<(), String> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path)
            .map_err(|_| "A settings destination could not be inspected.".to_string())?;
        let multiple_hard_links = has_multiple_hard_links(path, &metadata)?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || is_windows_reparse(&metadata)
            || multiple_hard_links
        {
            return Err("A settings destination is linked or is not a regular file.".to_string());
        }
    }
    create_parent_secure(root, path)?;
    write_file_atomic(path, contents, AtomicWriteOptions::with_unix_mode(0o600))
        .map_err(|_| "A settings file could not be replaced.".to_string())
}

fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let multiple_hard_links = has_multiple_hard_links(path, &metadata)?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || is_windows_reparse(&metadata)
                || multiple_hard_links
            {
                return Err(
                    "A settings destination is linked or is not a regular file.".to_string()
                );
            }
            fs::remove_file(path)
                .map_err(|_| "An obsolete settings file could not be removed.".to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("A settings destination could not be inspected.".to_string()),
    }
}

fn category_destination(
    root: &Path,
    category: SettingsCategoryId,
    wire_path: &str,
) -> Result<PathBuf, String> {
    validate_wire_path(wire_path)?;
    let path = match category {
        SettingsCategoryId::GlobalInstructions | SettingsCategoryId::GlobalPrompts => {
            root.join(wire_path.replace('/', std::path::MAIN_SEPARATOR_STR))
        }
        SettingsCategoryId::GlobalRalphFlows => root
            .join("ralph")
            .join(wire_path.replace('/', std::path::MAIN_SEPARATOR_STR)),
        _ => return Err("The category does not own settings files.".to_string()),
    };
    Ok(path)
}

fn apply_file_category(root: &Path, snapshot: &CategorySnapshot) -> Result<(), String> {
    let incoming = category_file_entries(snapshot)?;
    let incoming_paths = incoming
        .iter()
        .map(|entry| category_destination(root, snapshot.id, &entry.relative_path))
        .collect::<Result<BTreeSet<_>, _>>()?;
    let existing = managed_files_for_category(root, snapshot.id)?;
    for path in existing {
        if !incoming_paths.contains(&path) {
            remove_file_if_exists(&path)?;
        }
    }
    for entry in incoming {
        let path = category_destination(root, snapshot.id, &entry.relative_path)?;
        write_settings_file(root, &path, entry.utf8_content.as_bytes())?;
    }
    Ok(())
}

fn apply_mcp(root: &Path, snapshot: &CategorySnapshot) -> Result<Value, String> {
    let value = category_data_json(snapshot)?;
    let exists = value["exists"]
        .as_bool()
        .ok_or_else(|| "The imported MCP file marker is invalid.".to_string())?;
    let path = root.join("mcp.json");
    if exists {
        let serialized = serde_json::to_string_pretty(&value["config"])
            .map_err(|_| "The imported MCP configuration could not be serialized.".to_string())?;
        write_settings_file(root, &path, format!("{serialized}\n").as_bytes())?;
    } else {
        remove_file_if_exists(&path)?;
    }
    Ok(value["marketplace"].clone())
}

fn apply_store_values<R: Runtime>(
    app: &AppHandle<R>,
    appearance: Option<Value>,
    marketplace: Option<Value>,
) -> Result<(), String> {
    if appearance.is_none() && marketplace.is_none() {
        return Ok(());
    }
    let store = app
        .store(store_file())
        .map_err(|_| "Desktop settings storage is unavailable.".to_string())?;
    if let Some(value) = appearance {
        store.set(appearance_store_key(), value);
    }
    if let Some(value) = marketplace {
        store.set(marketplace_store_key(), value);
    }
    store
        .save()
        .map_err(|_| "Desktop settings storage could not be saved.".to_string())
}

fn apply_envelope<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    envelope: &TransferEnvelope,
) -> Result<(), String> {
    let appearance = if envelope.categories.iter().any(|category| {
        matches!(
            category.id,
            SettingsCategoryId::ApiKeys
                | SettingsCategoryId::AgentProviderPreferences
                | SettingsCategoryId::DesktopAppearance
                | SettingsCategoryId::GlobalMemory
        )
    }) {
        apply_user_config_categories(root, &envelope.categories)?
    } else {
        None
    };
    let mut marketplace = None;
    for snapshot in &envelope.categories {
        match snapshot.id {
            SettingsCategoryId::GlobalInstructions
            | SettingsCategoryId::GlobalPrompts
            | SettingsCategoryId::GlobalRalphFlows => apply_file_category(root, snapshot)?,
            SettingsCategoryId::GlobalMcp => marketplace = Some(apply_mcp(root, snapshot)?),
            _ => {}
        }
    }
    apply_store_values(app, appearance, marketplace)
}

fn restore_optional_file(root: &Path, path: &Path, backup: &Option<String>) -> Result<(), String> {
    match backup {
        Some(encoded) => {
            let bytes = Zeroizing::new(
                BASE64
                    .decode(encoded)
                    .map_err(|_| "Settings rollback data is corrupt.".to_string())?,
            );
            write_settings_file(root, path, &bytes)
        }
        None => remove_file_if_exists(path),
    }
}

fn restore_backup<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    backup: &ResourceBackup,
) -> Result<(), String> {
    validate_resource_backup(backup)?;
    if let Some(user_config) = &backup.user_config {
        restore_optional_file(root, &root.join("user-config.json"), user_config)?;
    }
    if let Some(mcp_config) = &backup.mcp_config {
        restore_optional_file(root, &root.join("mcp.json"), mcp_config)?;
    }
    for (category, entries) in &backup.files {
        for path in managed_files_for_category(root, *category)? {
            remove_file_if_exists(&path)?;
        }
        for entry in entries {
            let path = root.join(
                entry
                    .relative_path
                    .replace('/', std::path::MAIN_SEPARATOR_STR),
            );
            validate_wire_path(&entry.relative_path)?;
            let bytes = Zeroizing::new(
                BASE64
                    .decode(&entry.base64_content)
                    .map_err(|_| "Settings rollback data is corrupt.".to_string())?,
            );
            write_settings_file(root, &path, &bytes)?;
        }
    }
    if !backup.store_values.is_empty() {
        let store = app
            .store(store_file())
            .map_err(|_| "Desktop settings storage is unavailable during rollback.".to_string())?;
        for (key, value) in &backup.store_values {
            match value {
                Some(value) => store.set(key, value.clone()),
                None => {
                    store.delete(key);
                }
            }
        }
        store
            .save()
            .map_err(|_| "Desktop settings rollback could not be saved.".to_string())?;
    }
    Ok(())
}

fn verify_import<R: Runtime>(
    app: &AppHandle<R>,
    envelope: &TransferEnvelope,
) -> Result<(), String> {
    for expected in &envelope.categories {
        let mut actual = match snapshot_category(app, expected.id) {
            SnapshotAvailability::Available(snapshot) => snapshot,
            SnapshotAvailability::Unavailable(_) => {
                return Err("A committed settings category could not be read back.".to_string())
            }
        };
        let matches = actual.data == expected.data && actual.replacement == expected.replacement;
        zeroize_snapshot(&mut actual);
        if !matches {
            return Err(
                "A committed settings category failed post-write verification.".to_string(),
            );
        }
    }
    Ok(())
}

fn cleanup_transaction_directory(root: &Path, transaction_id: &str) -> Result<(), String> {
    if !valid_transaction_id(transaction_id) {
        return Err("The settings transaction id is invalid.".to_string());
    }
    let transaction_base = root.join(TRANSACTION_DIRECTORY);
    let transaction_root = transaction_base.join(transaction_id);
    if transaction_root.exists() {
        cleanup_private_directory(&transaction_root)?;
    }
    if transaction_base.exists()
        && fs::read_dir(&transaction_base)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
    {
        let _ = fs::remove_dir(&transaction_base);
    }
    Ok(())
}

fn remove_retired_journal(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("A retired settings-transfer journal could not be removed.".to_string()),
    }
}

fn retire_journal(journal_path: &Path) -> Result<Option<PathBuf>, String> {
    let retired_path = journal_path.with_file_name(RETIRED_JOURNAL_FILE);
    match rename_file_atomic(journal_path, &retired_path) {
        Ok(()) => Ok(Some(retired_path)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("The settings-transfer journal could not be retired safely.".to_string()),
    }
}

fn retire_journal_and_cleanup(
    root: &Path,
    journal_path: &Path,
    transaction_id: &str,
) -> Result<(), String> {
    let retired_path = retire_journal(journal_path)?;
    cleanup_transaction_directory(root, transaction_id)?;
    if let Some(retired_path) = retired_path {
        remove_retired_journal(&retired_path)?;
    }
    Ok(())
}

impl<R: Runtime> PreparedTransaction<R> {
    fn abort_before_writes(&self, error: String) -> Result<CommitOutcome, String> {
        match retire_journal_and_cleanup(
            &self.root,
            &self.journal_path,
            &self.journal.transaction_id,
        ) {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(format!(
                "PREPARED_TRANSACTION_CLEANUP_PENDING:{error}:{cleanup_error}"
            )),
        }
    }

    fn rollback_uncommitted(
        &self,
        commit_error: String,
        on_rollback: &mut impl FnMut(),
    ) -> Result<CommitOutcome, String> {
        on_rollback();
        let rollback_result = restore_backup(&self.app, &self.root, &self.backup).and_then(|()| {
            let restored = capture_backup(&self.app, &self.root, &self.journal.categories)?;
            if backup_fingerprint(&restored)? != self.journal.preview_fingerprint {
                return Err("Settings rollback verification failed.".to_string());
            }
            Ok(())
        });
        if let Err(rollback_error) = rollback_result {
            return Err(format!(
                "COMMIT_AND_ROLLBACK_FAILED:{commit_error}:{rollback_error}"
            ));
        }

        if retire_journal_and_cleanup(&self.root, &self.journal_path, &self.journal.transaction_id)
            .is_err()
        {
            return Err(format!("COMMIT_ROLLED_BACK_CLEANUP_PENDING:{commit_error}"));
        }
        Err(commit_error)
    }

    pub(crate) fn commit(mut self, mut on_rollback: impl FnMut()) -> Result<CommitOutcome, String> {
        let pre_commit_check = capture_backup(&self.app, &self.root, &self.journal.categories)
            .and_then(|current| backup_fingerprint(&current))
            .and_then(|fingerprint| {
                if fingerprint == self.journal.preview_fingerprint {
                    Ok(())
                } else {
                    Err("RECEIVER_SETTINGS_CHANGED".to_string())
                }
            });
        if let Err(error) = pre_commit_check {
            return self.abort_before_writes(error);
        }
        self.journal.phase = JournalPhase::Committing;
        if let Err(error) = write_private_json(&self.journal_path, &self.journal) {
            return self.abort_before_writes(error);
        }

        let commit_result = apply_envelope(&self.app, &self.root, &self.envelope)
            .and_then(|()| verify_import(&self.app, &self.envelope));
        if let Err(commit_error) = commit_result {
            return self.rollback_uncommitted(commit_error, &mut on_rollback);
        }

        let post = match capture_backup(&self.app, &self.root, &self.journal.categories) {
            Ok(post) => post,
            Err(error) => return self.rollback_uncommitted(error, &mut on_rollback),
        };
        self.journal.phase = JournalPhase::Committed;
        self.journal.post_commit_fingerprint = match backup_fingerprint(&post) {
            Ok(fingerprint) => Some(fingerprint),
            Err(error) => return self.rollback_uncommitted(error, &mut on_rollback),
        };
        if let Err(error) = write_private_json(&self.journal_path, &self.journal) {
            return self.rollback_uncommitted(error, &mut on_rollback);
        }
        let _ = self.app.emit(
            SETTINGS_IMPORTED_EVENT,
            serde_json::json!({
                "categories": self.journal.categories,
                "updatedAt": chrono::Utc::now().timestamp_millis(),
            }),
        );
        let recovery_cleanup_pending = retire_journal_and_cleanup(
            &self.root,
            &self.journal_path,
            &self.journal.transaction_id,
        )
        .is_err();
        Ok(CommitOutcome {
            recovery_cleanup_pending,
        })
    }
}

fn load_journal(root: &Path, path: &Path) -> Result<TransactionJournal, String> {
    verify_existing_regular_file(path, root)?;
    let metadata = fs::metadata(path)
        .map_err(|_| "The pending settings-transfer journal could not be inspected.".to_string())?;
    if metadata.len() > 64 * 1024 {
        return Err("The pending settings-transfer journal is oversized.".to_string());
    }
    let raw = fs::read(path)
        .map_err(|_| "The pending settings-transfer journal could not be read.".to_string())?;
    let journal = serde_json::from_slice::<TransactionJournal>(&raw)
        .map_err(|_| "The pending settings-transfer journal is invalid.".to_string())?;
    let valid_post_commit = match journal.phase {
        JournalPhase::Prepared | JournalPhase::Committing => {
            journal.post_commit_fingerprint.is_none()
        }
        JournalPhase::Committed => journal
            .post_commit_fingerprint
            .as_deref()
            .is_some_and(is_sha256_hex),
    };
    if journal.version != JOURNAL_VERSION
        || !valid_transaction_id(&journal.transaction_id)
        || journal.categories.is_empty()
        || journal.categories.len() > SettingsCategoryId::ALL.len()
        || !is_sha256_hex(&journal.preview_fingerprint)
        || !is_sha256_hex(&journal.backup_sha256)
        || !valid_post_commit
    {
        return Err(
            "The pending settings-transfer journal uses an unsupported format.".to_string(),
        );
    }
    Ok(journal)
}

fn load_backup(root: &Path, journal: &TransactionJournal) -> Result<ResourceBackup, String> {
    let path = root
        .join(TRANSACTION_DIRECTORY)
        .join(&journal.transaction_id)
        .join(BACKUP_FILE);
    verify_existing_regular_file(&path, root)?;
    let metadata = fs::metadata(&path)
        .map_err(|_| "Pending settings rollback data could not be inspected.".to_string())?;
    if metadata.len() > MAX_RECOVERY_BACKUP_BYTES as u64 {
        return Err("Pending settings rollback data is oversized.".to_string());
    }
    let raw = Zeroizing::new(
        fs::read(&path)
            .map_err(|_| "Pending settings rollback data could not be read.".to_string())?,
    );
    if sha256_hex(&raw) != journal.backup_sha256 {
        return Err("Pending settings rollback data failed its integrity check.".to_string());
    }
    let backup = serde_json::from_slice::<ResourceBackup>(&raw)
        .map_err(|_| "Pending settings rollback data is invalid.".to_string())?;
    if backup.categories != journal.categories {
        return Err("Pending settings rollback metadata does not match its journal.".to_string());
    }
    validate_resource_backup(&backup)?;
    Ok(backup)
}

fn journal_phase_requires_rollback(phase: &JournalPhase) -> bool {
    matches!(phase, JournalPhase::Committing)
}

pub(crate) fn recover_pending_transaction<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let root = get_user_config_directory()?;
    secure_directory(&root)?;
    let journal_path = root.join(JOURNAL_FILE);
    if !journal_path.exists() {
        let transaction_base = root.join(TRANSACTION_DIRECTORY);
        if transaction_base.exists() {
            cleanup_private_directory(&transaction_base)?;
        }
        remove_retired_journal(&root.join(RETIRED_JOURNAL_FILE))?;
        return Ok(());
    }
    let journal = load_journal(&root, &journal_path)?;
    let locks = acquire_transaction_locks(&root, &journal.categories)?;
    if journal_phase_requires_rollback(&journal.phase) {
        let backup = load_backup(&root, &journal)?;
        restore_backup(app, &root, &backup)?;
        let restored = capture_backup(app, &root, &journal.categories)?;
        if backup_fingerprint(&restored)? != journal.preview_fingerprint {
            return Err("Recovered settings did not match their pre-transfer state.".to_string());
        }
    }
    // Prepared means no live write began, while Committed is persisted only
    // after post-write verification. Restoring either phase could overwrite a
    // legitimate edit made after preparation or after the completed import.
    retire_journal_and_cleanup(&root, &journal_path, &journal.transaction_id)?;
    let transaction_base = root.join(TRANSACTION_DIRECTORY);
    if transaction_base.exists() {
        cleanup_private_directory(&transaction_base)?;
    }
    drop(locks);
    Ok(())
}

pub(crate) fn discard_prepared_transaction<R: Runtime>(
    transaction: PreparedTransaction<R>,
) -> Result<(), String> {
    retire_journal_and_cleanup(
        &transaction.root,
        &transaction.journal_path,
        &transaction.journal.transaction_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_test_root(name: &str) -> PathBuf {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock should follow the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "machdoch-settings-transfer-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[test]
    fn transaction_ids_cannot_escape_the_private_staging_root() {
        for invalid in [
            "../escape",
            "short",
            "with/slash",
            "with\\slash",
            "with space................",
        ] {
            assert!(!valid_transaction_id(invalid));
        }
        assert!(valid_transaction_id("dGhpc19pcy1hLXRyYW5zZmVyLWlk"));
    }

    #[test]
    fn recovery_rolls_back_only_after_live_writes_could_have_started() {
        assert!(!journal_phase_requires_rollback(&JournalPhase::Prepared));
        assert!(journal_phase_requires_rollback(&JournalPhase::Committing));
        assert!(!journal_phase_requires_rollback(&JournalPhase::Committed));
    }

    #[test]
    fn recovery_retires_the_journal_before_deleting_its_backup() {
        let root = temporary_test_root("recovery-cleanup-order");
        let transaction_id = "abcdefghijklmnopqrstuvwxyzABCDEF";
        let transaction_base = root.join(TRANSACTION_DIRECTORY);
        let transaction_path = transaction_base.join(transaction_id);
        let journal_path = root.join(JOURNAL_FILE);
        fs::create_dir_all(&transaction_base).expect("transaction base should be created");
        fs::write(&transaction_path, b"not a directory")
            .expect("an invalid transaction entry should be created");
        fs::write(&journal_path, b"journal").expect("journal should be created");

        retire_journal_and_cleanup(&root, &journal_path, transaction_id)
            .expect_err("invalid transaction cleanup should fail");
        assert!(
            !journal_path.exists(),
            "a verified recovery must not retain a journal after its backup cleanup starts"
        );
        assert!(
            root.join(RETIRED_JOURNAL_FILE).exists(),
            "the durable retirement marker should remain until backup cleanup succeeds"
        );
        assert!(
            transaction_path.exists(),
            "failed backup cleanup must remain retryable through orphan cleanup"
        );

        fs::remove_dir_all(&root).expect("test root should be removable");
    }

    #[test]
    fn incoming_payload_stage_closes_and_removes_plaintext_before_returning() {
        let config_root = temporary_test_root("payload-cleanup");
        let envelope = TransferEnvelope {
            protocol_version: super::super::contract::PROTOCOL_MAJOR,
            transfer_id: "abcdefghijklmnopqrstuvwxyzABCDEFGH".to_string(),
            created_at: 1,
            expires_at: 2,
            categories: Vec::new(),
        };
        let bytes = serde_json::to_vec(&envelope).expect("envelope should serialize");
        let digest = sha256_hex(&bytes);
        let mut stage = IncomingPayloadStage::create_in_config_root(
            &config_root,
            &envelope.transfer_id,
            bytes.len() as u64,
        )
        .expect("stage should be created");
        let stage_root = stage.root.clone();
        stage.append(0, &bytes).expect("payload should append");

        assert_eq!(
            stage.finish(&digest).expect("payload should finish"),
            envelope
        );
        assert!(
            !stage_root.exists(),
            "plaintext staging must be removed after finish"
        );

        let dropped = IncomingPayloadStage::create_in_config_root(
            &config_root,
            "0123456789abcdefghijklmnopqrstuv",
            1,
        )
        .expect("second stage should be created");
        let dropped_root = dropped.root.clone();
        drop(dropped);
        assert!(
            !dropped_root.exists(),
            "plaintext staging must be removed when a transfer is abandoned"
        );
        fs::remove_dir_all(&config_root).expect("test staging root should be removable");
    }

    #[test]
    fn recovery_ralph_paths_match_only_the_managed_layout() {
        for valid in [
            "ralph/flows/global-flow.json",
            "ralph/instructions/global-flow/instructions.md",
            "ralph/instructions/global-flow/instructions/review/security.instructions.md",
        ] {
            validate_backup_file_path(SettingsCategoryId::GlobalRalphFlows, valid)
                .unwrap_or_else(|error| panic!("{valid} should be valid: {error}"));
        }
        for invalid in [
            "ralph/flows/nested/global-flow.json",
            "ralph/instructions/global-flow/extra/instructions.md",
            "ralph/instructions/global-flow/review.instructions.md",
            "ralph/instructions/global-flow/instructions/.instructions.md",
        ] {
            assert!(
                validate_backup_file_path(SettingsCategoryId::GlobalRalphFlows, invalid).is_err(),
                "{invalid} should not be a managed rollback path"
            );
        }
    }

    #[test]
    fn backup_fingerprint_is_deterministic_and_scope_closed() {
        let backup = ResourceBackup {
            categories: BTreeSet::from([SettingsCategoryId::ApiKeys]),
            user_config: Some(Some(BASE64.encode(b"{}\n"))),
            mcp_config: None,
            store_values: BTreeMap::new(),
            files: BTreeMap::new(),
        };
        assert_eq!(
            backup_fingerprint(&backup).expect("first fingerprint"),
            backup_fingerprint(&backup).expect("second fingerprint")
        );
        let serialized = serde_json::to_string(&backup).expect("backup should serialize");
        assert!(!serialized.contains("workspaceRoot"));
        validate_resource_backup(&backup).expect("generated backup shape should be valid");
    }

    #[test]
    fn rollback_capture_enforces_one_cumulative_raw_byte_budget() {
        let mut remaining = 10_u64;
        consume_backup_budget(&mut remaining, 7).expect("the first resource should fit");
        assert_eq!(remaining, 3);
        assert!(consume_backup_budget(&mut remaining, 4)
            .expect_err("the combined resources must not exceed the budget")
            .contains("bounded rollback capacity"));
        assert_eq!(remaining, 3, "a rejected resource must not consume budget");
    }

    #[test]
    fn recovery_backup_cannot_target_unselected_files_or_store_keys() {
        let mut backup = ResourceBackup {
            categories: BTreeSet::from([SettingsCategoryId::GlobalInstructions]),
            user_config: None,
            mcp_config: None,
            store_values: BTreeMap::new(),
            files: BTreeMap::from([(
                SettingsCategoryId::GlobalInstructions,
                vec![FileBackupEntry {
                    relative_path: "user-config.json".to_string(),
                    base64_content: BASE64.encode(b"{}\n"),
                }],
            )]),
        };
        assert!(validate_resource_backup(&backup)
            .expect_err("an instruction backup cannot target user config")
            .contains("out-of-scope path"));

        backup.files.insert(
            SettingsCategoryId::GlobalInstructions,
            vec![FileBackupEntry {
                relative_path: "instructions.md".to_string(),
                base64_content: BASE64.encode(b"# safe\n"),
            }],
        );
        backup
            .store_values
            .insert("machdoch.desktop.shell-state".to_string(), None);
        assert!(validate_resource_backup(&backup)
            .expect_err("an instruction backup cannot target an arbitrary store key")
            .contains("out-of-scope store key"));
    }

    #[test]
    fn recovery_backup_rejects_a_file_used_as_an_ancestor_directory() {
        let backup = ResourceBackup {
            categories: BTreeSet::from([SettingsCategoryId::GlobalInstructions]),
            user_config: None,
            mcp_config: None,
            store_values: BTreeMap::new(),
            files: BTreeMap::from([(
                SettingsCategoryId::GlobalInstructions,
                vec![
                    FileBackupEntry {
                        relative_path: "instructions/review.instructions.md".to_string(),
                        base64_content: BASE64.encode(b"# Review\n"),
                    },
                    FileBackupEntry {
                        relative_path:
                            "instructions/review.instructions.md/security.instructions.md"
                                .to_string(),
                        base64_content: BASE64.encode(b"# Security\n"),
                    },
                ],
            )]),
        };

        assert!(validate_resource_backup(&backup)
            .expect_err("a backup file cannot also be an ancestor directory")
            .contains("nested below another file"));
    }

    #[test]
    fn global_memory_replacement_preserves_receiver_only_scopes() {
        let mut root = serde_json::json!({
            "memory": {
                "globalEnabled": false,
                "entries": [
                    { "id": "old-global", "scope": "global", "content": "old", "createdAt": 1, "updatedAt": 1 },
                    { "id": "session-only", "scope": "session", "content": "keep", "createdAt": 2, "updatedAt": 2 }
                ],
                "futureMemorySetting": true
            }
        });
        let snapshot = CategorySnapshot {
            id: SettingsCategoryId::GlobalMemory,
            schema_version: super::super::contract::CATEGORY_SCHEMA_VERSION,
            replacement: "value".to_string(),
            item_count: 1,
            plaintext_bytes: 0,
            sha256: String::new(),
            data: super::super::contract::CategorySnapshotData::Json(serde_json::json!({
                "globalEnabled": true,
                "entries": [
                    { "id": "new-global", "scope": "global", "content": "new", "createdAt": 3, "updatedAt": 3 }
                ]
            })),
        };
        let root_object = root.as_object_mut().expect("test root should be an object");

        apply_memory(root_object, &snapshot).expect("global memory should apply");

        assert_eq!(root["memory"]["globalEnabled"], true);
        assert_eq!(root["memory"]["futureMemorySetting"], true);
        assert_eq!(root["memory"]["entries"].as_array().map(Vec::len), Some(2));
        assert_eq!(root["memory"]["entries"][0]["id"], "session-only");
        assert_eq!(root["memory"]["entries"][1]["id"], "new-global");
    }
}
