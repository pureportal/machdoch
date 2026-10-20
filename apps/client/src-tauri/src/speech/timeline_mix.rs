use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;

const BLOCK_BYTES: usize = 65_536;

struct Ducker {
    threshold: f32,
    reduction: f32,
    attack: f32,
    release: f32,
    decay: f32,
    detector: f32,
    gain: f32,
}

impl Ducker {
    fn new(value: &Value, rate: u32) -> Result<Self, String> {
        let finite = |name: &str, min: f64, max: f64| {
            value[name]
                .as_f64()
                .filter(|value| value.is_finite() && *value >= min && *value <= max)
                .ok_or("Use valid voice-ducking values.")
        };
        let threshold = 10f64.powf(finite("thresholdDbfs", -80.0, 0.0)? / 20.0) as f32;
        let reduction = 10f64.powf(finite("reductionDb", -60.0, 0.0)? / 20.0) as f32;
        let coefficient =
            |milliseconds: f64| (-1000.0 / (milliseconds * f64::from(rate))).exp() as f32;
        Ok(Self {
            threshold,
            reduction,
            attack: coefficient(finite("attackMs", 1.0, 2000.0)?),
            release: coefficient(finite("releaseMs", 1.0, 10000.0)?),
            decay: coefficient(50.0),
            detector: 0.0,
            gain: 1.0,
        })
    }
    fn gain(&mut self, peak: f32) -> f32 {
        self.detector = peak.max(self.detector * self.decay);
        let target = if self.detector >= self.threshold {
            self.reduction
        } else {
            1.0
        };
        let coefficient = if target < self.gain {
            self.attack
        } else {
            self.release
        };
        self.gain = target + coefficient * (self.gain - target);
        self.gain
    }
}

pub fn mix(
    master: &Path,
    clip: &Path,
    offset: u64,
    capacity: u64,
    voice: Option<&Path>,
    ducking: &Value,
    rate: u32,
    channels: u32,
) -> Result<(), String> {
    if !(1..=2).contains(&channels) || rate == 0 {
        return Err("Choose a valid output sample format.".into());
    }
    let mut master = OpenOptions::new()
        .read(true)
        .write(true)
        .open(master)
        .map_err(|_| "The working master could not be opened.")?;
    let mut source = File::open(clip).map_err(|_| "A working audio clip could not be opened.")?;
    let frame_bytes = u64::from(channels) * 4;
    let length = source
        .metadata()
        .map_err(|_| "A working audio clip could not be measured.")?
        .len();
    if length == 0
        || length % frame_bytes != 0
        || offset % frame_bytes != 0
        || offset.checked_add(length).is_none_or(|end| end > capacity)
    {
        return Err("A rendered clip exceeded the measured timeline bounds.".into());
    }
    let mut sidechain = match voice {
        Some(path) if !ducking.is_null() => {
            Some(File::open(path).map_err(|_| "The voice ducking source is unavailable.")?)
        }
        _ => None,
    };
    if let Some(file) = &mut sidechain {
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| "The voice ducking source could not be positioned.")?;
    }
    let mut ducker = if sidechain.is_some() {
        Some(Ducker::new(ducking, rate)?)
    } else {
        None
    };
    let mut input = [0u8; BLOCK_BYTES];
    let mut output = [0u8; BLOCK_BYTES];
    let mut voices = [0u8; BLOCK_BYTES];
    let mut position = 0;
    while position < length {
        let count = (length - position).min(BLOCK_BYTES as u64) as usize;
        source
            .read_exact(&mut input[..count])
            .map_err(|_| "A working audio clip is truncated.")?;
        master
            .seek(SeekFrom::Start(offset + position))
            .and_then(|_| master.read_exact(&mut output[..count]))
            .map_err(|_| "The working master could not be read.")?;
        if let Some(file) = &mut sidechain {
            file.read_exact(&mut voices[..count])
                .map_err(|_| "The voice ducking source is truncated.")?;
        }
        for frame in (0..count).step_by(frame_bytes as usize) {
            let mut peak = 0f32;
            if ducker.is_some() {
                for sample in voices[frame..frame + frame_bytes as usize].chunks_exact(4) {
                    let value =
                        f32::from_le_bytes(sample.try_into().map_err(|_| "Invalid voice PCM.")?);
                    if !value.is_finite() {
                        return Err("The voice bus contains invalid samples.".into());
                    }
                    peak = peak.max(value.abs());
                }
            }
            let gain = ducker.as_mut().map_or(1.0, |ducker| ducker.gain(peak));
            for channel in 0..channels as usize {
                let begin = frame + channel * 4;
                let sample = f32::from_le_bytes(
                    input[begin..begin + 4]
                        .try_into()
                        .map_err(|_| "Invalid PCM block.")?,
                ) * gain;
                let sum = sample
                    + f32::from_le_bytes(
                        output[begin..begin + 4]
                            .try_into()
                            .map_err(|_| "Invalid PCM block.")?,
                    );
                if !sum.is_finite() {
                    return Err("A timeline mix contains invalid audio samples.".into());
                }
                output[begin..begin + 4].copy_from_slice(&sum.to_le_bytes());
            }
        }
        master
            .seek(SeekFrom::Start(offset + position))
            .and_then(|_| master.write_all(&output[..count]))
            .map_err(|_| "The timeline mix could not be saved. Check available disk space.")?;
        position += count as u64;
    }
    master
        .sync_all()
        .map_err(|_| "The timeline mix could not be saved.".into())
}

pub fn peak(path: &Path, offset: u64, length: u64) -> Result<f32, String> {
    let mut input = File::open(path)
        .map_err(|_| "The working master could not be opened for its peak check.")?;
    input
        .seek(SeekFrom::Start(offset))
        .map_err(|_| "The peak check could not reach the selected range.")?;
    let mut remaining = length;
    let mut buffer = [0u8; BLOCK_BYTES];
    let mut peak = 0f32;
    while remaining > 0 {
        let count = remaining.min(BLOCK_BYTES as u64) as usize;
        input
            .read_exact(&mut buffer[..count])
            .map_err(|_| "The working master is truncated.")?;
        for sample in buffer[..count].chunks_exact(4) {
            let value = f32::from_le_bytes(
                sample
                    .try_into()
                    .map_err(|_| "The working master has incomplete samples.")?,
            );
            if !value.is_finite() {
                return Err("The working master contains invalid samples.".into());
            }
            peak = peak.max(value.abs());
        }
        remaining -= count as u64;
    }
    Ok(peak)
}
