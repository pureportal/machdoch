use std::collections::BTreeMap;
use std::io::Cursor;

use base64::Engine;
use serde_json::{json, Map, Value};

use super::super::pcm::SAMPLE_RATE;
#[cfg(test)]
use super::super::pcm::wav_header;
pub(super) const MAX_MESSAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ALIGNMENT_BYTES: usize = 16 * 1024 * 1024;

#[cfg(test)]
use super::super::sse::SseDecoder;

pub(super) fn sse_audio(message: &Value) -> Result<Vec<u8>, String> {
    if message.get("error").is_some()
        || message.get("event").and_then(Value::as_str) == Some("error")
    {
        return Err("Fish rejected the speech request.".into());
    }
    let audio = message.get("audio_base64").and_then(Value::as_str)
        .ok_or("Fish SSE event is missing audio.")?;
    base64::engine::general_purpose::STANDARD.decode(audio)
        .map_err(|_| "Fish returned invalid base64 audio.".into())
}

struct Snapshot {
    segments: Vec<Value>,
    bytes: usize,
}

#[derive(Default)]
pub(super) struct Alignments {
    snapshots: BTreeMap<u64, Snapshot>,
    bytes: usize,
}

impl Alignments {
    pub(super) fn update(&mut self, message: &Value) -> Result<(), String> {
        let alignment = message.get("alignment")
            .ok_or("Fish timestamp event is missing alignment metadata.")?;
        let sequence = message.get("chunk_seq").and_then(Value::as_u64)
            .ok_or("Fish timestamp event has an invalid chunk sequence.")?;
        let offset = nonnegative(message.get("chunk_audio_offset_sec"))?;
        if alignment.is_null() {
            return Ok(());
        }
        let duration = nonnegative(alignment.get("audio_duration"))?;
        let segments = alignment.get("segments").and_then(Value::as_array)
            .ok_or("Fish returned invalid alignment segments.")?;
        let mut global = Vec::with_capacity(segments.len());
        for segment in segments {
            let text = segment.get("text").and_then(Value::as_str)
                .ok_or("Fish returned invalid alignment text.")?;
            let start = nonnegative(segment.get("start"))?;
            let end = nonnegative(segment.get("end"))?;
            if end < start || end > duration + 1.0 / f64::from(SAMPLE_RATE)
                || !(start + offset).is_finite() || !(end + offset).is_finite()
            {
                return Err("Fish returned invalid alignment times.".into());
            }
            global.push(json!({"text": text, "start": start + offset, "end": end + offset}));
        }
        let bytes = serde_json::to_vec(&global)
            .map_err(|_| "Fish alignment could not be encoded.")?.len();
        let previous = self.snapshots.get(&sequence).map_or(0, |snapshot| snapshot.bytes);
        let total = self.bytes.checked_sub(previous).and_then(|size| size.checked_add(bytes))
            .ok_or("Fish alignment exceeded the size limit.")?;
        if total > MAX_ALIGNMENT_BYTES || self.snapshots.len() >= 65_536
            && !self.snapshots.contains_key(&sequence)
        {
            return Err("Fish alignment exceeded the size limit.".into());
        }
        self.snapshots.insert(sequence, Snapshot { segments: global, bytes });
        self.bytes = total;
        Ok(())
    }

    pub(super) fn into_timeline(self) -> Vec<Value> {
        self.snapshots.into_values().flat_map(|snapshot| snapshot.segments).collect()
    }
}

fn nonnegative(value: Option<&Value>) -> Result<f64, String> {
    value.and_then(Value::as_f64).filter(|number| number.is_finite() && *number >= 0.0)
        .ok_or_else(|| "Fish returned an invalid timestamp.".into())
}

pub(super) enum LiveEvent {
    Audio { bytes: Vec<u8>, metadata: Option<Value> },
    Finish { metadata: Option<Value> },
}

