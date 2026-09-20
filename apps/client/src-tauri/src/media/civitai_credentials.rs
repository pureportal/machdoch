use std::path::{Path, PathBuf};

use crate::{
    cooperative_file_lock::with_cooperative_file_lock,
    runtime_snapshot::{
        get_user_config_directory,
        user_config::{load_user_config_value_at_path, write_user_config_value_at_path},
    },
};

use super::MediaResult;

fn credentials_path() -> MediaResult<PathBuf> {
    Ok(get_user_config_directory()?.join("civitai.json"))
}

fn load_at(path: &Path) -> MediaResult<Option<String>> {
    let value = load_user_config_value_at_path(path)?;
    match value.get("apiKey") {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(key)) if !key.trim().is_empty() => Ok(Some(key.clone())),
        _ => Err("The saved Civitai API key is invalid. Replace it in Settings.".to_string()),
    }
}

fn save_at(path: &Path, token: Option<&str>) -> MediaResult<()> {
    with_cooperative_file_lock(path, || {
        write_user_config_value_at_path(&serde_json::json!({ "apiKey": token }), path)
    })
}

pub(super) fn load() -> MediaResult<Option<String>> {
    load_at(&credentials_path()?)
}

pub(super) fn save(token: Option<&str>) -> MediaResult<()> {
    save_at(&credentials_path()?, token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civitai_credentials_survive_reload_replacement_and_removal() {
        let root = std::env::temp_dir().join(format!(
            "machdoch-civitai-key-{}",
            super::super::model_import::new_import_id().unwrap()
        ));
        let path = root.join("civitai.json");
        assert_eq!(load_at(&path).unwrap(), None);
        save_at(&path, Some("test-key")).unwrap();
        assert_eq!(load_at(&path).unwrap().as_deref(), Some("test-key"));
        save_at(&path, Some("replacement-key")).unwrap();
        assert_eq!(load_at(&path).unwrap().as_deref(), Some("replacement-key"));
        save_at(&path, None).unwrap();
        assert_eq!(load_at(&path).unwrap(), None);
        assert!(!std::fs::read_to_string(&path).unwrap().contains("test-key"));
        assert!(root.starts_with(std::env::temp_dir()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
