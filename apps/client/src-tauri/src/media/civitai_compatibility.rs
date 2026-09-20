use super::model_addon;

pub(super) const MODEL_TYPES: &[&str] = &["Checkpoint", "LORA", "LoCon", "TextualInversion"];

pub(super) const BASE_MODELS: &[(&str, &str)] = &[
    ("SD 1.4", "stable-diffusion-1"),
    ("SD 1.5", "stable-diffusion-1"),
    ("SD 2.0", "stable-diffusion-2"),
    ("SD 2.0 768", "stable-diffusion-2"),
    ("SD 2.1", "stable-diffusion-2"),
    ("SD 2.1 768", "stable-diffusion-2"),
    ("SDXL 0.9", "stable-diffusion-xl"),
    ("SDXL 1.0", "stable-diffusion-xl"),
    ("Illustrious", "stable-diffusion-xl"),
    ("NoobAI", "stable-diffusion-xl"),
    ("Pony", "pony"),
    ("SD 3", "stable-diffusion-3"),
    ("SD 3.5", "stable-diffusion-3"),
    ("SD 3.5 Large", "stable-diffusion-3"),
    ("SD 3.5 Medium", "stable-diffusion-3"),
    ("Flux.1 S", "flux-1"),
    ("Flux.1 D", "flux-1"),
    ("Flux.1 Krea", "flux-1"),
    ("Flux.2 Klein 4B", "flux-2"),
    ("Krea 2", "krea-2"),
    ("Wan Video 2.2 TI2V-5B", "wan-2.2-ti2v"),
    ("LTXV", "ltx-video"),
];

pub(super) fn kind_for_model_type(model_type: &str) -> Option<&'static str> {
    match model_type {
        "Checkpoint" => Some("checkpoint"),
        "LORA" | "LoCon" => Some("lora"),
        "TextualInversion" => Some("textual-inversion"),
        _ => None,
    }
}

pub(super) fn architecture_for_base_model(base_model: Option<&str>) -> Option<&'static str> {
    let base_model = base_model?.trim();
    BASE_MODELS.iter().find_map(|(name, architecture)| {
        name.eq_ignore_ascii_case(base_model)
            .then_some(*architecture)
    })
}

pub(super) fn supports_resource(model_type: &str, base_model: Option<&str>) -> bool {
    let Some(architecture) = architecture_for_base_model(base_model) else {
        return false;
    };
    let Some(kind) = kind_for_model_type(model_type) else {
        return false;
    };
    if kind == "checkpoint" {
        return matches!(
            architecture,
            "stable-diffusion-1" | "stable-diffusion-xl" | "pony" | "krea-2" | "wan-2.2-ti2v"
        );
    }
    if matches!(architecture, "wan-2.2-ti2v" | "ltx-video") {
        return model_type == "LORA";
    }
    model_addon::capabilities_for_model("local-diffusers", Some(architecture))
        .iter()
        .any(|capability| capability.kind == kind)
}

pub(super) fn supports_version_type(base_model_type: Option<&str>) -> bool {
    base_model_type.is_none_or(|value| value.eq_ignore_ascii_case("Standard"))
}

