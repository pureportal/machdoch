use std::{io, time::Duration};

use base64::{
    engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD},
    Engine as _,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use snow::{params::NoiseParams, TransportState};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpStream,
    time::{timeout, Instant},
};
use zeroize::Zeroizing;

use super::contract::{
    PayloadCategoryRange, ReceiverHello, SenderHello, TransferManifest, TransferReview,
    PROTOCOL_MAJOR, PROTOCOL_MINOR,
};

const PREFACE_MAGIC: &[u8; 13] = b"MACHDOCH-XFER";
const PREFACE_LENGTH: usize = 50;
const NOISE_SUITE_ID: u8 = 1;
const NOISE_PATTERN: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
const MAX_FRAME_BYTES: usize = 65_535;
const MAX_RECORD_PLAINTEXT_BYTES: usize = 48 * 1024;
pub(crate) const MAX_PAYLOAD_CHUNK_BYTES: usize = 32 * 1024;
const PREFACE_TIMEOUT: Duration = Duration::from_secs(3);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
// Human confirmation is bounded at 60 seconds. A peer that confirms first must
// remain connected long enough for the other person to use that full window.
const RECORD_IDLE_TIMEOUT: Duration = Duration::from_secs(75);
const MAX_CONNECTED_SESSION_LIFETIME: Duration = Duration::from_secs(5 * 60);
const CLOCK_SKEW_MILLIS: u64 = 5 * 60 * 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ConnectionPreface {
    pub(crate) major: u16,
    pub(crate) minor: u16,
    pub(crate) sid: [u8; 16],
    pub(crate) initiator_nonce: [u8; 16],
}

impl ConnectionPreface {
    pub(crate) fn new(sid: [u8; 16]) -> Result<Self, String> {
        Ok(Self {
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR,
            sid,
            initiator_nonce: random_array()?,
        })
    }

    fn encode(&self) -> [u8; PREFACE_LENGTH] {
        let mut bytes = [0_u8; PREFACE_LENGTH];
        bytes[..PREFACE_MAGIC.len()].copy_from_slice(PREFACE_MAGIC);
        bytes[13..15].copy_from_slice(&self.major.to_be_bytes());
        bytes[15..17].copy_from_slice(&self.minor.to_be_bytes());
        bytes[17..33].copy_from_slice(&self.sid);
        bytes[33..49].copy_from_slice(&self.initiator_nonce);
        bytes[49] = NOISE_SUITE_ID;
        bytes
    }

    fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != PREFACE_LENGTH
            || &bytes[..PREFACE_MAGIC.len()] != PREFACE_MAGIC
            || bytes[49] != NOISE_SUITE_ID
        {
            return Err("INVALID_PREFACE".to_string());
        }
        let major = u16::from_be_bytes([bytes[13], bytes[14]]);
        let minor = u16::from_be_bytes([bytes[15], bytes[16]]);
        let mut sid = [0_u8; 16];
        sid.copy_from_slice(&bytes[17..33]);
        let mut initiator_nonce = [0_u8; 16];
        initiator_nonce.copy_from_slice(&bytes[33..49]);
        Ok(Self {
            major,
            minor,
            sid,
            initiator_nonce,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    content = "body",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum WireMessage {
    SenderHello(SenderHello),
    ReceiverHello(ReceiverHello),
    SasCommit {
        role: String,
        commitment: String,
    },
    SasReveal {
        role: String,
        nonce: String,
    },
    PairingConfirmed,
    Manifest(TransferManifest),
    Review(TransferReview),
    Approval,
    PayloadStart {
        total_bytes: u64,
        sha256: String,
        category_ranges: Vec<PayloadCategoryRange>,
    },
    PayloadChunk {
        offset: u64,
        data: String,
    },
    PayloadEnd,
    ReadyToCommit,
    CommitAuthorized,
    CommitSucceeded,
    Cancel {
        code: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRecord {
    protocol_major: u16,
    protocol_minor: u16,
    transfer_id: String,
    sequence: u64,
    created_at: u64,
    expires_at: u64,
    message: WireMessage,
}

fn is_supported_protocol_version(major: u16, minor: u16) -> bool {
    major == PROTOCOL_MAJOR && minor == PROTOCOL_MINOR
}

pub(crate) struct NoiseChannel {
    stream: TcpStream,
    transport: TransportState,
    // Transport records are read from select branches that may be cancelled
    // when the local user confirms or stops a transfer. Keep partially read
    // frame bytes on the channel so cancelling a read cannot desynchronize the
    // TCP byte stream from the Noise nonce sequence.
    receive_buffer: Vec<u8>,
    transfer_id: Option<String>,
    send_sequence: u64,
    receive_sequence: u64,
    created_at: u64,
    expires_at: u64,
    session_deadline: Option<Instant>,
    handshake_hash: [u8; 32],
}

impl NoiseChannel {
    fn new(stream: TcpStream, transport: TransportState, handshake_hash: [u8; 32]) -> Self {
        Self {
            stream,
            transport,
            receive_buffer: Vec::new(),
            transfer_id: None,
            send_sequence: 0,
            receive_sequence: 0,
            created_at: 0,
            expires_at: 0,
            session_deadline: None,
            handshake_hash,
        }
    }

    fn set_session_window(
        &mut self,
        transfer_id: String,
        created_at: u64,
        expires_at: u64,
    ) -> Result<(), String> {
        let lifetime_millis = expires_at
            .checked_sub(created_at)
            .ok_or_else(|| "INVALID_TRANSFER_SESSION".to_string())?;
        if !is_valid_transfer_id(&transfer_id)
            || lifetime_millis == 0
            || lifetime_millis > MAX_CONNECTED_SESSION_LIFETIME.as_millis() as u64
        {
            return Err("INVALID_TRANSFER_SESSION".to_string());
        }
        let now = now_millis();
        if created_at > now.saturating_add(CLOCK_SKEW_MILLIS)
            || now > expires_at.saturating_add(CLOCK_SKEW_MILLIS)
        {
            return Err("TRANSFER_EXPIRED".to_string());
        }
        let remaining_millis = if expires_at > now {
            expires_at - now
        } else {
            CLOCK_SKEW_MILLIS.saturating_sub(now - expires_at)
        }
        .min(lifetime_millis);
        if remaining_millis == 0 {
            return Err("TRANSFER_EXPIRED".to_string());
        }
        self.transfer_id = Some(transfer_id);
        self.created_at = created_at;
        self.expires_at = expires_at;
        self.session_deadline = Some(Instant::now() + Duration::from_millis(remaining_millis));
        Ok(())
    }

    fn ensure_session_active(&self) -> Result<(), String> {
        if self
            .session_deadline
            .is_some_and(|deadline| Instant::now() >= deadline)
        {
            return Err("TRANSFER_EXPIRED".to_string());
        }
        Ok(())
    }

    pub(crate) fn set_sender_session(
        &mut self,
        transfer_id: String,
        created_at: u64,
        expires_at: u64,
    ) -> Result<(), String> {
        self.set_session_window(transfer_id, created_at, expires_at)
    }

    pub(crate) fn transfer_id(&self) -> Result<&str, String> {
        self.transfer_id
            .as_deref()
            .ok_or_else(|| "TRANSFER_SESSION_NOT_ESTABLISHED".to_string())
    }

    pub(crate) fn created_at(&self) -> u64 {
        self.created_at
    }

    pub(crate) fn expires_at(&self) -> u64 {
        self.expires_at
    }

    pub(crate) fn handshake_hash(&self) -> &[u8; 32] {
        &self.handshake_hash
    }

    pub(crate) async fn send(&mut self, message: WireMessage) -> Result<(), String> {
        self.ensure_session_active()?;
        let transfer_id = self
            .transfer_id
            .clone()
            .ok_or_else(|| "TRANSFER_SESSION_NOT_ESTABLISHED".to_string())?;
        let record = WireRecord {
            protocol_major: PROTOCOL_MAJOR,
            protocol_minor: PROTOCOL_MINOR,
            transfer_id,
            sequence: self.send_sequence,
            created_at: self.created_at,
            expires_at: self.expires_at,
            message,
        };
        let plaintext = Zeroizing::new(
            serde_json::to_vec(&record).map_err(|_| "RECORD_SERIALIZATION_FAILED".to_string())?,
        );
        if plaintext.len() > MAX_RECORD_PLAINTEXT_BYTES {
            return Err("RECORD_TOO_LARGE".to_string());
        }
        let mut ciphertext = vec![0_u8; plaintext.len() + 16];
        let length = self
            .transport
            .write_message(&plaintext, &mut ciphertext)
            .map_err(|_| "RECORD_ENCRYPTION_FAILED".to_string())?;
        ciphertext.truncate(length);
        write_frame(&mut self.stream, &ciphertext, RECORD_IDLE_TIMEOUT).await?;
        self.send_sequence = self
            .send_sequence
            .checked_add(1)
            .ok_or_else(|| "SEQUENCE_EXHAUSTED".to_string())?;
        Ok(())
    }

    pub(crate) async fn receive(&mut self) -> Result<WireMessage, String> {
        self.receive_with_idle_timeout(RECORD_IDLE_TIMEOUT).await
    }

    pub(crate) async fn receive_with_idle_timeout(
        &mut self,
        idle_timeout: Duration,
    ) -> Result<WireMessage, String> {
        self.ensure_session_active()?;
        let read_timeout = self
            .session_deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
            .unwrap_or(idle_timeout)
            .min(idle_timeout);
        if read_timeout.is_zero() {
            return Err("TRANSFER_EXPIRED".to_string());
        }
        let ciphertext = match read_transport_frame(
            &self.stream,
            &mut self.receive_buffer,
            read_timeout,
        )
        .await
        {
            Err(_) if self.ensure_session_active().is_err() => {
                return Err("TRANSFER_EXPIRED".to_string())
            }
            result => result?,
        };
        let mut plaintext = Zeroizing::new(vec![0_u8; ciphertext.len()]);
        let length = self
            .transport
            .read_message(&ciphertext, &mut plaintext)
            .map_err(|_| "RECORD_AUTHENTICATION_FAILED".to_string())?;
        plaintext.truncate(length);
        if plaintext.len() > MAX_RECORD_PLAINTEXT_BYTES {
            return Err("RECORD_TOO_LARGE".to_string());
        }
        let record = serde_json::from_slice::<WireRecord>(&plaintext)
            .map_err(|_| "INVALID_RECORD".to_string())?;
        if !is_supported_protocol_version(record.protocol_major, record.protocol_minor) {
            return Err("PROTOCOL_MISMATCH".to_string());
        }
        if record.sequence != self.receive_sequence {
            return Err("INVALID_SEQUENCE".to_string());
        }
        if let Some(expected) = &self.transfer_id {
            if !constant_time_eq(expected.as_bytes(), record.transfer_id.as_bytes()) {
                return Err("TRANSFER_ID_MISMATCH".to_string());
            }
            if record.created_at != self.created_at || record.expires_at != self.expires_at {
                return Err("TRANSFER_WINDOW_MISMATCH".to_string());
            }
        } else {
            self.set_session_window(
                record.transfer_id.clone(),
                record.created_at,
                record.expires_at,
            )?;
        }
        let now = now_millis();
        if record.created_at > now.saturating_add(CLOCK_SKEW_MILLIS)
            || now > record.expires_at.saturating_add(CLOCK_SKEW_MILLIS)
        {
            return Err("TRANSFER_EXPIRED".to_string());
        }
        self.ensure_session_active()?;
        self.receive_sequence = self
            .receive_sequence
            .checked_add(1)
            .ok_or_else(|| "SEQUENCE_EXHAUSTED".to_string())?;
        Ok(record.message)
    }

    pub(crate) async fn send_cancel(&mut self, code: &str) {
        let _ = self
            .send(WireMessage::Cancel {
                code: sanitize_cancel_code(code),
            })
            .await;
    }
}

fn sanitize_cancel_code(value: &str) -> String {
    let candidate = value.split(':').next().unwrap_or_default();
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

fn is_valid_transfer_id(value: &str) -> bool {
    (32..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

pub(crate) fn now_millis() -> u64 {
    u64::try_from(chrono::Utc::now().timestamp_millis()).unwrap_or_default()
}

pub(crate) fn random_array<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes).map_err(|_| "SECURE_RANDOM_UNAVAILABLE".to_string())?;
    Ok(bytes)
}

pub(crate) fn create_random_id(bytes: usize) -> Result<String, String> {
    let mut value = vec![0_u8; bytes];
    getrandom::fill(&mut value).map_err(|_| "SECURE_RANDOM_UNAVAILABLE".to_string())?;
    Ok(URL_SAFE_NO_PAD.encode(value))
}

pub(crate) fn encode_sid(sid: &[u8; 16]) -> String {
    URL_SAFE_NO_PAD.encode(sid)
}

pub(crate) fn decode_sid(value: &str) -> Result<[u8; 16], String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "INVALID_SESSION_ID".to_string())?;
    decoded
        .try_into()
        .map_err(|_| "INVALID_SESSION_ID".to_string())
}

async fn write_frame(
    stream: &mut TcpStream,
    frame: &[u8],
    deadline: Duration,
) -> Result<(), String> {
    if frame.is_empty() || frame.len() > MAX_FRAME_BYTES {
        return Err("INVALID_FRAME_LENGTH".to_string());
    }
    let length = u16::try_from(frame.len()).map_err(|_| "INVALID_FRAME_LENGTH".to_string())?;
    timeout(deadline, async {
        stream.write_all(&length.to_be_bytes()).await?;
        stream.write_all(frame).await?;
        stream.flush().await
    })
    .await
    .map_err(|_| "NETWORK_TIMEOUT".to_string())?
    .map_err(map_network_error)
}

async fn read_frame(stream: &mut TcpStream, deadline: Duration) -> Result<Vec<u8>, String> {
    timeout(deadline, async {
        let mut length = [0_u8; 2];
        stream.read_exact(&mut length).await?;
        let length = usize::from(u16::from_be_bytes(length));
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid frame"));
        }
        let mut frame = vec![0_u8; length];
        stream.read_exact(&mut frame).await?;
        Ok(frame)
    })
    .await
    .map_err(|_| "NETWORK_TIMEOUT".to_string())?
    .map_err(map_network_error)
}

async fn read_transport_frame(
    stream: &TcpStream,
    buffer: &mut Vec<u8>,
    deadline: Duration,
) -> Result<Vec<u8>, String> {
    timeout(deadline, async {
        loop {
            let target_length = if buffer.len() < 2 {
                2
            } else {
                let frame_length = usize::from(u16::from_be_bytes([buffer[0], buffer[1]]));
                if frame_length == 0 || frame_length > MAX_FRAME_BYTES {
                    return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid frame"));
                }
                frame_length + 2
            };

            if buffer.len() == target_length {
                let frame = buffer.split_off(2);
                buffer.clear();
                return Ok(frame);
            }

            stream.readable().await?;
            let previous_length = buffer.len();
            buffer.resize(target_length, 0);
            match stream.try_read(&mut buffer[previous_length..]) {
                Ok(0) => {
                    buffer.truncate(previous_length);
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "peer closed the stream",
                    ));
                }
                Ok(read) => buffer.truncate(previous_length + read),
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    buffer.truncate(previous_length);
                }
                Err(error) => {
                    buffer.truncate(previous_length);
                    return Err(error);
                }
            }
        }
    })
    .await
    .map_err(|_| "NETWORK_TIMEOUT".to_string())?
    .map_err(map_network_error)
}

