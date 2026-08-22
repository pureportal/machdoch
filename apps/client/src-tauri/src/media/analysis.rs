use sha2::{Digest as _, Sha256};

use super::{
    database, transform, MediaQualityAnalysisResult, MediaQualityObservation,
    MediaQualityProfileReference, MediaQualityReport, MediaResult, MediaRuntimePaths,
};

const PROFILE_ID: &str = "technical-image-baseline";
const PROFILE_VERSION: &str = "1.0.0";
const PREPROCESSING_PROFILE_ID: &str = "srgb-encoded-rgba-unassociated-v1";

pub(crate) fn analyze_image(
    paths: &MediaRuntimePaths,
    source_asset_id: &str,
) -> MediaResult<MediaQualityAnalysisResult> {
    let (source, image) = transform::read_asset_image(paths, source_asset_id)?;
    let width = image.width();
    let height = image.height();
    let rgba = image.into_rgba8();
    let pixel_count = u64::from(width) * u64::from(height);
    if pixel_count == 0 {
        return Err("quality analysis source has no pixels".to_string());
    }

    let mut luminance_sum = 0_f64;
    let mut luminance_squared_sum = 0_f64;
    let mut clipped_black = 0_u64;
    let mut clipped_white = 0_u64;
    let mut non_opaque = 0_u64;
    let mut transparent = 0_u64;
    let mut gradient_sum = 0_u64;
    let mut gradient_edges = 0_u64;
    let mut previous_row = vec![0_u8; width as usize];

    for y in 0..height {
        let mut previous_column = None;
        for x in 0..width {
            let pixel = rgba.get_pixel(x, y);
            let luminance = ((54_u32 * u32::from(pixel[0])
                + 183_u32 * u32::from(pixel[1])
                + 19_u32 * u32::from(pixel[2])
                + 128)
                >> 8) as u8;
            let luminance_f64 = f64::from(luminance);
            luminance_sum += luminance_f64;
            luminance_squared_sum += luminance_f64 * luminance_f64;
            clipped_black += u64::from(luminance <= 5);
            clipped_white += u64::from(luminance >= 250);
            non_opaque += u64::from(pixel[3] < 255);
            transparent += u64::from(pixel[3] == 0);
            if let Some(left) = previous_column {
                gradient_sum += u64::from(luminance.abs_diff(left));
                gradient_edges += 1;
            }
            if y > 0 {
                gradient_sum += u64::from(luminance.abs_diff(previous_row[x as usize]));
                gradient_edges += 1;
            }
            previous_row[x as usize] = luminance;
            previous_column = Some(luminance);
        }
    }

    let count = pixel_count as f64;
    let mean_raw = luminance_sum / count;
    let variance_raw = (luminance_squared_sum / count - mean_raw * mean_raw).max(0.0);
    let mean = round_metric(mean_raw / 255.0);
    let standard_deviation = round_metric(variance_raw.sqrt() / 255.0);
    let clipped_black_ratio = round_metric(clipped_black as f64 / count);
    let clipped_white_ratio = round_metric(clipped_white as f64 / count);
    let non_opaque_ratio = round_metric(non_opaque as f64 / count);
    let transparent_ratio = round_metric(transparent as f64 / count);
    let mean_gradient = if gradient_edges == 0 {
        0.0
    } else {
        round_metric(gradient_sum as f64 / gradient_edges as f64 / 255.0)
    };
    let encoded_bytes_per_pixel = round_metric(source.byte_size as f64 / count);

    let mut verdict = "pass";
    let mut gate_reasons = Vec::new();
    let minimum_axis = width.min(height);
    if minimum_axis < 128 {
        verdict = "fail";
        gate_reasons.push(format!(
            "Minimum axis {minimum_axis}px is below the profile's 128px hard floor."
        ));
    } else if minimum_axis < 512 {
        verdict = "warn";
        gate_reasons.push(format!(
            "Minimum axis {minimum_axis}px is below the profile's 512px review threshold."
        ));
    }
    if standard_deviation < 0.02 {
        if verdict == "pass" {
            verdict = "warn";
        }
        gate_reasons.push(
            "Luminance variation is below 0.02; blank or intentionally flat imagery requires review."
                .to_string(),
        );
    }
    if clipped_black_ratio > 0.5 {
        if verdict == "pass" {
            verdict = "warn";
        }
        gate_reasons.push(
            "More than half of pixels are near black under the pinned luma preprocessing profile."
                .to_string(),
        );
    }
    if clipped_white_ratio > 0.5 {
        if verdict == "pass" {
            verdict = "warn";
        }
        gate_reasons.push(
            "More than half of pixels are near white under the pinned luma preprocessing profile."
                .to_string(),
        );
    }
    if gate_reasons.is_empty() {
        gate_reasons.push("All configured deterministic gate expressions passed.".to_string());
    }

    let input_ids = vec![source_asset_id.to_string()];
    let mut observations = vec![
        observed(
            "decode.valid",
            serde_json::json!(true),
            Some("categorical"),
            &input_ids,
            Vec::new(),
        ),
        observed(
            "dimensions.exact",
            serde_json::json!({
                "width": width,
                "height": height,
                "pixels": pixel_count,
            }),
            Some("categorical"),
            &input_ids,
            Vec::new(),
        ),
        observed(
            "format.detected",
            serde_json::json!(source.mime_type),
            Some("categorical"),
            &input_ids,
            vec!["Format is detected from bounded decoded bytes, not the file name.".to_string()],
        ),
        observed_metric(
            "alpha.nonOpaqueRatio",
            non_opaque_ratio,
            "ratio",
            "categorical",
            &input_ids,
            vec!["This measures alpha occupancy, not matte edge quality.".to_string()],
        ),
        observed_metric(
            "alpha.fullyTransparentRatio",
            transparent_ratio,
            "ratio",
            "categorical",
            &input_ids,
            vec!["RGB values underneath fully transparent pixels are not evaluated.".to_string()],
        ),
        observed_metric(
            "luma.mean",
            mean,
            "normalized-srgb-luma",
            "target-range",
            &input_ids,
            vec!["Luma is measured in encoded RGB and is not a color-managed scene-linear value.".to_string()],
        ),
        observed_metric(
            "luma.standardDeviation",
            standard_deviation,
            "normalized-srgb-luma",
            "higher-is-better",
            &input_ids,
            vec!["Low variation may be intentional; this metric can only trigger review.".to_string()],
        ),
        observed_metric(
            "luma.clippedBlackRatio",
            clipped_black_ratio,
            "ratio",
            "lower-is-better",
            &input_ids,
            vec!["Near-black is defined as encoded luma <= 5/255 for this profile.".to_string()],
        ),
        observed_metric(
            "luma.clippedWhiteRatio",
            clipped_white_ratio,
            "ratio",
            "lower-is-better",
            &input_ids,
            vec!["Near-white is defined as encoded luma >= 250/255 for this profile.".to_string()],
        ),
        observed_metric(
            "detail.meanAbsoluteGradient",
            mean_gradient,
            "normalized-neighbor-difference",
            "higher-is-better",
            &input_ids,
            vec![
                "This deterministic edge-energy observation is not a calibrated blur score and does not gate the asset."
                    .to_string(),
            ],
        ),
        observed_metric(
            "compression.encodedBytesPerPixel",
            encoded_bytes_per_pixel,
            "bytes-per-pixel",
            "categorical",
            &input_ids,
            vec![
                "Encoded density depends on content and codec; it is retained for comparison but not gated."
                    .to_string(),
            ],
        ),
    ];
    observations.push(MediaQualityObservation {
        metric_id: "color.embeddedProfile".to_string(),
        metric_version: "1.0.0".to_string(),
        family: "technical".to_string(),
        scope: "asset".to_string(),
        status: "unknown".to_string(),
        value: None,
        unit: None,
        direction: Some("categorical".to_string()),
        input_asset_ids: input_ids,
        reference_asset_ids: Vec::new(),
        evaluator: None,
        preprocessing_profile_id: PREPROCESSING_PROFILE_ID.to_string(),
        sampling_profile_id: None,
        calibration_profile_id: None,
        confidence: None,
        limitations: vec![
            "The current image decoder does not expose a verified embedded ICC profile to this analyzer."
                .to_string(),
        ],
    });

    let report = MediaQualityReport {
        schema_version: 1,
        source_asset_id: source_asset_id.to_string(),
        analyzed_at: database::now(),
        profile: MediaQualityProfileReference {
            id: PROFILE_ID.to_string(),
            version: PROFILE_VERSION.to_string(),
            description: "Deterministic decode, dimensions, alpha, encoded-luma clipping, variation, edge energy, and encoded-density observations. Only explicit dimension and clipping expressions gate; no aggregate quality score is produced.".to_string(),
        },
        verdict: verdict.to_string(),
        gate_reasons,
        observations,
    };
    let encoded = serde_json::to_vec_pretty(&report)
        .map_err(|error| format!("failed to encode quality report: {error}"))?;
    let digest = format!("{:x}", Sha256::digest(&encoded));
    let relative_path = transform::cas_relative_path(&digest);
    transform::publish_cas_bytes(paths, &relative_path, &digest, &encoded)?;
    let detail = database::record_quality_report(
        paths,
        source_asset_id,
        &digest,
        &relative_path.to_string_lossy(),
        encoded.len() as u64,
        &report,
    )?;
    Ok(MediaQualityAnalysisResult { detail, report })
}