pub(super) fn supports_file(
    file_type: &str,
    name: &str,
    format: Option<&str>,
    precision: Option<&str>,
) -> bool {
    file_type.eq_ignore_ascii_case("Model")
        && name.to_ascii_lowercase().ends_with(".safetensors")
        && format.is_some_and(|value| value.eq_ignore_ascii_case("SafeTensor"))
        && precision.is_none_or(|value| {
            ["fp16", "fp32", "bf16"]
                .iter()
                .any(|fp| value.eq_ignore_ascii_case(fp))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_civitai_families_without_guessing_variants() {
        for (name, architecture) in [
            ("Pony", "pony"),
            ("Illustrious", "stable-diffusion-xl"),
            ("NoobAI", "stable-diffusion-xl"),
            ("Flux.1 Krea", "flux-1"),
            ("Krea 2", "krea-2"),
            ("SD 3.5 Large", "stable-diffusion-3"),
            ("Wan Video 2.2 TI2V-5B", "wan-2.2-ti2v"),
            ("LTXV", "ltx-video"),
        ] {
            assert_eq!(architecture_for_base_model(Some(name)), Some(architecture));
        }
        for name in [
            "Pony V7",
            "Flux.1 Kontext",
            "Flux.2 Klein 9B",
            "SD 2.1 Unclip",
            "SDXL unknown",
            "LTXV2",
            "Hunyuan Video",
            "Wan Video 2.2 I2V-A14B",
            "Other",
        ] {
            assert_eq!(architecture_for_base_model(Some(name)), None, "{name}");
        }
    }

    #[test]
    fn limits_types_to_their_importer_and_runtime() {
        assert!(!supports_resource("DoRA", Some("SDXL 1.0")));
        assert!(supports_resource("TextualInversion", Some("Pony")));
        assert!(!supports_resource("TextualInversion", Some("SD 3.5")));
        assert!(!supports_resource("VAE", Some("SDXL 1.0")));
        assert!(supports_resource(
            "Checkpoint",
            Some("Wan Video 2.2 TI2V-5B")
        ));
        for name in ["LTXV", "Flux.2 Klein 4B"] {
            assert!(supports_resource("LORA", Some(name)), "{name}");
            assert!(!supports_resource("Checkpoint", Some(name)), "{name}");
            assert!(!supports_resource("TextualInversion", Some(name)), "{name}");
        }
        assert!(!supports_resource("Checkpoint", Some("Flux.2 D")));
        assert!(!supports_resource("LORA", Some("Flux.2 D")));
    }

    #[test]
    fn checkpoints_require_managed_components_for_offline_loading() {
        for base in [
            "SD 1.4",
            "SD 1.5",
            "SDXL 0.9",
            "SDXL 1.0",
            "Illustrious",
            "NoobAI",
            "Pony",
            "Krea 2",
            "Wan Video 2.2 TI2V-5B",
        ] {
            assert!(supports_resource("Checkpoint", Some(base)), "{base}");
        }
        for base in [
            "SD 2.0",
            "SD 2.0 768",
            "SD 2.1",
            "SD 2.1 768",
            "SD 3",
            "SD 3.5",
            "SD 3.5 Large",
            "SD 3.5 Medium",
            "Flux.1 S",
            "Flux.1 D",
            "Flux.1 Krea",
            "Flux.2 Klein 4B",
            "LTXV",
        ] {
            assert!(!supports_resource("Checkpoint", Some(base)), "{base}");
            assert!(supports_resource("LORA", Some(base)), "{base}");
        }
    }

    #[test]
    fn video_runners_accept_standard_loras_only() {
        for base in ["Wan Video 2.2 TI2V-5B", "LTXV"] {
            assert!(supports_resource("LORA", Some(base)), "{base}");
            for model_type in ["LoCon", "DoRA", "TextualInversion"] {
                assert!(
                    !supports_resource(model_type, Some(base)),
                    "{model_type} {base}"
                );
            }
        }
    }

    #[test]
    fn excludes_variants_without_matching_runtime_profiles() {
        for base in [
            "SD 1.5 LCM",
            "SD 1.5 Hyper",
            "SDXL 1.0 LCM",
            "SDXL Lightning",
            "SDXL Hyper",
            "SDXL Turbo",
            "SDXL Distilled",
            "SD 3.5 Large Turbo",
            "Flux.2 Klein 4B-base",
            "Wan Video 2.2 I2V-A14B",
            "Wan Video 2.2 T2V-A14B",
            "Wan-Alpha",
        ] {
            for model_type in MODEL_TYPES {
                assert!(
                    !supports_resource(model_type, Some(base)),
                    "{model_type} {base}"
                );
            }
        }
    }

    #[test]
    fn excludes_specialized_pipelines_and_unsupported_file_formats() {
        assert!(supports_version_type(None));
        for kind in ["Refiner", "Inpainting", "Pix2Pix"] {
            assert!(!supports_version_type(Some(kind)));
        }
        assert!(supports_file(
            "Model",
            "test.safetensors",
            Some("SafeTensor"),
            Some("bf16")
        ));
        assert!(!supports_file(
            "VAE",
            "test.safetensors",
            Some("SafeTensor"),
            None
        ));
        assert!(!supports_file("Model", "test.gguf", Some("GGUF"), None));
        assert!(!supports_file(
            "Model",
            "test.safetensors",
            Some("SafeTensor"),
            Some("nf4")
        ));
    }
}
