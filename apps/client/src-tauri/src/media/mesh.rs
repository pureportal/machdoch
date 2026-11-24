use std::collections::BTreeMap;

use serde::Deserialize;
use tauri::{AppHandle, Manager as _};

use super::{
    database, provider_local_diffusers, transform, MediaCommandResult, MediaResult,
    MediaRunDetail, MediaRunPlanSnapshot, MediaRuntimePaths, MediaRuntimeState,
};

pub(crate) const MESH_MIME_TYPE: &str = "model/gltf-binary";
pub(crate) const MESH_PREVIEW_PROFILE: &str = "mesh-render-v1";
pub(crate) const MAX_MESH_BYTES: u64 = 512 * 1024 * 1024;
pub(crate) const MESH_VIEWS: [&str; 4] = ["front", "left", "back", "right"];
const GLB_MAGIC: u32 = 0x4654_6C67;
const GLB_JSON_CHUNK: u32 = 0x4E4F_534A;
const GLB_BINARY_CHUNK: u32 = 0x004E_4942;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MediaMeshStyle {
    Smooth,
    Voxel,
    LowPoly,
}

impl MediaMeshStyle {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Smooth => "smooth",
            Self::Voxel => "voxel",
            Self::LowPoly => "low-poly",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        [Self::Smooth, Self::Voxel, Self::LowPoly]
            .into_iter()
            .find(|style| style.as_str() == value)
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GenerateMediaMeshRequest {
    pub(crate) schema_version: u32,
    pub(crate) run_id: String,
    pub(crate) flow_id: String,
    pub(crate) flow_revision_id: String,
    pub(crate) flow_name: String,
    pub(crate) plan_id: String,
    pub(crate) model_id: String,
    pub(crate) model_label: String,
    pub(crate) views: BTreeMap<String, String>,
    pub(crate) remove_background: bool,
    pub(crate) num_inference_steps: u32,
    pub(crate) guidance_scale: f64,
    pub(crate) octree_resolution: u32,
    pub(crate) num_chunks: u32,
    pub(crate) remove_floaters: bool,
    pub(crate) max_face_count: Option<u32>,
    pub(crate) style: MediaMeshStyle,
    pub(crate) voxel_resolution: u32,
    pub(crate) voxel_fill: f64,
    pub(crate) polygon_count: u32,
    pub(crate) seed: u64,
    pub(crate) diagnostic_count: u32,
    pub(crate) plan_snapshot: MediaRunPlanSnapshot,
}

impl GenerateMediaMeshRequest {
    pub(super) fn validate_values(&mut self) -> MediaResult<()> {
        if self.schema_version != 1 {
            return Err("3D mesh generation requires schemaVersion 1".into());
        }
        for (label, value, limit) in [
            ("runId", &mut self.run_id, 128),
            ("flowId", &mut self.flow_id, 128),
            ("flowRevisionId", &mut self.flow_revision_id, 128),
            ("flowName", &mut self.flow_name, 256),
            ("planId", &mut self.plan_id, 128),
            ("modelId", &mut self.model_id, 128),
            ("modelLabel", &mut self.model_label, 256),
        ] {
            *value = super::required_text(label, value, limit)?;
        }
        if !self.views.contains_key("front")
            || self
                .views
                .keys()
                .any(|view| !MESH_VIEWS.contains(&view.as_str()))
        {
            return Err("Add a front view. Left, back, and right views are optional.".into());
        }
        for asset_id in self.views.values_mut() {
            *asset_id = super::required_text("viewAssetId", asset_id, 256)?;
        }
        if !(1..=100).contains(&self.num_inference_steps)
            || !self.guidance_scale.is_finite()
            || !(0.0..=15.0).contains(&self.guidance_scale)
            || !(64..=512).contains(&self.octree_resolution)
            || !(1_000..=500_000).contains(&self.num_chunks)
            || self
                .max_face_count
                .is_some_and(|count| !(1_000..=2_000_000).contains(&count))
            || !(8..=128).contains(&self.voxel_resolution)
            || !self.voxel_fill.is_finite()
            || !(0.1..=0.9).contains(&self.voxel_fill)
            || !(100..=20_000).contains(&self.polygon_count)
            || self.seed > super::MAX_IMAGE_GENERATION_SEED
        {
            return Err(
                "Check the steps, guidance, resolution, chunk size, face limit, voxel and low-poly settings, and seed.".into(),
            );
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
        if self.plan_snapshot.nodes.len() != self.views.len() + 2
            || count("source.image") != self.views.len()
            || count("task.generate-mesh") != 1
            || count("output.mesh") != 1
        {
            return Err("Connect the views, one mesh generator, and one mesh output.".into());
        }
        Ok(())
    }
}

pub(crate) struct GeneratedMesh {
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
pub(crate) async fn media_generate_mesh(
    app: AppHandle,
    mut request: GenerateMediaMeshRequest,
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
        if !database::mesh::begin(&paths, &request)? {
            return database::get_run_detail(&paths, &request.run_id);
        }
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["source.image"],
            "completed",
            Some("mesh.inputs"),
            Some("Views resolved"),
            Some(0.04),
        )?;
        database::transition_nodes_by_type(
            &paths,
            &request.run_id,
            &["task.generate-mesh"],
            "running",
            Some("mesh.generate"),
            Some("Starting Hunyuan3D"),
            Some(0.05),
        )?;
        let generation_app = app.clone();
        let generation_paths = paths.clone();
        let generation_request = request.clone();
        let generated = tauri::async_runtime::spawn_blocking(move || {
            provider_local_diffusers::generate_mesh(
                &generation_app,
                &generation_paths,
                &generation_request,
            )
        })
        .await
        .map_err(|error| format!("3D mesh worker could not be joined: {error}"))
        .and_then(|result| result);
        let publication =
            generated.and_then(|mesh| database::mesh::complete(&paths, &request, &mesh));
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
    super::command_result("media_generate_mesh", result)
}

#[tauri::command]
pub(crate) async fn media_read_mesh(
    app: AppHandle,
    asset_id: String,
) -> MediaCommandResult<tauri::ipc::Response> {
    let result: MediaResult<_> = async {
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        let asset_id = super::required_text("assetId", &asset_id, 256)?;
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            let (source, bytes) = transform::read_asset_original(&paths, &asset_id)?;
            if source.mime_type != MESH_MIME_TYPE {
                return Err("Choose a 3D mesh asset".to_string());
            }
            Ok(bytes)
        })
        .await
        .map_err(|error| format!("3D mesh reader could not be joined: {error}"))??;
        Ok(tauri::ipc::Response::new(bytes))
    }
    .await;
    super::command_result("media_read_mesh", result)
}

