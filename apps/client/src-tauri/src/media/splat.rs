use serde::Deserialize;
use tauri::{AppHandle, Manager as _};

use super::{
    database, provider_local_diffusers, transform, MediaCommandResult, MediaResult,
    MediaRunDetail, MediaRunPlanSnapshot, MediaRuntimePaths, MediaRuntimeState,
};

pub(crate) const SPLAT_MIME_TYPE: &str = "model/x-ply";
pub(crate) const SPLAT_PREVIEW_PROFILE: &str = "splat-render-v1";
pub(crate) const MAX_SPLAT_BYTES: u64 = 80 * 1024 * 1024;
pub(crate) const PLY_PROPERTIES: [&str; 17] = [
    "x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0",
    "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GenerateMediaSplatRequest {
    pub(crate) schema_version: u32,
    pub(crate) run_id: String,
    pub(crate) flow_id: String,
    pub(crate) flow_revision_id: String,
    pub(crate) flow_name: String,
    pub(crate) plan_id: String,
    pub(crate) model_id: String,
    pub(crate) model_label: String,
    pub(crate) source_asset_id: String,
    pub(crate) input_kind: String,
    pub(crate) gaussian_count: u32,
    pub(crate) num_inference_steps: u32,
    pub(crate) guidance_scale: f64,
    pub(crate) time_shift: f64,
    pub(crate) min_opacity: f64,
    pub(crate) seed: u64,
    pub(crate) diagnostic_count: u32,
    pub(crate) plan_snapshot: MediaRunPlanSnapshot,
}

impl GenerateMediaSplatRequest {
    pub(super) fn validate_values(&mut self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("3D generation requires schemaVersion 1".into());
        }
        for (label, value, limit) in [
            ("runId", &mut self.run_id, 128),
            ("flowId", &mut self.flow_id, 128),
            ("flowRevisionId", &mut self.flow_revision_id, 128),
            ("flowName", &mut self.flow_name, 256),
            ("planId", &mut self.plan_id, 128),
            ("modelId", &mut self.model_id, 128),
            ("modelLabel", &mut self.model_label, 256),
            ("sourceAssetId", &mut self.source_asset_id, 256),
        ] {
            *value = super::required_text(label, value, limit)?;
        }
        if !matches!(self.input_kind.as_str(), "synthetic" | "real") {
            return Err("Choose whether the image is a render or a photo.".into());
        }
        if !(32_768..=1_048_576).contains(&self.gaussian_count)
            || self.gaussian_count % 32 != 0
            || !(4..=100).contains(&self.num_inference_steps)
            || !self.guidance_scale.is_finite()
            || !(0.0..=10.0).contains(&self.guidance_scale)
            || !self.time_shift.is_finite()
            || !(1.0..=6.0).contains(&self.time_shift)
            || !self.min_opacity.is_finite()
            || !(0.0..=0.5).contains(&self.min_opacity)
            || self.seed > super::MAX_IMAGE_GENERATION_SEED
        {
            return Err("Check the detail, steps, guidance, cleanup, and seed.".into());
        }
        Ok(())
    }

    fn validate(&mut self) -> MediaResult<()> {
        self.validate_values()?;
        self.plan_snapshot.validate(&self.plan_id, &self.flow_id)?;
        let count = |kind: &str| {
            self.plan_snapshot
                .nodes
                .iter()
                .filter(|node| node.r#type == kind)
                .count()
        };
        if self.plan_snapshot.nodes.len() != 3
            || count("source.image") != 1
            || count("task.generate-splat") != 1
            || count("output.splat") != 1
        {
            return Err("Connect one image, one 3D generator, and one 3D output.".into());
        }
        Ok(())
    }
}

pub(crate) struct GeneratedSplat {
    pub(crate) relative_path: String,
    pub(crate) digest: String,
    pub(crate) byte_size: u64,
    pub(crate) preview_relative_path: String,
    pub(crate) preview_digest: String,
    pub(crate) preview_byte_size: u64,
    pub(crate) preview_edge: u32,
    pub(crate) provenance: serde_json::Value,
}

