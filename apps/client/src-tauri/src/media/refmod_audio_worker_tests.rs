use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::io::Cursor;

#[test]
#[ignore = "requires MACHDOCH_MEDIA_PYTHON with GPU support and MACHDOCH_H3_AUDIO_VAE"]
fn refmod_audio_vae_creation_preview_and_export_without_generation_weights() {
    let python = PathBuf::from(
        std::env::var_os("MACHDOCH_MEDIA_PYTHON").expect("Set MACHDOCH_MEDIA_PYTHON"),
    );
    let checkpoint = PathBuf::from(
        std::env::var_os("MACHDOCH_H3_AUDIO_VAE").expect("Set MACHDOCH_H3_AUDIO_VAE"),
    );
    assert!(python.is_absolute() && python.is_file());
    assert!(checkpoint.is_absolute() && checkpoint.is_file());
    let fixture = Fixture::new();
    let directory = fixture.root.join("models/minimax-h3-ref2va");
    fs::create_dir_all(directory.join("vae")).unwrap();
    fs::copy(
        &checkpoint,
        directory.join("vae/minimax_h3_audio_vae_fp32.safetensors"),
    )
    .unwrap();
    let models =
        crate::media::refmod_models::resolve_model_directory(fixture.root.to_str().unwrap())
            .unwrap();
    assert!(
        crate::media::model_discovery::resolve_workspace_diffusers_package(
            fixture.root.to_str().unwrap(),
            "minimax-h3-ref2va",
            Some("minimax-h3-ref2va")
        )
        .is_err()
    );

    let source = fixture.root.join("stereo.wav");
    let specification = hound::WavSpec {
        channels: 2,
        sample_rate: 32000,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut writer = hound::WavWriter::create(&source, specification).unwrap();
    for index in 0..64000 {
        let time = index as f32 / 32000.0;
        writer
            .write_sample((std::f32::consts::TAU * 440.0 * time).sin() * 0.2)
            .unwrap();
        writer
            .write_sample((std::f32::consts::TAU * 880.0 * time).sin() * 0.15)
            .unwrap();
    }
    writer.finalize().unwrap();

    let destination = fixture.root.join("voice.safetensors");
    let created = refmod_worker_request(
        &python,
        serde_json::json!({
            "operation": "create", "modelPath": models, "outputPath": destination,
            "name": "Native voice", "concept": "voice", "description": "Stereo tone verification",
            "sources": [{"path": source, "kind": "audio"}], "maxSeconds": 2
        }),
    );
    assert_eq!(created["tokens"], 160);
    assert_eq!(
        created["members"][0]["shape"],
        serde_json::json!([1, 32, 2, 80])
    );
    assert_eq!(created["members"][0]["metadata"]["concept_type"], "voice");
    assert_eq!(
        created["members"][0]["metadata"]["description"],
        "Stereo tone verification"
    );

    let preview = refmod_worker_request(
        &python,
        serde_json::json!({
            "operation": "preview", "modelPath": models, "path": destination,
            "compare": true, "strength": 0.35
        }),
    );
    let previews = preview["previews"].as_array().unwrap();
    assert_eq!(preview["kind"], "audio");
    assert_eq!(previews.len(), 2);
    assert_ne!(previews[0], previews[1]);
    for value in previews {
        let encoded = value
            .as_str()
            .unwrap()
            .strip_prefix("data:audio/wav;base64,")
            .unwrap();
        let bytes = STANDARD.decode(encoded).unwrap();
        let mut audio = hound::WavReader::new(Cursor::new(bytes)).unwrap();
        assert_eq!(audio.spec().channels, 2);
        assert_eq!(audio.spec().sample_rate, 32000);
        assert_eq!(audio.duration(), 64000);
        assert!(audio.samples::<i16>().any(|sample| sample.unwrap() != 0));
    }

    let exported = refmod_worker_request(
        &python,
        serde_json::json!({
            "operation": "save", "outputPath": fixture.root.join("copies.safetensors"), "name": "Copies",
            "slots": [{"path": destination, "copies": 2, "audioStrength": 0.5}]
        }),
    );
    assert_eq!(exported["tokens"], 320);
    assert_eq!(exported["members"].as_array().unwrap().len(), 2);
    let restored = refmod_worker_request(
        &python,
        serde_json::json!({
            "operation": "inspect", "path": exported["path"]
        }),
    );
    assert_eq!(exported, restored);
    assert!(destination.is_file() && checkpoint.is_file());
    release_idle().unwrap();
}
