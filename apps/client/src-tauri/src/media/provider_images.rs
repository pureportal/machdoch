use std::io::Cursor;

use image::{ImageFormat, ImageReader, Limits};
use sha2::{Digest as _, Sha256};

use super::{
    subject_cutout::{self, SubjectCutoutSummary},
    transform, MediaResult, MediaRuntimePaths,
};

pub(crate) const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

pub(super) fn is_remote_image_model(model_id: &str) -> bool {
    matches!(
        model_id,
        "openai:gpt-image-2.5-sunburst" | super::provider_codex::MODEL_ID
    )
}

#[derive(Debug)]
pub(crate) struct GeneratedImageAsset {
    pub(crate) digest: String,
    pub(crate) relative_path: String,
    pub(crate) byte_size: u64,
    pub(crate) mime_type: &'static str,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) output_index: u32,
    pub(crate) subject_cutout: Option<SubjectCutoutSummary>,
}

#[derive(Debug)]
pub(crate) struct GeneratedImageBatch {
    pub(crate) assets: Vec<GeneratedImageAsset>,
    pub(crate) provider_request_id: Option<String>,
}

#[derive(Debug)]
pub(crate) struct ImageGenerationFailure {
    pub(crate) diagnostic: String,
    pub(crate) acceptance_unknown: bool,
    pub(crate) provider_request_id: Option<String>,
}

impl ImageGenerationFailure {
    pub(crate) fn rejected(diagnostic: String, provider_request_id: Option<String>) -> Self {
        Self {
            diagnostic,
            acceptance_unknown: false,
            provider_request_id,
        }
    }

    pub(crate) fn unknown(diagnostic: String, provider_request_id: Option<String>) -> Self {
        Self {
            diagnostic,
            acceptance_unknown: true,
            provider_request_id,
        }
    }
}

pub(crate) struct ValidatedImage {
    pub(crate) mime_type: &'static str,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn validate_image(
    bytes: &[u8],
    output_format: &str,
    output_index: usize,
) -> MediaResult<ValidatedImage> {
    let expected_format = match output_format {
        "png" => ImageFormat::Png,
        "jpeg" => ImageFormat::Jpeg,
        "webp" => ImageFormat::WebP,
        _ => return Err("Image output format is not supported".to_string()),
    };
    let guessed = image::guess_format(bytes).map_err(|error| {
        format!(
            "Image output {} is not a recognized image: {error}",
            output_index + 1
        )
    })?;
    if guessed != expected_format {
        return Err(format!(
            "Image output {} did not match the requested format",
            output_index + 1
        ));
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), expected_format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(3_840);
    limits.max_image_height = Some(3_840);
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|error| {
        format!(
            "Image output {} failed bounded decode: {error}",
            output_index + 1
        )
    })?;
    let (width, height) = (decoded.width(), decoded.height());
    if width == 0 || height == 0 {
        return Err(format!(
            "Image output {} has invalid dimensions",
            output_index + 1
        ));
    }
    Ok(ValidatedImage {
        mime_type: match expected_format {
            ImageFormat::Png => "image/png",
            ImageFormat::Jpeg => "image/jpeg",
            ImageFormat::WebP => "image/webp",
            _ => unreachable!(),
        },
        width,
        height,
    })
}

pub(crate) async fn publish_image(
    paths: &MediaRuntimePaths,
    mut bytes: Vec<u8>,
    output_format: &str,
    index: usize,
    transparent_background: bool,
    subject_cutout_model_priority: &[String],
) -> MediaResult<GeneratedImageAsset> {
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "Image output {} has an invalid encoded size",
            index + 1
        ));
    }
    validate_image(&bytes, output_format, index)?;
    let subject_cutout = if transparent_background {
        let cutout_paths = paths.clone();
        let cutout_source = std::mem::take(&mut bytes);
        let cutout_format = output_format.to_string();
        let model_priority = subject_cutout_model_priority.to_vec();
        let transparent = tauri::async_runtime::spawn_blocking(move || {
            subject_cutout::cutout_encoded(
                &cutout_paths,
                &cutout_source,
                &cutout_format,
                &model_priority,
            )
        })
        .await
        .map_err(|error| {
            format!(
                "Image output {} subject cutout worker failed: {error}",
                index + 1
            )
        })??;
        bytes = transparent.bytes;
        Some(transparent.summary)
    } else {
        None
    };
    let validated = validate_image(&bytes, output_format, index)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let relative_path = transform::cas_relative_path(&digest);
    transform::publish_cas_bytes(paths, &relative_path, &digest, &bytes)?;
    Ok(GeneratedImageAsset {
        digest,
        relative_path: relative_path.to_string_lossy().into_owned(),
        byte_size: bytes.len() as u64,
        mime_type: validated.mime_type,
        width: validated.width,
        height: validated.height,
        output_index: index as u32,
        subject_cutout,
    })
}
