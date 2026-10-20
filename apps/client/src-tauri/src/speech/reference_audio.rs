use std::fs::OpenOptions;
use std::path::Path;
use std::io::{BufWriter,Seek,SeekFrom,Write};
use super::wave_file::{WaveReader,WaveSample};

pub fn trim(source: &Path, destination: &Path, from: f64, to: f64) -> Result<(), String> {
    let mut reader = WaveReader::open(source)?;
    let spec = reader.spec();
    let duration = reader.frames() as f64 / spec.sample_rate as f64;
    if !from.is_finite() || !to.is_finite() || from < 0.0 || to <= from || to > duration { return Err("Choose a trim range inside the recording.".into()); }
    let first_frame = (from * spec.sample_rate as f64).floor() as u64;
    let last_frame = ((to * spec.sample_rate as f64).ceil() as u64).min(reader.frames());
    let count=(last_frame-first_frame)*u64::from(spec.channels);
    if count.checked_mul(u64::from(spec.bits_per_sample/8)).is_none_or(|bytes|bytes>u64::from(u32::MAX)-64){return Err("Choose a shorter reference trim that fits the WAV recording format.".into());}
    reader.seek_frame(first_frame)?;
    let file = OpenOptions::new().create_new(true).write(true).open(destination).map_err(|_| "The trimmed recording could not be created.")?;
    let mut finalized=file.try_clone().map_err(|_|"The trimmed recording could not be finalized.")?;
    let mut writer = hound::WavWriter::new(BufWriter::with_capacity(65_536,file), spec).map_err(|_| "The trimmed recording could not be opened.")?;
    let mut written = 0u64;
    while written<count{
        match reader.next().ok_or("The recording ends before the trim range.")??{
            WaveSample::Float(sample)=>writer.write_sample(sample),
            WaveSample::Integer(sample)=>writer.write_sample(sample),
        }.map_err(|_|"The trimmed recording could not be written. Check free disk space.")?;
        written+=1;
    }
    writer.finalize().map_err(|_|"The trimmed recording could not be finalized.")?;
    let length=finalized.seek(SeekFrom::End(0)).map_err(|_|"The trimmed recording size could not be measured.")?;
    if length%2!=0{
        let size=u32::try_from(length+1-8).map_err(|_|"The trimmed recording exceeds the WAV container limit.")?;
        finalized.write_all(&[0]).and_then(|_|finalized.seek(SeekFrom::Start(4))).and_then(|_|finalized.write_all(&size.to_le_bytes())).map_err(|_|"The trimmed WAV padding could not be finalized.")?;
    }
    finalized.sync_all().map_err(|_|"The trimmed recording could not be saved.".into())
}

pub fn inspect_wav(path:&Path)->Result<(f64,u32,u16),String>{
    let mut reader=WaveReader::open(path)?;let spec=reader.spec();let duration=reader.frames() as f64/f64::from(spec.sample_rate);
    if spec.sample_format==hound::SampleFormat::Float{for sample in &mut reader{sample?;}}
    Ok((duration,spec.sample_rate,spec.channels))
}

#[cfg(test)]
#[path="reference_audio_tests.rs"]
mod tests;
