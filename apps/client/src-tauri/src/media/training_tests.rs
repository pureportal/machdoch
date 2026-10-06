use super::super::database;
use super::*;
#[cfg(target_os = "windows")]
use crate::child_process::SupervisedChild;
use rusqlite::params;
use sha2::Digest as _;
#[cfg(target_os = "windows")]
use std::process::{Command, Stdio};
#[cfg(target_os = "windows")]
use sysinfo::{Pid, System};

struct TestWorkspace {
    root: PathBuf,
    paths: MediaRuntimePaths,
}

impl TestWorkspace {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "media-training-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(root.join("models")).unwrap();
        Self {
            paths: MediaRuntimePaths {
                database: root.join("media.sqlite3"),
                blobs: root.join("blobs"),
                _storage_lease: None,
            },
            root,
        }
    }

    fn install_sdxl(&self, package_type: &str) -> TrainingModel {
        database::ensure_initialized(&self.paths).unwrap();
        let connection = database::open(&self.paths).unwrap();
        connection
            .execute(
                "INSERT INTO media_providers(
                id, display_name, target, lifecycle, capabilities_json, privacy_summary,
                checked_at, stale_after_seconds, catalog_revision, updated_at
             ) VALUES ('local-diffusers', 'Local', 'local', 'active', '[]', 'Local',
                       'now', 0, 'test', 'now')",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO media_models(
                id, provider_id, display_name, family, target, lifecycle,
                lifecycle_checked_at, lifecycle_stale_after_seconds, catalog_revision,
                capabilities_json, bundled, package_type, license_name, license_source_url,
                license_commercial_use, license_requires_acceptance, recommended,
                speed_score, quality_score, privacy_summary, updated_at, architecture
             ) VALUES ('test-sdxl', 'local-diffusers', 'SDXL', 'SDXL', 'local', 'active',
                       'now', 0, 'test', '[]', 0, ?1, 'Test', '', 'unknown', 0, 0,
                       0, 0, 'Local', 'now', 'stable-diffusion-xl')",
                [package_type],
            )
            .unwrap();
        let relative = "packages/sdxl/revisions/revision-1";
        let package = self.paths.models_root().unwrap().join(relative);
        fs::create_dir_all(&package).unwrap();
        if package_type == "safetensors" {
            fs::write(package.join("checkpoint.safetensors"), b"fixture").unwrap();
            fs::create_dir(package.join("config")).unwrap();
        } else {
            fs::write(
                package.join("model_index.json"),
                br#"{"_class_name":"StableDiffusionXLPipeline"}"#,
            )
            .unwrap();
        }
        connection
            .execute(
                "INSERT INTO media_model_installations(
                model_id, revision, status, manifest_digest, updated_at, relative_path
             ) VALUES ('test-sdxl', 'revision-1', 'installed', ?1, 'now', ?2)",
                params![
                    if package_type == "safetensors" {
                        format!("{:x}", sha2::Sha256::digest(b"fixture"))
                    } else {
                        "a".repeat(64)
                    },
                    relative
                ],
            )
            .unwrap();
        installed_training_model(&self.paths, "test-sdxl").unwrap()
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn request() -> TrainingRequest {
    TrainingRequest {
        name: "Portrait".into(),
        concept: TrainingConcept::Face,
        trigger_phrase: "sks person".into(),
        samples: (0..3)
            .map(|index| TrainingSample {
                path: PathBuf::from(format!("source-{index}.png")),
                caption: format!("portrait {index}"),
            })
            .collect(),
        architecture: TrainingArchitecture::Krea2,
        model_id: None,
        model_path: PathBuf::from("Krea-2-Raw"),
        steps: 1000,
        learning_rate: 0.0003,
        resolution: 768,
        rank: 32,
        attention_only: false,
        four_bit: true,
        seed: 42,
        options: options(),
        video: None,
    }
}

fn options() -> TrainingOptions {
    serde_json::from_value(serde_json::json!({
        "method": "lora", "precision": "bf16", "optimizer": "adamw", "trainablePrecision": "float32", "batchSize": 1, "gradientAccumulation": 1,
        "lrScheduler": "constant", "warmupSteps": 0, "weightDecay": 0.01, "maxGradNorm": 1.0,
        "snrGamma": 0.0, "noiseOffset": 0.0, "loraDropout": 0.0, "guidanceScale": 3.5,
        "checkpointInterval": 250, "checkpointRetention": 2, "gradientCheckpointing": true,
        "preserveAspectRatio": false, "initializerToken": ""
    }))
    .unwrap()
}

