use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

use font8x8::{UnicodeFonts, BASIC_FONTS};
use image::{
    codecs::{
        jpeg::JpegEncoder,
        png::{CompressionType, FilterType, PngEncoder},
        webp::WebPEncoder,
    },
    imageops::FilterType as ResizeFilter,
    DynamicImage, ExtendedColorType, ImageDecoder as _, ImageEncoder as _, ImageReader, Limits,
    Rgb, RgbImage, Rgba, RgbaImage,
};
use sha2::{Digest as _, Sha256};
use webp::Encoder as LossyWebPEncoder;

use super::{
    database, svg, MediaImageOutputBranch, MediaImagePostProcessingOperation,
    MediaImageTransformOperation, MediaImageTransformRequest, MediaResult, MediaRunDetail,
    MediaRuntimePaths,
};

const MAX_ENCODED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_WEBM_BYTES: u64 = 512 * 1024 * 1024;
const MAX_DIMENSION: u32 = 20_000;
const MAX_DECODED_PIXELS: u64 = 100_000_000;
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
const MAX_ICC_PROFILE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) struct DecodedAssetImage {
    pub(crate) image: DynamicImage,
    pub(crate) icc_profile: Option<Vec<u8>>,
}

pub(crate) struct ProcessedImageBranch {
    pub(crate) bytes: Vec<u8>,
    pub(crate) mime_type: &'static str,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn process_image_output_branch(
    source_bytes: &[u8],
    branch: &MediaImageOutputBranch,
) -> MediaResult<ProcessedImageBranch> {
    let mut decoded = decode_image_bytes_with_profile(source_bytes)?;
    for operation in &branch.operations {
        decoded.image = apply_post_processing_operation(decoded.image, operation)?;
        if matches!(
            operation,
            MediaImagePostProcessingOperation::MetadataStrip {
                preserve_color_profile: false,
                ..
            }
        ) {
            decoded.icc_profile = None;
        }
    }
    validate_dimensions(
        decoded.image.width(),
        decoded.image.height(),
        "Output branch",
    )?;
    let (format, mime_type) = match branch.format.as_str() {
        "png" => (OutputFormat::Png, "image/png"),
        "jpeg" => (OutputFormat::Jpeg, "image/jpeg"),
        "webp" => (OutputFormat::WebP, "image/webp"),
        _ => return Err("output branch format is invalid".to_string()),
    };
    let output = ValidatedOutput {
        format,
        mime_type,
        quality: branch.quality,
        jpeg_background: parse_hex_color(&branch.jpeg_background)?,
    };
    let bytes = encode_image_with_icc(&decoded.image, &output, decoded.icc_profile.as_deref())?;
    if bytes.len() as u64 > MAX_ENCODED_BYTES {
        return Err("Output branch exceeds the encoded-byte limit".to_string());
    }
    Ok(ProcessedImageBranch {
        bytes,
        mime_type,
        width: decoded.image.width(),
        height: decoded.image.height(),
    })
}

pub(crate) fn apply_post_processing_operation(
    source: DynamicImage,
    operation: &MediaImagePostProcessingOperation,
) -> MediaResult<DynamicImage> {
    match operation {
        MediaImagePostProcessingOperation::Crop {
            x,
            y,
            width,
            height,
            ..
        } => apply_operation(
            source,
            &MediaImageTransformOperation::Crop {
                x: *x,
                y: *y,
                width: *width,
                height: *height,
            },
        ),
        MediaImagePostProcessingOperation::Resize {
            width, height, fit, ..
        } => apply_operation(
            source,
            &MediaImageTransformOperation::Resize {
                width: *width,
                height: *height,
                fit: fit.clone(),
            },
        ),
        MediaImagePostProcessingOperation::TextOverlay {
            text,
            position,
            margin,
            font_size,
            color,
            background_color,
            background_opacity,
            ..
        } => render_text_overlay(
            source,
            TextOverlay {
                text,
                position,
                margin: *margin,
                font_size: *font_size,
                color: parse_hex_color(color)?,
                background_color: parse_hex_color(background_color)?,
                background_opacity: *background_opacity,
            },
        ),
        MediaImagePostProcessingOperation::ColorAdjust {
            brightness,
            contrast,
            saturation,
            ..
        } => {
            let adjusted = source
                .brighten(*brightness)
                .adjust_contrast(*contrast as f32);
            Ok(DynamicImage::ImageRgba8(adjust_saturation(
                adjusted.to_rgba8(),
                *saturation as f32 / 100.0,
            )))
        }
        MediaImagePostProcessingOperation::Sharpen {
            sigma, threshold, ..
        } => Ok(DynamicImage::ImageRgba8(image::imageops::unsharpen(
            &source.to_rgba8(),
            *sigma as f32,
            *threshold,
        ))),
        MediaImagePostProcessingOperation::MetadataStrip { .. } => Ok(source),
    }
}

fn adjust_saturation(mut image: RgbaImage, saturation: f32) -> RgbaImage {
    for pixel in image.pixels_mut() {
        let luminance =
            0.2126 * pixel[0] as f32 + 0.7152 * pixel[1] as f32 + 0.0722 * pixel[2] as f32;
        for channel in 0..3 {
            pixel[channel] = (luminance + (pixel[channel] as f32 - luminance) * saturation)
                .round()
                .clamp(0.0, 255.0) as u8;
        }
    }
    image
}

