use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read as _,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{AeadInOut as _, KeyInit as _},
    ChaCha20Poly1305, Nonce,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tauri::{AppHandle, Runtime};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize as _, Zeroizing};

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};

use super::{
    categories::{
        create_category_statuses, validate_envelope_categories, zeroize_snapshot, MAX_TOTAL_ITEMS,
    },
    contract::{
        CancelEncryptedSettingsFileImportRequest, CategoryAvailabilityState, CategoryEffect,
        CategorySnapshot, CommitEncryptedSettingsFileImportRequest,
        EncryptedSettingsFileExportResult, EncryptedSettingsFileImportResult,
        EncryptedSettingsFileImportReview, ExportEncryptedSettingsFileRequest,
        InspectEncryptedSettingsFileRequest, SettingsCategoryId, TransferEnvelope, PROTOCOL_MAJOR,
    },
    protocol::constant_time_eq,
    service::{
        emit_import_reload_events, prepare_validated_transaction, validate_transfer_envelope,
        SensitiveTransferEnvelope, TransferSnapshotSet,
    },
    session::SettingsTransferState,
    transaction::{capture_preview_fingerprint, MAX_WIRE_PAYLOAD_BYTES},
};

const FILE_MAGIC: &[u8] = b"MACHDOCH-SETTINGS\n";
const CONTAINER_VERSION: u16 = 1;
const PAYLOAD_SCHEMA_VERSION: u16 = 1;
const HEADER_MAX_BYTES: usize = 4 * 1024;
const AEAD_TAG_BYTES: u64 = 16;
const CONTAINER_OVERHEAD_BYTES: u64 = HEADER_MAX_BYTES as u64 + 128;
const MAX_CONTAINER_BYTES: u64 = MAX_WIRE_PAYLOAD_BYTES + CONTAINER_OVERHEAD_BYTES;
const PASSPHRASE_MIN_CHARACTERS: usize = 12;
const PASSPHRASE_MAX_BYTES: usize = 1_024;
const ARGON2_MEMORY_KIB: u32 = 65_536;
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 1;
const ARGON2_VERSION: u32 = 0x13;
const KDF_SALT_BYTES: usize = 16;
const KEY_BYTES: usize = 32;
const AEAD_NONCE_BYTES: usize = 12;
const FILE_IMPORT_REVIEW_MILLIS: u64 = 10 * 60 * 1_000;
// The payload creation time is informational, not an expiry or replay
// boundary. Keep it portable across machines with unsynchronized clocks while
// bounding it to the range accepted exactly by JavaScript Date.
const MAX_PORTABLE_TIMESTAMP_MILLIS: u64 = 8_640_000_000_000_000;
const SETTINGS_FILE_EXTENSION: &str = "machdoch-settings";
const FILE_VERIFICATION_BUFFER_BYTES: usize = 64 * 1024;
const OPERATION_IDLE: u8 = 0;
const OPERATION_FILE: u8 = 1;
const OPERATION_NETWORK: u8 = 2;
const MAX_CANCELLED_INSPECTION_IDS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KdfHeader {
    algorithm: String,
    version: u32,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
    salt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CipherHeader {
    algorithm: String,
    nonce: String,
    tag_bytes: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PayloadHeader {
    media_type: String,
    schema_version: u16,
    plaintext_bytes: u64,
    ciphertext_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContainerHeader {
    kdf: KdfHeader,
    cipher: CipherHeader,
    payload: PayloadHeader,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PortableSettingsPayload {
    schema_version: u16,
    export_id: String,
    created_at: u64,
    categories: Vec<CategorySnapshot>,
}

struct SensitivePortablePayload(PortableSettingsPayload);

impl Drop for SensitivePortablePayload {
    fn drop(&mut self) {
        self.0.export_id.zeroize();
        for category in &mut self.0.categories {
            zeroize_snapshot(category);
        }
        self.0.categories.clear();
    }
}

struct SensitivePassphrase(String);

impl SensitivePassphrase {
    fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

impl Drop for SensitivePassphrase {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct SensitiveReviewToken(String);

impl SensitiveReviewToken {
    fn as_str(&self) -> &str {
        &self.0
    }
}

impl Drop for SensitiveReviewToken {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

struct ParsedContainer<'a> {
    header: ContainerHeader,
    aad: &'a [u8],
    ciphertext: &'a [u8],
    salt: [u8; KDF_SALT_BYTES],
    nonce: [u8; AEAD_NONCE_BYTES],
}

struct PendingFileImport {
    operation_id: String,
    token: Zeroizing<String>,
    expires_at: u64,
    fingerprint: String,
    categories: BTreeSet<SettingsCategoryId>,
    envelope: SensitiveTransferEnvelope,
    expiry_cancel: CancellationToken,
    _operation: TransferOperationGuard,
}

#[derive(Default)]
struct FileTransferInner {
    generation: u64,
    active_inspection: Option<(String, u64)>,
    cancelled_inspections: BTreeMap<String, u64>,
    pending: Option<PendingFileImport>,
}

#[derive(Clone, Default)]
pub(crate) struct SettingsFileTransferState {
    inner: Arc<Mutex<FileTransferInner>>,
    operation_kind: Arc<AtomicU8>,
    commit_critical: Arc<AtomicBool>,
}

pub(crate) struct TransferOperationGuard {
    operation_kind: Arc<AtomicU8>,
    expected_kind: u8,
}

struct ActiveInspectionGuard {
    state: SettingsFileTransferState,
    generation: u64,
}

impl Drop for ActiveInspectionGuard {
    fn drop(&mut self) {
        self.state.finish_inspection(self.generation);
    }
}

struct FileCommitCriticalGuard {
    commit_critical: Arc<AtomicBool>,
}

impl Drop for FileCommitCriticalGuard {
    fn drop(&mut self) {
        self.commit_critical.store(false, Ordering::Release);
    }
}

impl Drop for TransferOperationGuard {
    fn drop(&mut self) {
        let _ = self.operation_kind.compare_exchange(
            self.expected_kind,
            OPERATION_IDLE,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}

impl SettingsFileTransferState {
    fn lock(&self) -> std::sync::MutexGuard<'_, FileTransferInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin_operation(&self, requested_kind: u8) -> Result<TransferOperationGuard, String> {
        self.clear_expired_pending();
        self.operation_kind
            .compare_exchange(
                OPERATION_IDLE,
                requested_kind,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|active_kind| match active_kind {
                OPERATION_NETWORK => {
                    "Finish or cancel the local-network settings transfer first.".to_string()
                }
                _ => "Finish or cancel the encrypted settings file operation first.".to_string(),
            })?;
        Ok(TransferOperationGuard {
            operation_kind: self.operation_kind.clone(),
            expected_kind: requested_kind,
        })
    }

    fn clear_expired_pending(&self) {
        let expired = {
            let mut inner = self.lock();
            if inner
                .pending
                .as_ref()
                .is_some_and(|pending| pending.expires_at <= now_millis())
            {
                inner.pending.take()
            } else {
                None
            }
        };
        if let Some(pending) = &expired {
            pending.expiry_cancel.cancel();
        }
        // Dropping the pending review also releases its operation guard.
        // Do that after unlocking the review state so the coordination
        // mechanism stays safe if its implementation changes later.
        drop(expired);
    }

    fn begin_file_operation(&self) -> Result<TransferOperationGuard, String> {
        self.begin_operation(OPERATION_FILE)
    }

    pub(crate) fn begin_network_operation(&self) -> Result<TransferOperationGuard, String> {
        self.begin_operation(OPERATION_NETWORK)
    }

    fn prune_cancelled_inspections(inner: &mut FileTransferInner, now: u64) {
        inner
            .cancelled_inspections
            .retain(|_, expires_at| *expires_at > now);
    }

    fn remember_cancelled_inspection(inner: &mut FileTransferInner, operation_id: &str, now: u64) {
        Self::prune_cancelled_inspections(inner, now);
        if !inner.cancelled_inspections.contains_key(operation_id)
            && inner.cancelled_inspections.len() >= MAX_CANCELLED_INSPECTION_IDS
        {
            if let Some(oldest) = inner
                .cancelled_inspections
                .iter()
                .min_by_key(|(_, expires_at)| *expires_at)
                .map(|(id, _)| id.clone())
            {
                inner.cancelled_inspections.remove(&oldest);
            }
        }
        inner.cancelled_inspections.insert(
            operation_id.to_string(),
            now.saturating_add(FILE_IMPORT_REVIEW_MILLIS),
        );
    }

    fn begin_inspection(
        &self,
        operation_id: String,
    ) -> Result<(TransferOperationGuard, ActiveInspectionGuard, u64), String> {
        if !valid_export_id(&operation_id) {
            return Err("The encrypted settings inspection id is invalid.".to_string());
        }
        let operation = self.begin_file_operation()?;
        let generation = {
            let mut inner = self.lock();
            Self::prune_cancelled_inspections(&mut inner, now_millis());
            if inner.cancelled_inspections.contains_key(&operation_id) {
                return Err("Encrypted settings file inspection was cancelled.".to_string());
            }
            inner.generation = inner.generation.wrapping_add(1).max(1);
            debug_assert!(inner.pending.is_none());
            debug_assert!(inner.active_inspection.is_none());
            let generation = inner.generation;
            inner.active_inspection = Some((operation_id, generation));
            generation
        };
        Ok((
            operation,
            ActiveInspectionGuard {
                state: self.clone(),
                generation,
            },
            generation,
        ))
    }

    fn finish_inspection(&self, generation: u64) {
        let mut inner = self.lock();
        if inner
            .active_inspection
            .as_ref()
            .is_some_and(|(_, active_generation)| *active_generation == generation)
        {
            inner.active_inspection = None;
        }
    }

    fn ensure_inspection_current(&self, generation: u64) -> Result<(), String> {
        let inner = self.lock();
        if inner.generation == generation
            && inner
                .active_inspection
                .as_ref()
                .is_some_and(|(_, active_generation)| *active_generation == generation)
        {
            Ok(())
        } else {
            Err("Encrypted settings file inspection was cancelled.".to_string())
        }
    }

    fn store_pending(&self, generation: u64, pending: PendingFileImport) -> Result<(), String> {
        let mut inner = self.lock();
        if inner.generation != generation
            || !inner
                .active_inspection
                .as_ref()
                .is_some_and(|(operation_id, active_generation)| {
                    *active_generation == generation && operation_id == &pending.operation_id
                })
        {
            return Err("Encrypted settings file inspection was cancelled.".to_string());
        }
        if inner.pending.is_some() {
            return Err("An encrypted settings file review is already pending.".to_string());
        }
        inner.active_inspection = None;
        inner.pending = Some(pending);
        Ok(())
    }

    fn take_pending(&self, token: &str) -> Result<PendingFileImport, String> {
        if !valid_export_id(token) {
            return Err("The encrypted settings file review token is invalid.".to_string());
        }
        let mut inner = self.lock();
        let Some(pending) = inner.pending.as_ref() else {
            return Err("The encrypted settings file review is no longer available.".to_string());
        };
        if pending.expires_at <= now_millis() {
            let expired = inner.pending.take();
            drop(inner);
            if let Some(pending) = &expired {
                pending.expiry_cancel.cancel();
            }
            drop(expired);
            return Err(
                "The encrypted settings file review expired. Inspect the file again.".to_string(),
            );
        }
        if !constant_time_eq(pending.token.as_bytes(), token.as_bytes()) {
            return Err("The encrypted settings file review token is invalid.".to_string());
        }
        let pending = inner.pending.take().ok_or_else(|| {
            "The encrypted settings file review is no longer available.".to_string()
        })?;
        drop(inner);
        pending.expiry_cancel.cancel();
        Ok(pending)
    }

    fn expire_pending_generation(&self, generation: u64) -> bool {
        let expired = {
            let mut inner = self.lock();
            if inner.generation == generation {
                inner.pending.take()
            } else {
                None
            }
        };
        let removed = expired.is_some();
        drop(expired);
        removed
    }

    fn cancel_inspection(&self, operation_id: &str) -> Result<bool, String> {
        if !valid_export_id(operation_id) {
            return Err("The encrypted settings inspection id is invalid.".to_string());
        }
        let (pending, cancelled_active) = {
            let mut inner = self.lock();
            let now = now_millis();
            let cancelled_active = inner
                .active_inspection
                .as_ref()
                .is_some_and(|(active_id, _)| active_id == operation_id);
            let cancelled_pending = inner
                .pending
                .as_ref()
                .is_some_and(|pending| pending.operation_id == operation_id);
            if cancelled_active || cancelled_pending {
                inner.generation = inner.generation.wrapping_add(1).max(1);
            }
            if cancelled_active {
                inner.active_inspection = None;
            }
            let pending = if cancelled_pending {
                inner.pending.take()
            } else {
                None
            };
            Self::remember_cancelled_inspection(&mut inner, operation_id, now);
            (pending, cancelled_active)
        };
        if let Some(pending) = &pending {
            pending.expiry_cancel.cancel();
        }
        let cancelled = cancelled_active || pending.is_some();
        drop(pending);
        Ok(cancelled)
    }

    fn cancel_all_noncritical(&self) {
        if self.commit_critical.load(Ordering::Acquire) {
            return;
        }
        let pending = {
            let mut inner = self.lock();
            if inner.active_inspection.is_some() || inner.pending.is_some() {
                inner.generation = inner.generation.wrapping_add(1).max(1);
            }
            inner.active_inspection = None;
            inner.pending.take()
        };
        if let Some(pending) = &pending {
            pending.expiry_cancel.cancel();
        }
        drop(pending);
    }

    pub(crate) fn request_stop(&self) -> bool {
        self.cancel_all_noncritical();
        self.activity().0
    }

    pub(crate) fn activity(&self) -> (bool, bool) {
        let active = self.operation_kind.load(Ordering::Acquire) != OPERATION_IDLE;
        (
            active,
            active && self.commit_critical.load(Ordering::Acquire),
        )
    }

    fn begin_file_commit_critical(&self) -> Result<FileCommitCriticalGuard, String> {
        if self.operation_kind.load(Ordering::Acquire) != OPERATION_FILE {
            return Err("The encrypted settings import is no longer active.".to_string());
        }
        self.commit_critical
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "The encrypted settings import is already committing.".to_string())?;
        Ok(FileCommitCriticalGuard {
            commit_critical: self.commit_critical.clone(),
        })
    }
}

fn schedule_pending_expiry(
    state: SettingsFileTransferState,
    generation: u64,
    delay: Duration,
    cancel: CancellationToken,
) {
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {
                state.expire_pending_generation(generation);
            }
            _ = cancel.cancelled() => {}
        }
    });
}

fn now_millis() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or(0)
}

#[cfg(test)]
fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn random_array<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes)
        .map_err(|_| "Secure random generation is unavailable.".to_string())?;
    Ok(bytes)
}

