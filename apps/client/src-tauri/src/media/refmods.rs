use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{command_result, provider_local_diffusers, MediaCommandResult, MediaResult};

type OperationKey = (PathBuf, String);
static OPERATIONS: OnceLock<Mutex<HashMap<OperationKey, Arc<AtomicBool>>>> = OnceLock::new();

struct OperationLease {
    key: OperationKey,
    interruption: Arc<AtomicBool>,
    temporary_files: Vec<PathBuf>,
}

impl OperationLease {
    fn start(workspace: PathBuf, id: &str) -> MediaResult<Self> {
        if id.is_empty()
            || id.len() > 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return Err("RefMod operation identifier is invalid".into());
        }
        let key = (workspace, id.to_string());
        let mut operations = OPERATIONS
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if operations.len() >= 256 || operations.contains_key(&key) {
            return Err("RefMod operation is already running or the queue is full".into());
        }
        let interruption = Arc::new(AtomicBool::new(false));
        operations.insert(key.clone(), interruption.clone());
        Ok(Self {
            key,
            interruption,
            temporary_files: Vec::new(),
        })
    }

    fn reserve_temporary_file(&mut self, directory: &Path, purpose: &str) -> MediaResult<PathBuf> {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Could not create the RefMod directory: {error}"))?;
        let path = directory.join(format!(".refmod-{}-{purpose}.safetensors", self.key.1));
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("Could not reserve the RefMod temporary file: {error}"))?;
        self.temporary_files.push(path.clone());
        Ok(path)
    }
}

impl Drop for OperationLease {
    fn drop(&mut self) {
        for path in &self.temporary_files {
            if let Err(error) = fs::remove_file(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "Could not remove RefMod temporary file {}: {error}",
                        path.display()
                    );
                }
            }
        }
        if let Some(operations) = OPERATIONS.get() {
            operations
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&self.key);
        }
    }
}

fn cancel_operation(workspace: PathBuf, id: &str) -> bool {
    let Some(operations) = OPERATIONS.get() else {
        return false;
    };
    let operations = operations.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(interruption) = operations.get(&(workspace, id.to_string())) {
        interruption.store(true, Ordering::Release);
        true
    } else {
        false
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RefModSelection {
    pub(crate) path: String,
    pub(crate) enabled: bool,
    pub(crate) selection: String,
    pub(crate) visual_strength: f64,
    pub(crate) audio_strength: f64,
    pub(crate) copies: u32,
    #[serde(default = "constant_curve")]
    pub(crate) step_curve: String,
    #[serde(default = "constant_curve")]
    pub(crate) frame_curve: String,
}

fn constant_curve() -> String {
    "constant".to_string()
}

impl RefModSelection {
    pub(crate) fn active(&self) -> bool {
        self.enabled
            && ((self.selection != "audio" && self.visual_strength > 0.0)
                || (self.selection != "visual" && self.audio_strength > 0.0))
    }
}

pub(crate) fn default_token_budget() -> u32 {
    65_536
}

pub(crate) fn conditioning_mode(selections: &[RefModSelection]) -> &'static str {
    if selections.iter().any(RefModSelection::active) {
        "minimax-h3-refmods"
    } else {
        "minimax-h3-reference-image-audio"
    }
}

pub(crate) fn validate(
    selections: &[RefModSelection],
    model_id: &str,
    budget: u32,
) -> MediaResult<()> {
    if selections.len() > 256 || budget > 1_048_576 {
        return Err(
            "RefMods require at most 256 slots and a token limit up to 1048576".to_string(),
        );
    }
    if !selections.is_empty() && model_id != "local:minimax-h3-ref2va" {
        return Err("RefMods require MiniMax H3".to_string());
    }
    for selection in selections {
        if !matches!(selection.selection.as_str(), "all" | "visual" | "audio")
            || !(1..=8).contains(&selection.copies)
            || !selection.visual_strength.is_finite()
            || !selection.audio_strength.is_finite()
            || !(0.0..=1.0).contains(&selection.visual_strength)
            || !(0.0..=1.0).contains(&selection.audio_strength)
            || !matches!(
                selection.step_curve.as_str(),
                "constant" | "increase" | "decrease" | "middle" | "ends"
            )
            || !matches!(
                selection.frame_curve.as_str(),
                "constant" | "increase" | "decrease" | "middle" | "ends"
            )
        {
            return Err(
                "Choose a RefMod modality, strengths from 0 to 1 and 1–8 copies".to_string(),
            );
        }
        if selection.active() {
            let path = Path::new(&selection.path);
            if !path.is_absolute()
                || !path.is_file()
                || !path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("safetensors"))
            {
                return Err("Choose an existing absolute RefMod .safetensors path".to_string());
            }
        }
    }
    Ok(())
}

