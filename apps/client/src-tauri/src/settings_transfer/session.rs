use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use mdns_sd::{DaemonEvent, ServiceEvent};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter as _, Runtime};
use tokio::{
    net::TcpStream,
    sync::{mpsc, Notify},
    task::JoinSet,
    time::{interval, sleep, sleep_until, timeout, Instant},
};
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization as _;
use zeroize::{Zeroize as _, Zeroizing};

use super::{
    categories::{
        validate_envelope_categories, zeroize_envelope, MAX_TOTAL_ITEMS, MAX_TOTAL_PLAINTEXT_BYTES,
    },
    contract::{
        CategoryAvailabilityState, CategoryEffect, CategorySnapshot,
        ConnectSettingsTransferRequest, DiscoveredTransferSession, ManifestEntry, OfferedCategory,
        PayloadCategoryRange, ReceiverHello, ReviewCategory, SenderHello, SettingsCategoryId,
        SettingsTransferStatus, SnapshotAvailability, StartSettingsReceiveRequest,
        StartSettingsTransferRequest, TransferEnvelope, TransferManifest, TransferMode,
        TransferPhase, TransferReview, CATEGORY_SCHEMA_VERSION, PROTOCOL_MAJOR,
        SETTINGS_TRANSFER_EVENT,
    },
    discovery::{
        bind_listener, create_qr_svg, decode_manual_code, encode_manual_code,
        inspect_network_interfaces, is_valid_session_label, manual_rendezvous,
        parse_resolved_service, random_session_label, select_network_interfaces,
        start_advertisement, start_browser, NetworkSelection, ResolvedRendezvous,
    },
    encrypted_file::SettingsFileTransferState,
    protocol::{
        accept_noise_responder, connect_noise_initiator, constant_time_eq, create_pairing_context,
        create_random_id, now_millis, perform_sas_initiator, perform_sas_responder, random_array,
        ConnectionPreface, NoiseChannel, WireMessage, MAX_PAYLOAD_CHUNK_BYTES,
    },
    service::{
        emit_import_reload_events, prepare_validated_transaction, SensitiveTransferEnvelope,
        TransferSnapshotSet,
    },
    transaction::{
        capture_preview_fingerprint, discard_prepared_transaction, IncomingPayloadStage,
        PreparedTransaction, MAX_WIRE_PAYLOAD_BYTES,
    },
};

const SENDER_SESSION_LIFETIME: Duration = Duration::from_secs(10 * 60);
const CONNECTED_SESSION_LIFETIME: Duration = Duration::from_secs(5 * 60);
const USER_DECISION_TIMEOUT: Duration = Duration::from_secs(60);
const COMMIT_ACK_TIMEOUT: Duration = CONNECTED_SESSION_LIFETIME;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_DISPLAY_NAME_BYTES: usize = 64;
const MAX_DISCOVERED_SESSIONS: usize = 64;
const MAX_REJECTED_CONNECTION_ATTEMPTS: u8 = 3;
const PROGRESS_EMIT_INTERVAL_BYTES: u64 = 256 * 1024;

#[derive(Debug)]
enum LocalAction {
    Connect(ConnectSettingsTransferRequest),
    ConfirmPairing,
    Approve,
}

#[derive(Default)]
struct CompletionSignal {
    completed: AtomicBool,
    notify: Notify,
}

