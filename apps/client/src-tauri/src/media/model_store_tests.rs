use super::*;
use std::io::{BufRead, Write};

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
                "media_get_model_catalog" => {
                    let status = runtime.get_or_insert_with(|| probe_python(&python, &script));
                    let mut catalog = database::get_model_catalog(&paths, &HashSet::new())?;
                    annotate_catalog_readiness(status, &mut catalog.models);
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