fn blend_pixel(destination: &mut Rgba<u8>, color: [u8; 3], alpha: u8) {
    let alpha = u16::from(alpha);
    let inverse = 255 - alpha;
    for channel in 0..3 {
        destination[channel] =
            ((u16::from(color[channel]) * alpha + u16::from(destination[channel]) * inverse + 127)
                / 255) as u8;
    }
    destination[3] = 255;
}

struct TextOverlay<'a> {
    text: &'a str,
    position: &'a str,
    margin: u32,
    font_size: u32,
    color: [u8; 3],
    background_color: [u8; 3],
    background_opacity: f64,
}

fn render_text_overlay(
    source: DynamicImage,
    overlay: TextOverlay<'_>,
) -> MediaResult<DynamicImage> {
    let scale = overlay.font_size.div_ceil(8).max(1);
    let lines = overlay.text.split('\n').collect::<Vec<_>>();
    let text_width = lines
        .iter()
        .map(|line| line.chars().count() as u32 * 8 * scale)
        .max()
        .unwrap_or(0);
    let line_height = 8 * scale;
    let text_height = lines.len() as u32 * line_height;
    let padding = scale * 2;
    let box_width = text_width.saturating_add(padding * 2);
    let box_height = text_height.saturating_add(padding * 2);
    if box_width > source.width() || box_height > source.height() {
        return Err("Text overlay does not fit inside the output image".to_string());
    }
    let (origin_x, origin_y) = match overlay.position {
        "top-left" => (overlay.margin, overlay.margin),
        "top-right" => (
            source.width().saturating_sub(box_width + overlay.margin),
            overlay.margin,
        ),
        "bottom-left" => (
            overlay.margin,
            source.height().saturating_sub(box_height + overlay.margin),
        ),
        "bottom-right" => (
            source.width().saturating_sub(box_width + overlay.margin),
            source.height().saturating_sub(box_height + overlay.margin),
        ),
        "center" => (
            (source.width() - box_width) / 2,
            (source.height() - box_height) / 2,
        ),
        _ => return Err("Text overlay position is invalid".to_string()),
    };
    if origin_x + box_width > source.width() || origin_y + box_height > source.height() {
        return Err("Text overlay margin places it outside the output image".to_string());
    }
    let mut image = source.to_rgba8();
    let background_alpha = (overlay.background_opacity * 255.0).round() as u8;
    for y in origin_y..origin_y + box_height {
        for x in origin_x..origin_x + box_width {
            blend_pixel(
                image.get_pixel_mut(x, y),
                overlay.background_color,
                background_alpha,
            );
        }
    }
    for (line_index, line) in lines.iter().enumerate() {
        for (character_index, character) in line.chars().enumerate() {
            let glyph = BASIC_FONTS
                .get(character)
                .ok_or_else(|| "Text overlay contains an unsupported glyph".to_string())?;
            let glyph_x = origin_x + padding + character_index as u32 * 8 * scale;
            let glyph_y = origin_y + padding + line_index as u32 * line_height;
            for (row, bits) in glyph.iter().enumerate() {
                for column in 0..8_u32 {
                    if bits & (1 << column) == 0 {
                        continue;
                    }
                    for offset_y in 0..scale {
                        for offset_x in 0..scale {
                            let x = glyph_x + column * scale + offset_x;
                            let y = glyph_y + row as u32 * scale + offset_y;
                            blend_pixel(image.get_pixel_mut(x, y), overlay.color, 255);
                        }
                    }
                }
            }
        }
    }
    Ok(DynamicImage::ImageRgba8(image))
}

pub(crate) fn read_asset_preview(
    paths: &MediaRuntimePaths,
    asset_id: &str,
    max_edge: u32,
) -> MediaResult<Vec<u8>> {
    let source = database::get_asset_blob_source(paths, asset_id)?;
    if source.mime_type == "video/webm" {
        // The browser needs the original container for native playback. The
        // immutable CAS read still verifies the recorded size and SHA-256.
        return read_verified_blob(paths, &source);
    }
    let is_svg = source.mime_type == "image/svg+xml";
    let profile = if is_svg {
        format!("svg-library-webp-{max_edge}-secure-static-v2")
    } else {
        format!("library-webp-{max_edge}-v1")
    };
    if let Some(cached) = database::get_asset_rendition_blob_source(paths, asset_id, &profile)? {
        // Renditions are disposable. A failed integrity check falls through to
        // deterministic regeneration from the immutable source asset.
        if let Ok(bytes) = read_verified_blob(paths, &cached) {
            return Ok(bytes);
        }
    }
    let image = if is_svg {
        let bytes = read_verified_blob(paths, &source)?;
        let document = svg::validate_and_canonicalize_svg(&bytes)?;
        let evaluation = svg::evaluate_svg(&document, max_edge)?;
        image::load_from_memory(&evaluation.png_bytes)
            .map_err(|error| format!("failed to decode secure SVG preview: {error}"))?
    } else {
        read_verified_asset_image(paths, asset_id)?
    };
    let thumbnail = image.thumbnail(max_edge, max_edge);
    let encoded = encode_webp(&thumbnail)?;
    let digest = format!("{:x}", Sha256::digest(&encoded));
    let relative_path = cas_relative_path(&digest);
    publish_cas_bytes(paths, &relative_path, &digest, &encoded)?;
    database::record_asset_rendition(
        paths,
        asset_id,
        &profile,
        &digest,
        &relative_path.to_string_lossy(),
        encoded.len() as u64,
        "image/webp",
        thumbnail.width(),
        thumbnail.height(),
    )?;
    Ok(encoded)
}

