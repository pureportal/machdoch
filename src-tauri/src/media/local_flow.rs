use std::collections::{HashMap, HashSet};

use image::{imageops, DynamicImage, Rgba, RgbaImage};
use serde_json::json;
use sha2::{Digest as _, Sha256};

use super::{
    database,
    flow::{LocalImageFlowOperation, LocalImageFlowPlan},
    subject_cutout, transform, ExecuteLocalImageFlowRequest, MediaImageTransformOperation,
    MediaImageTransformRequest, MediaResult, MediaRunDetail, MediaRuntimePaths,
};

const MAX_ENCODED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_COMPOSITE_PIXELS: u64 = 100_000_000;

#[derive(Clone)]
struct OutputSettings {
    format: String,
    quality: Option<u8>,
    jpeg_background: Option<String>,
}

#[derive(Clone)]
struct ImageValue {
    image: DynamicImage,
    icc_profile: Option<Vec<u8>>,
    source_asset_ids: Vec<String>,
    output: Option<OutputSettings>,
    metadata_stripped: bool,
    subject_cutout: Option<SubjectCutout>,
    alpha_extraction: Option<AlphaExtraction>,
    auto_tag_profile: Option<String>,
    composite: Option<CompositeSummary>,
    contact_sheet: Option<ContactSheetSummary>,
}

type NodeInput = (String, ImageValue);

#[derive(Clone)]
struct SubjectCutout {
    image: DynamicImage,
    publish: bool,
    summary: subject_cutout::SubjectCutoutSummary,
}

#[derive(Clone)]
struct AlphaExtraction {
    inverted: bool,
    transparent_pixels: u64,
    soft_pixels: u64,
    opaque_pixels: u64,
}

#[derive(Clone)]
struct CompositeSummary {
    fit: String,
    opacity_percent: u8,
    foreground_source_asset_ids: Vec<String>,
    background_source_asset_ids: Vec<String>,
}

#[derive(Clone)]
struct ContactSheetSummary {
    columns: u32,
    cell_width: u32,
    cell_height: u32,
    gap: u32,
    background: String,
    label_mode: String,
    source_asset_ids: Vec<String>,
}

pub(crate) fn execute(
    paths: &MediaRuntimePaths,
    request: &ExecuteLocalImageFlowRequest,
    plan: &LocalImageFlowPlan,
) -> MediaResult<MediaRunDetail> {
    if plan.flow_id != request.flow_id || plan.revision_id != request.flow_revision_id {
        return Err("local image execution plan does not match the requested revision".to_string());
    }
    if !database::begin_local_image_flow(paths, request, &plan.flow_name)? {
        return database::get_run_detail(paths, &request.run_id);
    }
    let result = execute_started(paths, request, plan);
    if let Err(error) = result.as_ref() {
        database::fail_run(paths, &request.run_id, error)?;
    }
    result
}

