use std::{
    collections::{HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use image::{imageops, DynamicImage, GrayImage, Luma, Rgba, RgbaImage};
use ort::{
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};

use super::{model_install, transform, MediaImageTransformOperation, MediaImageTransformRequest};
use super::{MediaResult, MediaRuntimePaths};

pub(crate) const BIREFNET_MODEL_ID: &str = "local:birefnet-matting";
pub(crate) const BIREFNET_MODEL_REVISION: &str = "a0cf9925880620000aa2d1948d61bf659ddfdfaa";
pub(crate) const BORDER_MATTE_MODEL_ID: &str = "local:border-matte-v1";
pub(crate) const BORDER_MATTE_MODEL_REVISION: &str = "builtin-2026-07-15.6-cutout-policy";
const MODEL_FILE: &str = "BiRefNet-matting-epoch_100.onnx";
const BIREFNET_ENGINE: &str = "birefnet-matting-onnx-v1";
const BORDER_MATTE_ENGINE: &str = "border-matte-v1";
const INPUT_SIZE: u32 = 1_024;
const MAX_PIXELS: u64 = 100_000_000;
const MAX_ENCODED_BYTES: u64 = 64 * 1_024 * 1_024;

struct CachedSession {
    model_path: PathBuf,
    session: Session,
}

static SESSION: OnceLock<Mutex<Option<CachedSession>>> = OnceLock::new();

pub(crate) fn release_session() -> MediaResult<()> {
    let Some(cache) = SESSION.get() else {
        return Ok(());
    };
    let mut cache = cache
        .lock()
        .map_err(|_| "the BiRefNet inference session is unavailable".to_string())?;
    *cache = None;
    Ok(())
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubjectCutoutSummary {
    pub(crate) engine: &'static str,
    pub(crate) model_id: &'static str,
    pub(crate) model_revision: &'static str,
    pub(crate) attempted_model_ids: Vec<String>,
    pub(crate) fallback_used: bool,
    pub(crate) transparent_pixels: u64,
    pub(crate) soft_pixels: u64,
    pub(crate) opaque_pixels: u64,
}

pub(crate) fn validate_model_priority(model_priority: &mut Vec<String>) -> MediaResult<()> {
    if model_priority.is_empty() || model_priority.len() > 8 {
        return Err("subjectCutoutModelPriority must contain between 1 and 8 models".to_string());
    }
    let mut unique = HashSet::new();
    for model_id in model_priority {
        *model_id = model_id.trim().to_string();
        if !matches!(model_id.as_str(), BIREFNET_MODEL_ID | BORDER_MATTE_MODEL_ID) {
            return Err(format!(
                "subject-cutout model {model_id} is not supported by this runtime"
            ));
        }
        if !unique.insert(model_id.clone()) {
            return Err("subjectCutoutModelPriority must contain unique model ids".to_string());
        }
    }
    Ok(())
}

pub(crate) fn model_label(model_id: &str) -> &str {
    match model_id {
        BIREFNET_MODEL_ID => "BiRefNet Matting",
        BORDER_MATTE_MODEL_ID => "Local Border Matte",
        _ => model_id,
    }
}

pub(crate) fn format_model_priority(model_priority: &[String]) -> String {
    model_priority
        .iter()
        .enumerate()
        .map(|(index, model_id)| format!("{} {}", index + 1, model_label(model_id)))
        .collect::<Vec<_>>()
        .join(" → ")
}

pub(crate) struct SubjectCutoutResult {
    pub(crate) cutout: DynamicImage,
    pub(crate) matte: DynamicImage,
    pub(crate) summary: SubjectCutoutSummary,
}

pub(crate) struct EncodedSubjectCutout {
    pub(crate) bytes: Vec<u8>,
    pub(crate) summary: SubjectCutoutSummary,
}

fn create_session(model_path: &Path) -> MediaResult<Session> {
    Session::builder()
        .map_err(|error| format!("failed to initialize ONNX Runtime: {error}"))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|error| format!("failed to configure ONNX graph optimization: {error}"))?
        .with_intra_threads(
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
                .min(8),
        )
        .map_err(|error| format!("failed to configure ONNX worker threads: {error}"))?
        .commit_from_file(model_path)
        .map_err(|error| format!("failed to load the installed BiRefNet model: {error}"))
}

fn infer_logits(model_path: &Path, input: Vec<f32>) -> MediaResult<Vec<f32>> {
    let cache = SESSION.get_or_init(|| Mutex::new(None));
    let mut cache = cache
        .lock()
        .map_err(|_| "the BiRefNet inference session is unavailable".to_string())?;
    if cache
        .as_ref()
        .is_none_or(|cached| cached.model_path != model_path)
    {
        *cache = Some(CachedSession {
            model_path: model_path.to_path_buf(),
            session: create_session(model_path)?,
        });
    }
    let cached = cache
        .as_mut()
        .ok_or_else(|| "the BiRefNet inference session was not initialized".to_string())?;
    let tensor = Tensor::from_array((
        [1_usize, 3, INPUT_SIZE as usize, INPUT_SIZE as usize],
        input.into_boxed_slice(),
    ))
    .map_err(|error| format!("failed to prepare the BiRefNet input tensor: {error}"))?;
    let outputs = cached
        .session
        .run(ort::inputs![tensor])
        .map_err(|error| format!("BiRefNet inference failed: {error}"))?;
    let output = outputs
        .values()
        .last()
        .ok_or_else(|| "BiRefNet returned no matte output".to_string())?;
    let (_, logits) = output
        .try_extract_tensor::<f32>()
        .map_err(|error| format!("BiRefNet returned an invalid matte tensor: {error}"))?;
    let expected = (INPUT_SIZE * INPUT_SIZE) as usize;
    if logits.len() != expected {
        return Err(format!(
            "BiRefNet returned {} matte values; expected {expected}",
            logits.len()
        ));
    }
    Ok(logits.to_vec())
}

fn normalized_input(source: &DynamicImage) -> Vec<f32> {
    const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
    const STD: [f32; 3] = [0.229, 0.224, 0.225];
    let resized = imageops::resize(
        &source.to_rgb8(),
        INPUT_SIZE,
        INPUT_SIZE,
        imageops::FilterType::Triangle,
    );
    let plane = (INPUT_SIZE * INPUT_SIZE) as usize;
    let mut input = vec![0.0_f32; plane * 3];
    for (index, pixel) in resized.pixels().enumerate() {
        for channel in 0..3 {
            input[channel * plane + index] =
                (f32::from(pixel[channel]) / 255.0 - MEAN[channel]) / STD[channel];
        }
    }
    input
}

fn probability_to_alpha(logit: f32) -> u8 {
    let probability = if logit >= 0.0 {
        1.0 / (1.0 + (-logit).exp())
    } else {
        let exponential = logit.exp();
        exponential / (1.0 + exponential)
    };
    (probability.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn apply_matte(
    source: &DynamicImage,
    matte: &GrayImage,
    engine: &'static str,
    model_id: &'static str,
    model_revision: &'static str,
) -> SubjectCutoutResult {
    let mut cutout = source.to_rgba8();
    let mut matte_image = RgbaImage::new(source.width(), source.height());
    let mut transparent_pixels = 0_u64;
    let mut soft_pixels = 0_u64;
    let mut opaque_pixels = 0_u64;
    for (x, y, pixel) in cutout.enumerate_pixels_mut() {
        let predicted = matte.get_pixel(x, y)[0];
        let alpha = ((u16::from(pixel[3]) * u16::from(predicted) + 127) / 255) as u8;
        pixel[3] = alpha;
        matte_image.put_pixel(x, y, Rgba([alpha, alpha, alpha, 255]));
        match alpha {
            0 => transparent_pixels += 1,
            255 => opaque_pixels += 1,
            _ => soft_pixels += 1,
        }
    }
    SubjectCutoutResult {
        cutout: DynamicImage::ImageRgba8(cutout),
        matte: DynamicImage::ImageRgba8(matte_image),
        summary: SubjectCutoutSummary {
            engine,
            model_id,
            model_revision,
            attempted_model_ids: Vec::new(),
            fallback_used: false,
            transparent_pixels,
            soft_pixels,
            opaque_pixels,
        },
    }
}

fn birefnet_cutout(
    paths: &MediaRuntimePaths,
    source: &DynamicImage,
) -> MediaResult<SubjectCutoutResult> {
    let pixel_count = u64::from(source.width()) * u64::from(source.height());
    if pixel_count == 0 || pixel_count > MAX_PIXELS {
        return Err(format!(
            "BiRefNet subject cutout supports between 1 and {MAX_PIXELS} decoded pixels"
        ));
    }
    let model_path = model_install::installed_builtin_file(paths, BIREFNET_MODEL_ID, MODEL_FILE)
        .map_err(|error| format!("BiRefNet Matting is not ready: {error}"))?;
    let logits = infer_logits(&model_path, normalized_input(source))?;
    let inference_matte = GrayImage::from_fn(INPUT_SIZE, INPUT_SIZE, |x, y| {
        let index = (y * INPUT_SIZE + x) as usize;
        Luma([probability_to_alpha(logits[index])])
    });
    let matte = imageops::resize(
        &inference_matte,
        source.width(),
        source.height(),
        imageops::FilterType::Triangle,
    );
    Ok(apply_matte(
        source,
        &matte,
        BIREFNET_ENGINE,
        BIREFNET_MODEL_ID,
        BIREFNET_MODEL_REVISION,
    ))
}

fn border_color(source: &RgbaImage) -> [u8; 3] {
    let mut channels = [Vec::new(), Vec::new(), Vec::new()];
    let width = source.width();
    let height = source.height();
    for x in 0..width {
        for y in [0, height.saturating_sub(1)] {
            let pixel = source.get_pixel(x, y);
            if pixel[3] > 0 {
                for channel in 0..3 {
                    channels[channel].push(pixel[channel]);
                }
            }
        }
    }
    for y in 1..height.saturating_sub(1) {
        for x in [0, width.saturating_sub(1)] {
            let pixel = source.get_pixel(x, y);
            if pixel[3] > 0 {
                for channel in 0..3 {
                    channels[channel].push(pixel[channel]);
                }
            }
        }
    }
    std::array::from_fn(|channel| {
        channels[channel].sort_unstable();
        let middle = channels[channel].len() / 2;
        channels[channel].get(middle).copied().unwrap_or(0)
    })
}

fn color_distance(pixel: &Rgba<u8>, background: [u8; 3]) -> f32 {
    (0..3)
        .map(|channel| {
            let difference = f32::from(pixel[channel]) - f32::from(background[channel]);
            difference * difference
        })
        .sum::<f32>()
        .sqrt()
}

fn enqueue_border_pixel(
    rgba: &RgbaImage,
    background: [u8; 3],
    maximum_distance: f32,
    connected: &mut [bool],
    queue: &mut VecDeque<(u32, u32)>,
    x: u32,
    y: u32,
) {
    let index = (y * rgba.width() + x) as usize;
    if connected[index] {
        return;
    }
    let pixel = rgba.get_pixel(x, y);
    if pixel[3] == 0 || color_distance(pixel, background) <= maximum_distance {
        connected[index] = true;
        queue.push_back((x, y));
    }
}

fn border_matte(source: &DynamicImage) -> MediaResult<SubjectCutoutResult> {
    const FULLY_TRANSPARENT_DISTANCE: f32 = 10.0;
    const CONNECTED_BACKGROUND_DISTANCE: f32 = 72.0;
    const FULLY_OPAQUE_DISTANCE: f32 = 58.0;

    let pixel_count = u64::from(source.width()) * u64::from(source.height());
    if pixel_count == 0 || pixel_count > MAX_PIXELS {
        return Err(format!(
            "Local Border Matte supports between 1 and {MAX_PIXELS} decoded pixels"
        ));
    }
    let rgba = source.to_rgba8();
    let background = border_color(&rgba);
    let width = rgba.width();
    let height = rgba.height();
    let mut connected = vec![false; (width * height) as usize];
    let mut queue = VecDeque::new();
    for x in 0..width {
        enqueue_border_pixel(
            &rgba,
            background,
            CONNECTED_BACKGROUND_DISTANCE,
            &mut connected,
            &mut queue,
            x,
            0,
        );
        enqueue_border_pixel(
            &rgba,
            background,
            CONNECTED_BACKGROUND_DISTANCE,
            &mut connected,
            &mut queue,
            x,
            height - 1,
        );
    }
    for y in 0..height {
        enqueue_border_pixel(
            &rgba,
            background,
            CONNECTED_BACKGROUND_DISTANCE,
            &mut connected,
            &mut queue,
            0,
            y,
        );
        enqueue_border_pixel(
            &rgba,
            background,
            CONNECTED_BACKGROUND_DISTANCE,
            &mut connected,
            &mut queue,
            width - 1,
            y,
        );
    }
    while let Some((x, y)) = queue.pop_front() {
        if x > 0 {
            enqueue_border_pixel(
                &rgba,
                background,
                CONNECTED_BACKGROUND_DISTANCE,
                &mut connected,
                &mut queue,
                x - 1,
                y,
            );
        }
        if x + 1 < width {
            enqueue_border_pixel(
                &rgba,
                background,
                CONNECTED_BACKGROUND_DISTANCE,
                &mut connected,
                &mut queue,
                x + 1,
                y,
            );
        }
        if y > 0 {
            enqueue_border_pixel(
                &rgba,
                background,
                CONNECTED_BACKGROUND_DISTANCE,
                &mut connected,
                &mut queue,
                x,
                y - 1,
            );
        }
        if y + 1 < height {
            enqueue_border_pixel(
                &rgba,
                background,
                CONNECTED_BACKGROUND_DISTANCE,
                &mut connected,
                &mut queue,
                x,
                y + 1,
            );
        }
    }
    let matte = GrayImage::from_fn(width, height, |x, y| {
        let index = (y * width + x) as usize;
        if !connected[index] {
            return Luma([255]);
        }
        let distance = color_distance(rgba.get_pixel(x, y), background);
        let alpha = ((distance - FULLY_TRANSPARENT_DISTANCE)
            / (FULLY_OPAQUE_DISTANCE - FULLY_TRANSPARENT_DISTANCE)
            * 255.0)
            .clamp(0.0, 255.0)
            .round() as u8;
        Luma([alpha])
    });
    Ok(apply_matte(
        source,
        &matte,
        BORDER_MATTE_ENGINE,
        BORDER_MATTE_MODEL_ID,
        BORDER_MATTE_MODEL_REVISION,
    ))
}

pub(crate) fn cutout(
    paths: &MediaRuntimePaths,
    source: &DynamicImage,
    model_priority: &[String],
) -> MediaResult<SubjectCutoutResult> {
    let mut failures = Vec::new();
    for (index, model_id) in model_priority.iter().enumerate() {
        let result = match model_id.as_str() {
            BIREFNET_MODEL_ID => birefnet_cutout(paths, source),
            BORDER_MATTE_MODEL_ID => border_matte(source),
            _ => Err(format!("subject-cutout model {model_id} is not supported")),
        };
        match result {
            Ok(mut result) => {
                result.summary.attempted_model_ids = model_priority[..=index].to_vec();
                result.summary.fallback_used = index > 0;
                return Ok(result);
            }
            Err(error) => failures.push(format!("{model_id}: {error}")),
        }
    }
    Err(format!(
        "every subject-cutout model failed: {}",
        failures.join("; ")
    ))
}

pub(crate) fn cutout_encoded(
    paths: &MediaRuntimePaths,
    source_bytes: &[u8],
    output_format: &str,
    model_priority: &[String],
) -> MediaResult<EncodedSubjectCutout> {
    if output_format == "jpeg" {
        return Err(
            "transparent images require PNG or WebP output because JPEG has no alpha channel"
                .to_string(),
        );
    }
    let source = transform::decode_image_bytes(source_bytes)?;
    let result = cutout(paths, &source, model_priority)?;
    let request = MediaImageTransformRequest {
        source_asset_id: "subject-cutout-input".to_string(),
        operation: MediaImageTransformOperation::Convert,
        output_format: output_format.to_string(),
        quality: None,
        jpeg_background: None,
    };
    let output = transform::validate_output(&request)?;
    let bytes = transform::encode_image_with_icc(&result.cutout, &output, None)?;
    if bytes.len() as u64 > MAX_ENCODED_BYTES {
        return Err(format!(
            "transparent image exceeds the {} MB encoded-byte limit",
            MAX_ENCODED_BYTES / 1_024 / 1_024
        ));
    }
    Ok(EncodedSubjectCutout {
        bytes,
        summary: result.summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_paths(label: &str) -> MediaRuntimePaths {
        let root = std::env::temp_dir().join(format!(
            "machdoch-subject-cutout-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        }
    }

    #[test]
    fn sigmoid_conversion_is_stable_and_preserves_soft_alpha() {
        assert_eq!(probability_to_alpha(-100.0), 0);
        assert_eq!(probability_to_alpha(0.0), 128);
        assert_eq!(probability_to_alpha(100.0), 255);
    }

    #[test]
    fn border_matte_removes_connected_uniform_background() {
        let source = DynamicImage::ImageRgba8(RgbaImage::from_fn(9, 9, |x, y| {
            if (2..=6).contains(&x) && (2..=6).contains(&y) {
                Rgba([15, 90, 180, 255])
            } else {
                Rgba([250, 250, 250, 255])
            }
        }));
        let priority = vec![BORDER_MATTE_MODEL_ID.to_string()];
        let result = cutout(&test_paths("border"), &source, &priority).unwrap();
        let output = result.cutout.to_rgba8();

        assert_eq!(output.get_pixel(0, 0)[3], 0);
        assert_eq!(output.get_pixel(4, 4)[3], 255);
        assert_eq!(result.summary.model_id, BORDER_MATTE_MODEL_ID);
        assert_eq!(result.summary.attempted_model_ids, priority);
        assert!(!result.summary.fallback_used);
    }

    #[test]
    fn unavailable_primary_falls_back_in_declared_order() {
        let paths = test_paths("fallback");
        let source = DynamicImage::ImageRgba8(RgbaImage::from_fn(5, 5, |x, y| {
            if x == 2 && y == 2 {
                Rgba([10, 20, 220, 255])
            } else {
                Rgba([255, 255, 255, 255])
            }
        }));
        let priority = vec![
            BIREFNET_MODEL_ID.to_string(),
            BORDER_MATTE_MODEL_ID.to_string(),
        ];
        let result = cutout(&paths, &source, &priority).unwrap();

        assert_eq!(result.summary.model_id, BORDER_MATTE_MODEL_ID);
        assert_eq!(result.summary.attempted_model_ids, priority);
        assert!(result.summary.fallback_used);
        if let Some(root) = paths.database.parent().and_then(Path::parent) {
            let _ = std::fs::remove_dir_all(root);
        }
    }
}
