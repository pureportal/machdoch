use super::*;
use crate::media::{image_layout::{ElementKind, LayoutMethod, MediaImageLayout}, image_layout_compositor, layout_asset_store};
use image::{DynamicImage, GrayImage, ImageFormat, RgbaImage};
use serde_json::{json, Value};
use std::io::Cursor;

fn retain(paths: &MediaRuntimePaths, run: &str, image: RgbaImage, role: &str) -> MediaResult<String> {
    let mut output = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image).write_to(&mut output, ImageFormat::Png).map_err(|error| error.to_string())?;
    let key = format!("{:x}", Sha256::digest(output.get_ref()));
    let entry = if let Some((_, evidence)) = layout_asset_store::read(paths, &key)? { evidence }
        else { layout_asset_store::publish(paths, run, &key, output.get_ref(), json!({"role":role}))? };
    entry["assetId"].as_str().map(str::to_owned).ok_or_else(|| "Layout conditioning asset is missing".into())
}

pub(super) fn refine(app: &AppHandle, paths: &MediaRuntimePaths, request: &GenerateMediaImagesRequest, layout: &MediaImageLayout,
    source: RgbaImage, seed: u64) -> MediaResult<(RgbaImage, Value)> {
    let masked = request.layout_method == Some(LayoutMethod::Masked);
    let mut order = layout.elements.iter().collect::<Vec<_>>();
    order.sort_by_key(|element| element.z_index);
    let targets = order.iter().enumerate().filter(|(_, element)| element.kind == ElementKind::Object).collect::<Vec<_>>();
    if masked && targets.len() > 16 { return Err("Masked layouts support at most 16 object repairs. Use composition for larger layouts.".into()); }
    subject_cutout::release_session()?;
    let mut result = source;
    let mut steps = Vec::new();
    for pass in 0..if masked { targets.len() } else { 1 } {
        if crate::media::database::is_cancellation_requested(paths, &request.run_id)? { return Err("Generation canceled".into()); }
        let base = retain(paths, &request.run_id, result.clone(), "composition-reference")?;
        let mut hard_mask = GrayImage::new(layout.canvas.width, layout.canvas.height);
        let prompt = if masked {
            let (index, element) = targets[pass];
            let [left, top, right, bottom] = element.bounds;
            for y in top..bottom { for x in left..right { hard_mask.put_pixel(x,y,image::Luma([255])); } }
            for front in order.iter().skip(index + 1) {
                let [left, top, right, bottom] = front.bounds;
                for y in top..bottom { for x in left..right { hard_mask.put_pixel(x,y,image::Luma([0])); } }
            }
            if !hard_mask.pixels().any(|pixel| pixel[0] == 255) { continue; }
            format!("Integrate this subject naturally in its existing position: {}. {}", element.description, layout.caption)
        } else { format!("{}. Keep the subject placement. Render imagery without lettering or labels.", layout.caption) };
        let mask_id = if masked { Some(retain(paths, &request.run_id, DynamicImage::ImageLuma8(hard_mask.clone()).into_rgba8(), "layout-hard-mask")?) } else { None };
        let mut edit = request.clone();
        edit.image_layout = None; edit.layout_method = None; edit.prompt = prompt;
        edit.base_image_asset_id = Some(base.clone()); edit.reference_images.clear(); edit.edit_mask = None;
        edit.output_count = 1; edit.output_format = "png".into(); edit.transparent_background = false;
        edit.sampling.width = Some(layout.canvas.width); edit.sampling.height = Some(layout.canvas.height);
        edit.seed = Some(seed.checked_add(pass as u64).ok_or("Seed overflow")?); edit.mask_strength = masked.then_some(1.0);
        edit.edit_strength = Some(request.edit_strength.unwrap_or(0.35));
        edit.output_branches = vec![crate::media::MediaImageOutputBranch { id:"layout-refinement".into(),output_node_id:"layout-refinement".into(),format:"png".into(),quality:95,jpeg_background:"#ffffff".into(),operations:Vec::new() }];
        let generated = super::generate(app, paths, &edit, mask_id.as_deref())?;
        let asset = generated.assets.first().ok_or("Layout refinement returned no image")?;
        let bytes = fs::read(paths.blobs.join(&asset.relative_path)).map_err(|error| error.to_string())?;
        if format!("{:x}",Sha256::digest(&bytes)) != asset.digest { return Err("Layout refinement digest mismatch".into()); }
        let decoded = transform::decode_image_bytes(&bytes)?.into_rgba8();
        result = if masked { image_layout_compositor::restore_outside_mask(&result, &decoded, &hard_mask)? } else {
            if decoded.dimensions() != result.dimensions() { return Err("Layout guidance changed the canvas dimensions".into()); } decoded
        };
        let output = retain(paths, &request.run_id, result.clone(), "layout-refinement-output")?;
        steps.push(json!({"pass":pass,"baseAssetId":base,"maskAssetId":mask_id,"outputAssetId":output,"generation":generated.provenance,"outsideMaskChangedPixels":if masked {Some(0)} else {None}}));
    }
    let guidance = if !masked {
        if targets.iter().any(|(_, element)| element.cutout.unwrap_or(true)) {
            super::super::model_memory::release_idle()?;
        }
        let mut guided_layers = HashMap::new();
        let mut inputs = Vec::new();
        for (_, element) in &targets {
            if crate::media::database::is_cancellation_requested(paths, &request.run_id)? { return Err("Generation canceled".into()); }
            let [left, top, right, bottom] = element.bounds;
            let mut region = image::imageops::crop_imm(&result, left, top, right - left, bottom - top).to_image();
            let cutout = if element.cutout.unwrap_or(true) {
                let cutout = subject_cutout::cutout(paths, &DynamicImage::ImageRgba8(region), &[subject_cutout::BIREFNET_MODEL_ID.into()])?;
                region = cutout.cutout.into_rgba8();
                Some(cutout.summary)
            } else { None };
            let asset = retain(paths, &request.run_id, region.clone(), "layout-guided-object")?;
            inputs.push(json!({"id":element.id,"assetId":asset,"box":element.bounds,"cutout":cutout}));
            guided_layers.insert(element.id.clone(), region);
        }
        let composed = image_layout_compositor::compose(layout, &guided_layers)?;
        result = composed.image;
        Some(json!({"adapter":"composition-reference-regions-v1","inputs":inputs,"composition":composed.evidence}))
    } else { None };
    Ok((result, json!({"maximumAttemptsPerObject":1,"steps":steps,"guidance":guidance})))
}
