use std::sync::OnceLock;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OpenModelProfile {
    pub(super) id: String,
    pub(super) architecture: String,
    pub(super) display_name: String,
    pub(super) family: String,
    pub(super) repository: String,
    pub(super) pipeline: String,
    pub(super) capabilities: Vec<String>,
    pub(super) steps: u32,
    pub(super) guidance: f64,
    pub(super) fixed_steps: bool,
    pub(super) fixed_guidance: bool,
    #[serde(default = "default_max_references")]
    pub(super) max_references: usize,
    pub(super) video: Option<VideoContract>,
    #[serde(default = "default_spatial_multiple")]
    pub(super) spatial_multiple: u32,
    #[serde(default = "default_prompt")]
    pub(super) prompt: bool,
    #[serde(default)]
    pub(super) audio: bool,
    pub(super) license: ProfileLicense,
}

fn default_prompt() -> bool {
    true
}

fn default_max_references() -> usize {
    1
}

fn default_spatial_multiple() -> u32 {
    16
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProfileLicense {
    pub(super) name: String,
    pub(super) spdx_id: Option<String>,
    pub(super) commercial_use: String,
}

#[derive(Debug, Deserialize)]
pub(super) struct VideoContract {
    pub(super) minimum: u32,
    pub(super) maximum: u32,
    pub(super) stride: u32,
}

pub(super) fn profiles() -> &'static [OpenModelProfile] {
    static PROFILES: OnceLock<Vec<OpenModelProfile>> = OnceLock::new();
    PROFILES.get_or_init(|| {
        serde_json::from_str(include_str!("../../python/open_media_models.json"))
            .expect("bundled open media model profiles must be valid")
    })
}

pub(super) fn by_architecture(architecture: &str) -> Option<&'static OpenModelProfile> {
    profiles()
        .iter()
        .find(|profile| profile.architecture == architecture)
}

pub(super) fn by_id(model_id: &str) -> Option<&'static OpenModelProfile> {
    profiles().iter().find(|profile| profile.id == model_id)
}

pub(super) fn capabilities(architecture: &str) -> &'static [&'static str] {
    static CAPABILITIES: OnceLock<std::collections::HashMap<&'static str, Vec<&'static str>>> =
        OnceLock::new();
    CAPABILITIES
        .get_or_init(|| {
            profiles()
                .iter()
                .map(|profile| {
                    (
                        profile.architecture.as_str(),
                        profile.capabilities.iter().map(String::as_str).collect(),
                    )
                })
                .collect()
        })
        .get(architecture)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

pub(super) fn video_settings_error(
    profile: &OpenModelProfile,
    frames: u32,
    steps: u32,
    guidance: f64,
) -> Option<String> {
    let contract = profile.video.as_ref()?;
    if frames < contract.minimum
        || frames > contract.maximum
        || !(frames - contract.minimum).is_multiple_of(contract.stride)
    {
        return Some(format!(
            "{} requires {}–{} frames in increments of {}",
            profile.display_name, contract.minimum, contract.maximum, contract.stride
        ));
    }
    if !(1..=100).contains(&steps) || (profile.fixed_steps && steps != profile.steps) {
        return Some(format!(
            "Choose valid sampling steps for {}",
            profile.display_name
        ));
    }
    if !guidance.is_finite()
        || !(0.0..=20.0).contains(&guidance)
        || (profile.fixed_guidance && guidance != profile.guidance)
    {
        return Some(format!(
            "Choose valid guidance for {}",
            profile.display_name
        ));
    }
    None
}
