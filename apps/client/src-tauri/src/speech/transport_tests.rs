use super::*;

fn timestamp(sequence: u64, offset: f64, text: &str, start: f64, end: f64) -> Value {
    json!({
        "chunk_seq": sequence,
        "chunk_audio_offset_sec": offset,
        "alignment": {
            "audio_duration": end,
            "segments": [{"text": text, "start": start, "end": end}]
        }
    })
}

fn packed(metadata: Value, audio: Option<&[u8]>) -> Vec<u8> {
    let encoded = rmp_serde::to_vec_named(&metadata).unwrap();
    let mut value = rmpv::decode::read_value(&mut Cursor::new(encoded)).unwrap();
    if let Some(audio) = audio {
        let rmpv::Value::Map(fields) = &mut value else {
            panic!("Expected a MessagePack object");
        };
        fields.push((
            rmpv::Value::from("audio"),
            rmpv::Value::Binary(audio.to_vec()),
        ));
    }
    let mut encoded = Vec::new();
    rmpv::encode::write_value(&mut encoded, &value).unwrap();
    encoded
}

#[test]
fn wav_header_describes_exact_pcm_sample_count() {
    let header = wav_header(48_000).unwrap();
    assert_eq!(&header[0..4], b"RIFF");
    assert_eq!(u32::from_le_bytes(header[4..8].try_into().unwrap()), 48_036);
    assert_eq!(&header[8..16], b"WAVEfmt ");
    assert_eq!(u32::from_le_bytes(header[16..20].try_into().unwrap()), 16);
    assert_eq!(u16::from_le_bytes(header[20..22].try_into().unwrap()), 1);
    assert_eq!(u16::from_le_bytes(header[22..24].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(header[24..28].try_into().unwrap()), 24_000);
    assert_eq!(u32::from_le_bytes(header[28..32].try_into().unwrap()), 48_000);
    assert_eq!(u16::from_le_bytes(header[32..34].try_into().unwrap()), 2);
    assert_eq!(u16::from_le_bytes(header[34..36].try_into().unwrap()), 16);
    assert_eq!(&header[36..40], b"data");
    assert_eq!(u32::from_le_bytes(header[40..44].try_into().unwrap()), 48_000);
}

#[test]
fn wav_rejects_empty_partial_and_overflowing_audio() {
    for bytes in [0, 1, 3, u64::from(u32::MAX - 35), u64::MAX] {
        assert!(wav_header(bytes).is_err());
    }
    assert!(wav_header(2).is_ok());
    assert!(wav_header(u64::from(u32::MAX - 37)).is_ok());
}

#[test]
fn sse_handles_bytewise_crlf_utf8_comments_and_metadata_fields() {
    let wire = ": heartbeat\r\nid: 1\r\nretry: 1000\r\nevent: message\r\ndata: {\"audio_base64\":\"AQI=\",\"content\":\"Grüße\"}\r\n\r\n";
    let mut decoder = SseDecoder::default();
    let mut messages = Vec::new();
    for byte in wire.as_bytes() {
        messages.extend(decoder.push(&[*byte]).unwrap());
    }
    decoder.finish().unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["content"], "Grüße");
    assert_eq!(sse_audio(&messages[0]).unwrap(), [1, 2]);
}

#[test]
fn sse_handles_multiline_data_and_bare_carriage_returns() {
    let mut decoder = SseDecoder::default();
    let messages = decoder.push(b"data: {\"audio_base64\":\rdata: \"AQI=\"}\r\r").unwrap();
    assert_eq!(messages.len(), 1);
    assert_eq!(sse_audio(&messages[0]).unwrap(), [1, 2]);
    decoder.finish().unwrap();
}

#[test]
fn sse_appends_each_audio_packet_in_arrival_order() {
    let mut decoder = SseDecoder::default();
    let messages = decoder.push(
        b"data: {\"audio_base64\":\"AQ==\"}\n\ndata: {\"audio_base64\":\"AgM=\"}\n\n",
    ).unwrap();
    let audio: Vec<_> = messages.iter().flat_map(|message| sse_audio(message).unwrap()).collect();
    assert_eq!(audio, [1, 2, 3]);
}

#[test]
fn sse_rejects_incomplete_events_even_after_valid_audio() {
    for tail in ["data: {", "data: {\"audio_base64\":\"AQI=\"}\n", "data:\n", "event: message\n"] {
        let mut decoder = SseDecoder::default();
        assert_eq!(decoder.push(b"data: {\"audio_base64\":\"AQI=\"}\n\n").unwrap().len(), 1);
        decoder.push(tail.as_bytes()).unwrap();
        assert!(decoder.finish().is_err());
    }
}

#[test]
fn sse_rejects_malformed_json_empty_data_invalid_utf8_and_oversized_events() {
    for wire in [
        b"data: nope\n\n".as_slice(),
        b"data: []\n\n".as_slice(),
        b"data:\n\n".as_slice(),
        b"data: \xff\n\n".as_slice(),
    ] {
        assert!(SseDecoder::default().push(wire).is_err());
    }
    assert!(SseDecoder::default().push(&vec![b'x'; MAX_MESSAGE_BYTES + 1]).is_err());
    assert!(sse_audio(&json!({"audio_base64": "%%%"})).is_err());
    assert!(sse_audio(&json!({})).is_err());
}

#[test]
fn sse_provider_errors_do_not_expose_provider_content() {
    let secret = "private-source-and-key";
    let mut decoder = SseDecoder::default();
    let error = decoder.push(format!("event: error\ndata: {{\"error\":\"{secret}\"}}\n\n").as_bytes()).unwrap_err();
    assert!(!error.contains(secret));
    let error = sse_audio(&json!({"error": secret})).unwrap_err();
    assert!(!error.contains(secret));
}