fn execute_started(
    paths: &MediaRuntimePaths,
    request: &ExecuteLocalImageFlowRequest,
    plan: &LocalImageFlowPlan,
) -> MediaResult<MediaRunDetail> {
    let mut values = HashMap::<String, ImageValue>::new();
    let mut trace = Vec::new();

    for (node_index, node) in plan.nodes.iter().enumerate() {
        let progress = node_index as f64 / plan.nodes.len().max(1) as f64;
        database::transition_node_execution(
            paths,
            &request.run_id,
            &node.id,
            "running",
            Some("local.execute"),
            Some(&format!("Running {}", node.id)),
            Some(progress),
        )?;
        let inputs = node
            .inputs
            .iter()
            .map(|input| {
                values
                    .get(&input.node_id)
                    .cloned()
                    .map(|value| (input.port_id.clone(), value))
                    .ok_or_else(|| {
                        format!(
                            "local image flow node {} is missing completed input {}",
                            node.id, input.node_id
                        )
                    })
            })
            .collect::<MediaResult<Vec<_>>>()?;
        let value = match &node.operation {
            LocalImageFlowOperation::Source { asset_id } => {
                if !inputs.is_empty() {
                    return Err(format!(
                        "source node {} cannot consume image inputs",
                        node.id
                    ));
                }
                let source_asset = database::get_asset(paths, asset_id)?;
                let (_, decoded) = transform::read_asset_image_with_profile(paths, asset_id)?;
                let source_alpha_inverted = source_asset
                    .operation
                    .as_ref()
                    .filter(|operation| operation["assetRole"] == "alpha-matte")
                    .map(|operation| {
                        operation["alphaExtraction"]["inverted"]
                            .as_bool()
                            .unwrap_or(false)
                    });
                let alpha_extraction = source_alpha_inverted
                    .map(|inverted| summarize_alpha_matte(&decoded.image, inverted));
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "source-image",
                    "assetId": asset_id,
                }));
                ImageValue {
                    image: decoded.image,
                    icc_profile: decoded.icc_profile,
                    source_asset_ids: vec![asset_id.clone()],
                    output: None,
                    metadata_stripped: false,
                    subject_cutout: None,
                    alpha_extraction,
                    auto_tag_profile: None,
                    composite: None,
                    contact_sheet: None,
                }
            }
            LocalImageFlowOperation::Crop {
                x,
                y,
                width,
                height,
            } => {
                let mut input = require_single_input(&node.id, inputs, "image")?;
                input.image = transform::apply_operation(
                    input.image,
                    &MediaImageTransformOperation::Crop {
                        x: *x,
                        y: *y,
                        width: *width,
                        height: *height,
                    },
                )?;
                if let Some(mut matte) = input.subject_cutout.take() {
                    matte.image = transform::apply_operation(
                        matte.image,
                        &MediaImageTransformOperation::Crop {
                            x: *x,
                            y: *y,
                            width: *width,
                            height: *height,
                        },
                    )?;
                    input.subject_cutout = Some(matte);
                }
                if let Some(extraction) = input.alpha_extraction.as_ref() {
                    input.alpha_extraction =
                        Some(summarize_alpha_matte(&input.image, extraction.inverted));
                }
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "crop",
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height,
                }));
                input
            }
            LocalImageFlowOperation::Resize { width, height, fit } => {
                let mut input = require_single_input(&node.id, inputs, "image")?;
                input.image = transform::apply_operation(
                    input.image,
                    &MediaImageTransformOperation::Resize {
                        width: *width,
                        height: *height,
                        fit: fit.clone(),
                    },
                )?;
                if let Some(mut matte) = input.subject_cutout.take() {
                    matte.image = transform::apply_operation(
                        matte.image,
                        &MediaImageTransformOperation::Resize {
                            width: *width,
                            height: *height,
                            fit: fit.clone(),
                        },
                    )?;
                    input.subject_cutout = Some(matte);
                }
                if let Some(extraction) = input.alpha_extraction.as_ref() {
                    input.alpha_extraction =
                        Some(summarize_alpha_matte(&input.image, extraction.inverted));
                }
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "resize",
                    "width": width,
                    "height": height,
                    "fit": fit,
                }));
                input
            }
            LocalImageFlowOperation::Convert {
                output_format,
                quality,
                jpeg_background,
            } => {
                let mut input = require_single_input(&node.id, inputs, "image")?;
                validate_output_settings(
                    output_format,
                    Some(*quality),
                    jpeg_background.as_deref(),
                )?;
                input.output = Some(OutputSettings {
                    format: output_format.clone(),
                    quality: (output_format == "jpeg").then_some(*quality),
                    jpeg_background: (output_format == "jpeg")
                        .then(|| jpeg_background.clone())
                        .flatten(),
                });
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "format-convert",
                    "outputFormat": output_format,
                    "quality": quality,
                    "jpegBackground": jpeg_background,
                }));
                input
            }
            LocalImageFlowOperation::MetadataStrip {
                preserve_color_profile,
                apply_orientation,
            } => {
                if !*apply_orientation {
                    return Err(
                        "Metadata Strip requires Apply orientation because source decoding normalizes EXIF orientation before graph execution"
                            .to_string(),
                    );
                }
                let mut input = require_single_input(&node.id, inputs, "image")?;
                if !*preserve_color_profile {
                    input.icc_profile = None;
                }
                input.metadata_stripped = true;
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "metadata-strip",
                    "preserveColorProfile": preserve_color_profile,
                    "applyOrientation": true,
                }));
                input
            }
            LocalImageFlowOperation::AutoTag { profile } => {
                let mut input = require_single_input(&node.id, inputs, "image")?;
                input.auto_tag_profile = Some(profile.clone());
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "auto-tag",
                    "profile": profile,
                    "semanticInference": false,
                }));
                input
            }
            LocalImageFlowOperation::SubjectCutout {
                model_priority,
                output_matte,
            } => {
                let mut input = require_single_input(&node.id, inputs, "image")?;
                let result = subject_cutout::cutout(paths, &input.image, model_priority)?;
                input.image = result.cutout;
                input.alpha_extraction = None;
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "cutout-subject",
                    "engine": result.summary.engine,
                    "modelId": result.summary.model_id,
                    "modelRevision": result.summary.model_revision,
                    "attemptedModelIds": &result.summary.attempted_model_ids,
                    "fallbackUsed": result.summary.fallback_used,
                    "outputMatte": output_matte,
                    "transparentPixels": result.summary.transparent_pixels,
                    "softPixels": result.summary.soft_pixels,
                    "opaquePixels": result.summary.opaque_pixels,
                }));
                input.subject_cutout = Some(SubjectCutout {
                    image: result.matte,
                    publish: *output_matte,
                    summary: result.summary,
                });
                input
            }
            LocalImageFlowOperation::AlphaMatte { invert } => {
                let mut input = require_single_input(&node.id, inputs, "image")?;
                let (matte, extraction) = extract_alpha_matte(&input.image, *invert);
                input.image = matte;
                input.icc_profile = None;
                input.metadata_stripped = true;
                input.subject_cutout = None;
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "extract-alpha-matte",
                    "engine": "alpha-channel-v1",
                    "inverted": extraction.inverted,
                    "transparentPixels": extraction.transparent_pixels,
                    "softPixels": extraction.soft_pixels,
                    "opaquePixels": extraction.opaque_pixels,
                }));
                input.alpha_extraction = Some(extraction);
                input
            }
            LocalImageFlowOperation::Composite {
                fit,
                opacity_percent,
            } => {
                let mut inputs = inputs;
                let foreground = take_named_input(&node.id, &mut inputs, "foreground")?;
                let background = take_named_input(&node.id, &mut inputs, "background")?;
                if !inputs.is_empty() {
                    return Err(format!(
                        "composite node {} received an unsupported input port",
                        node.id
                    ));
                }
                let foreground_source_asset_ids = foreground.source_asset_ids.clone();
                let background_source_asset_ids = background.source_asset_ids.clone();
                let source_asset_ids = stable_source_ids(&[foreground.clone(), background.clone()]);
                let image =
                    create_composite(&foreground.image, &background.image, fit, *opacity_percent)?;
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "composite-image",
                    "engine": "center-alpha-over-v1",
                    "fit": fit,
                    "opacityPercent": opacity_percent,
                    "foregroundSourceAssetIds": &foreground_source_asset_ids,
                    "backgroundSourceAssetIds": &background_source_asset_ids,
                    "canvasWidth": image.width(),
                    "canvasHeight": image.height(),
                }));
                ImageValue {
                    image,
                    icc_profile: background.icc_profile,
                    source_asset_ids,
                    output: None,
                    metadata_stripped: foreground.metadata_stripped && background.metadata_stripped,
                    subject_cutout: None,
                    alpha_extraction: None,
                    auto_tag_profile: None,
                    composite: Some(CompositeSummary {
                        fit: fit.clone(),
                        opacity_percent: *opacity_percent,
                        foreground_source_asset_ids,
                        background_source_asset_ids,
                    }),
                    contact_sheet: None,
                }
            }
            LocalImageFlowOperation::ContactSheet {
                columns,
                cell_width,
                cell_height,
                gap,
                background,
                label_mode,
            } => {
                if inputs.is_empty()
                    || inputs.len() > 8
                    || inputs.iter().any(|(port_id, _)| port_id != "image")
                {
                    return Err(format!(
                        "contact sheet node {} requires between one and eight images",
                        node.id
                    ));
                }
                let inputs = inputs
                    .into_iter()
                    .map(|(_, value)| value)
                    .collect::<Vec<_>>();
                let source_asset_ids = stable_source_ids(&inputs);
                let effective_columns = (*columns).min(inputs.len() as u32).max(1);
                let image = create_contact_sheet(
                    &inputs,
                    *columns,
                    *cell_width,
                    *cell_height,
                    *gap,
                    background,
                    label_mode,
                )?;
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "contact-sheet",
                    "columns": columns,
                    "cellWidth": cell_width,
                    "cellHeight": cell_height,
                    "gap": gap,
                    "background": background,
                    "labelMode": label_mode,
                    "inputCount": inputs.len(),
                }));
                let contact_sheet = Some(ContactSheetSummary {
                    columns: effective_columns,
                    cell_width: *cell_width,
                    cell_height: *cell_height,
                    gap: *gap,
                    background: background.clone(),
                    label_mode: label_mode.clone(),
                    source_asset_ids: source_asset_ids.clone(),
                });
                ImageValue {
                    image,
                    icc_profile: None,
                    source_asset_ids,
                    output: None,
                    metadata_stripped: inputs.iter().all(|input| input.metadata_stripped),
                    subject_cutout: None,
                    alpha_extraction: None,
                    auto_tag_profile: inputs
                        .iter()
                        .find_map(|input| input.auto_tag_profile.clone()),
                    composite: None,
                    contact_sheet,
                }
            }
            LocalImageFlowOperation::Output { output_format } => {
                let input = require_single_input(&node.id, inputs, "image")?;
                let output = match input.output.as_ref() {
                    Some(output) if output.format != *output_format => {
                        return Err(format!(
                            "Save asset format {output_format} conflicts with the upstream explicit {} conversion",
                            output.format
                        ))
                    }
                    Some(output) => output.clone(),
                    None => OutputSettings {
                        format: output_format.clone(),
                        quality: (output_format == "jpeg").then_some(90),
                        jpeg_background: None,
                    },
                };
                validate_output_settings(
                    &output.format,
                    output.quality,
                    output.jpeg_background.as_deref(),
                )?;
                trace.push(json!({
                    "nodeId": node.id,
                    "kind": "save-asset",
                    "outputFormat": output.format,
                }));
                return publish_output(paths, request, plan, input, output, trace);
            }
        };
        values.insert(node.id.clone(), value);
        database::transition_node_execution(
            paths,
            &request.run_id,
            &node.id,
            "completed",
            Some("local.execute"),
            Some(&format!("Completed {}", node.id)),
            Some((node_index + 1) as f64 / plan.nodes.len().max(1) as f64),
        )?;
    }

    Err("local image utility flow did not reach its Save asset output".to_string())
}

