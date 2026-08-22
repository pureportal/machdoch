use std::{
    collections::{HashSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::window;

pub(crate) const OPEN_FOLDER_ARG: &str = "--machdoch-open-folder";
pub(crate) const ATTACH_FILES_ARG: &str = "--machdoch-attach-files";
pub(crate) const FILE_MANAGER_INVOCATION_EVENT: &str = "machdoch://file-manager-invocation";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum FileManagerInvocation {
    Folder { path: String },
    Files { paths: Vec<String> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileManagerDestination {
    Chat,
    WorkspaceManagement,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManagerInvocationRoute {
    destination: FileManagerDestination,
    workspace_root: Option<String>,
    attachment_paths: Vec<String>,
}

#[derive(Default)]
pub struct FileManagerInvocationState(Mutex<VecDeque<FileManagerInvocation>>);

impl FileManagerInvocationState {
    pub(crate) fn with_initial(invocation: Option<FileManagerInvocation>) -> Self {
        Self(Mutex::new(invocation.into_iter().collect()))
    }

    fn enqueue(&self, invocation: FileManagerInvocation) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "Unable to queue the file-manager selection.".to_string())?
            .push_back(invocation);
        Ok(())
    }

    fn take_all(&self) -> Result<Vec<FileManagerInvocation>, String> {
        let mut queued = self
            .0
            .lock()
            .map_err(|_| "Unable to read queued file-manager selections.".to_string())?;
        Ok(queued.drain(..).collect())
    }
}

pub(crate) fn parse_invocation_args(
    args: &[String],
) -> Result<Option<FileManagerInvocation>, String> {
    let folder_positions = args
        .iter()
        .enumerate()
        .filter_map(|(index, argument)| (argument == OPEN_FOLDER_ARG).then_some(index))
        .collect::<Vec<_>>();
    let files_positions = args
        .iter()
        .enumerate()
        .filter_map(|(index, argument)| (argument == ATTACH_FILES_ARG).then_some(index))
        .collect::<Vec<_>>();

    if folder_positions.len() + files_positions.len() > 1 {
        return Err("Expected one file-manager action per launch.".to_string());
    }

    if let Some(position) = folder_positions.first().copied() {
        let paths = &args[position + 1..];

        if paths.len() != 1 || paths[0].is_empty() {
            return Err("The folder action requires exactly one folder path.".to_string());
        }

        return Ok(Some(FileManagerInvocation::Folder {
            path: paths[0].clone(),
        }));
    }

    if let Some(position) = files_positions.first().copied() {
        let paths = args[position + 1..]
            .iter()
            .filter(|path| !path.is_empty())
            .cloned()
            .collect::<Vec<_>>();

        if paths.is_empty() {
            return Err("The file action requires at least one file path.".to_string());
        }

        return Ok(Some(FileManagerInvocation::Files { paths }));
    }

    Ok(None)
}

pub(crate) fn handle_secondary_instance<R: Runtime>(
    app: &AppHandle<R>,
    args: Vec<String>,
) -> Result<(), String> {
    if let Some(invocation) = parse_invocation_args(&args)? {
        app.state::<FileManagerInvocationState>()
            .enqueue(invocation)?;
        app.emit(FILE_MANAGER_INVOCATION_EVENT, ())
            .map_err(|error| format!("Failed to notify the app about the selection: {error}"))?;
    }

    window::show_main_window(app);
    Ok(())
}

#[tauri::command]
pub fn take_file_manager_invocations(
    state: tauri::State<'_, FileManagerInvocationState>,
) -> Result<Vec<FileManagerInvocation>, String> {
    state.take_all()
}

#[tauri::command]
pub async fn resolve_file_manager_invocation(
    invocation: FileManagerInvocation,
    known_workspace_roots: Vec<String>,
) -> Result<FileManagerInvocationRoute, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_invocation_route(invocation, known_workspace_roots)
    })
    .await
    .map_err(|error| format!("The file-manager path resolver stopped unexpectedly: {error}"))?
}

