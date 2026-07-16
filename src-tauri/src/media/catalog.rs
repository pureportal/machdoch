use std::collections::HashSet;

use rusqlite::{params, Connection};

use super::{
    database, model_addon, model_import, MediaEmbeddingVectorProfile, MediaLoraTensorProfile,
    MediaModelAddonDescriptor, MediaModelCatalogSnapshot, MediaModelDescriptor, MediaModelLicense,
    MediaProviderCatalogEntry, MediaResult,
};

pub(crate) const CATALOG_REVISION: &str = "builtin-2026-07-15.6-cutout-policy";
const CATALOG_CHECKED_AT: &str = "2026-07-15T00:00:00.000Z";
const WEEK_SECONDS: u64 = 7 * 24 * 60 * 60;
const MONTH_SECONDS: u64 = 30 * 24 * 60 * 60;

struct BuiltinProvider {
    id: &'static str,
    display_name: &'static str,
    target: &'static str,
    lifecycle: &'static str,
    capabilities: &'static [&'static str],
    privacy_summary: &'static str,
    stale_after_seconds: u64,
    source_url: Option<&'static str>,
}

struct BuiltinModel {
    id: &'static str,
    provider_id: &'static str,
    display_name: &'static str,
    family: &'static str,
    target: &'static str,
    lifecycle: &'static str,
    capabilities: &'static [&'static str],
    bundled: bool,
    package_type: &'static str,
    architecture: Option<&'static str>,
    license_name: &'static str,
    license_spdx_id: Option<&'static str>,
    license_source_url: &'static str,
    license_commercial_use: &'static str,
    license_requires_acceptance: bool,
    recommended: bool,
    speed_score: u32,
    quality_score: u32,
    min_vram_gb: Option<f64>,
    expected_download_gb: Option<f64>,
    cost_hint: Option<&'static str>,
    privacy_summary: &'static str,
    limitation: Option<&'static str>,
    stale_after_seconds: u64,
    source_url: Option<&'static str>,
}

const IMAGE_GENERATION_CAPABILITIES: &[&str] =
    &["text-to-image", "image-to-image", "multi-reference-edit"];
const GUIDED_SVG_GENERATION_CAPABILITIES: &[&str] = &[
    "text-to-svg",
    "image-to-svg",
    "guided-svg-generation",
    "svg-structure-evaluation",
    "render-verified",
];
const SVG_VECTORIZATION_CAPABILITIES: &[&str] = &[
    "text-to-svg",
    "image-to-svg",
    "svg-structure-evaluation",
    "render-verified",
];

const PROVIDERS: &[BuiltinProvider] = &[
    BuiltinProvider {
        id: "local-onnx",
        display_name: "Managed local ONNX Runtime",
        target: "local",
        lifecycle: "active",
        capabilities: &["background-remove", "transparent-output"],
        privacy_summary: "Pixels remain on this device.",
        stale_after_seconds: MONTH_SECONDS,
        source_url: Some("https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1"),
    },
    BuiltinProvider {
        id: "openai",
        display_name: "OpenAI",
        target: "remote",
        lifecycle: "active",
        capabilities: IMAGE_GENERATION_CAPABILITIES,
        privacy_summary: "Prompts and explicitly attached reference assets are sent to OpenAI.",
        stale_after_seconds: WEEK_SECONDS,
        source_url: Some("https://developers.openai.com/api/docs/models/gpt-image-2"),
    },
    BuiltinProvider {
        id: "quiver",
        display_name: "Quiver Arrow",
        target: "remote",
        lifecycle: "preview",
        capabilities: GUIDED_SVG_GENERATION_CAPABILITIES,
        privacy_summary: "Prompts and explicitly attached metadata-stripped reference images are sent to Quiver; returned SVG is quarantined and verified locally before publication.",
        stale_after_seconds: WEEK_SECONDS,
        source_url: Some("https://docs.quiver.ai/api-reference/create-svgs/generatesvg"),
    },
    BuiltinProvider {
        id: "recraft",
        display_name: "Recraft Vector",
        target: "remote",
        lifecycle: "active",
        capabilities: SVG_VECTORIZATION_CAPABILITIES,
        privacy_summary: "Prompts or explicitly selected metadata-stripped vectorization inputs are sent to Recraft; inline vector output is verified locally before publication.",
        stale_after_seconds: WEEK_SECONDS,
        source_url: Some("https://www.recraft.ai/docs/api-reference/endpoints"),
    },
    BuiltinProvider {
        id: "local-svg-runtime",
        display_name: "Local SVG model runtime",
        target: "local",
        lifecycle: "preview",
        capabilities: GUIDED_SVG_GENERATION_CAPABILITIES,
        privacy_summary: "Prompts and reference images remain on this device and are sent only to the configured loopback model runtime.",
        stale_after_seconds: MONTH_SECONDS,
        source_url: Some("https://huggingface.co/gitcat404/IntroSVG-Qwen2.5-VL-7B"),
    },
    BuiltinProvider {
        id: "local-diffusers",
        display_name: "Managed local Diffusers",
        target: "local",
        lifecycle: "active",
        capabilities: IMAGE_GENERATION_CAPABILITIES,
        privacy_summary: "Prompts and pixels remain on this device.",
        stale_after_seconds: MONTH_SECONDS,
        source_url: Some("https://huggingface.co/black-forest-labs/FLUX.2-klein-4B"),
    },
    BuiltinProvider {
        id: "local-utility",
        display_name: "Built-in media utilities",
        target: "local",
        lifecycle: "active",
        capabilities: &[
            "background-remove",
            "transparent-output",
            "image-quality-analysis",
        ],
        privacy_summary: "Pixels remain on this device.",
        stale_after_seconds: MONTH_SECONDS,
        source_url: None,
    },
];