fn random_id() -> Result<String, String> {
    Ok(URL_SAFE_NO_PAD.encode(random_array::<24>()?))
}

fn validate_passphrase(passphrase: &SensitivePassphrase, exporting: bool) -> Result<(), String> {
    let byte_length = passphrase.as_bytes().len();
    if byte_length == 0 || byte_length > PASSPHRASE_MAX_BYTES {
        return Err(format!(
            "The passphrase must be between 1 and {PASSPHRASE_MAX_BYTES} UTF-8 bytes."
        ));
    }
    if exporting && passphrase.0.chars().count() < PASSPHRASE_MIN_CHARACTERS {
        return Err(format!(
            "Use a passphrase with at least {PASSPHRASE_MIN_CHARACTERS} characters."
        ));
    }
    Ok(())
}

fn derive_key(
    passphrase: &SensitivePassphrase,
    salt: &[u8; KDF_SALT_BYTES],
) -> Result<Zeroizing<[u8; KEY_BYTES]>, String> {
    let params = Params::new(
        ARGON2_MEMORY_KIB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(KEY_BYTES),
    )
    .map_err(|_| "The encrypted settings key profile is unavailable.".to_string())?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0_u8; KEY_BYTES]);
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, key.as_mut())
        .map_err(|_| "The encrypted settings key could not be derived.".to_string())?;
    Ok(key)
}

fn encode_fixed<const N: usize>(bytes: &[u8; N]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_fixed<const N: usize>(value: &str) -> Result<[u8; N], String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "The encrypted settings header is malformed.".to_string())?;
    let decoded: [u8; N] = decoded
        .try_into()
        .map_err(|_| "The encrypted settings header has an invalid field length.".to_string())?;
    if encode_fixed(&decoded) != value {
        return Err("The encrypted settings header is not canonical.".to_string());
    }
    Ok(decoded)
}

