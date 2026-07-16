use std::{io::Cursor, path::Path, thread, time::Duration};

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use sha2::{Digest as _, Sha256};

use super::{
    database::{self, ClaimResult, FixtureExecution},
    MediaResult, MediaRuntimePaths,
};

pub(crate) fn execute_fixture_run(paths: &MediaRuntimePaths, run_id: &str) -> MediaResult<()> {
    let execution = loop {
        match database::claim_fixture_run(paths, run_id)? {
            ClaimResult::Claimed(execution) => break execution,
            ClaimResult::Terminal => return Ok(()),
            ClaimResult::LeaseBusy => thread::sleep(Duration::from_millis(120)),
        }
    };

    database::transition_nodes_by_type(
        paths,
        run_id,
        &["source.prompt", "source.image"],
        "completed",
        Some("fixture.resolve-inputs"),
        Some("Fixture inputs resolved"),
        Some(0.05),
    )?;
    database::transition_nodes_by_type(
        paths,
        run_id,
        &["task.generate-image", "task.edit-image"],
        "running",
        Some("fixture.generate"),
        Some("Generating deterministic fixture output"),
        Some(0.08),
    )?;

    for output_index in 0..execution.output_count {
        if database::is_output_published(paths, run_id, output_index)? {
            continue;
        }
        thread::sleep(Duration::from_millis(180));
        if database::is_cancellation_requested(paths, run_id)? {
            return database::cancel_run(paths, run_id);
        }
        generate_and_ingest(paths, run_id, &execution, output_index)?;
    }

    thread::sleep(Duration::from_millis(120));
    if database::is_cancellation_requested(paths, run_id)? {
        return database::cancel_run(paths, run_id);
    }
    database::transition_nodes_by_type(
        paths,
        run_id,
        &["task.generate-image", "task.edit-image"],
        "completed",
        Some("fixture.generate"),
        Some("Fixture outputs generated"),
        Some(0.94),
    )?;
    database::complete_run(paths, run_id)
}

fn generate_and_ingest(
    paths: &MediaRuntimePaths,
    run_id: &str,
    execution: &FixtureExecution,
    output_index: u32,
) -> MediaResult<()> {
    let (width, height) = dimensions(&execution.aspect_ratio);
    let bytes = render_fixture_png(&execution.prompt, output_index, width, height)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let relative_path = Path::new(&digest[0..2]).join(&digest[2..4]).join(&digest);
    let destination = paths.blobs.join(&relative_path);

    if !destination.exists() {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create CAS shard directory: {error}"))?;
        }
        crate::atomic_file::write_file_atomic(
            &destination,
            &bytes,
            crate::atomic_file::AtomicWriteOptions::default(),
        )
        .map_err(|error| format!("failed to publish fixture blob to CAS: {error}"))?;
    }

    database::record_asset(
        paths,
        &database::FixtureAssetRecord {
            run_id,
            digest: &digest,
            relative_path: &relative_path.to_string_lossy(),
            bytes: bytes.len() as u64,
            width,
            height,
            output_index,
            output_count: execution.output_count,
        },
    )
}

pub(crate) fn dimensions(aspect_ratio: &str) -> (u32, u32) {
    match aspect_ratio {
        "4:5" => (384, 480),
        "16:9" => (512, 288),
        "9:16" => (288, 512),
        _ => (384, 384),
    }
}

