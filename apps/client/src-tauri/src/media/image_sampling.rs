use serde::{Deserialize, Serialize};

use super::MediaResult;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageSampling {
    pub(crate) sampler: Option<String>,
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
    pub(crate) num_inference_steps: Option<u32>,
    pub(crate) guidance_scale: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::ImageSampling;

    #[test]
    fn extended_krea_accepts_fractional_guidance_while_turbo_remains_fixed() {
        let sampling = ImageSampling {
            guidance_scale: Some(0.5),
            ..Default::default()
        };
        assert!(sampling.validate_architecture("krea-2").is_ok());
        assert!(sampling.validate_architecture("krea-2-turbo").is_err());
    }

    #[test]
    fn sampler_selection_rejects_incompatible_families_and_turbo_steps() {
        for architecture in [
            "stable-diffusion-1",
            "stable-diffusion-2",
            "stable-diffusion-xl",
            "pony",
        ] {
            assert!(ImageSampling {
                sampler: Some("deis".into()),
                ..Default::default()
            }
            .validate_architecture(architecture)
            .is_ok());
        }
        let mut sampling = ImageSampling {
            sampler: Some("dpmpp-2m-karras".into()),
            ..Default::default()
        };
        assert!(sampling
            .validate_architecture("stable-diffusion-xl")
            .is_ok());
        assert!(sampling.validate_architecture("krea-2-turbo").is_err());
        sampling.sampler = Some("flow-heun".into());
        assert!(sampling.validate_architecture("stable-diffusion-3").is_ok());
        assert!(sampling
            .validate_architecture("stable-diffusion-3.5-large-turbo")
            .is_err());
        assert!(sampling
            .validate_architecture("stable-diffusion-xl")
            .is_err());
        sampling.sampler = Some("flow-euler".into());
        assert!(sampling
            .validate_architecture("qwen-image-2.1-turbo")
            .is_ok());
        sampling.num_inference_steps = Some(20);
        assert!(sampling
            .validate_architecture("qwen-image-2.1-turbo")
            .is_err());
    }

    #[test]
    fn custom_sampling_validates_dimensions_and_model_constraints() {
        let mut sampling = ImageSampling {
            sampler: None,
            width: Some(768),
            height: Some(512),
            num_inference_steps: Some(12),
            guidance_scale: Some(5.0),
        };
        assert!(sampling.validate_architecture("sdxl").is_ok());
        assert!(sampling.validate_architecture("flux-2").is_err());
        sampling.height = Some(510);
        assert!(sampling.validate().is_err());
        sampling.height = None;
        assert!(sampling.validate().is_err());
        assert!(ImageSampling::default()
            .validate_architecture("flux-2")
            .is_ok());
    }
}

impl ImageSampling {
    pub(crate) fn validate_architecture(&self, architecture: &str) -> MediaResult<()> {
        self.validate()?;
        if let Some(sampler) = &self.sampler {
            let profiles: serde_json::Value =
                serde_json::from_str(include_str!("../../python/image_sampling_profiles.json"))
                    .expect("bundled image sampling profiles must be valid");
            if !profiles.as_array().unwrap().iter().any(|profile| {
                profile["architecture"].as_str() == Some(architecture)
                    && profile["samplers"].as_array().is_some_and(|samplers| {
                        samplers
                            .iter()
                            .any(|value| value.as_str() == Some(sampler.as_str()))
                    })
            }) {
                return Err("Choose a compatible sampler for this model.".to_string());
            }
        }
        if let Some(profile) = super::open_models::by_architecture(architecture) {
            if profile.fixed_steps
                && self
                    .num_inference_steps
                    .is_some_and(|steps| steps != profile.steps)
            {
                return Err(format!(
                    "{} requires {} sampling steps",
                    profile.display_name, profile.steps
                ));
            }
            if profile.fixed_guidance
                && self
                    .guidance_scale
                    .is_some_and(|scale| scale != profile.guidance)
            {
                return Err(format!(
                    "{} requires guidance {}",
                    profile.display_name, profile.guidance
                ));
            }
        }
        if architecture == "flux-2" && self.num_inference_steps.is_some_and(|steps| steps != 4) {
            return Err("FLUX.2 Klein requires 4 sampling steps.".to_string());
        }
        if architecture == "qwen-image-2.1" && self.guidance_scale.is_some_and(|scale| scale < 1.0)
        {
            return Err("Qwen-Image 2.1 guidance must be at least 1.".to_string());
        }
        let fixed_guidance = match architecture {
            "flux-2" => Some(1.0),
            _ => None,
        };
        if self
            .guidance_scale
            .zip(fixed_guidance)
            .is_some_and(|(requested, fixed)| requested != fixed)
        {
            return Err(format!("{architecture} uses fixed guidance."));
        }
        Ok(())
    }

    pub(crate) fn validate(&self) -> MediaResult<()> {
        if let Some(sampler) = &self.sampler {
            let profiles: serde_json::Value =
                serde_json::from_str(include_str!("../../python/image_sampling_profiles.json"))
                    .expect("bundled image sampling profiles are valid JSON");
            if !profiles.as_array().is_some_and(|profiles| {
                profiles.iter().any(|profile| {
                    profile["samplers"].as_array().is_some_and(|samplers| {
                        samplers.iter().any(|value| value.as_str() == Some(sampler))
                    })
                })
            }) {
                return Err("Choose a valid image sampler.".to_string());
            }
        }
        if self.width.is_some() != self.height.is_some() {
            return Err("Enter both width and height.".to_string());
        }
        if [self.width, self.height]
            .into_iter()
            .flatten()
            .any(|value| !(256..=2048).contains(&value) || value % 32 != 0)
        {
            return Err(
                "Width and height must be multiples of 32 between 256 and 2048.".to_string(),
            );
        }
        if self
            .num_inference_steps
            .is_some_and(|steps| !(1..=100).contains(&steps))
        {
            return Err("Sampling steps must be between 1 and 100.".to_string());
        }
        if self
            .guidance_scale
            .is_some_and(|value| !value.is_finite() || !(0.0..=20.0).contains(&value))
        {
            return Err("Guidance must be between 0 and 20.".to_string());
        }
        Ok(())
    }

    pub(crate) fn from_config(
        config: &serde_json::Map<String, serde_json::Value>,
    ) -> MediaResult<Self> {
        let sampling: Self = serde_json::from_value(serde_json::json!({
            "sampler": config.get("sampler"),
            "width": config.get("width"), "height": config.get("height"),
            "numInferenceSteps": config.get("numInferenceSteps"), "guidanceScale": config.get("guidanceScale")
        })).map_err(|error| format!("Invalid image sampling settings: {error}"))?;
        sampling.validate()?;
        Ok(sampling)
    }
}
