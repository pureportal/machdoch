use super::{
    flow::{MediaFlowDocument, MediaFlowNode},
    provider_images::GeneratedImageAsset,
    *,
};
use image::DynamicImage;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use tauri::{AppHandle, Manager};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecuteMediaWorkflowRequest {
    schema_version: u32,
    run_id: String,
    flow_id: String,
    flow_revision_id: String,
    plan_id: String,
    plan_snapshot: MediaRunPlanSnapshot,
    workspace_root: String,
    model_bindings: HashMap<String, String>,
}

#[derive(Clone)]
enum WorkflowValue {
    ControlNet(controlnet::ControlNetConditioning),
    Text(String),
    Image(String),
    Video(String),
    Mask { asset_id: String, source_id: String },
    Report(MediaQualityReport),
    Seed(u64),
}

type Values = HashMap<(String, String), WorkflowValue>;

fn input<'a>(
    flow: &MediaFlowDocument,
    values: &'a Values,
    node: &MediaFlowNode,
    port: &str,
) -> MediaResult<&'a WorkflowValue> {
    optional_input(flow, values, node, port)?
        .ok_or_else(|| format!("{} requires {port}", node.label))
}

fn optional_input<'a>(
    flow: &MediaFlowDocument,
    values: &'a Values,
    node: &MediaFlowNode,
    port: &str,
) -> MediaResult<Option<&'a WorkflowValue>> {
    let edge = flow
        .edges
        .iter()
        .find(|edge| edge.to_node_id == node.id && edge.to_port_id == port);
    let Some(edge) = edge else {
        return Ok(None);
    };
    values
        .get(&(edge.from_node_id.clone(), edge.from_port_id.clone()))
        .map(Some)
        .ok_or_else(|| format!("{} is waiting for {port}", node.label))
}

fn image_input(
    flow: &MediaFlowDocument,
    values: &Values,
    node: &MediaFlowNode,
    port: &str,
) -> MediaResult<String> {
    match input(flow, values, node, port)? {
        WorkflowValue::Image(id) => Ok(id.clone()),
        _ => Err(format!("{} requires an image", node.label)),
    }
}

fn config_text<'a>(node: &'a MediaFlowNode, key: &str) -> &'a str {
    node.config.get(key).and_then(Value::as_str).unwrap_or("")
}
fn config_number(node: &MediaFlowNode, key: &str, default: f64) -> f64 {
    node.config
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or(default)
}

