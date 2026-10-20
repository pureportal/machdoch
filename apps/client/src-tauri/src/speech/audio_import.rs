use super::{exports, identifier, reference_audio, SpeechService};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_PCM_BYTES: u64 = u32::MAX as u64 - 4096;
const INPUT_FORMATS: &str = "wav,mp3,flac,ogg,mov,matroska,aac";

struct ImportFiles {
    source: PathBuf,
    audio: PathBuf,
}
impl Drop for ImportFiles {
    fn drop(&mut self) {
        for path in [&self.source, &self.audio] {
            if path.exists() && std::fs::remove_file(path).is_err() {
                eprintln!("Speech import working files could not be removed.");
            }
        }
    }
}

fn command(binary: &Path) -> Command {
    let mut command = Command::new(binary);
    command.stdin(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

fn copy_source(source: &Path, destination: &Path) -> Result<(String, u64), String> {
    let mut input = File::open(source).map_err(|_| "The imported audio could not be opened.")?;
    let metadata = input
        .metadata()
        .map_err(|_| "The imported audio size is unavailable.")?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_SOURCE_BYTES {
        return Err(
            "Import a regular audio file between 1 byte and the local 512 MiB limit.".into(),
        );
    }
    let free = crate::storage_space::available_storage_bytes(
        destination
            .parent()
            .ok_or("The import working directory is missing.")?,
    )
    .ok_or("Free import storage could not be measured.")?;
    if free < metadata.len().saturating_add(64 * 1024 * 1024) {
        return Err("Free more speech storage before importing this audio.".into());
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| "Speech import working storage is unavailable.")?;
    let mut hash = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 65_536];
    loop {
        let bytes = input
            .read(&mut buffer)
            .map_err(|_| "The imported audio could not be read.")?;
        if bytes == 0 {
            break;
        }
        count += bytes as u64;
        if count > metadata.len() {
            return Err("The imported audio changed while reading it. Retry the import.".into());
        }
        output
            .write_all(&buffer[..bytes])
            .map_err(|_| "Speech import storage is full.")?;
        hash.update(&buffer[..bytes]);
    }
    if count != metadata.len() {
        return Err("The imported audio changed while reading it. Retry the import.".into());
    }
    output
        .sync_all()
        .map_err(|_| "The imported source could not be saved.")?;
    Ok((format!("{:x}", hash.finalize()), count))
}

async fn inspect(source: &Path, probe: &Path) -> Result<(u32, u16, f64), String> {
    let mut probe = command(probe);
    probe
        .args([
            "-v",
            "error",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            INPUT_FORMATS,
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=sample_rate,channels,duration:format=duration",
            "-of",
            "json",
        ])
        .arg(source)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = probe
        .spawn()
        .map_err(|_| "The pinned audio probe could not start.")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("The audio probe output is unavailable.")?;
    let measured = tokio::time::timeout(Duration::from_secs(30), async {
        let mut bytes = Vec::new();
        stdout
            .take(65_537)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Audio probing failed.")?;
        if bytes.len() > 65_536 {
            return Err("The audio metadata exceeded its local size limit.");
        }
        if !child
            .wait()
            .await
            .map_err(|_| "Audio probing failed.")?
            .success()
        {
            return Err("Choose a decodable WAV, MP3, FLAC, Opus, AAC or M4B audio file.");
        }
        serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "The audio probe returned invalid metadata.")
    })
    .await
    .map_err(|_| "Audio probing exceeded its processing deadline.")??;
    let stream = &measured["streams"][0];
    let rate = stream["sample_rate"]
        .as_str()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|rate| (8_000..=192_000).contains(rate))
        .ok_or("Use imported audio from 8,000 to 192,000 Hz.")?;
    let channels = stream["channels"]
        .as_u64()
        .filter(|channels| (1..=8).contains(channels))
        .ok_or("Use imported audio with one to eight channels.")? as u16;
    let duration = stream["duration"]
        .as_str()
        .or_else(|| measured["format"]["duration"].as_str())
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or("The imported audio has no measurable duration.")?;
    if duration * f64::from(rate) * f64::from(channels) * 4.0 > MAX_PCM_BYTES as f64 {
        return Err("This audio exceeds the local working-master limit. Split it into shorter tracks before importing.".into());
    }
    Ok((rate, channels, duration))
}

