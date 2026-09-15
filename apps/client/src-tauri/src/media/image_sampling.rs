use serde::{Deserialize, Serialize};

use super::MediaResult;

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImageSampling {
    pub(crate) width: Option<u32>,
    pub(crate) height: Option<u32>,
    pub(crate) num_inference_steps: Option<u32>,
    pub(crate) guidance_scale: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::ImageSampling;

    #[test]
    fn custom_sampling_validates_dimensions_and_model_constraints() {
        let mut sampling = ImageSampling {
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
        if architecture == "flux-2" && self.num_inference_steps.is_some_and(|steps| steps != 4) {
            return Err("FLUX.2 Klein requires 4 sampling steps.".to_string());
        }
        let fixed_guidance = match architecture {
            "flux-2" => Some(1.0),
            "krea-2" => Some(0.0),
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
            "width": config.get("width"), "height": config.get("height"),
            "numInferenceSteps": config.get("numInferenceSteps"), "guidanceScale": config.get("guidanceScale")
        })).map_err(|error| format!("Invalid image sampling settings: {error}"))?;
        sampling.validate()?;
        Ok(sampling)
    }
}
