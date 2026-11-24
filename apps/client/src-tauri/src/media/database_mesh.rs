use super::*;
use crate::media::mesh::{
    GenerateMediaMeshRequest, GeneratedMesh, MESH_MIME_TYPE, MESH_PREVIEW_PROFILE, MESH_VIEWS,
};

fn validate_saved_flow(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaMeshRequest,
) -> MediaResult<()> {
    let flow =
        super::super::flow::load_workflow(paths, &request.flow_id, &request.flow_revision_id)?;
    if flow.nodes.len() != request.views.len() + 2
        || flow.edges.len() != request.views.len() + 1
        || flow.name != request.flow_name
        || request.plan_snapshot.nodes.len() != flow.nodes.len()
        || flow.nodes.iter().any(|node| {
            !matches!(
                node.r#type.as_str(),
                "source.image" | "task.generate-mesh" | "output.mesh"
            ) || !request.plan_snapshot.nodes.iter().any(|snapshot| {
                snapshot.id == node.id
                    && snapshot.r#type == node.r#type
                    && snapshot.layer == node.layer
            })
        })
    {
        return Err("The 3D mesh request does not match its saved flow.".into());
    }
    let task = flow
        .nodes
        .iter()
        .find(|node| node.r#type == "task.generate-mesh")
        .ok_or("The 3D mesh flow has no generator")?;
    for (view, asset_id) in &request.views {
        let source = flow
            .edges
            .iter()
            .find(|edge| edge.to_node_id == task.id && &edge.to_port_id == view)
            .and_then(|edge| flow.nodes.iter().find(|node| node.id == edge.from_node_id))
            .filter(|node| node.r#type == "source.image")
            .ok_or_else(|| format!("The {view} view is not connected."))?;
        if source.config.get("assetId").and_then(serde_json::Value::as_str)
            != Some(asset_id.as_str())
        {
            return Err("The 3D views changed after the flow was saved. Save and retry.".into());
        }
    }
    let config = &task.config;
    let number = |key: &str| config.get(key).and_then(serde_json::Value::as_f64);
    let flag = |key: &str| config.get(key).and_then(serde_json::Value::as_bool);
    if config
        .get("modelId")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| id != request.model_id)
        || flag("removeBackground") != Some(request.remove_background)
        || flag("removeFloaters") != Some(request.remove_floaters)
        || flag("voxelize") != Some(request.voxelize)
        || number("voxelResolution") != Some(f64::from(request.voxel_resolution))
        || number("voxelFill") != Some(request.voxel_fill)
        || number("numInferenceSteps") != Some(f64::from(request.num_inference_steps))
        || number("guidanceScale") != Some(request.guidance_scale)
        || number("octreeResolution") != Some(f64::from(request.octree_resolution))
        || number("numChunks") != Some(f64::from(request.num_chunks))
        || number("maxFaceCount") != request.max_face_count.map(f64::from)
        || config
            .get("seed")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|seed| seed != request.seed)
    {
        return Err("The 3D settings changed after the flow was saved. Save and retry.".into());
    }
    Ok(())
}