fn map_network_error(error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::UnexpectedEof
        | io::ErrorKind::ConnectionAborted
        | io::ErrorKind::ConnectionReset
        | io::ErrorKind::BrokenPipe => "PEER_DISCONNECTED".to_string(),
        io::ErrorKind::InvalidData => "INVALID_FRAME".to_string(),
        _ => "NETWORK_IO_FAILED".to_string(),
    }
}

fn noise_params() -> Result<NoiseParams, String> {
    NOISE_PATTERN
        .parse()
        .map_err(|_| "NOISE_CONFIGURATION_FAILED".to_string())
}

fn build_noise_state(prologue: &[u8], initiator: bool) -> Result<snow::HandshakeState, String> {
    let params = noise_params()?;
    let keypair = snow::Builder::new(params.clone())
        .generate_keypair()
        .map_err(|_| "NOISE_KEY_GENERATION_FAILED".to_string())?;
    let private = Zeroizing::new(keypair.private);
    let builder = snow::Builder::new(params)
        .prologue(prologue)
        .map_err(|_| "NOISE_HANDSHAKE_SETUP_FAILED".to_string())?
        .local_private_key(private.as_slice())
        .map_err(|_| "NOISE_HANDSHAKE_SETUP_FAILED".to_string())?;
    if initiator {
        builder.build_initiator()
    } else {
        builder.build_responder()
    }
    .map_err(|_| "NOISE_HANDSHAKE_SETUP_FAILED".to_string())
}