fn resolve_invocation_route(
    invocation: FileManagerInvocation,
    known_workspace_roots: Vec<String>,
) -> Result<FileManagerInvocationRoute, String> {
    let known_workspaces = resolve_known_workspaces(known_workspace_roots);

    match invocation {
        FileManagerInvocation::Folder { path } => {
            let folder = canonical_selection_path(&path, SelectionKind::Folder)?;
            let workspace_root = known_workspaces
                .iter()
                .find(|workspace| paths_match(&workspace.canonical_root, &folder))
                .map(|workspace| workspace.registered_root.clone());

            Ok(match workspace_root {
                Some(workspace_root) => FileManagerInvocationRoute {
                    destination: FileManagerDestination::Chat,
                    workspace_root: Some(workspace_root),
                    attachment_paths: Vec::new(),
                },
                None => FileManagerInvocationRoute {
                    destination: FileManagerDestination::WorkspaceManagement,
                    workspace_root: Some(crate::desktop_task::format_path_for_ui(&folder)),
                    attachment_paths: Vec::new(),
                },
            })
        }
        FileManagerInvocation::Files { paths } => {
            let files = canonical_file_paths(paths)?;
            let workspace_root = most_specific_containing_workspace(&known_workspaces, &files)
                .map(|workspace| workspace.registered_root.clone());

            Ok(FileManagerInvocationRoute {
                destination: FileManagerDestination::Chat,
                workspace_root,
                attachment_paths: files
                    .iter()
                    .map(|path| crate::desktop_task::format_path_for_ui(path))
                    .collect(),
            })
        }
    }
}

#[derive(Debug)]
struct KnownWorkspace {
    registered_root: String,
    canonical_root: PathBuf,
    component_count: usize,
}

fn resolve_known_workspaces(roots: Vec<String>) -> Vec<KnownWorkspace> {
    let mut seen_roots = HashSet::new();
    let mut workspaces = Vec::new();

    for registered_root in roots {
        if registered_root.is_empty() {
            continue;
        }

        let Ok(canonical_root) = PathBuf::from(&registered_root).canonicalize() else {
            continue;
        };
        if !canonical_root.is_dir() || !seen_roots.insert(path_key(&canonical_root)) {
            continue;
        }

        workspaces.push(KnownWorkspace {
            component_count: canonical_root.components().count(),
            registered_root,
            canonical_root,
        });
    }

    workspaces
}

fn most_specific_containing_workspace<'a>(
    workspaces: &'a [KnownWorkspace],
    files: &[PathBuf],
) -> Option<&'a KnownWorkspace> {
    let mut selected: Option<&KnownWorkspace> = None;

    for workspace in workspaces {
        if !files
            .iter()
            .all(|file| file.starts_with(&workspace.canonical_root))
        {
            continue;
        }

        if selected.is_none_or(|current| workspace.component_count > current.component_count) {
            selected = Some(workspace);
        }
    }

    selected
}

fn canonical_file_paths(paths: Vec<String>) -> Result<Vec<PathBuf>, String> {
    let mut seen_paths = HashSet::new();
    let mut resolved_paths = Vec::new();

    for path in paths {
        let resolved_path = canonical_selection_path(&path, SelectionKind::File)?;

        if seen_paths.insert(path_key(&resolved_path)) {
            resolved_paths.push(resolved_path);
        }
    }

    if resolved_paths.is_empty() {
        return Err("The file action did not include any files.".to_string());
    }

    Ok(resolved_paths)
}

#[derive(Debug, Clone, Copy)]
enum SelectionKind {
    File,
    Folder,
}

fn canonical_selection_path(path: &str, kind: SelectionKind) -> Result<PathBuf, String> {
    if path.is_empty() {
        return Err("The file-manager selection contained an empty path.".to_string());
    }

    let candidate = PathBuf::from(path);
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("Unable to resolve selected path `{path}`: {error}"))?;
    let metadata = fs::metadata(&resolved)
        .map_err(|error| format!("Unable to inspect selected path `{path}`: {error}"))?;
    let expected_kind_matches = match kind {
        SelectionKind::File => metadata.is_file(),
        SelectionKind::Folder => metadata.is_dir(),
    };

    if !expected_kind_matches {
        let expected = match kind {
            SelectionKind::File => "file",
            SelectionKind::Folder => "folder",
        };
        return Err(format!(
            "Expected selected path `{path}` to be a {expected}."
        ));
    }

    Ok(resolved)
}

fn paths_match(left: &Path, right: &Path) -> bool {
    path_key(left) == path_key(right)
}

