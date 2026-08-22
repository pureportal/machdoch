use std::{
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use image::{ImageFormat, ImageReader, Limits};
use sha2::{Digest as _, Sha256};

use super::{database, svg, transform, MediaImageImportResult, MediaResult, MediaRuntimePaths};

const MAX_ENCODED_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DIMENSION: u32 = 20_000;
const MAX_DECODED_PIXELS: u64 = 100_000_000;
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;

pub(crate) fn import_image(
    paths: &MediaRuntimePaths,
    source_path: &str,
) -> MediaResult<MediaImageImportResult> {
    let source_path = validate_source_path(source_path)?;
    let staged = stage_and_hash(paths, &source_path)?;
    if source_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("svg"))
    {
        let result = import_svg_raster(paths, &staged);
        let _ = fs::remove_file(&staged.path);
        return result;
    }
    let result = validate_staged_image(&staged.path).and_then(|validated| {
        promote_to_cas(paths, &staged).and_then(|relative_path| {
            database::record_imported_asset(
                paths,
                database::ImportedAssetRegistration {
                    digest: &staged.digest,
                    relative_path: &relative_path.to_string_lossy(),
                    byte_size: staged.byte_size,
                    mime_type: validated.mime_type,
                    width: validated.width,
                    height: validated.height,
                    import_kind: database::LocalImportKind::Raster,
                },
            )
        })
    });

    if result.is_err() {
        let _ = fs::remove_file(&staged.path);
    }
    result
}

fn import_svg_raster(
    paths: &MediaRuntimePaths,
    staged: &StagedImage,
) -> MediaResult<MediaImageImportResult> {
    let raster = svg::rasterize_staged_svg(&staged.path)?;
    if raster.png_bytes.len() as u64 > MAX_ENCODED_BYTES {
        return Err(format!(
            "Sanitized SVG raster exceeds the {} MB encoded-byte limit",
            MAX_ENCODED_BYTES / 1024 / 1024
        ));
    }
    let digest = format!("{:x}", Sha256::digest(&raster.png_bytes));
    let relative_path = transform::cas_relative_path(&digest);
    transform::publish_cas_bytes(paths, &relative_path, &digest, &raster.png_bytes)?;
    let operation_json = serde_json::json!({
        "kind": "rasterize-svg",
        "sanitizerVersion": svg::SANITIZER_VERSION,
        "sourceDigest": staged.digest,
        "sourceByteSize": staged.byte_size,
        "xmlNodeCount": raster.xml_node_count,
        "hadText": raster.had_text,
        "resourcePolicy": "no-external-or-embedded-images",
        "fontPolicy": "system-font-snapshot",
        "outputColorSpace": "srgb",
    })
    .to_string();
    database::record_imported_asset(
        paths,
        database::ImportedAssetRegistration {
            digest: &digest,
            relative_path: &relative_path.to_string_lossy(),
            byte_size: raster.png_bytes.len() as u64,
            mime_type: "image/png",
            width: raster.width,
            height: raster.height,
            import_kind: database::LocalImportKind::RasterizedSvg {
                operation_json: &operation_json,
            },
        },
    )
}

struct StagedImage {
    path: PathBuf,
    digest: String,
    byte_size: u64,
}

struct ValidatedImage {
    mime_type: &'static str,
    width: u32,
    height: u32,
}

fn validate_source_path(source_path: &str) -> MediaResult<PathBuf> {
    if source_path.is_empty() || source_path.len() > 32_768 || source_path.contains('\0') {
        return Err("Image import path is invalid".to_string());
    }
    let source_path = PathBuf::from(source_path);
    let metadata = fs::symlink_metadata(&source_path)
        .map_err(|error| format!("failed to inspect selected image: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Selected image must be a regular file, not a link or device".to_string());
    }
    if metadata.len() == 0 {
        return Err("Selected image is empty".to_string());
    }
    if metadata.len() > MAX_ENCODED_BYTES {
        return Err(format!(
            "Selected image exceeds the {} MB encoded-byte limit",
            MAX_ENCODED_BYTES / 1024 / 1024
        ));
    }
    source_path
        .canonicalize()
        .map_err(|error| format!("failed to resolve selected image: {error}"))
}

