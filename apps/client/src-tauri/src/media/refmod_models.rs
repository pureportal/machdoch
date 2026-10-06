use std::{fs, path::PathBuf};

use super::{model_discovery, MediaResult};

const VAE_FILES: [&str; 2] = [
    "vae/minimax_h3_video_vae_fp16.safetensors",
    "vae/minimax_h3_audio_vae_fp32.safetensors",
];

pub(super) fn resolve_model_directory(workspace_root: &str) -> MediaResult<PathBuf> {
    let discovery = model_discovery::discover(workspace_root)?;
    let root = PathBuf::from(discovery.root_path);
    let missing = || {
        format!(
            "Install a MiniMax H3 audio or video VAE under {}",
            root.join("minimax-h3-ref2va/vae").display()
        )
    };
    if !root.is_dir() {
        return Err(missing());
    }
    let root = fs::canonicalize(&root)
        .map_err(|error| format!("Could not resolve the models directory: {error}"))?;
    let mut packages = Vec::new();
    for artifact in discovery.entries.iter().filter(|artifact| {
        artifact.kind == "diffusers-model"
            && artifact.architecture.as_deref() == Some("minimax-h3-ref2va")
    }) {
        let directory = fs::canonicalize(&artifact.path)
            .map_err(|error| format!("Could not resolve the H3 package: {error}"))?;
        if !directory.starts_with(&root) {
            return Err("H3 package is outside the workspace models directory".into());
        }
        let has_vae = VAE_FILES.iter().any(|relative| {
            let path = directory.join(relative);
            fs::symlink_metadata(&path).is_ok_and(|metadata| {
                !metadata.file_type().is_symlink() && metadata.is_file() && metadata.len() > 0
            }) && fs::canonicalize(path).is_ok_and(|path| path.starts_with(&root))
        });
        if has_vae {
            packages.push(directory);
        }
    }
    let preferred = root.join("minimax-h3-ref2va");
    if let Some(index) = packages.iter().position(|directory| {
        directory.parent() == Some(root.as_path())
            && directory
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case("minimax-h3-ref2va"))
    }) {
        return Ok(packages.remove(index));
    }
    match packages.len() {
        0 => Err(missing()),
        1 => Ok(packages.remove(0)),
        _ => Err(format!(
            "Multiple H3 VAE packages were found. Keep the VAEs under {} or leave one H3 package.",
            preferred.join("vae").display()
        )),
    }
}

#[cfg(test)]
#[path = "refmod_models_tests.rs"]
mod tests;