fn path_key(path: &Path) -> String {
    let formatted = crate::desktop_task::format_path_for_ui(path);

    #[cfg(windows)]
    {
        formatted.to_lowercase()
    }

    #[cfg(not(windows))]
    {
        formatted
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs::{self, File},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::*;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn create(name: &str) -> Self {
            let sequence = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "machdoch-file-manager-{name}-{}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self(path)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).expect("remove test directory");
        }
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn parses_unicode_folder_paths_with_spaces() {
        let args = vec![
            "machdoch".to_string(),
            "--ui".to_string(),
            OPEN_FOLDER_ARG.to_string(),
            "/tmp/Project files/Grüße".to_string(),
        ];

        assert_eq!(
            parse_invocation_args(&args).expect("parse folder invocation"),
            Some(FileManagerInvocation::Folder {
                path: "/tmp/Project files/Grüße".to_string(),
            })
        );
    }

    #[test]
    fn parses_multiple_file_arguments_without_splitting_paths() {
        let args = vec![
            "machdoch".to_string(),
            ATTACH_FILES_ARG.to_string(),
            "/tmp/one file.txt".to_string(),
            "/tmp/二.txt".to_string(),
        ];

        assert_eq!(
            parse_invocation_args(&args).expect("parse file invocation"),
            Some(FileManagerInvocation::Files {
                paths: vec!["/tmp/one file.txt".to_string(), "/tmp/二.txt".to_string()],
            })
        );
    }

    #[test]
    fn rejects_incomplete_and_conflicting_invocations() {
        assert!(parse_invocation_args(&[OPEN_FOLDER_ARG.to_string()]).is_err());
        assert!(parse_invocation_args(&[
            OPEN_FOLDER_ARG.to_string(),
            "/tmp/project".to_string(),
            ATTACH_FILES_ARG.to_string(),
            "/tmp/file".to_string(),
        ])
        .is_err());
    }

    #[test]
    fn known_and_unknown_folders_route_to_the_expected_destination() {
        let directory = TestDirectory::create("folders");
        let known = directory.0.join("known");
        let unknown = directory.0.join("unknown");
        fs::create_dir_all(&known).expect("create known workspace");
        fs::create_dir_all(&unknown).expect("create unknown workspace");
        let registered_root = path_string(&known);

        let known_route = resolve_invocation_route(
            FileManagerInvocation::Folder {
                path: registered_root.clone(),
            },
            vec![registered_root.clone()],
        )
        .expect("resolve known folder");
        let unknown_route = resolve_invocation_route(
            FileManagerInvocation::Folder {
                path: path_string(&unknown),
            },
            vec![registered_root.clone()],
        )
        .expect("resolve unknown folder");

        assert_eq!(known_route.destination, FileManagerDestination::Chat);
        assert_eq!(known_route.workspace_root, Some(registered_root));
        assert_eq!(
            unknown_route.destination,
            FileManagerDestination::WorkspaceManagement
        );
        assert_eq!(
            unknown_route.workspace_root,
            Some(crate::desktop_task::format_path_for_ui(
                &unknown.canonicalize().expect("canonical unknown workspace")
            ))
        );
    }

    #[test]
    fn files_use_the_most_specific_common_workspace_and_preserve_payload_order() {
        let directory = TestDirectory::create("nested");
        let outer = directory.0.join("outer");
        let nested = outer.join("nested workspace");
        fs::create_dir_all(&nested).expect("create nested workspace");
        let first = nested.join("first file.txt");
        let second = nested.join("überblick.txt");
        File::create(&first).expect("create first file");
        File::create(&second).expect("create second file");
        let nested_root = path_string(&nested);

        let route = resolve_invocation_route(
            FileManagerInvocation::Files {
                paths: vec![path_string(&first), path_string(&second)],
            },
            vec![path_string(&outer), nested_root.clone()],
        )
        .expect("resolve files");

        assert_eq!(route.destination, FileManagerDestination::Chat);
        assert_eq!(route.workspace_root, Some(nested_root));
        assert_eq!(
            route.attachment_paths,
            vec![
                crate::desktop_task::format_path_for_ui(
                    &first.canonicalize().expect("canonical first file")
                ),
                crate::desktop_task::format_path_for_ui(
                    &second.canonicalize().expect("canonical second file")
                ),
            ]
        );
    }

    #[test]
    fn files_without_one_common_workspace_route_with_not_set() {
        let directory = TestDirectory::create("outside");
        let workspace = directory.0.join("workspace");
        let outside = directory.0.join("outside");
        fs::create_dir_all(&workspace).expect("create workspace");
        fs::create_dir_all(&outside).expect("create outside directory");
        let inside_file = workspace.join("inside.txt");
        let outside_file = outside.join("outside.txt");
        File::create(&inside_file).expect("create inside file");
        File::create(&outside_file).expect("create outside file");

        let route = resolve_invocation_route(
            FileManagerInvocation::Files {
                paths: vec![path_string(&inside_file), path_string(&outside_file)],
            },
            vec![path_string(&workspace)],
        )
        .expect("resolve mixed files");

        assert_eq!(route.destination, FileManagerDestination::Chat);
        assert_eq!(route.workspace_root, None);
        assert_eq!(route.attachment_paths.len(), 2);
    }
}
