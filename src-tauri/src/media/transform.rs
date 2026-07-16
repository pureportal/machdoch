use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};

use image::{
    codecs::{
        jpeg::JpegEncoder,
        png::{CompressionType, FilterType, PngEncoder},
        webp::WebPEncoder,
    },
    imageops::FilterType as ResizeFilter,
    DynamicImage, ExtendedColorType, ImageDecoder as _, ImageEncoder as _, ImageReader, Limits,
    Rgb, RgbImage,
};
use sha2::{Digest as _, Sha256};

use super::{
    database, svg, MediaImageTransformOperation, MediaImageTransformRequest, MediaResult,
    MediaRunDetail, MediaRuntimePaths,
};

const MAX_ENCODED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DIMENSION: u32 = 20_000;
const MAX_DECODED_PIXELS: u64 = 100_000_000;
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
const MAX_ICC_PROFILE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) struct DecodedAssetImage {
    pub(crate) image: DynamicImage,
    pub(crate) icc_profile: Option<Vec<u8>>,
}

pub(crate) fn read_asset_preview(
    paths: &MediaRuntimePaths,
    asset_id: &str,
    max_edge: u32,
) -> MediaResult<Vec<u8>> {
    let source = database::get_asset_blob_source(paths, asset_id)?;
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
    jpeg_quality: u8,
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
    if !matches!(format, OutputFormat::Jpeg) && request.quality.is_some() {
        return Err("quality is only supported for JPEG output".to_string());
    }
    if !matches!(format, OutputFormat::Jpeg) && request.jpeg_background.is_some() {
        return Err("jpegBackground is only supported for JPEG output".to_string());
    }
    let jpeg_quality = request.quality.unwrap_or(90);
    if !(1..=100).contains(&jpeg_quality) {
        return Err("JPEG quality must be between 1 and 100".to_string());
    }
    let jpeg_background = parse_hex_color(request.jpeg_background.as_deref().unwrap_or("#ffffff"))?;
    Ok(ValidatedOutput {
        format,
        mime_type,
        jpeg_quality,
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
    if source.byte_size == 0 || source.byte_size > MAX_ENCODED_BYTES {
        return Err("Asset blob byte size is outside supported image limits".to_string());
    }
    let blob_path = paths.blobs.join(&expected_relative_path);
    let metadata = fs::symlink_metadata(&blob_path)
        .map_err(|error| format!("failed to inspect asset blob: {error}"))?;
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
            let mut encoder = JpegEncoder::new_with_quality(&mut encoded, output.jpeg_quality);
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
        OutputFormat::WebP => encode_webp_with_icc(image, icc_profile).map_err(|error| {
            error.replace(
                "failed to encode WebP image",
                "failed to encode WebP transform output",
            )
        }),
    }
}

fn encode_webp(image: &DynamicImage) -> MediaResult<Vec<u8>> {
    encode_webp_with_icc(image, None)
}

fn encode_webp_with_icc(image: &DynamicImage, icc_profile: Option<&[u8]>) -> MediaResult<Vec<u8>> {
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
    let destination = paths.blobs.join(relative_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create transformed CAS shard: {error}"))?;
    }
    if destination.exists() {
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
    .map_err(|error| format!("failed to atomically publish transformed image: {error}"))
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
