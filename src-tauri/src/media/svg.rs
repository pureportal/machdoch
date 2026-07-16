use std::{collections::HashSet, fs, path::Path};

use image::{imageops::FilterType, DynamicImage, RgbaImage};
use resvg::{tiny_skia, usvg};
use serde::Serialize;

use super::MediaResult;

pub(crate) const SANITIZER_VERSION: &str = "machdoch-svg-secure-static-v3";
pub(crate) const RENDERER_VERSION: &str = "resvg-0.47-secure-static-v1";
pub(crate) const SCORER_VERSION: &str = "machdoch-svg-multiscale-render-fidelity-v4";
const MAX_SVG_BYTES: usize = 8 * 1024 * 1024;
const MAX_XML_NODES: usize = 20_000;
const MAX_XML_DEPTH: usize = 128;
const MAX_PATH_DATA_BYTES: usize = 2 * 1024 * 1024;
const MAX_PATH_COMMANDS: usize = 200_000;
const MAX_RASTER_EDGE: u32 = 8_192;
const MAX_RASTER_PIXELS: u64 = 32_000_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SvgStructureSummary {
    pub(crate) xml_node_count: usize,
    pub(crate) element_count: usize,
    pub(crate) path_count: usize,
    pub(crate) path_command_count: usize,
    pub(crate) text_count: usize,
    pub(crate) definition_count: usize,
    pub(crate) use_count: usize,
    pub(crate) id_count: usize,
    pub(crate) drawable_element_count: usize,
    pub(crate) group_count: usize,
    pub(crate) duplicate_element_count: usize,
    pub(crate) unused_definition_count: usize,
    pub(crate) empty_group_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SvgQualityScore {
    pub(crate) score: f64,
    pub(crate) structural_quality_score: f64,
    pub(crate) source_fidelity_score: Option<f64>,
    pub(crate) multi_scale_consistency_score: f64,
    pub(crate) painted_pixel_ratio: f64,
    pub(crate) canvas_fill_ratio: f64,
    pub(crate) edge_contact_count: u32,
    pub(crate) complexity_penalty: f64,
    pub(crate) redundancy_penalty: f64,
    pub(crate) geometry_efficiency_score: f64,
    pub(crate) editability_score: f64,
    pub(crate) issues: Vec<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ValidatedSvgDocument {
    pub(crate) bytes: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) structure: SvgStructureSummary,
}

#[derive(Debug)]
pub(crate) struct SvgRasterization {
    pub(crate) png_bytes: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) xml_node_count: usize,
    pub(crate) had_text: bool,
}

#[derive(Debug)]
pub(crate) struct SvgEvaluation {
    pub(crate) png_bytes: Vec<u8>,
    pub(crate) preview_width: u32,
    pub(crate) preview_height: u32,
    pub(crate) score: SvgQualityScore,
}

pub(crate) fn validate_and_canonicalize_svg(bytes: &[u8]) -> MediaResult<ValidatedSvgDocument> {
    if bytes.is_empty() || bytes.len() > MAX_SVG_BYTES {
        return Err(format!(
            "SVG documents must be between 1 byte and {} MB",
            MAX_SVG_BYTES / 1024 / 1024
        ));
    }
    let source =
        std::str::from_utf8(bytes).map_err(|_| "SVG documents must use UTF-8 XML".to_string())?;
    let structure = validate_svg_xml(source)?;
    let tree = parse_svg_tree(source)?;
    let size = tree.size().to_int_size();
    validate_raster_dimensions(size.width(), size.height())?;
    let canonical = format!("{}\n", source.trim()).into_bytes();
    Ok(ValidatedSvgDocument {
        bytes: canonical,
        width: size.width(),
        height: size.height(),
        structure,
    })
}