#[test]
fn alignment_corrections_replace_snapshots_and_apply_latest_offset() {
    let mut alignments = Alignments::default();
    alignments.update(&timestamp(0, 0.0, "draft", 0.0, 0.3)).unwrap();
    alignments.update(&timestamp(1, 1.0, "second", 0.1, 0.4)).unwrap();
    alignments.update(&timestamp(0, 0.2, "final", 0.1, 0.5)).unwrap();
    let mut no_alignment = timestamp(0, 99.0, "ignored", 0.0, 0.0);
    no_alignment["alignment"] = Value::Null;
    alignments.update(&no_alignment).unwrap();
    let timeline = alignments.into_timeline();
    assert_eq!(timeline.len(), 2);
    assert_eq!(timeline[0]["text"], "final");
    assert!((timeline[0]["start"].as_f64().unwrap() - 0.3).abs() < 1e-9);
    assert_eq!(timeline[0]["end"], 0.7);
    assert_eq!(timeline[1], json!({"text": "second", "start": 1.1, "end": 1.4}));
}

#[test]
fn cumulative_alignment_repetition_does_not_duplicate_words() {
    let mut alignments = Alignments::default();
    let mut snapshot = timestamp(4, 0.0, "hello", 0.0, 0.2);
    alignments.update(&snapshot).unwrap();
    snapshot["alignment"]["audio_duration"] = json!(0.5);
    snapshot["alignment"]["segments"].as_array_mut().unwrap().push(
        json!({"text": "world", "start": 0.2, "end": 0.5}),
    );
    alignments.update(&snapshot).unwrap();
    alignments.update(&snapshot).unwrap();
    assert_eq!(alignments.into_timeline().len(), 2);
}

#[test]
fn alignment_rejects_missing_fields_negative_and_reversed_times() {
    for value in [
        json!({}),
        timestamp(0, -1.0, "word", 0.0, 0.1),
        timestamp(0, 0.0, "word", -0.1, 0.1),
        timestamp(0, 0.0, "word", 0.2, 0.1),
        json!({"chunk_seq": -1, "chunk_audio_offset_sec": 0, "alignment": null}),
        json!({"chunk_seq": 0, "chunk_audio_offset_sec": null, "alignment": null}),
    ] {
        assert!(Alignments::default().update(&value).is_err());
    }
}

#[test]
fn live_audio_uses_messagepack_binary() {
    let wire = packed(json!({"event": "audio"}), Some(&[1, 2, 3, 4]));
    match live_event(&wire, false).unwrap() {
        LiveEvent::Audio { bytes, metadata } => {
            assert_eq!(bytes, [1, 2, 3, 4]);
            assert!(metadata.is_none());
        }
        _ => panic!("Expected binary audio"),
    }
    assert!(live_event(&packed(json!({"event": "audio", "audio": [1, 2]}), None), false).is_err());
}

#[test]
fn timed_live_preserves_empty_audio_alignment_corrections() {
    let mut metadata = timestamp(3, 2.0, "corrected", 0.0, 0.5);
    metadata["event"] = json!("audio");
    let wire = packed(metadata, Some(&[]));
    let mut alignments = Alignments::default();
    match live_event(&wire, true).unwrap() {
        LiveEvent::Audio { bytes, metadata } => {
            assert!(bytes.is_empty());
            alignments.update(&metadata.unwrap()).unwrap();
        }
        _ => panic!("Expected timestamp correction"),
    }
    assert_eq!(alignments.into_timeline(), vec![json!({"text": "corrected", "start": 2.0, "end": 2.5})]);
    assert!(live_event(&packed(json!({"event": "audio"}), Some(&[])), true).is_err());
}

#[test]
fn live_only_accepts_finish_with_stop_reason() {
    assert!(matches!(
        live_event(&packed(json!({"event": "finish", "reason": "stop"}), None), true).unwrap(),
        LiveEvent::Finish { .. }
    ));
    for metadata in [
        json!({"event": "finish"}),
        json!({"event": "finish", "reason": "error"}),
        json!({"event": "finish", "reason": "unknown"}),
        json!({"event": "error", "error": "private-source-and-key"}),
        json!({"event": "unexpected"}),
    ] {
        let error = live_event(&packed(metadata, None), true).err().unwrap();
        assert!(!error.contains("private-source-and-key"));
    }
}

#[test]
fn live_rejects_malformed_trailing_duplicate_and_oversized_frames() {
    assert!(live_event(&[], false).is_err());
    assert!(live_event(&[0xc1], false).is_err());
    let mut nested = vec![0x91; 64];
    nested.push(0xc0);
    assert!(live_event(&nested, false).is_err());
    assert!(live_event(&[0xdf, 0xff, 0xff, 0xff, 0xff], false).is_err());
    assert!(live_event(&vec![0; MAX_MESSAGE_BYTES + 1], false).is_err());
    let mut wire = packed(json!({"event": "finish", "reason": "stop"}), None);
    wire.push(0xc0);
    assert!(live_event(&wire, false).is_err());
    let duplicate = rmpv::Value::Map(vec![
        (rmpv::Value::from("event"), rmpv::Value::from("finish")),
        (rmpv::Value::from("event"), rmpv::Value::from("finish")),
        (rmpv::Value::from("reason"), rmpv::Value::from("stop")),
    ]);
    let mut wire = Vec::new();
    rmpv::encode::write_value(&mut wire, &duplicate).unwrap();
    assert!(live_event(&wire, false).is_err());
}
