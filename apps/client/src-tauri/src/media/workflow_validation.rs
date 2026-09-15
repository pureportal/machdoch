use super::*;

#[derive(Default)]
pub(crate) struct GateOutcome {
    pub failures: Vec<String>,
    pub unknowns: Vec<String>,
}

pub(crate) fn evaluate_gate(
    node: &MediaFlowNode,
    report: &MediaQualityReport,
    source: &str,
) -> MediaResult<GateOutcome> {
    if report.source_asset_id != source || report.profile.id != config_text(node, "profile") {
        return Err("The quality report does not match this image and profile".into());
    }
    let observation = |metric: &str| {
        report
            .observations
            .iter()
            .find(|item| item.metric_id == metric && item.status == "observed")
            .and_then(|item| item.value.as_ref())
    };
    let dimensions = observation("dimensions.exact");
    let mut outcome = GateOutcome::default();
    for (axis, key) in [("width", "minWidth"), ("height", "minHeight")] {
        match dimensions.and_then(|value| value[axis].as_f64()) {
            Some(value) if value < config_number(node, key, 512.0) => {
                outcome.failures.push(format!(
                    "{axis} is {value}px; requires {}px",
                    config_number(node, key, 512.0)
                ))
            }
            None => outcome.unknowns.push(format!("Could not measure {axis}")),
            _ => {}
        }
    }
    for metric in ["luma.clippedBlackRatio", "luma.clippedWhiteRatio"] {
        match observation(metric).and_then(Value::as_f64) {
            Some(value) if value > config_number(node, "maxClipping", 0.95) => {
                outcome.failures.push(format!(
                    "Clipped pixels {:.1}% exceed {:.1}%",
                    value * 100.0,
                    config_number(node, "maxClipping", 0.95) * 100.0
                ))
            }
            None => outcome
                .unknowns
                .push("Could not measure clipped pixels".into()),
            _ => {}
        }
    }
    if let Some(preservation) = report
        .observations
        .iter()
        .find(|item| item.metric_id == "edit.protectedPixels")
    {
        if preservation.input_asset_ids != [source.to_string()] {
            return Err("The preservation measurement belongs to a different image".into());
        }
        let counts = preservation.value.as_ref().and_then(|value| {
            Some((
                value["protectedPixels"].as_u64()?,
                value["changedPixels"].as_u64()?,
            ))
        });
        match counts {
            Some((protected, changed))
                if protected > 0 && changed <= protected && preservation.status == "observed" =>
            {
                if changed > 0 {
                    outcome
                        .failures
                        .push(format!("{changed} of {protected} protected pixels changed"));
                }
            }
            _ => outcome.unknowns.push(
                "Could not check protected pixels; the mask must leave an unchanged area".into(),
            ),
        }
    }
    if let Some(visual) = report
        .observations
        .iter()
        .find(|item| item.metric_id == "visual.criteria")
    {
        if visual.input_asset_ids != [source.to_string()] {
            return Err("The visual assessment belongs to a different image".into());
        }
        let checks = visual
            .value
            .as_ref()
            .and_then(|value| value["checks"].as_array());
        match checks {
            Some(checks) if !checks.is_empty() && visual.status == "observed" => {
                for check in checks {
                    let reason = format!(
                        "{}: {}",
                        check["criterion"].as_str().unwrap_or("Visual criterion"),
                        check["reason"]
                            .as_str()
                            .unwrap_or("No visible evidence returned")
                    );
                    match check["verdict"].as_str() {
                        Some("pass") => {}
                        Some("fail") => outcome.failures.push(reason),
                        _ => outcome.unknowns.push(reason),
                    }
                }
            }
            _ => outcome
                .unknowns
                .push("The visual assessment is incomplete".into()),
        }
    }
    Ok(outcome)
}