impl CompletionSignal {
    fn complete(&self) {
        self.completed.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    async fn wait(&self) {
        loop {
            // `notify_waiters` does not retain a permit. Create the waiter
            // before observing completion so a concurrent notification cannot
            // be lost between the atomic load and waiter registration.
            let notified = self.notify.notified();
            if self.completed.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

#[derive(Clone)]
struct ActiveSession {
    generation: u64,
    cancel: CancellationToken,
    actions: mpsc::Sender<LocalAction>,
    done: Arc<CompletionSignal>,
}

#[derive(Default)]
struct TransferStateInner {
    generation: u64,
    status: SettingsTransferStatus,
    active: Option<ActiveSession>,
    pending_action_phase: Option<TransferPhase>,
}

#[derive(Clone, Default)]
pub(crate) struct SettingsTransferState {
    inner: Arc<Mutex<TransferStateInner>>,
}

struct SessionSuccess {
    message: String,
    completed_locally: bool,
}

struct SessionTaskContext {
    app: AppHandle,
    state: SettingsTransferState,
    generation: u64,
    cancel: CancellationToken,
}

impl SettingsTransferState {
    fn lock(&self) -> std::sync::MutexGuard<'_, TransferStateInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn status(&self) -> SettingsTransferStatus {
        self.lock().status.clone()
    }

    pub(crate) fn activity(&self) -> (bool, bool) {
        let inner = self.lock();
        let active = inner.active.is_some();
        (
            active,
            active
                && matches!(
                    inner.status.phase,
                    TransferPhase::Committing | TransferPhase::RollingBack
                ),
        )
    }

    pub(crate) fn is_active(&self) -> bool {
        self.activity().0
    }

    pub(crate) fn is_commit_critical(&self) -> bool {
        self.activity().1
    }

    fn mutate_active_status(
        &self,
        generation: u64,
        update: impl FnOnce(&mut SettingsTransferStatus),
    ) -> Option<SettingsTransferStatus> {
        let mut inner = self.lock();
        let active = inner.active.as_ref()?;
        if inner.generation != generation
            || active.generation != generation
            || active.cancel.is_cancelled()
            || !inner.status.phase.is_active()
        {
            return None;
        }
        update(&mut inner.status);
        Some(inner.status.clone())
    }

    fn update(
        &self,
        app: &AppHandle,
        generation: u64,
        update: impl FnOnce(&mut SettingsTransferStatus),
    ) -> bool {
        let Some(status) = self.mutate_active_status(generation, update) else {
            return false;
        };
        let _ = app.emit(SETTINGS_TRANSFER_EVENT, status);
        true
    }

    fn transition_to_commit_critical(&self, generation: u64) -> Option<SettingsTransferStatus> {
        let mut inner = self.lock();
        let active = inner.active.as_ref()?;
        if inner.generation != generation
            || active.generation != generation
            || active.cancel.is_cancelled()
            || inner.status.phase != TransferPhase::Validating
        {
            return None;
        }
        inner.status.phase = TransferPhase::Committing;
        inner.status.message =
            Some("Applying and verifying one journaled all-or-nothing replacement...".to_string());
        Some(inner.status.clone())
    }

    fn enter_commit_critical(&self, app: &AppHandle, generation: u64) -> bool {
        let Some(status) = self.transition_to_commit_critical(generation) else {
            return false;
        };
        let _ = app.emit(SETTINGS_TRANSFER_EVENT, status);
        true
    }

    fn begin(
        &self,
        app: &AppHandle,
        status: SettingsTransferStatus,
        cancel: CancellationToken,
        actions: mpsc::Sender<LocalAction>,
        done: Arc<CompletionSignal>,
    ) -> Result<u64, String> {
        let (generation, emitted) = {
            let mut inner = self.lock();
            if inner.active.is_some() {
                return Err("TRANSFER_ALREADY_ACTIVE".to_string());
            }
            inner.generation = inner.generation.wrapping_add(1).max(1);
            let generation = inner.generation;
            inner.status = status;
            inner.pending_action_phase = None;
            inner.active = Some(ActiveSession {
                generation,
                cancel,
                actions,
                done,
            });
            (generation, inner.status.clone())
        };
        let _ = app.emit(SETTINGS_TRANSFER_EVENT, emitted);
        Ok(generation)
    }

    fn finish(
        &self,
        app: &AppHandle,
        generation: u64,
        result: Result<SessionSuccess, String>,
        done: &CompletionSignal,
    ) {
        let status = {
            let mut inner = self.lock();
            if inner.generation != generation {
                done.complete();
                return;
            }
            if inner
                .active
                .as_ref()
                .is_some_and(|active| active.generation == generation)
            {
                inner.active = None;
            }
            inner.pending_action_phase = None;
            if inner.status.phase.is_active() {
                match result {
                    Ok(success) => {
                        inner.status.phase = TransferPhase::Completed;
                        inner.status.message = Some(success.message);
                        inner.status.error_code = None;
                        inner.status.completed_locally = success.completed_locally;
                        inner.status.pairing_code = None;
                    }
                    Err(error) if error == "CANCELLED" => {
                        inner.status.phase = TransferPhase::Cancelled;
                        inner.status.message = Some("Settings sharing was cancelled.".to_string());
                        inner.status.error_code = None;
                        inner.status.pairing_code = None;
                    }
                    Err(error) => {
                        let code = normalize_error_code(&error);
                        inner.status.phase = TransferPhase::Failed;
                        inner.status.message = Some(public_error_message(&code).to_string());
                        inner.status.error_code = Some(code);
                        inner.status.pairing_code = None;
                    }
                }
            }
            inner.status.clone()
        };
        done.complete();
        let _ = app.emit(SETTINGS_TRANSFER_EVENT, status);
    }

    fn send_action(&self, expected: TransferPhase, action: LocalAction) -> Result<(), String> {
        let mut inner = self.lock();
        if inner.status.phase != expected {
            return Err("INVALID_TRANSFER_STATE".to_string());
        }
        if inner.pending_action_phase.as_ref() == Some(&expected) {
            return Ok(());
        }
        let sender = inner
            .active
            .as_ref()
            .map(|active| active.actions.clone())
            .ok_or_else(|| "NO_ACTIVE_TRANSFER".to_string())?;
        match sender.try_send(action) {
            Ok(()) => {
                inner.pending_action_phase = Some(expected);
                Ok(())
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                Err("TRANSFER_ACTION_ALREADY_PENDING".to_string())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err("TRANSFER_SESSION_CLOSED".to_string()),
        }
    }

    fn clear_pending_action(&self, generation: u64, expected: TransferPhase) {
        let mut inner = self.lock();
        if inner.generation == generation
            && inner.status.phase == expected
            && inner.pending_action_phase.as_ref() == Some(&expected)
        {
            inner.pending_action_phase = None;
        }
    }

    pub(crate) fn request_stop<R: Runtime>(&self, app: &AppHandle<R>, message: &str) -> bool {
        let (active, status) = {
            let mut inner = self.lock();
            let Some(active) = inner.active.clone() else {
                return false;
            };
            if matches!(
                inner.status.phase,
                TransferPhase::Committing | TransferPhase::RollingBack
            ) {
                inner.status.message = Some(
                    "The receiver is finishing its journaled commit or rollback before shutdown."
                        .to_string(),
                );
            } else {
                active.cancel.cancel();
                inner.status.phase = TransferPhase::Cancelled;
                inner.status.message = Some(message.to_string());
                inner.status.pairing_code = None;
                inner.status.manual_code = None;
                inner.status.qr_svg = None;
            }
            inner.pending_action_phase = None;
            (active, inner.status.clone())
        };
        let _ = app.emit(SETTINGS_TRANSFER_EVENT, status);
        !active.done.completed.load(Ordering::Acquire)
    }

    async fn stop(&self, app: &AppHandle, message: &str) -> bool {
        let done = {
            let inner = self.lock();
            inner.active.as_ref().map(|active| active.done.clone())
        };
        let _ = self.request_stop(app, message);
        if let Some(done) = done {
            let _ = timeout(Duration::from_secs(6), done.wait()).await;
        }
        !self.is_active()
    }

    fn replace_inactive_status(
        &self,
        app: &AppHandle,
        status: SettingsTransferStatus,
    ) -> SettingsTransferStatus {
        let (status, replaced) = {
            let mut inner = self.lock();
            if inner.active.is_some() {
                (inner.status.clone(), false)
            } else {
                inner.status = status;
                inner.pending_action_phase = None;
                (inner.status.clone(), true)
            }
        };
        if replaced {
            let _ = app.emit(SETTINGS_TRANSFER_EVENT, status.clone());
        }
        status
    }
}

fn normalize_error_code(error: &str) -> String {
    let candidate = error.split(':').next().unwrap_or_default();
    if !candidate.is_empty()
        && candidate.len() <= 64
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte == b'_')
    {
        candidate.to_string()
    } else {
        "TRANSFER_FAILED".to_string()
    }
}

fn public_error_message(code: &str) -> &'static str {
    match code {
        "SESSION_EXPIRED" | "TRANSFER_EXPIRED" => {
            "The sharing session expired. Start a new session on both PCs."
        }
        "MDNS_START_FAILED"
        | "MDNS_INTERFACE_SETUP_FAILED"
        | "MDNS_REGISTER_FAILED"
        | "MDNS_BROWSE_FAILED"
        | "MDNS_DAEMON_FAILED" => {
            "Automatic local-network discovery is unavailable. Check multicast and firewall access, or use the manual connection code."
        }
        "NO_NETWORK_INTERFACE_SELECTED" | "LOCAL_NETWORK_ENUMERATION_FAILED" => {
            "No usable local-network interface is available. Connect both PCs to the same local network."
        }
        "NETWORK_INTERFACE_CHANGED" => {
            "The local network changed during sharing. Start a fresh session."
        }
        "PAIRING_TIMEOUT" => "Pairing timed out. Start a fresh session and compare the new code.",
        "APPROVAL_TIMEOUT" => {
            "Approval timed out. Start a fresh session and review every category again."
        }
        "SAS_COMMITMENT_MISMATCH" | "PAIRING_CONTEXT_MISMATCH" => {
            "The secure pairing check failed. Do not continue; start a new session and compare the new code."
        }
        "RECEIVER_SETTINGS_CHANGED" => {
            "Settings changed on the receiving PC after the preview. Review a fresh preview before replacing anything."
        }
        "COMMIT_ROLLED_BACK_CLEANUP_PENDING" => {
            "The replacement failed, every original setting was restored and verified, but private recovery cleanup is pending. Restart Machdoch before trying again."
        }
        "PREPARED_TRANSACTION_CLEANUP_PENDING" => {
            "No settings were replaced, but private staging cleanup is pending. Restart Machdoch before trying again."
        }
        "COMMIT_AND_ROLLBACK_FAILED" => {
            "The replacement failed and Machdoch could not verify automatic rollback. Stop changing settings and restart Machdoch so startup recovery can restore the journaled backup."
        }
        "PEER_DISCONNECTED_AFTER_COMMIT" => {
            "The final acknowledgement was lost after commit authorization. Check the receiving PC before retrying."
        }
        "PEER_DISCONNECTED" | "NETWORK_IO_FAILED" | "NETWORK_TIMEOUT" => {
            "The other PC disconnected before the transfer completed."
        }
        "INVALID_MANUAL_CODE" => {
            "The manual connection code is invalid or expired. Copy a fresh code from the sending PC."
        }
        "TOO_MANY_CONNECTION_ATTEMPTS" => {
            "The temporary listener rejected too many connection attempts. Start a fresh session when both PCs are ready."
        }
        "EMPTY_EFFECTIVE_SET" => "No mutually selected, available categories can be transferred.",
        _ => "Settings sharing could not complete safely. No partial replacement was accepted.",
    }
}

fn sanitize_display_name(value: &str) -> String {
    let filtered = value
        .trim()
        .chars()
        .filter(|character| !is_unsafe_display_character(*character))
        .collect::<String>()
        .nfc()
        .collect::<String>();
    let mut value = String::new();
    for character in filtered.chars() {
        if value.len() + character.len_utf8() > MAX_DISPLAY_NAME_BYTES {
            break;
        }
        value.push(character);
    }
    if value.is_empty() {
        if cfg!(target_os = "windows") {
            "This Windows PC".to_string()
        } else if cfg!(target_os = "macos") {
            "This Mac".to_string()
        } else {
            "This computer".to_string()
        }
    } else {
        value
    }
}

fn is_unsafe_display_character(character: char) -> bool {
    character.is_control()
        || (character.is_whitespace() && character != ' ')
        || matches!(
            character,
            '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2069}' | '\u{feff}'
        )
}

fn is_valid_display_text(value: &str, maximum_bytes: usize) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.len() <= maximum_bytes
        && !value.chars().any(is_unsafe_display_character)
        && value.nfc().eq(value.chars())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|value| format!("{value:02x}"))
        .collect()
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn effective_hash(effective: &BTreeSet<SettingsCategoryId>) -> Result<String, String> {
    let canonical = effective
        .iter()
        .copied()
        .map(|id| (id, CATEGORY_SCHEMA_VERSION))
        .collect::<Vec<_>>();
    serde_json::to_vec(&canonical)
        .map(|bytes| sha256_hex(&bytes))
        .map_err(|_| "EFFECTIVE_SET_FAILED".to_string())
}

fn compute_effective(
    sender: &SenderHello,
    receiver: &ReceiverHello,
) -> BTreeSet<SettingsCategoryId> {
    sender
        .offered
        .iter()
        .filter(|offered| {
            matches!(
                offered.availability,
                CategoryAvailabilityState::Available | CategoryAvailabilityState::Empty
            ) && receiver.wanted.contains(&offered.id)
                && receiver
                    .supported
                    .get(&offered.id)
                    .is_some_and(|versions| versions.contains(&offered.schema_version))
        })
        .map(|offered| offered.id)
        .collect()
}

fn offered_categories(
    allowed: &BTreeSet<SettingsCategoryId>,
    snapshots: &BTreeMap<SettingsCategoryId, SnapshotAvailability>,
) -> Vec<OfferedCategory> {
    allowed
        .iter()
        .copied()
        .filter_map(|id| {
            snapshots.get(&id).map(|snapshot| match snapshot {
                SnapshotAvailability::Available(snapshot) => OfferedCategory {
                    id,
                    schema_version: snapshot.schema_version,
                    availability: if snapshot.replacement == "empty" {
                        CategoryAvailabilityState::Empty
                    } else {
                        CategoryAvailabilityState::Available
                    },
                    item_count: snapshot.item_count,
                    plaintext_bytes: snapshot.plaintext_bytes,
                    reason: None,
                },
                SnapshotAvailability::Unavailable(reason) => OfferedCategory {
                    id,
                    schema_version: CATEGORY_SCHEMA_VERSION,
                    availability: CategoryAvailabilityState::Unavailable,
                    item_count: 0,
                    plaintext_bytes: 0,
                    reason: Some(reason.clone()),
                },
            })
        })
        .collect()
}

fn receiver_hello(display_name: String, wanted: BTreeSet<SettingsCategoryId>) -> ReceiverHello {
    ReceiverHello {
        display_name,
        wanted,
        supported: SettingsCategoryId::ALL
            .into_iter()
            .map(|id| (id, vec![CATEGORY_SCHEMA_VERSION]))
            .collect(),
    }
}

fn validate_peer_hello(sender: &SenderHello, receiver: &ReceiverHello) -> Result<(), String> {
    if !is_valid_display_text(&sender.display_name, MAX_DISPLAY_NAME_BYTES)
        || !is_valid_session_label(&sender.session_label)
        || sender.offered.len() > SettingsCategoryId::ALL.len()
        || !is_valid_display_text(&receiver.display_name, MAX_DISPLAY_NAME_BYTES)
        || receiver.supported.len() > SettingsCategoryId::ALL.len()
        || sender
            .offered
            .iter()
            .map(|entry| entry.id)
            .collect::<BTreeSet<_>>()
            .len()
            != sender.offered.len()
        || receiver.supported.values().any(|versions| {
            versions.is_empty()
                || versions.len() > 8
                || versions.contains(&0)
                || versions.iter().copied().collect::<BTreeSet<_>>().len() != versions.len()
        })
        || sender.offered.iter().any(|entry| {
            entry.schema_version == 0
                || entry.item_count as usize > MAX_TOTAL_ITEMS
                || entry.plaintext_bytes > MAX_TOTAL_PLAINTEXT_BYTES
                || match entry.availability {
                    CategoryAvailabilityState::Available => entry.reason.is_some(),
                    CategoryAvailabilityState::Empty => {
                        entry.item_count != 0 || entry.reason.is_some()
                    }
                    CategoryAvailabilityState::Unavailable => {
                        entry.item_count != 0
                            || entry.plaintext_bytes != 0
                            || !entry.reason.as_ref().is_some_and(|reason| {
                                !reason.trim().is_empty()
                                    && reason.len() <= 512
                                    && !reason.chars().any(is_unsafe_display_character)
                            })
                    }
                    CategoryAvailabilityState::Unsupported => true,
                }
        })
    {
        return Err("INVALID_PEER_HELLO".to_string());
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum ConfirmationKind {
    Pairing,
    Approval,
}

impl ConfirmationKind {
    fn message(self) -> WireMessage {
        match self {
            Self::Pairing => WireMessage::PairingConfirmed,
            Self::Approval => WireMessage::Approval,
        }
    }

    fn matches(self, message: &WireMessage) -> bool {
        matches!(
            (self, message),
            (Self::Pairing, WireMessage::PairingConfirmed)
                | (Self::Approval, WireMessage::Approval)
        )
    }

    fn unexpected_message_code(self) -> &'static str {
        match self {
            Self::Pairing => "UNEXPECTED_PAIRING_MESSAGE",
            Self::Approval => "UNEXPECTED_APPROVAL_MESSAGE",
        }
    }
}

async fn exchange_confirmation(
    actions: &mut mpsc::Receiver<LocalAction>,
    cancel: &CancellationToken,
    channel: &mut NoiseChannel,
    kind: ConfirmationKind,
    timeout_code: &'static str,
    expected_local_action: fn(&LocalAction) -> bool,
) -> Result<(), String> {
    let deadline = sleep(USER_DECISION_TIMEOUT);
    tokio::pin!(deadline);
    let mut local_confirmed = false;
    let mut peer_confirmed = false;
    while !local_confirmed || !peer_confirmed {
        tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
            _ = &mut deadline => return Err(timeout_code.to_string()),
            action = actions.recv(), if !local_confirmed => match action {
                Some(action) if expected_local_action(&action) => {
                    local_confirmed = true;
                    send_record(channel, cancel, kind.message()).await?;
                }
                Some(_) => continue,
                None => return Err("CANCELLED".to_string()),
            },
            message = channel.receive() => match message? {
                message if kind.matches(&message) && !peer_confirmed => {
                    peer_confirmed = true;
                }
                WireMessage::Cancel { code } => return Err(code),
                _ => return Err(kind.unexpected_message_code().to_string()),
            }
        }
    }
    Ok(())
}

async fn receive_record(
    channel: &mut NoiseChannel,
    cancel: &CancellationToken,
) -> Result<WireMessage, String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("CANCELLED".to_string()),
        result = channel.receive() => result,
    }
}

async fn send_record(
    channel: &mut NoiseChannel,
    cancel: &CancellationToken,
    message: WireMessage,
) -> Result<(), String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("CANCELLED".to_string()),
        result = channel.send(message) => result,
    }
}

