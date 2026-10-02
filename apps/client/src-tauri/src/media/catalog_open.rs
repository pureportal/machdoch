use std::{borrow::Cow, sync::OnceLock};

use super::BuiltinModel;
use crate::media::{model_install, open_models};

pub(super) fn models() -> &'static [BuiltinModel] {
    static SOURCES: OnceLock<Vec<String>> = OnceLock::new();
    static MODELS: OnceLock<Vec<BuiltinModel>> = OnceLock::new();
    let sources = SOURCES.get_or_init(|| {
        open_models::profiles()
            .iter()
            .map(|profile| format!("https://huggingface.co/{}", profile.repository))
            .collect()
    });
    MODELS.get_or_init(|| {
        open_models::profiles()
            .iter()
            .zip(sources)
            .map(|(profile, source)| BuiltinModel {
                id: &profile.id,
                provider_id: "local-diffusers",
                display_name: &profile.display_name,
                family: &profile.family,
                target: "local",
                lifecycle: "active",
                capabilities: Cow::Borrowed(open_models::capabilities(&profile.architecture)),
                bundled: false,
                package_type: "diffusers",
                architecture: Some(&profile.architecture),
                license_name: &profile.license.name,
                license_spdx_id: profile.license.spdx_id.as_deref(),
                license_source_url: source,
                license_commercial_use: &profile.license.commercial_use,
                license_requires_acceptance: profile.license.commercial_use != "allowed",
                recommended: false,
                speed_score: 0,
                quality_score: 0,
                min_vram_gb: None,
                expected_download_gb: model_install::download_size_gb(&profile.id),
                cost_hint: None,
                privacy_summary: "Generation runs on this device.",
                limitation: (!model_install::has_manifest(&profile.id))
                    .then_some("Import a complete local Diffusers package."),
                stale_after_seconds: 31_536_000,
                source_url: Some(source),
            })
            .collect()
    })
}