#[tauri::command]
pub(crate) async fn media_generate_splat(
    app: AppHandle,
    mut request: GenerateMediaSplatRequest,
) -> MediaCommandResult<MediaRunDetail> {
    let result = async {
        request.validate()?;
        let _sleep_inhibition = super::inhibit_system_sleep_for_media_work(&app)?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        let state = app.state::<MediaRuntimeState>();
        let Some(_active_run) = state.claim_run(&request.run_id)? else {
            return database::get_run_detail(&paths, &request.run_id);
        };
        if !database::splat::begin(&paths, &request)? {
            return database::get_run_detail(&paths, &request.run_id);
        }
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["source.image"],
            "completed",
            Some("splat.inputs"),
            Some("Image resolved"),
            Some(0.04),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["task.generate-splat"],
            "running",
            Some("splat.generate"),
            Some("Starting Idol"),
            Some(0.05),
        )?;
        let generation_app = app.clone();
        let generation_paths = paths.clone();
        let generation_request = request.clone();
        let generated = tauri::async_runtime::spawn_blocking(move || {
            provider_local_diffusers::generate_splat(
                &generation_app,
                &generation_paths,
                &generation_request,
            )
        })
        .await
        .map_err(|error| format!("3D worker could not be joined: {error}"))
        .and_then(|result| result);
        let publication =
            generated.and_then(|splat| database::splat::complete(&paths, &request, &splat));
        if let Err(error) = publication {
            if database::is_cancellation_requested(&paths, &request.run_id)? {
                database::cancel_run(&paths, &request.run_id)?;
            } else {
                database::fail_run(&paths, &request.run_id, &error)?;
            }
        }
        database::get_run_detail(&paths, &request.run_id)
    }
    .await;
    super::command_result("media_generate_splat", result)
}

#[tauri::command]
pub(crate) async fn media_read_splat(
    app: AppHandle,
    asset_id: String,
) -> MediaCommandResult<tauri::ipc::Response> {
    let result: MediaResult<_> = async {
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        let asset_id = super::required_text("assetId", &asset_id, 256)?;
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            let (source, bytes) = transform::read_asset_original(&paths, &asset_id)?;
            if source.mime_type != SPLAT_MIME_TYPE {
                return Err("Choose a 3D asset".to_string());
            }
            Ok(bytes)
        })
        .await
        .map_err(|error| format!("3D asset reader could not be joined: {error}"))??;
        Ok(tauri::ipc::Response::new(bytes))
    }
    .await;
    super::command_result("media_read_splat", result)
}

pub(crate) fn validate_splat_ply(bytes: &[u8]) -> MediaResult<u64> {
    const END: &[u8] = b"end_header\n";
    let header_end = bytes
        .windows(END.len())
        .take(4096)
        .position(|window| window == END)
        .map(|index| index + END.len())
        .ok_or("The 3D file has no PLY header.")?;
    let header = std::str::from_utf8(&bytes[..header_end]).map_err(|_| "The PLY header is not text.")?;
    let mut lines = header.lines();
    if lines.next() != Some("ply") || lines.next() != Some("format binary_little_endian 1.0") {
        return Err("The 3D file is not a binary little-endian PLY.".into());
    }
    let count = lines
        .next()
        .and_then(|line| line.strip_prefix("element vertex "))
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|count| (1..=1_048_576).contains(count))
        .ok_or("The PLY vertex count is invalid.")?;
    for expected in PLY_PROPERTIES {
        if lines.next() != Some(&format!("property float {expected}")) {
            return Err("The PLY does not contain the expected Gaussian properties.".into());
        }
    }
    if lines.next() != Some("end_header") || lines.next().is_some() {
        return Err("The PLY header has unexpected elements.".into());
    }
    let body = &bytes[header_end..];
    if body.len() as u64 != count * 4 * PLY_PROPERTIES.len() as u64 {
        return Err("The PLY body does not match its vertex count.".into());
    }
    if body
        .chunks_exact(4)
        .any(|value| !f32::from_le_bytes([value[0], value[1], value[2], value[3]]).is_finite())
    {
        return Err("The PLY contains non-finite values.".into());
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ply(format: &str, count: u64, values: &[f32]) -> Vec<u8> {
        let mut bytes = format!("ply\nformat {format} 1.0\nelement vertex {count}\n").into_bytes();
        for property in PLY_PROPERTIES {
            bytes.extend(format!("property float {property}\n").as_bytes());
        }
        bytes.extend(b"end_header\n");
        for value in values {
            bytes.extend(value.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn accepts_complete_gaussian_ply_and_rejects_damage() {
        let values = [0.25_f32; 34];
        let binary = "binary_little_endian";
        assert_eq!(validate_splat_ply(&ply(binary, 2, &values)).unwrap(), 2);
        assert!(validate_splat_ply(&ply(binary, 3, &values)).is_err());
        assert!(validate_splat_ply(&ply("ascii", 2, &values)).is_err());
        let mut infinite = values;
        infinite[5] = f32::INFINITY;
        assert!(validate_splat_ply(&ply(binary, 2, &infinite)).is_err());
        assert!(validate_splat_ply(b"ply\n").is_err());
    }
}