fn read_u32(bytes: &[u8], offset: usize) -> MediaResult<u32> {
    bytes
        .get(offset..offset + 4)
        .map(|value| u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
        .ok_or_else(|| "The GLB file is truncated.".to_string())
}

pub(crate) fn validate_mesh_glb(bytes: &[u8]) -> MediaResult<u64> {
    if bytes.len() as u64 > MAX_MESH_BYTES {
        return Err("The GLB file is too large.".into());
    }
    if read_u32(bytes, 0)? != GLB_MAGIC || read_u32(bytes, 4)? != 2 {
        return Err("The 3D file is not a glTF 2.0 binary.".into());
    }
    if read_u32(bytes, 8)? as usize != bytes.len() {
        return Err("The GLB length does not match its header.".into());
    }
    let json_length = read_u32(bytes, 12)? as usize;
    if read_u32(bytes, 16)? != GLB_JSON_CHUNK || json_length == 0 || json_length % 4 != 0 {
        return Err("The GLB has no JSON chunk.".into());
    }
    let json_end = 20 + json_length;
    let document: serde_json::Value = serde_json::from_slice(
        bytes
            .get(20..json_end)
            .ok_or("The GLB JSON chunk is truncated.")?,
    )
    .map_err(|error| format!("The GLB JSON chunk is invalid: {error}"))?;
    if document["asset"]["version"] != "2.0" {
        return Err("The GLB is not glTF 2.0.".into());
    }
    let primitives = document["meshes"]
        .as_array()
        .map(|meshes| {
            meshes
                .iter()
                .filter_map(|mesh| mesh["primitives"].as_array())
                .map(Vec::len)
                .sum::<usize>()
        })
        .unwrap_or(0);
    if primitives == 0 {
        return Err("The GLB contains no mesh.".into());
    }
    if json_end < bytes.len() {
        let binary_length = read_u32(bytes, json_end)? as usize;
        if read_u32(bytes, json_end + 4)? != GLB_BINARY_CHUNK
            || json_end + 8 + binary_length != bytes.len()
        {
            return Err("The GLB binary chunk is malformed.".into());
        }
    }
    Ok(primitives as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn glb(json: &str, binary: &[u8]) -> Vec<u8> {
        let mut json = json.as_bytes().to_vec();
        while json.len() % 4 != 0 {
            json.push(b' ');
        }
        let mut binary = binary.to_vec();
        while binary.len() % 4 != 0 {
            binary.push(0);
        }
        let total = 12 + 8 + json.len() + 8 + binary.len();
        let mut bytes = Vec::new();
        for value in [GLB_MAGIC, 2, total as u32, json.len() as u32, GLB_JSON_CHUNK] {
            bytes.extend(value.to_le_bytes());
        }
        bytes.extend(&json);
        bytes.extend((binary.len() as u32).to_le_bytes());
        bytes.extend(GLB_BINARY_CHUNK.to_le_bytes());
        bytes.extend(&binary);
        bytes
    }

    #[test]
    fn accepts_glb_meshes_and_rejects_damage() {
        let valid = glb(r#"{"asset":{"version":"2.0"},"meshes":[{"primitives":[{}]}]}"#, &[1, 2, 3]);
        assert_eq!(validate_mesh_glb(&valid).unwrap(), 1);
        assert!(validate_mesh_glb(&valid[..valid.len() - 4]).is_err());
        assert!(validate_mesh_glb(&glb(r#"{"asset":{"version":"2.0"},"meshes":[]}"#, &[])).is_err());
        assert!(validate_mesh_glb(&glb(r#"{"asset":{"version":"1.0"},"meshes":[{"primitives":[{}]}]}"#, &[])).is_err());
        let mut wrong_magic = valid.clone();
        wrong_magic[0] = 0;
        assert!(validate_mesh_glb(&wrong_magic).is_err());
    }
}