const MODELS: &[BuiltinModel] = &[
    BuiltinModel {
        id: "openai:gpt-image-2",
        provider_id: "openai",
        display_name: "GPT Image 2",
        family: "OpenAI GPT Image",
        target: "remote",
        lifecycle: "active",
        capabilities: IMAGE_GENERATION_CAPABILITIES,
        bundled: false,
        package_type: "remote-endpoint",
        architecture: None,
        license_name: "OpenAI service terms",
        license_spdx_id: None,
        license_source_url: "https://openai.com/policies/service-terms/",
        license_commercial_use: "provider-terms",
        license_requires_acceptance: false,
        recommended: true,
        speed_score: 82,
        quality_score: 96,
        min_vram_gb: None,
        expected_download_gb: None,
        cost_hint: Some("Provider usage is billed per generated image."),
        privacy_summary:
            "Prompt text is sent to OpenAI; no source image is uploaded for text-to-image.",
        limitation: Some("Transparent output requires an explicit background-removal step."),
        stale_after_seconds: WEEK_SECONDS,
        source_url: Some("https://developers.openai.com/api/docs/models/gpt-image-2"),
    },
    BuiltinModel {
        id: "quiver:arrow-1.1-max",
        provider_id: "quiver",
        display_name: "Arrow 1.1 Max",
        family: "Quiver Arrow",
        target: "remote",
        lifecycle: "preview",
        capabilities: GUIDED_SVG_GENERATION_CAPABILITIES,
        bundled: false,
        package_type: "remote-endpoint",
        architecture: None,
        license_name: "Quiver service terms",
        license_spdx_id: None,
        license_source_url: "https://quiver.ai/terms",
        license_commercial_use: "provider-terms",
        license_requires_acceptance: false,
        recommended: true,
        speed_score: 72,
        quality_score: 98,
        min_vram_gb: None,
        expected_download_gb: None,
        cost_hint: Some("Provider usage is billed in Quiver credits per generated candidate."),
        privacy_summary: "Prompt text or an explicitly selected metadata-stripped vectorization source is sent to Quiver; all returned SVG markup is validated locally.",
        limitation: Some("Public API beta; generation and vectorization requests are rate limited per organization."),
        stale_after_seconds: WEEK_SECONDS,
        source_url: Some("https://docs.quiver.ai/api-reference/models/list-models"),
    },
    BuiltinModel {
        id: "quiver:arrow-1.1",
        provider_id: "quiver",
        display_name: "Arrow 1.1",
        family: "Quiver Arrow",
        target: "remote",
        lifecycle: "preview",
        capabilities: GUIDED_SVG_GENERATION_CAPABILITIES,
        bundled: false,
        package_type: "remote-endpoint",
        architecture: None,
        license_name: "Quiver service terms",
        license_spdx_id: None,
        license_source_url: "https://quiver.ai/terms",
        license_commercial_use: "provider-terms",
        license_requires_acceptance: false,
        recommended: false,
        speed_score: 86,
        quality_score: 91,
        min_vram_gb: None,
        expected_download_gb: None,
        cost_hint: Some("Provider usage is billed in Quiver credits per generated candidate."),
        privacy_summary: "Prompt text, up to four metadata-stripped guidance images, or one explicitly selected vectorization source is sent to Quiver; all returned SVG markup is validated locally.",
        limitation: Some("Public API beta; guided generation accepts up to four reference images."),
        stale_after_seconds: WEEK_SECONDS,
        source_url: Some("https://docs.quiver.ai/api-reference/models/list-models"),
    },
    BuiltinModel {
        id: "recraft:recraftv4_1_pro_vector",
        provider_id: "recraft",
        display_name: "Recraft V4.1 Pro Vector",
        family: "Recraft V4.1 Vector",
        target: "remote",
        lifecycle: "active",
        capabilities: SVG_VECTORIZATION_CAPABILITIES,
        bundled: false,
        package_type: "remote-endpoint",
        architecture: None,
        license_name: "Recraft service terms",
        license_spdx_id: None,
        license_source_url: "https://www.recraft.ai/terms",
        license_commercial_use: "provider-terms",
        license_requires_acceptance: false,
        recommended: true,
        speed_score: 69,
        quality_score: 97,
        min_vram_gb: None,
        expected_download_gb: None,
        cost_hint: Some("Provider usage is billed per vector generation."),
        privacy_summary: "Prompt text or one explicitly selected metadata-stripped vectorization source is sent to Recraft; vector output is verified locally.",
        limitation: Some("Prompt generation returns at most six candidates; dedicated vectorization returns one SVG."),
        stale_after_seconds: WEEK_SECONDS,
        source_url: Some("https://www.recraft.ai/docs/api-reference/endpoints"),
    },
    BuiltinModel {
        id: "recraft:recraftv4_1_vector",
        provider_id: "recraft",
        display_name: "Recraft V4.1 Vector",
        family: "Recraft V4.1 Vector",
        target: "remote",
        lifecycle: "active",
        capabilities: SVG_VECTORIZATION_CAPABILITIES,
        bundled: false,
        package_type: "remote-endpoint",
        architecture: None,
        license_name: "Recraft service terms",
        license_spdx_id: None,
        license_source_url: "https://www.recraft.ai/terms",
        license_commercial_use: "provider-terms",
        license_requires_acceptance: false,
        recommended: false,
        speed_score: 88,
        quality_score: 91,
        min_vram_gb: None,
        expected_download_gb: None,
        cost_hint: Some("Provider usage is billed per vector generation."),
        privacy_summary: "Prompt text or one explicitly selected metadata-stripped vectorization source is sent to Recraft; vector output is verified locally.",
        limitation: Some("Prompt generation returns at most six candidates; dedicated vectorization returns one SVG."),
        stale_after_seconds: WEEK_SECONDS,
        source_url: Some("https://www.recraft.ai/docs/api-reference/endpoints"),
    },
    BuiltinModel {
        id: "local-svg:IntroSVG-Qwen2.5-VL-7B",
        provider_id: "local-svg-runtime",
        display_name: "IntroSVG 7B",
        family: "IntroSVG",
        target: "local",
        lifecycle: "preview",
        capabilities: GUIDED_SVG_GENERATION_CAPABILITIES,
        bundled: false,
        package_type: "remote-endpoint",
        architecture: None,
        license_name: "Apache License 2.0",
        license_spdx_id: Some("Apache-2.0"),
        license_source_url: "https://huggingface.co/gitcat404/IntroSVG-Qwen2.5-VL-7B",
        license_commercial_use: "allowed",
        license_requires_acceptance: false,
        recommended: true,
        speed_score: 58,
        quality_score: 94,
        min_vram_gb: Some(18.0),
        expected_download_gb: Some(15.0),
        cost_hint: Some("Runs through a user-configured local OpenAI-compatible endpoint."),
        privacy_summary: "Prompts remain on this device when the endpoint is loopback-only.",
        limitation: Some("Requires a separately managed vLLM or SGLang-compatible local runtime."),
        stale_after_seconds: MONTH_SECONDS,
        source_url: Some("https://huggingface.co/gitcat404/IntroSVG-Qwen2.5-VL-7B"),
    },
    BuiltinModel {
        id: "local-svg:InternSVG-8B",
        provider_id: "local-svg-runtime",
        display_name: "InternSVG 8B",
        family: "InternSVG",
        target: "local",
        lifecycle: "preview",
        capabilities: GUIDED_SVG_GENERATION_CAPABILITIES,
        bundled: false,
        package_type: "remote-endpoint",
        architecture: None,
        license_name: "Apache License 2.0",
        license_spdx_id: Some("Apache-2.0"),
        license_source_url: "https://github.com/hmwang2002/InternSVG",
        license_commercial_use: "allowed",
        license_requires_acceptance: false,
        recommended: false,
        speed_score: 54,
        quality_score: 92,
        min_vram_gb: Some(20.0),
        expected_download_gb: Some(16.0),
        cost_hint: Some("Runs through a user-configured local OpenAI-compatible endpoint."),
        privacy_summary: "Prompts remain on this device when the endpoint is loopback-only.",
        limitation: Some("Requires a separately managed local multimodal runtime."),
        stale_after_seconds: MONTH_SECONDS,
        source_url: Some("https://github.com/hmwang2002/InternSVG"),
    },
    BuiltinModel {
        id: "local-svg:VFIG-4B",
        provider_id: "local-svg-runtime",
        display_name: "VFIG 4B",
        family: "VFIG",
        target: "local",
        lifecycle: "preview",
        capabilities: GUIDED_SVG_GENERATION_CAPABILITIES,
        bundled: false,
        package_type: "remote-endpoint",
        architecture: None,
        license_name: "Creative Commons Attribution 4.0",
        license_spdx_id: Some("CC-BY-4.0"),
        license_source_url: "https://huggingface.co/XunmeiLiu/VFIG-4B",
        license_commercial_use: "allowed",
        license_requires_acceptance: false,
        recommended: false,
        speed_score: 68,
        quality_score: 93,
        min_vram_gb: Some(12.0),
        expected_download_gb: Some(9.0),
        cost_hint: Some("Runs through a user-configured local OpenAI-compatible endpoint."),
        privacy_summary: "Prompts remain on this device when the endpoint is loopback-only.",
        limitation: Some("Specialized for scientific and technical figure composition."),
        stale_after_seconds: MONTH_SECONDS,
        source_url: Some("https://github.com/RAIVNLab/VFig"),
    },
    BuiltinModel {
        id: "local:flux-2-klein-4b",
        provider_id: "local-diffusers",
        display_name: "FLUX.2 klein 4B",
        family: "FLUX.2 klein",
        target: "local",
        lifecycle: "active",
        capabilities: IMAGE_GENERATION_CAPABILITIES,
        bundled: false,
        package_type: "diffusers",
        architecture: Some("flux-2"),
        license_name: "Apache License 2.0",
        license_spdx_id: Some("Apache-2.0"),
        license_source_url: "https://www.apache.org/licenses/LICENSE-2.0",
        license_commercial_use: "allowed",
        license_requires_acceptance: true,
        recommended: true,
        speed_score: 74,
        quality_score: 88,
        min_vram_gb: Some(13.0),
        expected_download_gb: Some(14.9),
        cost_hint: Some("No provider charge; uses local GPU time and power."),
        privacy_summary: "Prompt and generated pixels remain on this device.",
        limitation: Some("Requires an installed, verified Diffusers runtime and compatible GPU."),
        stale_after_seconds: MONTH_SECONDS,
        source_url: Some("https://huggingface.co/black-forest-labs/FLUX.2-klein-4B"),
    },
    BuiltinModel {
        id: "local:border-matte-v1",
        provider_id: "local-utility",
        display_name: "Local Border Matte",
        family: "Machdoch border matte",
        target: "local",
        lifecycle: "active",
        capabilities: &["background-remove", "transparent-output"],
        bundled: true,
        package_type: "native-utility",
        architecture: None,
        license_name: "Machdoch bundled utility",
        license_spdx_id: None,
        license_source_url: "https://github.com/machdoch/machdoch",
        license_commercial_use: "allowed",
        license_requires_acceptance: false,
        recommended: true,
        speed_score: 98,
        quality_score: 72,
        min_vram_gb: Some(0.0),
        expected_download_gb: Some(0.0),
        cost_hint: Some("No provider charge; uses local CPU time."),
        privacy_summary: "Pixels remain on this device.",
        limitation: Some("Designed for subjects separated from a uniform background connected to the image border."),
        stale_after_seconds: MONTH_SECONDS,
        source_url: None,
    },
    BuiltinModel {
        id: "local:birefnet-matting",
        provider_id: "local-onnx",
        display_name: "BiRefNet Matting",
        family: "BiRefNet",
        target: "local",
        lifecycle: "active",
        capabilities: &["background-remove", "transparent-output"],
        bundled: false,
        package_type: "onnx",
        architecture: None,
        license_name: "MIT License",
        license_spdx_id: Some("MIT"),
        license_source_url: "https://github.com/ZhengPeng7/BiRefNet/blob/a0cf9925880620000aa2d1948d61bf659ddfdfaa/LICENSE",
        license_commercial_use: "allowed",
        license_requires_acceptance: true,
        recommended: true,
        speed_score: 55,
        quality_score: 94,
        min_vram_gb: None,
        expected_download_gb: Some(0.91),
        cost_hint: Some("No provider charge; uses local CPU time and memory."),
        privacy_summary: "Pixels remain on this device.",
        limitation: Some("The official 1024x1024 ONNX matting graph prioritizes subject-edge quality and may be slower on CPU-only systems."),
        stale_after_seconds: MONTH_SECONDS,
        source_url: Some("https://github.com/ZhengPeng7/BiRefNet/releases/tag/v1"),
    },
    BuiltinModel {
        id: "local:image-quality-baseline",
        provider_id: "local-utility",
        display_name: "Technical Quality Baseline",
        family: "Machdoch media utility",
        target: "local",
        lifecycle: "active",
        capabilities: &["image-quality-analysis"],
        bundled: true,
        package_type: "native-utility",
        architecture: None,
        license_name: "Machdoch bundled utility",
        license_spdx_id: None,
        license_source_url: "https://github.com/machdoch/machdoch",
        license_commercial_use: "allowed",
        license_requires_acceptance: false,
        recommended: true,
        speed_score: 98,
        quality_score: 80,
        min_vram_gb: Some(0.0),
        expected_download_gb: Some(0.0),
        cost_hint: Some("Runs locally."),
        privacy_summary: "Only deterministic local image checks are performed.",
        limitation: None,
        stale_after_seconds: MONTH_SECONDS,
        source_url: None,
    },
];

