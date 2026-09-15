use super::*;

pub(super) fn encode_image(
    paths: &MediaRuntimePaths,
    image: DynamicImage,
    format: &str,
    quality: u8,
    jpeg_background: &str,
    icc_profile: Option<&[u8]>,
) -> MediaResult<GeneratedImageAsset> {
    let settings = transform::validate_output(&MediaImageTransformRequest {
        source_asset_id: String::new(),
        operation: MediaImageTransformOperation::Convert,
        output_format: format.into(),
        quality: (format != "png").then_some(quality),
        jpeg_background: (format == "jpeg").then(|| jpeg_background.into()),
    })?;
    let bytes = transform::encode_image_with_icc(&image, &settings, icc_profile)?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    let relative = transform::cas_relative_path(&digest);
    transform::publish_cas_bytes(paths, &relative, &digest, &bytes)?;
    Ok(GeneratedImageAsset {
        digest,
        relative_path: relative.to_string_lossy().into_owned(),
        byte_size: bytes.len() as u64,
        mime_type: match format {
            "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            _ => "image/png",
        },
        width: image.width(),
        height: image.height(),
        output_index: 0,
        subject_cutout: None,
    })
}

pub(super) fn generate_image(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &ExecuteMediaWorkflowRequest,
    flow: &MediaFlowDocument,
    values: &Values,
    node: &MediaFlowNode,
    prompt: String,
    seed: u64,
    iteration: u32,
    previous_image: Option<&str>,
) -> MediaResult<String> {
    let mut base = None;
    let mut references = Vec::new();
    let mut pose = None;
    let mut pose_strength = None;
    for edge in flow
        .edges
        .iter()
        .filter(|edge| edge.to_node_id == node.id && edge.to_port_id == "image")
    {
        let Some(WorkflowValue::Image(id)) =
            values.get(&(edge.from_node_id.clone(), edge.from_port_id.clone()))
        else {
            return Err("Connected image is unavailable".into());
        };
        let source = flow
            .nodes
            .iter()
            .find(|source| source.id == edge.from_node_id)
            .ok_or("Image source is missing")?;
        let role = if source.r#type == "source.image" {
            config_text(source, "referenceRole")
        } else {
            "base"
        };
        if role == "base" || role.is_empty() {
            if base.replace(id.clone()).is_some() {
                return Err("Connect only one base image per edit".into());
            }
        } else if role == "pose" {
            if pose.replace(id.clone()).is_some() {
                return Err("Connect only one pose image".into());
            }
            pose_strength = Some(config_number(source, "influence", 1.0));
        } else {
            references.push(
                json!({"assetId":id,"role":role,"influence":config_number(source,"influence",1.0)}),
            );
        }
    }
    let mask = match optional_input(flow, values, node, "mask")? {
        Some(WorkflowValue::Mask {
            asset_id,
            source_id,
        }) => {
            if base.as_ref() != Some(source_id) {
                return Err("The mask belongs to a different image. Connect the mask and its original image to the same edit.".into());
            }
            if node
                .config
                .get("editMask")
                .is_some_and(|value| !value.is_null())
            {
                return Err("Remove the painted selection before connecting a mask".into());
            }
            Some(asset_id.clone())
        }
        Some(_) => return Err("Connect a segmentation mask".into()),
        None => None,
    };
    let model_id = request
        .model_bindings
        .get(&node.id)
        .ok_or("Choose an image model")?;
    let mut edit_mask = node.config.get("editMask").cloned().unwrap_or(Value::Null);
    if let Some(previous) = previous_image {
        let original = base
            .as_ref()
            .ok_or("Refining an edit requires a base image")?;
        let original_asset = database::get_asset(paths, original)?;
        let previous_asset = database::get_asset(paths, previous)?;
        if (original_asset.width, original_asset.height)
            != (previous_asset.width, previous_asset.height)
        {
            return Err(
                "The previous edit changed dimensions. Retry the original input instead.".into(),
            );
        }
        if !edit_mask.is_null() {
            if edit_mask["sourceAssetId"].as_str() != Some(original.as_str()) {
                return Err("The painted mask belongs to a different image".into());
            }
            edit_mask["sourceAssetId"] = json!(previous);
        }
        base = Some(previous.to_string());
    }
    let mut generation: GenerateMediaImagesRequest = serde_json::from_value(json!({
        "schemaVersion":1,"runId":request.run_id,"flowId":request.flow_id,"flowRevisionId":request.flow_revision_id,"flowName":flow.name,"planId":request.plan_id,"planSnapshot":request.plan_snapshot,
        "prompt":prompt,"modelId":model_id,"modelLabel":node.label,"outputCount":1,"diagnosticCount":0,"aspectRatio":node.config["aspectRatio"],"outputFormat":node.config["outputFormat"],"modelPolicy":node.config["modelPolicy"],"modelAddons":node.config.get("modelAddons").cloned().unwrap_or(json!([])),"transparentBackground":node.config.get("transparentBackground").and_then(Value::as_bool).unwrap_or(false),"poseImageAssetId":pose,"poseStrength":pose_strength,"referenceImages":references,"baseImageAssetId":base,"editMask":edit_mask,"seed":seed,"negativePrompt":"","editStrength":config_number(node,"editStrength",0.65),"maskStrength":config_number(node,"maskStrength",1.0),"memoryProfile":node.config.get("memoryProfile"),"outputBranches":[]
    })).map_err(|e| e.to_string())?;
    generation.sampling = super::image_sampling::ImageSampling::from_config(&node.config)?;
    generation.control_net = match optional_input(flow, values, node, "controlnet")? {
        Some(WorkflowValue::ControlNet(control)) => Some(control.clone()),
        Some(_) => return Err("Connect an Apply ControlNet node.".into()),
        None => None,
    };
    if generation.pose_image_asset_id.is_some() {
        generation.pose_start = Some(config_number(node, "poseStart", 0.0));
        generation.pose_end = Some(config_number(node, "poseEnd", 1.0));
    }
    generation.output_branches = vec![MediaImageOutputBranch {
        id: node.id.clone(),
        output_node_id: node.id.clone(),
        format: generation.output_format.clone(),
        quality: 95,
        jpeg_background: "#ffffff".into(),
        operations: Vec::new(),
    }];
    if generation.base_image_asset_id.is_none() && generation.reference_images.is_empty() {
        generation.edit_strength = None;
    }
    if generation.edit_mask.is_none() {
        generation.mask_strength = None;
    }
    generation.validate()?;
    if mask.is_some() {
        generation.mask_strength = Some(config_number(node, "maskStrength", 1.0));
    }
    let batch = provider_local_diffusers::generate(app, paths, &generation, mask.as_deref())?;
    let asset = batch.assets.first().ok_or("Generation returned no image")?;
    let mut sources = generation
        .reference_images
        .iter()
        .map(|item| item.asset_id.clone())
        .collect::<Vec<_>>();
    sources.extend(base);
    sources.extend(pose);
    sources.extend(mask);
    sources.extend(
        generation
            .control_net
            .as_ref()
            .map(|control| control.image_asset_id.clone()),
    );
    database::workflow::publish(
        paths,
        &request.run_id,
        &node.id,
        iteration,
        asset,
        "image",
        &sources,
        json!({"prompt":prompt,"seed":seed,"modelId":model_id,"provenance":batch.provenance}),
    )
}
