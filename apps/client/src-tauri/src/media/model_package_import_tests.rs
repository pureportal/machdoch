use std::{
    fs,
    path::{Path, PathBuf},
};

use serde_json::json;

use super::{inspect, inventory};

#[test]
fn sdxl_student_import_rejects_unpublished_binary_weights() {
    for architecture in [
        "stable-diffusion-xl-dmad-4step",
        "stable-diffusion-xl-dmad-1step",
    ] {
        let package = TestPackage::new();
        let profile = super::open_models::by_architecture(architecture).unwrap();
        let target = package
            .0
            .join(&profile.distillation.as_ref().unwrap().checkpoint_file);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        fs::write(target, b"different student weights").unwrap();
        assert!(inventory(&package.0)
            .err()
            .unwrap()
            .contains("published student checkpoint"));
    }
}

#[test]
#[ignore = "requires the released SDXL students and base components"]
fn live_sdxl_student_folder_passes_import_review() {
    let root = PathBuf::from(
        std::env::var("MACHDOCH_SDXL_DMAD_TEST_ROOT").expect("set the live SDXL DMAD folder"),
    );
    let package = inventory(&root).unwrap();
    let inspection = inspect(&root).unwrap();
    assert!(inspection.can_import);
    assert_eq!(
        inspection.detected_architecture.as_deref(),
        Some("stable-diffusion-xl-dmad-4step")
    );
    assert_eq!(inspection.suggested_display_name, "SDXL DMAD 4-step");
    assert_eq!(
        inspection.available_architectures,
        vec![
            "stable-diffusion-xl-dmad-4step",
            "stable-diffusion-xl-dmad-1step"
        ]
    );
    for architecture in [
        "stable-diffusion-xl-dmad-4step",
        "stable-diffusion-xl-dmad-1step",
    ] {
        let profile = super::open_models::by_architecture(architecture).unwrap();
        super::validate_student_package(&package, profile).unwrap();
    }
    println!(
        "Reviewed {} bytes and both published SDXL students",
        package.bytes
    );
}

fn h3_student_package() -> TestPackage {
    let package = TestPackage::new();
    let mut index = serde_json::Map::new();
    index.insert("_class_name".to_string(), json!("MiniMaxH3ModularPipeline"));
    for (name, library, class) in [
        ("transformer", "diffusers", "MiniMaxH3Transformer3DModel"),
        (
            "text_encoder",
            "transformers",
            "Qwen3VLForConditionalGeneration",
        ),
        ("tokenizer", "transformers", "Qwen2TokenizerFast"),
        ("processor", "transformers", "Qwen3VLProcessor"),
        ("vae", "diffusers", "AutoencoderKLMiniMaxH3"),
        ("audio_vae", "diffusers", "AutoencoderKLMiniMaxH3Audio"),
        ("scheduler", "diffusers", "MiniMaxH3Scheduler"),
        ("audio_scheduler", "diffusers", "MiniMaxH3Scheduler"),
    ] {
        index.insert(
            name.to_string(),
            json!([library, class, {
                "type_hint": [library, class], "subfolder": name,
                "pretrained_model_name_or_path": "MiniMaxAI/MiniMax-H3",
                "variant": null, "revision": null
            }]),
        );
        let component = package.0.join(name);
        fs::create_dir_all(&component).unwrap();
        for config in [
            "config.json",
            "tokenizer_config.json",
            "scheduler_config.json",
        ] {
            fs::write(component.join(config), "{}").unwrap();
        }
        if name == "text_encoder" {
            fs::write(
                component.join("config.json"),
                serde_json::to_vec(&json!({
                    "model_type": "qwen3_vl",
                    "text_config": {
                        "model_type": "qwen3_vl_text",
                        "num_hidden_layers": 64,
                        "hidden_size": 5120
                    }
                }))
                .unwrap(),
            )
            .unwrap();
        }
        if name != "transformer" {
            fs::copy(
                package
                    .0
                    .join("transformer/diffusion_pytorch_model.safetensors"),
                component.join("diffusion_pytorch_model.safetensors"),
            )
            .unwrap();
        }
    }
    index.insert("transformer_ref".to_string(), json!(["diffusers", "MiniMaxH3Transformer3DModel", {
        "type_hint": ["diffusers", "MiniMaxH3Transformer3DModel"], "subfolder": "transformer_ref",
        "pretrained_model_name_or_path": "MiniMaxAI/MiniMax-H3"
    }]));
    fs::write(
        package.0.join("model_index.json"),
        serde_json::to_vec(&index).unwrap(),
    )
    .unwrap();
    package
}