fn raw_model(root: &Path) -> PathBuf {
    let model = root.join("Krea-2-Raw");
    fs::create_dir(&model).unwrap();
    fs::write(
        model.join("model_index.json"),
        br#"{"_class_name":"Krea2Pipeline","is_distilled":false}"#,
    )
    .unwrap();
    for component in ["transformer", "text_encoder", "vae"] {
        fs::create_dir(model.join(component)).unwrap();
        fs::write(model.join(component).join("model.safetensors"), b"weight").unwrap();
    }
    fs::create_dir(model.join("tokenizer")).unwrap();
    fs::write(model.join("tokenizer/tokenizer.json"), b"{}").unwrap();
    fs::create_dir(model.join("scheduler")).unwrap();
    fs::write(model.join("scheduler/scheduler_config.json"), b"{}").unwrap();
    model
}

#[test]
fn request_accepts_canonical_fields_and_rejects_invalid_identities() {
    let value = serde_json::json!({
        "name": "Portrait", "concept": "face", "triggerPhrase": "sks person",
        "samples": [
            {"path": "a.png", "caption": ""},
            {"path": "b.png", "caption": ""},
            {"path": "c.png", "caption": ""}
        ],
        "architecture": "stable-diffusion-xl", "modelId": "test-sdxl",
        "modelPath": "checkpoint.safetensors", "steps": 1, "learningRate": 0.00001,
        "resolution": 512, "rank": 4, "attentionOnly": true, "fourBit": false,
        "seed": 4294967295u32, "options": options(), "video": null
    });
    let parsed: TrainingRequest = serde_json::from_value(value.clone()).unwrap();
    validate_request(&parsed).unwrap();
    assert_eq!(parsed.seed, u32::MAX);
    for (field, invalid) in [
        ("architecture", serde_json::json!("unknown-model")),
        ("concept", serde_json::json!("unknown")),
        ("seed", serde_json::json!(4294967296u64)),
        ("rawModelPath", serde_json::json!("old-name")),
    ] {
        let mut changed = value.clone();
        changed[field] = invalid;
        assert!(serde_json::from_value::<TrainingRequest>(changed).is_err());
    }
    let job = TrainingJob {
        id: "training-1".into(),
        name: parsed.name,
        concept: parsed.concept,
        trigger_phrase: parsed.trigger_phrase,
        architecture: parsed.architecture,
        method: parsed.options.method,
        base_model_id: parsed.model_id,
    };
    assert_eq!(
        serde_json::to_value(job).unwrap(),
        serde_json::json!({
            "id": "training-1", "name": "Portrait", "concept": "face",
            "triggerPhrase": "sks person", "architecture": "stable-diffusion-xl", "method": "lora",
            "baseModelId": "test-sdxl"
        })
    );
}

#[test]
fn video_datasets_require_matching_architectures_and_temporal_settings() {
    let mut video_request = request();
    video_request.architecture = TrainingArchitecture::CogVideoX2B;
    video_request.model_id = Some("cogvideo-test".into());
    video_request.four_bit = false;
    video_request.video = Some(TrainingVideoSettings {
        width: 720,
        height: 480,
        frames: 49,
        fps: 8,
        image_dropout: 0.0,
    });
    validate_request(&video_request).unwrap();
    let serialized = serde_json::to_value(JobSpec::new(
        &video_request,
        TrainingModel {
            id: Some("cogvideo-test".into()),
            architecture: TrainingArchitecture::CogVideoX2B,
            package_kind: "diffusers-directory".into(),
            path: PathBuf::from("model"),
            config_path: None,
            revision: None,
            digest: None,
        },
    ))
    .unwrap();
    assert_eq!(serialized["video"]["frames"], 49);
    for invalid in [
        TrainingVideoSettings {
            width: 719,
            height: 480,
            frames: 49,
            fps: 8,
            image_dropout: 0.0,
        },
        TrainingVideoSettings {
            width: 720,
            height: 480,
            frames: 48,
            fps: 8,
            image_dropout: 0.0,
        },
        TrainingVideoSettings {
            width: 2048,
            height: 2048,
            frames: 161,
            fps: 8,
            image_dropout: 0.0,
        },
        TrainingVideoSettings {
            width: 720,
            height: 480,
            frames: 49,
            fps: 0,
            image_dropout: 0.0,
        },
        TrainingVideoSettings {
            width: 720,
            height: 480,
            frames: 49,
            fps: 8,
            image_dropout: f64::NAN,
        },
    ] {
        let mut changed = video_request.clone();
        changed.video = Some(invalid);
        assert!(validate_request(&changed).is_err());
    }
    video_request.video.as_mut().unwrap().image_dropout = 0.1;
    assert!(validate_request(&video_request)
        .unwrap_err()
        .contains("Image dropout"));
    video_request.architecture = TrainingArchitecture::CogVideoX15_5BI2V;
    validate_request(&video_request).unwrap();
    video_request.options.snr_gamma = 5.0;
    assert!(validate_request(&video_request)
        .unwrap_err()
        .contains("Min-SNR"));
    video_request.options.snr_gamma = 0.0;
    video_request.video = None;
    assert!(validate_request(&video_request).is_err());
    let mut image_request = request();
    image_request.video = Some(TrainingVideoSettings {
        width: 720,
        height: 480,
        frames: 49,
        fps: 8,
        image_dropout: 0.0,
    });
    assert!(validate_request(&image_request).is_err());
}

