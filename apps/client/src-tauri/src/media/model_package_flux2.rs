use std::path::Path;

use serde_json::Value;

use super::{read_json, MediaResult};

pub(super) fn validate_dev(root: &Path, index: &Value) -> MediaResult<()> {
    for (name, library, class) in [
        ("scheduler", "diffusers", "FlowMatchEulerDiscreteScheduler"),
        ("transformer", "diffusers", "Flux2Transformer2DModel"),
        (
            "text_encoder",
            "transformers",
            "Mistral3ForConditionalGeneration",
        ),
        ("tokenizer", "transformers", "PixtralProcessor"),
        ("vae", "diffusers", "AutoencoderKLFlux2"),
    ] {
        if index[name] != serde_json::json!([library, class]) {
            return Err(format!(
                "Missing or incompatible FLUX.2 Dev component: {name}"
            ));
        }
    }
    let transformer = read_json(&root.join("transformer/config.json"))?;
    for (name, expected) in [
        ("in_channels", 128),
        ("attention_head_dim", 128),
        ("num_attention_heads", 48),
        ("joint_attention_dim", 15360),
        ("num_layers", 8),
        ("num_single_layers", 48),
    ] {
        if transformer[name].as_u64() != Some(expected) {
            return Err("Choose the FLUX.2 Dev 32B transformer configuration.".to_string());
        }
    }
    if transformer
        .get("guidance_embeds")
        .is_some_and(|value| value != true)
    {
        return Err("FLUX.2 Dev requires guidance embeddings.".to_string());
    }
    let encoder = read_json(&root.join("text_encoder/config.json"))?;
    if encoder["model_type"] != "mistral3"
        || encoder["text_config"]["model_type"] != "mistral"
        || encoder["text_config"]["num_hidden_layers"] != 40
        || encoder["text_config"]["hidden_size"] != 5120
        || encoder["vision_config"]["model_type"] != "pixtral"
        || encoder["vision_config"]["num_hidden_layers"] != 24
        || encoder["vision_config"]["hidden_size"] != 1024
    {
        return Err("Choose the complete FLUX.2 Dev Mistral Small 3.2 encoder.".to_string());
    }
    for name in [
        "tokenizer_config.json",
        "processor_config.json",
        "preprocessor_config.json",
    ] {
        read_json(&root.join("tokenizer").join(name))?;
    }
    if !root.join("tokenizer/tokenizer.json").is_file() {
        return Err("The FLUX.2 Dev tokenizer is missing.".to_string());
    }
    if read_json(&root.join("vae/config.json"))?["latent_channels"] != 32 {
        return Err("Choose the FLUX.2 Dev 32-channel decoder.".to_string());
    }
    Ok(())
}