#[test]
fn h3_student_import_uses_native_modular_components_without_the_reference_partition() {
    let package = h3_student_package();
    assert!(inventory(&package.0).is_ok());
    assert!(inspect(&package.0).unwrap().detected_architecture.is_none());
}

#[test]
fn h3_student_import_requires_original_text_encoder_weights() {
    let package = h3_student_package();
    fs::remove_file(
        package
            .0
            .join("text_encoder/diffusion_pytorch_model.safetensors"),
    )
    .unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("weights for text_encoder"));
}

#[test]
fn h3_student_import_rejects_an_incompatible_conditioner() {
    let package = h3_student_package();
    let path = package.0.join("text_encoder/config.json");
    let original: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for (field, value) in [
        ("num_hidden_layers", json!(32)),
        ("num_hidden_layers", json!(51)),
        ("num_hidden_layers", json!("64")),
        ("hidden_size", json!(2560)),
        ("hidden_size", json!("5120")),
        ("model_type", json!("qwen3_text")),
    ] {
        let mut config = original.clone();
        config["text_config"][field] = value;
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        assert!(inventory(&package.0)
            .err()
            .unwrap()
            .contains("original MiniMax-H3 Qwen3-VL"));
    }
    for config in [json!({}), json!({"text_config": null}), json!([])] {
        fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
        assert!(inventory(&package.0)
            .err()
            .unwrap()
            .contains("original MiniMax-H3 Qwen3-VL"));
    }
}

#[test]
fn h3_student_import_rejects_a_different_checkpoint_before_publication() {
    let package = h3_student_package();
    let student = super::open_models::by_architecture("minimax-h3-dmad-4step").unwrap();
    let target = package
        .0
        .join(&student.distillation.as_ref().unwrap().checkpoint_file);
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::copy(
        package
            .0
            .join("transformer/diffusion_pytorch_model.safetensors"),
        target,
    )
    .unwrap();
    let paths = super::MediaRuntimePaths {
        _storage_lease: None,
        database: package.0.join("media.sqlite3"),
        blobs: package.0.join("blobs"),
    };
    assert!(inspect(&package.0)
        .err()
        .unwrap()
        .contains("published student checkpoint"));
    assert!(!paths.database.exists());
}

#[test]
fn h3_student_import_rejects_modified_remote_component_specifications() {
    let package = h3_student_package();
    let path = package.0.join("model_index.json");
    let mut index: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    index["transformer"][2]["pretrained_model_name_or_path"] = json!("untrusted/custom-code");
    fs::write(path, serde_json::to_vec(&index).unwrap()).unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("Invalid MiniMax-H3 component"));
}

#[test]
fn h3_student_import_rejects_missing_audio_components() {
    let package = h3_student_package();
    let path = package.0.join("model_index.json");
    let mut index: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    index.as_object_mut().unwrap().remove("audio_vae");
    fs::write(path, serde_json::to_vec(&index).unwrap()).unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("Missing MiniMax-H3 component: audio_vae"));
}

struct TestPackage(PathBuf);