#[test]
fn training_settings_enforce_ranges_and_sdxl_constraints() {
    let mut request = request();
    for steps in [1, 10_000] {
        for rank in [4, 8, 16, 32, 64] {
            request.steps = steps;
            request.rank = rank;
            validate_request(&request).unwrap();
        }
    }
    for steps in [0, 10_001] {
        request.steps = steps;
        assert!(validate_request(&request).is_err());
    }
    request.steps = 1;
    for rate in [f64::NAN, f64::INFINITY, 0.0000009, 0.010001] {
        request.learning_rate = rate;
        assert!(validate_request(&request).is_err());
    }
    for rate in [0.00001, 0.001] {
        request.learning_rate = rate;
        validate_request(&request).unwrap();
    }
    for resolution in [512, 768, 1024] {
        request.resolution = resolution;
        validate_request(&request).unwrap();
    }
    request.rank = 12;
    assert!(validate_request(&request).is_err());
    request.rank = 8;
    request.resolution = 640;
    assert!(validate_request(&request).is_err());
    request.resolution = 512;
    request.architecture = TrainingArchitecture::StableDiffusionXl;
    request.model_id = Some("test-sdxl".into());
    request.attention_only = true;
    request.four_bit = false;
    validate_request(&request).unwrap();
    request.four_bit = true;
    assert!(validate_request(&request).is_err());
    request.four_bit = false;
    request.attention_only = false;
    validate_request(&request).unwrap();
    request.attention_only = true;
    for id in [None, Some(String::new()), Some(" ".into())] {
        request.model_id = id;
        assert!(validate_request(&request).is_err());
    }
}

#[test]
fn adafactor_settings_validate_bf16_finetuning_and_reject_incompatible_controls() {
    let mut request = request();
    request.architecture = TrainingArchitecture::StableDiffusionXl;
    request.model_id = Some("installed-model".into());
    request.four_bit = false;
    request.options.method = TrainingMethod::Finetune;
    request.options.optimizer = TrainingOptimizer::Adafactor;
    request.options.trainable_precision = TrainingWeightPrecision::Bf16;
    request.options.max_grad_norm = 0.0;
    validate_request(&request).unwrap();
    let valid = request.options.clone();
    for patch in [
        serde_json::json!({"method": "lora"}),
        serde_json::json!({"method": "embedding"}),
        serde_json::json!({"precision": "fp16"}),
        serde_json::json!({"optimizer": "adamw"}),
        serde_json::json!({"maxGradNorm": 1}),
    ] {
        let mut value = serde_json::to_value(&valid).unwrap();
        for (key, value_patch) in patch.as_object().unwrap() {
            value[key] = value_patch.clone();
        }
        request.options = serde_json::from_value(value).unwrap();
        assert!(validate_request(&request).is_err());
    }
    request.options = valid;
    request.options.trainable_precision = TrainingWeightPrecision::Float32;
    request.options.method = TrainingMethod::Lora;
    validate_request(&request).unwrap();
    request.architecture = TrainingArchitecture::Krea2;
    assert!(validate_request(&request).is_err());
}

