use image::{Rgb, RgbImage};
use serde::Deserialize;

use super::{database, ingest, MediaImageImportResult, MediaResult, MediaRuntimePaths};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PoseMap {
    aspect_ratio: String,
    people: Vec<PosePerson>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PosePerson {
    pose: String,
    x: f64,
    y: f64,
    scale: f64,
    mirror: bool,
    joints: Option<Vec<PoseJoint>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PoseJoint {
    x: f64,
    y: f64,
}

const BONES: [(usize, usize, [u8; 3]); 17] = [
    (1, 2, [255, 0, 0]),
    (1, 5, [255, 85, 0]),
    (2, 3, [255, 170, 0]),
    (3, 4, [255, 255, 0]),
    (5, 6, [170, 255, 0]),
    (6, 7, [85, 255, 0]),
    (1, 8, [0, 255, 0]),
    (8, 9, [0, 255, 85]),
    (9, 10, [0, 255, 170]),
    (1, 11, [0, 255, 255]),
    (11, 12, [0, 170, 255]),
    (12, 13, [0, 85, 255]),
    (1, 0, [0, 0, 255]),
    (0, 14, [85, 0, 255]),
    (14, 16, [170, 0, 255]),
    (0, 15, [255, 0, 255]),
    (15, 17, [255, 0, 170]),
];

const JOINT_COLORS: [[u8; 3]; 18] = [
    [255, 0, 0],
    [255, 85, 0],
    [255, 170, 0],
    [255, 255, 0],
    [170, 255, 0],
    [85, 255, 0],
    [0, 255, 0],
    [0, 255, 85],
    [0, 255, 170],
    [0, 255, 255],
    [0, 170, 255],
    [0, 85, 255],
    [0, 0, 255],
    [85, 0, 255],
    [170, 0, 255],
    [255, 0, 255],
    [255, 0, 170],
    [255, 0, 85],
];

fn joints(pose: &str) -> [(f64, f64); 18] {
    let mut points = [
        (0.50, 0.10),
        (0.50, 0.21),
        (0.40, 0.24),
        (0.37, 0.42),
        (0.35, 0.59),
        (0.60, 0.24),
        (0.63, 0.42),
        (0.65, 0.59),
        (0.45, 0.53),
        (0.43, 0.74),
        (0.42, 0.98),
        (0.55, 0.53),
        (0.57, 0.74),
        (0.58, 0.98),
        (0.47, 0.08),
        (0.53, 0.08),
        (0.44, 0.10),
        (0.56, 0.10),
    ];
    match pose {
        "sitting" => {
            points[9] = (0.68, 0.57);
            points[10] = (0.68, 0.88);
            points[12] = (0.82, 0.58);
            points[13] = (0.82, 0.88);
        }
        "walking" => {
            points[3] = (0.31, 0.39);
            points[4] = (0.22, 0.49);
            points[6] = (0.70, 0.40);
            points[7] = (0.77, 0.53);
            points[9] = (0.34, 0.72);
            points[10] = (0.20, 0.94);
            points[12] = (0.66, 0.73);
            points[13] = (0.81, 0.97);
        }
        "waving" => {
            points[6] = (0.67, 0.15);
            points[7] = (0.66, 0.02);
        }
        "arms-up" => {
            points[3] = (0.31, 0.16);
            points[4] = (0.27, 0.02);
            points[6] = (0.69, 0.16);
            points[7] = (0.73, 0.02);
        }
        "climbing" => {
            points[0] = (0.56, 0.11);
            points[1] = (0.52, 0.24);
            points[2] = (0.42, 0.28);
            points[3] = (0.26, 0.17);
            points[4] = (0.16, 0.05);
            points[5] = (0.61, 0.25);
            points[6] = (0.72, 0.12);
            points[7] = (0.78, 0.02);
            points[8] = (0.44, 0.55);
            points[9] = (0.29, 0.47);
            points[10] = (0.18, 0.63);
            points[11] = (0.57, 0.56);
            points[12] = (0.73, 0.74);
            points[13] = (0.68, 0.94);
            points[14] = (0.53, 0.09);
            points[15] = (0.59, 0.09);
            points[16] = (0.49, 0.11);
            points[17] = (0.63, 0.10);
        }
        _ => {}
    }
    points
}

fn disc(image: &mut RgbImage, x: i32, y: i32, radius: i32, color: Rgb<u8>) {
    for py in (y - radius).max(0)..=(y + radius).min(image.height() as i32 - 1) {
        for px in (x - radius).max(0)..=(x + radius).min(image.width() as i32 - 1) {
            if (px - x).pow(2) + (py - y).pow(2) <= radius.pow(2) {
                image.put_pixel(px as u32, py as u32, color);
            }
        }
    }
}

fn line(image: &mut RgbImage, from: (i32, i32), to: (i32, i32), radius: i32, color: Rgb<u8>) {
    let steps = (to.0 - from.0).abs().max((to.1 - from.1).abs()).max(1);
    for step in 0..=steps {
        let x = from.0 + (to.0 - from.0) * step / steps;
        let y = from.1 + (to.1 - from.1) * step / steps;
        disc(image, x, y, radius, color);
    }
}

impl PoseMap {
    pub(crate) fn validate(&self) -> MediaResult<()> {
        if !matches!(self.aspect_ratio.as_str(), "1:1" | "4:5" | "16:9" | "9:16") {
            return Err("Choose a valid pose map aspect ratio.".into());
        }
        if !(1..=4).contains(&self.people.len()) {
            return Err("A pose map needs one to four people.".into());
        }
        for person in &self.people {
            if !matches!(
                person.pose.as_str(),
                "standing" | "sitting" | "walking" | "waving" | "arms-up" | "climbing"
            ) || !person.x.is_finite()
                || !(0.1..=0.9).contains(&person.x)
                || !person.y.is_finite()
                || !(0.35..=1.0).contains(&person.y)
                || !person.scale.is_finite()
                || !(0.2..=0.9).contains(&person.scale)
            {
                return Err("A pose person has invalid placement or pose.".into());
            }
            if let Some(joints) = &person.joints {
                if joints.len() != 18
                    || joints.iter().any(|joint| {
                        !joint.x.is_finite()
                            || !(0.0..=1.0).contains(&joint.x)
                            || !joint.y.is_finite()
                            || !(0.0..=1.0).contains(&joint.y)
                    })
                {
                    return Err("A pose needs 18 valid joints.".into());
                }
            }
        }
        Ok(())
    }

    fn render(&self) -> MediaResult<RgbImage> {
        self.validate()?;
        let (width, height) = dimensions(&self.aspect_ratio)?;
        let mut image = RgbImage::from_pixel(width, height, Rgb([0, 0, 0]));
        for person in &self.people {
            let joint_positions = person.joints.as_ref().map_or_else(
                || joints(&person.pose),
                |custom| std::array::from_fn(|index| (custom[index].x, custom[index].y)),
            );
            let points = joint_positions.map(|(x, y)| {
                let relative_x = if person.mirror { 1.0 - x } else { x };
                (
                    ((person.x * width as f64)
                        + (relative_x - 0.5) * person.scale * height as f64 * 0.55)
                        .round() as i32,
                    ((person.y + (y - 1.0) * person.scale) * height as f64).round() as i32,
                )
            });
            let radius = ((person.scale * height as f64 / 125.0).round() as i32).max(3);
            for (start, end, color) in BONES {
                line(&mut image, points[start], points[end], radius, Rgb(color));
            }
            for (index, point) in points.into_iter().enumerate() {
                disc(
                    &mut image,
                    point.0,
                    point.1,
                    radius + 1,
                    Rgb(JOINT_COLORS[index]),
                );
            }
        }
        Ok(image)
    }
}

fn dimensions(aspect_ratio: &str) -> MediaResult<(u32, u32)> {
    match aspect_ratio {
        "1:1" => Ok((768, 768)),
        "4:5" => Ok((768, 960)),
        "16:9" => Ok((1024, 576)),
        "9:16" => Ok((576, 1024)),
        _ => Err("Choose a valid pose map aspect ratio.".into()),
    }
}

pub(crate) fn create(
    paths: &MediaRuntimePaths,
    map: PoseMap,
) -> MediaResult<MediaImageImportResult> {
    let image = map.render()?;
    let name = format!(
        "openpose-{}.png",
        map.people
            .iter()
            .map(|person| person.pose.as_str())
            .collect::<Vec<_>>()
            .join("-")
    );
    save_and_import(paths, image, &name)
}

fn save_and_import(
    paths: &MediaRuntimePaths,
    image: RgbImage,
    name: &str,
) -> MediaResult<MediaImageImportResult> {
    let staging = paths
        .database
        .parent()
        .ok_or("Media storage path is unavailable")?
        .join("pose-map-staging");
    std::fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| error.to_string())?;
    let suffix = random
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let staging_directory = staging.join(suffix);
    std::fs::create_dir(&staging_directory).map_err(|error| error.to_string())?;
    let path = staging_directory.join(name);
    image.save(&path).map_err(|error| error.to_string())?;
    let result = ingest::import_image(paths, &path.to_string_lossy());
    let cleanup = std::fs::remove_dir_all(&staging_directory).map_err(|error| error.to_string());
    cleanup?;
    let mut imported = result?;
    imported.asset = database::mark_openpose_asset(paths, &imported.asset.id)?;
    if let Some(asset) = imported
        .detail
        .assets
        .iter_mut()
        .find(|asset| asset.id == imported.asset.id)
    {
        *asset = imported.asset.clone();
    }
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn standing_and_sitting_have_distinct_leg_geometry() {
        let standing = joints("standing");
        let sitting = joints("sitting");
        assert!(standing[9].0 < standing[8].0);
        assert!(sitting[9].0 > sitting[8].0);
        assert!(sitting[12].0 > sitting[11].0);
        assert!((sitting[9].1 - sitting[8].1).abs() < 0.1);
    }

    #[test]
    fn walking_has_a_striding_silhouette() {
        let walking = joints("walking");
        assert!(walking[4].0 < walking[2].0);
        assert!(walking[7].0 > walking[5].0);
        assert!(walking[10].0 < walking[8].0);
        assert!(walking[13].0 > walking[11].0);
        assert!(walking[13].0 - walking[10].0 > 0.5);
    }

    #[test]
    fn climbing_has_a_raised_foot_and_two_reaching_arms() {
        let climbing = joints("climbing");
        assert!(climbing[10].1 < climbing[8].1 + 0.1);
        assert!(climbing[4].1 < climbing[2].1);
        assert!(climbing[7].1 < climbing[5].1);
        assert!(climbing[10].1 < climbing[13].1);
    }

    #[test]
    fn rejects_invalid_people() {
        let map = PoseMap {
            aspect_ratio: "1:1".into(),
            people: vec![PosePerson {
                pose: "jumping".into(),
                x: 0.5,
                y: 0.9,
                scale: 0.8,
                mirror: false,
                joints: None,
            }],
        };
        assert!(map.render().is_err());
    }

    #[test]
    fn rendered_skeleton_uses_openpose_joint_and_limb_colors() {
        let image = PoseMap {
            aspect_ratio: "1:1".into(),
            people: vec![PosePerson {
                pose: "standing".into(),
                x: 0.5,
                y: 0.92,
                scale: 0.8,
                mirror: false,
                joints: None,
            }],
        }
        .render()
        .unwrap();
        assert_eq!(*image.get_pixel(384, 154), Rgb([255, 0, 0]));
        assert_eq!(*image.get_pixel(384, 221), Rgb([255, 85, 0]));
        assert_eq!(*image.get_pixel(354, 233), Rgb([255, 0, 0]));
    }

    #[test]
    fn custom_joint_positions_change_the_saved_pose() {
        let default = PoseMap {
            aspect_ratio: "1:1".into(),
            people: vec![PosePerson {
                pose: "standing".into(),
                x: 0.5,
                y: 0.92,
                scale: 0.8,
                mirror: false,
                joints: None,
            }],
        };
        let mut edited = PoseMap {
            aspect_ratio: "1:1".into(),
            people: vec![PosePerson {
                pose: "standing".into(),
                x: 0.5,
                y: 0.92,
                scale: 0.8,
                mirror: false,
                joints: Some(
                    joints("standing")
                        .map(|(x, y)| PoseJoint { x, y })
                        .into_iter()
                        .collect(),
                ),
            }],
        };
        edited.people[0].joints.as_mut().unwrap()[4].x = 0.1;
        assert_ne!(default.render().unwrap(), edited.render().unwrap());
        edited.people[0].joints.as_mut().unwrap()[4].x = 1.1;
        assert!(edited.render().is_err());
    }

    #[test]
    fn created_pose_is_a_reusable_openpose_asset() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("machdoch-pose-map-{nonce}"));
        let paths = MediaRuntimePaths {
            _storage_lease: None,
            database: root.join("media.sqlite3"),
            blobs: root.join("blobs"),
        };
        database::ensure_initialized(&paths).unwrap();
        let result = create(
            &paths,
            PoseMap {
                aspect_ratio: "1:1".into(),
                people: vec![PosePerson {
                    pose: "standing".into(),
                    x: 0.5,
                    y: 0.92,
                    scale: 0.8,
                    mirror: false,
                    joints: None,
                }],
            },
        )
        .unwrap();
        assert!(result.asset.tags.iter().any(|tag| tag.value == "openpose"));
        assert!(database::get_asset(&paths, &result.asset.id).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }
}
