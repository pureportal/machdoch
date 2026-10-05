use super::*;

pub(super) fn import_audio(
    paths: &MediaRuntimePaths,
    staged: &StagedAsset,
    source_path: &Path,
) -> MediaResult<MediaAssetImportResult> {
    let mut reader = hound::WavReader::open(&staged.path)
        .map_err(|error| format!("Could not decode WAV audio: {error}"))?;
    let specification = reader.spec();
    let frames = reader.duration();
    let sample_count = reader.len();
    if !(1..=2).contains(&specification.channels)
        || !(8_000..=192_000).contains(&specification.sample_rate)
        || frames == 0
        || f64::from(frames) / f64::from(specification.sample_rate) > 3_600.0
        || sample_count % u32::from(specification.channels) != 0
    {
        return Err("Choose mono or stereo WAV audio, up to one hour at 8–192 kHz".into());
    }
    let mut decoded_samples = 0_u32;
    match specification.sample_format {
        hound::SampleFormat::Float if specification.bits_per_sample == 32 => {
            for sample in reader.samples::<f32>() {
                let sample = sample.map_err(|error| format!("WAV audio is incomplete: {error}"))?;
                if !sample.is_finite() {
                    return Err("WAV audio contains invalid samples; export it again".into());
                }
                decoded_samples += 1;
            }
        }
        hound::SampleFormat::Int if matches!(specification.bits_per_sample, 8 | 16 | 24 | 32) => {
            for sample in reader.samples::<i32>() {
                sample.map_err(|error| format!("WAV audio is incomplete: {error}"))?;
                decoded_samples += 1;
            }
        }
        _ => return Err("Export the audio as PCM or 32-bit float WAV".into()),
    }
    if decoded_samples != sample_count {
        return Err("WAV audio is incomplete; export it again".into());
    }
    let source_file_name = source_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.wav");
    let operation = serde_json::json!({
        "kind": "local-import",
        "mediaType": "audio",
        "sourceFileName": source_file_name,
        "sampleRate": specification.sample_rate,
        "channels": specification.channels,
        "bitsPerSample": specification.bits_per_sample,
        "sampleFormat": match specification.sample_format { hound::SampleFormat::Float => "float", hound::SampleFormat::Int => "pcm" },
        "sampleFrames": frames,
        "durationSeconds": f64::from(frames) / f64::from(specification.sample_rate),
    }).to_string();
    let relative_path = promote_to_cas(paths, staged)?;
    database::record_imported_asset(
        paths,
        database::ImportedAssetRegistration {
            digest: &staged.digest,
            relative_path: &relative_path.to_string_lossy(),
            byte_size: staged.byte_size,
            mime_type: "audio/wav",
            width: 0,
            height: 0,
            import_kind: database::LocalImportKind::Audio {
                source_file_name,
                operation_json: &operation,
            },
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_audio_is_decoded_registered_and_deduplicated() {
        let root = std::env::temp_dir().join(format!(
            "machdoch-audio-import-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("song.wav");
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&source, spec).unwrap();
        for sample in 0..960 {
            writer.write_sample::<i16>((sample % 128) as i16).unwrap();
        }
        writer.finalize().unwrap();
        let paths = MediaRuntimePaths {
            _storage_lease: None,
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let imported = import_asset(&paths, source.to_str().unwrap()).unwrap();
        assert_eq!(imported.asset.kind, "audio");
        assert_eq!(imported.asset.mime_type, "audio/wav");
        assert_eq!((imported.asset.width, imported.asset.height), (0, 0));
        assert_eq!(
            imported.asset.operation.as_ref().unwrap()["durationSeconds"],
            0.01
        );
        assert_eq!(
            fs::read(
                paths
                    .blobs
                    .join(&imported.asset.digest[..2])
                    .join(&imported.asset.digest[2..4])
                    .join(&imported.asset.digest)
            )
            .unwrap(),
            fs::read(&source).unwrap()
        );
        let duplicate = import_asset(&paths, source.to_str().unwrap()).unwrap();
        assert!(duplicate.deduplicated);
        assert_eq!(duplicate.asset.id, imported.asset.id);
        let truncated = root.join("truncated.wav");
        let mut bytes = fs::read(&source).unwrap();
        bytes.truncate(bytes.len() - 20);
        fs::write(&truncated, bytes).unwrap();
        assert!(import_asset(&paths, truncated.to_str().unwrap()).is_err());
        assert_eq!(database::list_assets(&paths, 10).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }
}