#[test]
fn stable_diffusion_families_validate_finetune_and_embedding_settings() {
    let mut request = request();
    request.four_bit = false;
    request.model_id = Some("installed-model".into());
    for architecture in [
        TrainingArchitecture::StableDiffusion1,
        TrainingArchitecture::StableDiffusion2,
        TrainingArchitecture::StableDiffusionXl,
        TrainingArchitecture::Pony,
    ] {
        request.architecture = architecture;
        for method in [
            TrainingMethod::Lora,
            TrainingMethod::Finetune,
            TrainingMethod::Embedding,
        ] {
            request.options.method = method;
            request.trigger_phrase = "<portrait>".into();
            request.options.initializer_token = "person".into();
            validate_request(&request).unwrap();
        }
    }
    request.trigger_phrase = "two words".into();
    assert!(validate_request(&request).is_err());
    request.trigger_phrase = "<portrait>".into();
    request.options.initializer_token.clear();
    assert!(validate_request(&request).is_err());
    request.architecture = TrainingArchitecture::Krea2;
    request.options.method = TrainingMethod::Finetune;
    assert!(validate_request(&request).is_err());
}

#[test]
fn completed_status_exposes_the_correct_finetune_and_embedding_artifacts() {
    let workspace = TestWorkspace::new();
    let mut request = request();
    request.model_path = raw_model(&workspace.root);
    let model = resolve_model(&workspace.paths, &request).unwrap();
    let mut spec = JobSpec::new(&request, model);
    spec.architecture = TrainingArchitecture::StableDiffusionXl;
    spec.model.architecture = spec.architecture;
    for (method, artifact) in [
        (TrainingMethod::Finetune, "model"),
        (TrainingMethod::Embedding, "learned_embeds.safetensors"),
    ] {
        let id = format!("training-{method:?}").to_lowercase();
        let directory = job_directory(&workspace.paths, &id).unwrap();
        fs::create_dir_all(directory.join("output")).unwrap();
        spec.options.method = method;
        fs::write(
            directory.join("job.json"),
            serde_json::to_vec(&spec).unwrap(),
        )
        .unwrap();
        fs::write(
            directory.join("status.json"),
            br#"{"state":"completed","message":null}"#,
        )
        .unwrap();
        assert_eq!(status(&workspace.paths, &id).unwrap().state, "failed");
        let output = directory.join("output").join(artifact);
        if method == TrainingMethod::Finetune {
            fs::create_dir(&output).unwrap();
            fs::write(output.join("model_index.json"), b"{}").unwrap();
        } else {
            fs::write(&output, b"weights").unwrap();
        }
        fs::write(
            directory.join("progress.json"),
            serde_json::json!({
                "completedSteps": 1000, "totalSteps": 1000, "loss": 0.25,
                "learningRate": 0.0001, "elapsedSeconds": 120, "remainingSeconds": 0
            })
            .to_string(),
        )
        .unwrap();
        let completed = status(&workspace.paths, &id).unwrap();
        assert_eq!(completed.state, "completed");
        assert_eq!(completed.output_path, Some(output));
        assert_eq!(completed.progress.unwrap().loss, 0.25);
    }
}

