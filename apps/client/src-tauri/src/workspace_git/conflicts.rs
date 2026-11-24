use std::{fs, path::Path, thread};

use serde::Serialize;

use super::{
    command_output_bounded, file_history::validate_relative_path,
    file_history::WorkspaceGitFileRequest, repository_context,
};

const MAX_CONFLICT_VERSION_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitConflictVersions {
    relative_path: String,
    base: Option<String>,
    ours: Option<String>,
    theirs: Option<String>,
    result: Option<String>,
    binary: bool,
}

fn stage_version(
    repository: &Path,
    stage: u8,
    relative_path: &str,
) -> Result<Option<Vec<u8>>, String> {
    let object = format!(":{stage}:{relative_path}");
    let output = command_output_bounded(
        "git",
        &["show", &object],
        repository,
        MAX_CONFLICT_VERSION_BYTES + 1,
    )?;
    if !output.status.success() {
        return Ok(None);
    }
    if output.stdout.len() > MAX_CONFLICT_VERSION_BYTES {
        return Err("This conflicted file is too large for the merge editor.".to_string());
    }
    Ok(Some(output.stdout))
}

pub(super) fn load_conflict(
    request: WorkspaceGitFileRequest,
) -> Result<WorkspaceGitConflictVersions, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    let relative_path = validate_relative_path(&request.relative_path)?;
    let (base, ours, theirs) = thread::scope(|scope| {
        let base = scope.spawn(|| stage_version(&repository, 1, relative_path));
        let theirs = scope.spawn(|| stage_version(&repository, 3, relative_path));
        let ours = stage_version(&repository, 2, relative_path);
        let join = |worker: thread::ScopedJoinHandle<'_, Result<Option<Vec<u8>>, String>>| {
            worker
                .join()
                .unwrap_or_else(|_| Err("Git stopped unexpectedly.".to_string()))
        };
        (join(base), ours, join(theirs))
    });
    let (base, ours, theirs) = (base?, ours?, theirs?);
    if base.is_none() && ours.is_none() && theirs.is_none() {
        return Err("This file has no conflict to resolve.".to_string());
    }
    let result = match fs::read(repository.join(relative_path)) {
        Ok(bytes) if bytes.len() > MAX_CONFLICT_VERSION_BYTES => {
            return Err("This conflicted file is too large for the merge editor.".to_string())
        }
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("Could not read {relative_path}: {error}")),
    };
    let versions = [&base, &ours, &theirs, &result];
    let binary = versions
        .iter()
        .any(|version| version.as_ref().is_some_and(|bytes| bytes.contains(&0)));
    let text = |version: Option<Vec<u8>>| {
        (!binary)
            .then_some(version)
            .flatten()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    };
    Ok(WorkspaceGitConflictVersions {
        relative_path: relative_path.to_string(),
        base: text(base),
        ours: text(ours),
        theirs: text(theirs),
        result: text(result),
        binary,
    })
}

#[cfg(test)]
mod tests {
    use std::{env, time::SystemTime};

    use super::*;
    use crate::workspace_git::{command_output, run_required, test_repository};

    #[test]
    fn reads_base_ours_theirs_and_the_working_result() {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-git-conflict-versions-{}-{unique}",
            std::process::id()
        ));
        test_repository(&root);
        run_required("git", &["switch", "--quiet", "-c", "side"], &root).expect("switch");
        fs::write(root.join("tracked.txt"), "side\n").expect("write");
        run_required("git", &["commit", "--quiet", "-am", "side"], &root).expect("commit");
        run_required("git", &["switch", "--quiet", "main"], &root).expect("switch");
        fs::write(root.join("tracked.txt"), "main\n").expect("write");
        run_required("git", &["commit", "--quiet", "-am", "main"], &root).expect("commit");
        let merge = command_output("git", &["merge", "side"], &root).expect("merge should run");
        assert!(!merge.status.success());
        let workspace_root = root.display().to_string();
        let versions = load_conflict(WorkspaceGitFileRequest {
            workspace_root: workspace_root.clone(),
            repository_root: workspace_root,
            relative_path: "tracked.txt".to_string(),
        })
        .expect("the conflict should load");
        assert_eq!(versions.base.as_deref(), Some("base\n"));
        assert_eq!(versions.ours.as_deref(), Some("main\n"));
        assert_eq!(versions.theirs.as_deref(), Some("side\n"));
        assert!(versions
            .result
            .as_deref()
            .is_some_and(|result| result.contains("<<<<<<<")));
        assert!(!versions.binary);
        let _ = fs::remove_dir_all(root);
    }
}
