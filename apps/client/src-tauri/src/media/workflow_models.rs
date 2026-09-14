use super::*;

#[tauri::command]
pub(crate) async fn media_install_workflow_model(
    app: AppHandle,
    kind: String,
) -> MediaCommandResult<String> {
    let result = async {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("workflow_models.json"))
                .map_err(|e| e.to_string())?;
        let files = manifest
            .get(&kind)
            .ok_or("Choose a prompt model, vision model, or upscaler")?
            .to_string();
        let paths = MediaRuntimePaths::resolve(&app)?;
        let root = paths.models_root()?.join("workflow").join(&kind);
        tauri::async_runtime::spawn_blocking(move || {
            let installed = model_components::ensure_components(&root, &files)?;
            Ok(match kind.as_str() {
                "upscale" => installed.join("RealESRGAN_x4.pth"),
                "upscale-span" => installed.join("4x-spanx4_ch48.safetensors"),
                _ => installed,
            }
            .to_string_lossy()
            .into_owned())
        })
        .await
        .map_err(|e| format!("Model download stopped: {e}"))?
    }
    .await;
    command_result("media_install_workflow_model", result)
}