pub(crate) fn read_quality_report(
    paths: &MediaRuntimePaths,
    report_asset_id: &str,
) -> MediaResult<MediaQualityReport> {
    let (source, bytes) = transform::read_asset_original(paths, report_asset_id)?;
    if source.mime_type != "application/json" {
        return Err(format!(
            "media asset {report_asset_id} is not a quality report"
        ));
    }
    let report = serde_json::from_slice::<MediaQualityReport>(&bytes)
        .map_err(|error| format!("quality report JSON is invalid: {error}"))?;
    if report.schema_version != 1 || report.profile.id != PROFILE_ID {
        return Err("quality report uses an unsupported schema or profile".to_string());
    }
    Ok(report)
}

fn observed_metric(
    metric_id: &str,
    value: f64,
    unit: &str,
    direction: &str,
    input_asset_ids: &[String],
    limitations: Vec<String>,
) -> MediaQualityObservation {
    let mut observation = observed(
        metric_id,
        serde_json::json!(value),
        Some(direction),
        input_asset_ids,
        limitations,
    );
    observation.unit = Some(unit.to_string());
    observation
}

fn observed(
    metric_id: &str,
    value: serde_json::Value,
    direction: Option<&str>,
    input_asset_ids: &[String],
    limitations: Vec<String>,
) -> MediaQualityObservation {
    MediaQualityObservation {
        metric_id: metric_id.to_string(),
        metric_version: "1.0.0".to_string(),
        family: "technical".to_string(),
        scope: "asset".to_string(),
        status: "observed".to_string(),
        value: Some(value),
        unit: None,
        direction: direction.map(str::to_string),
        input_asset_ids: input_asset_ids.to_vec(),
        reference_asset_ids: Vec::new(),
        evaluator: None,
        preprocessing_profile_id: PREPROCESSING_PROFILE_ID.to_string(),
        sampling_profile_id: None,
        calibration_profile_id: None,
        confidence: None,
        limitations,
    }
}