pub(crate) fn read_asset_original(
    paths: &MediaRuntimePaths,
    asset_id: &str,
) -> MediaResult<(database::AssetBlobSource, Vec<u8>)> {
    let source = database::get_asset_blob_source(paths, asset_id)?;
    let bytes = read_verified_blob(paths, &source)?;
    Ok((source, bytes))
}

pub(crate) fn transform_image(
    paths: &MediaRuntimePaths,
    request: &MediaImageTransformRequest,
) -> MediaResult<MediaRunDetail> {
    let output = validate_output(request)?;
    let (_, source) = read_asset_image_with_profile(paths, &request.source_asset_id)?;
    let transformed = apply_operation(source.image, &request.operation)?;
    validate_dimensions(
        transformed.width(),
        transformed.height(),
        "Transform output",
    )?;

    let encoded = encode_image_with_icc(&transformed, &output, source.icc_profile.as_deref())?;
    if encoded.len() as u64 > MAX_ENCODED_BYTES {
        return Err(format!(
            "Transform output exceeds the {} MB encoded-byte limit",
            MAX_ENCODED_BYTES / 1024 / 1024
        ));
    }
    let digest = format!("{:x}", Sha256::digest(&encoded));
    let relative_path = cas_relative_path(&digest);
    publish_cas_bytes(paths, &relative_path, &digest, &encoded)?;
    let operation_json = serde_json::to_string(&request.operation)
        .map_err(|error| format!("failed to encode image transform metadata: {error}"))?;

    database::record_transformed_asset(
        paths,
        &request.source_asset_id,
        &digest,
        &relative_path.to_string_lossy(),
        encoded.len() as u64,
        output.mime_type,
        transformed.width(),
        transformed.height(),
        operation_label(&request.operation),
        &operation_json,
    )
}

pub(super) struct ValidatedOutput {
    pub(super) format: OutputFormat,
    pub(super) mime_type: &'static str,
    quality: u8,
    jpeg_background: [u8; 3],
}

#[derive(Clone, Copy)]
pub(super) enum OutputFormat {
    Png,
    Jpeg,
    WebP,
}

pub(super) fn validate_output(
    request: &MediaImageTransformRequest,
) -> MediaResult<ValidatedOutput> {
    let (format, mime_type) = match request.output_format.as_str() {
        "png" => (OutputFormat::Png, "image/png"),
        "jpeg" => (OutputFormat::Jpeg, "image/jpeg"),
        "webp" => (OutputFormat::WebP, "image/webp"),
        _ => return Err("outputFormat must be png, jpeg, or webp".to_string()),
    };
    if matches!(format, OutputFormat::Png) && request.quality.is_some() {
        return Err("quality is only supported for JPEG or WebP output".to_string());
    }
    if !matches!(format, OutputFormat::Jpeg) && request.jpeg_background.is_some() {
        return Err("jpegBackground is only supported for JPEG output".to_string());
    }
    let quality = request.quality.unwrap_or(90);
    if !(1..=100).contains(&quality) {
        return Err("quality must be between 1 and 100".to_string());
    }
    let jpeg_background = parse_hex_color(request.jpeg_background.as_deref().unwrap_or("#ffffff"))?;
    Ok(ValidatedOutput {
        format,
        mime_type,
        quality,
        jpeg_background,
    })
}

pub(super) fn parse_hex_color(value: &str) -> MediaResult<[u8; 3]> {
    let digits = value
        .strip_prefix('#')
        .filter(|digits| digits.len() == 6)
        .ok_or_else(|| "jpegBackground must be a six-digit hex color".to_string())?;
    let parse = |range: std::ops::Range<usize>| {
        u8::from_str_radix(&digits[range], 16)
            .map_err(|_| "jpegBackground must be a six-digit hex color".to_string())
    };
    Ok([parse(0..2)?, parse(2..4)?, parse(4..6)?])
}

