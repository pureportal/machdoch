use std::fs;

use serde_json::json;

use super::{inspect, inventory, TestPackage};

fn dev_package() -> TestPackage {
    let package = TestPackage::new();
    let index = json!({
        "_class_name": "Flux2Pipeline",
        "scheduler": ["diffusers", "FlowMatchEulerDiscreteScheduler"],
        "transformer": ["diffusers", "Flux2Transformer2DModel"],
        "text_encoder": ["transformers", "Mistral3ForConditionalGeneration"],
        "tokenizer": ["transformers", "PixtralProcessor"],
        "vae": ["diffusers", "AutoencoderKLFlux2"],
        "machdoch_quantization": {"transformer": {"format": "gguf", "file": "transformer/model.gguf"}}
    });
    for name in ["scheduler", "text_encoder", "tokenizer", "vae"] {
        fs::create_dir(package.0.join(name)).unwrap();
    }
    for path in [
        "text_encoder/model.safetensors",
        "vae/diffusion_pytorch_model.safetensors",
    ] {
        fs::copy(
            package
                .0
                .join("transformer/diffusion_pytorch_model.safetensors"),
            package.0.join(path),
        )
        .unwrap();
    }
    fs::remove_file(
        package
            .0
            .join("transformer/diffusion_pytorch_model.safetensors"),
    )
    .unwrap();
    fs::write(
        package.0.join("transformer/model.gguf"),
        super::super::super::gguf_weights::fixture("flux", 12, 256, 144),
    )
    .unwrap();
    for (path, value) in [
        ("model_index.json", index),
        (
            "transformer/config.json",
            json!({"in_channels": 128, "attention_head_dim": 128, "num_attention_heads": 48, "joint_attention_dim": 15360, "num_layers": 8, "num_single_layers": 48}),
        ),
        (
            "text_encoder/config.json",
            json!({"model_type": "mistral3", "text_config": {"model_type": "mistral", "num_hidden_layers": 40, "hidden_size": 5120}, "vision_config": {"model_type": "pixtral", "num_hidden_layers": 24, "hidden_size": 1024}}),
        ),
        ("vae/config.json", json!({"latent_channels": 32})),
        ("scheduler/scheduler_config.json", json!({})),
        ("tokenizer/tokenizer_config.json", json!({})),
        ("tokenizer/processor_config.json", json!({})),
        ("tokenizer/preprocessor_config.json", json!({})),
        ("tokenizer/tokenizer.json", json!({})),
    ] {
        fs::write(package.0.join(path), serde_json::to_vec(&value).unwrap()).unwrap();
    }
    package
}

#[test]
fn dev_gguf_folder_is_importable_with_complete_components() {
    let package = dev_package();
    let review = inspect(&package.0).unwrap();
    assert!(review.can_import);
    assert_eq!(review.detected_architecture.as_deref(), Some("flux-2-dev"));
    fs::remove_file(package.0.join("text_encoder/model.safetensors")).unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("Missing safetensors weights for text_encoder"));
}

#[test]
fn dev_folder_rejects_klein_configuration_and_missing_processor() {
    let package = dev_package();
    let path = package.0.join("transformer/config.json");
    let original = fs::read(&path).unwrap();
    let mut config: serde_json::Value = serde_json::from_slice(&original).unwrap();
    config["num_attention_heads"] = json!(24);
    fs::write(&path, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("32B transformer"));
    fs::write(&path, original).unwrap();
    fs::remove_file(package.0.join("tokenizer/processor_config.json")).unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("processor_config.json"));
}

#[test]
fn dev_folder_rejects_text_only_encoder_and_wrong_gguf_architecture() {
    let package = dev_package();
    fs::write(
        package.0.join("transformer/model.gguf"),
        super::super::super::gguf_weights::fixture("qwen_image", 12, 256, 144),
    )
    .unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("does not match"));
    fs::write(
        package.0.join("transformer/model.gguf"),
        super::super::super::gguf_weights::fixture("flux", 12, 256, 144),
    )
    .unwrap();
    let path = package.0.join("text_encoder/config.json");
    let mut config: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    config.as_object_mut().unwrap().remove("vision_config");
    fs::write(path, serde_json::to_vec(&config).unwrap()).unwrap();
    assert!(inventory(&package.0)
        .err()
        .unwrap()
        .contains("complete FLUX.2 Dev Mistral"));
}
