use serde::{Deserialize, Serialize};

use super::{model_components, required_text, MediaResult, MediaRuntimePaths};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkerControlNet<'a> {
    pub(super) kind: &'a str,
    pub(super) image_path: &'a std::path::Path,
    pub(super) model_path: &'a std::path::Path,
    pub(super) strength: f64,
    pub(super) start: f64,
    pub(super) end: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ControlNetConditioning {
    pub(crate) image_asset_id: String,
    pub(crate) kind: String,
    pub(crate) strength: f64,
    pub(crate) start: f64,
    pub(crate) end: f64,
}

impl ControlNetConditioning {
    pub(crate) fn validate(&mut self) -> MediaResult<()> {
        self.image_asset_id = required_text("controlNet.imageAssetId", &self.image_asset_id, 256)?;
        if !matches!(self.kind.as_str(), "canny" | "depth") {
            return Err("Choose Canny or Depth ControlNet.".into());
        }
        if !self.strength.is_finite() || !(0.0..=2.0).contains(&self.strength) {
            return Err("ControlNet strength must be between 0 and 2.".into());
        }
        if !self.start.is_finite()
            || !self.end.is_finite()
            || !(0.0..1.0).contains(&self.start)
            || self.start >= self.end
            || self.end > 1.0
        {
            return Err("ControlNet range must satisfy 0 <= start < end <= 1.".into());
        }
        Ok(())
    }
}

pub(super) fn ensure_model(
    paths: &MediaRuntimePaths,
    architecture: &str,
    kind: &str,
) -> MediaResult<std::path::PathBuf> {
    if architecture != "stable-diffusion-1" || !matches!(kind, "canny" | "depth") {
        return Err("Choose an SD1.5 model for Canny or Depth ControlNet.".into());
    }
    ensure_component(paths, &format!("controlnet-sd15-{kind}"))
}

pub(super) fn ensure_component(
    paths: &MediaRuntimePaths,
    kind: &str,
) -> MediaResult<std::path::PathBuf> {
    let manifests: serde_json::Value =
        serde_json::from_str(include_str!("controlnet_components.json"))
            .map_err(|error| error.to_string())?;
    let files = manifests.get(kind).ok_or("Unknown control image model")?;
    model_components::ensure_components(
        &paths.models_root()?.join("components").join(kind),
        &files.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_control_ranges_and_rejects_unknown_fields() {
        let valid = serde_json::json!({"imageAssetId":"asset:guide","kind":"depth","strength":0.75,"start":0.1,"end":0.8});
        let mut control: ControlNetConditioning = serde_json::from_value(valid.clone()).unwrap();
        control.validate().unwrap();
        for (key, value) in [
            ("strength", serde_json::json!(2.1)),
            ("start", serde_json::json!(0.8)),
            ("end", serde_json::json!(0.0)),
            ("kind", serde_json::json!("unknown")),
        ] {
            let mut input = valid.clone();
            input[key] = value;
            let mut control: ControlNetConditioning = serde_json::from_value(input).unwrap();
            assert!(control.validate().is_err());
        }
        let mut input = valid;
        input["modelPath"] = serde_json::json!("arbitrary-model");
        assert!(serde_json::from_value::<ControlNetConditioning>(input).is_err());
    }

    #[test]
    fn component_manifest_pins_every_download() {
        let manifests: serde_json::Value =
            serde_json::from_str(include_str!("controlnet_components.json")).unwrap();
        for files in manifests.as_object().unwrap().values() {
            for file in files.as_array().unwrap() {
                assert_eq!(file["sha256"].as_str().unwrap().len(), 64);
                assert!(file["bytes"].as_u64().unwrap() > 0);
                let url = file["url"].as_str().unwrap();
                let revision = url
                    .split("/resolve/")
                    .nth(1)
                    .unwrap()
                    .split('/')
                    .next()
                    .unwrap();
                assert_eq!(revision.len(), 40);
                assert!(revision
                    .chars()
                    .all(|character| character.is_ascii_hexdigit()));
            }
        }
    }
}