pub(super) fn apply_operation(
    source: DynamicImage,
    operation: &MediaImageTransformOperation,
) -> MediaResult<DynamicImage> {
    match operation {
        MediaImageTransformOperation::Crop {
            x,
            y,
            width,
            height,
        } => {
            validate_dimensions(*width, *height, "Crop")?;
            let right = x
                .checked_add(*width)
                .ok_or_else(|| "Crop horizontal bounds overflow".to_string())?;
            let bottom = y
                .checked_add(*height)
                .ok_or_else(|| "Crop vertical bounds overflow".to_string())?;
            if right > source.width() || bottom > source.height() {
                return Err(format!(
                    "Crop rectangle {x},{y} {width}x{height} exceeds source dimensions {}x{}",
                    source.width(),
                    source.height()
                ));
            }
            Ok(source.crop_imm(*x, *y, *width, *height))
        }
        MediaImageTransformOperation::Resize { width, height, fit } => {
            validate_dimensions(*width, *height, "Resize")?;
            match fit.as_str() {
                "contain" => Ok(source.resize(*width, *height, ResizeFilter::Lanczos3)),
                "cover" => Ok(source.resize_to_fill(*width, *height, ResizeFilter::Lanczos3)),
                "stretch" => Ok(source.resize_exact(*width, *height, ResizeFilter::Lanczos3)),
                _ => Err("Resize fit must be contain, cover, or stretch".to_string()),
            }
        }
        MediaImageTransformOperation::Convert => Ok(source),
    }
}

pub(super) fn validate_dimensions(width: u32, height: u32, label: &str) -> MediaResult<()> {
    if width == 0 || height == 0 {
        return Err(format!("{label} dimensions must be greater than zero"));
    }
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!(
            "{label} dimensions {width}x{height} exceed the {MAX_DIMENSION}px per-axis limit"
        ));
    }
    let pixels = u64::from(width) * u64::from(height);
    if pixels > MAX_DECODED_PIXELS {
        return Err(format!(
            "{label} has {pixels} decoded pixels; the limit is {MAX_DECODED_PIXELS}"
        ));
    }
    Ok(())
}

fn read_verified_asset_image(
    paths: &MediaRuntimePaths,
    asset_id: &str,
) -> MediaResult<DynamicImage> {
    read_asset_image(paths, asset_id).map(|(_, image)| image)
}

pub(crate) fn read_asset_image(
    paths: &MediaRuntimePaths,
    asset_id: &str,
) -> MediaResult<(database::AssetBlobSource, DynamicImage)> {
    let (source, decoded) = read_asset_image_with_profile(paths, asset_id)?;
    Ok((source, decoded.image))
}

pub(crate) fn read_asset_image_with_profile(
    paths: &MediaRuntimePaths,
    asset_id: &str,
) -> MediaResult<(database::AssetBlobSource, DecodedAssetImage)> {
    let source = database::get_asset_blob_source(paths, asset_id)?;
    if !matches!(
        source.mime_type.as_str(),
        "image/png" | "image/jpeg" | "image/webp"
    ) {
        return Err(format!("media asset {asset_id} is not a supported image"));
    }
    let bytes = read_verified_blob(paths, &source)?;
    let image = decode_image_bytes_with_profile(&bytes)?;
    Ok((source, image))
}

pub(crate) fn decode_image_bytes(bytes: &[u8]) -> MediaResult<DynamicImage> {
    decode_image_bytes_with_profile(bytes).map(|decoded| decoded.image)
}

pub(crate) fn encode_metadata_stripped_png(
    image: &DynamicImage,
    icc_profile: Option<&[u8]>,
) -> MediaResult<Vec<u8>> {
    let encoded = encode_png_with_icc(image, CompressionType::Default, icc_profile)?;
    if encoded.len() as u64 > MAX_ENCODED_BYTES {
        return Err(format!(
            "Metadata-stripped PNG exceeds the {} MB encoded-byte limit",
            MAX_ENCODED_BYTES / 1024 / 1024
        ));
    }
    Ok(encoded)
}

fn decode_image_bytes_with_profile(bytes: &[u8]) -> MediaResult<DecodedAssetImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("failed to identify asset image format: {error}"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);
    let mut decoder = reader
        .into_decoder()
        .map_err(|error| format!("failed to initialize bounded asset decoder: {error}"))?;
    let orientation = decoder
        .orientation()
        .map_err(|error| format!("failed to read asset image orientation: {error}"))?;
    let icc_profile = decoder
        .icc_profile()
        .map_err(|error| format!("failed to read asset image color profile: {error}"))?;
    if icc_profile
        .as_ref()
        .is_some_and(|profile| profile.len() > MAX_ICC_PROFILE_BYTES)
    {
        return Err(format!(
            "Asset ICC profile exceeds the {} MB safety limit",
            MAX_ICC_PROFILE_BYTES / 1024 / 1024
        ));
    }
    let mut image = DynamicImage::from_decoder(decoder)
        .map_err(|error| format!("asset image failed bounded decode: {error}"))?;
    image.apply_orientation(orientation);
    validate_dimensions(image.width(), image.height(), "Asset image")?;
    Ok(DecodedAssetImage { image, icc_profile })
}

fn read_verified_blob(
    paths: &MediaRuntimePaths,
    source: &database::AssetBlobSource,
) -> MediaResult<Vec<u8>> {
    let blob_path = resolve_verified_blob_path(paths, source)?;
    fs::read(&blob_path).map_err(|error| format!("failed to read asset blob: {error}"))
}