fn header_for(
    plaintext_bytes: u64,
    salt: &[u8; KDF_SALT_BYTES],
    nonce: &[u8; AEAD_NONCE_BYTES],
) -> ContainerHeader {
    ContainerHeader {
        kdf: KdfHeader {
            algorithm: "argon2id".to_string(),
            version: ARGON2_VERSION,
            memory_kib: ARGON2_MEMORY_KIB,
            iterations: ARGON2_ITERATIONS,
            parallelism: ARGON2_PARALLELISM,
            salt: encode_fixed(salt),
        },
        cipher: CipherHeader {
            algorithm: "chacha20-poly1305".to_string(),
            nonce: encode_fixed(nonce),
            tag_bytes: AEAD_TAG_BYTES as u8,
        },
        payload: PayloadHeader {
            media_type: "application/vnd.machdoch.settings-transfer+json".to_string(),
            schema_version: PAYLOAD_SCHEMA_VERSION,
            plaintext_bytes,
            ciphertext_bytes: plaintext_bytes.saturating_add(AEAD_TAG_BYTES),
        },
    }
}

fn validate_header(
    header: &ContainerHeader,
) -> Result<([u8; KDF_SALT_BYTES], [u8; AEAD_NONCE_BYTES]), String> {
    if header.kdf.algorithm != "argon2id"
        || header.kdf.version != ARGON2_VERSION
        || header.kdf.memory_kib != ARGON2_MEMORY_KIB
        || header.kdf.iterations != ARGON2_ITERATIONS
        || header.kdf.parallelism != ARGON2_PARALLELISM
        || header.cipher.algorithm != "chacha20-poly1305"
        || u64::from(header.cipher.tag_bytes) != AEAD_TAG_BYTES
        || header.payload.media_type != "application/vnd.machdoch.settings-transfer+json"
        || header.payload.schema_version != PAYLOAD_SCHEMA_VERSION
        || header.payload.plaintext_bytes == 0
        || header.payload.plaintext_bytes > MAX_WIRE_PAYLOAD_BYTES
        || header.payload.ciphertext_bytes
            != header
                .payload
                .plaintext_bytes
                .checked_add(AEAD_TAG_BYTES)
                .ok_or_else(|| "The encrypted settings size is invalid.".to_string())?
    {
        return Err(
            "The encrypted settings file uses an unsupported version 1 profile.".to_string(),
        );
    }
    Ok((
        decode_fixed(&header.kdf.salt)?,
        decode_fixed(&header.cipher.nonce)?,
    ))
}

fn prefix_with_header(header: &ContainerHeader) -> Result<Vec<u8>, String> {
    let header_bytes = serde_json::to_vec(header)
        .map_err(|_| "The encrypted settings header could not be serialized.".to_string())?;
    if header_bytes.is_empty() || header_bytes.len() > HEADER_MAX_BYTES {
        return Err("The encrypted settings header is oversized.".to_string());
    }
    let header_length = u32::try_from(header_bytes.len())
        .map_err(|_| "The encrypted settings header is oversized.".to_string())?;
    let mut prefix = Vec::with_capacity(FILE_MAGIC.len() + 6 + header_bytes.len());
    prefix.extend_from_slice(FILE_MAGIC);
    prefix.extend_from_slice(&CONTAINER_VERSION.to_be_bytes());
    prefix.extend_from_slice(&header_length.to_be_bytes());
    prefix.extend_from_slice(&header_bytes);
    Ok(prefix)
}

fn encrypt_container(
    plaintext: &[u8],
    passphrase: &SensitivePassphrase,
) -> Result<Vec<u8>, String> {
    if plaintext.is_empty() || plaintext.len() as u64 > MAX_WIRE_PAYLOAD_BYTES {
        return Err("The settings payload exceeds the encrypted file size limit.".to_string());
    }
    validate_passphrase(passphrase, true)?;
    let salt = random_array::<KDF_SALT_BYTES>()?;
    let nonce = random_array::<AEAD_NONCE_BYTES>()?;
    encrypt_container_with_material(plaintext, passphrase, &salt, &nonce)
}

fn encrypt_container_with_material(
    plaintext: &[u8],
    passphrase: &SensitivePassphrase,
    salt: &[u8; KDF_SALT_BYTES],
    nonce: &[u8; AEAD_NONCE_BYTES],
) -> Result<Vec<u8>, String> {
    if plaintext.is_empty() || plaintext.len() as u64 > MAX_WIRE_PAYLOAD_BYTES {
        return Err("The settings payload exceeds the encrypted file size limit.".to_string());
    }
    validate_passphrase(passphrase, true)?;
    let header = header_for(plaintext.len() as u64, salt, nonce);
    let mut container = prefix_with_header(&header)?;
    let key = derive_key(passphrase, salt)?;
    let cipher = ChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| "The encrypted settings cipher could not be initialized.".to_string())?;
    let encryption_capacity = plaintext
        .len()
        .checked_add(AEAD_TAG_BYTES as usize)
        .ok_or_else(|| "The encrypted settings output size is invalid.".to_string())?;
    let mut ciphertext = Zeroizing::new(Vec::new());
    ciphertext
        .try_reserve_exact(encryption_capacity)
        .map_err(|_| "The settings payload could not be buffered for encryption.".to_string())?;
    ciphertext.extend_from_slice(plaintext);
    let nonce = Nonce::from(*nonce);
    cipher
        .encrypt_in_place(&nonce, &container, &mut *ciphertext)
        .map_err(|_| "The settings payload could not be encrypted.".to_string())?;
    if ciphertext.len() as u64 != header.payload.ciphertext_bytes {
        return Err("The encrypted settings output size is invalid.".to_string());
    }
    container
        .try_reserve_exact(ciphertext.len())
        .map_err(|_| "The encrypted settings output could not be buffered.".to_string())?;
    container.extend_from_slice(&ciphertext);
    Ok(container)
}

fn parse_container(raw: &[u8]) -> Result<ParsedContainer<'_>, String> {
    let fixed_prefix = FILE_MAGIC.len() + 2 + 4;
    if raw.len() < fixed_prefix + AEAD_TAG_BYTES as usize || !raw.starts_with(FILE_MAGIC) {
        return Err("The selected file is not a Machdoch encrypted settings file.".to_string());
    }
    let version_offset = FILE_MAGIC.len();
    let version = u16::from_be_bytes([raw[version_offset], raw[version_offset + 1]]);
    if version != CONTAINER_VERSION {
        return Err(format!(
            "Encrypted settings file version {version} is not supported."
        ));
    }
    let length_offset = version_offset + 2;
    let header_length = u32::from_be_bytes([
        raw[length_offset],
        raw[length_offset + 1],
        raw[length_offset + 2],
        raw[length_offset + 3],
    ]) as usize;
    if header_length == 0 || header_length > HEADER_MAX_BYTES {
        return Err("The encrypted settings header length is invalid.".to_string());
    }
    let ciphertext_offset = fixed_prefix
        .checked_add(header_length)
        .filter(|offset| *offset <= raw.len())
        .ok_or_else(|| "The encrypted settings file is truncated.".to_string())?;
    let header = serde_json::from_slice::<ContainerHeader>(&raw[fixed_prefix..ciphertext_offset])
        .map_err(|_| "The encrypted settings header is malformed.".to_string())?;
    let (salt, nonce) = validate_header(&header)?;
    if raw.len() as u64
        != (ciphertext_offset as u64)
            .checked_add(header.payload.ciphertext_bytes)
            .ok_or_else(|| "The encrypted settings size is invalid.".to_string())?
    {
        return Err("The encrypted settings file length does not match its header.".to_string());
    }
    Ok(ParsedContainer {
        header,
        aad: &raw[..ciphertext_offset],
        ciphertext: &raw[ciphertext_offset..],
        salt,
        nonce,
    })
}

fn decrypt_container(
    raw: &[u8],
    passphrase: &SensitivePassphrase,
) -> Result<Zeroizing<Vec<u8>>, String> {
    validate_passphrase(passphrase, false)?;
    let parsed = parse_container(raw)?;
    let key = derive_key(passphrase, &parsed.salt)?;
    let cipher = ChaCha20Poly1305::new_from_slice(key.as_ref())
        .map_err(|_| "The encrypted settings cipher could not be initialized.".to_string())?;
    // The in-place buffer is zeroizing because AEAD implementations may
    // modify it before reporting a failed tag. This keeps wrong-passphrase
    // and tampered-file exits on the same sensitive-buffer drop path.
    let mut plaintext = Zeroizing::new(Vec::new());
    plaintext
        .try_reserve_exact(parsed.ciphertext.len())
        .map_err(|_| "The encrypted settings payload could not be buffered safely.".to_string())?;
    plaintext.extend_from_slice(parsed.ciphertext);
    let nonce = Nonce::from(parsed.nonce);
    cipher
        .decrypt_in_place(&nonce, parsed.aad, &mut *plaintext)
        .map_err(|_| {
            "The passphrase is incorrect or the encrypted settings file was modified.".to_string()
        })?;
    if plaintext.len() as u64 != parsed.header.payload.plaintext_bytes {
        return Err("The decrypted settings payload size is invalid.".to_string());
    }
    Ok(plaintext)
}