fn stage_and_hash(paths: &MediaRuntimePaths, source_path: &Path) -> MediaResult<StagedImage> {
    let staging_directory = paths.blobs.join(".staging");
    fs::create_dir_all(&staging_directory)
        .map_err(|error| format!("failed to create image staging directory: {error}"))?;
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let staging_path =
        staging_directory.join(format!("import-{}-{unique}.partial", std::process::id()));

    let result = (|| -> MediaResult<StagedImage> {
        let mut source = File::open(source_path)
            .map_err(|error| format!("failed to open selected image: {error}"))?;
        let mut destination = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging_path)
            .map_err(|error| format!("failed to create image staging file: {error}"))?;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut byte_size = 0_u64;
        loop {
            let bytes_read = source
                .read(&mut buffer)
                .map_err(|error| format!("failed while reading selected image: {error}"))?;
            if bytes_read == 0 {
                break;
            }
            byte_size = byte_size.saturating_add(bytes_read as u64);
            if byte_size > MAX_ENCODED_BYTES {
                return Err(format!(
                    "Selected image changed while importing and now exceeds the {} MB limit",
                    MAX_ENCODED_BYTES / 1024 / 1024
                ));
            }
            digest.update(&buffer[..bytes_read]);
            destination
                .write_all(&buffer[..bytes_read])
                .map_err(|error| format!("failed while staging selected image: {error}"))?;
        }
        destination
            .sync_all()
            .map_err(|error| format!("failed to flush staged image: {error}"))?;
        Ok(StagedImage {
            path: staging_path.clone(),
            digest: format!("{:x}", digest.finalize()),
            byte_size,
        })
    })();

    if result.is_err() {
        let _ = fs::remove_file(&staging_path);
    }
    result
}

fn validate_staged_image(path: &Path) -> MediaResult<ValidatedImage> {
    let reader = ImageReader::open(path)
        .map_err(|error| format!("failed to inspect staged image: {error}"))?
        .with_guessed_format()
        .map_err(|error| format!("failed to identify staged image format: {error}"))?;
    let format = reader
        .format()
        .ok_or_else(|| "Selected file is not a recognized image".to_string())?;
    let mime_type = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => return Err("Only PNG, JPEG, and still WebP imports are supported".to_string()),
    };
    reject_animation(path, format)?;
    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| format!("failed to read selected image dimensions: {error}"))?;
    if width > MAX_DIMENSION || height > MAX_DIMENSION {
        return Err(format!(
            "Selected image dimensions {width}x{height} exceed the {MAX_DIMENSION}px per-axis limit"
        ));
    }
    let decoded_pixels = u64::from(width) * u64::from(height);
    if decoded_pixels > MAX_DECODED_PIXELS {
        return Err(format!(
            "Selected image has {decoded_pixels} decoded pixels; the limit is {MAX_DECODED_PIXELS}"
        ));
    }
    let mut decode_reader = ImageReader::open(path)
        .map_err(|error| format!("failed to reopen staged image: {error}"))?;
    decode_reader.set_format(format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    decode_reader.limits(limits);
    let decoded = decode_reader
        .decode()
        .map_err(|error| format!("selected image failed bounded decode validation: {error}"))?;
    if (decoded.width(), decoded.height()) != (width, height) {
        return Err("Selected image dimensions changed during decode validation".to_string());
    }
    Ok(ValidatedImage {
        mime_type,
        width,
        height,
    })
}

fn reject_animation(path: &Path, format: ImageFormat) -> MediaResult<()> {
    match format {
        ImageFormat::Png if png_has_animation(path)? => {
            Err("Animated PNG imports are not supported as still images".to_string())
        }
        ImageFormat::WebP if webp_has_animation(path)? => {
            Err("Animated WebP imports are not supported as still images".to_string())
        }
        _ => Ok(()),
    }
}

fn png_has_animation(path: &Path) -> MediaResult<bool> {
    let mut file = BufReader::new(
        File::open(path).map_err(|error| format!("failed to inspect PNG chunks: {error}"))?,
    );
    let mut signature = [0_u8; 8];
    file.read_exact(&mut signature)
        .map_err(|error| format!("failed to read PNG signature: {error}"))?;
    if signature != [137, 80, 78, 71, 13, 10, 26, 10] {
        return Ok(false);
    }
    loop {
        let mut header = [0_u8; 8];
        if file.read_exact(&mut header).is_err() {
            return Ok(false);
        }
        let chunk_size = u32::from_be_bytes(header[0..4].try_into().unwrap()) as u64;
        let chunk_type = &header[4..8];
        if chunk_type == b"acTL" {
            return Ok(true);
        }
        if chunk_type == b"IEND" {
            return Ok(false);
        }
        file.seek(SeekFrom::Current((chunk_size + 4) as i64))
            .map_err(|error| format!("failed to scan PNG chunks: {error}"))?;
    }
}

fn webp_has_animation(path: &Path) -> MediaResult<bool> {
    let mut file = BufReader::new(
        File::open(path).map_err(|error| format!("failed to inspect WebP chunks: {error}"))?,
    );
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|error| format!("failed to read WebP header: {error}"))?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WEBP" {
        return Ok(false);
    }
    loop {
        let mut chunk = [0_u8; 8];
        if file.read_exact(&mut chunk).is_err() {
            return Ok(false);
        }
        if &chunk[0..4] == b"ANIM" || &chunk[0..4] == b"ANMF" {
            return Ok(true);
        }
        let chunk_size = u32::from_le_bytes(chunk[4..8].try_into().unwrap()) as u64;
        let padded_size = chunk_size + (chunk_size % 2);
        file.seek(SeekFrom::Current(padded_size as i64))
            .map_err(|error| format!("failed to scan WebP chunks: {error}"))?;
    }
}

