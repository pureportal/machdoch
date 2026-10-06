use super::*;
use image::{ImageFormat, ImageReader, Limits};
use std::io::Cursor;

fn image_extension(path: &Path, bytes: &[u8]) -> MediaResult<(&'static str, ImageFormat)> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok(("png", ImageFormat::Png)),
        "jpg" | "jpeg" if bytes.starts_with(b"\xff\xd8\xff") => Ok(("jpg", ImageFormat::Jpeg)),
        "webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            Ok(("webp", ImageFormat::WebP))
        }
        _ => Err(format!(
            "{} must be a PNG, JPEG, or WebP image.",
            path.display()
        )),
    }
}

pub(super) fn read_training_image(path: &Path) -> MediaResult<(Vec<u8>, &'static str, u32, u32)> {
    let size = fs::metadata(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?
        .len();
    if size == 0 || size > 20 * 1024 * 1024 {
        return Err(format!("{} must be under 20 MB.", path.display()));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let (extension, format) = image_extension(path, &bytes)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes.as_slice()), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| {
        format!(
            "{} could not be decoded. Choose another image.",
            path.display()
        )
    })?;
    Ok((bytes, extension, decoded.width(), decoded.height()))
}

pub(super) fn inspect_images(paths: Vec<PathBuf>) -> MediaResult<Vec<TrainingSampleInspection>> {
    if paths.len() > 50 {
        return Err("Choose up to 50 images.".into());
    }
    paths
        .into_iter()
        .map(|path| {
            let (_, _, width, height) = read_training_image(&path)?;
            Ok(TrainingSampleInspection {
                path,
                width,
                height,
                duration_seconds: None,
                fps: None,
            })
        })
        .collect()
}

pub(super) fn validate_settings(request: &TrainingRequest) -> MediaResult<()> {
    if request.architecture.is_video() != request.video.is_some() {
        return Err("Choose a dataset that matches the training model.".into());
    }
    let Some(video) = &request.video else {
        return Ok(());
    };
    if !(64..=2048).contains(&video.width)
        || !(64..=2048).contains(&video.height)
        || video.width % 16 != 0
        || video.height % 16 != 0
        || !(5..=161).contains(&video.frames)
        || (video.frames - 1) % 4 != 0
        || !(1..=60).contains(&video.fps)
        || !video.image_dropout.is_finite()
        || !(0.0..=1.0).contains(&video.image_dropout)
        || u64::from(video.width) * u64::from(video.height) * u64::from(video.frames) * 12
            > 1024 * 1024 * 1024
    {
        return Err("Use dimensions divisible by 16, 5–161 frames in steps of 4, and 1–60 fps. Reduce the canvas or frame count if the clip exceeds 1 GiB when decoded.".into());
    }
    if request.options.snr_gamma != 0.0 || request.options.preserve_aspect_ratio {
        return Err("Disable Min-SNR and choose a fixed video canvas.".into());
    }
    if request.architecture == TrainingArchitecture::Wan21T2V13B
        && request.options.precision == super::TrainingPrecision::Fp16
    {
        return Err("Choose BF16 or FP32 for Wan training.".into());
    }
    if request.architecture != TrainingArchitecture::CogVideoX15_5BI2V && video.image_dropout != 0.0
    {
        return Err("Image dropout applies to image-to-video models.".into());
    }
    Ok(())
}

fn video_extension(path: &Path) -> MediaResult<String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !path.is_absolute()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > 2 * 1024 * 1024 * 1024
        || !["mp4", "webm", "mov", "mkv"].contains(&extension.as_str())
    {
        return Err(format!(
            "{} must be an MP4, WebM, MOV, or MKV video under 2 GiB.",
            path.display()
        ));
    }
    Ok(extension)
}

fn inspect_video(app: &AppHandle, path: PathBuf) -> MediaResult<TrainingSampleInspection> {
    video_extension(&path)?;
    let metadata = provider_local_diffusers::inspect_video(app, &path, true)?;
    Ok(TrainingSampleInspection {
        path,
        width: metadata["width"]
            .as_u64()
            .ok_or("Video width is unavailable.")? as u32,
        height: metadata["height"]
            .as_u64()
            .ok_or("Video height is unavailable.")? as u32,
        duration_seconds: metadata["durationSeconds"].as_f64(),
        fps: metadata["fps"].as_f64(),
    })
}

pub(crate) fn inspect_samples(
    app: &AppHandle,
    paths: Vec<PathBuf>,
    architecture: TrainingArchitecture,
) -> MediaResult<Vec<TrainingSampleInspection>> {
    if paths.len() > 50 {
        return Err("Choose up to 50 training samples.".into());
    }
    if architecture.is_video() {
        paths
            .into_iter()
            .map(|path| inspect_video(app, path))
            .collect()
    } else {
        inspect_images(paths)
    }
}

pub(super) fn prepare_dataset(
    app: Option<&AppHandle>,
    request: &TrainingRequest,
    directory: &Path,
) -> MediaResult<()> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create training dataset: {error}"))?;
    let mut metadata = File::create(directory.join("metadata.jsonl"))
        .map_err(|error| format!("Could not create training captions: {error}"))?;
    for (index, image) in request.samples.iter().enumerate() {
        let file_name = if let Some(video) = &request.video {
            let extension = video_extension(&image.path)?;
            let file_name = format!("video-{index:03}.{extension}");
            let destination = directory.join(&file_name);
            fs::copy(&image.path, &destination)
                .map_err(|error| format!("Could not copy training video: {error}"))?;
            let metadata = inspect_video(
                app.ok_or("The media runtime is required to inspect training videos.")?,
                destination,
            )?;
            if metadata
                .duration_seconds
                .ok_or("Video duration is unavailable.")?
                < f64::from(video.frames) / f64::from(video.fps)
            {
                return Err(format!(
                    "{} is too short. Choose a clip with at least {:.2} seconds.",
                    image.path.display(),
                    f64::from(video.frames) / f64::from(video.fps)
                ));
            }
            file_name
        } else {
            let (bytes, extension, _, _) = read_training_image(&image.path)?;
            let file_name = format!("image-{index:03}.{extension}");
            fs::write(directory.join(&file_name), bytes)
                .map_err(|error| format!("Could not copy training image: {error}"))?;
            file_name
        };
        let trigger = request.trigger_phrase.trim();
        let caption = image.caption.trim();
        let text = if caption.is_empty() {
            trigger.to_string()
        } else if request.options.method == TrainingMethod::Embedding {
            if caption.contains(trigger) {
                caption.to_string()
            } else {
                format!("{trigger}, {caption}")
            }
        } else if caption.to_lowercase().contains(&trigger.to_lowercase()) {
            caption.to_string()
        } else {
            format!("{caption}, {trigger}")
        };
        writeln!(
            metadata,
            "{}",
            serde_json::json!({ "file_name": file_name, "text": text })
        )
        .map_err(|error| format!("Could not save training captions: {error}"))?;
    }
    Ok(())
}
