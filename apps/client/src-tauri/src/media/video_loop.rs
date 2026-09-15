use serde::{Deserialize, Serialize};

use super::MediaResult;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoLoopBoundaryEvidence {
    frame_indices: [u32; 4],
    transition_mae: [f64; 3],
    appearance_ratio: f64,
    alpha_transition_mae: [f64; 3],
    alpha_appearance_ratio: f64,
    motion_mean_pixels: [f64; 3],
    speed_ratio: f64,
    velocity_change_mean_pixels: [f64; 2],
    velocity_change_ratio: f64,
    neighbor_motion_alignment: f64,
    motion_measurable: bool,
}

impl VideoLoopBoundaryEvidence {
    fn validate(&self, frame_count: u32, index: u32, allow_reversal: bool) -> MediaResult<()> {
        let measurements = self
            .transition_mae
            .iter()
            .chain(self.motion_mean_pixels.iter())
            .chain(self.alpha_transition_mae.iter())
            .chain(self.velocity_change_mean_pixels.iter())
            .copied()
            .chain([
                self.appearance_ratio,
                self.alpha_appearance_ratio,
                self.speed_ratio,
                self.velocity_change_ratio,
            ]);
        if frame_count < 4
            || !self.neighbor_motion_alignment.is_finite()
            || !(-1.0..=1.0).contains(&self.neighbor_motion_alignment)
            || self.frame_indices
                != [
                    (index + frame_count - 2) % frame_count,
                    (index + frame_count - 1) % frame_count,
                    index,
                    (index + 1) % frame_count,
                ]
            || measurements
                .into_iter()
                .any(|value| !value.is_finite() || value < 0.0)
        {
            return Err("Video loop measurements are invalid".to_string());
        }
        let speed_reference = (self.motion_mean_pixels[0] + self.motion_mean_pixels[2]) / 2.0;
        let appearance_ratio = self.transition_mae[1]
            / ((self.transition_mae[0] + self.transition_mae[2]) / 2.0).max(1.0);
        let speed_ratio = self.motion_mean_pixels[1] / speed_reference.max(0.1);
        let alpha_ratio = self.alpha_transition_mae[1]
            / ((self.alpha_transition_mae[0] + self.alpha_transition_mae[2]) / 2.0).max(1.0);
        let velocity_ratio = self.velocity_change_mean_pixels[0]
            .max(self.velocity_change_mean_pixels[1])
            / (self.motion_mean_pixels.iter().sum::<f64>() / 3.0).max(0.1);
        if (appearance_ratio - self.appearance_ratio).abs() > 1e-6
            || (alpha_ratio - self.alpha_appearance_ratio).abs() > 1e-6
            || (speed_ratio - self.speed_ratio).abs() > 1e-6
            || (velocity_ratio - self.velocity_change_ratio).abs() > 1e-6
            || self.motion_measurable != (speed_reference.max(self.motion_mean_pixels[1]) >= 0.25)
        {
            return Err("Video loop measurements are inconsistent".to_string());
        }
        let appearance_discontinuity = [
            (self.appearance_ratio, self.transition_mae),
            (self.alpha_appearance_ratio, self.alpha_transition_mae),
        ]
        .iter()
        .any(|(ratio, changes)| {
            *ratio > 1.25 && changes[1] - (changes[0] + changes[2]) / 2.0 > 1.0
        });
        let smooth_turn =
            self.neighbor_motion_alignment <= -0.5 && self.velocity_change_ratio <= 1.5;
        if appearance_discontinuity
            || (self.motion_measurable
                && (self.speed_ratio > 2.0
                    || (self.speed_ratio < 0.4 && !smooth_turn)
                    || (!allow_reversal && self.velocity_change_ratio > 1.5)))
        {
            return Err(
                "Video loop has a discontinuity; try more frames or another loop mode".to_string(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VideoLoopBoundaryInspection {
    generated: Vec<VideoLoopBoundaryEvidence>,
    decoded: Vec<VideoLoopBoundaryEvidence>,
}

pub(crate) fn output_frame_count(source_frames: u32, loop_mode: &str) -> MediaResult<u32> {
    if !(8..=257).contains(&source_frames) {
        return Err("Video loop source frame count is invalid".to_string());
    }
    match loop_mode {
        "none" => Ok(source_frames),
        "ping-pong" => Ok(source_frames * 2 - 2),
        "seamless" => Ok(source_frames - 1),
        "crossfade" => Ok(source_frames - ((source_frames - 1) / 2).min(24)),
        _ => Err("Video loop mode is invalid".to_string()),
    }
}

pub(crate) fn validate_inspection(
    inspection: Option<&VideoLoopBoundaryInspection>,
    source_frames: u32,
    loop_mode: &str,
) -> MediaResult<()> {
    let frame_count = output_frame_count(source_frames, loop_mode)?;
    if loop_mode == "none" {
        return if inspection.is_none() {
            Ok(())
        } else {
            Err("One-way video returned loop inspection".to_string())
        };
    }
    let inspection =
        inspection.ok_or_else(|| "Video loop omitted transition inspection".to_string())?;
    let indices: Vec<u32> = match loop_mode {
        "crossfade" => std::iter::once(0)
            .chain(frame_count - (source_frames - frame_count)..frame_count)
            .collect(),
        "ping-pong" => vec![0, source_frames - 1],
        _ => vec![0],
    };
    for measurements in [&inspection.generated, &inspection.decoded] {
        if measurements.len() != indices.len() {
            return Err("Video loop omitted transition measurements".to_string());
        }
        for (measurement, index) in measurements.iter().zip(&indices) {
            measurement.validate(frame_count, *index, loop_mode == "ping-pong")?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evidence() -> serde_json::Value {
        let boundary = serde_json::json!({
            "frameIndices": [14, 15, 0, 1],
            "transitionMae": [4.0, 4.0, 4.0],
            "appearanceRatio": 1.0,
            "alphaTransitionMae": [0.0, 0.0, 0.0],
            "alphaAppearanceRatio": 0.0,
            "motionMeanPixels": [2.0, 2.0, 2.0],
            "speedRatio": 1.0,
            "velocityChangeMeanPixels": [0.2, 0.2],
            "velocityChangeRatio": 0.1,
            "neighborMotionAlignment": 1.0,
            "motionMeasurable": true
        });
        serde_json::json!({
            "generated": [boundary],
            "decoded": [boundary]
        })
    }

    #[test]
    fn accepts_a_measured_cycle() {
        let decoded: VideoLoopBoundaryInspection = serde_json::from_value(evidence()).unwrap();
        assert!(validate_inspection(Some(&decoded), 17, "seamless").is_ok());
    }

    #[test]
    fn rejects_a_hold_or_reversal_even_when_pixel_change_is_normal() {
        for (speed, change) in [(0.0, 1.0), (1.0, 2.0), (3.0, 0.5)] {
            let mut value = evidence();
            value["decoded"][0]["speedRatio"] = speed.into();
            value["decoded"][0]["motionMeanPixels"][1] = (speed * 2.0).into();
            value["decoded"][0]["velocityChangeRatio"] = change.into();
            let delta = change * (4.0 + speed * 2.0) / 3.0;
            value["decoded"][0]["velocityChangeMeanPixels"] = serde_json::json!([delta, delta]);
            let decoded: VideoLoopBoundaryInspection = serde_json::from_value(value).unwrap();
            assert!(validate_inspection(Some(&decoded), 17, "seamless").is_err());
        }
    }

    #[test]
    fn rejects_missing_measurements_and_incorrect_frame_indices() {
        let mut value = evidence();
        value.as_object_mut().unwrap().remove("decoded");
        assert!(serde_json::from_value::<VideoLoopBoundaryInspection>(value).is_err());
        let decoded: VideoLoopBoundaryInspection = serde_json::from_value(evidence()).unwrap();
        assert!(validate_inspection(Some(&decoded), 21, "seamless").is_err());
        assert!(validate_inspection(Some(&decoded), 1, "seamless").is_err());
        assert!(validate_inspection(None, 17, "seamless").is_err());
        assert!(validate_inspection(None, 17, "crossfade").is_err());
    }

    #[test]
    fn rejects_a_visual_snap_and_nonfinite_measurements() {
        let mut decoded: VideoLoopBoundaryInspection = serde_json::from_value(evidence()).unwrap();
        decoded.generated[0].appearance_ratio = 2.0;
        decoded.generated[0].transition_mae[1] = 8.0;
        assert!(validate_inspection(Some(&decoded), 17, "seamless").is_err());
        decoded.generated[0].appearance_ratio = f64::NAN;
        assert!(validate_inspection(Some(&decoded), 17, "seamless").is_err());
    }

    #[test]
    fn requires_every_crossfade_transition_in_order_before_and_after_encoding() {
        let mut value = evidence();
        let entries: Vec<_> = [0u32, 1, 2, 3, 4, 5, 6, 7, 8]
            .iter()
            .map(|index| {
                let mut entry = value["generated"][0].clone();
                entry["frameIndices"] =
                    serde_json::json!([(index + 7) % 9, (index + 8) % 9, index, (index + 1) % 9]);
                entry
            })
            .collect();
        value["generated"] = serde_json::json!(entries);
        value["decoded"] = serde_json::json!(entries);
        let good: VideoLoopBoundaryInspection = serde_json::from_value(value.clone()).unwrap();
        assert!(validate_inspection(Some(&good), 17, "crossfade").is_ok());
        value["decoded"].as_array_mut().unwrap().remove(2);
        let incomplete: VideoLoopBoundaryInspection = serde_json::from_value(value).unwrap();
        assert!(validate_inspection(Some(&incomplete), 17, "crossfade").is_err());
        let mut invalid = good;
        invalid.generated[2].velocity_change_ratio = 0.0;
        assert!(validate_inspection(Some(&invalid), 17, "crossfade").is_err());
    }

    #[test]
    fn resolves_source_and_delivery_counts_without_adding_frames() {
        for (source, expected) in [(9, 5), (17, 9), (33, 17), (121, 97), (129, 105), (257, 233)] {
            assert_eq!(output_frame_count(source, "crossfade").unwrap(), expected);
        }
        assert_eq!(output_frame_count(17, "ping-pong").unwrap(), 32);
        assert_eq!(output_frame_count(17, "seamless").unwrap(), 16);
        assert_eq!(output_frame_count(17, "none").unwrap(), 17);
        assert!(output_frame_count(3, "crossfade").is_err());
        assert!(output_frame_count(17, "unknown").is_err());
    }

    #[test]
    fn accepts_slow_smooth_turns_but_rejects_holds_and_invalid_alignment() {
        let mut inspection: VideoLoopBoundaryInspection =
            serde_json::from_value(evidence()).unwrap();
        let boundary = &mut inspection.generated[0];
        boundary.motion_mean_pixels = [4.0, 1.0, 2.0];
        boundary.speed_ratio = 1.0 / 3.0;
        boundary.velocity_change_mean_pixels = [3.0, 3.0];
        boundary.velocity_change_ratio = 9.0 / 7.0;
        boundary.neighbor_motion_alignment = -1.0;
        assert!(validate_inspection(Some(&inspection), 17, "seamless").is_ok());
        for alignment in [1.0, 2.0, f64::NAN] {
            inspection.generated[0].neighbor_motion_alignment = alignment;
            assert!(validate_inspection(Some(&inspection), 17, "seamless").is_err());
        }
    }

    #[test]
    fn tolerates_sub_tone_appearance_variation_but_rejects_a_flash() {
        let mut inspection: VideoLoopBoundaryInspection =
            serde_json::from_value(evidence()).unwrap();
        inspection.generated[0].transition_mae = [2.0, 2.8, 2.0];
        inspection.generated[0].appearance_ratio = 1.4;
        assert!(validate_inspection(Some(&inspection), 17, "seamless").is_ok());
        inspection.generated[0].transition_mae = [2.0, 5.0, 2.0];
        inspection.generated[0].appearance_ratio = 2.5;
        assert!(validate_inspection(Some(&inspection), 17, "seamless").is_err());
    }
}