fn valid_export_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_portable_payload(payload: &PortableSettingsPayload) -> Result<(), String> {
    if payload.schema_version != PAYLOAD_SCHEMA_VERSION
        || !valid_export_id(&payload.export_id)
        || payload.created_at == 0
        || payload.created_at > MAX_PORTABLE_TIMESTAMP_MILLIS
        || payload.categories.is_empty()
    {
        return Err("The decrypted settings payload has invalid metadata.".to_string());
    }
    validate_envelope_categories(&payload.categories)
}

#[cfg(test)]
fn decode_portable_payload(
    container: &[u8],
    passphrase: &SensitivePassphrase,
) -> Result<SensitivePortablePayload, String> {
    let plaintext = decrypt_container(container, passphrase)?;
    decode_decrypted_portable_payload(&plaintext)
}

fn decode_decrypted_portable_payload(plaintext: &[u8]) -> Result<SensitivePortablePayload, String> {
    let payload = serde_json::from_slice::<PortableSettingsPayload>(plaintext)
        .map_err(|_| "The decrypted settings payload is malformed.".to_string())?;
    let payload = SensitivePortablePayload(payload);
    validate_portable_payload(&payload.0)?;
    Ok(payload)
}

fn encode_portable_payload(
    payload: SensitivePortablePayload,
    passphrase: SensitivePassphrase,
) -> Result<Vec<u8>, String> {
    validate_portable_payload(&payload.0)?;
    let plaintext = Zeroizing::new(
        serde_json::to_vec(&payload.0)
            .map_err(|_| "The selected settings could not be serialized.".to_string())?,
    );
    // Both the object graph and its serialized representation, along with the
    // passphrase, are owned by this scope. They are scrubbed before the caller
    // starts filesystem I/O and retains only authenticated ciphertext.
    encrypt_container(&plaintext, &passphrase)
}

fn with_validated_portable_payload<T>(
    container: Vec<u8>,
    passphrase: SensitivePassphrase,
    checkpoint: impl Fn() -> Result<(), String>,
    continuation: impl FnOnce(SensitivePortablePayload) -> Result<T, String>,
) -> Result<T, String> {
    let plaintext = decrypt_container(&container, &passphrase)?;
    // Do not retain either the IPC passphrase or the full encrypted input
    // while parsing, validating, or previewing the authenticated payload.
    drop(passphrase);
    drop(container);
    checkpoint()?;
    let payload = decode_decrypted_portable_payload(&plaintext)?;
    drop(plaintext);
    checkpoint()?;
    continuation(payload)
}

fn validate_path_text(value: &str) -> Result<&Path, String> {
    if value.is_empty() || value.len() > 32_768 || value.contains('\0') {
        return Err("The encrypted settings file path is invalid.".to_string());
    }
    let path = Path::new(value);
    if !path.is_absolute()
        || path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case(SETTINGS_FILE_EXTENSION))
    {
        return Err(format!(
            "Select an absolute .{SETTINGS_FILE_EXTENSION} file path."
        ));
    }
    Ok(path)
}

fn validated_destination(value: &str) -> Result<PathBuf, String> {
    let requested = validate_path_text(value)?;
    let file_name = requested
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "The encrypted settings destination requires a file name.".to_string())?;
    let parent = requested
        .parent()
        .ok_or_else(|| "The encrypted settings destination has no parent directory.".to_string())?;
    let parent_metadata = fs::metadata(parent)
        .map_err(|_| "The encrypted settings destination directory is unavailable.".to_string())?;
    if !parent_metadata.is_dir() {
        return Err("The encrypted settings destination parent is not a directory.".to_string());
    }
    let canonical_parent = parent.canonicalize().map_err(|_| {
        "The encrypted settings destination directory could not be resolved.".to_string()
    })?;
    let destination = canonical_parent.join(file_name);
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(
                "An existing encrypted settings destination is not a regular file.".to_string(),
            );
        }
    }
    Ok(destination)
}

fn validated_source(value: &str) -> Result<PathBuf, String> {
    let requested = validate_path_text(value)?;
    let metadata = fs::symlink_metadata(requested)
        .map_err(|_| "The encrypted settings file could not be inspected.".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("The encrypted settings source is not a regular file.".to_string());
    }
    requested
        .canonicalize()
        .map_err(|_| "The encrypted settings file could not be resolved.".to_string())
}

fn read_container_file(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path)
        .map_err(|_| "The encrypted settings file could not be opened.".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "The encrypted settings file could not be inspected.".to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_CONTAINER_BYTES {
        return Err("The encrypted settings file size is invalid.".to_string());
    }
    let capacity = usize::try_from(metadata.len())
        .map_err(|_| "The encrypted settings file size is invalid.".to_string())?;
    let mut raw = Vec::new();
    raw.try_reserve_exact(capacity)
        .map_err(|_| "The encrypted settings file could not be buffered safely.".to_string())?;
    file.take(MAX_CONTAINER_BYTES.saturating_add(1))
        .read_to_end(&mut raw)
        .map_err(|_| "The encrypted settings file could not be read.".to_string())?;
    if raw.len() as u64 != metadata.len() || raw.len() as u64 > MAX_CONTAINER_BYTES {
        return Err("The encrypted settings file changed while it was being read.".to_string());
    }
    Ok(raw)
}

fn write_container_file(path: &Path, container: &[u8]) -> Result<(), String> {
    if container.is_empty() || container.len() as u64 > MAX_CONTAINER_BYTES {
        return Err("The encrypted settings output size is invalid.".to_string());
    }
    let expected_bytes = container.len() as u64;
    let expected_sha256: [u8; 32] = Sha256::digest(container).into();
    write_file_atomic(path, container, AtomicWriteOptions::with_unix_mode(0o600))
        .map_err(|_| "The encrypted settings file could not be written atomically.".to_string())?;
    verify_container_file(path, expected_bytes, &expected_sha256)
}

fn verify_container_file(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &[u8; 32],
) -> Result<(), String> {
    let file = fs::File::open(path)
        .map_err(|_| "The encrypted settings file failed write verification.".to_string())?;
    let metadata = file
        .metadata()
        .map_err(|_| "The encrypted settings file failed write verification.".to_string())?;
    if !metadata.is_file()
        || expected_bytes == 0
        || expected_bytes > MAX_CONTAINER_BYTES
        || metadata.len() != expected_bytes
    {
        return Err("The encrypted settings file failed write verification.".to_string());
    }

    let mut reader = file.take(expected_bytes.saturating_add(1));
    let mut digest = Sha256::new();
    let mut observed_bytes = 0_u64;
    let mut buffer = [0_u8; FILE_VERIFICATION_BUFFER_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| "The encrypted settings file failed write verification.".to_string())?;
        if read == 0 {
            break;
        }
        observed_bytes = observed_bytes
            .checked_add(read as u64)
            .filter(|bytes| *bytes <= expected_bytes)
            .ok_or_else(|| "The encrypted settings file failed write verification.".to_string())?;
        digest.update(&buffer[..read]);
    }
    let observed_sha256: [u8; 32] = digest.finalize().into();
    if observed_bytes != expected_bytes || &observed_sha256 != expected_sha256 {
        return Err("The encrypted settings file failed write verification.".to_string());
    }
    Ok(())
}

fn ensure_network_idle(network: &SettingsTransferState) -> Result<(), String> {
    if network.is_active() {
        return Err("Finish or cancel the local-network settings transfer first.".to_string());
    }
    Ok(())
}

fn file_review_statuses(
    wanted: &BTreeSet<SettingsCategoryId>,
    payload: &PortableSettingsPayload,
    local_counts: &BTreeMap<SettingsCategoryId, u32>,
) -> Vec<super::contract::CategoryStatus> {
    let incoming = payload
        .categories
        .iter()
        .map(|category| (category.id, category))
        .collect::<BTreeMap<_, _>>();
    let mut statuses = create_category_statuses(wanted, &BTreeMap::new());
    for status in &mut statuses {
        let offered = incoming.get(&status.id).copied();
        status.effect = Some(if !wanted.contains(&status.id) {
            CategoryEffect::PreserveNotSelected
        } else if offered.is_none() {
            CategoryEffect::PreserveNotOffered
        } else if offered.is_some_and(|category| category.replacement == "empty") {
            CategoryEffect::Clear
        } else {
            CategoryEffect::Replace
        });
        status.current_item_count = if wanted.contains(&status.id) {
            Some(local_counts.get(&status.id).copied().unwrap_or(0))
        } else {
            None
        };
        match offered {
            Some(category) => {
                status.availability = if category.replacement == "empty" {
                    CategoryAvailabilityState::Empty
                } else {
                    CategoryAvailabilityState::Available
                };
                if wanted.contains(&status.id) {
                    status.item_count = category.item_count;
                    status.byte_count = category.plaintext_bytes;
                }
            }
            None if wanted.contains(&status.id) => {
                status.availability = CategoryAvailabilityState::Unavailable;
                status.reason =
                    Some("The encrypted file does not contain this category.".to_string());
            }
            None => {}
        }
    }
    statuses
}

