use rusqlite::{params, OptionalExtension};
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
    let student_profile = super::open_models::by_architecture(&request.architecture)
        .filter(|profile| profile.distillation.is_some());
    let license_name = student_profile.map_or(license_name, |student| student.license.name.clone());
    let commercial_use = student_profile.map_or(commercial_use, |student| {
        student.license.commercial_use.as_str()
    });
    let license_source_url = if let Some(student) = student_profile {
        student
            .license
            .source_url
            .as_deref()
            .ok_or("Student model profile has no licence source")?
    } else {
        source_url.as_deref().unwrap_or("")
    };
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
    let stored_architecture = transaction
        .query_row(
            "SELECT architecture FROM media_models WHERE id = ?1",
            [&request.resource_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("failed to read model: {error}"))?
        .flatten();
    if stored_architecture.as_deref().is_some_and(|architecture| {
        super::open_models::by_architecture(architecture)
            .is_some_and(|profile| profile.distillation.is_some())
            && architecture != request.architecture.as_str()
    }) {
        return Err(
            "A student model's type cannot be changed. Import the matching student folder."
                .to_string(),
        );
    }
    let updated = transaction
        .execute(
            "UPDATE media_models SET display_name = ?2, architecture = ?3, family = ?4,
         lifecycle_source_url = ?5, license_name = ?6, license_source_url = ?7,
         license_commercial_use = ?8, capabilities_json = ?9, addon_capabilities_json = ?10,
          min_vram_gb = ?11, speed_score = ?12, quality_score = ?13, updated_at = ?14,
          license_requires_acceptance = CASE WHEN ?15 THEN 1 ELSE license_requires_acceptance END WHERE id = ?1",
            params![
                request.resource_id,
                display_name,
                request.architecture,
                profile.family,
                source_url,
                license_name,
                license_source_url,
                commercial_use,
                capabilities,
                addon_capabilities,
                profile.min_vram_gb,
                profile.speed_score,
                profile.quality_score,
                database::now(),
                student_profile.is_some()
            ],
        )
        .map_err(|error| format!("failed to save model: {error}"))?;
    if updated == 0 {
        return Err("The model is unavailable. Refresh the library.".to_string());
    }
    transaction
        .commit()
        .map_err(|error| format!("failed to commit model update: {error}"))
}