pub(crate) fn resolve_verified_blob_path(
    paths: &MediaRuntimePaths,
    source: &database::AssetBlobSource,
) -> MediaResult<PathBuf> {
    if source.digest.len() != 64 || !source.digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Asset blob digest is invalid".to_string());
    }
    let expected_relative_path = cas_relative_path(&source.digest);
    if Path::new(&source.relative_path) != expected_relative_path {
        return Err("Asset blob path does not match its content digest".to_string());
    }
    let max_byte_size = max_asset_blob_bytes(&source.mime_type);
    if source.byte_size == 0 || source.byte_size > max_byte_size {
        return Err(format!(
            "Asset blob byte size is outside the supported {} MB limit for {}",
            max_byte_size / 1024 / 1024,
            source.mime_type
        ));
    }
    let blob_path = paths.blobs.join(&expected_relative_path);
    let metadata = fs::symlink_metadata(&blob_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            format!(
                "Asset blob {} is missing from managed content-addressed storage; republish or regenerate the source asset",
                source.digest
            )
        } else {
            format!("failed to inspect asset blob: {error}")
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Asset blob must be a regular file".to_string());
    }
    if metadata.len() != source.byte_size {
        return Err("Asset blob size does not match its database record".to_string());
    }
    let bytes =
        fs::read(&blob_path).map_err(|error| format!("failed to verify asset blob: {error}"))?;
    let actual_digest = format!("{:x}", Sha256::digest(&bytes));
    if actual_digest != source.digest {
        return Err("Asset blob failed SHA-256 integrity verification".to_string());
    }
    Ok(blob_path)
}

pub(crate) fn max_asset_blob_bytes(mime_type: &str) -> u64 {
    if mime_type == "video/webm" {
        MAX_WEBM_BYTES
    } else {
        MAX_ENCODED_BYTES
    }
}

pub(super) fn encode_image_with_icc(
    image: &DynamicImage,
    output: &ValidatedOutput,
    icc_profile: Option<&[u8]>,
) -> MediaResult<Vec<u8>> {
    match output.format {
        OutputFormat::Png => encode_png_with_icc(image, CompressionType::Default, icc_profile),
        OutputFormat::Jpeg => {
            let rgb = flatten_to_rgb(image, output.jpeg_background);
            let mut encoded = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut encoded, output.quality);
            if let Some(profile) = icc_profile {
                encoder
                    .set_icc_profile(profile.to_vec())
                    .map_err(|error| format!("failed to preserve JPEG ICC profile: {error}"))?;
            }
            encoder
                .encode(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    ExtendedColorType::Rgb8,
                )
                .map_err(|error| format!("failed to encode JPEG transform output: {error}"))?;
            Ok(encoded)
        }
        OutputFormat::WebP => {
            encode_webp_with_icc(image, output.quality, icc_profile).map_err(|error| {
                error.replace(
                    "failed to encode WebP image",
                    "failed to encode WebP transform output",
                )
            })
        }
    }
}

fn encode_webp(image: &DynamicImage) -> MediaResult<Vec<u8>> {
    encode_lossless_webp_with_icc(image, None)
}

fn encode_lossless_webp_with_icc(
    image: &DynamicImage,
    icc_profile: Option<&[u8]>,
) -> MediaResult<Vec<u8>> {
    let rgba = image.to_rgba8();
    let mut encoded = Vec::new();
    let mut encoder = WebPEncoder::new_lossless(&mut encoded);
    if let Some(profile) = icc_profile {
        encoder
            .set_icc_profile(profile.to_vec())
            .map_err(|error| format!("failed to preserve WebP ICC profile: {error}"))?;
    }
    encoder
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|error| format!("failed to encode WebP image: {error}"))?;
    Ok(encoded)
}

fn encode_webp_with_icc(
    image: &DynamicImage,
    quality: u8,
    icc_profile: Option<&[u8]>,
) -> MediaResult<Vec<u8>> {
    let rgba = image.to_rgba8();
    let encoded = LossyWebPEncoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height())
        .encode_simple(false, f32::from(quality))
        .map_err(|error| format!("failed to encode WebP image: {error:?}"))?;
    match icc_profile {
        Some(profile) => attach_webp_icc(&encoded, profile, rgba.width(), rgba.height()),
        None => Ok(encoded.to_vec()),
    }
}

fn webp_chunk(fourcc: &[u8; 4], payload: &[u8]) -> MediaResult<Vec<u8>> {
    let payload_size = u32::try_from(payload.len())
        .map_err(|_| "WebP metadata chunk exceeds its size limit".to_string())?;
    let mut chunk = Vec::with_capacity(8 + payload.len() + payload.len() % 2);
    chunk.extend_from_slice(fourcc);
    chunk.extend_from_slice(&payload_size.to_le_bytes());
    chunk.extend_from_slice(payload);
    if !payload.len().is_multiple_of(2) {
        chunk.push(0);
    }
    Ok(chunk)
}