fn create_manifest(
    effective: &BTreeSet<SettingsCategoryId>,
    categories: &[CategorySnapshot],
) -> Result<TransferManifest, String> {
    let entries = categories
        .iter()
        .map(|snapshot| ManifestEntry {
            id: snapshot.id,
            schema_version: snapshot.schema_version,
            replacement: snapshot.replacement.clone(),
            item_count: snapshot.item_count,
            plaintext_bytes: snapshot.plaintext_bytes,
            sha256: snapshot.sha256.clone(),
        })
        .collect::<Vec<_>>();
    let total_bytes = entries.iter().try_fold(0_u64, |total, entry| {
        total
            .checked_add(entry.plaintext_bytes)
            .ok_or_else(|| "INVALID_MANIFEST".to_string())
    })?;
    let total_items = entries.iter().try_fold(0_usize, |total, entry| {
        total
            .checked_add(entry.item_count as usize)
            .ok_or_else(|| "INVALID_MANIFEST".to_string())
    })?;
    if total_bytes > MAX_TOTAL_PLAINTEXT_BYTES
        || total_items > MAX_TOTAL_ITEMS
        || entries.len() != effective.len()
        || entries
            .iter()
            .map(|entry| entry.id)
            .collect::<BTreeSet<_>>()
            != *effective
    {
        return Err("INVALID_MANIFEST".to_string());
    }
    Ok(TransferManifest {
        effective: effective.clone(),
        effective_hash: effective_hash(effective)?,
        entries,
        total_bytes,
    })
}

fn validate_manifest(
    manifest: &TransferManifest,
    expected: &BTreeSet<SettingsCategoryId>,
) -> Result<(), String> {
    if manifest.effective != *expected
        || manifest.effective_hash != effective_hash(expected)?
        || manifest.entries.len() != expected.len()
        || manifest
            .entries
            .iter()
            .map(|entry| entry.id)
            .collect::<BTreeSet<_>>()
            != *expected
        || manifest.entries.iter().any(|entry| {
            entry.schema_version != CATEGORY_SCHEMA_VERSION
                || !matches!(entry.replacement.as_str(), "value" | "empty")
                || !is_sha256_hex(&entry.sha256)
        })
        || manifest.entries.iter().try_fold(0_u64, |total, entry| {
            total.checked_add(entry.plaintext_bytes)
        }) != Some(manifest.total_bytes)
        || manifest
            .entries
            .iter()
            .try_fold(0_usize, |total, entry| {
                total.checked_add(entry.item_count as usize)
            })
            .is_none_or(|total| total > MAX_TOTAL_ITEMS)
        || manifest.total_bytes > MAX_TOTAL_PLAINTEXT_BYTES
    {
        return Err("INVALID_MANIFEST".to_string());
    }
    Ok(())
}

fn locate_payload_category_ranges(
    payload: &[u8],
    categories: &[CategorySnapshot],
) -> Result<Vec<PayloadCategoryRange>, String> {
    let mut ranges = Vec::with_capacity(categories.len());
    let mut search_from = 0_usize;
    for category in categories {
        let encoded = Zeroizing::new(
            serde_json::to_vec(category).map_err(|_| "PAYLOAD_SERIALIZATION_FAILED".to_string())?,
        );
        if encoded.is_empty() || search_from > payload.len() {
            return Err("PAYLOAD_CATEGORY_LAYOUT_FAILED".to_string());
        }
        let marker_length = encoded.len().min(96);
        let relative_start = payload[search_from..]
            .windows(marker_length)
            .position(|window| window == &encoded[..marker_length])
            .ok_or_else(|| "PAYLOAD_CATEGORY_LAYOUT_FAILED".to_string())?;
        let start = search_from
            .checked_add(relative_start)
            .ok_or_else(|| "PAYLOAD_CATEGORY_LAYOUT_FAILED".to_string())?;
        let end = start
            .checked_add(encoded.len())
            .filter(|end| *end <= payload.len())
            .ok_or_else(|| "PAYLOAD_CATEGORY_LAYOUT_FAILED".to_string())?;
        if !constant_time_eq(&payload[start..end], &encoded) {
            return Err("PAYLOAD_CATEGORY_LAYOUT_FAILED".to_string());
        }
        ranges.push(PayloadCategoryRange {
            id: category.id,
            start: start as u64,
            end: end as u64,
        });
        search_from = end;
    }
    Ok(ranges)
}

fn validate_payload_category_ranges(
    ranges: &[PayloadCategoryRange],
    total_bytes: u64,
    manifest: &TransferManifest,
) -> Result<(), String> {
    let mut previous_end = 0_u64;
    let mut ids = BTreeSet::new();
    if ranges.len() != manifest.entries.len()
        || ranges.iter().any(|range| {
            let invalid = range.start < previous_end
                || range.start >= range.end
                || range.end > total_bytes
                || !ids.insert(range.id);
            previous_end = range.end;
            invalid
        })
        || ids != manifest.effective
    {
        return Err("INVALID_PAYLOAD_CATEGORY_LAYOUT".to_string());
    }
    Ok(())
}

fn apply_category_transfer_progress(
    status: &mut SettingsTransferStatus,
    ranges: &[PayloadCategoryRange],
    completed_bytes: u64,
) {
    for category in &mut status.categories {
        if let Some(range) = ranges.iter().find(|range| range.id == category.id) {
            category.transfer_total_bytes = range.end.saturating_sub(range.start);
            category.transferred_bytes = completed_bytes
                .saturating_sub(range.start)
                .min(category.transfer_total_bytes);
        } else {
            category.transfer_total_bytes = 0;
            category.transferred_bytes = 0;
        }
    }
}

fn review_for_receiver(
    sender: &SenderHello,
    receiver: &ReceiverHello,
    manifest: &TransferManifest,
    local_counts: &BTreeMap<SettingsCategoryId, u32>,
) -> TransferReview {
    let offered = sender
        .offered
        .iter()
        .map(|entry| (entry.id, entry))
        .collect::<BTreeMap<_, _>>();
    let entries = manifest
        .entries
        .iter()
        .map(|entry| (entry.id, entry))
        .collect::<BTreeMap<_, _>>();
    let categories = SettingsCategoryId::ALL
        .into_iter()
        .map(|id| {
            let offer = offered.get(&id).copied();
            let entry = entries.get(&id).copied();
            let supported = receiver.supported.get(&id).is_some_and(|versions| {
                offer.is_some_and(|offer| versions.contains(&offer.schema_version))
            });
            let (effect, reason) = if !receiver.wanted.contains(&id) {
                (CategoryEffect::PreserveNotSelected, None)
            } else if offer.is_none() {
                (
                    CategoryEffect::PreserveNotOffered,
                    Some("The sender did not offer this category.".to_string()),
                )
            } else if offer.is_some_and(|offer| {
                matches!(offer.availability, CategoryAvailabilityState::Unavailable)
            }) {
                (
                    CategoryEffect::PreserveUnavailable,
                    offer.and_then(|offer| offer.reason.clone()),
                )
            } else if !supported {
                (
                    CategoryEffect::PreserveIncompatible,
                    Some("No mutually supported category schema is available.".to_string()),
                )
            } else if entry.is_some_and(|entry| entry.replacement == "empty") {
                (CategoryEffect::Clear, None)
            } else {
                (CategoryEffect::Replace, None)
            };
            ReviewCategory {
                id,
                effect,
                incoming_item_count: entry.map_or(0, |entry| entry.item_count),
                incoming_bytes: entry.map_or(0, |entry| entry.plaintext_bytes),
                current_item_count: local_counts.get(&id).copied().unwrap_or(0),
                reason,
            }
        })
        .collect();
    TransferReview {
        effective_hash: manifest.effective_hash.clone(),
        categories,
    }
}

fn validate_review(
    review: &TransferReview,
    sender: &SenderHello,
    receiver: &ReceiverHello,
    manifest: &TransferManifest,
) -> Result<(), String> {
    if review.effective_hash != manifest.effective_hash
        || review.categories.len() != SettingsCategoryId::ALL.len()
        || review
            .categories
            .iter()
            .map(|category| category.id)
            .collect::<BTreeSet<_>>()
            != SettingsCategoryId::ALL.into_iter().collect()
    {
        return Err("PAIRING_CONTEXT_MISMATCH".to_string());
    }
    let expected_review = review_for_receiver(sender, receiver, manifest, &BTreeMap::new());
    let expected = expected_review
        .categories
        .iter()
        .map(|category| (category.id, category))
        .collect::<BTreeMap<_, _>>();
    for category in &review.categories {
        let Some(expected) = expected.get(&category.id) else {
            return Err("PAIRING_CONTEXT_MISMATCH".to_string());
        };
        if category.effect != expected.effect
            || category.incoming_item_count != expected.incoming_item_count
            || category.incoming_bytes != expected.incoming_bytes
            || category.reason != expected.reason
            || category.current_item_count as usize > MAX_TOTAL_ITEMS
        {
            return Err("PAIRING_CONTEXT_MISMATCH".to_string());
        }
    }
    Ok(())
}

fn apply_review_to_status(status: &mut SettingsTransferStatus, review: &TransferReview) {
    let review = review
        .categories
        .iter()
        .map(|category| (category.id, category))
        .collect::<BTreeMap<_, _>>();
    for category in &mut status.categories {
        if let Some(entry) = review.get(&category.id) {
            category.effect = Some(entry.effect.clone());
            category.current_item_count = if entry.effect == CategoryEffect::PreserveNotSelected {
                None
            } else {
                Some(entry.current_item_count)
            };
            if matches!(
                entry.effect,
                CategoryEffect::Replace | CategoryEffect::Clear
            ) {
                category.item_count = entry.incoming_item_count;
                category.byte_count = entry.incoming_bytes;
            }
            if entry.reason.is_some() {
                category.reason.clone_from(&entry.reason);
            }
        }
    }
}

fn verify_envelope(
    envelope: &TransferEnvelope,
    channel: &NoiseChannel,
    manifest: &TransferManifest,
) -> Result<(), String> {
    if envelope.protocol_version != PROTOCOL_MAJOR
        || !constant_time_eq(
            envelope.transfer_id.as_bytes(),
            channel.transfer_id()?.as_bytes(),
        )
        || envelope.created_at != channel.created_at()
        || envelope.expires_at != channel.expires_at()
        || now_millis() > envelope.expires_at
    {
        return Err("INVALID_TRANSFER_PAYLOAD".to_string());
    }
    validate_envelope_categories(&envelope.categories)?;
    let received = envelope
        .categories
        .iter()
        .map(|category| (category.id, category))
        .collect::<BTreeMap<_, _>>();
    if received.len() != manifest.entries.len() {
        return Err("INVALID_TRANSFER_PAYLOAD".to_string());
    }
    for entry in &manifest.entries {
        let Some(category) = received.get(&entry.id) else {
            return Err("INVALID_TRANSFER_PAYLOAD".to_string());
        };
        if category.schema_version != entry.schema_version
            || category.replacement != entry.replacement
            || category.item_count != entry.item_count
            || category.plaintext_bytes != entry.plaintext_bytes
            || !constant_time_eq(category.sha256.as_bytes(), entry.sha256.as_bytes())
        {
            return Err("INVALID_TRANSFER_PAYLOAD".to_string());
        }
    }
    Ok(())
}

pub(crate) async fn inspect_catalog(
    app: AppHandle,
    state: &SettingsTransferState,
) -> Result<SettingsTransferStatus, String> {
    let existing = state.status();
    if state.is_active() {
        return Ok(existing);
    }
    let app_for_snapshot = app.clone();
    let snapshots = tauri::async_runtime::spawn_blocking(move || {
        TransferSnapshotSet::collect(
            &app_for_snapshot,
            &SettingsCategoryId::ALL.into_iter().collect(),
        )
    })
    .await
    .map_err(|_| "SETTINGS_INSPECTION_FAILED".to_string())??;
    let selected = SettingsCategoryId::ALL
        .into_iter()
        .filter(|id| id.metadata().default_selected)
        .collect::<BTreeSet<_>>();
    let status = SettingsTransferStatus {
        categories: snapshots.statuses(&selected),
        network_interfaces: inspect_network_interfaces()?,
        ..SettingsTransferStatus::default()
    };
    drop(snapshots);
    Ok(state.replace_inactive_status(&app, status))
}