async fn write_handshake_message(
    stream: &mut TcpStream,
    state: &mut snow::HandshakeState,
) -> Result<(), String> {
    let mut message = vec![0_u8; MAX_FRAME_BYTES];
    let length = state
        .write_message(&[], &mut message)
        .map_err(|_| "NOISE_HANDSHAKE_FAILED".to_string())?;
    message.truncate(length);
    write_frame(stream, &message, HANDSHAKE_TIMEOUT).await
}

async fn read_handshake_message(
    stream: &mut TcpStream,
    state: &mut snow::HandshakeState,
) -> Result<(), String> {
    let message = read_frame(stream, HANDSHAKE_TIMEOUT).await?;
    let mut payload = vec![0_u8; MAX_FRAME_BYTES];
    let length = state
        .read_message(&message, &mut payload)
        .map_err(|_| "NOISE_HANDSHAKE_FAILED".to_string())?;
    if length != 0 {
        return Err("UNEXPECTED_HANDSHAKE_PAYLOAD".to_string());
    }
    Ok(())
}

fn finish_handshake(
    stream: TcpStream,
    state: snow::HandshakeState,
) -> Result<NoiseChannel, String> {
    if !state.is_handshake_finished() || state.get_handshake_hash().len() != 32 {
        return Err("NOISE_HANDSHAKE_INCOMPLETE".to_string());
    }
    let mut handshake_hash = [0_u8; 32];
    handshake_hash.copy_from_slice(state.get_handshake_hash());
    let transport = state
        .into_transport_mode()
        .map_err(|_| "NOISE_TRANSPORT_SETUP_FAILED".to_string())?;
    Ok(NoiseChannel::new(stream, transport, handshake_hash))
}