fn require_single_input(
    node_id: &str,
    inputs: Vec<NodeInput>,
    expected_port: &str,
) -> MediaResult<ImageValue> {
    if inputs.len() != 1
        || inputs
            .first()
            .is_some_and(|(port_id, _)| port_id != expected_port)
    {
        return Err(format!(
            "local image flow node {node_id} requires exactly one {expected_port} input"
        ));
    }
    inputs
        .into_iter()
        .next()
        .map(|(_, value)| value)
        .ok_or_else(|| {
            format!("local image flow node {node_id} is missing its {expected_port} input")
        })
}

fn take_named_input(
    node_id: &str,
    inputs: &mut Vec<NodeInput>,
    expected_port: &str,
) -> MediaResult<ImageValue> {
    let index = inputs
        .iter()
        .position(|(port_id, _)| port_id == expected_port)
        .ok_or_else(|| {
            format!("local image flow node {node_id} is missing its {expected_port} input")
        })?;
    Ok(inputs.remove(index).1)
}

fn validate_output_settings(
    output_format: &str,
    quality: Option<u8>,
    jpeg_background: Option<&str>,
) -> MediaResult<()> {
    let request = MediaImageTransformRequest {
        source_asset_id: "validation-only".to_string(),
        operation: MediaImageTransformOperation::Convert,
        output_format: output_format.to_string(),
        quality,
        jpeg_background: jpeg_background.map(str::to_string),
    };
    transform::validate_output(&request).map(|_| ())
}

fn stable_source_ids(inputs: &[ImageValue]) -> Vec<String> {
    let mut seen = HashSet::new();
    inputs
        .iter()
        .flat_map(|input| input.source_asset_ids.iter().cloned())
        .filter(|asset_id| seen.insert(asset_id.clone()))
        .collect()
}

fn extract_alpha_matte(image: &DynamicImage, inverted: bool) -> (DynamicImage, AlphaExtraction) {
    let rgba = image.to_rgba8();
    let mut matte = RgbaImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = if inverted {
            255 - pixel.0[3]
        } else {
            pixel.0[3]
        };
        matte.put_pixel(x, y, Rgba([alpha, alpha, alpha, 255]));
    }
    let image = DynamicImage::ImageRgba8(matte);
    let summary = summarize_alpha_matte(&image, inverted);
    (image, summary)
}

fn summarize_alpha_matte(image: &DynamicImage, inverted: bool) -> AlphaExtraction {
    let rgba = image.to_rgba8();
    let mut transparent_pixels = 0_u64;
    let mut soft_pixels = 0_u64;
    let mut opaque_pixels = 0_u64;
    for pixel in rgba.pixels() {
        match pixel.0[0] {
            0 => transparent_pixels += 1,
            255 => opaque_pixels += 1,
            _ => soft_pixels += 1,
        }
    }
    AlphaExtraction {
        inverted,
        transparent_pixels,
        soft_pixels,
        opaque_pixels,
    }
}

fn technical_metadata_tags(
    width: u32,
    height: u32,
    format: &str,
    asset_role: &str,
) -> Vec<(String, String)> {
    let mut tags = vec![("image".to_string(), "Image".to_string())];
    if let Some((value, label)) = match format {
        "png" => Some(("png", "PNG")),
        "jpeg" => Some(("jpeg", "JPEG")),
        "webp" => Some(("webp", "WebP")),
        _ => None,
    } {
        tags.push((value.to_string(), label.to_string()));
    }
    let difference = width.abs_diff(height);
    let (aspect_value, aspect_label) = if difference <= width.max(height) / 100 {
        ("square", "Square")
    } else if width > height {
        ("landscape", "Landscape")
    } else {
        ("portrait", "Portrait")
    };
    tags.push((aspect_value.to_string(), aspect_label.to_string()));
    let (resolution_value, resolution_label) = if width.min(height) < 512 {
        ("low-resolution", "Low resolution")
    } else if width.max(height) >= 1_920 || u64::from(width) * u64::from(height) >= 2_000_000 {
        ("high-resolution", "High resolution")
    } else {
        ("standard-resolution", "Standard resolution")
    };
    tags.push((resolution_value.to_string(), resolution_label.to_string()));
    if asset_role == "cutout" {
        tags.push((
            "transparent-cutout".to_string(),
            "Transparent cutout".to_string(),
        ));
    }
    tags
}

fn create_composite(
    foreground: &DynamicImage,
    background: &DynamicImage,
    fit: &str,
    opacity_percent: u8,
) -> MediaResult<DynamicImage> {
    if opacity_percent > 100 {
        return Err("composite opacity must be between 0 and 100".to_string());
    }
    let canvas_width = background.width();
    let canvas_height = background.height();
    transform::validate_dimensions(canvas_width, canvas_height, "Composite canvas")?;
    let foreground_width = foreground.width();
    let foreground_height = foreground.height();
    if foreground_width == 0 || foreground_height == 0 {
        return Err("composite foreground must have non-zero dimensions".to_string());
    }
    let width_scale = f64::from(canvas_width) / f64::from(foreground_width);
    let height_scale = f64::from(canvas_height) / f64::from(foreground_height);
    let (target_width, target_height) = match fit {
        "stretch" => (canvas_width, canvas_height),
        "contain" | "cover" => {
            let scale = if fit == "contain" {
                width_scale.min(height_scale)
            } else {
                width_scale.max(height_scale)
            };
            let scale_dimension = |dimension: u32| {
                let scaled = f64::from(dimension) * scale;
                if fit == "cover" {
                    scaled.ceil()
                } else {
                    scaled.round()
                }
                .max(1.0) as u32
            };
            (
                scale_dimension(foreground_width),
                scale_dimension(foreground_height),
            )
        }
        _ => return Err(format!("unsupported composite fit {fit}")),
    };
    let target_pixels = u64::from(target_width) * u64::from(target_height);
    if target_pixels > MAX_COMPOSITE_PIXELS {
        return Err(format!(
            "composite intermediate contains {target_pixels} pixels; the limit is {MAX_COMPOSITE_PIXELS}"
        ));
    }
    transform::validate_dimensions(target_width, target_height, "Composite intermediate")?;
    let foreground = foreground.to_rgba8();
    let mut foreground =
        if foreground.width() == target_width && foreground.height() == target_height {
            foreground
        } else {
            imageops::resize(
                &foreground,
                target_width,
                target_height,
                imageops::FilterType::Lanczos3,
            )
        };
    if fit == "cover" && (target_width != canvas_width || target_height != canvas_height) {
        let crop_x = target_width.saturating_sub(canvas_width) / 2;
        let crop_y = target_height.saturating_sub(canvas_height) / 2;
        foreground =
            imageops::crop_imm(&foreground, crop_x, crop_y, canvas_width, canvas_height).to_image();
    }
    if opacity_percent < 100 {
        for pixel in foreground.pixels_mut() {
            pixel.0[3] = ((u16::from(pixel.0[3]) * u16::from(opacity_percent) + 50) / 100) as u8;
        }
    }
    let mut canvas = background.to_rgba8();
    let x = i64::from(canvas_width.saturating_sub(foreground.width()) / 2);
    let y = i64::from(canvas_height.saturating_sub(foreground.height()) / 2);
    imageops::overlay(&mut canvas, &foreground, x, y);
    Ok(DynamicImage::ImageRgba8(canvas))
}

