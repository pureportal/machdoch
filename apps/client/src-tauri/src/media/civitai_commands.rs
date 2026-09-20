use tauri::AppHandle;

use super::{
    civitai_addon, civitai_catalog, database,
    error::{command_result, MediaCommandResult},
    MediaRuntimePaths,
};

#[tauri::command]
pub(crate) fn media_civitai_storage(
    app: AppHandle,
    file_bytes: u64,
) -> MediaCommandResult<super::civitai_storage::CivitaiStorage> {
    command_result(
        "media_civitai_storage",
        MediaRuntimePaths::resolve(&app)
            .and_then(|paths| super::civitai_storage::inspect(&paths, file_bytes)),
    )
}

#[tauri::command]
pub(crate) async fn media_search_civitai(
    request: civitai_catalog::CivitaiSearchRequest,
) -> MediaCommandResult<civitai_catalog::CivitaiSearchPage> {
    command_result(
        "media_search_civitai",
        civitai_catalog::search(&request).await,
    )
}

#[tauri::command]
pub(crate) async fn media_get_civitai_model(
    source: String,
    nsfw: bool,
) -> MediaCommandResult<civitai_catalog::CivitaiCatalogModel> {
    command_result(
        "media_get_civitai_model",
        civitai_catalog::get_model(&source, nsfw).await,
    )
}

#[tauri::command]
pub(crate) async fn media_inspect_civitai_file(
    source: String,
    file_id: u64,
) -> MediaCommandResult<civitai_addon::MediaCivitaiModelAddonInspection> {
    command_result(
        "media_inspect_civitai_file",
        civitai_addon::inspect_file(&source, file_id).await,
    )
}

#[tauri::command]
pub(crate) async fn media_connect_civitai(token: Option<String>) -> MediaCommandResult<bool> {
    command_result(
        "media_connect_civitai",
        civitai_catalog::connect(token).await,
    )
}

#[tauri::command]
pub(crate) fn media_civitai_connection() -> MediaCommandResult<bool> {
    command_result(
        "media_civitai_connection",
        civitai_catalog::api_key().map(|key| key.is_some()),
    )
}

#[tauri::command]
pub(crate) async fn media_download_civitai_resource(
    app: AppHandle,
    request: civitai_addon::DownloadMediaCivitaiModelAddonRequest,
) -> MediaCommandResult<civitai_catalog::CivitaiDownloadedResource> {
    let result = async {
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        civitai_catalog::begin_download(&request.operation_id)?;
        let result = civitai_addon::download_reviewed(&paths, &request, &app).await;
        civitai_catalog::finish_download(&request.operation_id);
        result
    }
    .await;
    command_result("media_download_civitai_resource", result)
}

#[tauri::command]
pub(crate) fn media_cancel_civitai_download(operation_id: String) -> MediaCommandResult<()> {
    command_result(
        "media_cancel_civitai_download",
        civitai_catalog::cancel_download(&operation_id),
    )
}

#[tauri::command]
pub(crate) async fn media_civitai_options() -> MediaCommandResult<civitai_catalog::CivitaiOptions> {
    command_result("media_civitai_options", civitai_catalog::options().await)
}