#[test]
fn embedding_captions_include_the_exact_token_before_long_descriptions() {
    let workspace = TestWorkspace::new();
    let mut request = request();
    request.options.method = TrainingMethod::Embedding;
    request.trigger_phrase = "<portrait>".into();
    for (index, source) in request.samples.iter_mut().enumerate() {
        source.path = workspace.root.join(format!("embedding-{index}.png"));
        image::RgbaImage::new(32, 24).save(&source.path).unwrap();
    }
    request.samples[0].caption = "<PORTRAIT> in a studio".into();
    request.samples[1].caption = "detailed photograph ".repeat(100);
    request.samples[2].caption = "<portrait> on a street".into();
    let dataset = workspace.root.join("embedding-dataset");
    prepare_dataset(None, &request, &dataset).unwrap();
    let records: Vec<serde_json::Value> = fs::read_to_string(dataset.join("metadata.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(records[0]["text"], "<portrait>, <PORTRAIT> in a studio");
    assert!(records[1]["text"]
        .as_str()
        .unwrap()
        .starts_with("<portrait>, "));
    assert_eq!(records[2]["text"], "<portrait> on a street");
}

#[test]
fn raw_dataset_validation_decodes_images_and_preserves_captions() {
    let workspace = TestWorkspace::new();
    let mut request = request();
    request.model_path = raw_model(&workspace.root);
    for (index, source) in request.samples.iter_mut().enumerate() {
        source.path = workspace.root.join(format!("source-{index}.png"));
        image::RgbaImage::new(32, 24).save(&source.path).unwrap();
    }
    request.samples[0].caption.clear();
    request.samples[2].caption = "Sks Person in a studio".into();
    validate_request(&request).unwrap();
    let model = resolve_model(&workspace.paths, &request).unwrap();
    assert_eq!(model.path, request.model_path.canonicalize().unwrap());
    let inspected = inspect_images(
        request
            .samples
            .iter()
            .map(|image| image.path.clone())
            .collect(),
    )
    .unwrap();
    assert_eq!((inspected[0].width, inspected[0].height), (32, 24));
    let dataset = workspace.root.join("dataset");
    prepare_dataset(None, &request, &dataset).unwrap();
    let lines: Vec<serde_json::Value> = fs::read_to_string(dataset.join("metadata.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines[0]["text"], "sks person");
    assert_eq!(lines[1]["text"], "portrait 1, sks person");
    assert_eq!(lines[2]["text"], "Sks Person in a studio");
    assert!(dataset.join("image-001.png").is_file());
    fs::write(&request.samples[0].path, b"\x89PNG\r\n\x1a\ntruncated").unwrap();
    assert!(inspect_images(vec![request.samples[0].path.clone()])
        .unwrap_err()
        .contains("could not be decoded"));
    fs::remove_file(request.model_path.join("transformer/model.safetensors")).unwrap();
    assert!(validate_raw_model(&request.model_path)
        .unwrap_err()
        .contains("transformer weights"));
    fs::write(
        request.model_path.join("transformer/model.safetensors"),
        b"weight",
    )
    .unwrap();
    fs::write(
        request.model_path.join("model_index.json"),
        br#"{"_class_name":"Krea2Pipeline","is_distilled":true}"#,
    )
    .unwrap();
    assert!(validate_raw_model(&request.model_path).is_err());
}

#[test]
fn sdxl_resolves_installed_single_file_identity_and_rejects_changed_jobs() {
    let workspace = TestWorkspace::new();
    let installed = workspace.install_sdxl("safetensors");
    let mut request = request();
    request.architecture = TrainingArchitecture::StableDiffusionXl;
    request.model_id = installed.id.clone();
    request.model_path = PathBuf::new();
    request.attention_only = true;
    request.four_bit = false;
    let model = resolve_model(&workspace.paths, &request).unwrap();
    assert_eq!(model, installed);
    assert_eq!(model.package_kind, "single-file");
    assert!(model.config_path.as_ref().unwrap().is_dir());
    assert_eq!(
        resolve_model(&workspace.paths, &request).unwrap(),
        installed
    );
    request.model_path = installed.path.clone();
    assert_eq!(
        resolve_model(&workspace.paths, &request).unwrap(),
        installed
    );
    request.model_path = workspace.root.clone();
    assert!(resolve_model(&workspace.paths, &request)
        .unwrap_err()
        .contains("does not match"));
    request.model_path = PathBuf::new();
    let spec = JobSpec::new(&request, model);
    validate_job_model(&workspace.paths, &spec).unwrap();
    let connection = database::open(&workspace.paths).unwrap();
    for (revision, digest) in [
        ("revision-2", "a".repeat(64)),
        ("revision-1", "b".repeat(64)),
    ] {
        connection
            .execute(
                "UPDATE media_model_installations SET revision = ?1, manifest_digest = ?2",
                params![revision, digest],
            )
            .unwrap();
        assert!(validate_job_model(&workspace.paths, &spec).is_err());
    }
    connection
        .execute(
            "UPDATE media_model_installations SET status = 'not-installed'",
            [],
        )
        .unwrap();
    assert!(installed_training_model(&workspace.paths, "test-sdxl").is_err());
}

#[test]
fn krea_raw_resolves_installed_identity_and_rejects_changed_or_distilled_bases() {
    let workspace = TestWorkspace::new();
    let installed = workspace.install_sdxl("diffusers");
    let raw = raw_model(&installed.path);
    let connection = database::open(&workspace.paths).unwrap();
    connection
        .execute("UPDATE media_models SET architecture = 'krea-2-raw'", [])
        .unwrap();
    connection
        .execute(
            "UPDATE media_model_installations SET relative_path = ?1",
            ["packages/sdxl/revisions/revision-1/Krea-2-Raw"],
        )
        .unwrap();
    let mut request = request();
    request.model_id = installed.id;
    request.model_path = PathBuf::new();
    let model = resolve_model(&workspace.paths, &request).unwrap();
    assert_eq!(model.architecture, TrainingArchitecture::Krea2);
    assert_eq!(model.path, raw.canonicalize().unwrap());
    assert_eq!(model.id, request.model_id);
    assert_eq!(model.revision.as_deref(), Some("revision-1"));
    let spec = JobSpec::new(&request, model);
    validate_job_model(&workspace.paths, &spec).unwrap();
    request.model_path = workspace.root.clone();
    assert!(resolve_model(&workspace.paths, &request).is_err());
    connection
        .execute(
            "UPDATE media_model_installations SET revision = 'revision-2'",
            [],
        )
        .unwrap();
    assert!(validate_job_model(&workspace.paths, &spec).is_err());
    connection
        .execute(
            "UPDATE media_model_installations SET revision = 'revision-1'",
            [],
        )
        .unwrap();
    fs::write(
        raw.join("model_index.json"),
        br#"{"_class_name":"Krea2Pipeline","is_distilled":true}"#,
    )
    .unwrap();
    assert!(validate_job_model(&workspace.paths, &spec).is_err());
    connection
        .execute("UPDATE media_models SET architecture = 'krea-2'", [])
        .unwrap();
    assert!(installed_training_model(&workspace.paths, "test-sdxl")
        .unwrap_err()
        .contains("not Turbo"));
}

#[test]
fn sdxl_directory_rejects_wrong_architecture_and_unsafe_database_paths() {
    let workspace = TestWorkspace::new();
    let model = workspace.install_sdxl("diffusers");
    assert_eq!(model.package_kind, "diffusers-directory");
    assert!(model.path.is_dir());
    assert_eq!(model.config_path, None);
    let connection = database::open(&workspace.paths).unwrap();
    connection
        .execute("UPDATE media_models SET architecture = 'flux-2-dev'", [])
        .unwrap();
    assert!(installed_training_model(&workspace.paths, "test-sdxl")
        .unwrap_err()
        .contains("no integrated training runtime"));
    connection
        .execute(
            "UPDATE media_models SET architecture = 'stable-diffusion-xl'",
            [],
        )
        .unwrap();
    for relative in ["../outside", "", "packages/../../outside"] {
        connection
            .execute(
                "UPDATE media_model_installations SET relative_path = ?1",
                [relative],
            )
            .unwrap();
        assert!(installed_training_model(&workspace.paths, "test-sdxl").is_err());
    }
    assert!(installed_training_model(&workspace.paths, "missing-model").is_err());
}

#[test]
fn job_spec_uses_python_contract_and_frozen_camel_case_model_identity() {
    let workspace = TestWorkspace::new();
    let model = workspace.install_sdxl("safetensors");
    let mut request = request();
    request.architecture = TrainingArchitecture::StableDiffusionXl;
    request.attention_only = true;
    request.four_bit = false;
    request.seed = 17;
    let spec = JobSpec::new(&request, model);
    let value = serde_json::to_value(&spec).unwrap();
    let mut keys: Vec<&str> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    assert_eq!(
        keys,
        [
            "architecture",
            "attention_only",
            "four_bit",
            "learning_rate",
            "model",
            "options",
            "rank",
            "resolution",
            "resume",
            "seed",
            "steps",
            "trigger_phrase",
            "video"
        ]
    );
    assert_eq!(value["architecture"], "stable-diffusion-xl");
    assert_eq!(value["model"]["architecture"], value["architecture"]);
    assert_eq!(value["model"]["id"], "test-sdxl");
    assert_eq!(value["model"]["packageKind"], "single-file");
    assert!(value["model"]["configPath"].is_string());
    assert_eq!(value["model"]["revision"], "revision-1");
    assert_eq!(
        value["model"]["digest"],
        spec.model.digest.as_deref().unwrap()
    );
    assert_eq!(value["options"]["checkpointInterval"], 250);
    assert_eq!(value["seed"], 17);
    let decoded: JobSpec = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.model, spec.model);
    validate_job_model(&workspace.paths, &decoded).unwrap();
}

#[test]
fn status_preserves_output_and_resumable_checkpoint_lifecycle() {
    let workspace = TestWorkspace::new();
    let mut request = request();
    request.model_path = raw_model(&workspace.root);
    let model = resolve_model(&workspace.paths, &request).unwrap();
    let spec = JobSpec::new(&request, model);
    let directory = job_directory(&workspace.paths, "training-test").unwrap();
    fs::create_dir_all(directory.join("output")).unwrap();
    fs::write(
        directory.join("job.json"),
        serde_json::to_vec(&spec).unwrap(),
    )
    .unwrap();
    fs::write(
        directory.join("training.log"),
        b"Steps: 12/1000\rSteps: 37/1000",
    )
    .unwrap();
    assert_eq!(
        status(&workspace.paths, "training-test").unwrap().state,
        "interrupted"
    );
    fs::write(
        directory.join("output/checkpoint-37"),
        b"not a checkpoint directory",
    )
    .unwrap();
    assert!(!has_checkpoint(
        &directory,
        TrainingArchitecture::StableDiffusionXl
    ));
    fs::remove_file(directory.join("output/checkpoint-37")).unwrap();
    fs::create_dir(directory.join("output/checkpoint-37")).unwrap();
    assert!(!has_checkpoint(
        &directory,
        TrainingArchitecture::StableDiffusionXl
    ));
    fs::write(directory.join("output/checkpoint-37/state.pt"), b"state").unwrap();
    fs::write(
        directory.join("output/checkpoint-37/weights.safetensors"),
        b"adapter",
    )
    .unwrap();
    fs::write(
        directory.join("output/checkpoint-37/pytorch_lora_weights.safetensors"),
        b"weights",
    )
    .unwrap();
    cancel(&workspace.paths, "training-test").unwrap();
    let cancelled = status(&workspace.paths, "training-test").unwrap();
    assert_eq!(cancelled.state, "cancelled");
    assert!(cancelled.can_resume);
    assert_eq!(cancelled.completed_steps, Some(37));
    fs::write(
        directory.join("status.json"),
        br#"{"state":"completed","message":null}"#,
    )
    .unwrap();
    let missing = status(&workspace.paths, "training-test").unwrap();
    assert_eq!(missing.state, "failed");
    assert!(missing.message.unwrap().contains("weights are missing"));
    let output = directory.join("output/pytorch_lora_weights.safetensors");
    fs::write(&output, b"weights").unwrap();
    let completed = status(&workspace.paths, "training-test").unwrap();
    assert_eq!(completed.state, "completed");
    assert_eq!(completed.output_path, Some(output));
    assert_eq!(completed.completed_steps, Some(1000));
    assert!(!completed.can_resume);
    remove_job(&workspace.paths, "training-test").unwrap();
    assert!(!directory.exists());
    for invalid in ["", "../outside", "training/test", "training_test"] {
        assert!(job_directory(&workspace.paths, invalid).is_err());
    }
}

#[test]
fn progress_reads_latest_steps_across_carriage_return_logs() {
    let workspace = TestWorkspace::new();
    let log = workspace.root.join("training.log");
    fs::write(
        &log,
        b"Steps:  10%|#         | 100/1000 [00:12]\rSteps:  21%|## | 210/1000 [00:25]\nSteps: waiting",
    ).unwrap();
    assert_eq!(completed_steps_from_log(&log), Some(210));
}

#[cfg(target_os = "windows")]
#[test]
fn cancellation_stops_the_training_process_and_its_descendants() {
    let workspace = TestWorkspace::new();
    let directory = job_directory(&workspace.paths, "training-process-tree").unwrap();
    fs::create_dir_all(&directory).unwrap();
    let model = workspace.install_sdxl("safetensors");
    let mut request = request();
    request.architecture = model.architecture;
    request.model_id = model.id.clone();
    request.four_bit = false;
    fs::write(
        directory.join("job.json"),
        serde_json::to_vec(&JobSpec::new(&request, model)).unwrap(),
    )
    .unwrap();
    let script = directory.join("worker.py");
    fs::write(
        &script,
        r#"import pathlib
import subprocess
import sys
import time

directory = pathlib.Path(sys.argv[1])
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])
pending_pid = directory / 'descendant.pending'
pending_pid.write_text(str(child.pid))
pending_pid.replace(directory / 'descendant.pid')
time.sleep(300)
"#,
    )
    .unwrap();
    let log_path = directory.join("worker.log");
    let log = File::create(&log_path).unwrap();
    let mut command = Command::new("python");
    command
        .arg("-B")
        .arg(&script)
        .arg(&directory)
        .stdin(Stdio::null())
        .stdout(log.try_clone().unwrap())
        .stderr(log);
    let mut child = SupervisedChild::spawn(&mut command).unwrap();
    fs::write(directory.join("pid"), child.id().to_string()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    let descendant = loop {
        if let Ok(value) = fs::read_to_string(directory.join("descendant.pid")) {
            break Pid::from_u32(value.parse().unwrap());
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!(
                "Training fixture exited with {status}: {}",
                fs::read_to_string(&log_path).unwrap()
            );
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Training fixture did not start: {}",
            fs::read_to_string(&log_path).unwrap()
        );
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    for message in [
        "Loading model",
        "Preparing images",
        "Preparing model",
        "Saving checkpoint",
        "Saving weights",
    ] {
        fs::write(
            directory.join("status.json"),
            serde_json::to_vec(&RunnerStatus {
                state: "running".into(),
                message: Some(message.into()),
            })
            .unwrap(),
        )
        .unwrap();
        let current = status(&workspace.paths, "training-process-tree").unwrap();
        assert_eq!(current.state, "running");
        assert_eq!(current.message.as_deref(), Some(message));
    }
    cancel(&workspace.paths, "training-process-tree").unwrap();
    assert!(!child.wait().unwrap().success());
    assert!(process_for_job(&directory).unwrap().is_none());
    assert!(System::new_all().process(descendant).is_none());
    assert_eq!(
        fs::read_to_string(directory.join("status.json")).unwrap(),
        r#"{"state":"cancelled","message":null}"#,
    );
}

#[test]
fn flow_models_accept_training_methods_and_reject_inapplicable_settings() {
    for architecture in [
        TrainingArchitecture::StableDiffusion3,
        TrainingArchitecture::Flux1,
        TrainingArchitecture::Flux1Dev,
        TrainingArchitecture::Flux1Schnell,
        TrainingArchitecture::Flux2,
        TrainingArchitecture::Flux2KleinBase4B,
        TrainingArchitecture::Flux2Klein9B,
        TrainingArchitecture::Flux2KleinBase9B,
        TrainingArchitecture::Sana,
    ] {
        let mut request = request();
        request.architecture = architecture;
        request.model_id = Some("flow-base".into());
        let name = serde_json::to_value(architecture).unwrap();
        let capabilities =
            super::super::model_addon::capabilities_for_model("local-diffusers", name.as_str());
        assert!(capabilities
            .iter()
            .any(|capability| capability.kind == "lora"
                && capability
                    .target_components
                    .iter()
                    .any(|component| component == "denoiser")));
        request.model_path = PathBuf::new();
        request.four_bit = false;
        for method in [TrainingMethod::Lora, TrainingMethod::Finetune] {
            request.options.method = method;
            validate_request(&request).unwrap();
        }
        request.options.method = TrainingMethod::Embedding;
        request.trigger_phrase = "<mdconcept>".into();
        request.options.initializer_token = "concept".into();
        validate_request(&request).unwrap();
        assert!(capabilities
            .iter()
            .any(|capability| capability.kind == "textual-inversion"));
        request.options.method = TrainingMethod::Lora;
        request.options.snr_gamma = 5.0;
        assert!(validate_request(&request).unwrap_err().contains("Min-SNR"));
        request.options.snr_gamma = 0.0;
        for guidance in [f64::NAN, f64::INFINITY, -1.0, 20.1] {
            request.options.guidance_scale = guidance;
            assert!(validate_request(&request).is_err());
        }
    }
}

#[test]
fn z_image_models_accept_all_training_methods_and_reject_min_snr() {
    for architecture in [
        TrainingArchitecture::ZImage,
        TrainingArchitecture::ZImageTurbo,
    ] {
        let mut request = request();
        request.architecture = architecture;
        request.model_id = Some("z-image-base".into());
        request.four_bit = false;
        for method in [TrainingMethod::Lora, TrainingMethod::Finetune] {
            request.options.method = method;
            validate_request(&request).unwrap();
        }
        request.options.snr_gamma = 5.0;
        assert!(validate_request(&request).unwrap_err().contains("Min-SNR"));
        request.options.snr_gamma = 0.0;
        request.options.method = TrainingMethod::Embedding;
        request.trigger_phrase = "<mdconcept>".into();
        request.options.initializer_token = "concept".into();
        validate_request(&request).unwrap();
        assert!(super::super::model_addon::capabilities_for_model(
            "local-diffusers",
            Some(if architecture == TrainingArchitecture::ZImage {
                "z-image"
            } else {
                "z-image-turbo"
            })
        )
        .iter()
        .any(|capability| capability.kind == "textual-inversion"));
    }
}
