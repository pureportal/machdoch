use super::{
    clip_window, clips, encoder, export_text, finite, selected_range, source_clips, write_new,
};
use crate::speech::{identifier, SpeechService};
use serde_json::Value;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const MAX_ENCODER_LOG: u64 = 1024 * 1024;
#[path = "timeline_mix.rs"]
mod timeline_mix;

struct Workspace(PathBuf);

impl Workspace {
    fn create(output: &Path) -> Result<Self, String> {
        let path = output.with_file_name(format!(".speech-work-{}", identifier()?));
        std::fs::create_dir(&path)
            .map_err(|_| "Audio export working storage could not be created.")?;
        Ok(Self(path))
    }

    fn finish(self) -> Result<(), String> {
        std::fs::remove_dir_all(&self.0)
            .map_err(|_| "Audio export working files could not be removed.".into())
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if self.0.exists() && std::fs::remove_dir_all(&self.0).is_err() {
            eprintln!("Speech export working storage could not be removed.");
        }
    }
}

fn command(encoder: &Path) -> Command {
    let mut command = Command::new(encoder);
    command.args(["-hide_banner", "-nostdin", "-nostats", "-n"]);
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

async fn run(mut command: Command) -> Result<String, String> {
    let mut child = command
        .spawn()
        .map_err(|_| "The speech encoder could not start.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("The speech encoder log could not be read.")?;
    let result = tokio::time::timeout(Duration::from_secs(12 * 3600), async {
        let log = async {
            let mut bytes = Vec::new();
            stderr
                .take(MAX_ENCODER_LOG + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "The speech encoder log could not be read.".to_string())?;
            if bytes.len() as u64 > MAX_ENCODER_LOG {
                return Err("The speech encoder exceeded its log limit.".to_string());
            }
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        };
        let status = async {
            child
                .wait()
                .await
                .map_err(|_| "The speech encoder could not finish.".to_string())
        };
        tokio::try_join!(status, log)
    })
    .await
    .map_err(|_| "Audio export exceeded its processing deadline.")??;
    if !result.0.success() {
        return Err(
            "Audio export failed. Check the timeline, encoder capabilities and free disk space."
                .into(),
        );
    }
    Ok(result.1)
}

fn raw_input(command: &mut Command, path: &Path, rate: u32, channels: u32) {
    command
        .args([
            "-f",
            "f32le",
            "-ar",
            &rate.to_string(),
            "-ac",
            &channels.to_string(),
            "-i",
        ])
        .arg(path);
}

fn measured_filter(log: &str, loudness: f64, peak: f64) -> Result<String, String> {
    let start = log
        .rfind('{')
        .ok_or("The encoder returned no loudness measurement.")?;
    let end = log[start..]
        .find('}')
        .map(|end| start + end + 1)
        .ok_or("The loudness measurement is incomplete.")?;
    let values: Value = serde_json::from_str(&log[start..end])
        .map_err(|_| "The loudness measurement is malformed.")?;
    let number = |key: &str| {
        values[key]
            .as_str()
            .and_then(|text| text.parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .ok_or("Loudness cannot be measured for this audio. Check for a silent master.")
    };
    let gain = loudness - number("input_i")?;
    if number("input_tp")? + gain > peak + 0.01 {
        return Err("The requested loudness exceeds the true-peak limit. Lower the loudness target or raise the peak limit.".into());
    }
    Ok(format!("volume={gain}dB"))
}

pub async fn encode(
    service: &Arc<SpeechService>,
    project: &Value,
    takes: &Value,
    input: &Value,
    output: &Path,
    format: &str,
) -> Result<(), String> {
    let speech = source_clips(project, takes, input)?;
    let mut media: Vec<(Value, Value, Value)> = speech
        .iter()
        .map(|(clip, take)| (clip.clone(), take["asset"].clone(), Value::Null))
        .collect();
    let speech_count = media.len();
    if input["includeBackground"].as_bool().unwrap_or_else(||input["takeIds"].as_array().is_some_and(|ids|ids.is_empty()))
    {
        for clip in project["backgroundTracks"].as_array().into_iter().flatten() {
            let asset = service.with_store(|store| {
                store.execute("asset", &serde_json::json!({"id":clip["assetId"]}))
            })?;
            media.push((clip.clone(), asset, clip["ducking"].clone()));
        }
    }
    if media.is_empty() || media.len() > 10_000 {
        return Err("Choose a nonempty production timeline within the local clip guard.".into());
    }
    let assets=media.iter().map(|(_,asset,_)|asset["id"].as_str().map(str::to_owned).ok_or("An export source audio identity is missing.")).collect::<Result<std::collections::HashSet<_>,_>>()?;
    let mut reservation=super::super::asset_io::retain(service,&assets.into_iter().collect::<Vec<_>>())?;
    let encoder = encoder()?;
    let range = selected_range(input)?;
    let ducking = media.iter().any(|(_, _, ducking)| !ducking.is_null());
    let processing_range = if ducking { None } else { range };
    let rate = finite(input, "sampleRate", 8_000.0, 192_000.0)? as u32;
    let channels = finite(input, "channels", 1.0, 2.0)? as u32;
    if input["sampleRate"] != rate || input["channels"] != channels {
        return Err("Use whole sample-rate and channel values.".into());
    }
    let bitrate = if matches!(format, "mp3" | "opus" | "m4b") {
        finite(input, "bitrate", 16_000.0, 512_000.0)? as u32
    } else {
        0
    };
    let mut measured = Vec::with_capacity(media.len());
    let mut frames = 0u64;
    let mut full_duration = 0f64;
    for (index, (clip, asset, ducking)) in media.iter().enumerate() {
        let duration = asset["duration"]
            .as_f64()
            .ok_or("An audio source has no measured duration.")?;
        let from = finite(clip, "in", 0.0, duration)?;
        let to = finite(clip, "out", from, duration)?;
        if to <= from {
            return Err("A timeline clip has no audio. Adjust its trim.".into());
        }
        let start = finite(clip, "start", 0.0, 7.0 * 24.0 * 3600.0)?;
        let gain = finite(clip, "gain", 0.0, 16.0)?;
        let fade_in = finite(clip, "fadeIn", 0.0, to - from)?;
        let fade_out = finite(clip, "fadeOut", 0.0, to - from)?;
        full_duration = full_duration.max(start + to - from);
        let Some(window) = clip_window(clip, processing_range)? else {
            continue;
        };
        let length = ((window.to - window.from) * f64::from(rate)).round() as u64;
        let position = (window.start * f64::from(rate)).round() as u64;
        if length == 0 {
            return Err("A timeline clip is shorter than one output sample.".into());
        }
        frames = frames.max(
            position
                .checked_add(length)
                .ok_or("The timeline length overflowed.")?,
        );
        measured.push((
            index,
            asset["id"]
                .as_str()
                .ok_or("An audio source ID is missing.")?
                .to_string(),
            ducking.clone(),
            from,
            to,
            gain,
            fade_in,
            fade_out,
            window.crop_from,
            window.crop_to,
            length,
            position,
        ));
    }
    if let Some((from, to)) = range {
        if to > full_duration + 0.5 / f64::from(rate) {
            return Err("Choose an export range within the measured timeline.".into());
        }
        if !ducking {
            frames = ((to - from) * f64::from(rate)).round() as u64;
        }
    }
    let capacity = frames
        .checked_mul(u64::from(channels) * 4)
        .ok_or("The timeline byte size overflowed.")?;
    if capacity == 0 {
        return Err("The selected range is shorter than one output sample.".into());
    }
    let free = crate::storage_space::available_storage_bytes(
        output.parent().ok_or("Choose an export directory.")?,
    )
    .ok_or("Free export storage could not be measured.")?;
    if free < capacity.saturating_mul(4).saturating_add(64 * 1024 * 1024) {
        return Err("Free more export storage before assembling this timeline.".into());
    }
    let workspace = Workspace::create(output)?;
    let master = workspace.0.join("master.f32le");
    let voices = workspace.0.join("voices.f32le");
    File::create(&master)
        .and_then(|file| file.set_len(capacity))
        .map_err(|_| "The working timeline could not be allocated. Check available disk space.")?;
    let mut voice_bus_ready = false;
    for (
        index,
        id,
        ducking_values,
        from,
        to,
        gain,
        fade_in,
        fade_out,
        crop_from,
        crop_to,
        length,
        position,
    ) in measured
    {
        if index >= speech_count && !voice_bus_ready {
            if ducking {
                std::fs::copy(&master, &voices)
                    .map_err(|_| "The voice ducking bus could not be saved.")?;
            }
            voice_bus_ready = true;
        }
        reservation.ensure_live()?;
        let source_audio=super::super::asset_io::open(service,&id,None)?;
        let source=source_audio.path.clone();
        let clip = workspace.0.join("clip.f32le");
        let mut render = command(&encoder);
        let mut filters = format!("atrim=start={from}:end={to},asetpts=PTS-STARTPTS,aresample={rate},aformat=channel_layouts={},volume={gain}", if channels == 1 { "mono" } else { "stereo" });
        if fade_in > 0.0 {
            filters += &format!(",afade=t=in:st=0:d={fade_in}");
        }
        if fade_out > 0.0 {
            filters += &format!(",afade=t=out:st={}:d={fade_out}", to - from - fade_out);
        }
        if crop_from > 0.0 || crop_to < to - from {
            filters += &format!(",atrim=start={crop_from}:end={crop_to},asetpts=PTS-STARTPTS");
        }
        filters += &format!(",apad=whole_len={length},atrim=end_sample={length}");
        render
            .args(["-loglevel", "error", "-i"])
            .arg(source)
            .args([
                "-map",
                "0:a:0",
                "-af",
                &filters,
                "-ar",
                &rate.to_string(),
                "-ac",
                &channels.to_string(),
                "-f",
                "f32le",
            ])
            .arg(&clip);
        run(render).await?;
        let master_path = master.clone();
        let clip_path = clip.clone();
        let voice_path = if !ducking_values.is_null() {
            Some(voices.clone())
        } else {
            None
        };
        tokio::task::spawn_blocking(move || {
            timeline_mix::mix(
                &master_path,
                &clip_path,
                position * u64::from(channels) * 4,
                capacity,
                voice_path.as_deref(),
                &ducking_values,
                rate,
                channels,
            )
        })
        .await
        .map_err(|_| "The audio mix worker stopped.")??;
        std::fs::remove_file(clip).map_err(|_| "A working audio clip could not be removed.")?;
    }
    let selection_filter = if ducking {
        range.map(|(from, to)| {
            format!(
                "atrim=start_sample={}:end_sample={},asetpts=PTS-STARTPTS",
                (from * f64::from(rate)).round() as u64,
                (to * f64::from(rate)).round() as u64
            )
        })
    } else {
        None
    };
    if input["loudnessLufs"].is_null() {
        let checked = master.clone();
        let frame_bytes = u64::from(channels) * 4;
        let (offset, length) = if ducking {
            range.map_or((0, capacity), |(from, to)| {
                let from = (from * f64::from(rate)).round() as u64;
                let to = (to * f64::from(rate)).round() as u64;
                (from * frame_bytes, (to - from) * frame_bytes)
            })
        } else {
            (0, capacity)
        };
        let peak =
            tokio::task::spawn_blocking(move || timeline_mix::peak(&checked, offset, length))
                .await
                .map_err(|_| "The production peak check stopped.")??;
        if peak > 1.0 {
            return Err("The production mix clips. Lower clip or background gains, or choose loudness and true-peak targets before exporting.".into());
        }
    }
    let normalization = if input["loudnessLufs"].is_null() {
        None
    } else {
        let loudness = finite(input, "loudnessLufs", -70.0, -5.0)?;
        let peak = finite(input, "truePeakDb", -9.0, 0.0)?;
        let mut measure = command(&encoder);
        measure.args(["-loglevel", "info"]);
        raw_input(&mut measure, &master, rate, channels);
        let filter = format!(
            "{}loudnorm=I={loudness}:TP={peak}:LRA=11:print_format=json",
            selection_filter
                .as_ref()
                .map_or(String::new(), |filter| format!("{filter},"))
        );
        measure.args(["-af", &filter, "-f", "null", "-"]);
        Some(measured_filter(&run(measure).await?, loudness, peak)?)
    };
    let mut encode = command(&encoder);
    encode.args(["-loglevel", "error"]);
    raw_input(&mut encode, &master, rate, channels);
    if format == "m4b" {
        let chapters = workspace.0.join("chapters.ffmetadata");
        let duration = range.map_or(full_duration, |(from, to)| to - from);
        write_new(
            &chapters,
            export_text::chapter_metadata(&clips(project, takes, input)?, duration)?.as_bytes(),
        )?;
        encode.args(["-f", "ffmetadata", "-i"]).arg(chapters);
    }
    encode.args([
        "-map",
        "0:a:0",
        "-ar",
        &rate.to_string(),
        "-ac",
        &channels.to_string(),
    ]);
    let filters: Vec<_> = selection_filter.into_iter().chain(normalization).collect();
    if !filters.is_empty() {
        encode.args(["-af", &filters.join(",")]);
    }
    match format {
        "wav" => {
            encode.args(["-c:a", "pcm_s24le", "-rf64", "auto", "-f", "wav"]);
        }
        "mp3" => {
            encode.args([
                "-c:a",
                "libmp3lame",
                "-b:a",
                &bitrate.to_string(),
                "-f",
                "mp3",
            ]);
        }
        "opus" => {
            encode.args(["-c:a", "libopus", "-b:a", &bitrate.to_string(), "-f", "ogg"]);
        }
        "flac" => {
            encode.args(["-c:a", "flac", "-f", "flac"]);
        }
        "m4b" => {
            encode.args([
                "-c:a",
                "aac",
                "-b:a",
                &bitrate.to_string(),
                "-map_metadata",
                "1",
                "-map_chapters",
                "1",
                "-f",
                "ipod",
            ]);
        }
        _ => return Err("Choose a supported audio export format.".into()),
    }
    encode.arg(output);
    run(encode).await?;
    reservation.ensure_live()?;
    workspace.finish()?;
    service.with_store(|store|reservation.release(store))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_uses_measured_values_and_rejects_silence() {
        let log = r#"{"input_i":"-19.7","input_tp":"-6.2","input_lra":"2.4","input_thresh":"-30.1","target_offset":"0.5"}"#;
        let filter = measured_filter(log, -16.0, -1.0).unwrap();
        assert!(filter.starts_with("volume=") && filter.ends_with("dB"));
        assert!((filter[7..filter.len() - 2].parse::<f64>().unwrap() - 3.7).abs() < 0.0001);
        assert!(measured_filter(log, -10.0, -1.0).is_err());
        assert!(measured_filter(&log.replace("-19.7", "-inf"), -16.0, -1.0).is_err());
    }
}