pub(crate) async fn connect_noise_initiator(
    mut stream: TcpStream,
    preface: &ConnectionPreface,
) -> Result<NoiseChannel, String> {
    stream
        .set_nodelay(true)
        .map_err(|_| "NETWORK_SETUP_FAILED".to_string())?;
    let preface_bytes = preface.encode();
    write_frame(&mut stream, &preface_bytes, HANDSHAKE_TIMEOUT).await?;
    let mut state = build_noise_state(&preface_bytes, true)?;
    write_handshake_message(&mut stream, &mut state).await?;
    read_handshake_message(&mut stream, &mut state).await?;
    write_handshake_message(&mut stream, &mut state).await?;
    finish_handshake(stream, state)
}

pub(crate) async fn accept_noise_responder(
    mut stream: TcpStream,
    expected_sid: &[u8; 16],
) -> Result<(NoiseChannel, ConnectionPreface), String> {
    stream
        .set_nodelay(true)
        .map_err(|_| "NETWORK_SETUP_FAILED".to_string())?;
    let preface_bytes = read_frame(&mut stream, PREFACE_TIMEOUT).await?;
    let preface = ConnectionPreface::decode(&preface_bytes)?;
    if !is_supported_protocol_version(preface.major, preface.minor) {
        return Err("PROTOCOL_MISMATCH".to_string());
    }
    if !constant_time_eq(&preface.sid, expected_sid) {
        return Err("SESSION_ID_MISMATCH".to_string());
    }
    let mut state = build_noise_state(&preface_bytes, false)?;
    read_handshake_message(&mut stream, &mut state).await?;
    write_handshake_message(&mut stream, &mut state).await?;
    read_handshake_message(&mut stream, &mut state).await?;
    Ok((finish_handshake(stream, state)?, preface))
}