fn retain_effective_categories(
    payload: &mut PortableSettingsPayload,
    effective: &BTreeSet<SettingsCategoryId>,
) -> Vec<CategorySnapshot> {
    let mut retained = Vec::with_capacity(effective.len());
    for mut category in std::mem::take(&mut payload.categories) {
        if effective.contains(&category.id) {
            retained.push(category);
        } else {
            zeroize_snapshot(&mut category);
        }
    }
    retained.sort_by_key(|category| category.id);
    retained
}

fn apply_preview_item_counts(
    local_counts: &mut BTreeMap<SettingsCategoryId, u32>,
    preview_counts: &BTreeMap<SettingsCategoryId, u32>,
) {
    for (id, count) in preview_counts {
        local_counts.insert(*id, *count);
    }
}

pub(crate) async fn export_encrypted_settings_file<R: Runtime>(
    app: AppHandle<R>,
    network: &SettingsTransferState,
    state: &SettingsFileTransferState,
    request: ExportEncryptedSettingsFileRequest,
) -> Result<EncryptedSettingsFileExportResult, String> {
    let ExportEncryptedSettingsFileRequest {
        categories,
        destination_path,
        passphrase,
    } = request;
    let passphrase = SensitivePassphrase(passphrase);
    if categories.is_empty() {
        return Err("Select at least one settings category to export.".to_string());
    }
    let operation = state.begin_file_operation()?;
    ensure_network_idle(network)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation;
        validate_passphrase(&passphrase, true)?;
        let destination = validated_destination(&destination_path)?;
        let export_id = random_id()?;
        let created_at = now_millis();
        let mut snapshots = TransferSnapshotSet::collect(&app, &categories)?;
        let category_snapshots = snapshots.take_offered(&categories)?;
        if category_snapshots.is_empty() {
            return Err(
                "None of the selected settings categories is currently available to export."
                    .to_string(),
            );
        }
        let exported_categories = category_snapshots
            .iter()
            .map(|category| category.id)
            .collect::<Vec<_>>();
        let payload = SensitivePortablePayload(PortableSettingsPayload {
            schema_version: PAYLOAD_SCHEMA_VERSION,
            export_id,
            created_at,
            categories: category_snapshots,
        });
        let item_count = payload
            .0
            .categories
            .iter()
            .try_fold(0_u32, |total, category| {
                total
                    .checked_add(category.item_count)
                    .ok_or_else(|| "The selected settings item count is invalid.".to_string())
            })?;
        if item_count as usize > MAX_TOTAL_ITEMS {
            return Err("The selected settings contain too many items.".to_string());
        }
        let container = encode_portable_payload(payload, passphrase)?;
        write_container_file(&destination, &container)?;
        Ok(EncryptedSettingsFileExportResult {
            categories: exported_categories,
            item_count,
            file_bytes: container.len() as u64,
        })
    })
    .await
    .map_err(|_| "The encrypted settings export task stopped unexpectedly.".to_string())?
}

pub(crate) async fn inspect_encrypted_settings_file<R: Runtime>(
    app: AppHandle<R>,
    network: &SettingsTransferState,
    state: SettingsFileTransferState,
    request: InspectEncryptedSettingsFileRequest,
) -> Result<EncryptedSettingsFileImportReview, String> {
    let InspectEncryptedSettingsFileRequest {
        operation_id,
        categories: wanted,
        source_path,
        passphrase,
    } = request;
    let passphrase = SensitivePassphrase(passphrase);
    if wanted.is_empty() {
        return Err("Select at least one settings category to import.".to_string());
    }
    let (operation, inspection, generation) = state.begin_inspection(operation_id.clone())?;
    ensure_network_idle(network)?;
    let task_state = state.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _inspection = inspection;
        task_state.ensure_inspection_current(generation)?;
        validate_passphrase(&passphrase, false)?;
        let source = validated_source(&source_path)?;
        let container = read_container_file(&source)?;
        task_state.ensure_inspection_current(generation)?;
        with_validated_portable_payload(
            container,
            passphrase,
            || task_state.ensure_inspection_current(generation),
            |mut payload| {
                let offered = payload
                    .0
                    .categories
                    .iter()
                    .map(|category| category.id)
                    .collect::<BTreeSet<_>>();
                let effective = wanted
                    .intersection(&offered)
                    .copied()
                    .collect::<BTreeSet<_>>();
                let local = TransferSnapshotSet::collect(&app, &wanted)?;
                let mut local_counts = local.item_counts();
                drop(local);
                task_state.ensure_inspection_current(generation)?;
                if effective.is_empty() {
                    let statuses = file_review_statuses(&wanted, &payload.0, &local_counts);
                    return Ok(EncryptedSettingsFileImportReview {
                        token: None,
                        file_created_at: payload.0.created_at,
                        review_expires_at: None,
                        effective_categories: Vec::new(),
                        categories: statuses,
                    });
                }
                let preview = capture_preview_fingerprint(&app, &effective)?;
                task_state.ensure_inspection_current(generation)?;
                // The fingerprint capture is the authoritative preview read. As in
                // network transfer, its counts must replace any earlier catalog
                // counts so the review and commit precondition describe one state.
                apply_preview_item_counts(&mut local_counts, &preview.item_counts);
                let statuses = file_review_statuses(&wanted, &payload.0, &local_counts);
                let created_at = now_millis();
                let expires_at = created_at.saturating_add(FILE_IMPORT_REVIEW_MILLIS);
                let envelope = SensitiveTransferEnvelope(TransferEnvelope {
                    protocol_version: PROTOCOL_MAJOR,
                    transfer_id: random_id()?,
                    created_at,
                    expires_at,
                    categories: retain_effective_categories(&mut payload.0, &effective),
                });
                validate_transfer_envelope(&envelope.0)?;
                let token = random_id()?;
                let expiry_cancel = CancellationToken::new();
                task_state.store_pending(
                    generation,
                    PendingFileImport {
                        operation_id,
                        token: Zeroizing::new(token.clone()),
                        expires_at,
                        fingerprint: preview.fingerprint,
                        categories: effective.clone(),
                        envelope,
                        expiry_cancel: expiry_cancel.clone(),
                        _operation: operation,
                    },
                )?;
                // Arm expiry at storage time. The invoking IPC future may be
                // dropped (for example when its webview closes) before it resumes
                // from this blocking task, but the pending plaintext still needs
                // an independent lifetime bound.
                let delay = Duration::from_millis(expires_at.saturating_sub(now_millis()));
                schedule_pending_expiry(task_state.clone(), generation, delay, expiry_cancel);
                Ok(EncryptedSettingsFileImportReview {
                    token: Some(token),
                    file_created_at: payload.0.created_at,
                    review_expires_at: Some(expires_at),
                    effective_categories: effective.into_iter().collect(),
                    categories: statuses,
                })
            },
        )
    })
    .await
    .map_err(|_| "The encrypted settings inspection task stopped unexpectedly.".to_string())?
}

pub(crate) async fn commit_encrypted_settings_file_import<R: Runtime>(
    app: AppHandle<R>,
    network: &SettingsTransferState,
    state: &SettingsFileTransferState,
    request: CommitEncryptedSettingsFileImportRequest,
) -> Result<EncryptedSettingsFileImportResult, String> {
    let token = SensitiveReviewToken(request.token);
    ensure_network_idle(network)?;
    let pending = state.take_pending(token.as_str())?;
    drop(token);
    let commit_critical = state.begin_file_commit_critical()?;
    tauri::async_runtime::spawn_blocking(move || {
        let PendingFileImport {
            operation_id: _operation_id,
            token: _review_token,
            expires_at: _,
            fingerprint,
            categories,
            envelope,
            expiry_cancel: _expiry_cancel,
            _operation,
        } = pending;
        // This guard is declared after the operation lease so commit-critical
        // state clears before the operation becomes idle during scope teardown.
        let _commit_critical = commit_critical;
        let envelope = envelope.into_inner();
        let prepared = prepare_validated_transaction(app.clone(), envelope, &fingerprint)?;
        let outcome = prepared.commit(|| {})?;
        emit_import_reload_events(&app, &categories);
        Ok(EncryptedSettingsFileImportResult {
            categories: categories.into_iter().collect(),
            recovery_cleanup_pending: outcome.recovery_cleanup_pending,
        })
    })
    .await
    .map_err(|_| "The encrypted settings import task stopped unexpectedly.".to_string())?
}

