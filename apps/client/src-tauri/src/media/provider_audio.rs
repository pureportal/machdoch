use super::*;
use crate::media::{
    audio::{AudioOutput, GeneratedAudio},
    GenerateMediaAudioRequest,
};

pub(crate) fn generate_audio(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &GenerateMediaAudioRequest,
) -> MediaResult<GeneratedAudio> {
    let script = worker_script(app)?;
    let (_, python) = ready_runtime(app, &script)?;
    let model = installed_model(paths, &request.model_id)?;
    if model.architecture != "audioldm-2" {
        return Err("Choose an AudioLDM 2 model.".into());
    }
    let staging = create_staging_directory(paths)?;
    let payload = serde_json::json!({
        "schemaVersion": WORKER_SCHEMA_VERSION,
        "model": WorkerModel { id: &model.id, architecture: &model.architecture, package_kind: &model.package_kind,
            path: &model.path, config_path: None, revision: &model.revision, digest: &model.digest },
        "prompt": request.prompt, "negativePrompt": request.negative_prompt,
        "durationSeconds": request.duration_seconds, "numInferenceSteps": request.num_inference_steps,
        "guidanceScale": request.guidance_scale, "seed": request.seed, "outputDirectory": staging.0,
    });
    subject_cutout::release_session()?;
    let process = run_worker(
        &python,
        &script,
        "generate-audio",
        Some(&serde_json::to_vec(&payload).map_err(|error| error.to_string())?),
        GENERATION_TIMEOUT,
        Some((paths, &request.run_id)),
    )?;
    if !process.status.success() {
        let message = serde_json::from_slice::<WorkerFailure>(&process.stdout)
            .map(|failure| failure.error)
            .unwrap_or_else(|_| "Audio generation failed.".into());
        return Err(worker_failure_with_diagnostics(message, &process.stderr));
    }
    let provenance: serde_json::Value = serde_json::from_slice(&process.stdout)
        .map_err(|error| format!("Audio worker returned invalid JSON: {error}"))?;
    let output: AudioOutput = serde_json::from_value(provenance["output"].clone())
        .map_err(|error| format!("Audio worker returned invalid metadata: {error}"))?;
    if provenance["schemaVersion"] != WORKER_SCHEMA_VERSION
        || provenance["modelDigest"] != model.digest
        || provenance["modelRevision"] != model.revision
        || provenance["modelArchitecture"] != model.architecture
        || provenance["prompt"] != request.prompt
        || provenance["negativePrompt"] != request.negative_prompt
        || provenance["numInferenceSteps"] != request.num_inference_steps
        || provenance["guidanceScale"] != request.guidance_scale
        || output.file_name != "output-0000.wav"
        || output.seed != request.seed
        || output.sample_rate != 16_000
        || output.channels != 1
        || output.frames
            != (request.duration_seconds * f64::from(output.sample_rate)).round() as u64
        || (output.duration_seconds - request.duration_seconds).abs()
            > 1.0 / f64::from(output.sample_rate)
    {
        return Err("Audio worker returned mismatched generation evidence.".into());
    }
    let source = staging.0.join(&output.file_name);
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| format!("Could not inspect generated audio: {error}"))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != output.byte_size
        || metadata.len() > 64 * 1024 * 1024
    {
        return Err("Generated audio is not a bounded regular file.".into());
    }
    let bytes =
        fs::read(&source).map_err(|error| format!("Could not read generated audio: {error}"))?;
    if bytes.len() as u64 != output.byte_size
        || output.byte_size > 64 * 1024 * 1024
        || format!("{:x}", Sha256::digest(&bytes)) != output.digest
    {
        return Err("Generated audio failed integrity checks.".into());
    }
    validate_wave(&bytes, &output)?;
    let relative = Path::new(&output.digest[..2])
        .join(&output.digest[2..4])
        .join(&output.digest);
    let destination = paths.blobs.join(&relative);
    fs::create_dir_all(
        destination
            .parent()
            .ok_or("Audio storage path is invalid")?,
    )
    .map_err(|error| error.to_string())?;
    crate::atomic_file::write_file_atomic(
        &destination,
        &bytes,
        crate::atomic_file::AtomicWriteOptions::default(),
    )
    .map_err(|error| error.to_string())?;
    Ok(GeneratedAudio {
        relative_path: relative.to_string_lossy().into(),
        output,
        provenance,
    })
}

fn validate_wave(bytes: &[u8], output: &AudioOutput) -> MediaResult<()> {
    if bytes.len() < 44
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WAVE"
        || &bytes[12..16] != b"fmt "
        || &bytes[36..40] != b"data"
        || u32::from_le_bytes(bytes[16..20].try_into().unwrap()) != 16
        || u16::from_le_bytes(bytes[20..22].try_into().unwrap()) != 1
        || u16::from_le_bytes(bytes[22..24].try_into().unwrap()) != output.channels
        || u32::from_le_bytes(bytes[24..28].try_into().unwrap()) != output.sample_rate
        || u32::from_le_bytes(bytes[28..32].try_into().unwrap()) != output.sample_rate * 2
        || u16::from_le_bytes(bytes[32..34].try_into().unwrap()) != 2
        || u16::from_le_bytes(bytes[34..36].try_into().unwrap()) != 16
        || u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize + 8 != bytes.len()
        || u32::from_le_bytes(bytes[40..44].try_into().unwrap()) as u64 != output.frames * 2
        || bytes.len() as u64 != 44 + output.frames * 2
    {
        return Err("Generated WAV is invalid or incomplete.".into());
    }
    if bytes[44..].chunks_exact(2).all(|sample| sample == [0, 0]) {
        return Err("Generated audio is silent. Change the prompt or seed and retry.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_silent_truncated_and_mislabeled_pcm() {
        let mut bytes = Vec::new();
        bytes.extend(b"RIFF");
        bytes.extend(40_u32.to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(16_u32.to_le_bytes());
        bytes.extend(1_u16.to_le_bytes());
        bytes.extend(1_u16.to_le_bytes());
        bytes.extend(16_000_u32.to_le_bytes());
        bytes.extend(32_000_u32.to_le_bytes());
        bytes.extend(2_u16.to_le_bytes());
        bytes.extend(16_u16.to_le_bytes());
        bytes.extend(b"data");
        bytes.extend(4_u32.to_le_bytes());
        bytes.extend(300_i16.to_le_bytes());
        bytes.extend((-300_i16).to_le_bytes());
        let output = AudioOutput {
            file_name: "output-0000.wav".into(),
            sample_rate: 16_000,
            channels: 1,
            frames: 2,
            duration_seconds: 0.000125,
            seed: 0,
            digest: String::new(),
            byte_size: 48,
        };
        assert!(validate_wave(&bytes, &output).is_ok());
        assert!(validate_wave(&bytes[..47], &output).is_err());
        for (offset, replacement) in [(22, 2), (28, 1), (32, 1), (34, 8), (40, 3)] {
            let mut corrupted = bytes.clone();
            corrupted[offset] = replacement;
            assert!(
                validate_wave(&corrupted, &output).is_err(),
                "offset {offset}"
            );
        }
        bytes[44..].fill(0);
        assert!(validate_wave(&bytes, &output)
            .unwrap_err()
            .contains("silent"));
    }
}