fn promote_to_cas(paths: &MediaRuntimePaths, staged: &StagedImage) -> MediaResult<PathBuf> {
    let relative_path = Path::new(&staged.digest[0..2])
        .join(&staged.digest[2..4])
        .join(&staged.digest);
    let destination = paths.blobs.join(&relative_path);
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create imported CAS shard: {error}"))?;
    }
    if destination.exists() {
        fs::remove_file(&staged.path)
            .map_err(|error| format!("failed to discard deduplicated staging file: {error}"))?;
        return Ok(relative_path);
    }
    match fs::rename(&staged.path, &destination) {
        Ok(()) => Ok(relative_path),
        Err(_) if destination.exists() => {
            let _ = fs::remove_file(&staged.path);
            Ok(relative_path)
        }
        Err(error) => Err(format!(
            "failed to atomically publish imported image: {error}"
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use image::{DynamicImage, Rgba, RgbaImage};

    use super::*;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "machdoch-ingest-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn detects_apng_animation_control_chunk() {
        let root = test_root("apng");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("animated.png");
        let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10];
        bytes.extend_from_slice(&8_u32.to_be_bytes());
        bytes.extend_from_slice(b"acTL");
        bytes.extend_from_slice(&[0; 12]);
        fs::write(&path, bytes).unwrap();
        assert!(png_has_animation(&path).unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn valid_png_is_streamed_validated_and_registered() {
        let root = test_root("png");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.png");
        let image = RgbaImage::from_pixel(80, 48, Rgba([12, 34, 56, 255]));
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

        let result = import_image(&paths, source.to_str().unwrap()).unwrap();
        let detail = &result.detail;

        assert_eq!(detail.run.status, "completed");
        assert_eq!(detail.run.executor, "local-import");
        assert_eq!(detail.assets.len(), 1);
        assert!(!detail.assets[0].fixture);
        assert_eq!((detail.assets[0].width, detail.assets[0].height), (80, 48));
        assert!(detail
            .events
            .iter()
            .any(|event| event.kind == "asset_imported"));
        let asset = &detail.assets[0];
        assert!(paths
            .blobs
            .join(&asset.digest[0..2])
            .join(&asset.digest[2..4])
            .join(&asset.digest)
            .exists());
        assert!(!result.deduplicated);

        let duplicate = import_image(&paths, source.to_str().unwrap()).unwrap();
        assert!(duplicate.deduplicated);
        assert_eq!(duplicate.asset.id, result.asset.id);
        assert_eq!(database::list_assets(&paths, 10).unwrap().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn svg_import_publishes_only_safe_png_with_source_digest_lineage() {
        let root = test_root("svg");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.svg");
        let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64">
          <rect width="96" height="64" rx="8" fill="#0ea5e9"/>
          <circle cx="48" cy="32" r="18" fill="#f8fafc"/>
        </svg>"##;
        fs::write(&source, svg).unwrap();
        let source_digest = format!("{:x}", Sha256::digest(svg.as_bytes()));
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();

        let result = import_image(&paths, source.to_str().unwrap()).unwrap();
        let detail = &result.detail;

        assert_eq!(detail.run.executor, "local-svg-raster");
        assert_eq!(detail.assets.len(), 1);
        let asset = &detail.assets[0];
        assert_eq!(asset.mime_type, "image/png");
        assert_eq!((asset.width, asset.height), (96, 64));
        assert_ne!(asset.digest, source_digest);
        let operation = asset.operation.as_ref().unwrap();
        assert_eq!(operation["kind"], "rasterize-svg");
        assert_eq!(operation["sourceDigest"], source_digest);
        assert_eq!(operation["sanitizerVersion"], svg::SANITIZER_VERSION);
        let published = fs::read(
            paths
                .blobs
                .join(&asset.digest[0..2])
                .join(&asset.digest[2..4])
                .join(&asset.digest),
        )
        .unwrap();
        assert_eq!(&published[..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
        assert!(!paths
            .blobs
            .join(&source_digest[0..2])
            .join(&source_digest[2..4])
            .join(&source_digest)
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejected_svg_does_not_publish_an_asset_or_active_markup() {
        let root = test_root("svg-script");
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.svg");
        fs::write(
            &source,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><script>alert(1)</script></svg>"#,
        )
        .unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();

        let error = import_image(&paths, source.to_str().unwrap()).unwrap_err();

        assert!(error.contains("<script>"));
        assert!(database::list_assets(&paths, 10).unwrap().is_empty());
        assert!(fs::read_dir(paths.blobs.join(".staging"))
            .unwrap()
            .next()
            .is_none());
        let _ = fs::remove_dir_all(root);
    }
}