pub(crate) fn cancel_encrypted_settings_file_import(
    state: &SettingsFileTransferState,
    request: CancelEncryptedSettingsFileImportRequest,
) -> Result<bool, String> {
    state.cancel_inspection(&request.operation_id)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use serde_json::json;

    use super::*;
    use crate::settings_transfer::contract::{CategorySnapshotData, SnapshotAvailability};

    fn api_key_snapshot(secret: &str) -> CategorySnapshot {
        let data = CategorySnapshotData::Json(json!({
            "apiKeys": { "openai": secret },
            "webSearchApiKeys": {}
        }));
        let bytes = serde_json::to_vec(&data).expect("snapshot should serialize");
        CategorySnapshot {
            id: SettingsCategoryId::ApiKeys,
            schema_version: super::super::contract::CATEGORY_SCHEMA_VERSION,
            replacement: "value".to_string(),
            item_count: 1,
            plaintext_bytes: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
            data,
        }
    }

    fn empty_api_key_snapshot() -> CategorySnapshot {
        let data = CategorySnapshotData::Json(json!({
            "apiKeys": {},
            "webSearchApiKeys": {}
        }));
        let bytes = serde_json::to_vec(&data).expect("snapshot should serialize");
        CategorySnapshot {
            id: SettingsCategoryId::ApiKeys,
            schema_version: super::super::contract::CATEGORY_SCHEMA_VERSION,
            replacement: "empty".to_string(),
            item_count: 0,
            plaintext_bytes: bytes.len() as u64,
            sha256: sha256_hex(&bytes),
            data,
        }
    }

    fn payload() -> SensitivePortablePayload {
        SensitivePortablePayload(PortableSettingsPayload {
            schema_version: PAYLOAD_SCHEMA_VERSION,
            export_id: "abcdefghijklmnopqrstuvwxyzABCDEF".to_string(),
            created_at: now_millis(),
            categories: vec![api_key_snapshot("secret")],
        })
    }

    fn encoded(passphrase: &str) -> Vec<u8> {
        encode_portable_payload(payload(), SensitivePassphrase(passphrase.to_string()))
            .expect("container should encrypt")
    }

    #[test]
    fn encrypted_file_round_trip_preserves_canonical_category_snapshots() {
        let passphrase = "correct horse battery staple";
        let first = encoded(passphrase);
        let second = encoded(passphrase);
        assert_ne!(first, second, "fresh salt and nonce must change every file");

        let decoded = decode_portable_payload(&first, &SensitivePassphrase(passphrase.to_string()))
            .expect("container should decrypt");
        assert_eq!(decoded.0.categories, payload().0.categories);
        assert_eq!(
            decoded
                .0
                .categories
                .iter()
                .map(|category| category.id)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([SettingsCategoryId::ApiKeys])
        );
    }

    #[test]
    fn version_one_container_fixture_detects_compatibility_drift() {
        const FIXTURE_BASE64URL: &str = concat!(
            "TUFDSERPQ0gtU0VUVElOR1MKAAEAAAFZeyJrZGYiOnsiYWxnb3JpdGhtIjoiYXJnb24yaWQiLCJ2ZXJzaW9uIjoxOSwibWVt",
            "b3J5S2liIjo2NTUzNiwiaXRlcmF0aW9ucyI6MywicGFyYWxsZWxpc20iOjEsInNhbHQiOiJBQUVDQXdRRkJnY0lDUW9MREEw",
            "T0R3In0sImNpcGhlciI6eyJhbGdvcml0aG0iOiJjaGFjaGEyMC1wb2x5MTMwNSIsIm5vbmNlIjoiRUJFU0V4UVZGaGNZR1Jv",
            "YiIsInRhZ0J5dGVzIjoxNn0sInBheWxvYWQiOnsibWVkaWFUeXBlIjoiYXBwbGljYXRpb24vdm5kLm1hY2hkb2NoLnNldHRp",
            "bmdzLXRyYW5zZmVyK2pzb24iLCJzY2hlbWFWZXJzaW9uIjoxLCJwbGFpbnRleHRCeXRlcyI6Mzc5LCJjaXBoZXJ0ZXh0Qnl0",
            "ZXMiOjM5NX19hy1M1liU4_f-iQDQYHB68A-gShS6avwUkUl5nhrSa9IGO4I5I382tOUZsq1u55I7Z-mz0CUpkrhd_BsVInHC",
            "v5A2VXgabuA1iChhyqVOwU539bw20ZHX1UxW-1veevVRXSMStzaC6WhZSijo0oo7zzXsH1CK_N8dpe-iBYZhPINHv8rccUTi",
            "btzRL5YZCm7mHYh15AY-3TjTRoOghPeksUKg2dBzPcecii8jRU1fIa7CMOb48mtERAtA4BOW7gCsD93G60rIKfhzVkT2R5bY",
            "eCHSpQTheQTQ2YWq2tDub31wZFuq9d5WpHxovukyS-mrg-4bm8boBPJ3OgO9UH_PU7ZJLcai23sjZ2J--J_YdeLHZPW6ED8D",
            "4mtKCXgd7vCwJaW-pxbM2q6D5RrUnS3ZCVrBuQK7d8RRrLlqMjsCst6IWhc8SDSsq53dVQeYQq37pi3omh6sD0JDCLV2CNS2",
            "Bn6-4VQP24RMI6hrNqMfV4RmaPM8Tr0EkDK1u2DHB39zLPFImm10SNSp434",
        );
        let passphrase = SensitivePassphrase("correct horse battery staple".to_string());
        let payload = SensitivePortablePayload(PortableSettingsPayload {
            schema_version: PAYLOAD_SCHEMA_VERSION,
            export_id: "abcdefghijklmnopqrstuvwxyzABCDEF".to_string(),
            created_at: 1_700_000_000_000,
            categories: vec![api_key_snapshot("fixture-secret")],
        });
        let plaintext =
            Zeroizing::new(serde_json::to_vec(&payload.0).expect("fixture should serialize"));
        let salt = std::array::from_fn::<_, KDF_SALT_BYTES, _>(|index| index as u8);
        let nonce = std::array::from_fn::<_, AEAD_NONCE_BYTES, _>(|index| (index + 16) as u8);

        let container = encrypt_container_with_material(&plaintext, &passphrase, &salt, &nonce)
            .expect("fixed version-one fixture should encrypt");
        let fixture = URL_SAFE_NO_PAD
            .decode(FIXTURE_BASE64URL)
            .expect("committed fixture should use canonical base64url");

        assert_eq!(container, fixture);
        assert_eq!(
            sha256_hex(&container),
            "9fd4b574f47da174a53d3ffd0901fe7b39b0a285882752a22da7c93c31e2942c"
        );
        let decoded = decode_portable_payload(&fixture, &passphrase)
            .expect("the fixed fixture should remain readable");
        assert_eq!(&decoded.0, &payload.0);
    }

    #[test]
    fn passphrase_bounds_match_export_and_import_policy() {
        assert!(validate_passphrase(&SensitivePassphrase(String::new()), false).is_err());
        assert!(validate_passphrase(&SensitivePassphrase("short".to_string()), true).is_err());
        assert!(validate_passphrase(&SensitivePassphrase("short".to_string()), false).is_ok());
        assert!(validate_passphrase(
            &SensitivePassphrase("x".repeat(PASSPHRASE_MAX_BYTES + 1)),
            false,
        )
        .is_err());
        assert!(validate_passphrase(
            &SensitivePassphrase("correct horse battery staple".to_string()),
            true,
        )
        .is_ok());
    }

    #[test]
    fn portable_creation_time_does_not_require_synchronized_machine_clocks() {
        let mut payload = payload();
        payload.0.created_at = now_millis().saturating_add(24 * 60 * 60 * 1_000);
        validate_portable_payload(&payload.0)
            .expect("an informational future creation time should remain portable");

        payload.0.created_at = MAX_PORTABLE_TIMESTAMP_MILLIS.saturating_add(1);
        assert!(validate_portable_payload(&payload.0).is_err());
    }

    #[test]
    fn wrong_passphrase_and_authenticated_header_tampering_share_a_safe_error() {
        let passphrase = "correct horse battery staple";
        let container = encoded(passphrase);
        let wrong = decode_portable_payload(
            &container,
            &SensitivePassphrase("incorrect horse battery staple".to_string()),
        )
        .err()
        .expect("wrong passphrase must fail");

        let parsed = parse_container(&container).expect("container should parse");
        let salt_text = parsed.header.kdf.salt.clone();
        let mut tampered = container.clone();
        let salt_offset = tampered
            .windows(salt_text.len())
            .position(|window| window == salt_text.as_bytes())
            .expect("salt should be present in the header");
        tampered[salt_offset] = if tampered[salt_offset] == b'A' {
            b'B'
        } else {
            b'A'
        };
        let changed =
            decode_portable_payload(&tampered, &SensitivePassphrase(passphrase.to_string()))
                .err()
                .expect("authenticated header tampering must fail");

        let expected = "The passphrase is incorrect or the encrypted settings file was modified.";
        assert_eq!(wrong, expected);
        assert_eq!(changed, expected);
    }

    #[test]
    fn truncated_and_ciphertext_tampered_containers_fail_closed() {
        let passphrase = "correct horse battery staple";
        let container = encoded(passphrase);
        let fixed_prefix = FILE_MAGIC.len() + 2 + 4;
        for length in [
            0,
            FILE_MAGIC.len().saturating_sub(1),
            FILE_MAGIC.len(),
            fixed_prefix.saturating_sub(1),
            fixed_prefix,
            container.len().saturating_sub(1),
        ] {
            assert!(
                parse_container(&container[..length]).is_err(),
                "a container truncated to {length} bytes must fail"
            );
        }

        let mut tampered = container;
        let ciphertext_offset = parse_container(&tampered)
            .expect("container should parse")
            .aad
            .len();
        tampered[ciphertext_offset] ^= 0x01;
        assert_eq!(
            decode_portable_payload(&tampered, &SensitivePassphrase(passphrase.to_string()))
                .err()
                .expect("ciphertext tampering must fail"),
            "The passphrase is incorrect or the encrypted settings file was modified."
        );
    }

    #[test]
    fn malformed_and_unsupported_containers_fail_before_payload_processing() {
        let called = AtomicBool::new(false);
        let passphrase = SensitivePassphrase("correct horse battery staple".to_string());
        let malformed = b"not-a-machdoch-file";
        let result = decode_portable_payload(malformed, &passphrase).inspect(|_| {
            called.store(true, Ordering::SeqCst);
        });
        assert!(result.is_err());
        assert!(!called.load(Ordering::SeqCst));

        let mut unsupported = encoded("correct horse battery staple");
        let version_offset = FILE_MAGIC.len();
        unsupported[version_offset..version_offset + 2].copy_from_slice(&2_u16.to_be_bytes());
        let error = decode_portable_payload(&unsupported, &passphrase)
            .err()
            .expect("unknown outer version must fail");
        assert!(error.contains("version 2 is not supported"));
        assert!(!called.load(Ordering::SeqCst));
    }

    #[test]
    fn cancellation_after_authentication_skips_payload_parsing_and_preview_work() {
        let checkpoint_called = AtomicBool::new(false);
        let continuation_called = AtomicBool::new(false);
        let result = with_validated_portable_payload(
            encoded("correct horse battery staple"),
            SensitivePassphrase("correct horse battery staple".to_string()),
            || {
                checkpoint_called.store(true, Ordering::SeqCst);
                Err("inspection cancelled at authentication checkpoint".to_string())
            },
            |_| {
                continuation_called.store(true, Ordering::SeqCst);
                Ok(())
            },
        );

        assert_eq!(
            result.expect_err("the cancellation checkpoint must stop processing"),
            "inspection cancelled at authentication checkpoint"
        );
        assert!(checkpoint_called.load(Ordering::SeqCst));
        assert!(!continuation_called.load(Ordering::SeqCst));
    }

    #[test]
    fn version_one_parser_rejects_trailing_data_and_noncanonical_or_changed_profiles() {
        let container = encoded("correct horse battery staple");
        let parsed = parse_container(&container).expect("container should parse");

        let mut trailing = container.clone();
        trailing.push(0);
        assert_eq!(
            parse_container(&trailing)
                .err()
                .expect("trailing bytes must fail"),
            "The encrypted settings file length does not match its header."
        );

        let mut changed_profile = parsed.header.clone();
        changed_profile.kdf.memory_kib -= 1;
        let mut changed_profile_container =
            prefix_with_header(&changed_profile).expect("changed header should serialize");
        changed_profile_container.extend_from_slice(parsed.ciphertext);
        assert!(parse_container(&changed_profile_container)
            .err()
            .expect("a changed fixed profile must fail")
            .contains("unsupported version 1 profile"));

        let mut noncanonical = parsed.header.clone();
        noncanonical.kdf.salt.push('=');
        let mut noncanonical_container =
            prefix_with_header(&noncanonical).expect("changed header should serialize");
        noncanonical_container.extend_from_slice(parsed.ciphertext);
        assert!(parse_container(&noncanonical_container).is_err());
    }

    #[test]
    fn oversized_files_are_rejected_from_metadata_before_allocation() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock should follow the Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-encrypted-settings-oversized-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("test directory should be created");
        let path = root.join("oversized.machdoch-settings");
        let file = std::fs::File::create(&path).expect("test file should be created");
        file.set_len(MAX_CONTAINER_BYTES + 1)
            .expect("test file should be extended");
        drop(file);

        assert_eq!(
            read_container_file(&path).expect_err("oversized file must fail before reading"),
            "The encrypted settings file size is invalid."
        );

        std::fs::remove_dir_all(root).expect("test directory should be removable");
    }

    #[test]
    fn post_write_verification_detects_same_length_corruption_and_size_changes() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("test clock should follow the Unix epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-encrypted-settings-verification-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).expect("test directory should be created");
        let path = root.join("verified.machdoch-settings");
        let expected = b"authenticated encrypted settings bytes";
        let expected_sha256: [u8; 32] = Sha256::digest(expected).into();

        write_container_file(&path, expected).expect("the initial write should verify");

        let mut corrupted = expected.to_vec();
        corrupted[0] ^= 1;
        std::fs::write(&path, &corrupted).expect("corrupt fixture should be written");
        assert!(verify_container_file(&path, expected.len() as u64, &expected_sha256).is_err());

        std::fs::write(&path, &expected[..expected.len() - 1])
            .expect("truncated fixture should be written");
        assert!(verify_container_file(&path, expected.len() as u64, &expected_sha256).is_err());

        let mut extended = expected.to_vec();
        extended.push(0);
        std::fs::write(&path, extended).expect("extended fixture should be written");
        assert!(verify_container_file(&path, expected.len() as u64, &expected_sha256).is_err());

        std::fs::remove_dir_all(root).expect("test directory should be removable");
    }

    #[test]
    fn invalid_payload_fails_atomically_before_the_import_continuation() {
        let mut duplicate_payload = payload();
        duplicate_payload
            .0
            .categories
            .push(api_key_snapshot("duplicate"));
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&duplicate_payload.0).expect("invalid payload should serialize"),
        );
        let passphrase = SensitivePassphrase("correct horse battery staple".to_string());
        let container =
            encrypt_container(&plaintext, &passphrase).expect("container should encrypt");
        let called = AtomicBool::new(false);
        let result = with_validated_portable_payload(
            container,
            passphrase,
            || Ok(()),
            |_| {
                called.store(true, Ordering::SeqCst);
                Ok(())
            },
        );

        assert!(result.is_err());
        assert!(!called.load(Ordering::SeqCst));

        let mut unsupported = payload();
        unsupported.0.categories[0].schema_version += 1;
        assert!(validate_portable_payload(&unsupported.0).is_err());
        assert!(!called.load(Ordering::SeqCst));
    }

    #[test]
    fn file_review_uses_the_same_complete_catalog_and_replacement_semantics() {
        let mut payload = payload();
        let wanted = SettingsCategoryId::ALL.into_iter().collect::<BTreeSet<_>>();
        let statuses = file_review_statuses(&wanted, &payload.0, &BTreeMap::new());

        assert_eq!(statuses.len(), SettingsCategoryId::ALL.len());
        assert_eq!(statuses[0].effect, Some(CategoryEffect::Replace));
        assert!(statuses[1..]
            .iter()
            .all(|status| status.effect == Some(CategoryEffect::PreserveNotOffered)));

        payload.0.categories[0] = empty_api_key_snapshot();
        validate_portable_payload(&payload.0).expect("an explicit empty category should validate");
        let statuses = file_review_statuses(&wanted, &payload.0, &BTreeMap::new());
        assert_eq!(statuses[0].effect, Some(CategoryEffect::Clear));
        assert_eq!(statuses[0].availability, CategoryAvailabilityState::Empty);

        let not_selected = SettingsCategoryId::ALL
            .into_iter()
            .filter(|id| *id != SettingsCategoryId::ApiKeys)
            .collect();
        let statuses = file_review_statuses(&not_selected, &payload.0, &BTreeMap::new());
        assert_eq!(
            statuses[0].effect,
            Some(CategoryEffect::PreserveNotSelected)
        );
    }

    #[test]
    fn authoritative_preview_counts_replace_earlier_catalog_counts() {
        let mut local_counts = BTreeMap::from([
            (SettingsCategoryId::ApiKeys, 1),
            (SettingsCategoryId::GlobalMemory, 7),
        ]);
        let preview_counts = BTreeMap::from([(SettingsCategoryId::ApiKeys, 4)]);

        apply_preview_item_counts(&mut local_counts, &preview_counts);

        assert_eq!(local_counts[&SettingsCategoryId::ApiKeys], 4);
        assert_eq!(local_counts[&SettingsCategoryId::GlobalMemory], 7);
    }

    #[test]
    fn file_export_omits_unavailable_categories_without_dropping_valid_offers() {
        let selected = BTreeSet::from([
            SettingsCategoryId::ApiKeys,
            SettingsCategoryId::GlobalMemory,
        ]);
        let mut snapshots = TransferSnapshotSet(BTreeMap::from([
            (
                SettingsCategoryId::ApiKeys,
                SnapshotAvailability::Available(api_key_snapshot("secret")),
            ),
            (
                SettingsCategoryId::GlobalMemory,
                SnapshotAvailability::Unavailable("invalid local memory".to_string()),
            ),
        ]));

        let offered = snapshots
            .take_offered(&selected)
            .expect("the available category should remain exportable");

        assert_eq!(offered.len(), 1);
        assert_eq!(offered[0].id, SettingsCategoryId::ApiKeys);
    }

    #[test]
    fn operation_coordinator_excludes_network_and_file_work_in_both_directions() {
        let state = SettingsFileTransferState::default();

        let file_operation = state
            .begin_file_operation()
            .expect("the first file operation should start");
        assert!(state.begin_network_operation().is_err());
        drop(file_operation);

        let network_operation = state
            .begin_network_operation()
            .expect("network work should start after the file operation ends");
        assert!(state.begin_file_operation().is_err());
        drop(network_operation);

        assert!(state.begin_file_operation().is_ok());
    }

    #[test]
    fn expired_review_releases_its_operation_lease_before_new_work() {
        let state = SettingsFileTransferState::default();
        let operation_id = "a".repeat(32);
        let (operation, inspection, generation) = state
            .begin_inspection(operation_id.clone())
            .expect("file inspection should acquire the operation lease");
        let _inspection = inspection;
        state
            .store_pending(
                generation,
                PendingFileImport {
                    operation_id,
                    token: Zeroizing::new("expired-review-token".to_string()),
                    expires_at: 0,
                    fingerprint: "0".repeat(64),
                    categories: BTreeSet::from([SettingsCategoryId::ApiKeys]),
                    envelope: SensitiveTransferEnvelope(TransferEnvelope {
                        protocol_version: PROTOCOL_MAJOR,
                        transfer_id: "expired-review-transfer".to_string(),
                        created_at: 1,
                        expires_at: 2,
                        categories: vec![api_key_snapshot("secret")],
                    }),
                    expiry_cancel: CancellationToken::new(),
                    _operation: operation,
                },
            )
            .expect("review should be stored");

        assert!(state.begin_network_operation().is_ok());
        assert!(state.lock().pending.is_none());
    }

    #[test]
    fn invalid_review_tokens_do_not_consume_or_release_a_pending_review() {
        let state = SettingsFileTransferState::default();
        let operation_id = "b".repeat(32);
        let (operation, inspection, generation) = state
            .begin_inspection(operation_id.clone())
            .expect("file inspection should acquire the operation lease");
        let _inspection = inspection;
        let token = "abcdefghijklmnopqrstuvwxyzABCDEF";
        state
            .store_pending(
                generation,
                PendingFileImport {
                    operation_id,
                    token: Zeroizing::new(token.to_string()),
                    expires_at: now_millis().saturating_add(60_000),
                    fingerprint: "0".repeat(64),
                    categories: BTreeSet::from([SettingsCategoryId::ApiKeys]),
                    envelope: SensitiveTransferEnvelope(TransferEnvelope {
                        protocol_version: PROTOCOL_MAJOR,
                        transfer_id: "pending-review-transfer".to_string(),
                        created_at: 1,
                        expires_at: 2,
                        categories: vec![api_key_snapshot("secret")],
                    }),
                    expiry_cancel: CancellationToken::new(),
                    _operation: operation,
                },
            )
            .expect("review should be stored");

        assert!(state.take_pending("short").is_err());
        assert!(state
            .take_pending("abcdefghijklmnopqrstuvwxyzABCDEG")
            .is_err());
        assert!(state.begin_network_operation().is_err());

        let pending = state
            .take_pending(token)
            .expect("the exact capability token should consume the review");
        assert!(pending.expiry_cancel.is_cancelled());
        assert!(state.begin_network_operation().is_err());
        drop(pending);
        assert!(state.begin_network_operation().is_ok());
    }

    #[tokio::test]
    async fn scheduled_review_expiry_releases_plaintext_without_another_command() {
        let state = SettingsFileTransferState::default();
        let operation_id = "c".repeat(32);
        let (operation, inspection, generation) = state
            .begin_inspection(operation_id.clone())
            .expect("file inspection should acquire the operation lease");
        let _inspection = inspection;
        let expiry_cancel = CancellationToken::new();
        state
            .store_pending(
                generation,
                PendingFileImport {
                    operation_id,
                    token: Zeroizing::new("abcdefghijklmnopqrstuvwxyzABCDEF".to_string()),
                    expires_at: now_millis().saturating_add(60_000),
                    fingerprint: "0".repeat(64),
                    categories: BTreeSet::from([SettingsCategoryId::ApiKeys]),
                    envelope: SensitiveTransferEnvelope(TransferEnvelope {
                        protocol_version: PROTOCOL_MAJOR,
                        transfer_id: "scheduled-expiry-transfer".to_string(),
                        created_at: 1,
                        expires_at: 2,
                        categories: vec![api_key_snapshot("secret")],
                    }),
                    expiry_cancel: expiry_cancel.clone(),
                    _operation: operation,
                },
            )
            .expect("review should be stored");

        schedule_pending_expiry(
            state.clone(),
            generation,
            Duration::from_millis(10),
            expiry_cancel,
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            while state.lock().pending.is_some() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the independent expiry task should evict the review");

        assert!(state.lock().pending.is_none());
        assert!(state.begin_network_operation().is_ok());
    }

    #[test]
    fn scoped_cancellation_survives_command_reordering_without_cancelling_other_work() {
        let state = SettingsFileTransferState::default();
        let cancelled_before_start = "d".repeat(32);
        assert!(!state
            .cancel_inspection(&cancelled_before_start)
            .expect("a valid future operation id should be remembered"));
        let cancelled_error = state
            .begin_inspection(cancelled_before_start)
            .err()
            .expect("a cancellation that arrives first must stop the matching inspection");
        assert!(cancelled_error.contains("cancelled"));

        let active_id = "e".repeat(32);
        let (operation, inspection, generation) = state
            .begin_inspection(active_id.clone())
            .expect("an unrelated inspection should still start");
        assert!(!state
            .cancel_inspection(&"f".repeat(32))
            .expect("an unrelated cancellation should remain scoped"));
        state
            .ensure_inspection_current(generation)
            .expect("an unrelated cancellation must not invalidate active work");
        assert!(state
            .cancel_inspection(&active_id)
            .expect("the active inspection should be cancelled"));
        assert!(state.ensure_inspection_current(generation).is_err());
        drop(inspection);
        drop(operation);
        assert_eq!(state.activity(), (false, false));
    }

    #[test]
    fn file_commit_critical_state_is_visible_to_graceful_shutdown() {
        let state = SettingsFileTransferState::default();
        let operation = state
            .begin_file_operation()
            .expect("file work should acquire its operation lease");
        assert_eq!(state.activity(), (true, false));

        let commit = state
            .begin_file_commit_critical()
            .expect("the active file import should enter commit-critical state");
        assert_eq!(state.activity(), (true, true));
        assert!(state.request_stop(), "shutdown must wait for the commit");
        assert_eq!(state.activity(), (true, true));

        drop(commit);
        assert_eq!(state.activity(), (true, false));
        drop(operation);
        assert_eq!(state.activity(), (false, false));
    }
}
