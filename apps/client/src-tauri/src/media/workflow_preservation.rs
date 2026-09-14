use super::*;

pub(super) fn measure_preservation(
    paths: &MediaRuntimePaths,
    source: &str,
    reference: &str,
    mask_id: &str,
) -> MediaResult<MediaQualityObservation> {
    let (_, result) = transform::read_asset_image_with_profile(paths, source)?;
    let (_, original) = transform::read_asset_image_with_profile(paths, reference)?;
    let (_, mask) = transform::read_asset_image_with_profile(paths, mask_id)?;
    let value = protected_pixels(&result.image, &original.image, &mask.image)?;
    Ok(MediaQualityObservation {
        metric_id: "edit.protectedPixels".into(),
        metric_version: "1.0.0".into(),
        family: "technical".into(),
        scope: "asset".into(),
        status: "observed".into(),
        value: Some(value),
        unit: Some("pixels".into()),
        direction: None,
        input_asset_ids: vec![source.into()],
        reference_asset_ids: vec![reference.into(), mask_id.into()],
        evaluator: None,
        preprocessing_profile_id: "rgba8-exact-zero-mask-v1".into(),
        sampling_profile_id: None,
        calibration_profile_id: None,
        confidence: None,
        limitations: vec!["Measures unchanged pixels outside the edit mask; does not assess lighting or edges inside it.".into()],
    })
}

pub(super) fn protected_pixels(
    result: &DynamicImage,
    reference: &DynamicImage,
    mask: &DynamicImage,
) -> MediaResult<Value> {
    let dimensions = |image: &DynamicImage| (image.width(), image.height());
    if dimensions(result) != dimensions(reference) || dimensions(result) != dimensions(mask) {
        return Err("Preservation checks require an image, reference, and mask with matching dimensions. Check the edit before resizing or upscaling.".into());
    }
    let mut protected = 0_u64;
    let mut changed = 0_u64;
    let mut max_delta = 0_u8;
    for ((result, reference), mask) in result
        .to_rgba8()
        .pixels()
        .zip(reference.to_rgba8().pixels())
        .zip(mask.to_luma8().pixels())
    {
        if mask.0[0] != 0 {
            continue;
        }
        protected += 1;
        let delta = result
            .0
            .iter()
            .zip(reference.0)
            .map(|(a, b)| a.abs_diff(b))
            .max()
            .unwrap();
        if delta != 0 {
            changed += 1;
            max_delta = max_delta.max(delta);
        }
    }
    Ok(
        json!({"protectedPixels":protected,"changedPixels":changed,"maxChannelDifference":max_delta}),
    )
}
