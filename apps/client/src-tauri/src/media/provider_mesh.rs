use super::*;
use crate::media::mesh::{validate_mesh_glb, GenerateMediaMeshRequest, GeneratedMesh, MAX_MESH_BYTES};
use crate::media::subject_cutout::{self, BIREFNET_MODEL_ID, BORDER_MATTE_MODEL_ID};

const PREVIEW_EDGE: u32 = 768;
const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;
const OPAQUE_ALPHA: u8 = 250;

fn has_transparency(image: &image::DynamicImage) -> bool {
    image.color().has_alpha() && image.to_rgba8().pixels().any(|pixel| pixel[3] < OPAQUE_ALPHA)
}

fn stage_views(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaMeshRequest,
    directory: &Path,
) -> MediaResult<(serde_json::Map<String, serde_json::Value>, serde_json::Value)> {
    let mut views = serde_json::Map::new();
    let mut cutouts = serde_json::Map::new();
    let priority = [BIREFNET_MODEL_ID.to_string(), BORDER_MATTE_MODEL_ID.to_string()];
    for (view, asset_id) in &request.views {
        let source = database::get_asset(paths, asset_id)?;
        if source.kind != "image"
            || !matches!(source.mime_type.as_str(), "image/png" | "image/jpeg" | "image/webp")
        {
            return Err("Choose PNG, JPEG, or WebP views.".into());
        }
        let (_, bytes) = transform::read_asset_original(paths, asset_id)?;
        let decoded = transform::decode_image_bytes(&bytes)?;
        let prepared = if request.remove_background && !has_transparency(&decoded) {
            let result = subject_cutout::cutout(paths, &decoded, &priority)?;
            cutouts.insert(
                view.clone(),
                serde_json::to_value(&result.summary).map_err(|error| error.to_string())?,
            );
            result.cutout
        } else {
            decoded
        };
        let path = directory.join(format!("{view}.png"));
        prepared
            .save_with_format(&path, image::ImageFormat::Png)
            .map_err(|error| format!("Could not stage the {view} view: {error}"))?;
        views.insert(view.clone(), serde_json::json!(path));
    }
    subject_cutout::release_session()?;
    Ok((views, serde_json::Value::Object(cutouts)))
}

pub(crate) fn generate_mesh(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &GenerateMediaMeshRequest,
) -> MediaResult<GeneratedMesh> {
    let script = worker_script(app)?;
    let (_, python) = ready_runtime(app, &script)?;
    let model = installed_model(paths, &request.model_id)?;
    if !matches!(model.architecture.as_str(), "hunyuan3d-2mv" | "hunyuan3d-2mv-turbo") {
        return Err("Choose a Hunyuan3D model.".into());
    }
    let input = create_staging_directory(paths)?;
    let (views, background_removal) = stage_views(paths, request, &input.0)?;
    let staging = create_staging_directory(paths)?;
    let payload = serde_json::json!({
        "schemaVersion": WORKER_SCHEMA_VERSION,
        "model": WorkerModel { id: &model.id, architecture: &model.architecture, package_kind: &model.package_kind,
            path: &model.path, config_path: None, revision: &model.revision, digest: &model.digest },
        "views": views, "seed": request.seed, "numInferenceSteps": request.num_inference_steps,
        "guidanceScale": request.guidance_scale, "octreeResolution": request.octree_resolution,
        "numChunks": request.num_chunks, "removeFloaters": request.remove_floaters,
        "maxFaceCount": request.max_face_count, "voxelize": request.voxelize,
        "voxelResolution": request.voxel_resolution, "voxelFill": request.voxel_fill,
        "outputDirectory": staging.0,
    });
    let process = run_worker(
        &python,
        &script,
        "generate-mesh",
        Some(&serde_json::to_vec(&payload).map_err(|error| error.to_string())?),
        GENERATION_TIMEOUT,
        Some((paths, &request.run_id)),
    )?;
    if !process.status.success() {
        let message = serde_json::from_slice::<WorkerFailure>(&process.stdout)
            .map(|failure| failure.error)
            .unwrap_or_else(|_| "3D mesh generation failed.".into());
        return Err(worker_failure_with_diagnostics(message, &process.stderr));
    }
    let mut provenance: serde_json::Value = serde_json::from_slice(&process.stdout)
        .map_err(|error| format!("3D mesh worker returned invalid JSON: {error}"))?;
    let evidence = |key: &str| {
        serde_json::from_value::<StagedFileEvidence>(provenance[key].clone())
            .map_err(|error| format!("3D mesh worker returned invalid {key} metadata: {error}"))
    };
    let output = evidence("output")?;
    let preview = evidence("preview")?;
    let expected_views: Vec<&String> = request.views.keys().collect();
    if provenance["schemaVersion"] != WORKER_SCHEMA_VERSION
        || provenance["modelDigest"] != model.digest
        || provenance["modelRevision"] != model.revision
        || provenance["modelArchitecture"] != model.architecture
        || provenance["seed"] != request.seed
        || provenance["numInferenceSteps"] != request.num_inference_steps
        || provenance["guidanceScale"] != request.guidance_scale
        || provenance["octreeResolution"] != request.octree_resolution
        || provenance["numChunks"] != request.num_chunks
        || provenance["removeFloaters"] != request.remove_floaters
        || provenance["maxFaceCount"] != serde_json::json!(request.max_face_count)
        || provenance["voxelize"] != request.voxelize
        || provenance["voxelResolution"] != request.voxel_resolution
        || provenance["voxelFill"] != request.voxel_fill
        || provenance["views"].as_array().map(Vec::len) != Some(expected_views.len())
        || output.file_name != "object.glb"
        || preview.file_name != "preview.png"
        || provenance["preview"]["width"] != PREVIEW_EDGE
        || provenance["preview"]["height"] != PREVIEW_EDGE
    {
        return Err("3D mesh worker returned mismatched generation evidence.".into());
    }
    let glb = read_staged_output(&staging.0, &output, MAX_MESH_BYTES)?;
    validate_mesh_glb(&glb)?;
    let preview_bytes = read_staged_output(&staging.0, &preview, MAX_PREVIEW_BYTES)?;
    let decoded = image::load_from_memory_with_format(&preview_bytes, image::ImageFormat::Png)
        .map_err(|error| format!("The 3D mesh preview is not a valid PNG: {error}"))?;
    if decoded.width() != PREVIEW_EDGE || decoded.height() != PREVIEW_EDGE {
        return Err("The 3D mesh preview has unexpected dimensions.".into());
    }
    provenance["removeBackground"] = serde_json::json!(request.remove_background);
    provenance["backgroundRemoval"] = background_removal;
    let relative = transform::cas_relative_path(&output.digest);
    transform::publish_cas_bytes(paths, &relative, &output.digest, &glb)?;
    let preview_relative = transform::cas_relative_path(&preview.digest);
    transform::publish_cas_bytes(paths, &preview_relative, &preview.digest, &preview_bytes)?;
    Ok(GeneratedMesh {
        relative_path: relative.to_string_lossy().into(),
        digest: output.digest,
        byte_size: output.byte_size,
        preview_relative_path: preview_relative.to_string_lossy().into(),
        preview_digest: preview.digest,
        preview_byte_size: preview.byte_size,
        preview_edge: PREVIEW_EDGE,
        provenance,
    })
}