pub(crate) async fn start_send(
    app: AppHandle,
    state: SettingsTransferState,
    file_state: SettingsFileTransferState,
    request: StartSettingsTransferRequest,
) -> Result<SettingsTransferStatus, String> {
    if !state
        .stop(&app, "The previous sharing session was stopped.")
        .await
    {
        return Err("TRANSFER_COMMIT_IN_PROGRESS".to_string());
    }
    let operation = file_state.begin_network_operation()?;
    if request.categories.is_empty() {
        return Err("NO_CATEGORIES_SELECTED".to_string());
    }
    let selection = select_network_interfaces(&request.interface_ids)?;
    let status = SettingsTransferStatus {
        mode: Some(TransferMode::Send),
        phase: TransferPhase::Inspecting,
        categories: super::categories::create_category_statuses(
            &request.categories,
            &BTreeMap::new(),
        ),
        network_interfaces: selection.statuses(),
        message: Some("Preparing an encrypted local-network session...".to_string()),
        ..SettingsTransferStatus::default()
    };
    let cancel = CancellationToken::new();
    let (action_tx, action_rx) = mpsc::channel(8);
    let done = Arc::new(CompletionSignal::default());
    let generation = state.begin(&app, status, cancel.clone(), action_tx, done.clone())?;
    let task_state = state.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _operation = operation;
        let selected = request.categories;
        let display_name = sanitize_display_name(&request.display_name);
        let app_for_snapshot = task_app.clone();
        let selected_for_snapshot = selected.clone();
        let result = async {
            let snapshots = tauri::async_runtime::spawn_blocking(move || {
                TransferSnapshotSet::collect(&app_for_snapshot, &selected_for_snapshot)
            })
            .await
            .map_err(|_| "SETTINGS_INSPECTION_FAILED".to_string())??;
            if cancel.is_cancelled() {
                return Err("CANCELLED".to_string());
            }
            task_state.update(&task_app, generation, |status| {
                status.categories = snapshots.statuses(&selected);
            });
            sender_task(
                SessionTaskContext {
                    app: task_app.clone(),
                    state: task_state.clone(),
                    generation,
                    cancel: cancel.clone(),
                },
                action_rx,
                selected,
                display_name,
                selection,
                snapshots,
            )
            .await
        }
        .await;
        task_state.finish(&task_app, generation, result, &done);
    });
    Ok(state.status())
}

pub(crate) async fn start_receive(
    app: AppHandle,
    state: SettingsTransferState,
    file_state: SettingsFileTransferState,
    request: StartSettingsReceiveRequest,
) -> Result<SettingsTransferStatus, String> {
    if !state
        .stop(&app, "The previous sharing session was stopped.")
        .await
    {
        return Err("TRANSFER_COMMIT_IN_PROGRESS".to_string());
    }
    let operation = file_state.begin_network_operation()?;
    if request.categories.is_empty() {
        return Err("NO_CATEGORIES_SELECTED".to_string());
    }
    let selection = select_network_interfaces(&request.interface_ids)?;
    let status = SettingsTransferStatus {
        mode: Some(TransferMode::Receive),
        phase: TransferPhase::Inspecting,
        categories: super::categories::create_category_statuses(
            &request.categories,
            &BTreeMap::new(),
        ),
        network_interfaces: selection.statuses(),
        message: Some("Inspecting the receiving PC's current settings...".to_string()),
        ..SettingsTransferStatus::default()
    };
    let cancel = CancellationToken::new();
    let (action_tx, action_rx) = mpsc::channel(8);
    let done = Arc::new(CompletionSignal::default());
    let generation = state.begin(&app, status, cancel.clone(), action_tx, done.clone())?;
    let task_state = state.clone();
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _operation = operation;
        let wanted = request.categories;
        let display_name = sanitize_display_name(&request.display_name);
        let app_for_snapshot = task_app.clone();
        let wanted_for_snapshot = wanted.clone();
        let result = async {
            let snapshots = tauri::async_runtime::spawn_blocking(move || {
                TransferSnapshotSet::collect(&app_for_snapshot, &wanted_for_snapshot)
            })
            .await
            .map_err(|_| "SETTINGS_INSPECTION_FAILED".to_string())??;
            if cancel.is_cancelled() {
                return Err("CANCELLED".to_string());
            }
            let counts = snapshots.item_counts();
            let mut categories = snapshots.statuses(&wanted);
            for category in &mut categories {
                category.current_item_count = Some(category.item_count);
                category.item_count = 0;
                category.byte_count = 0;
            }
            drop(snapshots);
            task_state.update(&task_app, generation, |status| {
                status.phase = TransferPhase::Discovering;
                status.categories = categories;
                status.message = Some("Looking for live Machdoch sharing sessions...".to_string());
            });
            receiver_task(
                SessionTaskContext {
                    app: task_app.clone(),
                    state: task_state.clone(),
                    generation,
                    cancel: cancel.clone(),
                },
                action_rx,
                wanted,
                display_name,
                selection,
                counts,
            )
            .await
        }
        .await;
        task_state.finish(&task_app, generation, result, &done);
    });
    Ok(state.status())
}

pub(crate) fn connect(
    state: &SettingsTransferState,
    request: ConnectSettingsTransferRequest,
) -> Result<(), String> {
    if request.discovered_id.is_some() == request.manual_code.is_some() {
        return Err("INVALID_CONNECTION_SELECTION".to_string());
    }
    state.send_action(TransferPhase::Discovering, LocalAction::Connect(request))
}

pub(crate) fn confirm_pairing(state: &SettingsTransferState) -> Result<(), String> {
    state.send_action(TransferPhase::Pairing, LocalAction::ConfirmPairing)
}

pub(crate) fn approve(state: &SettingsTransferState) -> Result<(), String> {
    state.send_action(TransferPhase::Review, LocalAction::Approve)
}

pub(crate) async fn stop(app: AppHandle, state: &SettingsTransferState) -> SettingsTransferStatus {
    let _ = state
        .stop(&app, "Settings sharing was cancelled on this PC.")
        .await;
    state.status()
}

struct SenderConnection {
    channel: NoiseChannel,
    sender_hello: SenderHello,
    receiver_hello: ReceiverHello,
}

struct SenderOffer<'a> {
    cancel: &'a CancellationToken,
    display_name: &'a str,
    allowed: &'a BTreeSet<SettingsCategoryId>,
    snapshots: &'a BTreeMap<SettingsCategoryId, SnapshotAvailability>,
    absolute_expires_at: u64,
}

struct SenderRendezvousContext<'a> {
    app: &'a AppHandle,
    state: &'a SettingsTransferState,
    generation: u64,
    cancel: &'a CancellationToken,
    selection: &'a NetworkSelection,
    allowed: &'a BTreeSet<SettingsCategoryId>,
    snapshots: &'a BTreeMap<SettingsCategoryId, SnapshotAvailability>,
    display_name: &'a str,
    absolute_expires_at: u64,
    advertisement_deadline: Instant,
}

fn is_unrelated_preface_error(error: &str) -> bool {
    matches!(
        error,
        "INVALID_PREFACE"
            | "SESSION_ID_MISMATCH"
            | "PROTOCOL_MISMATCH"
            | "NETWORK_TIMEOUT"
            | "PEER_DISCONNECTED"
            | "INVALID_FRAME"
    )
}

async fn establish_sender_connection(
    stream: TcpStream,
    sid: &[u8; 16],
    label: &str,
    offer: SenderOffer<'_>,
) -> Result<SenderConnection, String> {
    let SenderOffer {
        cancel,
        display_name,
        allowed,
        snapshots,
        absolute_expires_at,
    } = offer;
    let (mut channel, _) = tokio::select! {
        _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
        result = accept_noise_responder(stream, sid) => result?,
    };
    let result = async {
        let transfer_id = create_random_id(32)?;
        let connected_expiry = absolute_expires_at
            .min(now_millis().saturating_add(CONNECTED_SESSION_LIFETIME.as_millis() as u64));
        let created_at = now_millis();
        channel.set_sender_session(transfer_id, created_at, connected_expiry)?;
        let sender_hello = SenderHello {
            display_name: display_name.to_string(),
            session_label: label.to_string(),
            offered: offered_categories(allowed, snapshots),
        };
        send_record(
            &mut channel,
            cancel,
            WireMessage::SenderHello(sender_hello.clone()),
        )
        .await?;
        let receiver_hello = match receive_record(&mut channel, cancel).await? {
            WireMessage::ReceiverHello(hello) => hello,
            WireMessage::Cancel { code } => return Err(code),
            _ => return Err("UNEXPECTED_HELLO_MESSAGE".to_string()),
        };
        validate_peer_hello(&sender_hello, &receiver_hello)?;
        Ok((sender_hello, receiver_hello))
    }
    .await;

    match result {
        Ok((sender_hello, receiver_hello)) => Ok(SenderConnection {
            channel,
            sender_hello,
            receiver_hello,
        }),
        Err(error) => {
            channel.send_cancel(&error).await;
            Err(error)
        }
    }
}

async fn wait_for_sender_connection(
    context: SenderRendezvousContext<'_>,
) -> Result<SenderConnection, String> {
    let SenderRendezvousContext {
        app,
        state,
        generation,
        cancel,
        selection,
        allowed,
        snapshots,
        display_name,
        absolute_expires_at,
        advertisement_deadline,
    } = context;
    loop {
        if Instant::now() >= advertisement_deadline || now_millis() >= absolute_expires_at {
            return Err("SESSION_EXPIRED".to_string());
        }
        let listener = bind_listener()?;
        let port = listener
            .local_addr()
            .map_err(|_| "NETWORK_LISTENER_FAILED".to_string())?
            .port();
        let sid: [u8; 16] = random_array()?;
        let label = random_session_label()?;
        let advertisement = start_advertisement(selection, &label, &sid, port);
        let mut advertisement = advertisement.ok();
        let manual = manual_rendezvous(selection, &label, &sid, port, absolute_expires_at);
        let manual_code = encode_manual_code(&manual)?;
        let qr_svg = create_qr_svg(&manual_code)?;
        state.update(app, generation, |status| {
            status.phase = TransferPhase::Advertising;
            status.session_label = Some(label.clone());
            status.created_at.get_or_insert_with(now_millis);
            status.expires_at = Some(absolute_expires_at);
            status.manual_code = Some(manual_code);
            status.qr_svg = Some(qr_svg);
            if advertisement.is_some() {
                status.message =
                    Some("Available on the selected local-network interfaces.".to_string());
                status.error_code = None;
            } else {
                status.message = Some(
                    "Automatic discovery is unavailable; use the manual or QR code.".to_string(),
                );
                status.error_code = Some("MDNS_START_FAILED".to_string());
            }
        });

        let mut rotate = false;
        let mut monitor_active = advertisement.is_some();
        let mut rejected_connections = 0_u8;
        let connection = loop {
            tokio::select! {
                _ = cancel.cancelled() => break Err("CANCELLED".to_string()),
                _ = sleep_until(advertisement_deadline) => {
                    break Err("SESSION_EXPIRED".to_string());
                }
                event = async {
                    match advertisement.as_ref() {
                        Some(advertisement) if monitor_active => {
                            Some(advertisement.monitor.recv_async().await)
                        }
                        _ => std::future::pending().await,
                    }
                } => {
                    match event {
                        Some(Ok(DaemonEvent::Error(_))) => {
                            state.update(app, generation, |status| {
                                status.message = Some("Automatic discovery is unavailable; the manual code remains active.".to_string());
                                status.error_code = Some("MDNS_DAEMON_FAILED".to_string());
                            });
                        }
                        Some(Ok(DaemonEvent::IpDel(_))) => break Err("NETWORK_INTERFACE_CHANGED".to_string()),
                        Some(Ok(DaemonEvent::NameChange(_))) => {
                            rotate = true;
                            break Err("ADVERTISEMENT_NAME_CHANGED".to_string());
                        }
                        Some(Ok(_)) => {}
                        Some(Err(_)) => {
                            monitor_active = false;
                            state.update(app, generation, |status| {
                                status.message = Some("Automatic discovery stopped; the manual code remains active.".to_string());
                                status.error_code = Some("MDNS_DAEMON_FAILED".to_string());
                            });
                        }
                        None => {}
                    }
                }
                accepted = listener.accept() => {
                    let Ok((stream, peer)) = accepted else {
                        break Err("NETWORK_LISTENER_FAILED".to_string());
                    };
                    if !selection.contains_peer(peer) {
                        drop(stream);
                        continue;
                    }
                    let attempt = establish_sender_connection(
                        stream,
                        &sid,
                        &label,
                        SenderOffer {
                            cancel,
                            display_name,
                            allowed,
                            snapshots,
                            absolute_expires_at,
                        },
                    )
                    .await;
                    match attempt {
                        Ok(connection) => break Ok(connection),
                        Err(error) if is_unrelated_preface_error(&error) => {
                            rejected_connections = rejected_connections.saturating_add(1);
                            if rejected_connections >= MAX_REJECTED_CONNECTION_ATTEMPTS {
                                break Err("TOO_MANY_CONNECTION_ATTEMPTS".to_string());
                            }
                            sleep(Duration::from_millis(50)).await;
                            continue;
                        }
                        Err(error) => {
                            rotate = true;
                            break Err(error);
                        }
                    }
                }
            }
        };
        drop(listener);
        if let Some(advertisement) = advertisement.take() {
            advertisement.shutdown().await;
        }
        match connection {
            Ok(connection) => return Ok(connection),
            Err(_error) if rotate && !cancel.is_cancelled() => {
                state.update(app, generation, |status| {
                    status.message = Some(
                        "The previous connection attempt was closed. Publishing a fresh single-use session..."
                            .to_string(),
                    );
                    status.manual_code = None;
                    status.qr_svg = None;
                });
                continue;
            }
            Err(error) => return Err(error),
        }
    }
}

