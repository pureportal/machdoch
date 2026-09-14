use super::*;

pub(super) fn check_image(
    app: &AppHandle,
    paths: &MediaRuntimePaths,
    request: &ExecuteMediaWorkflowRequest,
    flow: &MediaFlowDocument,
    values: &Values,
    node: &MediaFlowNode,
    report: &mut MediaQualityReport,
) -> MediaResult<()> {
    let mut config = Value::Object(node.config.clone());
    let reference = match optional_input(flow, values, node, "reference")? {
        Some(WorkflowValue::Image(id)) => Some(id.clone()),
        Some(_) => return Err("Connect a reference image".into()),
        None => None,
    };
    if let Some(mask) = optional_input(flow, values, node, "mask")? {
        let reference = reference
            .as_deref()
            .ok_or("Connect the mask's original image as the reference")?;
        let WorkflowValue::Mask {
            asset_id,
            source_id,
        } = mask
        else {
            return Err("Connect the edit mask to check protected pixels".into());
        };
        if source_id != reference {
            return Err("The edit mask belongs to a different reference image".into());
        }
        let observation = preservation::measure_preservation(
            paths,
            &report.source_asset_id,
            reference,
            asset_id,
        )?;
        if let Some(value) = &observation.value {
            if value["changedPixels"]
                .as_u64()
                .is_some_and(|count| count > 0)
            {
                report.verdict = "fail".into();
            } else if value["protectedPixels"] == 0 && report.verdict != "fail" {
                report.verdict = "unknown".into();
            }
        }
        report.observations.push(observation);
    }
    let visual_reference = reference.filter(|_| {
        node.config
            .get("compareReference")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    });
    config["referenceAssetId"] = json!(visual_reference);
    let (result, _) = provider_local_diffusers::workflow_operation(
        app,
        paths,
        &request.run_id,
        "visual-check",
        config,
        Some(&report.source_asset_id),
    )?;
    let criteria: Vec<_> = config_text(node, "criteria")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let checks = result["checks"]
        .as_array()
        .ok_or("The vision model returned no assessment")?;
    if checks.len() != criteria.len()
        || checks.iter().zip(&criteria).any(|(check, criterion)| {
            check["criterion"].as_str() != Some(*criterion)
                || !matches!(check["verdict"].as_str(), Some("pass" | "fail" | "unknown"))
                || check["reason"]
                    .as_str()
                    .is_none_or(|reason| reason.trim().is_empty() || reason.chars().count() > 1000)
        })
    {
        return Err("The visual assessment does not match the requested criteria".into());
    }
    let reviews = result["reviews"]
        .as_array()
        .ok_or("The visual reviews are missing")?;
    if reviews.len() != config_number(node, "reviewPasses", 2.0) as usize {
        return Err("The visual assessment is missing a review pass".into());
    }
    validate_reviews(checks, reviews, &criteria)?;
    let mut review_summaries = Vec::new();
    for (index, review) in reviews.iter().enumerate() {
        let results = review["checks"]
            .as_array()
            .ok_or("The visual review is incomplete")?;
        if results.len() != criteria.len() {
            return Err("The visual review is missing criteria".into());
        }
        let summary = results
            .iter()
            .map(|check| {
                format!(
                    "{} · {}: {}",
                    check["verdict"].as_str().unwrap_or("unknown"),
                    check["criterion"].as_str().unwrap_or(""),
                    check["reason"].as_str().unwrap_or("")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        review_summaries.push(format!("Review {}/{}\n{summary}", index + 1, reviews.len()));
    }
    let messages: Vec<_> = checks
        .iter()
        .map(|check| {
            format!(
                "{} · {}: {}",
                check["verdict"].as_str().unwrap(),
                check["criterion"].as_str().unwrap(),
                check["reason"].as_str().unwrap()
            )
        })
        .collect();
    database::workflow::record_result(
        paths,
        &request.run_id,
        &node.id,
        "workflow_visual",
        &format!(
            "{}\n\n{}",
            messages.join("\n"),
            review_summaries.join("\n\n")
        ),
    )?;
    if checks.iter().any(|check| check["verdict"] == "fail") {
        report.verdict = "fail".into();
    } else if checks.iter().any(|check| check["verdict"] == "unknown") && report.verdict != "fail" {
        report.verdict = "unknown".into();
    }
    report.gate_reasons.extend(messages);
    report.observations.push(MediaQualityObservation {
        metric_id: "visual.criteria".into(), metric_version: "2.0.0".into(),
        family: "learned".into(), scope: "asset".into(), status: "observed".into(),
        value: Some(json!({"checks":checks,"reviews":reviews,"modelType":result["modelType"],"modelPath":node.config["modelPath"],"maxPixels":node.config["maxPixels"]})),
        unit: None, direction: None, input_asset_ids: vec![report.source_asset_id.clone()],
        reference_asset_ids: visual_reference.into_iter().collect(), evaluator: None,
        preprocessing_profile_id: "qwen3-vl-rgb-bounded-v1".into(), sampling_profile_id: None,
        calibration_profile_id: None, confidence: None,
        limitations: vec!["AI assessments are uncalibrated and can miss visual defects.".into()],
    });
    Ok(())
}

pub(super) fn validate_reviews(
    checks: &[Value],
    reviews: &[Value],
    criteria: &[&str],
) -> MediaResult<()> {
    if reviews.is_empty() || reviews.len() > 3 || checks.len() != criteria.len() {
        return Err("The visual assessment is incomplete".into());
    }
    for review in reviews {
        let items = review["checks"]
            .as_array()
            .ok_or("The visual review is incomplete")?;
        if !review["rawResponse"].is_string()
            || items.len() != criteria.len()
            || items.iter().zip(criteria).any(|(check, criterion)| {
                check["criterion"].as_str() != Some(*criterion)
                    || !matches!(check["verdict"].as_str(), Some("pass" | "fail" | "unknown"))
                    || check["reason"].as_str().is_none_or(|reason| {
                        reason.trim().is_empty() || reason.chars().count() > 1000
                    })
            })
        {
            return Err("The visual review does not match the requested criteria".into());
        }
    }
    for (index, check) in checks.iter().enumerate() {
        let first = &reviews[0]["checks"][index]["verdict"];
        let expected = if reviews
            .iter()
            .all(|review| &review["checks"][index]["verdict"] == first)
        {
            first.as_str().unwrap()
        } else {
            "unknown"
        };
        if check["verdict"].as_str() != Some(expected) {
            return Err("The visual assessment contradicts its review passes".into());
        }
    }
    Ok(())
}