async fn decode(
    source: &Path,
    destination: &Path,
    encoder: &Path,
    rate: u32,
    channels: u16,
) -> Result<(), String> {
    let mut decode = command(encoder);
    decode
        .args([
            "-v",
            "error",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            INPUT_FORMATS,
            "-i",
        ])
        .arg(source)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-ar",
            &rate.to_string(),
            "-ac",
            &channels.to_string(),
            "-c:a",
            "pcm_f32le",
            "-f",
            "f32le",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = decode
        .spawn()
        .map_err(|_| "The pinned audio decoder could not start.")?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("The audio decoder output is unavailable.")?;
    tokio::time::timeout(Duration::from_secs(3600), async {
        let file = OpenOptions::new()
            .write(true)
            .read(true)
            .create_new(true)
            .open(destination)
            .map_err(|_| "The working audio could not be created.")?;
        let mut writer = hound::WavWriter::new(
            std::io::BufWriter::with_capacity(65_536, file),
            hound::WavSpec {
                channels,
                sample_rate: rate,
                bits_per_sample: 32,
                sample_format: hound::SampleFormat::Float,
            },
        )
        .map_err(|_| "The working audio header could not be written.")?;
        let mut buffer = [0u8; 65_536];
        let mut pending = Vec::new();
        let mut bytes = 0u64;
        loop {
            let count = stdout
                .read(&mut buffer)
                .await
                .map_err(|_| "The audio decoder was interrupted.")?;
            if count == 0 {
                break;
            }
            bytes += count as u64;
            if bytes > MAX_PCM_BYTES {
                return Err("The decoded audio exceeded the local working-master limit.");
            }
            pending.extend_from_slice(&buffer[..count]);
            let complete = pending.len() - pending.len() % 4;
            for value in pending[..complete].chunks_exact(4) {
                let sample = f32::from_le_bytes(
                    value
                        .try_into()
                        .map_err(|_| "An imported sample is invalid.")?,
                );
                if !sample.is_finite() {
                    return Err("The imported audio contains invalid samples.");
                }
                writer
                    .write_sample(sample)
                    .map_err(|_| "Speech import storage is full.")?;
            }
            pending.drain(..complete);
        }
        if bytes == 0 || bytes % (u64::from(channels) * 4) != 0 || !pending.is_empty() {
            return Err("The audio decoder returned incomplete frames.");
        }
        if !child
            .wait()
            .await
            .map_err(|_| "The audio decoder could not finish.")?
            .success()
        {
            return Err("The imported audio could not be fully decoded.");
        }
        writer
            .finalize()
            .map_err(|_| "The imported working master could not be finalized.")?;
        Ok(())
    })
    .await
    .map_err(|_| "Audio import exceeded its processing deadline.")?
    .map_err(str::to_owned)
}

pub async fn import(service: &Arc<SpeechService>, input: &Value) -> Result<Value, String> {
    let source = PathBuf::from(
        input["path"]
            .as_str()
            .ok_or("Choose an audio file to import.")?,
    );
    if !source.is_absolute() {
        return Err("Choose an absolute path to the imported audio file.".into());
    }
    let rights = input["rightsEvidence"]
        .as_str()
        .map(str::trim)
        .filter(|rights| !rights.is_empty() && rights.len() <= 32_768)
        .ok_or("Record permission to use this audio before importing it.")?
        .to_owned();
    let (encoder, probe) = (exports::encoder()?, exports::probe()?);
    let root = service.with_store(|store| Ok(store.root.clone()))?;
    let files = ImportFiles {
        source: root.join(format!("audio-source-{}.part", identifier()?)),
        audio: root.join(format!("audio-master-{}.wav", identifier()?)),
    };
    let source_copy = files.source.clone();
    let (hash, source_bytes) =
        tokio::task::spawn_blocking(move || copy_source(&source, &source_copy))
            .await
            .map_err(|_| "The source copy worker stopped.")??;
    let (rate, channels, estimated_duration) = inspect(&files.source, &probe).await?;
    let required = (estimated_duration * f64::from(rate) * f64::from(channels) * 4.0).ceil() as u64;
    let free = crate::storage_space::available_storage_bytes(&root)
        .ok_or("Free import storage could not be measured.")?;
    if free < required.saturating_mul(2).saturating_add(64 * 1024 * 1024) {
        return Err("Free more speech storage before decoding this audio.".into());
    }
    decode(&files.source, &files.audio, &encoder, rate, channels).await?;
    let audio = files.audio.clone();
    let (duration, rate, channels) =
        tokio::task::spawn_blocking(move || reference_audio::inspect_wav(&audio))
            .await
            .map_err(|_| "The imported audio check stopped.")??;
    let provenance =
        json!({"sourceSha256":hash,"sourceBytes":source_bytes,"rightsEvidence":rights});
    let asset=super::asset_commit::import(service,&files.audio,duration,rate,channels,None,|store,asset|{
        let previous:Option<String>=store.connection.query_row("SELECT data FROM speech_audio_sources WHERE asset_id=?1",[asset["id"].as_str()],|row|row.get(0)).optional().map_err(|_|"The imported audio provenance could not be read.")?;
        let mut origins=match previous{Some(data)=>serde_json::from_str::<Value>(&data).map_err(|_|"The imported audio provenance is damaged.")?["origins"].as_array().cloned().ok_or("The imported audio provenance is invalid.")?,None=>Vec::new()};
        if !origins.contains(&provenance){if origins.len()>=32{return Err("This audio already has the maximum stored source records.".into());}origins.push(provenance.clone());}
        store.connection.execute("INSERT INTO speech_audio_sources VALUES(?1,?2) ON CONFLICT(asset_id) DO UPDATE SET data=excluded.data",rusqlite::params![asset["id"].as_str(),json!({"origins":origins}).to_string()]).map_err(|_|"The imported audio provenance could not be saved.")?;
        Ok(asset)
    })?;
    Ok(json!({"asset":asset,"provenance":provenance}))
}