pub(crate) fn begin(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaMeshRequest,
) -> MediaResult<bool> {
    validate_saved_flow(paths, request)?;
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    validate_run_flow_revision(
        &transaction,
        &request.flow_id,
        Some(&request.flow_revision_id),
        Some(&request.plan_snapshot),
    )?;
    let timestamp = now();
    let snapshot =
        serde_json::to_string(&request.plan_snapshot).map_err(|error| error.to_string())?;
    let inserted = transaction.execute(
        "INSERT OR IGNORE INTO runs(id,flow_id,flow_name,plan_id,status,created_at,updated_at,prompt,model_label,target,output_count,diagnostic_count,progress,current_step,executor,aspect_ratio,plan_snapshot_json,flow_revision_id)
         VALUES(?1,?2,?3,?4,'running',?5,?5,'',?6,'local',1,?7,0.02,'Starting Hunyuan3D','local-mesh','1:1',?8,?9)",
        params![request.run_id,request.flow_id,request.flow_name,request.plan_id,timestamp,request.model_label,request.diagnostic_count,snapshot,request.flow_revision_id],
    ).map_err(|error| format!("Could not register 3D mesh run: {error}"))?;
    if inserted == 0 {
        validate_existing_run_identity(
            &transaction,
            &request.run_id,
            &request.flow_id,
            Some(&request.flow_revision_id),
            &request.plan_id,
            "local-mesh",
        )?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(false);
    }
    seed_node_executions(
        &transaction,
        &request.run_id,
        &request.plan_snapshot,
        "pending",
    )?;
    transaction.execute("INSERT INTO jobs(id,run_id,status,attempts,started_at,heartbeat_at) VALUES(?1,?2,'running',1,?3,?3)",params![format!("job:{}",request.run_id),request.run_id,timestamp]).map_err(|error| error.to_string())?;
    append_event(
        &transaction,
        &request.run_id,
        "worker_prepared",
        "3D mesh generation started",
        Some(0.02),
        Some("mesh.prepare"),
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

pub(crate) fn insert_mesh_asset(
    transaction: &rusqlite::Transaction<'_>,
    asset_id: &str,
    run_id: &str,
    output_index: u32,
    mesh: &GeneratedMesh,
    operation: &serde_json::Value,
    view_asset_ids: &[&str],
) -> MediaResult<()> {
    let timestamp = now();
    for (digest, byte_size, mime_type, relative_path) in [
        (&mesh.digest, mesh.byte_size, MESH_MIME_TYPE, &mesh.relative_path),
        (&mesh.preview_digest, mesh.preview_byte_size, "image/png", &mesh.preview_relative_path),
    ] {
        transaction.execute("INSERT INTO blobs(digest,byte_size,mime_type,relative_path,created_at,available) VALUES(?1,?2,?3,?4,?5,1) ON CONFLICT(digest) DO UPDATE SET available=1",params![digest,byte_size as i64,mime_type,relative_path,timestamp]).map_err(|error|error.to_string())?;
    }
    transaction.execute("INSERT INTO assets(id,run_id,blob_digest,kind,mime_type,byte_size,width,height,created_at,output_index,fixture,operation_json) VALUES(?1,?2,?3,'mesh',?4,?5,0,0,?6,?7,0,?8)",params![asset_id,run_id,mesh.digest,MESH_MIME_TYPE,mesh.byte_size as i64,timestamp,output_index,operation.to_string()]).map_err(|error|error.to_string())?;
    for (index, source_asset_id) in view_asset_ids.iter().enumerate() {
        transaction.execute("INSERT OR IGNORE INTO asset_inputs(asset_id,input_asset_id,role) VALUES(?1,?2,?3)",params![asset_id,source_asset_id,format!("source:{index}")]).map_err(|error|error.to_string())?;
    }
    transaction.execute("INSERT INTO asset_renditions(asset_id,profile,blob_digest,mime_type,byte_size,width,height,created_at) VALUES(?1,?2,?3,'image/png',?4,?5,?5,?6)",params![asset_id,MESH_PREVIEW_PROFILE,mesh.preview_digest,mesh.preview_byte_size as i64,mesh.preview_edge,timestamp]).map_err(|error|error.to_string())?;
    transaction.execute("INSERT INTO asset_tags(asset_id,normalized_tag,display_tag,source,confidence,created_at) VALUES(?1,'hunyuan3d','Hunyuan3D','technical',1.0,?2)",params![asset_id,timestamp]).map_err(|error|error.to_string())?;
    Ok(())
}

pub(crate) fn complete(
    paths: &MediaRuntimePaths,
    request: &GenerateMediaMeshRequest,
    mesh: &GeneratedMesh,
) -> MediaResult<MediaRunDetail> {
    let mut connection = open(paths)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let status: String = transaction
        .query_row(
            "SELECT status FROM runs WHERE id=?1",
            [&request.run_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if status == "canceling" {
        finalize_cancellation(&transaction, &request.run_id)?;
        transaction.commit().map_err(|error| error.to_string())?;
        return get_run_detail(paths, &request.run_id);
    }
    if status != "running" {
        return Err(format!("3D mesh output cannot be published from {status} state"));
    }
    let operation = serde_json::json!({"kind":"local-mesh-generation","providerId":"local-diffusers","modelId":request.model_id,"flowRevisionId":request.flow_revision_id,"viewAssetIds":request.views,"generation":mesh.provenance});
    let view_asset_ids: Vec<&str> = MESH_VIEWS
        .iter()
        .filter_map(|view| request.views.get(*view).map(String::as_str))
        .collect();
    insert_mesh_asset(
        &transaction,
        &format!("asset:{}:0", request.run_id),
        &request.run_id,
        0,
        mesh,
        &operation,
        &view_asset_ids,
    )?;
    transaction.commit().map_err(|error| error.to_string())?;
    transition_nodes_by_type(
        paths,
        &request.run_id,
        &["task.generate-mesh", "output.mesh"],
        "completed",
        Some("mesh.publish"),
        Some("3D mesh saved"),
        Some(0.98),
    )?;
    complete_run(paths, &request.run_id)?;
    get_run_detail(paths, &request.run_id)
}