pub(crate) fn evaluate_svg(
    document: &ValidatedSvgDocument,
    max_edge: u32,
) -> MediaResult<SvgEvaluation> {
    if !(64..=2_048).contains(&max_edge) {
        return Err("SVG evaluation edge must be between 64 and 2048 pixels".to_string());
    }
    let source = std::str::from_utf8(&document.bytes)
        .map_err(|_| "validated SVG bytes were not UTF-8".to_string())?;
    let tree = parse_svg_tree(source)?;
    let pixmap = render_tree_at_edge(&tree, document, max_edge, false)?;
    let mut score = score_pixmap(&pixmap, &document.structure);
    let png_bytes = pixmap
        .encode_png()
        .map_err(|error| format!("failed to encode secure SVG preview: {error}"))?;
    let mut scale_scores = Vec::new();
    for verification_edge in [64_u32, 256] {
        if verification_edge >= pixmap.width().max(pixmap.height()) {
            continue;
        }
        let verification = render_tree_at_edge(&tree, document, verification_edge, false)?;
        let consistency = score_raster_fidelity(
            &png_bytes,
            &verification
                .encode_png()
                .map_err(|error| format!("failed to encode SVG verification render: {error}"))?,
        )?;
        scale_scores.push(consistency);
    }
    if scale_scores.is_empty() {
        let primary_edge = pixmap.width().max(pixmap.height());
        let verification_edge = primary_edge.saturating_mul(2).clamp(2, 256);
        let verification = render_tree_at_edge(&tree, document, verification_edge, true)?;
        let verification_png = verification
            .encode_png()
            .map_err(|error| format!("failed to encode SVG verification render: {error}"))?;
        scale_scores.push(score_raster_fidelity(&verification_png, &png_bytes)?);
    }
    let multi_scale_consistency_score =
        scale_scores.iter().sum::<f64>() / scale_scores.len() as f64;
    score.multi_scale_consistency_score = multi_scale_consistency_score;
    score.structural_quality_score = (score.structural_quality_score * 0.9
        + multi_scale_consistency_score * 0.1)
        .clamp(0.0, 100.0);
    score.score = score.structural_quality_score;
    if multi_scale_consistency_score < 70.0 {
        score.issues.push(
            "The SVG render is unstable across verification scales and may lose detail at common display sizes."
                .to_string(),
        );
    }
    let width = pixmap.width();
    let height = pixmap.height();
    Ok(SvgEvaluation {
        png_bytes,
        preview_width: width,
        preview_height: height,
        score,
    })
}

fn render_tree_at_edge(
    tree: &usvg::Tree,
    document: &ValidatedSvgDocument,
    max_edge: u32,
    allow_upscale: bool,
) -> MediaResult<tiny_skia::Pixmap> {
    let requested_scale = max_edge as f32 / document.width.max(document.height) as f32;
    let scale = if allow_upscale {
        requested_scale
    } else {
        requested_scale.min(1.0)
    };
    let width = ((document.width as f32 * scale).ceil() as u32).max(1);
    let height = ((document.height as f32 * scale).ceil() as u32).max(1);
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| "SVG preview target could not be allocated".to_string())?;
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    Ok(pixmap)
}

pub(crate) fn apply_raster_fidelity_score(
    score: &mut SvgQualityScore,
    reference_bytes: &[u8],
    rendered_bytes: &[u8],
) -> MediaResult<()> {
    let fidelity = score_raster_fidelity(reference_bytes, rendered_bytes)?;
    score.source_fidelity_score = Some(fidelity);
    score.score = (score.structural_quality_score * 0.35 + fidelity * 0.65).clamp(0.0, 100.0);
    if fidelity < 55.0 {
        score.issues.push(
            "The vector render has low visual agreement with the prepared source image."
                .to_string(),
        );
    }
    Ok(())
}

fn score_raster_fidelity(reference_bytes: &[u8], rendered_bytes: &[u8]) -> MediaResult<f64> {
    let reference = image::load_from_memory(reference_bytes)
        .map_err(|error| format!("failed to decode SVG fidelity reference: {error}"))?;
    let rendered = image::load_from_memory(rendered_bytes)
        .map_err(|error| format!("failed to decode SVG fidelity render: {error}"))?;
    let (width, height) = comparison_dimensions(&rendered);
    let reference = flatten_over_white(reference.resize_exact(width, height, FilterType::Lanczos3));
    let rendered = flatten_over_white(rendered.resize_exact(width, height, FilterType::Lanczos3));
    let reference_luma = luminance_plane(&reference);
    let rendered_luma = luminance_plane(&rendered);

    let structural_similarity = global_ssim(&reference_luma, &rendered_luma);
    let color_similarity = rgb_similarity(&reference, &rendered);
    let edge_similarity = edge_agreement(&reference_luma, &rendered_luma, width, height);
    Ok(
        (structural_similarity * 0.50 + color_similarity * 0.35 + edge_similarity * 0.15)
            .clamp(0.0, 1.0)
            * 100.0,
    )
}