fn attach_webp_icc(
    encoded: &[u8],
    icc_profile: &[u8],
    width: u32,
    height: u32,
) -> MediaResult<Vec<u8>> {
    if encoded.len() < 12 || &encoded[..4] != b"RIFF" || &encoded[8..12] != b"WEBP" {
        return Err("failed to preserve WebP ICC profile: invalid WebP container".to_string());
    }
    if icc_profile.len() > MAX_ICC_PROFILE_BYTES {
        return Err("failed to preserve WebP ICC profile: profile is too large".to_string());
    }
    let declared_size = u32::from_le_bytes([encoded[4], encoded[5], encoded[6], encoded[7]]);
    if declared_size as usize + 8 != encoded.len() {
        return Err("failed to preserve WebP ICC profile: invalid RIFF size".to_string());
    }

    let mut chunks = encoded[12..].to_vec();
    let mut offset = 0usize;
    let mut vp8x_end = None;
    while offset < chunks.len() {
        if chunks.len() - offset < 8 {
            return Err("failed to preserve WebP ICC profile: truncated chunk".to_string());
        }
        let fourcc = &chunks[offset..offset + 4];
        let payload_size = u32::from_le_bytes([
            chunks[offset + 4],
            chunks[offset + 5],
            chunks[offset + 6],
            chunks[offset + 7],
        ]) as usize;
        let padded_size = payload_size
            .checked_add(payload_size % 2)
            .ok_or_else(|| "failed to preserve WebP ICC profile: invalid chunk size".to_string())?;
        let end = offset
            .checked_add(8)
            .and_then(|value| value.checked_add(padded_size))
            .ok_or_else(|| "failed to preserve WebP ICC profile: invalid chunk size".to_string())?;
        if end > chunks.len() {
            return Err("failed to preserve WebP ICC profile: truncated chunk".to_string());
        }
        if fourcc == b"ICCP" {
            return Err("failed to preserve WebP ICC profile: duplicate ICC chunk".to_string());
        }
        if fourcc == b"VP8X" {
            if payload_size != 10 || vp8x_end.is_some() {
                return Err("failed to preserve WebP ICC profile: invalid VP8X chunk".to_string());
            }
            chunks[offset + 8] |= 1 << 5;
            vp8x_end = Some(end);
        }
        offset = end;
    }

    let icc_chunk = webp_chunk(b"ICCP", icc_profile)?;
    let body = if let Some(insert_at) = vp8x_end {
        let mut body = Vec::with_capacity(chunks.len() + icc_chunk.len());
        body.extend_from_slice(&chunks[..insert_at]);
        body.extend_from_slice(&icc_chunk);
        body.extend_from_slice(&chunks[insert_at..]);
        body
    } else {
        if width == 0 || height == 0 || width > (1 << 24) || height > (1 << 24) {
            return Err("failed to preserve WebP ICC profile: invalid canvas size".to_string());
        }
        let mut vp8x = Vec::with_capacity(10);
        vp8x.push(1 << 5);
        vp8x.extend_from_slice(&[0; 3]);
        vp8x.extend_from_slice(&(width - 1).to_le_bytes()[..3]);
        vp8x.extend_from_slice(&(height - 1).to_le_bytes()[..3]);
        let vp8x_chunk = webp_chunk(b"VP8X", &vp8x)?;
        let mut body = Vec::with_capacity(vp8x_chunk.len() + icc_chunk.len() + chunks.len());
        body.extend_from_slice(&vp8x_chunk);
        body.extend_from_slice(&icc_chunk);
        body.extend_from_slice(&chunks);
        body
    };
    let riff_size = body
        .len()
        .checked_add(4)
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| "failed to preserve WebP ICC profile: output is too large".to_string())?;
    let mut output = Vec::with_capacity(body.len() + 12);
    output.extend_from_slice(b"RIFF");
    output.extend_from_slice(&riff_size.to_le_bytes());
    output.extend_from_slice(b"WEBP");
    output.extend_from_slice(&body);
    Ok(output)
}

fn encode_png_with_icc(
    image: &DynamicImage,
    compression: CompressionType,
    icc_profile: Option<&[u8]>,
) -> MediaResult<Vec<u8>> {
    let rgba = image.to_rgba8();
    let mut encoded = Vec::new();
    let mut encoder = PngEncoder::new_with_quality(&mut encoded, compression, FilterType::Adaptive);
    if let Some(profile) = icc_profile {
        encoder
            .set_icc_profile(profile.to_vec())
            .map_err(|error| format!("failed to preserve PNG ICC profile: {error}"))?;
    }
    encoder
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            ExtendedColorType::Rgba8,
        )
        .map_err(|error| format!("failed to encode PNG image: {error}"))?;
    Ok(encoded)
}

fn flatten_to_rgb(image: &DynamicImage, background: [u8; 3]) -> RgbImage {
    let rgba = image.to_rgba8();
    let mut rgb = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u16::from(pixel[3]);
        let inverse = 255 - alpha;
        let composite = [0, 1, 2].map(|channel| {
            ((u16::from(pixel[channel]) * alpha + u16::from(background[channel]) * inverse + 127)
                / 255) as u8
        });
        rgb.put_pixel(x, y, Rgb(composite));
    }
    rgb
}

pub(crate) fn cas_relative_path(digest: &str) -> PathBuf {
    Path::new(&digest[0..2]).join(&digest[2..4]).join(digest)
}