pub(super) fn live_event(bytes: &[u8], timestamps: bool) -> Result<LiveEvent, String> {
    if bytes.is_empty() || bytes.len() > MAX_MESSAGE_BYTES {
        return Err("Fish WebSocket message exceeded the size limit or was empty.".into());
    }
    let mut cursor = Cursor::new(bytes);
    let decoded = rmpv::decode::read_value_with_max_depth(&mut cursor, 32)
        .map_err(|_| "Fish returned malformed MessagePack.")?;
    if cursor.position() != bytes.len() as u64 {
        return Err("Fish returned trailing MessagePack data.".into());
    }
    let fields = decoded.as_map().ok_or("Fish returned an invalid WebSocket event.")?;
    let mut audio = None;
    let mut metadata = Map::new();
    for (key, value) in fields {
        let key = key.as_str().ok_or("Fish returned an invalid WebSocket field.")?;
        if key == "audio" {
            if audio.is_some() {
                return Err("Fish returned a duplicate WebSocket field.".into());
            }
            let rmpv::Value::Binary(bytes) = value else {
                return Err("Fish returned invalid binary audio.".into());
            };
            audio = Some(bytes.clone());
        } else if metadata.insert(key.to_owned(), messagepack_json(value, 0)?).is_some() {
            return Err("Fish returned a duplicate WebSocket field.".into());
        }
    }
    let metadata = Value::Object(metadata);
    match metadata.get("event").and_then(Value::as_str) {
        Some("audio") => {
            let bytes = audio.ok_or("Fish WebSocket event is missing audio.")?;
            if timestamps && (!metadata.get("alignment").is_some()
                || !metadata.get("chunk_seq").is_some()
                || !metadata.get("chunk_audio_offset_sec").is_some())
            {
                return Err("Fish WebSocket event is missing timestamps.".into());
            }
            Ok(LiveEvent::Audio { bytes, metadata: timestamps.then_some(metadata) })
        }
        Some("finish") if metadata.get("reason").and_then(Value::as_str) == Some("stop") => {
            if audio.is_some() {
                return Err("Fish returned audio in a finish event.".into());
            }
            let has_alignment = timestamps && metadata.get("alignment").is_some();
            Ok(LiveEvent::Finish { metadata: has_alignment.then_some(metadata) })
        }
        Some("finish") | Some("error") => Err("Fish speech session failed.".into()),
        _ => Err("Fish returned an unexpected WebSocket event.".into()),
    }
}

fn messagepack_json(value: &rmpv::Value, depth: usize) -> Result<Value, String> {
    if depth > 32 {
        return Err("Fish MessagePack nesting exceeded the limit.".into());
    }
    match value {
        rmpv::Value::Nil => Ok(Value::Null),
        rmpv::Value::Boolean(value) => Ok(Value::Bool(*value)),
        rmpv::Value::Integer(value) => value.as_u64().map(Value::from)
            .or_else(|| value.as_i64().map(Value::from))
            .ok_or_else(|| "Fish returned an invalid MessagePack integer.".into()),
        rmpv::Value::F32(value) => finite_number(f64::from(*value)),
        rmpv::Value::F64(value) => finite_number(*value),
        rmpv::Value::String(value) => value.as_str().map(|value| Value::String(value.to_owned()))
            .ok_or_else(|| "Fish returned invalid MessagePack text.".into()),
        rmpv::Value::Array(values) => values.iter()
            .map(|value| messagepack_json(value, depth + 1))
            .collect::<Result<Vec<_>, _>>().map(Value::Array),
        rmpv::Value::Map(fields) => {
            let mut object = Map::new();
            for (key, value) in fields {
                let key = key.as_str().ok_or("Fish returned an invalid MessagePack key.")?;
                if object.insert(key.to_owned(), messagepack_json(value, depth + 1)?).is_some() {
                    return Err("Fish returned a duplicate MessagePack field.".into());
                }
            }
            Ok(Value::Object(object))
        }
        _ => Err("Fish returned an unsupported MessagePack value.".into()),
    }
}

fn finite_number(value: f64) -> Result<Value, String> {
    serde_json::Number::from_f64(value).map(Value::Number)
        .ok_or_else(|| "Fish returned a nonfinite MessagePack number.".into())
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
