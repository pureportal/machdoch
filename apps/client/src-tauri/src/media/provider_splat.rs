use super::*;
use crate::media::splat::{
    validate_splat_ply, GenerateMediaSplatRequest, GeneratedSplat, MAX_SPLAT_BYTES,
};

const PREVIEW_EDGE: u32 = 768;
const MAX_PREVIEW_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplatFileEvidence {
    file_name: String,
    digest: String,
    byte_size: u64,
}

pub(crate) fn generate_splat(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &GenerateMediaSplatRequest,
) -> MediaResult<GeneratedSplat> {
    let script = worker_script(app)?;
    let (_, python) = ready_runtime(app, &script)?;
    let model = installed_model(paths, &request.model_id)?;
    if model.architecture != "idol" {
        return Err("Choose an Idol model.".into());
    }
    let source = database::get_asset(paths, &request.source_asset_id)?;
    let extension = match (source.kind.as_str(), source.mime_type.as_str()) {
        ("image", "image/png") => "png",
        ("image", "image/jpeg") => "jpg",
        ("image", "image/webp") => "webp",
        _ => return Err("Choose a PNG, JPEG, or WebP image.".into()),
    };
    let (_, source_bytes) = transform::read_asset_original(paths, &request.source_asset_id)?;
    let input = create_staging_directory(paths)?;
    let source_path = input.0.join(format!("source.{extension}"));
    fs::write(&source_path, &source_bytes)
        .map_err(|error| format!("Could not stage the source image: {error}"))?;
    let staging = create_staging_directory(paths)?;
    let payload = serde_json::json!({
        "schemaVersion": WORKER_SCHEMA_VERSION,
        "model": WorkerModel { id: &model.id, architecture: &model.architecture, package_kind: &model.package_kind,
            path: &model.path, config_path: None, revision: &model.revision, digest: &model.digest },
        "sourceImagePath": source_path, "inputKind": request.input_kind, "seed": request.seed,
        "numInferenceSteps": request.num_inference_steps, "guidanceScale": request.guidance_scale,
        "timeShift": request.time_shift, "gaussianCount": request.gaussian_count,
        "minOpacity": request.min_opacity, "outputDirectory": staging.0,
    });
    subject_cutout::release_session()?;
    let process = run_worker(
        &python,
        &script,
        "generate-splat",
        Some(&serde_json::to_vec(&payload).map_err(|error| error.to_string())?),
        GENERATION_TIMEOUT,
        Some((paths, &request.run_id)),
    )?;
    if !process.status.success() {
        let message = serde_json::from_slice::<WorkerFailure>(&process.stdout)
            .map(|failure| failure.error)
            .unwrap_or_else(|_| "3D generation failed.".into());
        return Err(worker_failure_with_diagnostics(message, &process.stderr));
    }
    let provenance: serde_json::Value = serde_json::from_slice(&process.stdout)
        .map_err(|error| format!("3D worker returned invalid JSON: {error}"))?;
    let evidence = |key: &str| {
        serde_json::from_value::<SplatFileEvidence>(provenance[key].clone())
            .map_err(|error| format!("3D worker returned invalid {key} metadata: {error}"))
    };
    let output = evidence("output")?;
    let preview = evidence("preview")?;
    if provenance["schemaVersion"] != WORKER_SCHEMA_VERSION
        || provenance["modelDigest"] != model.digest
        || provenance["modelRevision"] != model.revision
        || provenance["modelArchitecture"] != model.architecture
        || provenance["inputKind"] != request.input_kind
        || provenance["seed"] != request.seed
        || provenance["numInferenceSteps"] != request.num_inference_steps
        || provenance["guidanceScale"] != request.guidance_scale
        || provenance["timeShift"] != request.time_shift
        || provenance["gaussianCount"] != request.gaussian_count
        || provenance["minOpacity"] != request.min_opacity
        || output.file_name != "object.ply"
        || preview.file_name != "preview.png"
        || provenance["preview"]["width"] != PREVIEW_EDGE
        || provenance["preview"]["height"] != PREVIEW_EDGE
    {
        return Err("3D worker returned mismatched generation evidence.".into());
    }
    let ply = read_staged_output(&staging.0, &output, MAX_SPLAT_BYTES)?;
    let gaussians = validate_splat_ply(&ply)?;
    if provenance["output"]["gaussianCount"] != gaussians
        || gaussians > u64::from(request.gaussian_count)
    {
        return Err("3D worker returned a mismatched Gaussian count.".into());
    }
    let preview_bytes = read_staged_output(&staging.0, &preview, MAX_PREVIEW_BYTES)?;
    let decoded = image::load_from_memory_with_format(&preview_bytes, image::ImageFormat::Png)
        .map_err(|error| format!("The 3D preview is not a valid PNG: {error}"))?;
    if decoded.width() != PREVIEW_EDGE || decoded.height() != PREVIEW_EDGE {
        return Err("The 3D preview has unexpected dimensions.".into());
    }
    let relative = transform::cas_relative_path(&output.digest);
    transform::publish_cas_bytes(paths, &relative, &output.digest, &ply)?;
    let preview_relative = transform::cas_relative_path(&preview.digest);
    transform::publish_cas_bytes(paths, &preview_relative, &preview.digest, &preview_bytes)?;
    Ok(GeneratedSplat {
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

fn read_staged_output(
    directory: &Path,
    evidence: &SplatFileEvidence,
    limit: u64,
) -> MediaResult<Vec<u8>> {
    let path = directory.join(&evidence.file_name);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Could not inspect {}: {error}", evidence.file_name))?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() != evidence.byte_size
        || metadata.len() > limit
    {
        return Err(format!("{} is not a bounded regular file.", evidence.file_name));
    }
    let bytes = fs::read(&path)
        .map_err(|error| format!("Could not read {}: {error}", evidence.file_name))?;
    if bytes.len() as u64 != evidence.byte_size
        || format!("{:x}", Sha256::digest(&bytes)) != evidence.digest
    {
        return Err(format!("{} failed integrity checks.", evidence.file_name));
    }
    Ok(bytes)
}
