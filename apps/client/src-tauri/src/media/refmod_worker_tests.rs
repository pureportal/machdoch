use super::*;
use std::path::Path;

#[path = "refmod_audio_worker_tests.rs"]
mod audio_tests;

fn refmod_worker_request(python: &Path, request: serde_json::Value) -> serde_json::Value {
    let operation = request["operation"]
        .as_str()
        .expect("Set a RefMod operation");
    let worker = Path::new(env!("CARGO_MANIFEST_DIR")).join("python/media_diffusers_worker.py");
    let process = crate::media::provider_local_diffusers::worker_command(python, &worker);
    let input = serde_json::to_vec(&request).unwrap();
    let output = run(
        process,
        "refmod",
        Some(&input),
        crate::media::provider_local_diffusers::GENERATION_TIMEOUT,
        None,
    )
    .unwrap_or_else(|error| panic!("RefMod {operation} worker failed: {error}"));
    assert!(
        output.status.success(),
        "RefMod worker failed: {}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["schemaVersion"], 5);
    response["result"].clone()
}

#[test]
#[ignore = "requires MACHDOCH_MEDIA_PYTHON pointing to an installed media runtime"]
fn refmod_worker_inspection_import_and_export_roundtrip() {
    let python = PathBuf::from(
        std::env::var_os("MACHDOCH_MEDIA_PYTHON").expect("Set MACHDOCH_MEDIA_PYTHON"),
    );
    assert!(python.is_absolute() && python.is_file());
    let fixture = Fixture::new();
    let mut library_request = serde_json::json!({"operation": "list"});
    crate::media::refmods::prepare_library_listing(
        fixture.root.to_str().unwrap(),
        &mut library_request,
    )
    .unwrap();
    let library = PathBuf::from(library_request["directory"].as_str().unwrap());
    let listed = refmod_worker_request(&python, library_request.clone());
    assert_eq!(listed["records"], serde_json::json!([]));
    assert_eq!(listed["errors"], serde_json::json!([]));
    assert!(listed["nextOffset"].is_null());
    let source = fixture.root.join("source.safetensors");
    let metadata = serde_json::json!({
        "_format_version": 5, "kind": "bundle", "name": "Native reference",
        "members": [
            {"_format_version": 4, "kind": "image", "name": "Portrait"},
            {"_format_version": 4, "kind": "video", "name": "Motion"},
            {"_format_version": 4, "kind": "audio", "name": "Voice"}
        ]
    });
    let mut header = serde_json::to_vec(&serde_json::json!({
        "__metadata__": {"refmod_meta": metadata.to_string()},
        "ref_0": {"dtype": "F32", "shape": [1, 24, 1, 4, 4], "data_offsets": [0, 1536]},
        "ref_1": {"dtype": "F32", "shape": [1, 24, 3, 4, 4], "data_offsets": [1536, 6144]},
        "ref_2": {"dtype": "F32", "shape": [1, 32, 2, 20], "data_offsets": [6144, 11264]}
    }))
    .unwrap();
    header.resize(header.len().div_ceil(8) * 8, b' ');
    let mut checkpoint = (header.len() as u64).to_le_bytes().to_vec();
    checkpoint.extend(header);
    checkpoint.extend(vec![0u8; 11264]);
    fs::write(&source, checkpoint).unwrap();

    let inspected = refmod_worker_request(
        &python,
        serde_json::json!({"operation": "inspect", "path": source}),
    );
    assert_eq!(inspected["tokens"], 56);
    assert_eq!(inspected["members"][0]["frameCount"], 1);
    assert_eq!(inspected["members"][1]["frameCount"], 9);
    assert_eq!(inspected["members"][2]["frameCount"], 0);

    let imported = refmod_worker_request(
        &python,
        serde_json::json!({"operation": "import", "path": source,
                           "libraryDirectory": library}),
    );
    let imported_path = PathBuf::from(imported["path"].as_str().unwrap());
    assert!(imported_path.starts_with(&library));
    assert!(imported_path.is_file());
    fs::remove_file(&source).unwrap();
    let listed = refmod_worker_request(&python, library_request);
    assert_eq!(listed["records"].as_array().unwrap().len(), 1);
    assert_eq!(listed["records"][0]["path"], imported["path"]);
    assert_eq!(listed["errors"], serde_json::json!([]));

    let destination = fixture.root.join("export.safetensors");
    let exported = refmod_worker_request(
        &python,
        serde_json::json!({"operation": "save", "outputPath": destination, "name": "Export",
                          "slots": [{"path": imported_path, "copies": 2, "visualStrength": 0.5}]}),
    );
    assert_eq!(exported["kind"], "bundle");
    assert_eq!(exported["tokens"], 112);
    let members = exported["members"].as_array().unwrap();
    assert_eq!(members.len(), 6);
    assert_eq!(
        members
            .iter()
            .map(|member| member["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["image", "image", "video", "video", "audio", "audio"]
    );
    assert!(imported_path.is_file());

    let restored = refmod_worker_request(
        &python,
        serde_json::json!({"operation": "inspect", "path": destination}),
    );
    assert_eq!(restored, exported);
    release_idle().unwrap();
}
