use super::wave_file::{WaveReader,WaveSample};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const MAX_BUCKETS: usize = 4096;
const MAX_MEASUREMENT_LOG: u64 = 65_536;

pub fn analyze(path: &Path, buckets: usize) -> Result<Value, String> {
    if !(1..=MAX_BUCKETS).contains(&buckets) {
        return Err("Choose between 1 and 4096 waveform buckets.".to_string());
    }
    let reader = WaveReader::open(path)?;
    let spec = reader.spec();
    let samples = reader.sample_count();
    let scale=2_f64.powi(i32::from(spec.bits_per_sample)-1);
    let minimum=-(1_i64<<(spec.bits_per_sample-1));let maximum=(1_i64<<(spec.bits_per_sample-1))-1;
    summarize(reader.map(|sample|sample.map(|sample|match sample{
        WaveSample::Integer(sample)=>(f64::from(sample)/scale,i64::from(sample)==minimum||i64::from(sample)==maximum),
        WaveSample::Float(sample)=>(f64::from(sample),sample.abs()>=1.0),
    })),samples,spec.channels,spec.sample_rate,buckets)
}

fn summarize(
    samples: impl Iterator<Item = Result<(f64, bool), String>>,
    expected_samples: u64,
    channels: u16,
    sample_rate: u32,
    requested_buckets: usize,
) -> Result<Value, String> {
    let frames = expected_samples / u64::from(channels);
    let count = frames.min(requested_buckets as u64) as usize;
    let mut peaks = vec![(f64::INFINITY, f64::NEG_INFINITY); count];
    let mut sample_count = 0_u64;
    let mut clipped_samples = 0_u64;
    let mut zero_samples = 0_u64;
    let mut silent_frames = 0_u64;
    let mut leading_silent_frames = 0_u64;
    let mut trailing_silent_frames = 0_u64;
    let mut frame_is_silent = true;
    let mut sum_squares = 0.0_f64;
    let mut sample_peak = 0.0_f64;

    for sample in samples {
        let (value, clipped) = sample
            .map_err(|_| "The WAV is damaged or truncated. Render the take again.".to_string())?;
        if !value.is_finite() || sample_count >= expected_samples {
            return Err("The WAV contains invalid audio samples.".to_string());
        }
        let frame = sample_count / u64::from(channels);
        let bucket = (u128::from(frame) * count as u128 / u128::from(frames)) as usize;
        peaks[bucket].0 = peaks[bucket].0.min(value);
        peaks[bucket].1 = peaks[bucket].1.max(value);
        sample_peak = sample_peak.max(value.abs());
        sum_squares += value * value;
        clipped_samples += u64::from(clipped);
        zero_samples += u64::from(value == 0.0);
        frame_is_silent &= value == 0.0;
        sample_count += 1;
        if sample_count % u64::from(channels) == 0 {
            if frame_is_silent {
                silent_frames += 1;
                trailing_silent_frames += 1;
                if leading_silent_frames == frame {
                    leading_silent_frames += 1;
                }
            } else {
                trailing_silent_frames = 0;
            }
            frame_is_silent = true;
        }
    }
    if sample_count != expected_samples {
        return Err("The WAV is truncated. Render the take again.".to_string());
    }
    let peaks: Vec<Value> = peaks.into_iter().enumerate().map(|(index, (min, max))| {
        json!({
            "startFrame": (index as u64 * frames).div_ceil(count as u64),
            "endFrame": ((index as u64 + 1) * frames).div_ceil(count as u64),
            "min": min,
            "max": max,
        })
    }).collect();
    let rms = (sum_squares / sample_count as f64).sqrt();
    Ok(json!({
        "duration": frames as f64 / f64::from(sample_rate),
        "frames": frames,
        "channels": channels,
        "sampleRate": sample_rate,
        "sampleCount": sample_count,
        "peaks": peaks,
        "samplePeak": sample_peak,
        "samplePeakDbfs": amplitude_dbfs(sample_peak),
        "rmsDbfs": amplitude_dbfs(rms),
        "clippedSamples": clipped_samples,
        "zeroSamples": zero_samples,
        "silentFrames": silent_frames,
        "silence": zero_samples == sample_count,
        "silentDuration": silent_frames as f64 / f64::from(sample_rate),
        "leadingSilence": leading_silent_frames as f64 / f64::from(sample_rate),
        "trailingSilence": trailing_silent_frames as f64 / f64::from(sample_rate),
    }))
}

fn amplitude_dbfs(amplitude: f64) -> Value {
    if amplitude == 0.0 {
        json!("-inf")
    } else {
        json!(20.0 * amplitude.log10())
    }
}

pub async fn loudness(path: &Path, encoder: &Path) -> Result<Value, String> {
    if !path.is_absolute() || !encoder.is_absolute() {
        return Err("Audio measurement requires the pinned encoder and an absolute audio path.".to_string());
    }
    let mut command = Command::new(encoder);
    command.args(["-hide_banner", "-loglevel", "info", "-nostdin", "-nostats", "-xerror", "-i"])
        .arg(path)
        .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-af",
            "loudnorm=print_format=json", "-f", "null", "-"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()
        .map_err(|_| "The pinned encoder could not start. Reinstall the speech encoder.".to_string())?;
    let stderr = child.stderr.take()
        .ok_or("The encoder measurement output is unavailable.")?;
    tokio::time::timeout(Duration::from_secs(12 * 3600), async {
        let mut log = Vec::new();
        stderr.take(MAX_MEASUREMENT_LOG + 1).read_to_end(&mut log).await
            .map_err(|_| "The encoder measurement could not be read.".to_string())?;
        if log.len() as u64 > MAX_MEASUREMENT_LOG {
            return Err("The encoder produced excessive measurement output. Check the audio file.".to_string());
        }
        let status = child.wait().await
            .map_err(|_| "The encoder measurement did not finish.".to_string())?;
        if !status.success() {
            return Err("Audio measurement failed. Check the WAV and reinstall the pinned encoder.".to_string());
        }
        parse_loudness(&log)
    }).await.map_err(|_| "Audio measurement exceeded the processing deadline.".to_string())?
}

fn parse_loudness(log: &[u8]) -> Result<Value, String> {
    let invalid = || "The encoder did not return valid loudness measurements.".to_string();
    let end = log.iter().rposition(|byte| *byte == b'}').ok_or_else(invalid)?;
    let start = log[..end].iter().rposition(|byte| *byte == b'{').ok_or_else(invalid)?;
    let measurements: Value = serde_json::from_slice(&log[start..=end]).map_err(|_| invalid())?;
    Ok(json!({
        "integratedLufs": measured_decibels(&measurements["input_i"])?,
        "truePeakDbtp": measured_decibels(&measurements["input_tp"])?,
    }))
}

fn measured_decibels(value: &Value) -> Result<Value, String> {
    let value = value.as_str()
        .ok_or("The encoder returned an invalid decibel measurement.")?;
    if value == "-inf" {
        return Ok(json!("-inf"));
    }
    let value = value.parse::<f64>().ok().filter(|value| value.is_finite())
        .ok_or("The encoder returned an invalid decibel measurement.")?;
    Ok(json!(value))
}

#[cfg(test)]
#[path = "analysis_tests.rs"]
mod tests;