pub(super) fn prepare_library_listing(
    workspace_root: &str,
    request: &mut serde_json::Value,
) -> MediaResult<()> {
    if request.get("operation").and_then(serde_json::Value::as_str) != Some("list")
        || request.get("directory").is_some()
    {
        return Ok(());
    }
    let workspace = crate::runtime_snapshot::resolve_workspace_root_path(workspace_root)?;
    let directory = workspace.join("models/refmods");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not open the RefMod library: {error}"))?;
    request["directory"] = serde_json::Value::String(directory.to_string_lossy().into_owned());
    Ok(())
}

#[tauri::command]
pub(crate) async fn media_refmod_operation(
    app: AppHandle,
    workspace_root: String,
    mut request: serde_json::Value,
) -> MediaCommandResult<serde_json::Value> {
    let result = async {
        let operation = request
            .get("operation")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "Choose a RefMod operation".to_string())?;
        let operation_id = request
            .get("operationId")
            .and_then(serde_json::Value::as_str);
        let workspace = crate::runtime_snapshot::resolve_workspace_root_path(&workspace_root)?;
        if operation == "cancel" {
            let id =
                operation_id.ok_or_else(|| "RefMod operation identifier is missing".to_string())?;
            return Ok(serde_json::json!({"canceled": cancel_operation(workspace, id)}));
        }
        let mut lease = if operation == "create" || operation == "preview" {
            Some(OperationLease::start(
                workspace,
                operation_id.ok_or_else(|| "RefMod operation identifier is missing".to_string())?,
            )?)
        } else {
            None
        };
        if !matches!(
            operation,
            "inspect"
                | "inspect-many"
                | "import"
                | "list"
                | "sources"
                | "save"
                | "create"
                | "preview"
        ) {
            return Err(
                "Choose inspect, inspect-many, import, list, sources, save, create or preview"
                    .to_string(),
            );
        }
        if request.get("operation").and_then(serde_json::Value::as_str) == Some("import")
            || request
                .get("keepInLibrary")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        {
            let workspace = crate::runtime_snapshot::resolve_workspace_root_path(&workspace_root)?;
            request
                .as_object_mut()
                .ok_or_else(|| "RefMod request must be an object".to_string())?
                .insert(
                    "libraryDirectory".to_string(),
                    serde_json::Value::String(
                        workspace
                            .join("models/refmods")
                            .to_string_lossy()
                            .into_owned(),
                    ),
                );
        }
        if request.get("operation").and_then(serde_json::Value::as_str) == Some("create") {
            let lease = lease
                .as_mut()
                .ok_or_else(|| "RefMod operation is missing".to_string())?;
            let output = PathBuf::from(
                request
                    .get("outputPath")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| "Choose a RefMod output path".to_string())?,
            );
            if !output.is_absolute()
                || !output
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("safetensors"))
            {
                return Err("Choose an absolute RefMod .safetensors output path".into());
            }
            let parent = output
                .parent()
                .ok_or_else(|| "Choose a RefMod output directory".to_string())?;
            let temporary = lease.reserve_temporary_file(parent, "create")?;
            request["temporaryPath"] =
                serde_json::Value::String(temporary.to_string_lossy().into_owned());
            if let Some(library) = request
                .get("libraryDirectory")
                .and_then(serde_json::Value::as_str)
            {
                let temporary = lease.reserve_temporary_file(Path::new(library), "library")?;
                request["libraryTemporaryPath"] =
                    serde_json::Value::String(temporary.to_string_lossy().into_owned());
            }
        }
        tauri::async_runtime::spawn_blocking(move || {
            prepare_library_listing(&workspace_root, &mut request)?;
            if matches!(
                request.get("operation").and_then(serde_json::Value::as_str),
                Some("create" | "preview")
            ) {
                let models = super::refmod_models::resolve_model_directory(&workspace_root)?;
                request
                    .as_object_mut()
                    .ok_or_else(|| "RefMod request must be an object".to_string())?
                    .insert(
                        "modelPath".to_string(),
                        serde_json::Value::String(models.to_string_lossy().into_owned()),
                    );
            }
            provider_local_diffusers::refmod_operation(
                &app,
                &request,
                lease.as_ref().map(|lease| lease.interruption.clone()),
            )
        })
        .await
        .map_err(|error| format!("RefMod worker could not be joined: {error}"))?
    }
    .await;
    command_result("media_refmod_operation", result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refmod_library_listing_creates_the_workspace_library_and_preserves_folder_requests() {
        let root = std::env::temp_dir().join(format!(
            "refmod-library-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let workspace =
            crate::runtime_snapshot::resolve_workspace_root_path(root.to_str().unwrap()).unwrap();
        let library = workspace.join("models/refmods");
        assert!(!library.exists());
        let mut request = serde_json::json!({"operation": "list", "offset": 0});
        prepare_library_listing(root.to_str().unwrap(), &mut request).unwrap();
        assert!(library.is_dir());
        assert_eq!(request["directory"], library.to_string_lossy().as_ref());
        assert_eq!(request["offset"], 0);
        prepare_library_listing(root.to_str().unwrap(), &mut request).unwrap();
        let mut chosen = serde_json::json!({"operation": "list", "directory": root});
        let original = chosen.clone();
        prepare_library_listing(root.to_str().unwrap(), &mut chosen).unwrap();
        assert_eq!(chosen, original);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn inactive_files_do_not_need_to_exist() {
        let selection = RefModSelection {
            path: "missing".into(),
            enabled: false,
            selection: "all".into(),
            visual_strength: 1.0,
            audio_strength: 1.0,
            copies: 1,
            step_curve: constant_curve(),
            frame_curve: constant_curve(),
        };
        assert!(validate(&[selection.clone()], "local:minimax-h3-ref2va", 65536).is_ok());
        assert!(validate(&[selection], "local:framepack-i2v-hy-13b", 65536).is_err());
    }

    #[test]
    fn conditioning_evidence_matches_active_modalities() {
        let mut selection: RefModSelection = serde_json::from_value(serde_json::json!({
            "path": "/refs/voice.safetensors", "enabled": true, "selection": "audio",
            "visualStrength": 1, "audioStrength": 0.4, "copies": 1
        }))
        .unwrap();
        assert_eq!(
            conditioning_mode(&[selection.clone()]),
            "minimax-h3-refmods"
        );
        selection.audio_strength = 0.0;
        assert_eq!(
            conditioning_mode(&[selection]),
            "minimax-h3-reference-image-audio"
        );
        assert_eq!(conditioning_mode(&[]), "minimax-h3-reference-image-audio");
    }

    #[test]
    fn cancellation_is_scoped_to_workspace_and_cleans_up_after_completion() {
        let workspace = PathBuf::from("/refmod-cancellation-workspace");
        let operation = OperationLease::start(workspace.clone(), "refmod-test-operation").unwrap();
        assert!(!cancel_operation(
            PathBuf::from("/another-workspace"),
            "refmod-test-operation"
        ));
        assert!(!operation.interruption.load(Ordering::Acquire));
        assert!(OperationLease::start(workspace.clone(), "refmod-test-operation").is_err());
        assert!(cancel_operation(workspace.clone(), "refmod-test-operation"));
        assert!(operation.interruption.load(Ordering::Acquire));
        drop(operation);
        assert!(!cancel_operation(
            workspace.clone(),
            "refmod-test-operation"
        ));
        assert!(OperationLease::start(workspace, "refmod-test-operation").is_ok());
    }

    #[test]
    fn operation_completion_removes_only_its_reserved_temporary_files() {
        let root = std::env::temp_dir().join(format!(
            "refmod-temp-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let unrelated = root.join("existing.safetensors");
        fs::write(&unrelated, b"keep").unwrap();
        let mut operation = OperationLease::start(root.clone(), "refmod-temp-operation").unwrap();
        let temporary = operation.reserve_temporary_file(&root, "create").unwrap();
        fs::write(&temporary, b"interrupted").unwrap();
        assert!(operation.reserve_temporary_file(&root, "create").is_err());
        drop(operation);
        assert!(!temporary.exists());
        assert_eq!(fs::read(&unrelated).unwrap(), b"keep");
        fs::remove_file(unrelated).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