pub(crate) fn publish_cas_bytes(
    paths: &MediaRuntimePaths,
    relative_path: &Path,
    digest: &str,
    bytes: &[u8],
) -> MediaResult<()> {
    if digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("CAS publication digest is invalid".to_string());
    }
    let expected_relative_path = cas_relative_path(digest);
    if relative_path != expected_relative_path {
        return Err("CAS publication path does not match its content digest".to_string());
    }
    if format!("{:x}", Sha256::digest(bytes)) != digest {
        return Err("CAS publication bytes do not match their content digest".to_string());
    }
    let destination = paths.blobs.join(relative_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create CAS shard: {error}"))?;
    }
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Existing CAS destination must be a regular file".to_string());
        }
        let existing = fs::read(&destination)
            .map_err(|error| format!("failed to verify deduplicated CAS blob: {error}"))?;
        if format!("{:x}", Sha256::digest(&existing)) == digest {
            return Ok(());
        }
    }
    crate::atomic_file::write_file_atomic(
        &destination,
        bytes,
        crate::atomic_file::AtomicWriteOptions::default(),
    )
    .map_err(|error| format!("failed to atomically publish CAS blob: {error}"))?;
    let published = fs::read(&destination)
        .map_err(|error| format!("failed to verify published CAS blob: {error}"))?;
    if published.len() != bytes.len() || format!("{:x}", Sha256::digest(&published)) != digest {
        return Err("Published CAS blob failed size or SHA-256 verification".to_string());
    }
    Ok(())
}