fn create_contact_sheet(
    inputs: &[ImageValue],
    columns: u32,
    cell_width: u32,
    cell_height: u32,
    gap: u32,
    background: &str,
    label_mode: &str,
) -> MediaResult<DynamicImage> {
    let columns = columns.min(inputs.len() as u32).max(1);
    let rows = (inputs.len() as u32).div_ceil(columns);
    let width = columns
        .checked_mul(cell_width)
        .and_then(|value| value.checked_add(gap.saturating_mul(columns.saturating_sub(1))))
        .ok_or_else(|| "contact sheet width overflowed safe bounds".to_string())?;
    let height = rows
        .checked_mul(cell_height)
        .and_then(|value| value.checked_add(gap.saturating_mul(rows.saturating_sub(1))))
        .ok_or_else(|| "contact sheet height overflowed safe bounds".to_string())?;
    transform::validate_dimensions(width, height, "Contact sheet")?;
    let rgb = transform::parse_hex_color(background)?;
    let mut sheet = RgbaImage::from_pixel(width, height, Rgba([rgb[0], rgb[1], rgb[2], 255]));
    for (index, input) in inputs.iter().enumerate() {
        let thumbnail = input.image.thumbnail(cell_width, cell_height).to_rgba8();
        let column = index as u32 % columns;
        let row = index as u32 / columns;
        let cell_x = column * (cell_width + gap);
        let cell_y = row * (cell_height + gap);
        let x = cell_x + (cell_width - thumbnail.width()) / 2;
        let y = cell_y + (cell_height - thumbnail.height()) / 2;
        imageops::overlay(&mut sheet, &thumbnail, i64::from(x), i64::from(y));
        if label_mode == "index" {
            draw_index_label(&mut sheet, cell_x + 8, cell_y + 8, index + 1);
        }
    }
    Ok(DynamicImage::ImageRgba8(sheet))
}

fn draw_index_label(image: &mut RgbaImage, x: u32, y: u32, index: usize) {
    const DIGITS: [[u8; 5]; 10] = [
        [0b111, 0b101, 0b101, 0b101, 0b111],
        [0b010, 0b110, 0b010, 0b010, 0b111],
        [0b111, 0b001, 0b111, 0b100, 0b111],
        [0b111, 0b001, 0b111, 0b001, 0b111],
        [0b101, 0b101, 0b111, 0b001, 0b001],
        [0b111, 0b100, 0b111, 0b001, 0b111],
        [0b111, 0b100, 0b111, 0b101, 0b111],
        [0b111, 0b001, 0b010, 0b010, 0b010],
        [0b111, 0b101, 0b111, 0b101, 0b111],
        [0b111, 0b101, 0b111, 0b001, 0b111],
    ];
    const SCALE: u32 = 3;
    let digits = index.to_string();
    let label_width = digits.len() as u32 * 4 * SCALE + SCALE;
    for py in y.saturating_sub(4)..(y + 5 * SCALE + 4).min(image.height()) {
        for px in x.saturating_sub(4)..(x + label_width + 4).min(image.width()) {
            image.put_pixel(px, py, Rgba([15, 23, 42, 220]));
        }
    }
    for (digit_index, digit) in digits.bytes().enumerate() {
        let pattern = DIGITS[usize::from(digit - b'0')];
        let origin_x = x + digit_index as u32 * 4 * SCALE;
        for (row, bits) in pattern.iter().enumerate() {
            for column in 0..3_u32 {
                if bits & (1 << (2 - column)) == 0 {
                    continue;
                }
                for dy in 0..SCALE {
                    for dx in 0..SCALE {
                        let px = origin_x + column * SCALE + dx;
                        let py = y + row as u32 * SCALE + dy;
                        if px < image.width() && py < image.height() {
                            image.put_pixel(px, py, Rgba([248, 250, 252, 255]));
                        }
                    }
                }
            }
        }
    }
}

