use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use tauri::ipc::{InvokeResponseBody, IpcResponse};

pub(super) fn error_value(error: impl Serialize) -> Value {
    serde_json::to_value(error).unwrap_or_else(|_| json!("Media operation failed."))
}

fn argument<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, Value> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null))
        .map_err(|error| json!(format!("Invalid {key}: {error}")))
}

fn check_arguments(args: &Value, allowed: &[&str]) -> Result<(), Value> {
    let object = args
        .as_object()
        .ok_or_else(|| json!("Expected media arguments."))?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(json!("Unexpected media argument."));
    }
    Ok(())
}

fn binary_value(response: tauri::ipc::Response) -> Result<Value, Value> {
    use base64::Engine;
    match response.body().map_err(|error| json!(error.to_string()))? {
        InvokeResponseBody::Raw(bytes) => {
            Ok(json!({"binary": base64::engine::general_purpose::STANDARD.encode(bytes)}))
        }
        InvokeResponseBody::Json(value) => {
            serde_json::from_str(&value).map_err(|error| json!(error.to_string()))
        }
    }
}

pub(super) async fn invoke(
    app: tauri::AppHandle,
    command: String,
    args: Value,
) -> Result<Value, Value> {
    Ok(match command.as_str() {
        "run_media_flow_agent" => {
            check_arguments(&args, &["workspaceRoot", "request"])?;
            crate::desktop_task::media_flow_agent::run_media_flow_agent(
                argument(&args, "workspaceRoot")?,
                argument(&args, "request")?,
            )
            .await
            .map_err(error_value)?
        }
        "media_read_studio_state" | "media_write_studio_state" => {
            check_arguments(
                &args,
                if command == "media_read_studio_state" {
                    &[]
                } else {
                    &["value"]
                },
            )?;
            super::fleet_store::execute(&app, &command, &args)?
        }
        "media_create_transfer"
        | "media_write_transfer"
        | "media_read_transfer"
        | "media_remove_transfer" => {
            check_arguments(
                &args,
                match command.as_str() {
                    "media_create_transfer" => &["id", "name"],
                    "media_write_transfer" => &["id", "offset", "data"],
                    "media_read_transfer" => &["id", "offset"],
                    _ => &["id"],
                },
            )?;
            super::fleet_transfer::execute(&app, &command, &args)?
        }
        "media_search_civitai" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::civitai_commands::media_search_civitai(argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_get_civitai_model" => {
            check_arguments(&args, &["source", "nsfw"])?;
            serde_json::to_value(
                super::civitai_commands::media_get_civitai_model(
                    argument(&args, "source")?,
                    argument(&args, "nsfw")?,
                )
                .await
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_inspect_civitai_file" => {
            check_arguments(&args, &["source", "fileId"])?;
            serde_json::to_value(
                super::civitai_commands::media_inspect_civitai_file(
                    argument(&args, "source")?,
                    argument(&args, "fileId")?,
                )
                .await
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_civitai_storage" => {
            check_arguments(&args, &["fileBytes"])?;
            serde_json::to_value(
                super::civitai_commands::media_civitai_storage(
                    app.clone(),
                    argument(&args, "fileBytes")?,
                )
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_connect_civitai" => {
            check_arguments(&args, &["token"])?;
            serde_json::to_value(
                super::civitai_commands::media_connect_civitai(argument(&args, "token")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_civitai_connection" => {
            check_arguments(&args, &[])?;
            serde_json::to_value(
                super::civitai_commands::media_civitai_connection().map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_download_civitai_resource" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::civitai_commands::media_download_civitai_resource(
                    app.clone(),
                    argument(&args, "request")?,
                )
                .await
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_cancel_civitai_download" => {
            check_arguments(&args, &["operationId"])?;
            serde_json::to_value(
                super::civitai_commands::media_cancel_civitai_download(argument(
                    &args,
                    "operationId",
                )?)
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_civitai_options" => {
            check_arguments(&args, &[])?;
            serde_json::to_value(
                super::civitai_commands::media_civitai_options()
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_initialize_runtime" => {
            check_arguments(&args, &[])?;
            serde_json::to_value(super::media_initialize_runtime(app.clone()).map_err(error_value)?)
                .map_err(|error| json!(error.to_string()))?
        }
        "media_refresh_local_diffusers_runtime" => {
            check_arguments(&args, &[])?;
            serde_json::to_value(
                super::media_refresh_local_diffusers_runtime(app.clone())
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_list_flows" => {
            check_arguments(&args, &[])?;
            serde_json::to_value(super::media_list_flows(app.clone()).map_err(error_value)?)
                .map_err(|error| json!(error.to_string()))?
        }
        "media_get_flow" => {
            check_arguments(&args, &["flowId"])?;
            serde_json::to_value(
                super::media_get_flow(app.clone(), argument(&args, "flowId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_save_flow_revision" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_save_flow_revision(app.clone(), argument(&args, "request")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_export_flow_revision" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_export_flow_revision(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_inspect_flow_import" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_inspect_flow_import(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_import_flow" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_import_flow(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_inspect_local_model" => {
            check_arguments(&args, &["sourcePath"])?;
            serde_json::to_value(
                super::media_inspect_local_model(app.clone(), argument(&args, "sourcePath")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_import_local_model" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_import_local_model(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_probe_local_model" => {
            check_arguments(&args, &["modelId"])?;
            serde_json::to_value(
                super::media_probe_local_model(app.clone(), argument(&args, "modelId")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_inspect_model_addon" => {
            check_arguments(&args, &["sourcePath"])?;
            serde_json::to_value(
                super::media_inspect_model_addon(app.clone(), argument(&args, "sourcePath")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_inspect_civitai_model_addon" => {
            check_arguments(&args, &["source"])?;
            serde_json::to_value(
                super::media_inspect_civitai_model_addon(argument(&args, "source")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_import_model_addon" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_import_model_addon(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_plan_model_addon_removal" => {
            check_arguments(&args, &["addonId"])?;
            serde_json::to_value(
                super::media_plan_model_addon_removal(app.clone(), argument(&args, "addonId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_update_model_resource" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_update_model_resource(app.clone(), argument(&args, "request")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_remove_model_addon" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_remove_model_addon(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_plan_model_install" => {
            check_arguments(&args, &["modelId"])?;
            serde_json::to_value(
                super::media_plan_model_install(app.clone(), argument(&args, "modelId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_start_model_install" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_start_model_install(app.clone(), argument(&args, "request")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_get_model_install_job" => {
            check_arguments(&args, &["jobId"])?;
            serde_json::to_value(
                super::media_get_model_install_job(app.clone(), argument(&args, "jobId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_cancel_model_install" => {
            check_arguments(&args, &["jobId"])?;
            serde_json::to_value(
                super::media_cancel_model_install(app.clone(), argument(&args, "jobId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_plan_model_removal" => {
            check_arguments(&args, &["modelId"])?;
            serde_json::to_value(
                super::media_plan_model_removal(app.clone(), argument(&args, "modelId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_remove_model" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_remove_model(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_generate_images" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_generate_images(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_generate_video" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_generate_video(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_generate_svg" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_generate_svg(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_execute_remote_image_edit_flow" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_execute_remote_image_edit_flow(
                    app.clone(),
                    argument(&args, "request")?,
                )
                .await
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_resolve_provider_review" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_resolve_provider_review(app.clone(), argument(&args, "request")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_resolve_human_review" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_resolve_human_review(app.clone(), argument(&args, "request")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_wake_provider_reconciliation" => {
            check_arguments(&args, &["providerJobId"])?;
            serde_json::to_value(
                super::media_wake_provider_reconciliation(
                    app.clone(),
                    argument(&args, "providerJobId")?,
                )
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_list_runs" => {
            check_arguments(&args, &["limit"])?;
            serde_json::to_value(
                super::media_list_runs(app.clone(), argument(&args, "limit")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_list_run_page" => {
            check_arguments(&args, &["offset", "limit", "knownRevision"])?;
            serde_json::to_value(
                super::media_list_run_page(
                    app.clone(),
                    argument(&args, "offset")?,
                    argument(&args, "limit")?,
                    argument(&args, "knownRevision")?,
                )
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_get_run_detail" => {
            check_arguments(&args, &["runId"])?;
            serde_json::to_value(
                super::media_get_run_detail(app.clone(), argument(&args, "runId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_cancel_run" => {
            check_arguments(&args, &["runId"])?;
            serde_json::to_value(
                super::media_cancel_run(app.clone(), argument(&args, "runId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_list_assets" => {
            check_arguments(&args, &["limit"])?;
            serde_json::to_value(
                super::media_list_assets(app.clone(), argument(&args, "limit")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_list_asset_page" => {
            check_arguments(&args, &["offset", "limit", "knownRevision"])?;
            serde_json::to_value(
                super::media_list_asset_page(
                    app.clone(),
                    argument(&args, "offset")?,
                    argument(&args, "limit")?,
                    argument(&args, "knownRevision")?,
                )
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_get_model_catalog" => {
            check_arguments(&args, &["configuredProviderIds"])?;
            serde_json::to_value(
                super::media_get_model_catalog(
                    app.clone(),
                    argument(&args, "configuredProviderIds")?,
                )
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_discover_workspace_models" => {
            check_arguments(&args, &["workspaceRoot"])?;
            serde_json::to_value(
                super::media_discover_workspace_models(argument(&args, "workspaceRoot")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_set_asset_tags" => {
            check_arguments(&args, &["assetId", "tags"])?;
            serde_json::to_value(
                super::media_set_asset_tags(
                    app.clone(),
                    argument(&args, "assetId")?,
                    argument(&args, "tags")?,
                )
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_auto_tag_asset" => {
            check_arguments(&args, &["assetId"])?;
            serde_json::to_value(
                super::media_auto_tag_asset(app.clone(), argument(&args, "assetId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_plan_asset_deletion" => {
            check_arguments(&args, &["assetId"])?;
            serde_json::to_value(
                super::media_plan_asset_deletion(app.clone(), argument(&args, "assetId")?)
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_delete_asset" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_delete_asset(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_inspect_hardware" => {
            check_arguments(&args, &[])?;
            serde_json::to_value(super::media_inspect_hardware(app.clone()).map_err(error_value)?)
                .map_err(|error| json!(error.to_string()))?
        }
        "media_import_image" => {
            check_arguments(&args, &["path"])?;
            serde_json::to_value(
                super::media_import_image(app.clone(), argument(&args, "path")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_create_pose_map" => {
            check_arguments(&args, &["map"])?;
            serde_json::to_value(
                super::media_create_pose_map(app.clone(), argument(&args, "map")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_install_pose_control" => {
            check_arguments(&args, &["architecture"])?;
            serde_json::to_value(
                super::media_install_pose_control(app.clone(), argument(&args, "architecture")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_import_image_url" => {
            check_arguments(&args, &["url"])?;
            serde_json::to_value(
                super::media_import_image_url(app.clone(), argument(&args, "url")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_read_asset_preview" => {
            check_arguments(&args, &["assetId", "maxEdge"])?;
            binary_value(
                super::media_read_asset_preview(
                    app.clone(),
                    argument(&args, "assetId")?,
                    argument(&args, "maxEdge")?,
                )
                .await
                .map_err(error_value)?,
            )?
        }
        "media_transform_image" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_transform_image(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_execute_local_image_flow" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_execute_local_image_flow(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_export_asset" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::media_export_asset(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_analyze_image_quality" => {
            check_arguments(&args, &["sourceAssetId"])?;
            serde_json::to_value(
                super::media_analyze_image_quality(app.clone(), argument(&args, "sourceAssetId")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_read_quality_report" => {
            check_arguments(&args, &["reportAssetId"])?;
            serde_json::to_value(
                super::media_read_quality_report(app.clone(), argument(&args, "reportAssetId")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_execute_workflow" => {
            check_arguments(&args, &["request"])?;
            serde_json::to_value(
                super::workflow::media_execute_workflow(app.clone(), argument(&args, "request")?)
                    .await
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_install_workflow_model" => {
            check_arguments(&args, &["kind"])?;
            serde_json::to_value(
                super::workflow_models::media_install_workflow_model(
                    app.clone(),
                    argument(&args, "kind")?,
                )
                .await
                .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_get_runtime_setup" => {
            check_arguments(&args, &[])?;
            serde_json::to_value(
                super::runtime_setup::media_get_runtime_setup(app.clone()).map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        "media_start_runtime_setup" => {
            check_arguments(&args, &[])?;
            serde_json::to_value(
                super::runtime_setup::media_start_runtime_setup(app.clone())
                    .map_err(error_value)?,
            )
            .map_err(|error| json!(error.to_string()))?
        }
        _ => return Err(json!("Unknown media command.")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_native_argument_shapes_and_rejects_extra_fields() {
        assert!(check_arguments(&json!({"assetId":"a","path":"secret"}), &["assetId"]).is_err());
        assert!(check_arguments(&json!([]), &[]).is_err());
        assert!(check_arguments(&json!({"assetId":"a"}), &["assetId"]).is_ok());
        assert_eq!(
            argument::<String>(&json!({"assetId":"a"}), "assetId").unwrap(),
            "a"
        );
        assert!(argument::<String>(&json!({"assetId":12}), "assetId").is_err());
        assert_eq!(
            argument::<Option<String>>(&json!({}), "workspaceRoot").unwrap(),
            None
        );
    }
}