pub(crate) fn render_fixture_png(
    prompt: &str,
    output_index: u32,
    width: u32,
    height: u32,
) -> MediaResult<Vec<u8>> {
    let seed = Sha256::digest(format!("machdoch-fixture-v1\0{output_index}\0{prompt}").as_bytes());
    let mut image = RgbaImage::new(width, height);
    let accent = [seed[0], seed[1], seed[2]];
    let secondary = [seed[8], seed[9], seed[10]];

    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let x_mix = (x * 255 / width.max(1)) as u8;
        let y_mix = (y * 255 / height.max(1)) as u8;
        let checker = if ((x / 32) + (y / 32) + output_index).is_multiple_of(2) {
            20
        } else {
            0
        };
        *pixel = Rgba([
            accent[0].saturating_add(x_mix / 3).saturating_add(checker),
            secondary[1]
                .saturating_add(y_mix / 3)
                .saturating_add(checker),
            accent[2].saturating_add(x_mix.wrapping_add(y_mix) / 5),
            255,
        ]);
    }

    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|error| format!("failed to encode deterministic fixture PNG: {error}"))?;
    Ok(bytes.into_inner())
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;
    use crate::media::{database, EnqueueFixtureRunRequest, MediaRuntimePaths};

    fn test_paths(label: &str) -> MediaRuntimePaths {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-media-executor-{label}-{}-{unique}",
            std::process::id()
        ));
        MediaRuntimePaths {
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        }
    }

    fn request(run_id: &str) -> EnqueueFixtureRunRequest {
        EnqueueFixtureRunRequest {
            run_id: run_id.to_string(),
            flow_id: "flow-1".to_string(),
            flow_revision_id: None,
            flow_name: "Fixture".to_string(),
            plan_id: "plan-1".to_string(),
            prompt: "A deterministic fixture".to_string(),
            model_label: "Fixture executor".to_string(),
            target: Some("local".to_string()),
            output_count: 2,
            diagnostic_count: 0,
            aspect_ratio: "16:9".to_string(),
            plan_snapshot: None,
        }
    }

    #[test]
    fn fixture_output_is_deterministic_and_decodable() {
        let first = render_fixture_png("same prompt", 0, 64, 64).unwrap();
        let second = render_fixture_png("same prompt", 0, 64, 64).unwrap();
        assert_eq!(Sha256::digest(&first), Sha256::digest(&second));
        let decoded = image::load_from_memory_with_format(&first, ImageFormat::Png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (64, 64));
    }

    #[test]
    fn fixture_executor_publishes_verified_cas_assets() {
        let paths = test_paths("cas");
        database::ensure_initialized(&paths).unwrap();
        database::enqueue_fixture_run(&paths, &request("run-cas")).unwrap();

        execute_fixture_run(&paths, "run-cas").unwrap();

        let detail = database::get_run_detail(&paths, "run-cas").unwrap();
        assert_eq!(detail.run.status, "completed");
        assert_eq!(detail.assets.len(), 2);
        for asset in &detail.assets {
            let blob = paths
                .blobs
                .join(&asset.digest[0..2])
                .join(&asset.digest[2..4])
                .join(&asset.digest);
            let bytes = std::fs::read(blob).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), asset.digest);
            image::load_from_memory_with_format(&bytes, ImageFormat::Png).unwrap();
        }

        if let Some(root) = paths.database.parent() {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn retry_reuses_a_previously_published_partial_output() {
        let paths = test_paths("retry");
        database::ensure_initialized(&paths).unwrap();
        database::enqueue_fixture_run(&paths, &request("run-retry")).unwrap();
        let execution = match database::claim_fixture_run(&paths, "run-retry").unwrap() {
            ClaimResult::Claimed(execution) => execution,
            _ => panic!("fixture run was not claimed"),
        };
        generate_and_ingest(&paths, "run-retry", &execution, 0).unwrap();
        database::cancel_run(&paths, "run-retry").unwrap();
        database::retry_fixture_run(&paths, "run-retry").unwrap();

        execute_fixture_run(&paths, "run-retry").unwrap();

        let detail = database::get_run_detail(&paths, "run-retry").unwrap();
        assert_eq!(detail.run.status, "completed");
        assert_eq!(detail.assets.len(), 2);
        assert_eq!(
            detail
                .events
                .iter()
                .filter(|event| event.kind == "asset_published")
                .count(),
            2
        );
        assert!(detail
            .events
            .iter()
            .any(|event| event.kind == "retry_queued"));

        if let Some(root) = paths.database.parent() {
            let _ = std::fs::remove_dir_all(root);
        }
    }
}