fn publish_output(
    paths: &MediaRuntimePaths,
    request: &ExecuteLocalImageFlowRequest,
    plan: &LocalImageFlowPlan,
    input: ImageValue,
    output: OutputSettings,
    trace: Vec<serde_json::Value>,
) -> MediaResult<MediaRunDetail> {
    transform::validate_dimensions(input.image.width(), input.image.height(), "Flow output")?;
    if (input.subject_cutout.is_some() || input.alpha_extraction.is_some())
        && output.format == "jpeg"
    {
        return Err(
            "cutouts and exact alpha mattes must use PNG or WebP; JPEG would flatten transparency or quantize the matte"
                .to_string(),
        );
    }
    let output_request = MediaImageTransformRequest {
        source_asset_id: "flow-output".to_string(),
        operation: MediaImageTransformOperation::Convert,
        output_format: output.format.clone(),
        quality: output.quality,
        jpeg_background: output.jpeg_background,
    };
    let validated_output = transform::validate_output(&output_request)?;
    let bytes = transform::encode_image_with_icc(
        &input.image,
        &validated_output,
        input.icc_profile.as_deref(),
    )?;
    if bytes.len() as u64 > MAX_ENCODED_BYTES {
        return Err(format!(
            "local flow output exceeds the {} MB encoded-byte limit",
            MAX_ENCODED_BYTES / 1024 / 1024
        ));
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let relative_path = transform::cas_relative_path(&digest);
    transform::publish_cas_bytes(paths, &relative_path, &digest, &bytes)?;
    let cutout_summary = input.subject_cutout.as_ref().map(|cutout| {
        json!({
            "engine": cutout.summary.engine,
            "modelId": cutout.summary.model_id,
            "modelRevision": cutout.summary.model_revision,
            "attemptedModelIds": &cutout.summary.attempted_model_ids,
            "fallbackUsed": cutout.summary.fallback_used,
            "transparentPixels": cutout.summary.transparent_pixels,
            "softPixels": cutout.summary.soft_pixels,
            "opaquePixels": cutout.summary.opaque_pixels,
        })
    });
    let alpha_summary = input.alpha_extraction.as_ref().map(|extraction| {
        json!({
            "engine": "alpha-channel-v1",
            "inverted": extraction.inverted,
            "transparentPixels": extraction.transparent_pixels,
            "softPixels": extraction.soft_pixels,
            "opaquePixels": extraction.opaque_pixels,
        })
    });
    let composite_summary = input.composite.as_ref().map(|composite| {
        json!({
            "engine": "center-alpha-over-v1",
            "fit": composite.fit,
            "opacityPercent": composite.opacity_percent,
            "foregroundSourceAssetIds": composite.foreground_source_asset_ids,
            "backgroundSourceAssetIds": composite.background_source_asset_ids,
        })
    });
    let contact_sheet_summary = input.contact_sheet.as_ref().map(|contact_sheet| {
        json!({
            "engine": "grid-contact-sheet-v1",
            "columns": contact_sheet.columns,
            "cellWidth": contact_sheet.cell_width,
            "cellHeight": contact_sheet.cell_height,
            "gap": contact_sheet.gap,
            "background": contact_sheet.background,
            "labelMode": contact_sheet.label_mode,
            "sourceAssetIds": contact_sheet.source_asset_ids,
        })
    });
    let asset_role = if alpha_summary.is_some() {
        "alpha-matte"
    } else if cutout_summary.is_some() {
        "cutout"
    } else {
        "primary"
    };
    let tags = input
        .auto_tag_profile
        .as_deref()
        .map(|_| {
            technical_metadata_tags(
                input.image.width(),
                input.image.height(),
                &output.format,
                asset_role,
            )
        })
        .unwrap_or_default();
    let operation_json = serde_json::to_string(&json!({
        "kind": "local-image-flow",
        "flowRevisionId": plan.revision_id,
        "metadataStripped": input.metadata_stripped,
        "assetRole": asset_role,
        "subjectCutout": cutout_summary,
        "alphaExtraction": alpha_summary,
        "autoTagProfile": input.auto_tag_profile,
        "composite": composite_summary,
        "contactSheet": contact_sheet_summary,
        "nodes": &trace,
    }))
    .map_err(|error| format!("failed to encode local image flow lineage: {error}"))?;
    let mut companions = Vec::new();
    if let Some(matte) = input.subject_cutout.filter(|matte| matte.publish) {
        transform::validate_dimensions(
            matte.image.width(),
            matte.image.height(),
            "Alpha matte output",
        )?;
        let matte_request = MediaImageTransformRequest {
            source_asset_id: "flow-alpha-matte".to_string(),
            operation: MediaImageTransformOperation::Convert,
            output_format: "png".to_string(),
            quality: None,
            jpeg_background: None,
        };
        let matte_output = transform::validate_output(&matte_request)?;
        let matte_bytes = transform::encode_image_with_icc(&matte.image, &matte_output, None)?;
        if matte_bytes.len() as u64 > MAX_ENCODED_BYTES {
            return Err(format!(
                "alpha matte output exceeds the {} MB encoded-byte limit",
                MAX_ENCODED_BYTES / 1024 / 1024
            ));
        }
        let matte_digest = format!("{:x}", Sha256::digest(&matte_bytes));
        let matte_relative_path = transform::cas_relative_path(&matte_digest);
        transform::publish_cas_bytes(paths, &matte_relative_path, &matte_digest, &matte_bytes)?;
        let matte_operation_json = serde_json::to_string(&json!({
            "kind": "local-image-flow",
            "flowRevisionId": plan.revision_id,
            "metadataStripped": true,
            "assetRole": "alpha-matte",
            "subjectCutout": {
                "engine": matte.summary.engine,
                "modelId": matte.summary.model_id,
                "modelRevision": matte.summary.model_revision,
                "attemptedModelIds": &matte.summary.attempted_model_ids,
                "fallbackUsed": matte.summary.fallback_used,
                "transparentPixels": matte.summary.transparent_pixels,
                "softPixels": matte.summary.soft_pixels,
                "opaquePixels": matte.summary.opaque_pixels,
            },
            "nodes": &trace,
        }))
        .map_err(|error| format!("failed to encode alpha matte lineage: {error}"))?;
        companions.push(database::LocalImageFlowCompanionRegistration {
            digest: matte_digest,
            relative_path: matte_relative_path.to_string_lossy().into_owned(),
            bytes: matte_bytes.len() as u64,
            mime_type: matte_output.mime_type.to_string(),
            width: matte.image.width(),
            height: matte.image.height(),
            role: "alpha matte".to_string(),
            operation_json: matte_operation_json,
        });
    }
    database::record_local_image_flow_asset(
        paths,
        database::LocalImageFlowAssetRegistration {
            request,
            digest: &digest,
            relative_path: &relative_path.to_string_lossy(),
            bytes: bytes.len() as u64,
            mime_type: validated_output.mime_type,
            width: input.image.width(),
            height: input.image.height(),
            source_asset_ids: &input.source_asset_ids,
            operation_json: &operation_json,
            role: asset_role,
            tags,
            companions,
        },
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Cursor,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use image::{ImageFormat, RgbaImage};

    use super::*;
    use crate::media::{
        flow::{self, SaveMediaFlowRevisionRequest},
        ingest, MediaRunPlanNodeSnapshot, MediaRunPlanSnapshot, MediaRunPlanStepSnapshot,
    };

    fn test_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "machdoch-local-flow-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn import_fixture(paths: &MediaRuntimePaths, root: &std::path::Path, name: &str) -> String {
        let source = root.join(format!("{name}.png"));
        let image = RgbaImage::from_fn(40, 24, |x, y| {
            Rgba([(x * 4) as u8, (y * 7) as u8, name.as_bytes()[0], 255])
        });
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut bytes, ImageFormat::Png)
            .unwrap();
        fs::write(&source, bytes.into_inner()).unwrap();
        ingest::import_image(paths, source.to_str().unwrap())
            .unwrap()
            .asset
            .id
    }

    fn step(id: &str, node_id: &str, kind: &str) -> MediaRunPlanStepSnapshot {
        MediaRunPlanStepSnapshot {
            id: id.to_string(),
            source_node_id: node_id.to_string(),
            kind: kind.to_string(),
            label: kind.to_string(),
            target: if kind == "resolve-asset" || kind == "ingest-asset" {
                "orchestrator"
            } else {
                "local"
            }
            .to_string(),
            cacheable: kind != "ingest-asset",
            side_effect: (kind == "ingest-asset").then(|| "asset-write".to_string()),
            review: None,
        }
    }

    #[test]
    fn executes_pinned_multi_source_contact_sheet_and_replays_idempotently() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let first_asset_id = import_fixture(&paths, &root, "first");
        let second_asset_id = import_fixture(&paths, &root, "second");
        let request: SaveMediaFlowRevisionRequest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "idempotencyKey": "save-local-contact-sheet",
            "expectedHeadRevisionId": null,
            "changeSummary": "Local flow execution fixture",
            "flow": {
                "schemaVersion": 1,
                "id": "flow:local-contact-sheet",
                "name": "Local contact sheet",
                "description": "",
                "createdAt": "2026-07-14T00:00:00.000Z",
                "updatedAt": "2026-07-14T00:00:00.000Z",
                "variables": [],
                "variableBindings": {},
                "presets": [],
                "activePresetId": null,
                "nodes": [
                    {"id":"one","type":"source.image","version":1,"label":"One","layer":"source","config":{"assetId":first_asset_id}},
                    {"id":"two","type":"source.image","version":1,"label":"Two","layer":"source","config":{"assetId":second_asset_id}},
                    {"id":"sheet","type":"operation.contact-sheet","version":1,"label":"Sheet","layer":"operation","config":{"columns":2,"cellWidth":64,"cellHeight":64,"gap":4,"background":"#0f172a","labelMode":"index"}},
                    {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":1}}
                ],
                "edges": [
                    {"id":"one-sheet","fromNodeId":"one","fromPortId":"image","toNodeId":"sheet","toPortId":"image"},
                    {"id":"two-sheet","fromNodeId":"two","fromPortId":"image","toNodeId":"sheet","toPortId":"image"},
                    {"id":"sheet-output","fromNodeId":"sheet","fromPortId":"image","toNodeId":"output","toPortId":"image"}
                ]
            },
            "layout": {
                "schemaVersion": 1,
                "flowId": "flow:local-contact-sheet",
                "nodes": [
                    {"nodeId":"one","x":0,"y":0},
                    {"nodeId":"two","x":0,"y":120},
                    {"nodeId":"sheet","x":260,"y":60},
                    {"nodeId":"output","x":520,"y":60}
                ],
                "groups": [],
                "comments": []
            }
        }))
        .unwrap();
        let saved = flow::save(&paths, &request).unwrap();
        let saved_json = serde_json::to_value(&saved).unwrap();
        let revision_id = saved_json["revision"]["revisionId"]
            .as_str()
            .unwrap()
            .to_string();
        let flow_fingerprint = saved_json["revision"]["executionDigest"]
            .as_str()
            .unwrap()
            .to_string();
        let snapshot = MediaRunPlanSnapshot {
            schema_version: 1,
            plan_id: "plan:local-contact-sheet".to_string(),
            flow_id: "flow:local-contact-sheet".to_string(),
            flow_fingerprint,
            compiled_at: "2026-07-14T00:00:01.000Z".to_string(),
            nodes: [
                ("one", "source.image", "One", "source"),
                ("two", "source.image", "Two", "source"),
                ("sheet", "operation.contact-sheet", "Sheet", "operation"),
                ("output", "output.asset", "Output", "output"),
            ]
            .into_iter()
            .map(|(id, node_type, label, layer)| MediaRunPlanNodeSnapshot {
                id: id.to_string(),
                r#type: node_type.to_string(),
                label: label.to_string(),
                layer: layer.to_string(),
            })
            .collect(),
            steps: vec![
                step("resolve-asset:one", "one", "resolve-asset"),
                step("resolve-asset:two", "two", "resolve-asset"),
                step(
                    "create-contact-sheet:sheet",
                    "sheet",
                    "create-contact-sheet",
                ),
                step("ingest-asset:output", "output", "ingest-asset"),
            ],
        };
        let execution_request = ExecuteLocalImageFlowRequest {
            schema_version: 1,
            run_id: "run:local-contact-sheet".to_string(),
            flow_id: "flow:local-contact-sheet".to_string(),
            flow_revision_id: revision_id.clone(),
            plan_id: snapshot.plan_id.clone(),
            plan_snapshot: snapshot,
        };
        let plan = flow::compile_local_image_flow(
            &paths,
            &execution_request.flow_id,
            &revision_id,
            &execution_request.plan_snapshot,
        )
        .unwrap();

        let first = execute(&paths, &execution_request, &plan).unwrap();
        let replay = execute(&paths, &execution_request, &plan).unwrap();

        assert_eq!(first.run.id, replay.run.id);
        assert_eq!(first.run.executor, "local-image-flow");
        assert_eq!((first.assets[0].width, first.assets[0].height), (132, 64));
        assert_eq!(
            first.assets[0].source_asset_ids,
            vec![first_asset_id.clone(), second_asset_id.clone()]
        );
        assert_eq!(
            first.assets[0].operation.as_ref().unwrap()["kind"],
            "local-image-flow"
        );
        let operation = first.assets[0].operation.as_ref().unwrap();
        assert_eq!(operation["contactSheet"]["engine"], "grid-contact-sheet-v1");
        assert_eq!(operation["contactSheet"]["columns"], 2);
        assert_eq!(operation["contactSheet"]["cellWidth"], 64);
        assert_eq!(operation["contactSheet"]["cellHeight"], 64);
        assert_eq!(operation["contactSheet"]["gap"], 4);
        assert_eq!(operation["contactSheet"]["labelMode"], "index");
        assert_eq!(
            operation["contactSheet"]["sourceAssetIds"],
            json!([first_asset_id, second_asset_id])
        );
        assert!(first
            .events
            .iter()
            .any(|event| event.kind == "local_flow_executed"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn composite_centers_foreground_and_applies_bounded_opacity() {
        let foreground =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, Rgba([240, 20, 20, 255])));
        let background =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(6, 4, Rgba([10, 20, 220, 255])));

        let full = create_composite(&foreground, &background, "contain", 100)
            .unwrap()
            .to_rgba8();
        assert_eq!(full.get_pixel(0, 0).0, [10, 20, 220, 255]);
        assert_eq!(full.get_pixel(1, 0).0, [240, 20, 20, 255]);
        assert_eq!(full.get_pixel(4, 3).0, [240, 20, 20, 255]);
        assert_eq!(full.get_pixel(5, 3).0, [10, 20, 220, 255]);

        let hidden = create_composite(&foreground, &background, "contain", 0)
            .unwrap()
            .to_rgba8();
        assert_eq!(hidden.get_pixel(2, 2).0, [10, 20, 220, 255]);
    }

    #[test]
    fn executes_named_port_composite_with_ordered_lineage_and_pixel_output() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();

        let foreground_path = root.join("foreground.png");
        let mut foreground_bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(2, 2, Rgba([240, 20, 20, 255])))
            .write_to(&mut foreground_bytes, ImageFormat::Png)
            .unwrap();
        fs::write(&foreground_path, foreground_bytes.into_inner()).unwrap();
        let foreground_asset_id = ingest::import_image(&paths, foreground_path.to_str().unwrap())
            .unwrap()
            .asset
            .id;

        let background_path = root.join("background.png");
        let mut background_bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(6, 4, Rgba([10, 20, 220, 255])))
            .write_to(&mut background_bytes, ImageFormat::Png)
            .unwrap();
        fs::write(&background_path, background_bytes.into_inner()).unwrap();
        let background_asset_id = ingest::import_image(&paths, background_path.to_str().unwrap())
            .unwrap()
            .asset
            .id;

        let save_request: SaveMediaFlowRevisionRequest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "idempotencyKey": "save-local-composite",
            "expectedHeadRevisionId": null,
            "changeSummary": "Local named-port composite fixture",
            "flow": {
                "schemaVersion": 1,
                "id": "flow:local-composite",
                "name": "Local composite",
                "description": "",
                "createdAt": "2026-07-14T00:00:00.000Z",
                "updatedAt": "2026-07-14T00:00:00.000Z",
                "variables": [],
                "variableBindings": {},
                "presets": [],
                "activePresetId": null,
                "nodes": [
                    {"id":"foreground","type":"source.image","version":1,"label":"Foreground","layer":"source","config":{"assetId":foreground_asset_id}},
                    {"id":"background","type":"source.image","version":1,"label":"Background","layer":"source","config":{"assetId":background_asset_id}},
                    {"id":"composite","type":"operation.composite","version":1,"label":"Composite","layer":"operation","config":{"fit":"contain","opacityPercent":50}},
                    {"id":"tag","type":"operation.auto-tag","version":1,"label":"Tag","layer":"operation","config":{"profile":"technical-metadata-v1"}},
                    {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":1}}
                ],
                "edges": [
                    {"id":"foreground-composite","fromNodeId":"foreground","fromPortId":"image","toNodeId":"composite","toPortId":"foreground"},
                    {"id":"background-composite","fromNodeId":"background","fromPortId":"image","toNodeId":"composite","toPortId":"background"},
                    {"id":"composite-tag","fromNodeId":"composite","fromPortId":"image","toNodeId":"tag","toPortId":"image"},
                    {"id":"tag-output","fromNodeId":"tag","fromPortId":"image","toNodeId":"output","toPortId":"image"}
                ]
            },
            "layout": {
                "schemaVersion": 1,
                "flowId": "flow:local-composite",
                "nodes": [
                    {"nodeId":"foreground","x":0,"y":0},
                    {"nodeId":"background","x":0,"y":160},
                    {"nodeId":"composite","x":260,"y":80},
                    {"nodeId":"tag","x":520,"y":80},
                    {"nodeId":"output","x":780,"y":80}
                ],
                "groups": [],
                "comments": []
            }
        }))
        .unwrap();
        let saved = flow::save(&paths, &save_request).unwrap();
        let saved_json = serde_json::to_value(&saved).unwrap();
        let revision_id = saved_json["revision"]["revisionId"]
            .as_str()
            .unwrap()
            .to_string();
        let snapshot = MediaRunPlanSnapshot {
            schema_version: 1,
            plan_id: "plan:local-composite".to_string(),
            flow_id: "flow:local-composite".to_string(),
            flow_fingerprint: saved_json["revision"]["executionDigest"]
                .as_str()
                .unwrap()
                .to_string(),
            compiled_at: "2026-07-14T00:00:01.000Z".to_string(),
            nodes: [
                ("foreground", "source.image", "Foreground", "source"),
                ("background", "source.image", "Background", "source"),
                ("composite", "operation.composite", "Composite", "operation"),
                ("tag", "operation.auto-tag", "Tag", "operation"),
                ("output", "output.asset", "Output", "output"),
            ]
            .into_iter()
            .map(|(id, node_type, label, layer)| MediaRunPlanNodeSnapshot {
                id: id.to_string(),
                r#type: node_type.to_string(),
                label: label.to_string(),
                layer: layer.to_string(),
            })
            .collect(),
            steps: vec![
                step("resolve-asset:foreground", "foreground", "resolve-asset"),
                step("resolve-asset:background", "background", "resolve-asset"),
                step("composite-image:composite", "composite", "composite-image"),
                step("auto-tag:tag", "tag", "auto-tag"),
                step("ingest-asset:output", "output", "ingest-asset"),
            ],
        };
        let execution_request = ExecuteLocalImageFlowRequest {
            schema_version: 1,
            run_id: "run:local-composite".to_string(),
            flow_id: "flow:local-composite".to_string(),
            flow_revision_id: revision_id.clone(),
            plan_id: snapshot.plan_id.clone(),
            plan_snapshot: snapshot,
        };
        let plan = flow::compile_local_image_flow(
            &paths,
            &execution_request.flow_id,
            &revision_id,
            &execution_request.plan_snapshot,
        )
        .unwrap();
        let detail = execute(&paths, &execution_request, &plan).unwrap();

        assert_eq!(detail.assets.len(), 1);
        let asset = &detail.assets[0];
        assert_eq!((asset.width, asset.height), (6, 4));
        assert_eq!(
            asset.source_asset_ids,
            vec![foreground_asset_id.clone(), background_asset_id.clone()]
        );
        let operation = asset.operation.as_ref().unwrap();
        assert_eq!(operation["composite"]["engine"], "center-alpha-over-v1");
        assert_eq!(operation["composite"]["fit"], "contain");
        assert_eq!(operation["composite"]["opacityPercent"], 50);
        assert_eq!(
            operation["composite"]["foregroundSourceAssetIds"][0],
            foreground_asset_id
        );
        assert_eq!(
            operation["composite"]["backgroundSourceAssetIds"][0],
            background_asset_id
        );
        assert!(asset.tags.iter().any(|tag| tag.value == "landscape"));

        let (_, output) = transform::read_asset_image(&paths, &asset.id).unwrap();
        let output = output.to_rgba8();
        assert_eq!(output.get_pixel(0, 0).0, [10, 20, 220, 255]);
        assert!(output.get_pixel(2, 2)[0] > 100);
        assert!(output.get_pixel(2, 2)[2] < 180);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires the reviewed BiRefNet model package"]
    fn local_subject_cutout_flow_publishes_cutout_and_matte_with_lineage() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let source_path = root.join("studio-source.png");
        let source_image = RgbaImage::from_fn(32, 32, |x, y| {
            if (8..24).contains(&x) && (8..24).contains(&y) {
                Rgba([15, 90, 180, 255])
            } else {
                Rgba([250, 250, 250, 255])
            }
        });
        let mut source_bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(source_image)
            .write_to(&mut source_bytes, ImageFormat::Png)
            .unwrap();
        fs::write(&source_path, source_bytes.into_inner()).unwrap();
        let source_asset_id = ingest::import_image(&paths, source_path.to_str().unwrap())
            .unwrap()
            .asset
            .id;
        let save_request: SaveMediaFlowRevisionRequest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "idempotencyKey": "save-local-background-matte",
            "expectedHeadRevisionId": null,
            "changeSummary": "Local background matte fixture",
            "flow": {
                "schemaVersion": 1,
                "id": "flow:local-background-matte",
                "name": "Local background matte",
                "description": "",
                "createdAt": "2026-07-14T00:00:00.000Z",
                "updatedAt": "2026-07-14T00:00:00.000Z",
                "variables": [],
                "variableBindings": {},
                "presets": [],
                "activePresetId": null,
                "nodes": [
                    {"id":"source","type":"source.image","version":1,"label":"Source","layer":"source","config":{"assetId":source_asset_id}},
                    {"id":"matte","type":"operation.subject-cutout","version":1,"label":"Subject cutout","layer":"operation","config":{"outputMatte":true}},
                    {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":1}}
                ],
                "edges": [
                    {"id":"source-matte","fromNodeId":"source","fromPortId":"image","toNodeId":"matte","toPortId":"image"},
                    {"id":"matte-output","fromNodeId":"matte","fromPortId":"image","toNodeId":"output","toPortId":"image"}
                ]
            },
            "layout": {
                "schemaVersion": 1,
                "flowId": "flow:local-background-matte",
                "nodes": [
                    {"nodeId":"source","x":0,"y":0},
                    {"nodeId":"matte","x":260,"y":0},
                    {"nodeId":"output","x":520,"y":0}
                ],
                "groups": [],
                "comments": []
            }
        }))
        .unwrap();
        let saved = flow::save(&paths, &save_request).unwrap();
        let saved_json = serde_json::to_value(&saved).unwrap();
        let revision_id = saved_json["revision"]["revisionId"]
            .as_str()
            .unwrap()
            .to_string();
        let snapshot = MediaRunPlanSnapshot {
            schema_version: 1,
            plan_id: "plan:local-background-matte".to_string(),
            flow_id: "flow:local-background-matte".to_string(),
            flow_fingerprint: saved_json["revision"]["executionDigest"]
                .as_str()
                .unwrap()
                .to_string(),
            compiled_at: "2026-07-14T00:00:01.000Z".to_string(),
            nodes: [
                ("source", "source.image", "Source", "source"),
                (
                    "matte",
                    "operation.subject-cutout",
                    "Subject cutout",
                    "operation",
                ),
                ("output", "output.asset", "Output", "output"),
            ]
            .into_iter()
            .map(|(id, node_type, label, layer)| MediaRunPlanNodeSnapshot {
                id: id.to_string(),
                r#type: node_type.to_string(),
                label: label.to_string(),
                layer: layer.to_string(),
            })
            .collect(),
            steps: vec![
                step("resolve-asset:source", "source", "resolve-asset"),
                step("cutout-subject:matte", "matte", "cutout-subject"),
                step("ingest-asset:output", "output", "ingest-asset"),
            ],
        };
        let execution_request = ExecuteLocalImageFlowRequest {
            schema_version: 1,
            run_id: "run:local-background-matte".to_string(),
            flow_id: "flow:local-background-matte".to_string(),
            flow_revision_id: revision_id.clone(),
            plan_id: snapshot.plan_id.clone(),
            plan_snapshot: snapshot,
        };
        let plan = flow::compile_local_image_flow(
            &paths,
            &execution_request.flow_id,
            &revision_id,
            &execution_request.plan_snapshot,
        )
        .unwrap();
        let detail = execute(&paths, &execution_request, &plan).unwrap();

        assert_eq!(detail.assets.len(), 2);
        assert_eq!(detail.run.output_count, 1);
        assert_eq!(detail.run.diagnostic_count, 1);
        assert_eq!(
            detail.assets[0].source_asset_ids,
            vec![source_asset_id.clone()]
        );
        assert_eq!(detail.assets[1].source_asset_ids, vec![source_asset_id]);
        assert_eq!(
            detail.assets[0].operation.as_ref().unwrap()["assetRole"],
            "cutout"
        );
        assert_eq!(
            detail.assets[1].operation.as_ref().unwrap()["assetRole"],
            "alpha-matte"
        );
        assert!(detail.assets[1]
            .tags
            .iter()
            .any(|tag| tag.value == "alpha-matte" && tag.source == "technical"));
        let (_, cutout) = transform::read_asset_image(&paths, &detail.assets[0].id).unwrap();
        let (_, matte) = transform::read_asset_image(&paths, &detail.assets[1].id).unwrap();
        let cutout = cutout.to_rgba8();
        let matte = matte.to_rgba8();
        assert_eq!(cutout.get_pixel(0, 0)[3], 0);
        assert_eq!(cutout.get_pixel(16, 16)[3], 255);
        assert_eq!(matte.get_pixel(0, 0)[0], 0);
        assert_eq!(matte.get_pixel(16, 16)[0], 255);
        assert!(detail
            .events
            .iter()
            .any(|event| { event.step_id.as_deref() == Some("local-flow.publish-companion") }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_alpha_flow_publishes_exact_tagged_channel_with_lineage() {
        let root = test_root();
        fs::create_dir_all(&root).unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let source_path = root.join("alpha-source.png");
        let source_image = RgbaImage::from_fn(8, 4, |x, _| {
            let alpha = match x {
                0 | 1 => 0,
                2 | 3 => 64,
                4 | 5 => 128,
                _ => 255,
            };
            Rgba([20, 80, 160, alpha])
        });
        let mut source_bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(source_image)
            .write_to(&mut source_bytes, ImageFormat::Png)
            .unwrap();
        fs::write(&source_path, source_bytes.into_inner()).unwrap();
        let source_asset_id = ingest::import_image(&paths, source_path.to_str().unwrap())
            .unwrap()
            .asset
            .id;
        let save_request: SaveMediaFlowRevisionRequest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "idempotencyKey": "save-local-alpha-matte",
            "expectedHeadRevisionId": null,
            "changeSummary": "Local alpha extraction fixture",
            "flow": {
                "schemaVersion": 1,
                "id": "flow:local-alpha-matte",
                "name": "Local alpha matte",
                "description": "",
                "createdAt": "2026-07-14T00:00:00.000Z",
                "updatedAt": "2026-07-14T00:00:00.000Z",
                "variables": [],
                "variableBindings": {},
                "presets": [],
                "activePresetId": null,
                "nodes": [
                    {"id":"source","type":"source.image","version":1,"label":"Source","layer":"source","config":{"assetId":source_asset_id}},
                    {"id":"alpha","type":"operation.alpha-matte","version":1,"label":"Alpha","layer":"operation","config":{"invert":false}},
                    {"id":"tag","type":"operation.auto-tag","version":1,"label":"Tag","layer":"operation","config":{"profile":"technical-metadata-v1"}},
                    {"id":"output","type":"output.asset","version":1,"label":"Output","layer":"output","config":{"format":"png","outputCount":1}}
                ],
                "edges": [
                    {"id":"source-alpha","fromNodeId":"source","fromPortId":"image","toNodeId":"alpha","toPortId":"image"},
                    {"id":"alpha-tag","fromNodeId":"alpha","fromPortId":"image","toNodeId":"tag","toPortId":"image"},
                    {"id":"tag-output","fromNodeId":"tag","fromPortId":"image","toNodeId":"output","toPortId":"image"}
                ]
            },
            "layout": {
                "schemaVersion": 1,
                "flowId": "flow:local-alpha-matte",
                "nodes": [
                    {"nodeId":"source","x":0,"y":0},
                    {"nodeId":"alpha","x":260,"y":0},
                    {"nodeId":"tag","x":520,"y":0},
                    {"nodeId":"output","x":780,"y":0}
                ],
                "groups": [],
                "comments": []
            }
        }))
        .unwrap();
        let saved = flow::save(&paths, &save_request).unwrap();
        let saved_json = serde_json::to_value(&saved).unwrap();
        let revision_id = saved_json["revision"]["revisionId"]
            .as_str()
            .unwrap()
            .to_string();
        let snapshot = MediaRunPlanSnapshot {
            schema_version: 1,
            plan_id: "plan:local-alpha-matte".to_string(),
            flow_id: "flow:local-alpha-matte".to_string(),
            flow_fingerprint: saved_json["revision"]["executionDigest"]
                .as_str()
                .unwrap()
                .to_string(),
            compiled_at: "2026-07-14T00:00:01.000Z".to_string(),
            nodes: [
                ("source", "source.image", "Source", "source"),
                ("alpha", "operation.alpha-matte", "Alpha", "operation"),
                ("tag", "operation.auto-tag", "Tag", "operation"),
                ("output", "output.asset", "Output", "output"),
            ]
            .into_iter()
            .map(|(id, node_type, label, layer)| MediaRunPlanNodeSnapshot {
                id: id.to_string(),
                r#type: node_type.to_string(),
                label: label.to_string(),
                layer: layer.to_string(),
            })
            .collect(),
            steps: vec![
                step("resolve-asset:source", "source", "resolve-asset"),
                step("extract-alpha-matte:alpha", "alpha", "extract-alpha-matte"),
                step("auto-tag:tag", "tag", "auto-tag"),
                step("ingest-asset:output", "output", "ingest-asset"),
            ],
        };
        let execution_request = ExecuteLocalImageFlowRequest {
            schema_version: 1,
            run_id: "run:local-alpha-matte".to_string(),
            flow_id: "flow:local-alpha-matte".to_string(),
            flow_revision_id: revision_id.clone(),
            plan_id: snapshot.plan_id.clone(),
            plan_snapshot: snapshot,
        };
        let plan = flow::compile_local_image_flow(
            &paths,
            &execution_request.flow_id,
            &revision_id,
            &execution_request.plan_snapshot,
        )
        .unwrap();
        let detail = execute(&paths, &execution_request, &plan).unwrap();

        assert_eq!(detail.assets.len(), 1);
        let asset = &detail.assets[0];
        assert_eq!(asset.source_asset_ids, vec![source_asset_id]);
        let operation = asset.operation.as_ref().unwrap();
        assert_eq!(operation["assetRole"], "alpha-matte");
        assert_eq!(operation["alphaExtraction"]["engine"], "alpha-channel-v1");
        assert_eq!(operation["alphaExtraction"]["transparentPixels"], 8);
        assert_eq!(operation["alphaExtraction"]["softPixels"], 16);
        assert_eq!(operation["alphaExtraction"]["opaquePixels"], 8);
        assert_eq!(operation["autoTagProfile"], "technical-metadata-v1");
        assert!(asset
            .tags
            .iter()
            .any(|tag| tag.value == "alpha-matte" && tag.source == "technical"));
        for expected in ["image", "png", "landscape", "low-resolution"] {
            assert!(asset
                .tags
                .iter()
                .any(|tag| tag.value == expected && tag.source == "technical"));
        }
        let (_, matte) = transform::read_asset_image(&paths, &asset.id).unwrap();
        let matte = matte.to_rgba8();
        assert_eq!(matte.get_pixel(0, 0).0, [0, 0, 0, 255]);
        assert_eq!(matte.get_pixel(2, 0).0, [64, 64, 64, 255]);
        assert_eq!(matte.get_pixel(4, 0).0, [128, 128, 128, 255]);
        assert_eq!(matte.get_pixel(7, 0).0, [255, 255, 255, 255]);
        fs::remove_dir_all(root).unwrap();
    }
}