fn comparison_dimensions(image: &DynamicImage) -> (u32, u32) {
    let width = image.width().max(1);
    let height = image.height().max(1);
    let scale = (256.0 / f64::from(width.max(height))).min(1.0);
    (
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    )
}

fn flatten_over_white(image: DynamicImage) -> RgbaImage {
    let mut image = image.to_rgba8();
    for pixel in image.pixels_mut() {
        let alpha = u32::from(pixel[3]);
        for channel in &mut pixel.0[..3] {
            *channel = ((u32::from(*channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        }
        pixel[3] = 255;
    }
    image
}

fn luminance_plane(image: &RgbaImage) -> Vec<f64> {
    image
        .pixels()
        .map(|pixel| {
            0.2126 * f64::from(pixel[0])
                + 0.7152 * f64::from(pixel[1])
                + 0.0722 * f64::from(pixel[2])
        })
        .collect()
}

fn global_ssim(reference: &[f64], rendered: &[f64]) -> f64 {
    let count = reference.len().max(1) as f64;
    let reference_mean = reference.iter().sum::<f64>() / count;
    let rendered_mean = rendered.iter().sum::<f64>() / count;
    let (mut reference_variance, mut rendered_variance, mut covariance) = (0.0, 0.0, 0.0);
    for (&reference, &rendered) in reference.iter().zip(rendered) {
        let reference_delta = reference - reference_mean;
        let rendered_delta = rendered - rendered_mean;
        reference_variance += reference_delta * reference_delta;
        rendered_variance += rendered_delta * rendered_delta;
        covariance += reference_delta * rendered_delta;
    }
    reference_variance /= count;
    rendered_variance /= count;
    covariance /= count;
    let c1 = (0.01_f64 * 255.0).powi(2);
    let c2 = (0.03_f64 * 255.0).powi(2);
    (((2.0 * reference_mean * rendered_mean + c1) * (2.0 * covariance + c2))
        / ((reference_mean.powi(2) + rendered_mean.powi(2) + c1)
            * (reference_variance + rendered_variance + c2)))
        .clamp(0.0, 1.0)
}

fn rgb_similarity(reference: &RgbaImage, rendered: &RgbaImage) -> f64 {
    let squared_error = reference
        .pixels()
        .zip(rendered.pixels())
        .flat_map(|(reference, rendered)| {
            (0..3).map(move |channel| {
                let delta = f64::from(reference[channel]) - f64::from(rendered[channel]);
                delta * delta
            })
        })
        .sum::<f64>();
    let channel_count = reference.width() as f64 * reference.height() as f64 * 3.0;
    (1.0 - (squared_error / channel_count.max(1.0)).sqrt() / 255.0).clamp(0.0, 1.0)
}

fn edge_agreement(reference: &[f64], rendered: &[f64], width: u32, height: u32) -> f64 {
    let width = width as usize;
    let height = height as usize;
    if width < 2 || height < 2 {
        return 1.0;
    }
    let mut overlap = 0.0;
    let mut total = 0.0;
    for y in 0..height - 1 {
        for x in 0..width - 1 {
            let index = y * width + x;
            let reference_edge = ((reference[index + 1] - reference[index]).abs()
                + (reference[index + width] - reference[index]).abs())
                / 510.0;
            let rendered_edge = ((rendered[index + 1] - rendered[index]).abs()
                + (rendered[index + width] - rendered[index]).abs())
                / 510.0;
            overlap += 2.0 * reference_edge.min(rendered_edge);
            total += reference_edge + rendered_edge;
        }
    }
    if total <= f64::EPSILON {
        1.0
    } else {
        (overlap / total).clamp(0.0, 1.0)
    }
}

pub(crate) fn rasterize_staged_svg(staged_path: &Path) -> MediaResult<SvgRasterization> {
    let metadata = fs::metadata(staged_path)
        .map_err(|error| format!("failed to inspect staged SVG: {error}"))?;
    if metadata.len() == 0 || metadata.len() > MAX_SVG_BYTES as u64 {
        return Err(format!(
            "SVG imports must be between 1 byte and {} MB",
            MAX_SVG_BYTES / 1024 / 1024
        ));
    }
    let bytes =
        fs::read(staged_path).map_err(|error| format!("failed to read staged SVG: {error}"))?;
    let document = validate_and_canonicalize_svg(&bytes)?;
    let evaluation = evaluate_svg(&document, document.width.max(document.height).min(2_048))?;
    Ok(SvgRasterization {
        png_bytes: evaluation.png_bytes,
        width: evaluation.preview_width,
        height: evaluation.preview_height,
        xml_node_count: document.structure.xml_node_count,
        had_text: document.structure.text_count > 0,
    })
}

fn parse_svg_tree(source: &str) -> MediaResult<usvg::Tree> {
    let mut options = usvg::Options {
        resources_dir: None,
        ..usvg::Options::default()
    };
    options.image_href_resolver.resolve_data = Box::new(|_, _, _| None);
    options.image_href_resolver.resolve_string = Box::new(|_, _| None);
    // The secure-static profile deliberately does not load host fonts. This
    // keeps candidate renders reproducible and prevents filesystem font reads.
    usvg::Tree::from_str(source, &options)
        .map_err(|error| format!("SVG failed secure structural parsing: {error}"))
}

fn validate_svg_xml(source: &str) -> MediaResult<SvgStructureSummary> {
    let lowercase = source.to_ascii_lowercase();
    if lowercase.contains("<!doctype") || lowercase.contains("<!entity") {
        return Err("SVG document types and entity declarations are not allowed".to_string());
    }
    if lowercase.contains("<?") {
        return Err("SVG processing instructions are not allowed".to_string());
    }
    let document = roxmltree::Document::parse(source)
        .map_err(|error| format!("SVG is not valid bounded XML: {error}"))?;
    let root = document.root_element();
    if root.tag_name().name() != "svg"
        || root.tag_name().namespace() != Some("http://www.w3.org/2000/svg")
    {
        return Err("SVG root must use the standard SVG namespace".to_string());
    }

    let mut summary = SvgStructureSummary {
        xml_node_count: 0,
        element_count: 0,
        path_count: 0,
        path_command_count: 0,
        text_count: 0,
        definition_count: 0,
        use_count: 0,
        id_count: 0,
        drawable_element_count: 0,
        group_count: 0,
        duplicate_element_count: 0,
        unused_definition_count: 0,
        empty_group_count: 0,
    };
    let mut ids = HashSet::new();
    let mut definition_ids = HashSet::new();
    let mut drawable_fingerprints = HashSet::new();
    let mut references = Vec::new();
    let mut path_data_bytes = 0_usize;
    for node in document.descendants() {
        summary.xml_node_count = summary.xml_node_count.saturating_add(1);
        if summary.xml_node_count > MAX_XML_NODES {
            return Err(format!("SVG contains more than {MAX_XML_NODES} XML nodes"));
        }
        if node.ancestors().count() > MAX_XML_DEPTH {
            return Err(format!("SVG nesting exceeds {MAX_XML_DEPTH} levels"));
        }
        if !node.is_element() {
            continue;
        }
        summary.element_count = summary.element_count.saturating_add(1);
        let element_name = node.tag_name().name();
        if !matches!(
            element_name,
            "svg"
                | "g"
                | "defs"
                | "title"
                | "desc"
                | "symbol"
                | "use"
                | "path"
                | "rect"
                | "circle"
                | "ellipse"
                | "line"
                | "polyline"
                | "polygon"
                | "text"
                | "tspan"
                | "textPath"
                | "linearGradient"
                | "radialGradient"
                | "stop"
                | "pattern"
                | "clipPath"
                | "mask"
                | "marker"
        ) || matches!(
            element_name,
            "script"
                | "foreignObject"
                | "iframe"
                | "object"
                | "embed"
                | "audio"
                | "video"
                | "image"
                | "a"
                | "style"
                | "animate"
                | "animateMotion"
                | "animateTransform"
                | "set"
        ) {
            return Err(format!(
                "SVG element <{element_name}> is not supported by the secure-static allowlist"
            ));
        }
        match element_name {
            "path" => summary.path_count = summary.path_count.saturating_add(1),
            "text" | "tspan" | "textPath" => {
                summary.text_count = summary.text_count.saturating_add(1)
            }
            "defs" | "symbol" | "linearGradient" | "radialGradient" | "pattern" | "clipPath"
            | "mask" | "filter" => {
                summary.definition_count = summary.definition_count.saturating_add(1)
            }
            "use" => summary.use_count = summary.use_count.saturating_add(1),
            _ => {}
        }
        let is_drawable = matches!(
            element_name,
            "path" | "rect" | "circle" | "ellipse" | "line" | "polyline" | "polygon" | "text"
        );
        if is_drawable {
            summary.drawable_element_count = summary.drawable_element_count.saturating_add(1);
            let mut attributes = node
                .attributes()
                .filter(|attribute| !attribute.name().eq_ignore_ascii_case("id"))
                .map(|attribute| format!("{}={}", attribute.name(), attribute.value().trim()))
                .collect::<Vec<_>>();
            attributes.sort_unstable();
            let fingerprint = format!(
                "{element_name}|{}|{}",
                attributes.join("|"),
                node.text().unwrap_or_default().trim()
            );
            if !drawable_fingerprints.insert(fingerprint) {
                summary.duplicate_element_count = summary.duplicate_element_count.saturating_add(1);
            }
        }
        if element_name == "g" {
            summary.group_count = summary.group_count.saturating_add(1);
            if !node.children().any(|child| child.is_element()) {
                summary.empty_group_count = summary.empty_group_count.saturating_add(1);
            }
        }
        for attribute in node.attributes() {
            let name = attribute.name();
            let value = attribute.value().trim();
            let lowercase_value = value.to_ascii_lowercase();
            if lowercase_value.contains("://")
                || lowercase_value.starts_with("data:")
                || lowercase_value.starts_with("file:")
                || lowercase_value.contains("javascript:")
            {
                return Err(format!(
                    "SVG attribute {name} contains a disallowed external or active resource"
                ));
            }
            if name.eq_ignore_ascii_case("id") {
                if value.is_empty() || !ids.insert(value.to_string()) {
                    return Err("SVG ids must be non-empty and unique".to_string());
                }
                summary.id_count = summary.id_count.saturating_add(1);
            }
            if name.to_ascii_lowercase().starts_with("on") {
                return Err(format!(
                    "SVG event attribute {name} is not allowed by the secure-static policy"
                ));
            }
            if name.eq_ignore_ascii_case("href") || name.ends_with(":href") {
                let target = value.strip_prefix('#').ok_or_else(|| {
                    "SVG links may reference only ids inside the same document".to_string()
                })?;
                references.push(target.to_string());
            }
            if name.eq_ignore_ascii_case("style") {
                validate_css_urls(value)?;
            }
            collect_url_references(value, &mut references)?;
            if element_name == "path" && name == "d" {
                path_data_bytes = path_data_bytes.saturating_add(value.len());
                summary.path_command_count = summary.path_command_count.saturating_add(
                    value
                        .bytes()
                        .filter(|byte| byte.is_ascii_alphabetic())
                        .count(),
                );
            }
        }
        if matches!(
            element_name,
            "symbol"
                | "linearGradient"
                | "radialGradient"
                | "pattern"
                | "clipPath"
                | "mask"
                | "marker"
        ) {
            if let Some(id) = node.attribute("id") {
                definition_ids.insert(id.to_string());
            }
        }
    }
    if path_data_bytes > MAX_PATH_DATA_BYTES {
        return Err(format!(
            "SVG path data exceeds the {} MB secure-static limit",
            MAX_PATH_DATA_BYTES / 1024 / 1024
        ));
    }
    if summary.path_command_count > MAX_PATH_COMMANDS {
        return Err(format!(
            "SVG contains more than {MAX_PATH_COMMANDS} path commands"
        ));
    }
    if summary.use_count > 1_024 || summary.definition_count > 4_096 {
        return Err(
            "SVG reference structure exceeds the secure-static complexity limit".to_string(),
        );
    }
    let referenced_ids = references.iter().cloned().collect::<HashSet<_>>();
    for reference in references {
        if !ids.contains(&reference) {
            return Err(format!(
                "SVG contains a dangling internal reference #{reference}"
            ));
        }
    }
    summary.unused_definition_count = definition_ids.difference(&referenced_ids).count();
    Ok(summary)
}

fn collect_url_references(value: &str, references: &mut Vec<String>) -> MediaResult<()> {
    let lowercase = value.to_ascii_lowercase();
    if lowercase.contains("@import") || lowercase.contains("javascript:") {
        return Err("SVG CSS imports and active URLs are disabled".to_string());
    }
    let mut remainder = value;
    while let Some(start) = remainder.to_ascii_lowercase().find("url(") {
        remainder = &remainder[start + 4..];
        let end = remainder
            .find(')')
            .ok_or_else(|| "SVG CSS contains an unterminated url()".to_string())?;
        let target = remainder[..end].trim().trim_matches(['\'', '"']).trim();
        let id = target
            .strip_prefix('#')
            .ok_or_else(|| "SVG CSS may reference only ids inside the same document".to_string())?;
        references.push(id.to_string());
        remainder = &remainder[end + 1..];
    }
    Ok(())
}

fn validate_css_urls(value: &str) -> MediaResult<()> {
    collect_url_references(value, &mut Vec::new())
}

fn score_pixmap(pixmap: &tiny_skia::Pixmap, structure: &SvgStructureSummary) -> SvgQualityScore {
    let width = pixmap.width() as usize;
    let height = pixmap.height() as usize;
    let mut painted = 0_usize;
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0_usize;
    let mut max_y = 0_usize;
    for (index, pixel) in pixmap.data().chunks_exact(4).enumerate() {
        if pixel[3] <= 8 {
            continue;
        }
        painted += 1;
        let x = index % width;
        let y = index / width;
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }
    let total = (width * height).max(1);
    let painted_ratio = painted as f64 / total as f64;
    let canvas_fill_ratio = if painted == 0 {
        0.0
    } else {
        ((max_x - min_x + 1) * (max_y - min_y + 1)) as f64 / total as f64
    };
    let edge_contact_count = if painted == 0 {
        0
    } else {
        u32::from(min_x == 0)
            + u32::from(min_y == 0)
            + u32::from(max_x + 1 == width)
            + u32::from(max_y + 1 == height)
    };
    let complexity_penalty = ((structure.element_count.saturating_sub(1_200) as f64 / 80.0)
        + (structure.path_command_count.saturating_sub(20_000) as f64 / 2_000.0))
        .min(25.0);
    let redundancy_penalty = (structure.duplicate_element_count as f64 * 1.5
        + structure.unused_definition_count as f64 * 0.75
        + structure.empty_group_count as f64 * 0.75)
        .min(20.0);
    let average_path_commands =
        structure.path_command_count as f64 / structure.path_count.max(1) as f64;
    let path_density_penalty = ((average_path_commands - 96.0).max(0.0) / 8.0).min(24.0);
    let geometry_efficiency_score =
        (100.0 - path_density_penalty - redundancy_penalty * 1.5).clamp(0.0, 100.0);
    let semantic_group_bonus = if structure.group_count > 0 { 4.0 } else { 0.0 };
    let editability_score = (100.0 - complexity_penalty * 2.0 - redundancy_penalty
        + semantic_group_bonus)
        .clamp(0.0, 100.0);
    let mut issues = Vec::new();
    if painted_ratio < 0.002 {
        issues.push("The render is blank or nearly blank.".to_string());
    }
    if edge_contact_count >= 3 {
        issues.push("Artwork touches at least three canvas edges and may be clipped.".to_string());
    }
    if canvas_fill_ratio < 0.08 && painted > 0 {
        issues.push("Artwork occupies less than eight percent of the canvas.".to_string());
    }
    if structure.element_count > 5_000 {
        issues.push("The SVG has high structural complexity.".to_string());
    }
    if structure.duplicate_element_count > 4 {
        issues.push(format!(
            "The SVG repeats {} identical drawable elements; reusable definitions may be more editable.",
            structure.duplicate_element_count
        ));
    }
    if structure.unused_definition_count > 0 {
        issues.push(format!(
            "The SVG contains {} unused definitions.",
            structure.unused_definition_count
        ));
    }
    if average_path_commands > 160.0 {
        issues
            .push("Path geometry is unusually dense for the number of editable paths.".to_string());
    }
    let coverage_score = if painted_ratio < 0.002 {
        0.0
    } else {
        (canvas_fill_ratio / 0.65).min(1.0) * 35.0
    };
    let clipping_score = (20.0 - edge_contact_count as f64 * 4.0).max(0.0);
    let editability_component = editability_score * 0.25;
    let geometry_component = geometry_efficiency_score * 0.20;
    let structural_quality_score =
        (coverage_score + clipping_score + editability_component + geometry_component)
            .clamp(0.0, 100.0);
    SvgQualityScore {
        score: structural_quality_score,
        structural_quality_score,
        source_fidelity_score: None,
        multi_scale_consistency_score: 100.0,
        painted_pixel_ratio: painted_ratio,
        canvas_fill_ratio,
        edge_contact_count,
        complexity_penalty,
        redundancy_penalty,
        geometry_efficiency_score,
        editability_score,
        issues,
    }
}

fn validate_raster_dimensions(width: u32, height: u32) -> MediaResult<()> {
    if width == 0 || height == 0 {
        return Err("SVG must resolve to non-zero raster dimensions".to_string());
    }
    if width > MAX_RASTER_EDGE || height > MAX_RASTER_EDGE {
        return Err(format!(
            "SVG raster dimensions {width}x{height} exceed the {MAX_RASTER_EDGE}px per-axis limit"
        ));
    }
    let pixels = u64::from(width) * u64::from(height);
    if pixels > MAX_RASTER_PIXELS {
        return Err(format!(
            "SVG raster contains {pixels} pixels; the limit is {MAX_RASTER_PIXELS}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secure_static_svg_is_validated_rendered_and_scored() {
        let source = br##"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><defs><linearGradient id="g"><stop stop-color="#38bdf8"/><stop offset="1" stop-color="#10b981"/></linearGradient></defs><rect width="120" height="80" rx="12" fill="url(#g)"/></svg>"##;
        let document = validate_and_canonicalize_svg(source).unwrap();
        let evaluation = evaluate_svg(&document, 512).unwrap();
        assert_eq!((document.width, document.height), (120, 80));
        assert_eq!(
            &evaluation.png_bytes[..8],
            &[137, 80, 78, 71, 13, 10, 26, 10]
        );
        assert!(evaluation.score.score > 50.0);
        assert!(
            evaluation.score.multi_scale_consistency_score > 90.0,
            "multi-scale score was {}",
            evaluation.score.multi_scale_consistency_score
        );
    }

    #[test]
    fn rejects_active_external_animated_and_dangling_content() {
        for source in [
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="file:///secret.png"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><animate attributeName="x"/></svg>"#,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="url(#missing)"/></svg>"#,
        ] {
            assert!(validate_and_canonicalize_svg(source.as_bytes()).is_err());
        }
    }

    #[test]
    fn rejects_duplicate_ids_and_processing_instructions() {
        let duplicate = br##"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><g id="x"/><g id="x"/></svg>"##;
        let processing = br##"<?xml-stylesheet href="x"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>"##;
        assert!(validate_and_canonicalize_svg(duplicate)
            .unwrap_err()
            .contains("unique"));
        assert!(validate_and_canonicalize_svg(processing)
            .unwrap_err()
            .contains("processing instructions"));
    }

    #[test]
    fn reports_redundant_geometry_and_unused_definitions() {
        let source = br##"<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs><linearGradient id="unused"><stop stop-color="#fff"/></linearGradient></defs><g></g><rect x="10" y="10" width="30" height="30" fill="#38bdf8"/><rect x="10" y="10" width="30" height="30" fill="#38bdf8"/></svg>"##;
        let document = validate_and_canonicalize_svg(source).unwrap();
        let evaluation = evaluate_svg(&document, 512).unwrap();

        assert_eq!(document.structure.duplicate_element_count, 1);
        assert_eq!(document.structure.unused_definition_count, 1);
        assert_eq!(document.structure.empty_group_count, 1);
        assert!(evaluation.score.redundancy_penalty > 0.0);
        assert!(evaluation.score.geometry_efficiency_score < 100.0);
    }

    #[test]
    fn raster_fidelity_rewards_matching_renders_and_rejects_opposites() {
        use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
        use std::io::Cursor;

        fn encode(image: RgbaImage) -> Vec<u8> {
            let mut bytes = Cursor::new(Vec::new());
            DynamicImage::ImageRgba8(image)
                .write_to(&mut bytes, ImageFormat::Png)
                .unwrap();
            bytes.into_inner()
        }

        let source = encode(RgbaImage::from_fn(64, 64, |x, y| {
            if (x / 8 + y / 8) % 2 == 0 {
                Rgba([20, 90, 220, 255])
            } else {
                Rgba([240, 180, 30, 255])
            }
        }));
        let opposite = encode(RgbaImage::from_fn(64, 64, |x, y| {
            if (x / 8 + y / 8) % 2 == 0 {
                Rgba([240, 180, 30, 255])
            } else {
                Rgba([20, 90, 220, 255])
            }
        }));

        assert!(score_raster_fidelity(&source, &source).unwrap() > 99.9);
        assert!(score_raster_fidelity(&source, &opposite).unwrap() < 50.0);
    }
}
