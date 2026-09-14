use super::*;

fn gate() -> MediaFlowNode {
    serde_json::from_value(json!({"id":"gate","type":"control.quality-gate","version":1,"label":"Quality gate","layer":"control","config":{"profile":"technical-image-baseline","minWidth":512,"minHeight":512,"maxClipping":0.2,"onUnknown":"fail","onFailure":"repeat"}})).unwrap()
}

fn report(width: u32, clipping: f64) -> MediaQualityReport {
    let observations: Vec<Value> = json!([
        {"metricId":"dimensions.exact","value":{"width":width,"height":512}},
        {"metricId":"luma.clippedBlackRatio","value":clipping},
        {"metricId":"luma.clippedWhiteRatio","value":0.01}
    ]).as_array().unwrap().iter().map(|entry| {
        let mut item = entry.as_object().unwrap().clone();
        item.extend(json!({"metricVersion":"1.0.0","family":"technical","scope":"asset","status":"observed","inputAssetIds":["image"],"referenceAssetIds":[],"preprocessingProfileId":"test","limitations":[]}).as_object().unwrap().clone());
        Value::Object(item)
    }).collect();
    serde_json::from_value(json!({"schemaVersion":1,"sourceAssetId":"image","analyzedAt":"2026-09-14T00:00:00Z","profile":{"id":"technical-image-baseline","version":"1.0.0","description":""},"verdict":"pass","gateReasons":[],"observations":observations})).unwrap()
}

#[test]
fn gate_uses_measured_thresholds_instead_of_a_report_verdict() {
    assert!(evaluate_gate(&gate(), &report(512, 0.1), "image")
        .unwrap()
        .failures
        .is_empty());
    let failures = evaluate_gate(&gate(), &report(256, 0.3), "image").unwrap();
    assert_eq!(failures.failures.len(), 2);
    assert!(failures.failures[0].contains("256px"));
    assert!(failures.failures[1].contains("30.0%"));
}

#[test]
fn gate_refuses_stale_image_or_profile_evidence() {
    assert!(evaluate_gate(&gate(), &report(512, 0.1), "different-image").is_err());
    let mut wrong_profile = report(512, 0.1);
    wrong_profile.profile.id = "different-profile".into();
    assert!(evaluate_gate(&gate(), &wrong_profile, "image").is_err());
}

#[test]
fn inconclusive_measurements_follow_the_explicit_policy() {
    let mut missing = report(512, 0.1);
    missing.observations.clear();
    assert_eq!(
        evaluate_gate(&gate(), &missing, "image")
            .unwrap()
            .unknowns
            .len(),
        4
    );
    let mut permissive = gate();
    permissive.config.insert("onUnknown".into(), json!("pass"));
    let outcome = evaluate_gate(&permissive, &missing, "image").unwrap();
    assert!(outcome.failures.is_empty());
    assert_eq!(outcome.unknowns.len(), 4);
}

#[test]
fn repeats_reject_unbounded_attempts_and_invalid_seed_steps() {
    let mut repeat: MediaFlowNode = serde_json::from_value(json!({"id":"repeat","type":"control.repeat","version":1,"label":"Repeat","layer":"control","config":{"startNodeId":"generate","maxIterations":3,"seedStep":1,"feedback":true,"inputMode":"original"}})).unwrap();
    assert!(workflow_schema::validate_node(&repeat).is_ok());
    for invalid in [json!(0), json!(21), json!(1.5)] {
        repeat.config.insert("maxIterations".into(), invalid);
        assert!(workflow_schema::validate_node(&repeat).is_err());
    }
    repeat.config.insert("maxIterations".into(), json!(3));
    repeat.config.insert("seedStep".into(), json!(0));
    assert!(workflow_schema::validate_node(&repeat).is_err());
}

#[test]
fn visual_evidence_can_reject_a_technically_valid_image() {
    for verdict in ["pass", "fail", "unknown"] {
        let mut assessed = report(512, 0.1);
        let mut observation = assessed.observations[0].clone();
        observation.metric_id = "visual.criteria".into();
        observation.value = Some(
            json!({"checks":[{"criterion":"One handle","verdict":verdict,"reason":"Visible handle count"}]}),
        );
        assessed.observations.push(observation);
        let outcome = evaluate_gate(&gate(), &assessed, "image").unwrap();
        assert_eq!(outcome.failures.len(), usize::from(verdict == "fail"));
        assert_eq!(outcome.unknowns.len(), usize::from(verdict == "unknown"));
        assessed.observations.last_mut().unwrap().input_asset_ids = vec!["another-image".into()];
        assert!(evaluate_gate(&gate(), &assessed, "image").is_err());
    }
}

#[test]
fn visual_reference_comparison_requires_a_boolean_setting() {
    let mut node: MediaFlowNode = serde_json::from_value(json!({"id":"check","type":"operation.visual-check","version":1,"label":"Check image","layer":"operation","config":{"criteria":"The dress is blue.","modelPath":"C:/vision","maxPixels":1048576,"maxTokens":768,"reviewPasses":2}})).unwrap();
    assert!(workflow_schema::validate_node(&node).is_ok());
    for value in [true, false] {
        node.config.insert("compareReference".into(), json!(value));
        assert!(workflow_schema::validate_node(&node).is_ok());
    }
    node.config
        .insert("compareReference".into(), json!("false"));
    assert!(workflow_schema::validate_node(&node).is_err());
}