fn execute_started(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &ExecuteMediaWorkflowRequest,
    flow: &MediaFlowDocument,
    repeated: &HashSet<String>,
) -> MediaResult<()> {
    let loop_node = flow
        .nodes
        .iter()
        .find(|node| node.r#type == "control.repeat");
    let maximum = loop_node
        .map(|node| config_number(node, "maxIterations", 3.0) as u32)
        .unwrap_or(1);
    let seed_step = loop_node
        .map(|node| config_number(node, "seedStep", 1.0) as u64)
        .unwrap_or(1);
    let base_seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64
        % u32::MAX as u64;
    let mut values = Values::new();
    let mut completed = HashSet::new();
    let mut feedback = String::new();
    let mut previous_image: Option<String> = None;
    let mut final_outputs = 0;
    let mut rejected_images: HashMap<(String, String), u32> = HashMap::new();
    let execution_nodes: Vec<_> = flow
        .nodes
        .iter()
        .filter(|node| !node.r#type.starts_with("output."))
        .chain(
            flow.nodes
                .iter()
                .filter(|node| node.r#type.starts_with("output.")),
        )
        .collect();
    let feedback_target = execution_nodes.iter().find(|node| {
        repeated.contains(&node.id)
            && matches!(
                node.r#type.as_str(),
                "task.generate-prompt" | "task.generate-image" | "task.edit-image"
            )
    });
    for iteration in 1..=maximum {
        let mut retry = None;
        for node in &execution_nodes {
            if database::is_cancellation_requested(paths, &request.run_id)? {
                return Err("Workflow canceled".into());
            }
            if completed.contains(&node.id) {
                continue;
            }
            database::transition_node_execution(
                paths,
                &request.run_id,
                &node.id,
                "running",
                Some("workflow.execute"),
                Some(&format!("Attempt {iteration}/{maximum} · {}", node.label)),
                Some(0.0),
            )?;
            let image = || image_input(flow, &values, node, "image");
            let mut output_port = "image";
            let output = match node.r#type.as_str() {
                "source.prompt" => {
                    output_port = "prompt";
                    Some(WorkflowValue::Text(config_text(node, "prompt").to_string()))
                }
                "source.seed" => {
                    output_port = "seed";
                    Some(WorkflowValue::Seed(
                        config_number(node, "seed", base_seed as f64) as u64,
                    ))
                }
                "source.image" => {
                    let id = config_text(node, "assetId");
                    transform::read_asset_original(paths, id)?;
                    Some(WorkflowValue::Image(id.to_string()))
                }
                "control.repeat" => None,
                "task.generate-prompt"
                | "task.generate-image"
                | "task.edit-image"
                | "task.generate-video" => {
                    let WorkflowValue::Text(mut prompt) =
                        input(flow, &values, node, "prompt")?.clone()
                    else {
                        return Err("Connect a prompt".into());
                    };
                    if !feedback.is_empty()
                        && loop_node.is_some_and(|repeat| {
                            repeat.config["feedback"] == true
                                && feedback_target.is_some_and(|target| target.id == node.id)
                        })
                    {
                        prompt.push_str(&format!("\nRefinement feedback: {feedback}"));
                    }
                    let seed = match optional_input(flow, &values, node, "seed")? {
                        Some(WorkflowValue::Seed(seed)) => *seed,
                        _ => node
                            .config
                            .get("seed")
                            .and_then(Value::as_u64)
                            .unwrap_or(base_seed),
                    }
                    .wrapping_add(u64::from(iteration - 1) * seed_step)
                        % u32::MAX as u64;
                    if node.r#type == "task.generate-prompt" {
                        let mut config = Value::Object(node.config.clone());
                        config["prompt"] = json!(prompt);
                        let (result, _) = provider_local_diffusers::workflow_operation(
                            app,
                            paths,
                            &request.run_id,
                            "generate-prompt",
                            config,
                            None,
                        )?;
                        let text = result["prompt"]
                            .as_str()
                            .filter(|text| !text.trim().is_empty() && text.chars().count() <= 8000)
                            .ok_or("The text model returned an invalid prompt")?
                            .to_string();
                        database::workflow::record_result(
                            paths,
                            &request.run_id,
                            &node.id,
                            "workflow_prompt",
                            &text,
                        )?;
                        output_port = "prompt";
                        Some(WorkflowValue::Text(text))
                    } else if node.r#type == "task.generate-video" {
                        let first = image_input(flow, &values, node, "first-frame")?;
                        let last = if flow.edges.iter().any(|edge| {
                            edge.to_node_id == node.id && edge.to_port_id == "last-frame"
                        }) {
                            image_input(flow, &values, node, "last-frame")?
                        } else {
                            first.clone()
                        };
                        let mut config = Value::Object(node.config.clone());
                        let object = config.as_object_mut().ok_or("Invalid video settings")?;
                        for key in ["providerPolicy", "modelPolicy", "generateAudio"] {
                            object.remove(key);
                        }
                        object.extend(json!({"schemaVersion":1,"runId":request.run_id,"flowId":request.flow_id,"flowRevisionId":request.flow_revision_id,"flowName":flow.name,"planId":request.plan_id,"planSnapshot":request.plan_snapshot,"prompt":prompt,"modelId":request.model_bindings[&node.id],"modelLabel":node.label,"diagnosticCount":0,"workspaceRoot":request.workspace_root,"firstFrameAssetId":first,"lastFrameAssetId":last,"seed":seed,"outputFormat":"webm"}).as_object().unwrap().clone());
                        let mut generation: GenerateMediaVideoRequest =
                            serde_json::from_value(config).map_err(|e| e.to_string())?;
                        generation.validate()?;
                        let video =
                            provider_local_diffusers::generate_video(app, paths, &generation)?;
                        let asset = GeneratedImageAsset {
                            digest: video.digest,
                            relative_path: video.relative_path,
                            byte_size: video.byte_size,
                            mime_type: "video/webm",
                            width: video.output.width,
                            height: video.output.height,
                            output_index: 0,
                            subject_cutout: None,
                        };
                        let id = database::workflow::publish(
                            paths,
                            &request.run_id,
                            &node.id,
                            iteration,
                            &asset,
                            "video",
                            &[first, last],
                            json!({"prompt":prompt,"seed":seed,"modelId":generation.model_id,"modelRevision":video.model_revision,"numFrames":video.output.frame_count,"fps":generation.fps,"performance":video.performance}),
                        )?;
                        output_port = "video";
                        Some(WorkflowValue::Video(id))
                    } else {
                        Some(WorkflowValue::Image(generate_image(
                            app,
                            paths,
                            request,
                            flow,
                            &values,
                            node,
                            prompt,
                            seed,
                            iteration,
                            loop_node
                                .filter(|repeat| config_text(repeat, "startNodeId") == node.id)
                                .and(previous_image.as_deref()),
                        )?))
                    }
                }
                "operation.controlnet" => {
                    let mut control = controlnet::ControlNetConditioning {
                        image_asset_id: image()?,
                        kind: config_text(node, "kind").to_string(),
                        strength: config_number(node, "strength", 1.0),
                        start: config_number(node, "start", 0.0),
                        end: config_number(node, "end", 1.0),
                    };
                    control.validate()?;
                    output_port = "controlnet";
                    Some(WorkflowValue::ControlNet(control))
                }
                "operation.mask-composite" => {
                    let WorkflowValue::Mask {
                        asset_id: destination,
                        source_id,
                    } = input(flow, &values, node, "destination")?
                    else {
                        return Err("Connect a destination mask".into());
                    };
                    let WorkflowValue::Mask {
                        asset_id: source,
                        source_id: other_source,
                    } = input(flow, &values, node, "source")?
                    else {
                        return Err("Connect a source mask".into());
                    };
                    if source_id != other_source {
                        return Err("Combine masks belonging to the same image".into());
                    }
                    let mut config = Value::Object(node.config.clone());
                    config["maskAssetId"] = json!(source);
                    let (details, asset) = provider_local_diffusers::workflow_operation(
                        app,
                        paths,
                        &request.run_id,
                        "mask-composite",
                        config,
                        Some(destination),
                    )?;
                    let id = database::workflow::publish(
                        paths,
                        &request.run_id,
                        &node.id,
                        iteration,
                        &asset.ok_or("Workflow returned no mask")?,
                        "image",
                        &[destination.clone(), source.clone(), source_id.clone()],
                        details,
                    )?;
                    output_port = "mask";
                    Some(WorkflowValue::Mask {
                        asset_id: id,
                        source_id: source_id.clone(),
                    })
                }
                "operation.segment"
                | "operation.prepare-mask"
                | "operation.image-mask"
                | "operation.upscale"
                | "operation.canny"
                | "operation.depth-map" => {
                    let source = image()?;
                    let mut config = Value::Object(node.config.clone());
                    let mut mask_reference = source.clone();
                    if node.r#type == "operation.image-mask" {
                        if let Some(reference) = optional_input(flow, &values, node, "reference")? {
                            let WorkflowValue::Image(reference) = reference else {
                                return Err("Connect the image the mask belongs to".into());
                            };
                            let original = database::get_asset(paths, reference)?;
                            let mask = database::get_asset(paths, &source)?;
                            if (original.width, original.height) != (mask.width, mask.height) {
                                return Err(
                                    "The mask and reference must have matching dimensions".into()
                                );
                            }
                            mask_reference = reference.clone();
                        }
                    }
                    if node.r#type == "operation.prepare-mask" {
                        let reference = match optional_input(flow, &values, node, "reference")? {
                            Some(WorkflowValue::Image(id)) => id.as_str(),
                            Some(_) => {
                                return Err("Connect the image that the mask was drawn on".into())
                            }
                            None => source.as_str(),
                        };
                        if reference != source {
                            let original = database::get_asset(paths, reference)?;
                            let candidate = database::get_asset(paths, &source)?;
                            if (original.width, original.height)
                                != (candidate.width, candidate.height)
                            {
                                return Err(
                                    "The mask reference and edit must have matching dimensions"
                                        .into(),
                                );
                            }
                        }
                        match optional_input(flow, &values, node, "mask")? {
                            Some(WorkflowValue::Mask {
                                asset_id,
                                source_id,
                            }) if source_id == reference => config["maskAssetId"] = json!(asset_id),
                            Some(_) => {
                                return Err(
                                    "Connect the mask and its original image to Prepare mask"
                                        .into(),
                                )
                            }
                            None if config["editMask"]["sourceAssetId"].as_str()
                                == Some(reference) => {}
                            None => {
                                return Err(
                                    "The painted selection belongs to a different image".into()
                                )
                            }
                        }
                    }
                    let (details, asset) = provider_local_diffusers::workflow_operation(
                        app,
                        paths,
                        &request.run_id,
                        node.r#type
                            .strip_prefix("operation.")
                            .ok_or("Invalid image operation")?,
                        config,
                        Some(&source),
                    )?;
                    let id = database::workflow::publish(
                        paths,
                        &request.run_id,
                        &node.id,
                        iteration,
                        &asset.ok_or("Workflow returned no image")?,
                        "image",
                        &if source == mask_reference {
                            vec![source.clone()]
                        } else {
                            vec![source.clone(), mask_reference.clone()]
                        },
                        details,
                    )?;
                    if matches!(
                        node.r#type.as_str(),
                        "operation.segment" | "operation.prepare-mask" | "operation.image-mask"
                    ) {
                        values.insert(
                            (node.id.clone(), "mask".into()),
                            WorkflowValue::Mask {
                                asset_id: id,
                                source_id: mask_reference.clone(),
                            },
                        );
                        Some(WorkflowValue::Image(mask_reference))
                    } else {
                        Some(WorkflowValue::Image(id))
                    }
                }
                "operation.quality-analyze" | "operation.visual-check" => {
                    let source = image()?;
                    let mut report = analysis::measure_image(paths, &source)?;
                    if node.r#type == "operation.visual-check" {
                        visual::check_image(app, paths, request, flow, &values, node, &mut report)?;
                    } else if report.profile.id != config_text(node, "profile") {
                        return Err("Choose the standard technical quality profile".into());
                    }
                    let bytes = serde_json::to_vec_pretty(&report).map_err(|e| e.to_string())?;
                    let digest = format!("{:x}", Sha256::digest(&bytes));
                    let relative = transform::cas_relative_path(&digest);
                    transform::publish_cas_bytes(paths, &relative, &digest, &bytes)?;
                    let asset = GeneratedImageAsset {
                        digest,
                        relative_path: relative.to_string_lossy().into_owned(),
                        byte_size: bytes.len() as u64,
                        mime_type: "application/json",
                        width: 0,
                        height: 0,
                        output_index: 0,
                        subject_cutout: None,
                    };
                    database::workflow::publish(
                        paths,
                        &request.run_id,
                        &node.id,
                        iteration,
                        &asset,
                        "report",
                        &[source],
                        json!({"profileId":report.profile.id,"verdict":report.verdict}),
                    )?;
                    output_port = "report";
                    Some(WorkflowValue::Report(report))
                }
                "control.quality-gate" => {
                    let source = image()?;
                    let WorkflowValue::Report(report) = input(flow, &values, node, "report")?
                    else {
                        return Err("Connect a quality report".into());
                    };
                    let outcome = evaluate_gate(node, report, &source)?;
                    let fingerprint = if config_text(node, "onFailure") == "repeat"
                        && loop_node.is_some_and(|repeat| {
                            repeat
                                .config
                                .get("stopOnRepeatedImage")
                                .and_then(Value::as_bool)
                                .unwrap_or(true)
                        }) {
                        let (_, decoded) =
                            transform::read_asset_image_with_profile(paths, &source)?;
                        Some(refinement::image_fingerprint(&decoded.image))
                    } else {
                        None
                    };
                    let stop_unknown =
                        !outcome.unknowns.is_empty() && config_text(node, "onUnknown") != "pass";
                    let mut reasons = outcome.failures.clone();
                    reasons.extend(
                        outcome
                            .unknowns
                            .iter()
                            .map(|reason| format!("Inconclusive: {reason}")),
                    );
                    let summary = if reasons.is_empty() {
                        if report
                            .observations
                            .iter()
                            .any(|item| item.metric_id == "visual.criteria")
                        {
                            "Technical and AI visual checks passed"
                        } else {
                            "Technical checks passed"
                        }
                        .to_string()
                    } else if outcome.failures.is_empty() && !stop_unknown {
                        format!(
                            "Continuing with inconclusive checks: {}",
                            outcome.unknowns.join("; ")
                        )
                    } else {
                        reasons.join("; ")
                    };
                    if let Some(first_attempt) = fingerprint
                        .as_ref()
                        .and_then(|digest| rejected_images.get(&(node.id.clone(), digest.clone())))
                    {
                        let reason = format!("Quality gate stopped: this image already failed checks on attempt {first_attempt}. Change the prompt, selection, or edit strength.");
                        database::workflow::record_result(
                            paths,
                            &request.run_id,
                            &node.id,
                            "workflow_gate",
                            &reason,
                        )?;
                        return Err(reason);
                    }
                    database::workflow::record_result(
                        paths,
                        &request.run_id,
                        &node.id,
                        "workflow_gate",
                        &summary,
                    )?;
                    if !outcome.failures.is_empty() || stop_unknown {
                        let reason = reasons.join("; ");
                        if stop_unknown || config_text(node, "onFailure") != "repeat" {
                            return Err(format!("Quality gate stopped: {reason}"));
                        }
                        if iteration == maximum {
                            return Err(format!(
                                "Quality gate failed after {maximum} attempts: {reason}"
                            ));
                        }
                        if let Some(digest) = fingerprint {
                            rejected_images.insert((node.id.clone(), digest), iteration);
                        }
                        retry = Some((reason, refinement::prompt_feedback(report)));
                        database::transition_node_execution(
                            paths,
                            &request.run_id,
                            &node.id,
                            "failed",
                            Some("workflow.gate"),
                            Some("Quality checks failed; repeating"),
                            Some(1.0),
                        )?;
                        break;
                    }
                    Some(WorkflowValue::Image(source))
                }
                "output.video" => {
                    let WorkflowValue::Video(source) = input(flow, &values, node, "video")? else {
                        return Err("Connect a video output".into());
                    };
                    let (_, bytes) = transform::read_asset_original(paths, source)?;
                    let record = database::get_asset(paths, source)?;
                    let digest = format!("{:x}", Sha256::digest(&bytes));
                    let relative = transform::cas_relative_path(&digest);
                    let asset = GeneratedImageAsset {
                        digest,
                        relative_path: relative.to_string_lossy().into_owned(),
                        byte_size: bytes.len() as u64,
                        mime_type: "video/webm",
                        width: record.width,
                        height: record.height,
                        output_index: 0,
                        subject_cutout: None,
                    };
                    database::workflow::publish(
                        paths,
                        &request.run_id,
                        &node.id,
                        iteration,
                        &asset,
                        "video",
                        std::slice::from_ref(source),
                        json!({"finalOutput":true}),
                    )?;
                    final_outputs += 1;
                    None
                }
                _ => {
                    let source = image()?;
                    let (_, decoded) = transform::read_asset_image_with_profile(paths, &source)?;
                    let transformed = match node.r#type.as_str() {
                        "operation.crop" => transform::apply_operation(
                            decoded.image,
                            &MediaImageTransformOperation::Crop {
                                x: config_number(node, "x", 0.0) as u32,
                                y: config_number(node, "y", 0.0) as u32,
                                width: config_number(node, "width", 512.0) as u32,
                                height: config_number(node, "height", 512.0) as u32,
                            },
                        )?,
                        "operation.resize" => transform::apply_operation(
                            decoded.image,
                            &MediaImageTransformOperation::Resize {
                                width: config_number(node, "width", 1024.0) as u32,
                                height: config_number(node, "height", 1024.0) as u32,
                                fit: config_text(node, "fit").to_string(),
                            },
                        )?,
                        "operation.color-adjust" => transform::apply_post_processing_operation(
                            decoded.image,
                            &MediaImagePostProcessingOperation::ColorAdjust {
                                node_id: node.id.clone(),
                                brightness: config_number(node, "brightness", 0.0) as i32,
                                contrast: config_number(node, "contrast", 0.0),
                                saturation: config_number(node, "saturation", 1.0),
                            },
                        )?,
                        "operation.sharpen" => transform::apply_post_processing_operation(
                            decoded.image,
                            &MediaImagePostProcessingOperation::Sharpen {
                                node_id: node.id.clone(),
                                sigma: config_number(node, "sigma", 1.0),
                                threshold: config_number(node, "threshold", 0.0) as i32,
                            },
                        )?,
                        "operation.subject-cutout" => {
                            let priority: Vec<String> = serde_json::from_value(
                                node.config
                                    .get("modelPriority")
                                    .cloned()
                                    .ok_or("Choose a cutout model")?,
                            )
                            .map_err(|e| e.to_string())?;
                            subject_cutout::cutout(paths, &decoded.image, &priority)?.cutout
                        }
                        "output.asset" => decoded.image,
                        _ => return Err(format!("{} is not executable", node.label)),
                    };
                    let is_output = node.r#type == "output.asset";
                    let asset = encode_image(
                        paths,
                        transformed,
                        if is_output {
                            config_text(node, "format")
                        } else {
                            "png"
                        },
                        config_number(node, "quality", 95.0) as u8,
                        config_text(node, "jpegBackground"),
                        decoded.icc_profile.as_deref(),
                    )?;
                    let id = database::workflow::publish(
                        paths,
                        &request.run_id,
                        &node.id,
                        iteration,
                        &asset,
                        "image",
                        &[source],
                        json!({"operation":node.r#type,"settings":node.config,"finalOutput":is_output}),
                    )?;
                    if is_output {
                        final_outputs += 1;
                        None
                    } else {
                        Some(WorkflowValue::Image(id))
                    }
                }
            };
            if let Some(value) = output {
                values.insert((node.id.clone(), output_port.to_string()), value);
            }
            completed.insert(node.id.clone());
            database::transition_node_execution(
                paths,
                &request.run_id,
                &node.id,
                "completed",
                Some("workflow.execute"),
                Some(&format!(
                    "Attempt {iteration}/{maximum} · {} completed",
                    node.label
                )),
                Some(1.0),
            )?;
        }
        if let Some((reason, next_feedback)) = retry {
            if let Some(repeat) =
                loop_node.filter(|repeat| config_text(repeat, "inputMode") == "previous")
            {
                let start = config_text(repeat, "startNodeId");
                let Some(WorkflowValue::Image(id)) =
                    values.get(&(start.to_string(), "image".into()))
                else {
                    return Err("The repeated edit produced no image to refine".into());
                };
                previous_image = Some(id.clone());
            }
            completed.retain(|id| !repeated.contains(id));
            values.retain(|(id, _), _| !repeated.contains(id));
            feedback = next_feedback;
            database::workflow::retry(paths, &request.run_id, repeated, iteration + 1, &reason)?;
        } else {
            return database::workflow::finish(paths, &request.run_id, final_outputs);
        }
    }
    Err("Workflow exhausted its attempt limit".into())
}

