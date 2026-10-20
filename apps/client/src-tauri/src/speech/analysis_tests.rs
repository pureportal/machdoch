use super::{analyze, parse_loudness};
use hound::{SampleFormat, WavSpec, WavWriter};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct TestWav {
    directory: PathBuf,
    path: PathBuf,
}

impl TestWav {
    fn new() -> Self {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "machdoch-waveform-{}-{}-{}",
            std::process::id(), nonce, NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed),
        ));
        std::fs::create_dir(&directory).unwrap();
        Self { path: directory.join("audio.wav"), directory }
    }

    fn pcm(bits: u16, channels: u16, samples: &[i32]) -> Self {
        let fixture = Self::new();
        let mut writer = WavWriter::create(&fixture.path, WavSpec {
            channels, sample_rate: 8000, bits_per_sample: bits, sample_format: SampleFormat::Int,
        }).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
        let mut bytes=std::fs::read(&fixture.path).unwrap();
        if bytes.len()%2!=0{bytes.push(0);let size=bytes.len() as u32-8;bytes[4..8].copy_from_slice(&size.to_le_bytes());std::fs::write(&fixture.path,bytes).unwrap();}
        fixture
    }

    fn float(channels: u16, samples: &[f32]) -> Self {
        let fixture = Self::new();
        let mut writer = WavWriter::create(&fixture.path, WavSpec {
            channels, sample_rate: 8000, bits_per_sample: 32, sample_format: SampleFormat::Float,
        }).unwrap();
        for sample in samples {
            writer.write_sample(*sample).unwrap();
        }
        writer.finalize().unwrap();
        fixture
    }
}

impl Drop for TestWav {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}

fn number(value: &Value, key: &str) -> f64 {
    value[key].as_f64().unwrap()
}

fn near(actual: f64, expected: f64) {
    assert!((actual - expected).abs() < 1e-9, "{actual} != {expected}");
}

#[test]
fn pcm_reports_decoded_extrema_clipping_rms_and_format() {
    let fixture = TestWav::pcm(16, 1, &[-32768, 0, 16384, 32767]);
    let analysis = analyze(&fixture.path, 2).unwrap();
    assert_eq!(analysis["frames"], 4);
    assert_eq!(analysis["sampleCount"], 4);
    assert_eq!(analysis["channels"], 1);
    assert_eq!(analysis["sampleRate"], 8000);
    near(number(&analysis, "duration"), 4.0 / 8000.0);
    assert_eq!(analysis["clippedSamples"], 2);
    assert_eq!(analysis["zeroSamples"], 1);
    assert_eq!(analysis["silentFrames"], 1);
    assert_eq!(analysis["silence"], false);
    assert_eq!(analysis["peaks"][0], json!({
        "startFrame": 0, "endFrame": 2, "min": -1.0, "max": 0.0,
    }));
    near(number(&analysis["peaks"][1], "max"), 32767.0 / 32768.0);
    near(number(&analysis, "samplePeakDbfs"), 0.0);
    let expected_rms = ((1.0_f64 + 0.25 + (32767.0_f64 / 32768.0).powi(2)) / 4.0).sqrt();
    near(number(&analysis, "rmsDbfs"), 20.0 * expected_rms.log10());
    assert!(analysis.get("integratedLufs").is_none());
    assert!(analysis.get("truePeakDbtp").is_none());
}

#[test]
fn stereo_preserves_opposite_polarity_and_counts_silent_frames() {
    let fixture = TestWav::pcm(16, 2, &[0, 0, 16384, -16384, 0, 0, 0, 0]);
    let analysis = analyze(&fixture.path, 8).unwrap();
    assert_eq!(analysis["frames"], 4);
    assert_eq!(analysis["sampleCount"], 8);
    assert_eq!(analysis["peaks"].as_array().unwrap().len(), 4);
    near(number(&analysis["peaks"][1], "min"), -0.5);
    near(number(&analysis["peaks"][1], "max"), 0.5);
    assert_eq!(analysis["silentFrames"], 3);
    assert_eq!(analysis["zeroSamples"], 6);
    near(number(&analysis, "leadingSilence"), 1.0 / 8000.0);
    near(number(&analysis, "trailingSilence"), 2.0 / 8000.0);
    near(number(&analysis, "silentDuration"), 3.0 / 8000.0);
}

#[test]
fn exact_zero_silence_has_explicit_negative_infinite_dbfs() {
    let fixture = TestWav::float(2, &[0.0, -0.0, 0.0, 0.0]);
    let analysis = analyze(&fixture.path, 1).unwrap();
    assert_eq!(analysis["rmsDbfs"], "-inf");
    assert_eq!(analysis["samplePeakDbfs"], "-inf");
    assert_eq!(analysis["silence"], true);
    assert_eq!(analysis["zeroSamples"], 4);
    assert_eq!(analysis["silentFrames"], 2);
    near(number(&analysis, "leadingSilence"), 2.0 / 8000.0);
    near(number(&analysis, "trailingSilence"), 2.0 / 8000.0);
}

#[test]
fn integer_formats_use_their_actual_full_scale() {
    for bits in [8_u16, 16, 24, 32] {
        let minimum = -(1_i64 << (bits - 1));
        let maximum = (1_i64 << (bits - 1)) - 1;
        let fixture = TestWav::pcm(bits, 1, &[minimum as i32, 0, maximum as i32]);
        let analysis = analyze(&fixture.path, 1).unwrap();
        near(number(&analysis["peaks"][0], "min"), -1.0);
        near(number(&analysis["peaks"][0], "max"), maximum as f64 / -minimum as f64);
        assert_eq!(analysis["clippedSamples"], 2);
    }
}

