use super::*;

pub(crate) fn import_video(
    paths: &MediaRuntimePaths,
    app: &tauri::AppHandle,
    source_path: &str,
) -> MediaResult<MediaAssetImportResult> {
    let source_path = validate_source_path(source_path)?;
    let staged = stage_and_hash(paths, &source_path)?;
    let result = (|| {
        let decode_path = staged.path.with_extension("webm");
        fs::rename(&staged.path, &decode_path)
            .map_err(|error| format!("Could not stage video: {error}"))?;
        let staged = StagedAsset {
            path: decode_path.clone(),
            digest: staged.digest.clone(),
            byte_size: staged.byte_size,
        };
        let metadata =
            super::super::provider_local_diffusers::inspect_video(app, &decode_path, false);
        let result = metadata.and_then(|metadata| {
            let source_file_name = source_path.file_name().and_then(|name| name.to_str()).unwrap_or("video.webm");
            let operation = serde_json::json!({"kind": "local-import", "mediaType": "video", "sourceFileName": source_file_name, "output": metadata}).to_string();
            let relative_path = promote_to_cas(paths, &staged)?;
            database::record_imported_asset(paths, database::ImportedAssetRegistration {
                digest: &staged.digest, relative_path: &relative_path.to_string_lossy(), byte_size: staged.byte_size,
                mime_type: "video/webm", width: metadata["width"].as_u64().unwrap() as u32, height: metadata["height"].as_u64().unwrap() as u32,
                import_kind: database::LocalImportKind::Video { source_file_name, operation_json: &operation },
            })
        });
        let _ = fs::remove_file(decode_path);
        result
    })();
    let _ = fs::remove_file(staged.path);
    result
}
