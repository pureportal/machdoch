use std::{fs, path::PathBuf, time::Instant};

use serde::Deserialize;

use super::{run_worker, verify_python_runtime, GENERATION_TIMEOUT};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationFixture {
    python: PathBuf,
    worker: PathBuf,
    request: PathBuf,
    records: PathBuf,
    require_pipeline_reuse: bool,
}

#[test]
#[ignore = "requires an installed runtime generation fixture"]
fn external_runtime_verification_is_ready() {
    let fixture_path = std::env::var_os("MACHDOCH_GENERATION_FIXTURE")
        .expect("Set MACHDOCH_GENERATION_FIXTURE to the external runtime fixture");
    let fixture: GenerationFixture =
        serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
    fs::create_dir_all(&fixture.records).unwrap();
    let started = Instant::now();
    let runtime = verify_python_runtime(&fixture.python, &fixture.worker);
    let record = serde_json::json!({
        "seconds": started.elapsed().as_secs_f64(),
        "runtime": runtime,
    });
    fs::write(
        fixture.records.join("runtime-verification.json"),
        serde_json::to_vec_pretty(&record).unwrap(),
    )
    .unwrap();
    assert!(runtime.ready, "{}", runtime.diagnostic);
    assert_eq!(runtime.device.as_deref(), Some("cuda"));
    for architecture in [
        "flux-2",
        "flux-2-klein-base-4b",
        "flux-2-klein-9b",
        "flux-2-klein-base-9b",
    ] {
        assert!(runtime
            .architectures
            .iter()
            .any(|name| name == architecture));
    }
}

#[test]
#[ignore = "requires an installed runtime and managed model generation fixture"]
fn external_managed_generation_respects_retention() {
    verify_managed_generation("generate");
}

#[test]
#[ignore = "requires an installed runtime and managed video model generation fixture"]
fn external_managed_video_generation_respects_retention() {
    verify_managed_generation("generate-video");
}

fn verify_managed_generation(command: &str) {
    let fixture_path = std::env::var_os("MACHDOCH_GENERATION_FIXTURE")
        .expect("Set MACHDOCH_GENERATION_FIXTURE to the external generation fixture");
    let fixture: GenerationFixture =
        serde_json::from_slice(&fs::read(fixture_path).unwrap()).unwrap();
    let mut request: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.request).unwrap()).unwrap();
    let output_root = PathBuf::from(request["outputDirectory"].as_str().unwrap());
    fs::create_dir_all(&output_root).unwrap();
    fs::create_dir_all(&fixture.records).unwrap();
    let mut records = Vec::new();
    for attempt in ["cold", "warm"] {
        let directory = output_root.join(attempt);
        fs::create_dir(&directory).unwrap();
        request["outputDirectory"] = serde_json::json!(directory);
        let started = Instant::now();
        let output = run_worker(
            &fixture.python,
            &fixture.worker,
            command,
            Some(&serde_json::to_vec(&request).unwrap()),
            GENERATION_TIMEOUT,
            None,
        );
        let seconds = started.elapsed().as_secs_f64();
        let record_path = fixture.records.join(format!("{attempt}.json"));
        match output {
            Ok(output) => {
                let diagnostics = String::from_utf8_lossy(&output.stderr);
                let modality = if command == "generate" {
                    "image"
                } else {
                    "video"
                };
                let reused_pipeline = diagnostics.contains(&format!("Preparing {modality}"))
                    && !diagnostics.contains(&format!("Loading {modality} model"));
                fs::write(
                    fixture.records.join(format!("{attempt}.stderr.log")),
                    &output.stderr,
                )
                .unwrap();
                let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
                let record = serde_json::json!({
                    "attempt": attempt,
                    "seconds": seconds,
                    "success": output.status.success(),
                    "reusedPipeline": reused_pipeline,
                    "workerResult": result,
                });
                fs::write(&record_path, serde_json::to_vec_pretty(&record).unwrap()).unwrap();
                assert!(output.status.success());
                if attempt == "cold" {
                    assert!(!reused_pipeline);
                } else if fixture.require_pipeline_reuse {
                    assert!(reused_pipeline);
                }
                assert_eq!(result["schemaVersion"], request["schemaVersion"]);
                let outputs = if command == "generate" {
                    let outputs = result["outputs"].as_array().unwrap();
                    assert_eq!(
                        outputs.len(),
                        request["outputCount"].as_u64().unwrap() as usize
                    );
                    outputs.iter().collect::<Vec<_>>()
                } else {
                    assert_eq!(result["architecture"], request["model"]["architecture"]);
                    vec![&result["output"]]
                };
                for artifact in outputs {
                    let file = directory.join(artifact["fileName"].as_str().unwrap());
                    assert!(fs::metadata(file).unwrap().len() > 0);
                }
                records.push(record);
            }
            Err(error) => {
                fs::write(
                    &record_path,
                    serde_json::to_vec_pretty(&serde_json::json!({
                        "attempt": attempt,
                        "seconds": seconds,
                        "success": false,
                        "error": error,
                    }))
                    .unwrap(),
                )
                .unwrap();
                super::super::model_memory::release_idle().unwrap();
                panic!("External managed generation failed: {error}");
            }
        }
    }
    super::super::model_memory::release_idle().unwrap();
    fs::write(
        fixture.records.join("results.json"),
        serde_json::to_vec_pretty(&records).unwrap(),
    )
    .unwrap();
}