#[test]
fn float_samples_keep_overs_and_measure_rms_without_normalizing() {
    let fixture = TestWav::float(1, &[-1.25, 0.5, 1.0, 0.0]);
    let analysis = analyze(&fixture.path, 1).unwrap();
    near(number(&analysis["peaks"][0], "min"), -1.25);
    near(number(&analysis["peaks"][0], "max"), 1.0);
    near(number(&analysis, "samplePeak"), 1.25);
    near(number(&analysis, "samplePeakDbfs"), 20.0 * 1.25_f64.log10());
    near(number(&analysis, "rmsDbfs"), 10.0 * ((1.5625_f64 + 0.25 + 1.0) / 4.0).log10());
    assert_eq!(analysis["clippedSamples"], 2);
}

#[test]
fn nonfinite_float_samples_are_rejected() {
    for invalid in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let fixture = TestWav::float(1, &[invalid]);
        let error = analyze(&fixture.path, 1).unwrap_err();
        assert!(!error.contains(&fixture.path.to_string_lossy().to_string()));
    }
}

#[test]
fn waveform_is_bounded_and_keeps_the_final_impulse() {
    let fixture = TestWav::new();
    let mut writer = WavWriter::create(&fixture.path, WavSpec {
        channels: 1, sample_rate: 8000, bits_per_sample: 16, sample_format: SampleFormat::Int,
    }).unwrap();
    for _ in 0..10_000 {
        writer.write_sample(0_i16).unwrap();
    }
    writer.write_sample(16384_i16).unwrap();
    writer.finalize().unwrap();
    let analysis = analyze(&fixture.path, 4096).unwrap();
    let peaks = analysis["peaks"].as_array().unwrap();
    assert_eq!(peaks.len(), 4096);
    assert_eq!(peaks[0]["startFrame"], 0);
    assert_eq!(peaks.last().unwrap()["endFrame"], 10_001);
    near(number(peaks.last().unwrap(), "max"), 0.5);
    for pair in peaks.windows(2) {
        assert_eq!(pair[0]["endFrame"], pair[1]["startFrame"]);
    }
}

#[test]
fn bucket_boundaries_follow_the_decoded_frame_groups() {
    let fixture = TestWav::pcm(16, 1, &[0, 8192, 16384, 24576, 0]);
    let analysis = analyze(&fixture.path, 3).unwrap();
    assert_eq!(analysis["peaks"], json!([
        {"startFrame": 0, "endFrame": 2, "min": 0.0, "max": 0.25},
        {"startFrame": 2, "endFrame": 4, "min": 0.5, "max": 0.75},
        {"startFrame": 4, "endFrame": 5, "min": 0.0, "max": 0.0},
    ]));
}

#[test]
fn invalid_bucket_counts_empty_and_truncated_files_are_rejected() {
    let fixture = TestWav::pcm(16, 1, &[1, 2, 3, 4]);
    assert!(analyze(&fixture.path, 0).is_err());
    assert!(analyze(&fixture.path, 4097).is_err());
    let file = std::fs::OpenOptions::new().write(true).open(&fixture.path).unwrap();
    file.set_len(file.metadata().unwrap().len() - 2).unwrap();
    drop(file);
    assert!(analyze(&fixture.path, 2).is_err());
    let empty = TestWav::pcm(16, 1, &[]);
    assert!(analyze(&empty.path, 1).is_err());
    std::fs::write(&fixture.path, b"invalid WAV").unwrap();
    assert!(analyze(&fixture.path, 1).is_err());
}

#[test]
fn loudnorm_uses_measured_input_values_and_ignores_normalized_output() {
    let measured = parse_loudness(br#"encoder log
{
    "input_i": "-21.35", "input_tp": "-2.10",
    "output_i": "-24.0", "output_tp": "-4.75"
}
"#).unwrap();
    assert_eq!(measured, json!({"integratedLufs": -21.35, "truePeakDbtp": -2.1}));
}

#[test]
fn loudnorm_silence_and_below_gate_audio_preserve_explicit_infinity() {
    assert_eq!(
        parse_loudness(br#"{"input_i":"-inf","input_tp":"-inf"}"#).unwrap(),
        json!({"integratedLufs":"-inf","truePeakDbtp":"-inf"}),
    );
    assert_eq!(
        parse_loudness(br#"{"input_i":"-inf","input_tp":"-80.0"}"#).unwrap(),
        json!({"integratedLufs":"-inf","truePeakDbtp":-80.0}),
    );
}

#[test]
fn invalid_or_missing_loudness_measurements_fail_without_exposing_logs() {
    for output in [
        r#"private/path/audio.wav: failed"#,
        r#"{"input_i":"NaN","input_tp":"0"}"#,
        r#"{"input_i":"-20","input_tp":"inf"}"#,
        r#"{"output_i":"-24","output_tp":"-2"}"#,
        r#"{"input_i":null,"input_tp":"-2"}"#,
    ] {
        let error = parse_loudness(output.as_bytes()).unwrap_err();
        assert!(!error.contains(output));
        assert!(!error.contains("private/path"));
    }
}
