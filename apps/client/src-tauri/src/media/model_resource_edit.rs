use rusqlite::{params, OptionalExtension as _};
use serde::Deserialize;

use super::{database, model_addon, model_import, MediaResult, MediaRuntimePaths};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct UpdateMediaModelResourceRequest {
    pub resource_id: String,
    pub display_name: String,
    pub architecture: String,
    pub source_url: Option<String>,
    pub license_name: Option<String>,
    pub commercial_use: Option<String>,
    pub trigger_words: Vec<String>,
}

pub(crate) fn update(
    paths: &MediaRuntimePaths,
    request: &UpdateMediaModelResourceRequest,
) -> MediaResult<()> {
    if request
        .resource_id
        .starts_with(model_addon::MODEL_ADDON_ID_PREFIX)
    {
        return model_addon::update_details(paths, request);
    }
    if !request
        .resource_id
        .starts_with(model_import::USER_MODEL_ID_PREFIX)
    {
        return Err("Only imported model details can be changed.".to_string());
    }
    let display_name = model_import::validated_text("Name", &request.display_name, 120)?;
    let source_url = model_import::validated_source_url(request.source_url.as_deref())?;
    let license_name =
        model_import::validated_optional_text("License", request.license_name.as_deref(), 256)?;
    let commercial_use = request.commercial_use.as_deref().unwrap_or("unknown");
    if !matches!(commercial_use, "unknown" | "allowed" | "review-required") {
        return Err("Choose a valid commercial use setting.".to_string());
    }
    let profile = model_import::architecture_profile(&request.architecture)
        .ok_or_else(|| "Choose a supported model type.".to_string())?;
    let capabilities = serde_json::to_string(model_import::capabilities_for_architecture(
        &request.architecture,
    ))
    .map_err(|error| format!("failed to encode model capabilities: {error}"))?;
    let addon_capabilities = serde_json::to_string(&model_addon::capabilities_for_model(
        "local-diffusers",
        Some(&request.architecture),
    ))
    .map_err(|error| format!("failed to encode add-on capabilities: {error}"))?;
    let mut connection = database::open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin model update: {error}"))?;
    let previous_architecture: String = transaction
        .query_row(
            "SELECT architecture FROM media_models WHERE id = ?1",
            [&request.resource_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("failed to read model: {error}"))?
        .ok_or_else(|| "The model is unavailable. Refresh the library.".to_string())?;
    transaction
        .execute(
            "UPDATE media_models SET display_name = ?2, architecture = ?3, family = ?4,
         lifecycle_source_url = ?5, license_name = ?6, license_source_url = ?7,
         license_commercial_use = ?8, capabilities_json = ?9, addon_capabilities_json = ?10,
         min_vram_gb = ?11, speed_score = ?12, quality_score = ?13, updated_at = ?14 WHERE id = ?1",
            params![
                request.resource_id,
                display_name,
                request.architecture,
                profile.family,
                source_url,
                license_name,
                source_url.as_deref().unwrap_or(""),
                commercial_use,
                capabilities,
                addon_capabilities,
                profile.min_vram_gb,
                profile.speed_score,
                profile.quality_score,
                database::now()
            ],
        )
        .map_err(|error| format!("failed to save model: {error}"))?;
    if previous_architecture != request.architecture {
        transaction
            .execute(
                "DELETE FROM media_model_runtime_probes WHERE model_id = ?1",
                [&request.resource_id],
            )
            .map_err(|error| format!("failed to reset model verification: {error}"))?;
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model update: {error}"))
}
