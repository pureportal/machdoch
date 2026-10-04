use super::*;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use std::fs;

struct AudioWorkspace {
    root: std::path::PathBuf,
    paths: MediaRuntimePaths,
    request: GenerateMediaAudioRequest,
}

impl AudioWorkspace {
    fn new() -> Self {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("machdoch-audio-{}-{unique}", std::process::id()));
        let paths = MediaRuntimePaths {
            _storage_lease: None,
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let nodes = json!([
            {"id":"prompt","type":"source.prompt","version":1,"label":"Prompt","layer":"source","config":{"prompt":"Ocean waves"}},
            {"id":"generate","type":"task.generate-audio","version":1,"label":"Generate audio","layer":"task","config":{"modelId":null,"negativePrompt":"","durationSeconds":1,"numInferenceSteps":100,"guidanceScale":3.5,"seed":null}},
            {"id":"output","type":"output.audio","version":1,"label":"Save audio","layer":"output","config":{"format":"wav"}}
        ]);
        let save = serde_json::from_value(json!({"schemaVersion":1,"idempotencyKey":"save:audio","expectedHeadRevisionId":null,"changeSummary":"Audio test",
            "flow":{"schemaVersion":1,"id":"flow:audio","name":"Create audio","description":"","createdAt":"2026-10-03T12:00:00Z","updatedAt":"2026-10-03T12:00:00Z","variables":[],"variableBindings":{},"presets":[],"activePresetId":null,"nodes":nodes,
                "edges":[{"id":"prompt-generate","fromNodeId":"prompt","fromPortId":"prompt","toNodeId":"generate","toPortId":"prompt"},{"id":"generate-output","fromNodeId":"generate","fromPortId":"audio","toNodeId":"output","toPortId":"audio"}]},
            "layout":{"schemaVersion":1,"flowId":"flow:audio","nodes":[{"nodeId":"prompt","x":0,"y":0},{"nodeId":"generate","x":300,"y":0},{"nodeId":"output","x":600,"y":0}],"groups":[],"comments":[]}
        })).unwrap();
        let saved = serde_json::to_value(crate::media::flow::save(&paths, &save).unwrap()).unwrap();
        let request = serde_json::from_value(json!({"schemaVersion":1,"runId":"run:audio","flowId":"flow:audio","flowRevisionId":saved["revision"]["revisionId"],"flowName":"Create audio","planId":"plan:audio","modelId":"local:audioldm2","modelLabel":"AudioLDM 2","prompt":"Ocean waves","negativePrompt":"","durationSeconds":1,"numInferenceSteps":100,"guidanceScale":3.5,"seed":0,"diagnosticCount":0,
            "planSnapshot":{"schemaVersion":1,"planId":"plan:audio","flowId":"flow:audio","flowFingerprint":saved["revision"]["executionDigest"],"compiledAt":"2026-10-03T12:00:01Z","nodes":[{"id":"prompt","type":"source.prompt","label":"Prompt","layer":"source"},{"id":"generate","type":"task.generate-audio","label":"Generate audio","layer":"task"},{"id":"output","type":"output.audio","label":"Save audio","layer":"output"}],"steps":[{"id":"generate-audio","sourceNodeId":"generate","kind":"generate-audio","label":"Generate audio","target":"local","cacheable":true},{"id":"save-audio","sourceNodeId":"output","kind":"ingest-asset","label":"Save audio","target":"orchestrator","cacheable":false,"sideEffect":"asset-write"}]}
        })).unwrap();
        Self {
            root,
            paths,
            request,
        }
    }