pub(crate) fn create_pairing_context(
    handshake_hash: &[u8; 32],
    sender: &SenderHello,
    receiver: &ReceiverHello,
) -> Result<[u8; 32], String> {
    let sender = serde_json::to_vec(sender).map_err(|_| "PAIRING_CONTEXT_FAILED".to_string())?;
    let receiver =
        serde_json::to_vec(receiver).map_err(|_| "PAIRING_CONTEXT_FAILED".to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-pairing-context-v1");
    hasher.update(handshake_hash);
    hasher.update((sender.len() as u64).to_be_bytes());
    hasher.update(sender);
    hasher.update((receiver.len() as u64).to_be_bytes());
    hasher.update(receiver);
    Ok(hasher.finalize().into())
}

fn sas_commitment(role: &str, context: &[u8; 32], nonce: &[u8; 16]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"machdoch-sas-commit-v1");
    hasher.update(role.as_bytes());
    hasher.update(context);
    hasher.update(nonce);
    hasher.finalize().into()
}

fn derive_sas(
    context: &[u8; 32],
    initiator_nonce: &[u8; 16],
    responder_nonce: &[u8; 16],
) -> String {
    let mut seed = {
        let mut hasher = Sha256::new();
        hasher.update(b"machdoch-sas-v1");
        hasher.update(context);
        hasher.update(initiator_nonce);
        hasher.update(responder_nonce);
        <[u8; 32]>::from(hasher.finalize())
    };
    let rejection_threshold = (u64::from(u32::MAX) + 1) % 1_000_000;
    let mut counter = 0_u32;
    loop {
        for chunk in seed.chunks_exact(4) {
            let candidate = u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
            if u64::from(candidate) >= rejection_threshold {
                return format!("{:06}", candidate % 1_000_000);
            }
        }
        counter = counter.wrapping_add(1);
        let mut hasher = Sha256::new();
        hasher.update(b"machdoch-sas-retry-v1");
        hasher.update(seed);
        hasher.update(counter.to_be_bytes());
        seed = hasher.finalize().into();
    }
}

fn decode_fixed<const N: usize>(value: &str, error: &str) -> Result<[u8; N], String> {
    let bytes = BASE64.decode(value).map_err(|_| error.to_string())?;
    bytes.try_into().map_err(|_| error.to_string())
}

pub(crate) async fn perform_sas_initiator(
    channel: &mut NoiseChannel,
    context: &[u8; 32],
) -> Result<String, String> {
    let local_nonce: [u8; 16] = random_array()?;
    let commitment = sas_commitment("receiver", context, &local_nonce);
    channel
        .send(WireMessage::SasCommit {
            role: "receiver".to_string(),
            commitment: BASE64.encode(commitment),
        })
        .await?;
    let remote_commitment = match channel.receive().await? {
        WireMessage::SasCommit { role, commitment } if role == "sender" => {
            decode_fixed::<32>(&commitment, "INVALID_SAS_COMMITMENT")?
        }
        WireMessage::Cancel { code } => return Err(code),
        _ => return Err("UNEXPECTED_SAS_MESSAGE".to_string()),
    };
    channel
        .send(WireMessage::SasReveal {
            role: "receiver".to_string(),
            nonce: BASE64.encode(local_nonce),
        })
        .await?;
    let remote_nonce = match channel.receive().await? {
        WireMessage::SasReveal { role, nonce } if role == "sender" => {
            decode_fixed::<16>(&nonce, "INVALID_SAS_REVEAL")?
        }
        WireMessage::Cancel { code } => return Err(code),
        _ => return Err("UNEXPECTED_SAS_MESSAGE".to_string()),
    };
    if !constant_time_eq(
        &sas_commitment("sender", context, &remote_nonce),
        &remote_commitment,
    ) {
        return Err("SAS_COMMITMENT_MISMATCH".to_string());
    }
    Ok(derive_sas(context, &local_nonce, &remote_nonce))
}