#[test]
fn preservation_counts_single_channel_changes_including_alpha_and_ignores_editable_pixels() {
    let original = image::RgbaImage::from_pixel(8, 8, image::Rgba([120, 30, 20, 255]));
    let mut result = original.clone();
    let mut mask = image::GrayImage::new(8, 8);
    mask.put_pixel(2, 2, image::Luma([1]));
    result.put_pixel(2, 2, image::Rgba([0, 0, 255, 255]));
    result.put_pixel(3, 3, image::Rgba([121, 30, 20, 255]));
    result.put_pixel(4, 4, image::Rgba([120, 30, 20, 254]));
    let measured =
        preservation::protected_pixels(&result.into(), &original.clone().into(), &mask.into())
            .unwrap();
    assert_eq!(
        measured,
        json!({"protectedPixels":63,"changedPixels":2,"maxChannelDifference":1})
    );
    assert!(preservation::protected_pixels(
        &original.clone().into(),
        &DynamicImage::new_rgb8(9, 8),
        &DynamicImage::new_luma8(8, 8)
    )
    .is_err());
}

#[test]
fn preservation_gate_requires_nonempty_valid_measurements_and_rejects_drift() {
    for (protected, changed, expected_failures, expected_unknowns) in
        [(100, 0, 0, 0), (100, 1, 1, 0), (0, 0, 0, 1), (10, 11, 0, 1)]
    {
        let mut assessed = report(512, 0.1);
        let mut observation = assessed.observations[0].clone();
        observation.metric_id = "edit.protectedPixels".into();
        observation.value = Some(json!({"protectedPixels":protected,"changedPixels":changed}));
        assessed.observations.push(observation);
        let outcome = evaluate_gate(&gate(), &assessed, "image").unwrap();
        assert_eq!(outcome.failures.len(), expected_failures);
        assert_eq!(outcome.unknowns.len(), expected_unknowns);
        assessed.observations.last_mut().unwrap().input_asset_ids = vec!["other".into()];
        assert!(evaluate_gate(&gate(), &assessed, "image").is_err());
    }
}

#[test]
fn aggregate_visual_verdicts_must_agree_with_every_review() {
    let check = |verdict: &str| json!({"criterion":"One handle","verdict":verdict,"reason":"Visible count"});
    for verdicts in [
        ["pass", "pass"],
        ["fail", "fail"],
        ["pass", "fail"],
        ["pass", "unknown"],
    ] {
        let reviews: Vec<_> = verdicts
            .iter()
            .map(|verdict| json!({"checks":[check(verdict)],"rawResponse":"{}"}))
            .collect();
        let expected = if verdicts[0] == verdicts[1] {
            verdicts[0]
        } else {
            "unknown"
        };
        assert!(visual::validate_reviews(&[check(expected)], &reviews, &["One handle"]).is_ok());
        assert!(
            visual::validate_reviews(&[check("pass")], &reviews, &["One handle"]).is_ok()
                == (expected == "pass")
        );
        assert!(visual::validate_reviews(&[check(expected)], &reviews, &["Two handles"]).is_err());
    }
}

#[test]
fn refinement_feedback_contains_only_failed_requirements() {
    let mut assessed = report(256, 0.8);
    let mut visual = assessed.observations[0].clone();
    visual.metric_id = "visual.criteria".into();
    visual.value = Some(json!({"checks":[
        {"criterion":"The dress is blue","verdict":"fail","reason":"A red dress is visible"},
        {"criterion":"The face is unchanged","verdict":"pass","reason":"Same face"},
        {"criterion":"The serial number is legible","verdict":"unknown","reason":"Not visible"}
    ]}));
    assessed.observations.push(visual);
    assert_eq!(
        refinement::prompt_feedback(&assessed),
        "Required corrections:\n- The dress is blue"
    );
    assert!(refinement::prompt_feedback(&report(256, 0.8)).is_empty());
}

#[test]
fn repeated_image_detection_uses_pixels_and_dimensions_not_encoding() {
    let image =
        DynamicImage::ImageRgb8(image::RgbImage::from_pixel(4, 4, image::Rgb([10, 30, 40])));
    let rgba = DynamicImage::ImageRgba8(image.to_rgba8());
    assert_eq!(
        refinement::image_fingerprint(&image),
        refinement::image_fingerprint(&rgba)
    );
    let mut changed = rgba.to_rgba8();
    changed.put_pixel(1, 1, image::Rgba([11, 30, 40, 255]));
    assert_ne!(
        refinement::image_fingerprint(&image),
        refinement::image_fingerprint(&changed.into())
    );
    let reshaped = image::RgbImage::from_pixel(2, 8, image::Rgb([10, 30, 40]));
    assert_ne!(
        refinement::image_fingerprint(&image),
        refinement::image_fingerprint(&reshaped.into())
    );
}
