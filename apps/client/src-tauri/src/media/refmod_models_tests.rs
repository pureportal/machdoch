use super::*;
use std::time::{SystemTime, UNIX_EPOCH};

struct Workspace(PathBuf);

impl Workspace {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "machdoch-refmod-models-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("models")).unwrap();
        Self(root)
    }

    fn package(&self, relative: &str, vae: &str) -> PathBuf {
        let directory = self.0.join("models").join(relative);
        fs::create_dir_all(directory.join("vae")).unwrap();
        fs::write(directory.join(vae), b"VAE fixture").unwrap();
        fs::canonicalize(directory).unwrap()
    }

    fn resolve(&self) -> MediaResult<PathBuf> {
        resolve_model_directory(self.0.to_str().unwrap())
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn refmod_vaes_resolve_without_the_generation_components() {
    for vae in VAE_FILES {
        let workspace = Workspace::new();
        let package = workspace.package("minimax-h3-ref2va", vae);
        assert_eq!(workspace.resolve().unwrap(), package);
        assert!(model_discovery::resolve_workspace_diffusers_package(
            workspace.0.to_str().unwrap(),
            "minimax-h3-ref2va",
            Some("minimax-h3-ref2va")
        )
        .is_err());
    }
}

#[test]
fn refmod_discovery_requires_a_nonempty_vae_in_this_workspace() {
    let workspace = Workspace::new();
    assert!(workspace
        .resolve()
        .unwrap_err()
        .contains("Install a MiniMax H3"));
    let package = workspace.package("minimax-h3-ref2va", VAE_FILES[1]);
    fs::write(package.join(VAE_FILES[1]), []).unwrap();
    assert!(workspace
        .resolve()
        .unwrap_err()
        .contains("Install a MiniMax H3"));
}

#[test]
fn refmod_discovery_uses_the_preferred_package_and_rejects_ambiguity() {
    let workspace = Workspace::new();
    let first = workspace.package("first/minimax-h3-ref2va", VAE_FILES[1]);
    assert_eq!(workspace.resolve().unwrap(), first);
    workspace.package("second/minimax-h3-ref2va", VAE_FILES[0]);
    assert!(workspace
        .resolve()
        .unwrap_err()
        .contains("Multiple H3 VAE packages"));
    let preferred = workspace.package("MINIMAX-H3-REF2VA", VAE_FILES[1]);
    assert_eq!(workspace.resolve().unwrap(), preferred);
}
