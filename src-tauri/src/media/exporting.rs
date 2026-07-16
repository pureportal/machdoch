use std::{fs, path::PathBuf};

use image::{
    codecs::{
        jpeg::JpegEncoder,
        png::{CompressionType, FilterType, PngEncoder},
        webp::WebPEncoder,
    },
    DynamicImage, ExtendedColorType, GenericImageView as _, ImageEncoder as _, ImageFormat,
};
use sha2::{Digest as _, Sha256};

use super::{
    database, transform, MediaAssetExportMode, MediaAssetExportRecord, MediaAssetExportRequest,
    MediaResult, MediaRuntimePaths,
};

const MAX_EXPORT_BYTES: usize = 64 * 1024 * 1024;
const PRIVACY_JPEG_QUALITY: u8 = 95;

pub(crate) fn export_asset(
    paths: &MediaRuntimePaths,
    request: &MediaAssetExportRequest,
) -> MediaResult<MediaAssetExportRecord> {
    let (source, original_bytes) = transform::read_asset_original(paths, &request.asset_id)?;
    let destination = validate_destination(&request.destination_path, &source.mime_type)?;
    let output = prepare_export(&source.mime_type, request.mode, original_bytes)?;
    let destination_display = destination.to_string_lossy().into_owned();
    let record = database::begin_asset_export(
        paths,
        &request.asset_id,
        &destination_display,
        request.mode,
        &source.digest,
        &output.digest,
        output.bytes.len() as u64,
    )?;

    let result = (|| -> MediaResult<()> {
        crate::atomic_file::write_file_atomic(
            &destination,
            &output.bytes,
            crate::atomic_file::AtomicWriteOptions::default(),
        )
        .map_err(|error| format!("failed to atomically export media asset: {error}"))?;
        let exported = fs::read(&destination)
            .map_err(|error| format!("failed to verify exported media asset: {error}"))?;
        if exported.len() != output.bytes.len() {
            return Err("exported media asset byte size did not match prepared output".to_string());
        }
        if format!("{:x}", Sha256::digest(&exported)) != output.digest {
            return Err("exported media asset failed SHA-256 verification".to_string());
        }
        if let Some(expected_pixels) = output.expected_pixels.as_ref() {
            verify_reencoded_output(&exported, &source.mime_type, expected_pixels)?;
        }
        database::complete_asset_export(paths, &record)
    })();

    if let Err(error) = result {
        let _ = database::fail_asset_export(paths, &record.id, &error);
        return Err(error);
    }
    Ok(record)
}

struct PreparedExport {
    bytes: Vec<u8>,
    digest: String,
    expected_pixels: Option<DynamicImage>,
}