pub(super) fn preflight(
    flow: &MediaFlowDocument,
    request: &ExecuteMediaWorkflowRequest,
) -> MediaResult<HashSet<String>> {
    let loops: Vec<_> = flow
        .nodes
        .iter()
        .filter(|node| node.r#type == "control.repeat")
        .collect();
    if loops.len() > 1 {
        return Err("Use one refinement loop per workflow".into());
    }
    let repeated = if let Some(node) = loops.first() {
        let start = config_text(node, "startNodeId");
        if !flow.nodes.iter().any(|node| {
            node.id == start
                && matches!(
                    node.r#type.as_str(),
                    "task.generate-image"
                        | "task.edit-image"
                        | "task.generate-prompt"
                        | "operation.resize"
                        | "operation.upscale"
                )
        }) {
            return Err("Choose the first step to repeat".into());
        }
        if config_text(node, "inputMode") == "previous"
            && !flow
                .nodes
                .iter()
                .any(|node| node.id == start && node.r#type == "task.edit-image")
        {
            return Err("Choose an Edit image step to refine its previous result".into());
        }
        workflow_schema::descendants(flow, start)
    } else {
        HashSet::new()
    };
    if !flow
        .nodes
        .iter()
        .any(|node| node.r#type.starts_with("output."))
    {
        return Err("Add an output to this workflow".into());
    }
    for node in &flow.nodes {
        if !matches!(
            node.r#type.as_str(),
            "source.prompt"
                | "source.image"
                | "source.seed"
                | "task.generate-prompt"
                | "task.generate-image"
                | "task.edit-image"
                | "task.generate-video"
                | "operation.segment"
                | "operation.canny"
                | "operation.image-mask"
                | "operation.mask-composite"
                | "operation.depth-map"
                | "operation.controlnet"
                | "operation.prepare-mask"
                | "operation.visual-check"
                | "operation.upscale"
                | "operation.crop"
                | "operation.resize"
                | "operation.color-adjust"
                | "operation.sharpen"
                | "operation.subject-cutout"
                | "operation.quality-analyze"
                | "control.quality-gate"
                | "control.repeat"
                | "output.asset"
                | "output.video"
        ) {
            return Err(format!("{} cannot run in a connected workflow", node.label));
        }
        if matches!(
            node.r#type.as_str(),
            "task.generate-image" | "task.edit-image" | "task.generate-video"
        ) {
            let model = request
                .model_bindings
                .get(&node.id)
                .ok_or_else(|| format!("Choose a model for {}", node.label))?;
            if !model.starts_with("local:") {
                return Err("Connected workflows require local generation models".into());
            }
            if node
                .config
                .get("modelId")
                .and_then(Value::as_str)
                .is_some_and(|id| id != model)
            {
                return Err("The workflow model differs from its saved revision".into());
            }
            if node
                .config
                .get("outputCount")
                .and_then(Value::as_u64)
                .is_some_and(|v| v != 1)
                || config_text(node, "outputFormat") == "svg"
            {
                return Err("Use one raster image per generation step".into());
            }
        }
        if matches!(
            node.r#type.as_str(),
            "operation.segment"
                | "operation.upscale"
                | "task.generate-prompt"
                | "operation.visual-check"
        ) && !std::path::Path::new(config_text(node, "modelPath")).exists()
        {
            return Err(format!("Choose the model for {}", node.label));
        }
        if node.r#type == "operation.segment" && config_text(node, "query").trim().is_empty() {
            return Err("Enter the object to select".into());
        }
        if node.r#type == "operation.visual-check" {
            if flow
                .edges
                .iter()
                .any(|edge| edge.to_node_id == node.id && edge.to_port_id == "mask")
                && !flow
                    .edges
                    .iter()
                    .any(|edge| edge.to_node_id == node.id && edge.to_port_id == "reference")
            {
                return Err("Connect the mask's original image as the reference".into());
            }
            let criteria: Vec<_> = config_text(node, "criteria")
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect();
            if criteria.is_empty()
                || criteria.len() > 8
                || criteria.iter().any(|line| line.chars().count() > 500)
            {
                return Err(
                    "Enter one to eight visual criteria, one per line (up to 500 characters each)"
                        .into(),
                );
            }
        }
        if node.r#type == "operation.prepare-mask" {
            let connected = flow
                .edges
                .iter()
                .any(|edge| edge.to_node_id == node.id && edge.to_port_id == "mask");
            let painted = node
                .config
                .get("editMask")
                .is_some_and(|mask| !mask.is_null());
            if connected == painted {
                return Err("Paint a selection or connect a mask; use one selection source".into());
            }
        }
        if node.r#type == "control.quality-gate" {
            if config_text(node, "onUnknown") == "human-review" {
                return Err("Choose Stop or Continue for an inconclusive quality check".into());
            }
            if config_text(node, "onFailure") == "repeat" && !repeated.contains(&node.id) {
                return Err("The retry gate must follow the first repeated step".into());
            }
            let incoming = |id: &str, port: &str| {
                flow.edges
                    .iter()
                    .find(|edge| edge.to_node_id == id && edge.to_port_id == port)
            };
            let report = incoming(&node.id, "report").ok_or("Connect a quality report")?;
            let analyzed = incoming(&report.from_node_id, "image")
                .ok_or("Connect an image to the quality check")?;
            let image =
                incoming(&node.id, "image").ok_or("Connect the analyzed image to the gate")?;
            if analyzed.from_node_id != image.from_node_id
                || analyzed.from_port_id != image.from_port_id
            {
                return Err("Connect the same image to the quality check and its gate".into());
            }
        }
    }
    if let Some(loop_node) = loops.first() {
        let mut ungated = HashSet::from([config_text(loop_node, "startNodeId").to_string()]);
        for _ in 0..flow.nodes.len() {
            for edge in &flow.edges {
                let is_gate = flow.nodes.iter().any(|node| {
                    node.id == edge.from_node_id
                        && node.r#type == "control.quality-gate"
                        && config_text(node, "onFailure") == "repeat"
                });
                if ungated.contains(&edge.from_node_id) && !is_gate {
                    ungated.insert(edge.to_node_id.clone());
                }
            }
        }
        if flow
            .nodes
            .iter()
            .any(|node| node.r#type.starts_with("output.") && ungated.contains(&node.id))
        {
            return Err("Connect repeated outputs through the retry gate".into());
        }
    }
    if !loops.is_empty()
        && !flow.nodes.iter().any(|node| {
            node.r#type == "control.quality-gate"
                && config_text(node, "onFailure") == "repeat"
                && repeated.contains(&node.id)
        })
    {
        return Err("The refinement loop requires a retry gate".into());
    }
    Ok(repeated)
}