#[tauri::command]
pub(crate) async fn media_execute_workflow(
    app: AppHandle,
    mut request: ExecuteMediaWorkflowRequest,
) -> MediaCommandResult<MediaRunDetail> {
    let result = async {
        if request.schema_version != 1 {
            return Err("Unsupported workflow request".into());
        }
        let _sleep = inhibit_system_sleep_for_media_work(&app)?;
        let paths = MediaRuntimePaths::resolve(&app)?;
        database::ensure_initialized(&paths)?;
        let base = ExecuteLocalImageFlowRequest {
            schema_version: 1,
            run_id: request.run_id.clone(),
            flow_id: request.flow_id.clone(),
            flow_revision_id: request.flow_revision_id.clone(),
            plan_id: request.plan_id.clone(),
            plan_snapshot: request.plan_snapshot.clone(),
        };
        request
            .plan_snapshot
            .validate(&request.plan_id, &request.flow_id)?;
        let flow = flow::load_workflow(&paths, &request.flow_id, &request.flow_revision_id)?;
        let repeated = preflight(&flow, &request)?;
        tauri::async_runtime::spawn_blocking(move || {
            let state = app.state::<MediaRuntimeState>();
            let Some(_active) = state.claim_run(&request.run_id)? else {
                return database::get_run_detail(&paths, &request.run_id);
            };
            let prompt = flow
                .nodes
                .iter()
                .find(|node| node.r#type == "source.prompt")
                .map(|node| config_text(node, "prompt"))
                .unwrap_or("");
            let output_count = flow
                .nodes
                .iter()
                .filter(|node| node.r#type.starts_with("output."))
                .count();
            if !database::workflow::begin(&paths, &base, &flow.name, prompt, output_count)? {
                return database::get_run_detail(&paths, &request.run_id);
            }
            if let Err(error) = execute_started(&app, &paths, &request, &flow, &repeated) {
                if database::is_cancellation_requested(&paths, &request.run_id)? {
                    database::cancel_run(&paths, &request.run_id)?;
                } else {
                    database::fail_run(&paths, &request.run_id, &error)?;
                }
            }
            database::get_run_detail(&paths, &request.run_id)
        })
        .await
        .map_err(|e| format!("Workflow worker stopped: {e}"))?
    }
    .await;
    command_result("media_execute_workflow", result)
}

#[path = "workflow_operations.rs"]
mod operations;
#[path = "workflow_preservation.rs"]
mod preservation;
#[path = "workflow_refinement.rs"]
mod refinement;
#[path = "workflow_validation.rs"]
mod validation;
#[path = "workflow_visual.rs"]
mod visual;
use operations::{encode_image, generate_image};
use validation::{evaluate_gate, preflight};

#[cfg(test)]
#[path = "workflow_tests.rs"]
mod tests;
