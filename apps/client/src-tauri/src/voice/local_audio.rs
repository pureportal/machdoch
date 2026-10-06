use std::{io::Cursor, ops::Range};

pub(super) fn read_wav(bytes: &[u8]) -> Result<Vec<i16>, String> {
    let mut reader = hound::WavReader::new(Cursor::new(bytes))
        .map_err(|error| format!("Could not read the WAV recording: {error}"))?;
    let spec = reader.spec();
    if spec.channels != 1
        || spec.sample_rate != 16_000
        || spec.bits_per_sample != 16
        || spec.sample_format != hound::SampleFormat::Int
    {
        return Err("Local speech recognition needs 16 kHz mono PCM WAV audio.".to_string());
    }
    let samples = reader
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not read the WAV recording: {error}"))?;
    if samples.is_empty() {
        return Err("The recording is empty. Record again.".to_string());
    }
    Ok(samples)
}

pub(super) fn wav_bytes(samples: &[i16]) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::new(&mut bytes, spec).map_err(|error| error.to_string())?;
    for sample in samples {
        writer
            .write_sample(*sample)
            .map_err(|error| error.to_string())?;
    }
    writer.finalize().map_err(|error| error.to_string())?;
    Ok(bytes.into_inner())
}

pub(super) fn chunk_ranges(samples: &[i16]) -> Vec<Range<usize>> {
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < samples.len() {
        let limit = (start + 30 * 16_000).min(samples.len());
        let end = if limit < samples.len() {
            ((start + 25 * 16_000)..limit)
                .step_by(160)
                .min_by_key(|index| {
                    samples[*index..(*index + 160).min(limit)]
                        .iter()
                        .map(|sample| i64::from(*sample).pow(2))
                        .sum::<i64>()
                })
                .unwrap_or(limit)
        } else {
            limit
        };
        chunks.push(start..end);
        start = end;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_every_sample_when_chunking_long_recordings() {
        let samples = vec![3000; 96 * 16_000];
        let chunks = chunk_ranges(&samples);
        assert_eq!(chunks.first().unwrap().start, 0);
        assert_eq!(chunks.last().unwrap().end, samples.len());
        assert!(chunks.iter().all(|chunk| chunk.len() <= 30 * 16_000));
        assert!(chunks.windows(2).all(|pair| pair[0].end == pair[1].start));
    }

    #[test]
    fn cuts_at_a_pause_and_round_trips_pcm() {
        let mut samples = vec![5000; 60 * 16_000];
        samples[27 * 16_000..28 * 16_000].fill(0);
        let chunks = chunk_ranges(&samples);
        assert_eq!(chunks[0].end, 27 * 16_000);
        assert_eq!(read_wav(&wav_bytes(&samples).unwrap()).unwrap(), samples);
    }

    #[test]
    fn rejects_empty_and_invalid_audio() {
        assert!(read_wav(b"invalid").is_err());
        assert!(read_wav(&wav_bytes(&[]).unwrap()).is_err());
    }
}