async fn sender_task(
    context: SessionTaskContext,
    mut actions: mpsc::Receiver<LocalAction>,
    allowed: BTreeSet<SettingsCategoryId>,
    display_name: String,
    selection: NetworkSelection,
    mut snapshots: TransferSnapshotSet,
) -> Result<SessionSuccess, String> {
    let SessionTaskContext {
        app,
        state,
        generation,
        cancel,
    } = context;
    let created_at = now_millis();
    let absolute_expires_at = created_at.saturating_add(SENDER_SESSION_LIFETIME.as_millis() as u64);
    let advertisement_deadline = Instant::now() + SENDER_SESSION_LIFETIME;
    let SenderConnection {
        mut channel,
        sender_hello,
        receiver_hello,
    } = wait_for_sender_connection(SenderRendezvousContext {
        app: &app,
        state: &state,
        generation,
        cancel: &cancel,
        selection: &selection,
        allowed: &allowed,
        snapshots: &snapshots.0,
        display_name: &display_name,
        absolute_expires_at,
        advertisement_deadline,
    })
    .await?;
    let result = async {
        let effective = compute_effective(&sender_hello, &receiver_hello);
        let context =
            create_pairing_context(channel.handshake_hash(), &sender_hello, &receiver_hello)?;
        let pairing_code = tokio::select! {
            _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
            result = perform_sas_responder(&mut channel, &context) => result?,
        };
        state.update(&app, generation, |status| {
            status.phase = TransferPhase::Pairing;
            status.peer_name = Some(receiver_hello.display_name.clone());
            status.peer_categories = receiver_hello.wanted.iter().copied().collect();
            status.effective_categories = effective.iter().copied().collect();
            status.pairing_code = Some(pairing_code);
            status.manual_code = None;
            status.qr_svg = None;
            status.expires_at = Some(channel.expires_at());
            status.message = Some(
                "Compare this code on both PCs. Continue only if every digit matches.".to_string(),
            );
        });
        exchange_confirmation(
            &mut actions,
            &cancel,
            &mut channel,
            ConfirmationKind::Pairing,
            "PAIRING_TIMEOUT",
            |action| matches!(action, LocalAction::ConfirmPairing),
        )
        .await?;

        let mut categories = Vec::with_capacity(effective.len());
        for id in &effective {
            let snapshot = snapshots
                .0
                .remove(id)
                .ok_or_else(|| "EFFECTIVE_CATEGORY_MISSING".to_string())?;
            match snapshot {
                SnapshotAvailability::Available(snapshot) => categories.push(snapshot),
                SnapshotAvailability::Unavailable(_) => {
                    return Err("EFFECTIVE_CATEGORY_UNAVAILABLE".to_string())
                }
            }
        }
        categories.sort_by_key(|category| category.id);
        let envelope = SensitiveTransferEnvelope(TransferEnvelope {
            protocol_version: PROTOCOL_MAJOR,
            transfer_id: channel.transfer_id()?.to_string(),
            created_at: channel.created_at(),
            expires_at: channel.expires_at(),
            categories,
        });
        let manifest = create_manifest(&effective, &envelope.0.categories)?;
        send_record(
            &mut channel,
            &cancel,
            WireMessage::Manifest(manifest.clone()),
        )
        .await?;
        let review = match receive_record(&mut channel, &cancel).await? {
            WireMessage::Review(review) => review,
            WireMessage::Cancel { code } => return Err(code),
            _ => return Err("UNEXPECTED_REVIEW_MESSAGE".to_string()),
        };
        validate_review(&review, &sender_hello, &receiver_hello, &manifest)?;
        state.update(&app, generation, |status| {
            status.phase = TransferPhase::Review;
            status.pairing_code = None;
            status.total_bytes = manifest.total_bytes;
            status.message = Some(if effective.is_empty() {
                "No mutually selected, available categories were found.".to_string()
            } else {
                "Review what the receiving PC will replace or clear, then authorize the transfer."
                    .to_string()
            });
            apply_review_to_status(status, &review);
        });
        if effective.is_empty() {
            send_record(&mut channel, &cancel, WireMessage::Approval).await?;
            match receive_record(&mut channel, &cancel).await? {
                WireMessage::Approval => {
                    return Ok(SessionSuccess {
                        message:
                            "Nothing was transferred because the effective category set was empty."
                                .to_string(),
                        completed_locally: false,
                    })
                }
                WireMessage::Cancel { code } => return Err(code),
                _ => return Err("UNEXPECTED_APPROVAL_MESSAGE".to_string()),
            }
        }
        exchange_confirmation(
            &mut actions,
            &cancel,
            &mut channel,
            ConfirmationKind::Approval,
            "APPROVAL_TIMEOUT",
            |action| matches!(action, LocalAction::Approve),
        )
        .await?;

        let payload = Zeroizing::new(
            serde_json::to_vec(&envelope.0)
                .map_err(|_| "PAYLOAD_SERIALIZATION_FAILED".to_string())?,
        );
        if payload.is_empty() || payload.len() as u64 > MAX_WIRE_PAYLOAD_BYTES {
            return Err("INVALID_PAYLOAD_SIZE".to_string());
        }
        let category_ranges = locate_payload_category_ranges(&payload, &envelope.0.categories)?;
        validate_payload_category_ranges(&category_ranges, payload.len() as u64, &manifest)?;
        let payload_hash = sha256_hex(&payload);
        state.update(&app, generation, |status| {
            status.phase = TransferPhase::Transferring;
            status.transferred_bytes = 0;
            status.total_bytes = payload.len() as u64;
            apply_category_transfer_progress(status, &category_ranges, 0);
            status.message = Some("Sending encrypted, bounded category data...".to_string());
        });
        send_record(
            &mut channel,
            &cancel,
            WireMessage::PayloadStart {
                total_bytes: payload.len() as u64,
                sha256: payload_hash,
                category_ranges: category_ranges.clone(),
            },
        )
        .await?;
        let mut last_reported_bytes = 0_u64;
        for (index, chunk) in payload.chunks(MAX_PAYLOAD_CHUNK_BYTES).enumerate() {
            let offset = (index * MAX_PAYLOAD_CHUNK_BYTES) as u64;
            send_record(
                &mut channel,
                &cancel,
                WireMessage::PayloadChunk {
                    offset,
                    data: BASE64.encode(chunk),
                },
            )
            .await?;
            let completed = (offset + chunk.len() as u64).min(payload.len() as u64);
            if completed == payload.len() as u64
                || completed.saturating_sub(last_reported_bytes) >= PROGRESS_EMIT_INTERVAL_BYTES
            {
                state.update(&app, generation, |status| {
                    status.transferred_bytes = completed;
                    apply_category_transfer_progress(status, &category_ranges, completed);
                });
                last_reported_bytes = completed;
            }
        }
        send_record(&mut channel, &cancel, WireMessage::PayloadEnd).await?;
        match receive_record(&mut channel, &cancel).await? {
            WireMessage::ReadyToCommit => {}
            WireMessage::Cancel { code } => return Err(code),
            _ => return Err("UNEXPECTED_COMMIT_MESSAGE".to_string()),
        }
        send_record(&mut channel, &cancel, WireMessage::CommitAuthorized).await?;
        state.update(&app, generation, |status| {
            status.phase = TransferPhase::Committing;
            status.message =
                Some("The receiving PC is applying one journaled replacement.".to_string());
        });
        match channel.receive_with_idle_timeout(COMMIT_ACK_TIMEOUT).await {
            Ok(WireMessage::CommitSucceeded) => Ok(SessionSuccess {
                message: "The receiving PC verified and committed every selected category."
                    .to_string(),
                completed_locally: false,
            }),
            Ok(WireMessage::Cancel { code }) => Err(code),
            Ok(_) => Err("UNEXPECTED_COMMIT_MESSAGE".to_string()),
            Err(error) if matches!(error.as_str(), "PEER_DISCONNECTED" | "NETWORK_TIMEOUT") => {
                Err("PEER_DISCONNECTED_AFTER_COMMIT".to_string())
            }
            Err(error) => Err(error),
        }
    }
    .await;
    if let Err(error) = &result {
        channel.send_cancel(error).await;
    }
    result
}