fn operation_label(operation: &MediaImageTransformOperation) -> &'static str {
    match operation {
        MediaImageTransformOperation::Crop { .. } => "Crop image",
        MediaImageTransformOperation::Resize { .. } => "Resize image",
        MediaImageTransformOperation::Convert => "Convert image format",
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Cursor,
        time::{SystemTime, UNIX_EPOCH},
    };

    use image::{ImageFormat, Rgba, RgbaImage};

    use super::*;
    use crate::media::ingest;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "machdoch-transform-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn imported_asset(label: &str) -> (PathBuf, MediaRuntimePaths, String) {
        let root = test_root(label);
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.png");
        let image = RgbaImage::from_fn(120, 80, |x, y| {
            Rgba([(x % 255) as u8, (y % 255) as u8, 90, 200])
        });
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        fs::write(&source, encoded.into_inner()).unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let imported = ingest::import_image(&paths, source.to_str().unwrap()).unwrap();
        let asset_id = imported.asset.id;
        (root, paths, asset_id)
    }

    #[test]
    fn crop_publishes_verified_derived_asset_with_lineage() {
        let (root, paths, source_asset_id) = imported_asset("crop");
        let request = MediaImageTransformRequest {
            source_asset_id: source_asset_id.clone(),
            operation: MediaImageTransformOperation::Crop {
                x: 10,
                y: 5,
                width: 60,
                height: 40,
            },
            output_format: "png".to_string(),
            quality: None,
            jpeg_background: None,
        };

        let detail = transform_image(&paths, &request).unwrap();

        assert_eq!(detail.run.executor, "local-transform");
        assert_eq!((detail.assets[0].width, detail.assets[0].height), (60, 40));
        assert_eq!(detail.assets[0].source_asset_ids, vec![source_asset_id]);
        assert_eq!(detail.assets[0].operation.as_ref().unwrap()["kind"], "crop");
        assert!(detail
            .events
            .iter()
            .any(|event| event.kind == "asset_transformed"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resize_cover_and_jpeg_conversion_use_requested_output_contract() {
        let (root, paths, source_asset_id) = imported_asset("resize-jpeg");
        let request = MediaImageTransformRequest {
            source_asset_id,
            operation: MediaImageTransformOperation::Resize {
                width: 50,
                height: 50,
                fit: "cover".to_string(),
            },
            output_format: "jpeg".to_string(),
            quality: Some(82),
            jpeg_background: Some("#102030".to_string()),
        };

        let detail = transform_image(&paths, &request).unwrap();

        assert_eq!(detail.assets[0].mime_type, "image/jpeg");
        assert_eq!((detail.assets[0].width, detail.assets[0].height), (50, 50));
        let preview = read_asset_preview(&paths, &detail.assets[0].id, 128).unwrap();
        let cached_preview = read_asset_preview(&paths, &detail.assets[0].id, 128).unwrap();
        assert_eq!(&preview[0..4], b"RIFF");
        assert_eq!(&preview[8..12], b"WEBP");
        assert_eq!(preview, cached_preview);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn output_branches_apply_crop_and_disclaimer_independently() {
        let source =
            DynamicImage::ImageRgba8(RgbaImage::from_pixel(256, 128, Rgba([255, 255, 255, 255])));
        let mut encoded = Cursor::new(Vec::new());
        source.write_to(&mut encoded, ImageFormat::Png).unwrap();
        let source_bytes = encoded.into_inner();
        let png_branch = MediaImageOutputBranch {
            id: "png-output".to_string(),
            output_node_id: "png-output".to_string(),
            format: "png".to_string(),
            quality: 95,
            jpeg_background: "#ffffff".to_string(),
            operations: vec![MediaImagePostProcessingOperation::Crop {
                node_id: "crop-png".to_string(),
                x: 16,
                y: 8,
                width: 120,
                height: 80,
            }],
        };
        let webp_branch = MediaImageOutputBranch {
            id: "webp-output".to_string(),
            output_node_id: "webp-output".to_string(),
            format: "webp".to_string(),
            quality: 90,
            jpeg_background: "#ffffff".to_string(),
            operations: vec![MediaImagePostProcessingOperation::TextOverlay {
                node_id: "disclaimer-overlay".to_string(),
                text: "AI Image Disclaimer".to_string(),
                position: "bottom-right".to_string(),
                margin: 8,
                font_size: 8,
                color: "#ffffff".to_string(),
                background_color: "#000000".to_string(),
                background_opacity: 0.55,
            }],
        };

        let png = process_image_output_branch(&source_bytes, &png_branch).unwrap();
        let webp = process_image_output_branch(&source_bytes, &webp_branch).unwrap();
        let png_pixels = image::load_from_memory(&png.bytes).unwrap().to_rgba8();
        let webp_pixels = image::load_from_memory(&webp.bytes).unwrap().to_rgba8();

        assert_eq!(
            (png.width, png.height, png.mime_type),
            (120, 80, "image/png")
        );
        assert_eq!(
            (webp.width, webp.height, webp.mime_type),
            (256, 128, "image/webp")
        );
        assert!(png_pixels
            .pixels()
            .all(|pixel| *pixel == Rgba([255, 255, 255, 255])));
        assert_eq!(*webp_pixels.get_pixel(0, 0), Rgba([255, 255, 255, 255]));
        assert!(webp_pixels
            .enumerate_pixels()
            .any(|(x, y, pixel)| x > 80 && y > 100 && *pixel != Rgba([255, 255, 255, 255])));
    }

    #[test]
    fn webp_output_branch_applies_quality() {
        let source = RgbaImage::from_fn(192, 128, |x, y| {
            Rgba([
                ((x * 37 + y * 17) % 256) as u8,
                ((x * 11 + y * 53) % 256) as u8,
                ((x * 71 + y * 29) % 256) as u8,
                255,
            ])
        });
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(source.clone())
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        let source_bytes = encoded.into_inner();
        let branch = |quality| MediaImageOutputBranch {
            id: format!("webp-{quality}"),
            output_node_id: format!("webp-{quality}"),
            format: "webp".to_string(),
            quality,
            jpeg_background: "#ffffff".to_string(),
            operations: Vec::new(),
        };

        let low = process_image_output_branch(&source_bytes, &branch(15)).unwrap();
        let high = process_image_output_branch(&source_bytes, &branch(95)).unwrap();
        let low_pixels = image::load_from_memory(&low.bytes).unwrap().to_rgba8();
        let high_pixels = image::load_from_memory(&high.bytes).unwrap().to_rgba8();
        let error = |actual: &RgbaImage| {
            source
                .pixels()
                .zip(actual.pixels())
                .map(|(expected, actual)| {
                    (0..3)
                        .map(|channel| expected[channel].abs_diff(actual[channel]) as u64)
                        .sum::<u64>()
                })
                .sum::<u64>()
        };

        assert_ne!(low.bytes, high.bytes);
        assert!(error(&high_pixels) < error(&low_pixels));
    }

    #[test]
    fn rejects_crop_outside_source_without_creating_an_asset() {
        let (root, paths, source_asset_id) = imported_asset("invalid-crop");
        let request = MediaImageTransformRequest {
            source_asset_id,
            operation: MediaImageTransformOperation::Crop {
                x: 100,
                y: 70,
                width: 30,
                height: 20,
            },
            output_format: "webp".to_string(),
            quality: None,
            jpeg_background: None,
        };

        let error = transform_image(&paths, &request).unwrap_err();

        assert!(error.contains("exceeds source dimensions"));
        assert_eq!(database::list_assets(&paths, 10).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preserves_bounded_icc_profiles_across_transform_formats() {
        let root = test_root("icc-preservation");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("profiled.png");
        let image = RgbaImage::from_pixel(32, 20, Rgba([40, 80, 120, 255]));
        let icc_profile = (0..=255).collect::<Vec<u8>>();
        let mut bytes = Vec::new();
        let mut encoder = PngEncoder::new(&mut bytes);
        encoder.set_icc_profile(icc_profile.clone()).unwrap();
        encoder
            .write_image(
                image.as_raw(),
                image.width(),
                image.height(),
                ExtendedColorType::Rgba8,
            )
            .unwrap();
        fs::write(&source, bytes).unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let imported = ingest::import_image(&paths, source.to_str().unwrap()).unwrap();
        let source_asset_id = imported.asset.id;
        let transformed = transform_image(
            &paths,
            &MediaImageTransformRequest {
                source_asset_id,
                operation: MediaImageTransformOperation::Resize {
                    width: 16,
                    height: 10,
                    fit: "stretch".to_string(),
                },
                output_format: "webp".to_string(),
                quality: None,
                jpeg_background: None,
            },
        )
        .unwrap();
        let (_, output_bytes) = read_asset_original(&paths, &transformed.assets[0].id).unwrap();
        let decoded = decode_image_bytes_with_profile(&output_bytes).unwrap();

        assert_eq!(decoded.icc_profile, Some(icc_profile));
        assert_eq!((decoded.image.width(), decoded.image.height()), (16, 10));
        fs::remove_dir_all(root).unwrap();
    }
}
