use super::*;
use std::io::{BufRead, Write};

#[test]
fn worker_start_failure_is_persisted_and_removed_models_cannot_be_verified() {
    let root = std::env::temp_dir().join(format!(
        "machdoch-model-verification-{}-{}",
        std::process::id(),
        database::now().replace(':', "-")
    ));
    let paths = MediaRuntimePaths {
        _storage_lease: None,
        database: root.join("media.sqlite3"),
        blobs: root.join("blobs/sha256"),
    };
    database::initialize(&paths).unwrap();
    let source = root.join("checkpoint.safetensors");
    let header = br#"{"double_blocks.0.img_attn.qkv.weight":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}"#;
    let mut bytes = (header.len() as u64).to_le_bytes().to_vec();
    bytes.extend(header);
    bytes.extend([0_u8; 4]);
    fs::write(&source, bytes).unwrap();
    let inspection = model_import::inspect(source.to_str().unwrap()).unwrap();
    let result = model_import::import_reviewed(
        &paths,
        &super::super::ImportMediaLocalModelRequest {
            source_path: source.to_string_lossy().into_owned(),
            review_token: inspection.review_token,
            display_name: "Verification fixture".into(),
            architecture: "flux-1".into(),
            source_url: None,
            license_name: None,
            commercial_use: None,
        },
    )
    .unwrap();
    let mut runtime = LocalDiffusersRuntimeStatus::unavailable("");
    runtime.ready = true;
    runtime.worker_version = Some("test".into());
    runtime.architectures = vec!["flux-1".into()];
    let model = installed_model(&paths, &result.model_id).unwrap();
    let failed = probe_model_with_runtime(
        &paths,
        &result.model_id,
        Path::new("worker.py"),
        &runtime,
        Some(&root.join("missing-python")),
    )
    .unwrap();
    assert_eq!(failed.status, "failed");
    let mut catalog = database::get_model_catalog(&paths, &HashSet::new()).unwrap();
    annotate_catalog_readiness(&paths, &runtime, &mut catalog.models).unwrap();
    let stored = catalog
        .models
        .iter()
        .find(|entry| entry.id == result.model_id)
        .unwrap();
    assert!(stored.installed);
    assert_eq!(stored.runtime_readiness, "failed");
    assert_eq!(
        stored.runtime_readiness_diagnostic.as_deref(),
        Some(failed.diagnostic.as_str())
    );
    assert!(runnable_model_ids(&paths, &runtime).unwrap().is_empty());
    let components = paths.models_root().unwrap().join("components/krea-2");
    fs::create_dir_all(&components).unwrap();
    fs::write(components.join("shared-weights"), b"shared model data").unwrap();
    database::open(&paths)
        .unwrap()
        .execute(
            "UPDATE media_models SET architecture = 'krea-2' WHERE id = ?1",
            [&result.model_id],
        )
        .unwrap();
    let plan = super::super::model_install::plan_removal(&paths, &result.model_id).unwrap();
    super::super::model_install::remove(
        &paths,
        &super::super::RemoveMediaModelRequest {
            model_id: result.model_id,
            confirmation_token: plan.confirmation_token,
            confirm_removal: true,
        },
    )
    .unwrap();
    assert!(!components.exists());
    assert!(persist_failed_model_probe(
        &paths,
        &model,
        &runtime_fingerprint(&runtime).unwrap(),
        &runtime,
        "late result".into(),
        &database::now(),
        None
    )
    .is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn isolated_gpu_probe_requires_matching_physical_device_and_runtime() {
    let model = InstalledModel {
        id: "model".into(),
        architecture: "krea-2".into(),
        package_kind: "single-file".into(),
        path: PathBuf::new(),
        config_path: None,
        revision: "revision".into(),
        digest: "digest".into(),
    };
    let mut runtime = LocalDiffusersRuntimeStatus::unavailable("");
    runtime.ready = true;
    runtime.worker_version = Some("worker".into());
    runtime.device = Some("cuda".into());
    runtime.device_label = Some("AMD Radeon RX 9070 (cuda:1)".into());
    runtime.device_memory_bytes = Some(17095983104);
    let mut response: WorkerModelProbeResponse = serde_json::from_value(serde_json::json!({
        "schemaVersion": WORKER_SCHEMA_VERSION, "workerVersion": "worker", "packages": {},
        "ready": true, "architecture": "krea-2", "pipelineClass": "Krea2Pipeline",
        "components": ["transformer", "vae"], "capabilities": ["lora", "multi-lora"],
        "device": "cuda", "deviceLabel": "AMD Radeon RX 9070 (cuda:0)",
        "deviceMemoryBytes": 17095983104_u64, "diagnostic": "loaded"
    }))
    .unwrap();
    assert!(model_probe_matches_runtime(&model, &runtime, &response));
    response.device_label = "AMD Radeon Graphics (cuda:0)".into();
    assert!(!model_probe_matches_runtime(&model, &runtime, &response));
    response.device_label = runtime.device_label.clone().unwrap();
    response.device_memory_bytes = Some(1024);
    assert!(!model_probe_matches_runtime(&model, &runtime, &response));
    response.device_memory_bytes = runtime.device_memory_bytes;
    response.worker_version = "changed".into();
    assert!(!model_probe_matches_runtime(&model, &runtime, &response));
}

#[test]
#[ignore = "Playwright drives this native model store through stdin"]
fn playwright_model_store() {
    let root =
        PathBuf::from(std::env::var("MACHDOCH_MODEL_TEST_ROOT").expect("isolated model test root"));
    let python = PathBuf::from(std::env::var("MACHDOCH_MODEL_TEST_PYTHON").expect("pinned Python"));
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("python/media_diffusers_worker.py");
    let paths = MediaRuntimePaths {
        _storage_lease: None,
        database: root.join("media.sqlite3"),
        blobs: root.join("blobs/sha256"),
    };
    database::initialize(&paths).unwrap();
    let mut runtime = None;
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        let reply = (|| -> MediaResult<serde_json::Value> {
            let input: serde_json::Value =
                serde_json::from_str(&line).map_err(|error| error.to_string())?;
            let args = &input["args"];
            let value = match input["command"].as_str().unwrap_or("") {
                "media_inspect_local_model" => serde_json::to_value(model_import::inspect(
                    args["sourcePath"].as_str().unwrap(),
                )?),
                "media_import_local_model" => serde_json::to_value(model_import::import_reviewed(
                    &paths,
                    &serde_json::from_value(args["request"].clone())
                        .map_err(|error| error.to_string())?,
                )?),
                "media_probe_local_model" => {
                    let status = runtime.get_or_insert_with(|| probe_python(&python, &script));
                    serde_json::to_value(probe_model_with_runtime(
                        &paths,
                        args["modelId"].as_str().unwrap(),
                        &script,
                        status,
                        Some(&python),
                    )?)
                }
                "media_get_model_catalog" => {
                    let status = runtime.get_or_insert_with(|| probe_python(&python, &script));
                    let mut catalog = database::get_model_catalog(&paths, &HashSet::new())?;
                    annotate_catalog_readiness(&paths, status, &mut catalog.models)?;
                    serde_json::to_value(catalog)
                }
                "media_initialize_runtime" => {
                    let status = runtime.get_or_insert_with(|| probe_python(&python, &script));
                    let models = runnable_model_ids(&paths, status)?;
                    Ok(
                        serde_json::json!({"schemaVersion": 1, "mode": "native", "storageReady": true,
                        "recoveredRuns": 0, "queuedRuns": 0, "activeRuns": 0,
                        "directGenerationModelIds": models, "directReferenceImageModelIds": [],
                        "directInpaintingModelIds": [], "directPoseModelIds": [], "localDiffusers": status}),
                    )
                }
                "media_plan_model_removal" => {
                    serde_json::to_value(super::super::model_install::plan_removal(
                        &paths,
                        args["modelId"].as_str().unwrap(),
                    )?)
                }
                "media_remove_model" => serde_json::to_value(super::super::model_install::remove(
                    &paths,
                    &serde_json::from_value(args["request"].clone())
                        .map_err(|error| error.to_string())?,
                )?),
                "recover" => {
                    super::super::model_install::recover_removals(&paths)?;
                    database::initialize(&paths)?;
                    Ok(serde_json::Value::Null)
                }
                command => return Err(format!("unexpected model test command: {command}")),
            };
            value.map_err(|error| error.to_string())
        })();
        let reply = match reply {
            Ok(value) => serde_json::json!({"value": value}),
            Err(error) => serde_json::json!({"error": error}),
        };
        println!("MEDIA_REPLY:{reply}");
        std::io::stdout().flush().unwrap();
    }
}