async fn browse_for_rendezvous(
    app: &AppHandle,
    state: &SettingsTransferState,
    generation: u64,
    cancel: &CancellationToken,
    actions: &mut mpsc::Receiver<LocalAction>,
    selection: &NetworkSelection,
) -> Result<ResolvedRendezvous, String> {
    let browser = start_browser(selection);
    if browser.is_err() {
        state.update(app, generation, |status| {
            status.message = Some(
                "Automatic discovery is unavailable. Paste a manual code from the sending PC."
                    .to_string(),
            );
            status.error_code = Some("MDNS_BROWSE_FAILED".to_string());
        });
    }
    let browser = browser.ok();
    let mut events_active = browser.is_some();
    let mut monitor_active = browser.is_some();
    let mut discovered = BTreeMap::<String, ResolvedRendezvous>::new();
    let mut ticker = interval(Duration::from_secs(1));
    let result = loop {
        if let Some(active_browser) = browser.as_ref() {
            tokio::select! {
                _ = cancel.cancelled() => break Err("CANCELLED".to_string()),
                _ = ticker.tick() => {
                    let now = now_millis();
                    let previous_len = discovered.len();
                    discovered.retain(|_, session| session.expires_at > now);
                    if discovered.len() != previous_len {
                        publish_discovered(app, state, generation, &discovered);
                    }
                }
                action = actions.recv() => {
                    let Some(LocalAction::Connect(request)) = action else {
                        if action.is_none() {
                            break Err("CANCELLED".to_string());
                        }
                        continue;
                    };
                    match resolve_connection_request(request, &discovered) {
                        Ok(session) => break Ok(session),
                        Err(error) => {
                            state.clear_pending_action(generation, TransferPhase::Discovering);
                            state.update(app, generation, |status| {
                                let code = normalize_error_code(&error);
                                status.message = Some(public_error_message(&code).to_string());
                                status.error_code = Some(code);
                            });
                        }
                    }
                }
                event = active_browser.events.recv_async(), if events_active => {
                    match event {
                        Ok(ServiceEvent::ServiceResolved(service)) => {
                            if let Some(session) = parse_resolved_service(&service) {
                                let changed = discovered.get(&session.id).is_none_or(|existing| {
                                    existing.label != session.label
                                        || existing.sid != session.sid
                                        || existing.endpoints != session.endpoints
                                });
                                if discovered.len() < MAX_DISCOVERED_SESSIONS
                                    || discovered.contains_key(&session.id)
                                {
                                    discovered.insert(session.id.clone(), session);
                                    if changed {
                                        publish_discovered(app, state, generation, &discovered);
                                    }
                                }
                            }
                        }
                        Ok(ServiceEvent::ServiceRemoved(_, id)) => {
                            if discovered.remove(&id).is_some() {
                                publish_discovered(app, state, generation, &discovered);
                            }
                        }
                        Ok(_) => {}
                        Err(_) => {
                            state.update(app, generation, |status| {
                                status.message = Some("Automatic discovery stopped. Paste a manual code to continue.".to_string());
                                status.error_code = Some("MDNS_DAEMON_FAILED".to_string());
                            });
                            events_active = false;
                        }
                    }
                }
                event = active_browser.monitor.recv_async(), if monitor_active => {
                    match event {
                        Ok(DaemonEvent::IpDel(_)) => break Err("NETWORK_INTERFACE_CHANGED".to_string()),
                        Ok(DaemonEvent::Error(_)) => {
                            state.update(app, generation, |status| {
                                status.message = Some("Automatic discovery is unavailable. Paste a manual code to continue.".to_string());
                                status.error_code = Some("MDNS_DAEMON_FAILED".to_string());
                            });
                        }
                        Err(_) => {
                            monitor_active = false;
                            state.update(app, generation, |status| {
                                status.message = Some("Automatic discovery is unavailable. Paste a manual code to continue.".to_string());
                                status.error_code = Some("MDNS_DAEMON_FAILED".to_string());
                            });
                        }
                        Ok(_) => {}
                    }
                }
            }
        } else {
            tokio::select! {
                _ = cancel.cancelled() => break Err("CANCELLED".to_string()),
                action = actions.recv() => {
                    let Some(LocalAction::Connect(request)) = action else {
                        if action.is_none() {
                            break Err("CANCELLED".to_string());
                        }
                        continue;
                    };
                    match resolve_connection_request(request, &discovered) {
                        Ok(session) => break Ok(session),
                        Err(error) => {
                            state.clear_pending_action(generation, TransferPhase::Discovering);
                            state.update(app, generation, |status| {
                                let code = normalize_error_code(&error);
                                status.message = Some(public_error_message(&code).to_string());
                                status.error_code = Some(code);
                            });
                        }
                    }
                }
            }
        }
    };
    if let Some(browser) = browser {
        browser.shutdown().await;
    }
    result
}

fn publish_discovered(
    app: &AppHandle,
    state: &SettingsTransferState,
    generation: u64,
    discovered: &BTreeMap<String, ResolvedRendezvous>,
) {
    let mut sessions = discovered
        .values()
        .map(|session| DiscoveredTransferSession {
            id: session.id.clone(),
            label: session.label.clone(),
            protocol_version: PROTOCOL_MAJOR,
            expires_at: session.expires_at,
        })
        .collect::<Vec<_>>();
    sessions.sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
    state.update(app, generation, |status| {
        status.discovered_sessions = sessions;
        status.error_code = None;
        status.message = Some(if status.discovered_sessions.is_empty() {
            "Looking for live Machdoch sharing sessions...".to_string()
        } else {
            "Select the session label shown on the sending PC.".to_string()
        });
    });
}

fn resolve_connection_request(
    request: ConnectSettingsTransferRequest,
    discovered: &BTreeMap<String, ResolvedRendezvous>,
) -> Result<ResolvedRendezvous, String> {
    if let Some(id) = request.discovered_id {
        let session = discovered
            .get(&id)
            .cloned()
            .ok_or_else(|| "DISCOVERED_SESSION_GONE".to_string())?;
        if session.expires_at <= now_millis() {
            return Err("SESSION_EXPIRED".to_string());
        }
        return Ok(session);
    }
    decode_manual_code(request.manual_code.as_deref().unwrap_or_default())
}

async fn connect_endpoints(
    selection: &NetworkSelection,
    endpoints: &[std::net::SocketAddr],
    cancel: &CancellationToken,
) -> Result<TcpStream, String> {
    let mut endpoints = endpoints
        .iter()
        .copied()
        .flat_map(|endpoint| selection.connection_endpoints(endpoint))
        .collect::<Vec<_>>();
    endpoints.sort();
    endpoints.dedup();
    endpoints.truncate(32);
    if endpoints.is_empty() {
        return Err("ENDPOINT_NOT_ON_LOCAL_NETWORK".to_string());
    }
    let mut attempts = JoinSet::new();
    for (index, endpoint) in endpoints.into_iter().enumerate() {
        attempts.spawn(async move {
            sleep(Duration::from_millis(
                (index as u64).saturating_mul(120).min(1_000),
            ))
            .await;
            timeout(CONNECT_TIMEOUT, TcpStream::connect(endpoint))
                .await
                .ok()
                .and_then(Result::ok)
        });
    }
    loop {
        tokio::select! {
            _ = cancel.cancelled() => {
                attempts.abort_all();
                return Err("CANCELLED".to_string());
            }
            result = attempts.join_next() => match result {
                Some(Ok(Some(stream))) => {
                    attempts.abort_all();
                    let peer = stream.peer_addr().map_err(|_| "NETWORK_CONNECT_FAILED".to_string())?;
                    if selection.contains_peer(peer) {
                        return Ok(stream);
                    }
                }
                Some(_) => {}
                None => return Err("NETWORK_CONNECT_FAILED".to_string()),
            }
        }
    }
}

fn update_receiver_review_status(
    status: &mut SettingsTransferStatus,
    sender: &SenderHello,
    review: &TransferReview,
) {
    let offered = sender
        .offered
        .iter()
        .map(|entry| (entry.id, entry))
        .collect::<BTreeMap<_, _>>();
    for category in &mut status.categories {
        if let Some(offer) = offered.get(&category.id) {
            category.availability = offer.availability.clone();
            category.reason.clone_from(&offer.reason);
        } else if category.selected {
            category.availability = CategoryAvailabilityState::Unavailable;
            category.reason = Some("The sender did not offer this category.".to_string());
        }
    }
    apply_review_to_status(status, review);
}

async fn discard_prepared<R: Runtime>(transaction: PreparedTransaction<R>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || discard_prepared_transaction(transaction))
        .await
        .map_err(|_| "PREPARED_TRANSACTION_CLEANUP_PENDING".to_string())?
        .map_err(|_| "PREPARED_TRANSACTION_CLEANUP_PENDING".to_string())
}