fn prepare_export(
    mime_type: &str,
    mode: MediaAssetExportMode,
    original_bytes: Vec<u8>,
) -> MediaResult<PreparedExport> {
    let (bytes, expected_pixels) = match mode {
        MediaAssetExportMode::VerifiedOriginal => (original_bytes, None),
        MediaAssetExportMode::MetadataStripped => {
            if mime_type == "image/svg+xml" {
                return Err(
                    "SVG assets are already Secure Static canonical documents; metadata-stripped export is raster-only"
                        .to_string(),
                );
            }
            let image = transform::decode_image_bytes(&original_bytes)?;
            let encoded = encode_without_metadata(&image, mime_type)?;
            (encoded, Some(image))
        }
    };
    if bytes.is_empty() || bytes.len() > MAX_EXPORT_BYTES {
        return Err(format!(
            "Prepared export exceeds the {} MB encoded-byte limit",
            MAX_EXPORT_BYTES / 1024 / 1024
        ));
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    Ok(PreparedExport {
        bytes,
        digest,
        expected_pixels,
    })
}

fn encode_without_metadata(image: &DynamicImage, mime_type: &str) -> MediaResult<Vec<u8>> {
    let mut encoded = Vec::new();
    match mime_type {
        "image/png" => {
            let rgba = image.to_rgba8();
            PngEncoder::new_with_quality(
                &mut encoded,
                CompressionType::Default,
                FilterType::Adaptive,
            )
            .write_image(
                rgba.as_raw(),
                rgba.width(),
                rgba.height(),
                ExtendedColorType::Rgba8,
            )
            .map_err(|error| format!("failed to encode metadata-stripped PNG: {error}"))?;
        }
        "image/jpeg" => {
            let rgb = image.to_rgb8();
            JpegEncoder::new_with_quality(&mut encoded, PRIVACY_JPEG_QUALITY)
                .encode(
                    rgb.as_raw(),
                    rgb.width(),
                    rgb.height(),
                    ExtendedColorType::Rgb8,
                )
                .map_err(|error| format!("failed to encode metadata-stripped JPEG: {error}"))?;
        }
        "image/webp" => {
            let rgba = image.to_rgba8();
            WebPEncoder::new_lossless(&mut encoded)
                .write_image(
                    rgba.as_raw(),
                    rgba.width(),
                    rgba.height(),
                    ExtendedColorType::Rgba8,
                )
                .map_err(|error| format!("failed to encode metadata-stripped WebP: {error}"))?;
        }
        _ => {
            return Err(format!(
                "Metadata-stripped export does not support {mime_type}"
            ));
        }
    }
    Ok(encoded)
}

fn verify_reencoded_output(
    bytes: &[u8],
    mime_type: &str,
    expected_pixels: &DynamicImage,
) -> MediaResult<()> {
    let format = match mime_type {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::WebP,
        _ => return Err(format!("Cannot verify export format {mime_type}")),
    };
    let decoded = image::load_from_memory_with_format(bytes, format)
        .map_err(|error| format!("metadata-stripped export failed decode verification: {error}"))?;
    if decoded.dimensions() != expected_pixels.dimensions() {
        return Err("metadata-stripped export dimensions changed during encoding".to_string());
    }
    if mime_type != "image/jpeg" && decoded.to_rgba8() != expected_pixels.to_rgba8() {
        return Err("lossless metadata-stripped export changed decoded pixels".to_string());
    }
    Ok(())
}

fn validate_destination(destination_path: &str, mime_type: &str) -> MediaResult<PathBuf> {
    if destination_path.is_empty()
        || destination_path.len() > 32_768
        || destination_path.contains('\0')
    {
        return Err("Asset export destination is invalid".to_string());
    }
    let requested = PathBuf::from(destination_path);
    if !requested.is_absolute() {
        return Err("Asset export destination must be an absolute path".to_string());
    }
    let file_name = requested
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "Asset export destination requires a file name".to_string())?;
    let extension = requested
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "Asset export destination requires a supported extension".to_string())?;
    let extension_matches = match mime_type {
        "image/png" => extension == "png",
        "image/jpeg" => matches!(extension.as_str(), "jpg" | "jpeg"),
        "image/webp" => extension == "webp",
        "image/svg+xml" => extension == "svg",
        _ => false,
    };
    if !extension_matches {
        return Err(format!(
            "Asset export extension .{extension} does not match {mime_type}"
        ));
    }
    let parent = requested
        .parent()
        .ok_or_else(|| "Asset export destination requires a parent directory".to_string())?;
    let parent_metadata = fs::metadata(parent)
        .map_err(|error| format!("failed to inspect asset export directory: {error}"))?;
    if !parent_metadata.is_dir() {
        return Err("Asset export parent must be a directory".to_string());
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("failed to resolve asset export directory: {error}"))?;
    let destination = canonical_parent.join(file_name);
    if let Ok(metadata) = fs::symlink_metadata(&destination) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("Existing export destination must be a regular file".to_string());
        }
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Cursor,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};

    use super::*;
    use crate::media::ingest;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "machdoch-export-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn imported_asset(label: &str) -> (PathBuf, MediaRuntimePaths, String, Vec<u8>) {
        let root = test_root(label);
        fs::create_dir_all(&root).unwrap();
        let source_path = root.join("source.png");
        let image = RgbaImage::from_pixel(48, 32, Rgba([20, 80, 140, 255]));
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        let source_bytes = encoded.into_inner();
        fs::write(&source_path, &source_bytes).unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let imported = ingest::import_image(&paths, source_path.to_str().unwrap()).unwrap();
        (root, paths, imported.asset.id, source_bytes)
    }

    fn request(
        asset_id: &str,
        destination: &Path,
        mode: MediaAssetExportMode,
    ) -> MediaAssetExportRequest {
        MediaAssetExportRequest {
            asset_id: asset_id.to_string(),
            destination_path: destination.to_string_lossy().into_owned(),
            mode,
        }
    }

    fn imported_oriented_jpeg(label: &str) -> (PathBuf, MediaRuntimePaths, String, Vec<u8>) {
        let root = test_root(label);
        fs::create_dir_all(&root).unwrap();
        let source_path = root.join("source.jpg");
        let image = RgbaImage::from_pixel(48, 32, Rgba([20, 80, 140, 255]));
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, ImageFormat::Jpeg)
            .unwrap();
        let encoded = encoded.into_inner();

        // A valid little-endian Exif payload with orientation 6 (rotate 90°).
        let exif = [
            b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1,
            0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ];
        let segment_length = u16::try_from(exif.len() + 2).unwrap().to_be_bytes();
        let mut source_bytes = Vec::with_capacity(encoded.len() + exif.len() + 4);
        source_bytes.extend_from_slice(&encoded[..2]);
        source_bytes.extend_from_slice(&[0xff, 0xe1]);
        source_bytes.extend_from_slice(&segment_length);
        source_bytes.extend_from_slice(&exif);
        source_bytes.extend_from_slice(&encoded[2..]);
        fs::write(&source_path, &source_bytes).unwrap();

        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let imported = ingest::import_image(&paths, source_path.to_str().unwrap()).unwrap();
        (root, paths, imported.asset.id, source_bytes)
    }

    #[test]
    fn export_copies_verified_original_and_records_audit_event() {
        let (root, paths, asset_id, source_bytes) = imported_asset("success");
        let destination = root.join("exported.png");

        let record = export_asset(
            &paths,
            &request(
                &asset_id,
                &destination,
                MediaAssetExportMode::VerifiedOriginal,
            ),
        )
        .unwrap();

        assert_eq!(record.asset_id, asset_id);
        assert_eq!(record.mode, MediaAssetExportMode::VerifiedOriginal);
        assert_eq!(record.source_digest, record.digest);
        assert!(!record.metadata_stripped);
        assert_eq!(fs::read(&destination).unwrap(), source_bytes);
        let run_id = database::list_assets(&paths, 1).unwrap()[0].run_id.clone();
        let detail = database::get_run_detail(&paths, &run_id).unwrap();
        assert!(detail
            .events
            .iter()
            .any(|event| event.kind == "asset_exported"));
        let connection = rusqlite::Connection::open(&paths.database).unwrap();
        let status: String = connection
            .query_row(
                "SELECT status FROM asset_exports WHERE id = ?1",
                rusqlite::params![record.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "completed");
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_stripped_export_applies_orientation_and_retains_local_source_lineage() {
        let (root, paths, asset_id, source_bytes) = imported_oriented_jpeg("privacy");
        let destination = root.join("privacy-export.jpg");

        let record = export_asset(
            &paths,
            &request(
                &asset_id,
                &destination,
                MediaAssetExportMode::MetadataStripped,
            ),
        )
        .unwrap();

        let exported = fs::read(&destination).unwrap();
        assert!(source_bytes.windows(6).any(|window| window == b"Exif\0\0"));
        assert!(!exported.windows(6).any(|window| window == b"Exif\0\0"));
        let decoded = image::load_from_memory_with_format(&exported, ImageFormat::Jpeg).unwrap();
        assert_eq!(decoded.dimensions(), (32, 48));
        assert_eq!(record.mode, MediaAssetExportMode::MetadataStripped);
        assert!(record.metadata_stripped);
        assert_ne!(record.source_digest, record.digest);

        let connection = rusqlite::Connection::open(&paths.database).unwrap();
        let audit: (String, String, bool) = connection
            .query_row(
                "SELECT mode, source_digest, metadata_stripped FROM asset_exports WHERE id = ?1",
                rusqlite::params![record.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(audit.0, "metadata-stripped");
        assert_eq!(audit.1, record.source_digest);
        assert!(audit.2);
        let source = database::get_asset_blob_source(&paths, &asset_id).unwrap();
        assert_eq!(source.digest, record.source_digest);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn export_rejects_extension_that_misrepresents_original_bytes() {
        let (root, paths, asset_id, _) = imported_asset("extension");
        let destination = root.join("misleading.jpg");

        let error = export_asset(
            &paths,
            &request(
                &asset_id,
                &destination,
                MediaAssetExportMode::VerifiedOriginal,
            ),
        )
        .unwrap_err();

        assert!(error.contains("does not match image/png"));
        assert!(!Path::new(&destination).exists());
        fs::remove_dir_all(root).unwrap();
    }
}