fn round_metric(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Cursor,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};

    use super::*;
    use crate::media::ingest;

    fn test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "machdoch-analysis-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn imported_asset(
        label: &str,
        width: u32,
        height: u32,
    ) -> (PathBuf, MediaRuntimePaths, String) {
        let root = test_root(label);
        fs::create_dir_all(&root).unwrap();
        let source_path = root.join("source.png");
        let image = RgbaImage::from_fn(width, height, |x, y| {
            let value = 24 + ((x + y) % 200) as u8;
            Rgba([
                value,
                value.saturating_add(8),
                value.saturating_add(16),
                255,
            ])
        });
        let mut encoded = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut encoded, ImageFormat::Png)
            .unwrap();
        fs::write(&source_path, encoded.into_inner()).unwrap();
        let paths = MediaRuntimePaths {
            database: root.join("runtime").join("media.sqlite3"),
            blobs: root.join("runtime").join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let imported = ingest::import_image(&paths, source_path.to_str().unwrap()).unwrap();
        (root, paths, imported.asset.id)
    }

    #[test]
    fn analysis_publishes_immutable_report_with_source_lineage() {
        let (root, paths, source_asset_id) = imported_asset("pass", 640, 640);

        let result = analyze_image(&paths, &source_asset_id).unwrap();

        assert_eq!(result.report.schema_version, 1);
        assert_eq!(result.report.verdict, "pass");
        assert!(result.report.observations.len() >= 10);
        assert_eq!(result.detail.run.executor, "local-analysis");
        assert_eq!(result.detail.assets[0].kind, "report");
        assert_eq!(result.detail.assets[0].mime_type, "application/json");
        assert_eq!(
            result.detail.assets[0].source_asset_ids,
            vec![source_asset_id]
        );
        let round_trip = read_quality_report(&paths, &result.detail.assets[0].id).unwrap();
        assert_eq!(round_trip.profile.id, PROFILE_ID);
        assert_eq!(
            round_trip.observations.len(),
            result.report.observations.len()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn undersized_source_fails_explicit_dimension_gate() {
        let (root, paths, source_asset_id) = imported_asset("small", 64, 96);

        let result = analyze_image(&paths, &source_asset_id).unwrap();

        assert_eq!(result.report.verdict, "fail");
        assert!(result.report.gate_reasons[0].contains("128px hard floor"));
        fs::remove_dir_all(root).unwrap();
    }
}