async fn receiver_task(
    context: SessionTaskContext,
    mut actions: mpsc::Receiver<LocalAction>,
    wanted: BTreeSet<SettingsCategoryId>,
    display_name: String,
    selection: NetworkSelection,
    mut local_counts: BTreeMap<SettingsCategoryId, u32>,
) -> Result<SessionSuccess, String> {
    let SessionTaskContext {
        app,
        state,
        generation,
        cancel,
    } = context;
    let rendezvous =
        browse_for_rendezvous(&app, &state, generation, &cancel, &mut actions, &selection).await?;
    state.update(&app, generation, |status| {
        status.phase = TransferPhase::Connecting;
        status.session_label = Some(rendezvous.label.clone());
        status.discovered_sessions.clear();
        status.message =
            Some("Connecting and establishing an encrypted Noise channel...".to_string());
        status.error_code = None;
    });
    let stream = connect_endpoints(&selection, &rendezvous.endpoints, &cancel).await?;
    let preface = ConnectionPreface::new(rendezvous.sid)?;
    let mut channel = tokio::select! {
        _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
        result = connect_noise_initiator(stream, &preface) => result?,
    };
    let result = async {
    let sender_hello = match receive_record(&mut channel, &cancel).await? {
        WireMessage::SenderHello(hello) => hello,
        WireMessage::Cancel { code } => return Err(code),
        _ => return Err("UNEXPECTED_HELLO_MESSAGE".to_string()),
    };
    if sender_hello.session_label != rendezvous.label {
        return Err("PAIRING_CONTEXT_MISMATCH".to_string());
    }
    let receiver_hello = receiver_hello(display_name, wanted.clone());
    validate_peer_hello(&sender_hello, &receiver_hello)?;
    send_record(
        &mut channel,
        &cancel,
        WireMessage::ReceiverHello(receiver_hello.clone()),
    )
    .await?;
    let effective = compute_effective(&sender_hello, &receiver_hello);
    let context = create_pairing_context(channel.handshake_hash(), &sender_hello, &receiver_hello)?;
    let pairing_code = tokio::select! {
        _ = cancel.cancelled() => return Err("CANCELLED".to_string()),
        result = perform_sas_initiator(&mut channel, &context) => result?,
    };
    state.update(&app, generation, |status| {
        status.phase = TransferPhase::Pairing;
        status.peer_name = Some(sender_hello.display_name.clone());
        status.peer_categories = sender_hello
            .offered
            .iter()
            .map(|category| category.id)
            .collect();
        status.effective_categories = effective.iter().copied().collect();
        status.pairing_code = Some(pairing_code);
        status.created_at = Some(channel.created_at());
        status.expires_at = Some(channel.expires_at());
        status.message = Some(
            "Compare this code on both PCs. Continue only if every digit matches.".to_string(),
        );
    });
    exchange_confirmation(
        &mut actions,
        &cancel,
        &mut channel,
        ConfirmationKind::Pairing,
        "PAIRING_TIMEOUT",
        |action| matches!(action, LocalAction::ConfirmPairing),
    )
    .await?;
    let manifest = match receive_record(&mut channel, &cancel).await? {
        WireMessage::Manifest(manifest) => manifest,
        WireMessage::Cancel { code } => return Err(code),
        _ => return Err("UNEXPECTED_MANIFEST_MESSAGE".to_string()),
    };
    validate_manifest(&manifest, &effective)?;
    let app_for_preview = app.clone();
    let preview_categories = effective.clone();
    let preview = tauri::async_runtime::spawn_blocking(move || {
        capture_preview_fingerprint(&app_for_preview, &preview_categories)
    })
    .await
    .map_err(|_| "PREVIEW_FAILED".to_string())??;
    for (id, count) in &preview.item_counts {
        local_counts.insert(*id, *count);
    }
    let review = review_for_receiver(&sender_hello, &receiver_hello, &manifest, &local_counts);
    send_record(&mut channel, &cancel, WireMessage::Review(review.clone())).await?;
    state.update(&app, generation, |status| {
        status.phase = TransferPhase::Review;
        status.pairing_code = None;
        status.total_bytes = manifest.total_bytes;
        status.message = Some(if effective.is_empty() {
            "No mutually selected, available categories were found.".to_string()
        } else {
            "Review every replacement, clear, and preserved category before continuing.".to_string()
        });
        update_receiver_review_status(status, &sender_hello, &review);
    });
    if effective.is_empty() {
        match receive_record(&mut channel, &cancel).await? {
            WireMessage::Approval => {}
            WireMessage::Cancel { code } => return Err(code),
            _ => return Err("UNEXPECTED_APPROVAL_MESSAGE".to_string()),
        }
        send_record(&mut channel, &cancel, WireMessage::Approval).await?;
        return Ok(SessionSuccess {
            message: "Nothing was replaced because the effective category set was empty."
                .to_string(),
            completed_locally: true,
        });
    }
    exchange_confirmation(
        &mut actions,
        &cancel,
        &mut channel,
        ConfirmationKind::Approval,
        "APPROVAL_TIMEOUT",
        |action| matches!(action, LocalAction::Approve),
    )
    .await?;
    let (payload_bytes, payload_sha256, category_ranges) =
        match receive_record(&mut channel, &cancel).await? {
        WireMessage::PayloadStart {
            total_bytes,
            sha256,
            category_ranges,
        } if total_bytes > 0
            && total_bytes <= MAX_WIRE_PAYLOAD_BYTES
            && is_sha256_hex(&sha256) => {
            validate_payload_category_ranges(&category_ranges, total_bytes, &manifest)?;
            (total_bytes, sha256, category_ranges)
        }
        WireMessage::Cancel { code } => return Err(code),
        _ => return Err("INVALID_PAYLOAD_START".to_string()),
    };
    let transfer_id = channel.transfer_id()?.to_string();
    let mut stage = IncomingPayloadStage::create(&transfer_id, payload_bytes)?;
    state.update(&app, generation, |status| {
        status.phase = TransferPhase::Transferring;
        status.total_bytes = payload_bytes;
        status.transferred_bytes = 0;
        apply_category_transfer_progress(status, &category_ranges, 0);
        status.message =
            Some("Receiving encrypted category data into private staging...".to_string());
    });
    let mut last_reported_bytes = 0_u64;
    loop {
        match receive_record(&mut channel, &cancel).await? {
            WireMessage::PayloadChunk { offset, mut data } => {
                let decoded = Zeroizing::new(
                    BASE64
                        .decode(data.as_bytes())
                        .map_err(|_| "INVALID_PAYLOAD_CHUNK".to_string())?,
                );
                data.zeroize();
                if decoded.len() > MAX_PAYLOAD_CHUNK_BYTES {
                    return Err("INVALID_PAYLOAD_CHUNK".to_string());
                }
                stage.append(offset, &decoded)?;
                let completed = (offset + decoded.len() as u64).min(payload_bytes);
                if completed == payload_bytes
                    || completed.saturating_sub(last_reported_bytes)
                        >= PROGRESS_EMIT_INTERVAL_BYTES
                {
                    state.update(&app, generation, |status| {
                        status.transferred_bytes = completed;
                        apply_category_transfer_progress(status, &category_ranges, completed);
                    });
                    last_reported_bytes = completed;
                }
            }
            WireMessage::PayloadEnd => break,
            WireMessage::Cancel { code } => return Err(code),
            _ => return Err("UNEXPECTED_PAYLOAD_MESSAGE".to_string()),
        }
    }
    state.update(&app, generation, |status| {
        status.phase = TransferPhase::Validating;
        status.message = Some(
            "Validating category schemas, scope boundaries, paths, counts, and hashes..."
                .to_string(),
        );
    });
    let mut envelope = stage.finish(&payload_sha256)?;
    if let Err(error) = verify_envelope(&envelope, &channel, &manifest) {
        zeroize_envelope(&mut envelope);
        return Err(error);
    }
    let fingerprint = preview.fingerprint.clone();
    let app_for_prepare = app.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_validated_transaction(app_for_prepare, envelope, &fingerprint)
    })
    .await
    .map_err(|_| "TRANSACTION_PREPARE_FAILED".to_string())??;
    if let Err(error) = send_record(&mut channel, &cancel, WireMessage::ReadyToCommit).await {
        discard_prepared(prepared).await?;
        return Err(error);
    }
    match receive_record(&mut channel, &cancel).await {
        Ok(WireMessage::CommitAuthorized) => {}
        Ok(WireMessage::Cancel { code }) => {
            discard_prepared(prepared).await?;
            return Err(code);
        }
        Ok(_) | Err(_) => {
            discard_prepared(prepared).await?;
            return Err("COMMIT_NOT_AUTHORIZED".to_string());
        }
    }
    if !state.enter_commit_critical(&app, generation) {
        discard_prepared(prepared).await?;
        return Err("CANCELLED".to_string());
    }
    let rollback_app = app.clone();
    let rollback_state = state.clone();
    let commit = tauri::async_runtime::spawn_blocking(move || {
        prepared.commit(|| {
            rollback_state.update(&rollback_app, generation, |status| {
                status.phase = TransferPhase::RollingBack;
                status.message = Some(
                    "A write or verification failed. Restoring and verifying every original setting..."
                        .to_string(),
                );
            });
        })
    })
        .await
        .map_err(|_| "COMMIT_FAILED".to_string())??;
    emit_import_reload_events(&app, &effective);
    state.update(&app, generation, |status| {
        status.completed_locally = true;
        status.message = Some(if commit.recovery_cleanup_pending {
            "All selected categories were committed and verified. Private recovery cleanup will finish on the next launch."
                .to_string()
        } else {
            "All selected categories were committed and verified locally.".to_string()
        });
    });
    let acknowledged = channel.send(WireMessage::CommitSucceeded).await.is_ok();
    Ok(SessionSuccess {
        message: if commit.recovery_cleanup_pending {
            "Every selected category was committed and verified. Restart Machdoch to finish cleaning private recovery data."
                .to_string()
        } else if acknowledged {
            "Every selected category was committed, verified, and acknowledged.".to_string()
        } else {
            "Every selected category was committed and verified locally, but the final acknowledgement did not reach the sender. Do not retry unless the sender confirms the settings are absent."
                .to_string()
        },
        completed_locally: true,
    })
    }
    .await;
    if let Err(error) = &result {
        channel.send_cancel(error).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn connected_noise_channels() -> (NoiseChannel, NoiseChannel) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let address = listener.local_addr().expect("listener address");
        let sid = [11_u8; 16];
        let responder = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("peer should connect");
            accept_noise_responder(stream, &sid)
                .await
                .expect("responder handshake")
                .0
        });
        let stream = TcpStream::connect(address)
            .await
            .expect("initiator should connect");
        let preface = ConnectionPreface {
            major: PROTOCOL_MAJOR,
            minor: super::super::contract::PROTOCOL_MINOR,
            sid,
            initiator_nonce: [12_u8; 16],
        };
        let mut initiator = connect_noise_initiator(stream, &preface)
            .await
            .expect("initiator handshake");
        let mut responder = responder.await.expect("responder task should finish");
        let created_at = now_millis();
        let expires_at = created_at + 60_000;
        let transfer_id = "abcdefghijklmnopqrstuvwxyzABCDEFGH".to_string();
        initiator
            .set_sender_session(transfer_id.clone(), created_at, expires_at)
            .expect("initiator session should initialize");
        responder
            .set_sender_session(transfer_id, created_at, expires_at)
            .expect("responder session should initialize");
        (initiator, responder)
    }

    #[tokio::test]
    async fn completion_signal_wakes_every_waiter_and_remembers_completion() {
        let signal = Arc::new(CompletionSignal::default());
        let waiters = (0..8)
            .map(|_| {
                let signal = Arc::clone(&signal);
                tokio::spawn(async move { signal.wait().await })
            })
            .collect::<Vec<_>>();
        tokio::task::yield_now().await;
        signal.complete();

        timeout(Duration::from_secs(2), async {
            for waiter in waiters {
                waiter.await.expect("completion waiter should join");
            }
            signal.wait().await;
        })
        .await
        .expect("completion should wake all current and future waiters");
    }

    #[tokio::test]
    async fn confirmations_can_arrive_before_the_local_user_confirms() {
        let (initiator, responder) = connected_noise_channels().await;
        let initiator_cancel = CancellationToken::new();
        let responder_cancel = CancellationToken::new();
        let (initiator_actions, mut initiator_action_rx) = mpsc::channel(1);
        let (responder_actions, mut responder_action_rx) = mpsc::channel(1);

        let initiator_task = tokio::spawn(async move {
            let mut channel = initiator;
            exchange_confirmation(
                &mut initiator_action_rx,
                &initiator_cancel,
                &mut channel,
                ConfirmationKind::Pairing,
                "PAIRING_TIMEOUT",
                |action| matches!(action, LocalAction::ConfirmPairing),
            )
            .await
        });
        let responder_task = tokio::spawn(async move {
            let mut channel = responder;
            exchange_confirmation(
                &mut responder_action_rx,
                &responder_cancel,
                &mut channel,
                ConfirmationKind::Pairing,
                "PAIRING_TIMEOUT",
                |action| matches!(action, LocalAction::ConfirmPairing),
            )
            .await
        });

        initiator_actions
            .send(LocalAction::ConfirmPairing)
            .await
            .expect("first local confirmation should send");
        tokio::task::yield_now().await;
        assert!(!initiator_task.is_finished());
        assert!(!responder_task.is_finished());
        responder_actions
            .send(LocalAction::ConfirmPairing)
            .await
            .expect("second local confirmation should send");

        timeout(Duration::from_secs(2), async {
            initiator_task
                .await
                .expect("initiator task should join")
                .expect("initiator confirmation should succeed");
            responder_task
                .await
                .expect("responder task should join")
                .expect("responder confirmation should succeed");
        })
        .await
        .expect("confirmation exchange should complete promptly");
    }

    #[tokio::test]
    async fn remote_cancel_interrupts_a_pending_user_confirmation() {
        let (initiator, mut responder) = connected_noise_channels().await;
        let cancel = CancellationToken::new();
        let (_actions, mut action_rx) = mpsc::channel(1);
        let pending = tokio::spawn(async move {
            let mut channel = initiator;
            exchange_confirmation(
                &mut action_rx,
                &cancel,
                &mut channel,
                ConfirmationKind::Approval,
                "APPROVAL_TIMEOUT",
                |action| matches!(action, LocalAction::Approve),
            )
            .await
        });

        responder.send_cancel("REMOTE_CANCELLED").await;
        let error = timeout(Duration::from_secs(2), pending)
            .await
            .expect("remote cancellation should not wait for the user timeout")
            .expect("confirmation task should join")
            .expect_err("remote cancellation should stop confirmation");
        assert_eq!(error, "REMOTE_CANCELLED");
    }

    #[test]
    fn local_confirmation_commands_are_idempotent_per_phase() {
        let state = SettingsTransferState::default();
        let cancel = CancellationToken::new();
        let (actions, mut received) = mpsc::channel(8);
        {
            let mut inner = state.lock();
            inner.generation = 1;
            inner.status.phase = TransferPhase::Pairing;
            inner.active = Some(ActiveSession {
                generation: 1,
                cancel,
                actions,
                done: Arc::new(CompletionSignal::default()),
            });
        }

        confirm_pairing(&state).expect("first pairing confirmation should queue");
        confirm_pairing(&state).expect("duplicate pairing confirmation should be idempotent");
        assert!(matches!(
            received.try_recv(),
            Ok(LocalAction::ConfirmPairing)
        ));
        assert!(matches!(
            received.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));

        state.lock().status.phase = TransferPhase::Review;
        approve(&state).expect("first approval should queue");
        approve(&state).expect("duplicate approval should be idempotent");
        assert!(matches!(received.try_recv(), Ok(LocalAction::Approve)));
        assert!(matches!(
            received.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn failed_connection_actions_can_be_retried() {
        let state = SettingsTransferState::default();
        let cancel = CancellationToken::new();
        let (actions, mut received) = mpsc::channel(8);
        {
            let mut inner = state.lock();
            inner.generation = 1;
            inner.status.phase = TransferPhase::Discovering;
            inner.active = Some(ActiveSession {
                generation: 1,
                cancel,
                actions,
                done: Arc::new(CompletionSignal::default()),
            });
        }

        let request = || ConnectSettingsTransferRequest {
            discovered_id: None,
            manual_code: Some("invalid manual code".to_string()),
        };
        connect(&state, request()).expect("first connection action should queue");
        assert!(matches!(received.try_recv(), Ok(LocalAction::Connect(_))));

        state.clear_pending_action(1, TransferPhase::Discovering);
        connect(&state, request()).expect("corrected connection action should queue");
        assert!(matches!(received.try_recv(), Ok(LocalAction::Connect(_))));
    }

    #[test]
    fn cancelled_sessions_cannot_publish_a_new_active_phase() {
        let state = SettingsTransferState::default();
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (actions, _received) = mpsc::channel(1);
        {
            let mut inner = state.lock();
            inner.generation = 1;
            inner.status.phase = TransferPhase::Cancelled;
            inner.active = Some(ActiveSession {
                generation: 1,
                cancel,
                actions,
                done: Arc::new(CompletionSignal::default()),
            });
        }

        assert!(state
            .mutate_active_status(1, |status| status.phase = TransferPhase::Discovering)
            .is_none());
        assert_eq!(state.status().phase, TransferPhase::Cancelled);
    }

    #[test]
    fn rollback_is_a_non_interruptible_commit_critical_phase() {
        let state = SettingsTransferState::default();
        let (actions, _action_rx) = mpsc::channel(1);
        let done = Arc::new(CompletionSignal::default());
        {
            let mut inner = state.lock();
            inner.generation = 1;
            inner.status.phase = TransferPhase::RollingBack;
            inner.active = Some(ActiveSession {
                generation: 1,
                cancel: CancellationToken::new(),
                actions,
                done,
            });
        }
        assert_eq!(state.activity(), (true, true));
        assert!(state.is_commit_critical());
    }

    #[test]
    fn commit_authorization_transition_respects_a_concurrent_stop() {
        let create_state = |cancelled: bool| {
            let state = SettingsTransferState::default();
            let (actions, _action_rx) = mpsc::channel(1);
            let cancel = CancellationToken::new();
            if cancelled {
                cancel.cancel();
            }
            {
                let mut inner = state.lock();
                inner.generation = 1;
                inner.status.phase = TransferPhase::Validating;
                inner.active = Some(ActiveSession {
                    generation: 1,
                    cancel,
                    actions,
                    done: Arc::new(CompletionSignal::default()),
                });
            }
            state
        };

        let stopped = create_state(true);
        assert!(stopped.transition_to_commit_critical(1).is_none());
        assert_eq!(stopped.status().phase, TransferPhase::Validating);

        let authorized = create_state(false);
        assert!(authorized.transition_to_commit_critical(1).is_some());
        assert_eq!(authorized.status().phase, TransferPhase::Committing);
        assert!(authorized.is_commit_critical());
    }

    fn hello_with(availability: CategoryAvailabilityState) -> SenderHello {
        let (item_count, plaintext_bytes, reason) = match availability {
            CategoryAvailabilityState::Available => (1, 42, None),
            CategoryAvailabilityState::Empty => (0, 2, None),
            CategoryAvailabilityState::Unavailable => {
                (0, 0, Some("The category is unavailable.".to_string()))
            }
            CategoryAvailabilityState::Unsupported => (0, 0, None),
        };
        SenderHello {
            display_name: "Sender".to_string(),
            session_label: "Machdoch Transfer TEST".to_string(),
            offered: vec![OfferedCategory {
                id: SettingsCategoryId::GlobalMemory,
                schema_version: CATEGORY_SCHEMA_VERSION,
                availability,
                item_count,
                plaintext_bytes,
                reason,
            }],
        }
    }

    #[test]
    fn effective_set_requires_offer_availability_want_and_schema_support() {
        let wanted = BTreeSet::from([SettingsCategoryId::GlobalMemory]);
        let receiver = receiver_hello("Receiver".to_string(), wanted);
        assert_eq!(
            compute_effective(&hello_with(CategoryAvailabilityState::Available), &receiver),
            BTreeSet::from([SettingsCategoryId::GlobalMemory])
        );
        assert!(compute_effective(
            &hello_with(CategoryAvailabilityState::Unavailable),
            &receiver
        )
        .is_empty());
        let receiver = receiver_hello("Receiver".to_string(), BTreeSet::new());
        assert!(
            compute_effective(&hello_with(CategoryAvailabilityState::Available), &receiver)
                .is_empty()
        );
    }

    #[test]
    fn review_distinguishes_clear_from_unavailable_preservation() {
        let receiver = receiver_hello(
            "Receiver".to_string(),
            BTreeSet::from([SettingsCategoryId::GlobalMemory]),
        );
        let sender = hello_with(CategoryAvailabilityState::Empty);
        let manifest = TransferManifest {
            effective: BTreeSet::from([SettingsCategoryId::GlobalMemory]),
            effective_hash: effective_hash(&BTreeSet::from([SettingsCategoryId::GlobalMemory]))
                .unwrap(),
            entries: vec![ManifestEntry {
                id: SettingsCategoryId::GlobalMemory,
                schema_version: CATEGORY_SCHEMA_VERSION,
                replacement: "empty".to_string(),
                item_count: 0,
                plaintext_bytes: 2,
                sha256: "0".repeat(64),
            }],
            total_bytes: 2,
        };
        let review = review_for_receiver(&sender, &receiver, &manifest, &BTreeMap::new());
        assert_eq!(
            review
                .categories
                .iter()
                .find(|category| category.id == SettingsCategoryId::GlobalMemory)
                .unwrap()
                .effect,
            CategoryEffect::Clear
        );

        let sender = hello_with(CategoryAvailabilityState::Unavailable);
        let empty_manifest = TransferManifest {
            effective: BTreeSet::new(),
            effective_hash: effective_hash(&BTreeSet::new()).unwrap(),
            entries: Vec::new(),
            total_bytes: 0,
        };
        let review = review_for_receiver(&sender, &receiver, &empty_manifest, &BTreeMap::new());
        assert_eq!(
            review
                .categories
                .iter()
                .find(|category| category.id == SettingsCategoryId::GlobalMemory)
                .unwrap()
                .effect,
            CategoryEffect::PreserveUnavailable
        );
    }

    #[test]
    fn receiver_cannot_hide_an_effective_replacement_in_its_review() {
        let sender = hello_with(CategoryAvailabilityState::Available);
        let receiver = receiver_hello(
            "Receiver".to_string(),
            BTreeSet::from([SettingsCategoryId::GlobalMemory]),
        );
        let effective = BTreeSet::from([SettingsCategoryId::GlobalMemory]);
        let manifest = TransferManifest {
            effective: effective.clone(),
            effective_hash: effective_hash(&effective).expect("effective set should hash"),
            entries: vec![ManifestEntry {
                id: SettingsCategoryId::GlobalMemory,
                schema_version: CATEGORY_SCHEMA_VERSION,
                replacement: "value".to_string(),
                item_count: 1,
                plaintext_bytes: 42,
                sha256: "0".repeat(64),
            }],
            total_bytes: 42,
        };
        let mut review = review_for_receiver(&sender, &receiver, &manifest, &BTreeMap::new());
        review
            .categories
            .iter_mut()
            .find(|category| category.id == SettingsCategoryId::GlobalMemory)
            .expect("memory review should exist")
            .effect = CategoryEffect::PreserveNotSelected;

        assert_eq!(
            validate_review(&review, &sender, &receiver, &manifest),
            Err("PAIRING_CONTEXT_MISMATCH".to_string())
        );
    }

    #[test]
    fn display_names_are_control_free_and_bounded_by_utf8_bytes() {
        let sanitized = sanitize_display_name(&format!("  PC\n\u{202e}{}  ", "é".repeat(64)));
        assert!(!sanitized.chars().any(is_unsafe_display_character));
        assert!(sanitized.len() <= MAX_DISPLAY_NAME_BYTES);
        assert!(sanitized.is_char_boundary(sanitized.len()));
        assert!(is_valid_display_text(&sanitized, MAX_DISPLAY_NAME_BYTES));
        assert!(!is_valid_display_text(
            "Trusted PC\u{202e}",
            MAX_DISPLAY_NAME_BYTES
        ));
    }

    #[test]
    fn manifest_rejects_a_combined_item_count_over_the_global_limit() {
        let effective = BTreeSet::from([SettingsCategoryId::GlobalMemory]);
        let snapshot = CategorySnapshot {
            id: SettingsCategoryId::GlobalMemory,
            schema_version: CATEGORY_SCHEMA_VERSION,
            replacement: "value".to_string(),
            item_count: u32::try_from(MAX_TOTAL_ITEMS + 1).expect("test count should fit"),
            plaintext_bytes: 2,
            sha256: "0".repeat(64),
            data: super::super::contract::CategorySnapshotData::Json(serde_json::json!({})),
        };
        assert_eq!(
            create_manifest(&effective, &[snapshot]),
            Err("INVALID_MANIFEST".to_string())
        );
    }

    #[test]
    fn payload_category_ranges_are_ordered_bounded_and_drive_progress() {
        let categories = vec![
            CategorySnapshot {
                id: SettingsCategoryId::ApiKeys,
                schema_version: CATEGORY_SCHEMA_VERSION,
                replacement: "value".to_string(),
                item_count: 1,
                plaintext_bytes: 10,
                sha256: "1".repeat(64),
                data: super::super::contract::CategorySnapshotData::Json(
                    serde_json::json!({ "apiKeys": { "openai": "secret" } }),
                ),
            },
            CategorySnapshot {
                id: SettingsCategoryId::GlobalMemory,
                schema_version: CATEGORY_SCHEMA_VERSION,
                replacement: "empty".to_string(),
                item_count: 0,
                plaintext_bytes: 2,
                sha256: "2".repeat(64),
                data: super::super::contract::CategorySnapshotData::Json(
                    serde_json::json!({ "entries": [] }),
                ),
            },
        ];
        let effective = BTreeSet::from([
            SettingsCategoryId::ApiKeys,
            SettingsCategoryId::GlobalMemory,
        ]);
        let manifest = create_manifest(&effective, &categories).expect("manifest should build");
        let payload = serde_json::to_vec(&TransferEnvelope {
            protocol_version: PROTOCOL_MAJOR,
            transfer_id: "abcdefghijklmnopqrstuvwxyzABCDEFGH".to_string(),
            created_at: 1,
            expires_at: 2,
            categories: categories.clone(),
        })
        .expect("payload should serialize");
        let ranges = locate_payload_category_ranges(&payload, &categories)
            .expect("category ranges should be located");
        validate_payload_category_ranges(&ranges, payload.len() as u64, &manifest)
            .expect("category ranges should validate");
        assert_eq!(ranges.len(), 2);
        assert!(ranges[0].end <= ranges[1].start);

        let mut status = SettingsTransferStatus::default();
        let first_half = ranges[0].start + (ranges[0].end - ranges[0].start) / 2;
        apply_category_transfer_progress(&mut status, &ranges, first_half);
        let api_keys = status
            .categories
            .iter()
            .find(|category| category.id == SettingsCategoryId::ApiKeys)
            .expect("API key progress should exist");
        let memory = status
            .categories
            .iter()
            .find(|category| category.id == SettingsCategoryId::GlobalMemory)
            .expect("memory progress should exist");
        assert!(api_keys.transferred_bytes > 0);
        assert!(api_keys.transferred_bytes < api_keys.transfer_total_bytes);
        assert_eq!(memory.transferred_bytes, 0);

        let mut overlapping = ranges.clone();
        overlapping[1].start = overlapping[0].end.saturating_sub(1);
        assert!(
            validate_payload_category_ranges(&overlapping, payload.len() as u64, &manifest)
                .is_err()
        );
    }
}