pub(crate) async fn perform_sas_responder(
    channel: &mut NoiseChannel,
    context: &[u8; 32],
) -> Result<String, String> {
    let remote_commitment = match channel.receive().await? {
        WireMessage::SasCommit { role, commitment } if role == "receiver" => {
            decode_fixed::<32>(&commitment, "INVALID_SAS_COMMITMENT")?
        }
        WireMessage::Cancel { code } => return Err(code),
        _ => return Err("UNEXPECTED_SAS_MESSAGE".to_string()),
    };
    let local_nonce: [u8; 16] = random_array()?;
    let commitment = sas_commitment("sender", context, &local_nonce);
    channel
        .send(WireMessage::SasCommit {
            role: "sender".to_string(),
            commitment: BASE64.encode(commitment),
        })
        .await?;
    let remote_nonce = match channel.receive().await? {
        WireMessage::SasReveal { role, nonce } if role == "receiver" => {
            decode_fixed::<16>(&nonce, "INVALID_SAS_REVEAL")?
        }
        WireMessage::Cancel { code } => return Err(code),
        _ => return Err("UNEXPECTED_SAS_MESSAGE".to_string()),
    };
    if !constant_time_eq(
        &sas_commitment("receiver", context, &remote_nonce),
        &remote_commitment,
    ) {
        return Err("SAS_COMMITMENT_MISMATCH".to_string());
    }
    channel
        .send(WireMessage::SasReveal {
            role: "sender".to_string(),
            nonce: BASE64.encode(local_nonce),
        })
        .await?;
    Ok(derive_sas(context, &remote_nonce, &local_nonce))
}

