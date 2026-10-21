use super::*;
use crate::media::{image_layout::{ElementKind, LayoutMethod}, image_layout_compositor};
use crate::media::{canonical_json, layout_asset_store};
use image::{DynamicImage, ImageFormat};
use serde_json::json;
use std::{io::Cursor, time::Instant};

pub(super) fn generate(app: &AppHandle, paths: &MediaRuntimePaths, request: &GenerateMediaImagesRequest) -> MediaResult<LocalGeneratedImageBatch> {
    let layout = request.image_layout.as_ref().ok_or("Choose a layout")?;
    layout.validate()?;
    image_layout_compositor::validate_fonts(layout)?;
    if layout.elements.iter().any(|element| element.kind == ElementKind::Object && element.cutout.unwrap_or(true))
        && !crate::media::model_install::library_files_present(paths, subject_cutout::BIREFNET_MODEL_ID)? {
        return Err("Install BiRefNet before generating subject cutouts.".into());
    }
    if !matches!(request.layout_method, Some(LayoutMethod::Composition | LayoutMethod::Reference | LayoutMethod::Masked)) { return Err("Choose a virtual layout method.".into()); }
    if request.base_image_asset_id.is_some() || !request.reference_images.is_empty() || request.edit_mask.is_some() || request.pose_image_asset_id.is_some() || request.control_net.is_some() {
        return Err("Use layer assets for composition. Remove image, pose and mask inputs.".into());
    }
    let script = worker_script(app)?;
    let (runtime, _) = ready_runtime(app, &script)?;
    let model = installed_model(paths, &request.model_id)?;
    let addons = resolve_addons(paths, &model, &request.model_addons)?;
    let addon_evidence = addons.iter().map(WorkerAddon::from).collect::<Vec<_>>();
    if model.architecture == "ideogram-4" { return Err("Choose a supported local layout model.".into()); }
    let native_edit = matches!(model.architecture.as_str(), "flux-2" | "stable-diffusion-1" | "stable-diffusion-2" | "stable-diffusion-xl" | "pony" | "flux-1" | "krea-2");
    if request.layout_method == Some(LayoutMethod::Masked) && !native_edit { return Err("This model has no integrated mask-conditioning adapter. Choose composition or a mask-capable model.".into()); }
    if request.layout_method == Some(LayoutMethod::Reference) && !native_edit && !crate::media::open_models::capabilities(&model.architecture).contains(&"image-to-image") && model.architecture != "qwen-image-2.1" {
        return Err("This model has no image-reference adapter. Choose composition or an image-editing model.".into());
    }
    let started = Instant::now();
    let mut assets = Vec::new();
    let mut outputs = Vec::new();
    let mut evidence = Vec::new();
    for variant in 0..request.output_count {
        let seed = request.seed.ok_or("Resolve a seed before composition")?.checked_add(variant as u64).ok_or("Seed overflow")?;
        let mut layers = HashMap::new();
        let mut inputs = Vec::new();
        let mut sources = Vec::new();
        if layout.elements.iter().any(|element| element.kind == ElementKind::Object && element.asset_id.is_none()) {
            subject_cutout::release_session()?;
        }
        for element in layout.elements.iter().filter(|element| element.kind == ElementKind::Object) {
            if super::super::database::is_cancellation_requested(paths, &request.run_id)? { return Err("Generation canceled".into()); }
            let (bytes, provenance) = if let Some(asset_id) = &element.asset_id {
                let (source, bytes) = transform::read_asset_original(paths, asset_id)?;
                (bytes, json!({"assetId":asset_id,"digest":source.digest}))
            } else {
                if element.description.trim().is_empty() { return Err(format!("Describe {} before generating it.", element.id)); }
                let mut asset_request = request.clone();
                asset_request.image_layout = None;
                asset_request.layout_method = None;
                asset_request.edit_strength = None;
                asset_request.mask_strength = None;
                asset_request.output_count = 1;
                asset_request.output_format = "png".into();
                asset_request.transparent_background = false;
                asset_request.subject_cutout_model_priority = vec![subject_cutout::BIREFNET_MODEL_ID.into()];
                asset_request.prompt = if element.cutout.unwrap_or(true) {
                    format!("An isolated cutout asset showing only the primary subject described below, including its own parts. Show the entire subject with margins on a plain background. Exclude the surrounding scene and other objects mentioned only as location context. Subject description: {}", element.description)
                } else { element.description.clone() };
                asset_request.sampling.width = Some(768);
                asset_request.sampling.height = Some(768);
                let digest = Sha256::digest(format!("{seed}:{}", element.id).as_bytes());
                asset_request.seed = Some(u64::from_le_bytes(digest[..8].try_into().unwrap()) & ((1_u64 << 53) - 1));
                asset_request.output_branches = vec![super::super::MediaImageOutputBranch {
                    id: element.id.clone(), output_node_id: element.id.clone(), format: "png".into(), quality: 95,
                    jpeg_background: "#ffffff".into(), operations: Vec::new(),
                }];
                let key = format!("{:x}", Sha256::digest(canonical_json::canonical_json(&json!({
                    "adapter":"layout-asset-v2","id":element.id,"model":request.model_id,"revision":model.revision,"modelDigest":model.digest,
                    "prompt":asset_request.prompt,"negativePrompt":asset_request.negative_prompt,"seed":asset_request.seed,"sampling":asset_request.sampling,
                    "addons":addon_evidence,"workerVersion":runtime.worker_version,"modelPolicy":asset_request.model_policy,"memoryProfile":asset_request.memory_profile,
                    "cutout":asset_request.transparent_background,"cutoutRevision":subject_cutout::BIREFNET_MODEL_REVISION,
                }))?.as_bytes()));
                if let Some(cached) = layout_asset_store::read(paths, &key)? { cached }
                else {
                    let generated = super::generate(app, paths, &asset_request, None)?;
                    let asset = generated.assets.first().ok_or("The layout asset generator returned no image")?;
                    let bytes = fs::read(paths.blobs.join(&asset.relative_path)).map_err(|error| format!("Could not read layout asset: {error}"))?;
                    if format!("{:x}", Sha256::digest(&bytes)) != asset.digest { return Err("Layout asset digest mismatch".into()); }
                    let retained = layout_asset_store::publish(paths, &request.run_id, &key, &bytes,
                        json!({"cutout":asset.subject_cutout,"generation":generated.provenance}))?;
                    (bytes, retained)
                }
            };
            sources.push((element, transform::decode_image_bytes(&bytes)?.into_rgba8(), provenance));
        }
        if sources.iter().any(|(element, decoded, _)| element.cutout.unwrap_or(true) && decoded.pixels().all(|pixel| pixel[3] == 255)) {
            super::super::model_memory::release_idle()?;
        }
        for (element, mut decoded, provenance) in sources {
            if super::super::database::is_cancellation_requested(paths, &request.run_id)? { return Err("Generation canceled".into()); }
            let mut prepared_asset = None;
            let cutout = if element.cutout.unwrap_or(true) && decoded.pixels().all(|pixel| pixel[3] == 255) {
                let result = subject_cutout::cutout(paths, &DynamicImage::ImageRgba8(decoded), &[subject_cutout::BIREFNET_MODEL_ID.into()])?;
                decoded = result.cutout.into_rgba8();
                let mut png = Cursor::new(Vec::new());
                DynamicImage::ImageRgba8(decoded.clone()).write_to(&mut png, ImageFormat::Png).map_err(|error| error.to_string())?;
                let key = format!("{:x}", Sha256::digest(png.get_ref()));
                prepared_asset = Some(if let Some((_, retained)) = layout_asset_store::read(paths, &key)? { retained }
                    else { layout_asset_store::publish(paths, &request.run_id, &key, png.get_ref(), json!({"source":provenance,"cutout":result.summary}))? });
                Some(result.summary)
            } else { None };
            inputs.push(json!({"id":element.id,"source":provenance,"preparedAsset":prepared_asset,"cutout":cutout}));
            layers.insert(element.id.clone(), decoded);
        }
        let mut composition_layout = layout.clone();
        if request.layout_method == Some(LayoutMethod::Reference) {
            composition_layout.elements.retain(|element| element.kind != ElementKind::Text);
            composition_layout.relations = None;
        }
        let composed = image_layout_compositor::compose(&composition_layout, &layers)?;
        let (image, refinement) = if request.layout_method == Some(LayoutMethod::Composition) { (composed.image, serde_json::Value::Null) }
            else { super::layout_refinement::refine(app, paths, request, layout, composed.image, seed)? };
        let mut png = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image).write_to(&mut png, ImageFormat::Png).map_err(|error| error.to_string())?;
        evidence.push(json!({"seed":seed,"inputs":inputs,"composition":composed.evidence,"refinement":refinement}));
        for branch in &request.output_branches {
            let processed = transform::process_image_output_branch(png.get_ref(), branch)?;
            let digest = format!("{:x}", Sha256::digest(&processed.bytes));
            let relative = transform::cas_relative_path(&digest);
            transform::publish_cas_bytes(paths, &relative, &digest, &processed.bytes)?;
            let index = assets.len() as u32;
            assets.push(GeneratedImageAsset { digest, relative_path: relative.to_string_lossy().into_owned(), byte_size: processed.bytes.len() as u64,
                mime_type: processed.mime_type, width: processed.width, height: processed.height, output_index: index, subject_cutout: None });
            outputs.push(LocalDiffusersOutputProvenance { index, source_index: variant, seed, branch_id: branch.id.clone(), output_node_id: branch.output_node_id.clone(),
                format: branch.format.clone(), quality: branch.quality, jpeg_background: branch.jpeg_background.clone(), post_processing: branch.operations.clone() });
        }
    }
    Ok(LocalGeneratedImageBatch { assets, provenance: LocalDiffusersProvenance {
        image_layout: Some(json!({"layout":layout,"digest":layout.digest()?,"method":request.layout_method,"assetPipeline":"raw-assets-cutout-v2","variants":evidence,"elapsedSeconds":started.elapsed().as_secs_f64()})),
        worker_version: runtime.worker_version.unwrap_or_default(), packages: runtime.packages,
        device: runtime.device.unwrap_or_default(), device_label: runtime.device_label.unwrap_or_default(), device_memory_bytes: runtime.device_memory_bytes,
        model_revision: model.revision, model_digest: model.digest, prompt: request.prompt.clone(), negative_prompt: request.negative_prompt.clone(),
        model_policy: request.model_policy.clone(), aspect_ratio: request.aspect_ratio.clone(), num_inference_steps: request.sampling.num_inference_steps.unwrap_or(expected_image_inference_steps(&model.architecture, &request.model_policy)?),
        addons: Vec::new(), performance: None, require_chroma_background: false, edit_conditioning: None, conditioning_sources: Vec::new(), outputs,
    } })
}