    fn generated(&self) -> GeneratedAudio {
        let mut bytes = Vec::new();
        bytes.extend(b"RIFF");
        bytes.extend(32_036_u32.to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(16_u32.to_le_bytes());
        bytes.extend(1_u16.to_le_bytes());
        bytes.extend(1_u16.to_le_bytes());
        bytes.extend(16_000_u32.to_le_bytes());
        bytes.extend(32_000_u32.to_le_bytes());
        bytes.extend(2_u16.to_le_bytes());
        bytes.extend(16_u16.to_le_bytes());
        bytes.extend(b"data");
        bytes.extend(32_000_u32.to_le_bytes());
        for index in 0..16_000 {
            bytes.extend((if index % 2 == 0 { 100_i16 } else { -100_i16 }).to_le_bytes());
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let relative = std::path::Path::new(&digest[..2])
            .join(&digest[2..4])
            .join(&digest);
        let destination = self.paths.blobs.join(&relative);
        fs::create_dir_all(destination.parent().unwrap()).unwrap();
        fs::write(destination, &bytes).unwrap();
        GeneratedAudio {
            relative_path: relative.to_string_lossy().into(),
            output: AudioOutput {
                file_name: "output-0000.wav".into(),
                sample_rate: 16_000,
                channels: 1,
                frames: 16_000,
                duration_seconds: 1.0,
                seed: 0,
                digest,
                byte_size: bytes.len() as u64,
            },
            provenance: json!({"unitTest":true}),
        }
    }
}

impl Drop for AudioWorkspace {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn publishes_audio_with_exact_playback_and_original_export_bytes() {
    let mut workspace = AudioWorkspace::new();
    workspace.request.validate().unwrap();
    assert!(database::audio::begin(&workspace.paths, &workspace.request).unwrap());
    assert!(!database::audio::begin(&workspace.paths, &workspace.request).unwrap());
    let audio = workspace.generated();
    let detail = database::audio::complete(&workspace.paths, &workspace.request, &audio).unwrap();
    assert_eq!(detail.run.status, "completed");
    assert_eq!(detail.assets.len(), 1);
    let asset = &detail.assets[0];
    assert_eq!(asset.kind, "audio");
    let preview =
        crate::media::transform::read_asset_preview(&workspace.paths, &asset.id, 512).unwrap();
    let destination = workspace.root.join("export.wav");
    let export = crate::media::exporting::export_asset(
        &workspace.paths,
        &crate::media::MediaAssetExportRequest {
            asset_id: asset.id.clone(),
            destination_path: destination.to_string_lossy().into(),
            mode: crate::media::MediaAssetExportMode::VerifiedOriginal,
        },
    )
    .unwrap();
    assert_eq!(export.source_digest, audio.output.digest);
    assert_eq!(fs::read(destination).unwrap(), preview);
}

#[test]
fn rejects_modified_settings_before_claiming_a_saved_audio_run() {
    let mut workspace = AudioWorkspace::new();
    workspace.request.duration_seconds = 2.0;
    assert!(database::audio::begin(&workspace.paths, &workspace.request)
        .unwrap_err()
        .contains("settings changed"));
    assert!(database::get_run_detail(&workspace.paths, &workspace.request.run_id).is_err());
}

#[test]
fn cancellation_prevents_audio_publication() {
    let workspace = AudioWorkspace::new();
    database::audio::begin(&workspace.paths, &workspace.request).unwrap();
    database::request_cancellation(&workspace.paths, &workspace.request.run_id).unwrap();
    let detail =
        database::audio::complete(&workspace.paths, &workspace.request, &workspace.generated())
            .unwrap();
    assert_eq!(detail.run.status, "canceled");
    assert!(detail.assets.is_empty());
}

#[test]
fn audio_sampling_updates_its_node_while_the_library_polls() {
    let workspace = AudioWorkspace::new();
    database::audio::begin(&workspace.paths, &workspace.request).unwrap();
    let script = workspace.root.join("progress.py");
    fs::write(&script, r#"import json, sys, time
json.load(sys.stdin)
for index in range(8):
    print('MACHDOCH_PROGRESS ' + json.dumps({'stage': 'Sampling', 'progress': (index + 1) / 10}), file=sys.stderr, flush=True)
    time.sleep(0.02)
print(json.dumps({'unitTest': True}))
"#).unwrap();
    std::thread::scope(|scope| {
        scope.spawn(|| {
            for _ in 0..100 {
                database::get_run_detail(&workspace.paths, &workspace.request.run_id).unwrap();
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        });
        let mut process = std::process::Command::new("python");
        process.args(["-I", "-Xutf8"]).arg(script);
        let output = crate::media::model_memory::run(
            process,
            "generate-audio",
            Some(b"{}"),
            std::time::Duration::from_secs(10),
            Some((&workspace.paths, &workspace.request.run_id)),
        )
        .unwrap();
        assert!(output.status.success());
    });
    let detail = database::get_run_detail(&workspace.paths, &workspace.request.run_id).unwrap();
    assert_eq!(detail.run.progress, 0.8);
    assert_eq!(detail.run.current_step, "Sampling");
    let node = detail
        .node_executions
        .iter()
        .find(|node| node.node_id == "generate")
        .unwrap();
    assert_eq!(node.progress, Some(0.8));
    assert_eq!(node.status, "running");
}
