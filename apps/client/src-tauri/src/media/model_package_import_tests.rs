use std::{fs, path::PathBuf};

use serde_json::json;

use super::{inspect, inventory};

struct TestPackage(PathBuf);

impl TestPackage {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "machdoch-model-folder-test-{}",
            super::model_import::new_import_id().unwrap()
        ));
        fs::create_dir_all(root.join("transformer")).unwrap();
        fs::write(
            root.join("model_index.json"),
            serde_json::to_vec(&json!({
                "_class_name": "ZImagePipeline",
                "transformer": ["diffusers", "ZImageTransformer2DModel"]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(root.join("transformer/config.json"), "{}").unwrap();
        let header = serde_json::to_vec(
            &json!({ "weight": { "dtype": "F32", "shape": [1], "data_offsets": [0, 4] } }),
        )
        .unwrap();
        let mut weights = (header.len() as u64).to_le_bytes().to_vec();
        weights.extend(header);
        weights.extend(1_f32.to_le_bytes());
        fs::write(
            root.join("transformer/diffusion_pytorch_model.safetensors"),
            weights,
        )
        .unwrap();
        Self(root)
    }
}

impl Drop for TestPackage {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn a_complete_folder_can_be_reviewed_without_guessing_a_shared_pipeline_variant() {
    let package = TestPackage::new();
    let inspection = inspect(&package.0).unwrap();
    assert!(inspection.can_import);
    assert_eq!(inspection.detected_architecture, None);
    assert_eq!(inspection.review_token.len(), 64);
    assert!(inspection.byte_size > 0);
    assert_eq!(inspection.tensor_count, 1);
}

#[test]
fn incomplete_shards_and_truncated_weights_are_rejected() {
    let package = TestPackage::new();
    fs::write(
        package.0.join("transformer/model.safetensors.index.json"),
        serde_json::to_vec(&json!({"weight_map": {"weight": "missing.safetensors"}})).unwrap(),
    )
    .unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("Missing or unsafe weight shard"));
    fs::remove_file(package.0.join("transformer/model.safetensors.index.json")).unwrap();
    fs::write(
        package
            .0
            .join("transformer/diffusion_pytorch_model.safetensors"),
        [0_u8; 16],
    )
    .unwrap();
    assert!(inventory(&package.0).is_err());
}

#[test]
fn executable_files_and_external_shard_paths_are_rejected() {
    let package = TestPackage::new();
    fs::write(package.0.join("modeling.py"), "pass").unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("executable or unsupported"));
    fs::remove_file(package.0.join("modeling.py")).unwrap();
    fs::write(
        package.0.join("transformer/model.safetensors.index.json"),
        serde_json::to_vec(&json!({"weight_map": {"weight": "../outside.safetensors"}})).unwrap(),
    )
    .unwrap();
    assert!(inventory(&package.0).is_err());
}

#[test]
fn a_changed_folder_invalidates_the_review_token() {
    let package = TestPackage::new();
    let previous = inspect(&package.0).unwrap();
    fs::write(package.0.join("README.md"), "Model details").unwrap();
    let current = inspect(&package.0).unwrap();
    assert_ne!(previous.review_token, current.review_token);
}

#[test]
fn a_reviewed_package_is_published_registered_and_checked_on_reimport() {
    let source = TestPackage::new();
    let workspace = TestPackage::new();
    let paths = super::MediaRuntimePaths {
        _storage_lease: None,
        database: workspace.0.join("media.sqlite3"),
        blobs: workspace.0.join("blobs"),
    };
    super::database::initialize(&paths).unwrap();
    let inspection = inspect(&source.0).unwrap();
    let request = super::ImportMediaLocalModelRequest {
        source_path: source.0.to_str().unwrap().to_string(),
        review_token: inspection.review_token,
        display_name: "Test Z-Image Turbo".to_string(),
        architecture: "z-image-turbo".to_string(),
        source_url: None,
        license_name: None,
        commercial_use: None,
    };
    let result = super::import_reviewed(&paths, &request).unwrap();
    assert!(!result.already_installed);
    let connection = super::database::open(&paths).unwrap();
    let (package_type, minimum_vram, relative_path): (String, Option<f64>, String) = connection.query_row(
        "SELECT m.package_type, m.min_vram_gb, i.relative_path FROM media_models m JOIN media_model_installations i ON m.id = i.model_id WHERE m.id = ?1",
        [&result.model_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))
    ).unwrap();
    assert_eq!(package_type, "diffusers");
    assert_eq!(minimum_vram, None);
    drop(connection);
    assert!(
        super::import_reviewed(&paths, &request)
            .unwrap()
            .already_installed
    );
    let published = paths
        .models_root()
        .unwrap()
        .join(relative_path)
        .join("transformer/diffusion_pytorch_model.safetensors");
    let mut data = fs::read(&published).unwrap();
    *data.last_mut().unwrap() ^= 1;
    fs::write(published, data).unwrap();
    assert!(super::import_reviewed(&paths, &request)
        .err()
        .unwrap()
        .contains("failed verification"));
}