pub(crate) fn synchronize(connection: &mut Connection) -> MediaResult<()> {
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin media catalog synchronization: {error}"))?;
    let synced_at = database::now();
    for provider in PROVIDERS {
        let capabilities_json = serde_json::to_string(provider.capabilities)
            .map_err(|error| format!("failed to encode provider capabilities: {error}"))?;
        transaction
            .execute(
                "INSERT INTO media_providers(\n\
                   id, display_name, target, lifecycle, capabilities_json, privacy_summary,\n\
                   checked_at, stale_after_seconds, source_url, catalog_revision, updated_at\n\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)\n\
                 ON CONFLICT(id) DO UPDATE SET\n\
                   display_name = excluded.display_name, target = excluded.target,\n\
                   lifecycle = excluded.lifecycle, capabilities_json = excluded.capabilities_json,\n\
                   privacy_summary = excluded.privacy_summary, checked_at = excluded.checked_at,\n\
                   stale_after_seconds = excluded.stale_after_seconds, source_url = excluded.source_url,\n\
                   catalog_revision = excluded.catalog_revision, updated_at = excluded.updated_at",
                params![
                    provider.id,
                    provider.display_name,
                    provider.target,
                    provider.lifecycle,
                    capabilities_json,
                    provider.privacy_summary,
                    CATALOG_CHECKED_AT,
                    provider.stale_after_seconds as i64,
                    provider.source_url,
                    CATALOG_REVISION,
                    synced_at,
                ],
            )
            .map_err(|error| format!("failed to synchronize media provider: {error}"))?;
    }
    for model in MODELS {
        let capabilities_json = serde_json::to_string(model.capabilities)
            .map_err(|error| format!("failed to encode model capabilities: {error}"))?;
        let addon_capabilities_json = serde_json::to_string(&model_addon::capabilities_for_model(
            model.provider_id,
            model.architecture,
        ))
        .map_err(|error| format!("failed to encode model add-on capabilities: {error}"))?;
        transaction
            .execute(
                "INSERT INTO media_models(\n\
                   id, provider_id, display_name, family, target, lifecycle, lifecycle_checked_at,\n\
                   lifecycle_stale_after_seconds, lifecycle_source_url, catalog_revision, capabilities_json,\n\
                   architecture, addon_capabilities_json, bundled, package_type, license_name, license_spdx_id, license_source_url,\n\
                   license_commercial_use, license_requires_acceptance, recommended, speed_score,\n\
                   quality_score, min_vram_gb, expected_download_gb, cost_hint, privacy_summary, limitation, updated_at\n\
                 ) VALUES (\n\
                   ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,\n\
                   ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29\n\
                 ) ON CONFLICT(id) DO UPDATE SET\n\
                   provider_id = excluded.provider_id, display_name = excluded.display_name, family = excluded.family,\n\
                   target = excluded.target, lifecycle = excluded.lifecycle, lifecycle_checked_at = excluded.lifecycle_checked_at,\n\
                   lifecycle_stale_after_seconds = excluded.lifecycle_stale_after_seconds,\n\
                   lifecycle_source_url = excluded.lifecycle_source_url, catalog_revision = excluded.catalog_revision,\n\
                   capabilities_json = excluded.capabilities_json, architecture = excluded.architecture,\n\
                   addon_capabilities_json = excluded.addon_capabilities_json, bundled = excluded.bundled, package_type = excluded.package_type,\n\
                   license_name = excluded.license_name, license_spdx_id = excluded.license_spdx_id,\n\
                   license_source_url = excluded.license_source_url, license_commercial_use = excluded.license_commercial_use,\n\
                   license_requires_acceptance = excluded.license_requires_acceptance, recommended = excluded.recommended,\n\
                   speed_score = excluded.speed_score, quality_score = excluded.quality_score, min_vram_gb = excluded.min_vram_gb,\n\
                   expected_download_gb = excluded.expected_download_gb, cost_hint = excluded.cost_hint,\n\
                   privacy_summary = excluded.privacy_summary, limitation = excluded.limitation, updated_at = excluded.updated_at",
                params![
                    model.id,
                    model.provider_id,
                    model.display_name,
                    model.family,
                    model.target,
                    model.lifecycle,
                    CATALOG_CHECKED_AT,
                    model.stale_after_seconds as i64,
                    model.source_url,
                    CATALOG_REVISION,
                    capabilities_json,
                    model.architecture,
                    addon_capabilities_json,
                    model.bundled,
                    model.package_type,
                    model.license_name,
                    model.license_spdx_id,
                    model.license_source_url,
                    model.license_commercial_use,
                    model.license_requires_acceptance,
                    model.recommended,
                    model.speed_score,
                    model.quality_score,
                    model.min_vram_gb,
                    model.expected_download_gb,
                    model.cost_hint,
                    model.privacy_summary,
                    model.limitation,
                    synced_at,
                ],
            )
            .map_err(|error| format!("failed to synchronize media model: {error}"))?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO media_model_lifecycle_snapshots(\n\
                   model_id, lifecycle, checked_at, source_url, catalog_revision, observed_at\n\
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    model.id,
                    model.lifecycle,
                    CATALOG_CHECKED_AT,
                    model.source_url,
                    CATALOG_REVISION,
                    synced_at,
                ],
            )
            .map_err(|error| format!("failed to snapshot media model lifecycle: {error}"))?;
    }
    let known_model_ids = MODELS.iter().map(|model| model.id).collect::<HashSet<_>>();
    let stored_model_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM media_models")
            .map_err(|error| format!("failed to inspect stored media models: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to query stored media models: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode stored media models: {error}"))?;
        rows
    };
    for model_id in stored_model_ids.iter().filter(|model_id| {
        !known_model_ids.contains(model_id.as_str())
            && !model_id.starts_with(model_import::USER_MODEL_ID_PREFIX)
    }) {
        transaction
            .execute(
                "UPDATE media_models\n\
                 SET lifecycle = 'removed', recommended = 0, catalog_revision = ?2, updated_at = ?3\n\
                 WHERE id = ?1",
                params![model_id, CATALOG_REVISION, synced_at],
            )
            .map_err(|error| format!("failed to tombstone removed media model: {error}"))?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO media_model_lifecycle_snapshots(\n\
                   model_id, lifecycle, checked_at, source_url, catalog_revision, observed_at\n\
                 ) SELECT id, 'removed', ?2, lifecycle_source_url, ?3, ?4\n\
                   FROM media_models WHERE id = ?1",
                params![model_id, CATALOG_CHECKED_AT, CATALOG_REVISION, synced_at],
            )
            .map_err(|error| format!("failed to snapshot removed media model: {error}"))?;
    }
    let known_provider_ids = PROVIDERS
        .iter()
        .map(|provider| provider.id)
        .collect::<HashSet<_>>();
    let stored_provider_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM media_providers")
            .map_err(|error| format!("failed to inspect stored media providers: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("failed to query stored media providers: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode stored media providers: {error}"))?;
        rows
    };
    for provider_id in stored_provider_ids
        .iter()
        .filter(|provider_id| !known_provider_ids.contains(provider_id.as_str()))
    {
        transaction
            .execute(
                "UPDATE media_providers\n\
                 SET lifecycle = 'removed', catalog_revision = ?2, updated_at = ?3\n\
                 WHERE id = ?1",
                params![provider_id, CATALOG_REVISION, synced_at],
            )
            .map_err(|error| format!("failed to tombstone removed media provider: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit media catalog synchronization: {error}"))
}

fn decode_capabilities(value: String, label: &str) -> MediaResult<Vec<String>> {
    serde_json::from_str(&value)
        .map_err(|error| format!("failed to decode {label} capabilities: {error}"))
}

pub(crate) fn snapshot(
    connection: &Connection,
    configured_provider_ids: &HashSet<String>,
) -> MediaResult<MediaModelCatalogSnapshot> {
    let providers = {
        let mut statement = connection
            .prepare(
                "SELECT id, display_name, target, lifecycle, capabilities_json, privacy_summary,\n\
                        checked_at, stale_after_seconds, source_url, catalog_revision\n\
                 FROM media_providers ORDER BY target DESC, display_name",
            )
            .map_err(|error| format!("failed to prepare media provider catalog: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                let id = row.get::<_, String>(0)?;
                Ok((
                    id,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                ))
            })
            .map_err(|error| format!("failed to query media provider catalog: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode media provider catalog: {error}"))?;
        rows
    };
    let providers = providers
        .into_iter()
        .map(
            |(
                id,
                display_name,
                target,
                lifecycle,
                capabilities_json,
                privacy_summary,
                checked_at,
                stale_after_seconds,
                source_url,
                catalog_revision,
            )| {
                let configured = if id == "local-svg-runtime" {
                    configured_provider_ids.contains(&id)
                } else {
                    target == "local" || configured_provider_ids.contains(&id)
                };
                Ok(MediaProviderCatalogEntry {
                    id,
                    display_name,
                    target,
                    configured,
                    lifecycle,
                    capabilities: decode_capabilities(capabilities_json, "provider")?,
                    privacy_summary,
                    checked_at,
                    stale_after_seconds: stale_after_seconds.max(0) as u64,
                    source_url,
                    catalog_revision,
                })
            },
        )
        .collect::<MediaResult<Vec<_>>>()?;

    let models = {
        let mut statement = connection
            .prepare(
                "SELECT m.id, m.provider_id, m.display_name, m.family, m.target, m.lifecycle,\n\
                        m.lifecycle_checked_at, m.lifecycle_stale_after_seconds, m.lifecycle_source_url,\n\
                        m.catalog_revision, m.capabilities_json, m.bundled, m.package_type,\n\
                        m.license_name, m.license_spdx_id, m.license_source_url,\n\
                        m.license_commercial_use, m.license_requires_acceptance, m.recommended,\n\
                        m.speed_score, m.quality_score, m.min_vram_gb, m.expected_download_gb,\n\
                        m.cost_hint, m.privacy_summary, m.limitation,\n\
                        i.status, i.revision, m.architecture, m.addon_capabilities_json\n\
                 FROM media_models m\n\
                 LEFT JOIN media_model_installations i ON i.model_id = m.id\n\
                 ORDER BY m.target DESC, m.recommended DESC, m.display_name",
            )
            .map_err(|error| format!("failed to prepare media model catalog: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, bool>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, Option<String>>(14)?,
                    row.get::<_, String>(15)?,
                    row.get::<_, String>(16)?,
                    row.get::<_, bool>(17)?,
                    row.get::<_, bool>(18)?,
                    row.get::<_, u32>(19)?,
                    row.get::<_, u32>(20)?,
                    row.get::<_, Option<f64>>(21)?,
                    row.get::<_, Option<f64>>(22)?,
                    row.get::<_, Option<String>>(23)?,
                    row.get::<_, String>(24)?,
                    row.get::<_, Option<String>>(25)?,
                    row.get::<_, Option<String>>(26)?,
                    row.get::<_, Option<String>>(27)?,
                    row.get::<_, Option<String>>(28)?,
                    row.get::<_, String>(29)?,
                ))
            })
            .map_err(|error| format!("failed to query media model catalog: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode media model catalog: {error}"))?;
        rows
    };
    let models = models
        .into_iter()
        .map(
            |(
                id,
                provider_id,
                display_name,
                family,
                target,
                lifecycle,
                lifecycle_checked_at,
                lifecycle_stale_after_seconds,
                lifecycle_source_url,
                catalog_revision,
                capabilities_json,
                bundled,
                package_type,
                license_name,
                license_spdx_id,
                license_source_url,
                license_commercial_use,
                license_requires_acceptance,
                recommended,
                speed_score,
                quality_score,
                min_vram_gb,
                expected_download_gb,
                cost_hint,
                privacy_summary,
                limitation,
                install_status,
                installed_revision,
                architecture,
                addon_capabilities_json,
            )| {
                let externally_managed_local_runtime = provider_id == "local-svg-runtime"
                    && configured_provider_ids.contains(&provider_id);
                let (installed, installation_status, installed_revision) = if target == "remote" {
                    (true, "remote".to_string(), None)
                } else if externally_managed_local_runtime {
                    (
                        true,
                        "installed".to_string(),
                        Some("external-runtime".to_string()),
                    )
                } else if bundled {
                    (true, "bundled".to_string(), Some(catalog_revision.clone()))
                } else {
                    let status = install_status.unwrap_or_else(|| "not-installed".to_string());
                    (status == "installed", status, installed_revision)
                };
                let user_imported = id.starts_with(model_import::USER_MODEL_ID_PREFIX);
                Ok(MediaModelDescriptor {
                    id,
                    provider_id: provider_id.clone(),
                    display_name,
                    family,
                    target: target.clone(),
                    lifecycle,
                    lifecycle_checked_at,
                    lifecycle_stale_after_seconds: lifecycle_stale_after_seconds.max(0) as u64,
                    lifecycle_source_url,
                    catalog_revision,
                    capabilities: decode_capabilities(capabilities_json, "model")?,
                    configured: if provider_id == "local-svg-runtime" {
                        configured_provider_ids.contains(&provider_id)
                    } else {
                        target == "local" || configured_provider_ids.contains(&provider_id)
                    },
                    installed,
                    bundled,
                    installation_status,
                    installed_revision,
                    package_type,
                    architecture,
                    addon_capabilities: serde_json::from_str(&addon_capabilities_json).map_err(
                        |error| format!("failed to decode model add-on capabilities: {error}"),
                    )?,
                    runtime_readiness: if provider_id == "local-diffusers" && installed {
                        "unverified".to_string()
                    } else {
                        "not-applicable".to_string()
                    },
                    runtime_readiness_diagnostic: None,
                    runtime_readiness_checked_at: None,
                    license: MediaModelLicense {
                        name: license_name,
                        spdx_id: license_spdx_id,
                        source_url: license_source_url,
                        commercial_use: license_commercial_use,
                        requires_acceptance: license_requires_acceptance,
                    },
                    recommended,
                    speed_score,
                    quality_score,
                    min_vram_gb,
                    expected_download_gb,
                    cost_hint,
                    privacy_summary,
                    limitation,
                    user_imported,
                })
            },
        )
        .collect::<MediaResult<Vec<_>>>()?;

    let addons = {
        let mut statement = connection
            .prepare(
                "SELECT id, kind, display_name, architecture, architecture_confidence, format,\n\
                        target_components_json, embedding_vectors_json, lora_profile_json, base_model_hint,\n\
                        trigger_words_json, default_token, digest, header_digest, byte_size,\n\
                        relative_path, source_url, source_metadata_json, license_name,\n\
                        license_source_url, license_commercial_use, imported_at\n\
                 FROM media_model_addons\n\
                 ORDER BY kind, display_name",
            )
            .map_err(|error| format!("failed to prepare media model add-ons: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, i64>(14)?,
                    row.get::<_, String>(15)?,
                    row.get::<_, Option<String>>(16)?,
                    row.get::<_, Option<String>>(17)?,
                    row.get::<_, String>(18)?,
                    row.get::<_, String>(19)?,
                    row.get::<_, String>(20)?,
                    row.get::<_, String>(21)?,
                ))
            })
            .map_err(|error| format!("failed to query media model add-ons: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("failed to decode media model add-ons: {error}"))?;
        rows.into_iter()
            .map(
                |(
                    id,
                    kind,
                    display_name,
                    architecture,
                    architecture_confidence,
                    format,
                    target_components_json,
                    embedding_vectors_json,
                    lora_profile_json,
                    base_model_hint,
                    trigger_words_json,
                    default_token,
                    digest,
                    header_digest,
                    byte_size,
                    relative_path,
                    source_url,
                    source_metadata_json,
                    license_name,
                    license_source_url,
                    license_commercial_use,
                    imported_at,
                )| {
                    Ok(MediaModelAddonDescriptor {
                        id,
                        kind,
                        display_name,
                        architecture,
                        architecture_confidence,
                        format,
                        target_components: decode_capabilities(
                            target_components_json,
                            "model add-on target component",
                        )?,
                        embedding_vectors:
                            serde_json::from_str::<Vec<MediaEmbeddingVectorProfile>>(
                                &embedding_vectors_json,
                            )
                            .map_err(|error| {
                                format!("failed to decode embedding vector profiles: {error}")
                            })?,
                        lora_profile: lora_profile_json
                            .map(|value| {
                                serde_json::from_str::<MediaLoraTensorProfile>(&value).map_err(
                                    |error| {
                                        format!("failed to decode LoRA tensor profile: {error}")
                                    },
                                )
                            })
                            .transpose()?,
                        base_model_hint,
                        trigger_words: decode_capabilities(
                            trigger_words_json,
                            "model add-on trigger word",
                        )?,
                        default_token,
                        digest,
                        header_digest,
                        byte_size: byte_size.max(0) as u64,
                        relative_path,
                        source_url,
                        source_metadata: source_metadata_json
                            .map(|value| {
                                serde_json::from_str(&value).map_err(|error| {
                                    format!(
                                        "failed to decode model add-on source metadata: {error}"
                                    )
                                })
                            })
                            .transpose()?,
                        license: MediaModelLicense {
                            name: license_name,
                            spdx_id: None,
                            source_url: license_source_url,
                            commercial_use: license_commercial_use,
                            requires_acceptance: false,
                        },
                        imported_at,
                    })
                },
            )
            .collect::<MediaResult<Vec<_>>>()?
    };

    Ok(MediaModelCatalogSnapshot {
        schema_version: 1,
        catalog_revision: CATALOG_REVISION.to_string(),
        observed_at: database::now(),
        providers,
        models,
        addons,
    })
}