impl TestPackage {
    fn audio() -> Self {
        let package = Self::new();
        for component in ["projection_model", "unet", "vocoder"] {
            fs::create_dir_all(package.0.join(component)).unwrap();
            fs::write(package.0.join(component).join("config.json"), "{}").unwrap();
            fs::copy(
                package
                    .0
                    .join("transformer/diffusion_pytorch_model.safetensors"),
                package
                    .0
                    .join(component)
                    .join("diffusion_pytorch_model.safetensors"),
            )
            .unwrap();
        }
        fs::write(
            package.0.join("model_index.json"),
            serde_json::to_vec(&json!({
                "_class_name": "AudioLDM2Pipeline",
                "projection_model": ["audioldm2", "AudioLDM2ProjectionModel"],
                "unet": ["audioldm2", "AudioLDM2UNet2DConditionModel"],
                "vocoder": ["transformers", "SpeechT5HifiGan"]
            }))
            .unwrap(),
        )
        .unwrap();
        package
    }

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

#[test]
fn flux2_trained_packages_preserve_variants_and_reject_distillation_mismatch() {
    for architecture in [
        "flux-2",
        "flux-2-klein-base-4b",
        "flux-2-klein-9b",
        "flux-2-klein-base-9b",
    ] {
        let package = TestPackage::new();
        let distilled = matches!(architecture, "flux-2" | "flux-2-klein-9b");
        let path = package.0.join("model_index.json");
        let mut index = json!({
            "_class_name": "Flux2KleinPipeline",
            "_machdoch_training_architecture": architecture,
            "is_distilled": distilled,
            "transformer": ["diffusers", "Flux2Transformer2DModel"]
        });
        fs::write(&path, serde_json::to_vec(&index).unwrap()).unwrap();
        assert_eq!(
            inspect(&package.0)
                .unwrap()
                .detected_architecture
                .as_deref(),
            Some(architecture)
        );
        index["is_distilled"] = json!(!distilled);
        fs::write(&path, serde_json::to_vec(&index).unwrap()).unwrap();
        assert!(inspect(&package.0).err().unwrap().contains("is_distilled"));
    }
}

#[test]
fn flux2_publisher_packages_detect_width_and_distillation_and_reject_wrong_variants() {
    for (heads, distilled, architecture, other) in [
        (24, true, "flux-2", "flux-2-klein-base-4b"),
        (24, false, "flux-2-klein-base-4b", "flux-2-klein-base-9b"),
        (32, true, "flux-2-klein-9b", "flux-2"),
        (32, false, "flux-2-klein-base-9b", "flux-2-klein-9b"),
    ] {
        let package = TestPackage::new();
        let index_path = package.0.join("model_index.json");
        let mut index = json!({"_class_name": "Flux2KleinPipeline", "is_distilled": distilled,
            "transformer": ["diffusers", "Flux2Transformer2DModel"]});
        fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
        fs::write(
            package.0.join("transformer/config.json"),
            serde_json::to_vec(&json!({"num_attention_heads": heads, "attention_head_dim": 128}))
                .unwrap(),
        )
        .unwrap();
        let inspection = inspect(&package.0).unwrap();
        assert_eq!(
            inspection.detected_architecture.as_deref(),
            Some(architecture)
        );
        let paths = super::MediaRuntimePaths {
            _storage_lease: None,
            database: package.0.join("media.sqlite3"),
            blobs: package.0.join("blobs"),
        };
        let request = super::ImportMediaLocalModelRequest {
            source_path: package.0.to_str().unwrap().to_string(),
            review_token: inspection.review_token,
            display_name: "Klein model".into(),
            architecture: other.into(),
            source_url: None,
            license_name: None,
            commercial_use: None,
        };
        let error = super::import_reviewed(&paths, &request).err().unwrap();
        assert!(
            error.contains("does not match"),
            "{architecture} -> {other}: {error}"
        );
        assert!(!paths.database.exists());
        if !distilled {
            index.as_object_mut().unwrap().remove("is_distilled");
            fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
            assert_eq!(
                inspect(&package.0)
                    .unwrap()
                    .detected_architecture
                    .as_deref(),
                Some(architecture)
            );
            index["is_distilled"] = json!(distilled);
        }
        index["_machdoch_training_architecture"] = json!(architecture);
        fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
        fs::write(package.0.join("transformer/config.json"), serde_json::to_vec(
            &json!({"num_attention_heads": if heads == 24 { 32 } else { 24 }, "attention_head_dim": 128})).unwrap()).unwrap();
        assert!(inspect(&package.0)
            .err()
            .unwrap()
            .contains("transformer configuration"));
    }
}

#[test]
#[ignore = "requires the exact publisher Klein Base 4B package"]
fn detects_external_flux2_publisher_package() {
    let source = PathBuf::from(
        std::env::var("MACHDOCH_FLUX2_SOURCE_FOLDER").expect("Set the publisher source folder"),
    );
    let inspection = inspect(&source).unwrap();
    assert!(inspection.can_import);
    assert_eq!(
        inspection.detected_architecture.as_deref(),
        Some("flux-2-klein-base-4b")
    );
    println!("{}", serde_json::to_string(&inspection).unwrap());
}

#[test]
fn all_flux2_variants_publish_resolve_and_reimport() {
    for (heads, distilled, architecture) in [
        (24, true, "flux-2"),
        (24, false, "flux-2-klein-base-4b"),
        (32, true, "flux-2-klein-9b"),
        (32, false, "flux-2-klein-base-9b"),
    ] {
        let package = TestPackage::new();
        let workspace = TestPackage::new();
        fs::write(
            package.0.join("model_index.json"),
            serde_json::to_vec(&json!({
                "_class_name": "Flux2KleinPipeline", "is_distilled": distilled,
                "transformer": ["diffusers", "Flux2Transformer2DModel"]
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            package.0.join("transformer/config.json"),
            serde_json::to_vec(&json!({
                "num_attention_heads": heads, "attention_head_dim": 128
            }))
            .unwrap(),
        )
        .unwrap();
        let paths = super::MediaRuntimePaths {
            _storage_lease: None,
            database: workspace.0.join("media.sqlite3"),
            blobs: workspace.0.join("blobs"),
        };
        super::database::initialize(&paths).unwrap();
        verify_training_export(&paths, &package.0, architecture);
    }
}

#[test]
fn audioldm_native_components_can_be_imported() {
    let package = TestPackage::audio();
    let inspection = inspect(&package.0).unwrap();
    assert!(inspection.can_import);
    assert_eq!(
        inspection.detected_architecture.as_deref(),
        Some("audioldm-2")
    );
}

#[test]
fn trained_stable_diffusion_folders_are_detected_by_pipeline_and_encoder() {
    for (pipeline, dimension, architecture) in [
        ("StableDiffusionXLPipeline", 768, "stable-diffusion-xl"),
        ("StableDiffusionPipeline", 768, "stable-diffusion-1"),
        ("StableDiffusionPipeline", 1024, "stable-diffusion-2"),
    ] {
        let package = TestPackage::new();
        fs::create_dir(package.0.join("text_encoder")).unwrap();
        fs::write(
            package.0.join("text_encoder/config.json"),
            serde_json::to_vec(&json!({"hidden_size": dimension})).unwrap(),
        )
        .unwrap();
        fs::copy(
            package
                .0
                .join("transformer/diffusion_pytorch_model.safetensors"),
            package.0.join("text_encoder/model.safetensors"),
        )
        .unwrap();
        fs::write(
            package.0.join("model_index.json"),
            serde_json::to_vec(&json!({
                "_class_name": pipeline, "text_encoder": ["transformers", "CLIPTextModel"],
                "transformer": ["diffusers", "UNet2DConditionModel"]
            }))
            .unwrap(),
        )
        .unwrap();
        let inspection = inspect(&package.0).unwrap();
        assert!(inspection.can_import);
        assert_eq!(
            inspection.detected_architecture.as_deref(),
            Some(architecture)
        );
    }
}

#[test]
fn audioldm_namespace_does_not_accept_other_repository_classes() {
    let package = TestPackage::audio();
    let path = package.0.join("model_index.json");
    let mut index: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    index["projection_model"][1] = json!("CustomProjectionModel");
    fs::write(&path, serde_json::to_vec(&index).unwrap()).unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("custom repository code"));
}

#[test]
fn audioldm_requires_vocoder_weights() {
    let package = TestPackage::audio();
    fs::remove_file(
        package
            .0
            .join("vocoder/diffusion_pytorch_model.safetensors"),
    )
    .unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("Missing safetensors weights for vocoder"));
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
fn sana_training_export_has_a_canonical_import_architecture() {
    let package = TestPackage::new();
    let path = package.0.join("model_index.json");
    let mut index: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    index["_class_name"] = json!("SanaPipeline");
    index["transformer"][1] = json!("SanaTransformer2DModel");
    fs::write(path, serde_json::to_vec(&index).unwrap()).unwrap();
    let inspection = inspect(&package.0).unwrap();
    assert!(inspection.can_import);
    assert_eq!(inspection.detected_architecture.as_deref(), Some("sana"));
}

#[test]
fn sd3_training_export_has_a_canonical_import_architecture() {
    let package = TestPackage::new();
    let path = package.0.join("model_index.json");
    let mut index: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    index["_class_name"] = json!("StableDiffusion3Pipeline");
    index["transformer"][1] = json!("SD3Transformer2DModel");
    fs::write(path, serde_json::to_vec(&index).unwrap()).unwrap();
    let inspection = inspect(&package.0).unwrap();
    assert!(inspection.can_import);
    assert_eq!(
        inspection.detected_architecture.as_deref(),
        Some("stable-diffusion-3")
    );
}

#[test]
fn flux_training_exports_detect_guidance_variants_and_reject_mismatched_imports() {
    for (guidance, architecture, other) in [
        (true, "flux-1-dev", "flux-1-schnell"),
        (false, "flux-1-schnell", "flux-1-dev"),
    ] {
        let package = TestPackage::new();
        let path = package.0.join("model_index.json");
        let mut index: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        index["_class_name"] = json!("FluxPipeline");
        index["transformer"][1] = json!("FluxTransformer2DModel");
        fs::write(path, serde_json::to_vec(&index).unwrap()).unwrap();
        fs::write(
            package.0.join("transformer/config.json"),
            serde_json::to_vec(&json!({"guidance_embeds": guidance})).unwrap(),
        )
        .unwrap();
        let inspection = inspect(&package.0).unwrap();
        assert_eq!(
            inspection.detected_architecture.as_deref(),
            Some(architecture)
        );
        let paths = super::MediaRuntimePaths {
            _storage_lease: None,
            database: package.0.join("media.sqlite3"),
            blobs: package.0.join("blobs"),
        };
        let request = super::ImportMediaLocalModelRequest {
            source_path: package.0.to_str().unwrap().to_string(),
            review_token: inspection.review_token,
            display_name: "Trained Flux".into(),
            architecture: other.into(),
            source_url: None,
            license_name: None,
            commercial_use: None,
        };
        assert!(super::import_reviewed(&paths, &request)
            .err()
            .unwrap()
            .contains("does not match"));
        assert!(!paths.database.exists());
        fs::write(package.0.join("transformer/config.json"), "{}").unwrap();
        assert!(inspect(&package.0)
            .err()
            .unwrap()
            .contains("guidance_embeds"));
    }
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
fn krea_packages_distinguish_raw_and_turbo_and_reject_incorrect_import_types() {
    for (distilled, architecture, mismatch) in [
        (false, "krea-2-raw", "krea-2"),
        (true, "krea-2", "krea-2-raw"),
    ] {
        let package = TestPackage::new();
        let index = json!({
            "_class_name": "Krea2Pipeline", "is_distilled": distilled,
            "transformer": ["diffusers", "Krea2Transformer2DModel"]
        });
        fs::write(
            package.0.join("model_index.json"),
            serde_json::to_vec(&index).unwrap(),
        )
        .unwrap();
        let inspection = inspect(&package.0).unwrap();
        assert_eq!(
            inspection.detected_architecture.as_deref(),
            Some(architecture)
        );
        let paths = super::MediaRuntimePaths {
            _storage_lease: None,
            database: package.0.join("media.sqlite3"),
            blobs: package.0.join("blobs"),
        };
        let request = super::ImportMediaLocalModelRequest {
            source_path: inspection.source_path,
            review_token: inspection.review_token,
            display_name: "KREA fixture".to_string(),
            architecture: mismatch.to_string(),
            source_url: None,
            license_name: None,
            commercial_use: None,
        };
        assert!(super::import_reviewed(&paths, &request)
            .err()
            .unwrap()
            .contains("does not match"));
        assert!(!paths.database.exists());
        for invalid in [json!(null), json!("false")] {
            let mut invalid_index = index.clone();
            invalid_index["is_distilled"] = invalid;
            fs::write(
                package.0.join("model_index.json"),
                serde_json::to_vec(&invalid_index).unwrap(),
            )
            .unwrap();
            assert!(inspect(&package.0).err().unwrap().contains("is_distilled"));
        }
    }
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
    let staging = paths.models_root().unwrap().join("staging");
    fs::remove_dir(&staging).unwrap();
    fs::write(&staging, "Staging is unavailable").unwrap();
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

#[test]
fn trained_z_image_packages_preserve_the_variant_and_reject_another_variant() {
    for architecture in ["z-image", "z-image-turbo"] {
        let package = TestPackage::new();
        let index_path = package.0.join("model_index.json");
        let mut index: serde_json::Value =
            serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
        index["_machdoch_training_architecture"] = serde_json::Value::String(architecture.into());
        fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
        let inspection = inspect(&package.0).unwrap();
        assert_eq!(
            inspection.detected_architecture.as_deref(),
            Some(architecture)
        );
        let paths = super::MediaRuntimePaths {
            _storage_lease: None,
            database: package.0.join("store/media.sqlite3"),
            blobs: package.0.join("store/blobs"),
        };
        let request = super::ImportMediaLocalModelRequest {
            source_path: inspection.source_path,
            review_token: inspection.review_token,
            display_name: "Z-Image trained model".into(),
            architecture: if architecture == "z-image" {
                "z-image-turbo"
            } else {
                "z-image"
            }
            .into(),
            source_url: None,
            license_name: None,
            commercial_use: None,
        };
        assert!(super::import_reviewed(&paths, &request)
            .unwrap_err()
            .contains("trained model"));
        index["_machdoch_training_architecture"] = serde_json::Value::String("flux-1".into());
        fs::write(&index_path, serde_json::to_vec(&index).unwrap()).unwrap();
        assert!(inspect(&package.0)
            .unwrap_err()
            .contains("training architecture"));
    }
}

#[test]
fn cogvideo_packages_identify_temporal_patches_and_conditioning_channels() {
    for architecture in ["cogvideox-2b", "cogvideox-1.5-5b", "cogvideox-1.5-5b-i2v"] {
        let package = TestPackage::new();
        let image_conditioned = architecture.ends_with("-i2v");
        let version_15 = architecture != "cogvideox-2b";
        fs::create_dir(package.0.join("vae")).unwrap();
        fs::write(
            package.0.join("vae/config.json"),
            serde_json::to_vec(&json!({"latent_channels": 16})).unwrap(),
        )
        .unwrap();
        let index = json!({"_class_name": if image_conditioned { "CogVideoXImageToVideoPipeline" } else { "CogVideoXPipeline" },
            "_machdoch_training_architecture": architecture, "transformer": ["diffusers", "CogVideoXTransformer3DModel"]});
        fs::write(
            package.0.join("model_index.json"),
            serde_json::to_vec(&index).unwrap(),
        )
        .unwrap();
        let config = json!({"in_channels": if image_conditioned { 32 } else { 16 },
            "patch_size_t": if version_15 { Some(2) } else { None }, "use_rotary_positional_embeddings": version_15});
        fs::write(
            package.0.join("transformer/config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        assert_eq!(
            inspect(&package.0)
                .unwrap()
                .detected_architecture
                .as_deref(),
            Some(architecture)
        );
        let mut wrong_marker = index.clone();
        wrong_marker["_machdoch_training_architecture"] = json!("stable-diffusion-xl");
        fs::write(
            package.0.join("model_index.json"),
            serde_json::to_vec(&wrong_marker).unwrap(),
        )
        .unwrap();
        assert!(inspect(&package.0)
            .unwrap_err()
            .contains("training architecture"));
        fs::write(
            package.0.join("model_index.json"),
            serde_json::to_vec(&index).unwrap(),
        )
        .unwrap();
        let mut wrong_channels = config;
        wrong_channels["in_channels"] = json!(64);
        fs::write(
            package.0.join("transformer/config.json"),
            serde_json::to_vec(&wrong_channels).unwrap(),
        )
        .unwrap();
        assert!(inspect(&package.0).unwrap_err().contains("channels"));
    }
}

fn verify_training_export(
    paths: &super::MediaRuntimePaths,
    source: &Path,
    architecture: &str,
) -> serde_json::Value {
    let inspection = inspect(source).unwrap();
    assert_eq!(
        inspection
            .detected_architecture
            .as_deref()
            .map(super::super::model_import::pipeline_architecture),
        Some(super::super::model_import::pipeline_architecture(
            &architecture
        ))
    );
    assert!(inspection.byte_size > 0);
    assert!(inspection.tensor_count > 0);
    let request = super::ImportMediaLocalModelRequest {
        source_path: inspection.source_path,
        review_token: inspection.review_token,
        display_name: format!("{architecture} finetune verification"),
        architecture: architecture.into(),
        source_url: None,
        license_name: None,
        commercial_use: None,
    };
    let imported = super::import_reviewed(paths, &request).unwrap();
    assert!(!imported.already_installed);
    assert_eq!(imported.byte_size, inspection.byte_size);
    let managed =
        super::super::provider_local_diffusers::installed_model(paths, &imported.model_id).unwrap();
    assert_eq!(managed.architecture, architecture);
    assert_eq!(managed.package_kind, "diffusers-directory");
    assert_eq!(
        inspect(&managed.path).unwrap().tensor_count,
        inspection.tensor_count
    );
    assert!(
        super::import_reviewed(paths, &request)
            .unwrap()
            .already_installed
    );
    println!(
        "Verified {} bytes, {} tensors, managed model {}",
        imported.byte_size, inspection.tensor_count, imported.model_id
    );
    serde_json::json!({"architecture": architecture, "byteSize": imported.byte_size,
                      "tensorCount": inspection.tensor_count, "model": {"id": managed.id,
                          "architecture": managed.architecture, "packageKind": managed.package_kind,
                          "path": managed.path, "configPath": managed.config_path,
                          "revision": managed.revision, "digest": managed.digest}})
}

#[test]
#[ignore]
fn full_size_training_export_is_imported_verified_and_resolved() {
    let source = PathBuf::from(
        std::env::var("MACHDOCH_TRAINING_VERIFICATION_EXPORT")
            .expect("Set the training export directory"),
    );
    let architecture = std::env::var("MACHDOCH_TRAINING_VERIFICATION_ARCHITECTURE")
        .expect("Set the trained model architecture");
    let workspace = TestPackage::new();
    let paths = super::MediaRuntimePaths {
        _storage_lease: None,
        database: workspace.0.join("media.sqlite3"),
        blobs: workspace.0.join("blobs"),
    };
    super::database::initialize(&paths).unwrap();
    let result = verify_training_export(&paths, &source, &architecture);
    assert!(result["byteSize"].as_u64().unwrap() > 1_000_000_000);
    assert!(result["tensorCount"].as_u64().unwrap() > 500);
}

#[test]
#[ignore]
fn external_training_exports_are_imported_verified_and_resolved() {
    let fixture = PathBuf::from(
        std::env::var("MACHDOCH_TRAINING_PACKAGE_FIXTURE")
            .expect("Set the training package fixture path"),
    );
    let specification: serde_json::Value =
        serde_json::from_slice(&fs::read(fixture).unwrap()).unwrap();
    let store = PathBuf::from(specification["store"].as_str().unwrap());
    fs::create_dir(&store).unwrap();
    let paths = super::MediaRuntimePaths {
        _storage_lease: None,
        database: store.join("media.sqlite3"),
        blobs: store.join("blobs"),
    };
    super::database::initialize(&paths).unwrap();
    let exports = specification["exports"].as_array().unwrap();
    assert!(!exports.is_empty());
    let results = exports
        .iter()
        .map(|export| {
            verify_training_export(
                &paths,
                Path::new(export["path"].as_str().unwrap()),
                export["architecture"].as_str().unwrap(),
            )
        })
        .collect::<Vec<_>>();
    fs::write(
        store.join("results.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
}