pub(crate) fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn preface_round_trip_binds_version_sid_and_nonce() {
        let preface = ConnectionPreface {
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR,
            sid: [7; 16],
            initiator_nonce: [9; 16],
        };
        assert_eq!(
            ConnectionPreface::decode(&preface.encode()).expect("preface should decode"),
            preface
        );
    }

    #[test]
    fn catalog_changing_protocol_minors_fail_before_noise() {
        assert!(is_supported_protocol_version(
            PROTOCOL_MAJOR,
            PROTOCOL_MINOR
        ));
        assert!(!is_supported_protocol_version(
            PROTOCOL_MAJOR,
            PROTOCOL_MINOR.saturating_sub(1)
        ));
        assert!(!is_supported_protocol_version(
            PROTOCOL_MAJOR.saturating_add(1),
            PROTOCOL_MINOR
        ));
    }

    #[test]
    fn sas_is_six_digits_and_role_order_sensitive() {
        let context = [3_u8; 32];
        let initiator = [4_u8; 16];
        let responder = [5_u8; 16];
        let sas = derive_sas(&context, &initiator, &responder);
        assert_eq!(sas.len(), 6);
        assert!(sas.bytes().all(|byte| byte.is_ascii_digit()));
        assert_ne!(sas, derive_sas(&context, &responder, &initiator));
    }

    #[test]
    fn record_idle_window_covers_the_full_human_decision_window() {
        assert!(RECORD_IDLE_TIMEOUT > Duration::from_secs(60));
        assert!(RECORD_IDLE_TIMEOUT < MAX_CONNECTED_SESSION_LIFETIME);
    }

    #[test]
    fn cancel_records_expose_only_one_bounded_machine_code() {
        assert_eq!(
            sanitize_cancel_code("COMMIT_AND_ROLLBACK_FAILED:private diagnostic"),
            "COMMIT_AND_ROLLBACK_FAILED"
        );
        assert_eq!(
            sanitize_cancel_code("A human-readable error with C:\\private\\settings"),
            "TRANSFER_FAILED"
        );
    }

    #[tokio::test]
    async fn transport_frame_reads_resume_after_select_cancellation() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let address = listener.local_addr().expect("listener address");
        let (client, accepted) = tokio::join!(TcpStream::connect(address), listener.accept());
        let mut client = client.expect("client should connect");
        let (server, _) = accepted.expect("server should accept");
        let mut buffer = Vec::new();

        client
            .write_all(&[0])
            .await
            .expect("first length byte should write");
        {
            let pending = read_transport_frame(&server, &mut buffer, Duration::from_secs(1));
            tokio::pin!(pending);
            tokio::select! {
                result = &mut pending => panic!("partial frame unexpectedly completed: {result:?}"),
                _ = tokio::time::sleep(Duration::from_millis(25)) => {}
            }
        }
        assert_eq!(
            buffer,
            vec![0],
            "the consumed byte must survive cancellation"
        );

        client
            .write_all(&[4, 1, 2, 3, 4])
            .await
            .expect("remaining frame should write");
        assert_eq!(
            read_transport_frame(&server, &mut buffer, Duration::from_secs(1))
                .await
                .expect("the buffered frame should resume"),
            vec![1, 2, 3, 4]
        );
        assert!(buffer.is_empty());
    }

    #[tokio::test]
    async fn noise_xx_round_trip_encrypts_and_sequences_records() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let address = listener.local_addr().expect("listener address");
        let sid = [8_u8; 16];
        let responder = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("peer should connect");
            let (mut channel, _) = accept_noise_responder(stream, &sid)
                .await
                .expect("responder handshake");
            match channel.receive().await.expect("record should decrypt") {
                WireMessage::PairingConfirmed => {}
                other => panic!("unexpected record: {other:?}"),
            }
            channel
                .send(WireMessage::Approval)
                .await
                .expect("response should encrypt");
        });
        let stream = TcpStream::connect(address)
            .await
            .expect("connect should work");
        let preface = ConnectionPreface {
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR,
            sid,
            initiator_nonce: [6; 16],
        };
        let mut initiator = connect_noise_initiator(stream, &preface)
            .await
            .expect("initiator handshake");
        let created_at = now_millis();
        initiator
            .set_sender_session(
                "abcdefghijklmnopqrstuvwxyzABCDEFGH".to_string(),
                created_at,
                created_at + 60_000,
            )
            .expect("session should initialize");
        initiator
            .send(WireMessage::PairingConfirmed)
            .await
            .expect("record should encrypt");
        assert_eq!(
            initiator.receive().await.expect("response should decrypt"),
            WireMessage::Approval
        );
        responder.await.expect("responder task should finish");
    }

    #[tokio::test]
    async fn mismatched_minor_is_rejected_before_noise_handshake() {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener should bind");
        let address = listener.local_addr().expect("listener address");
        let sid = [11_u8; 16];
        let responder = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("peer should connect");
            match accept_noise_responder(stream, &sid).await {
                Ok(_) => panic!("a lower protocol minor must fail before Noise"),
                Err(error) => error,
            }
        });
        let mut stream = TcpStream::connect(address)
            .await
            .expect("connect should work");
        let incompatible = ConnectionPreface {
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR.saturating_sub(1),
            sid,
            initiator_nonce: [12; 16],
        };
        write_frame(&mut stream, &incompatible.encode(), Duration::from_secs(1))
            .await
            .expect("the incompatible preface should be sent");

        assert_eq!(
            responder.await.expect("responder task should finish"),
            "PROTOCOL_MISMATCH"
        );
    }
}
