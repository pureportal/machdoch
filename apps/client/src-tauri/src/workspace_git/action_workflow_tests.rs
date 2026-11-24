use std::{fs, path::PathBuf};

use super::{
    action_tests::TestRepository, undo::load_undo, WorkspaceGitActionRequest,
    WorkspaceGitRepositoryRequest,
};

struct BareRemote(PathBuf);

impl BareRemote {
    fn attach(repository: &TestRepository) -> Self {
        let path = repository.path().with_extension("remote");
        let remote = path.display().to_string();
        repository.git(&["init", "--quiet", "--bare", "-b", "main", &remote]);
        repository.git(&["remote", "add", "origin", &remote]);
        repository.git(&["push", "--quiet", "--set-upstream", "origin", "main"]);
        Self(path)
    }

    fn git(&self, arguments: &[&str]) -> String {
        let git_directory = format!("--git-dir={}", self.0.display());
        let arguments = [&[git_directory.as_str()][..], arguments].concat();
        super::run_required("git", &arguments, &self.0)
            .unwrap_or_else(|error| panic!("git {arguments:?} failed in the remote: {error}"))
    }
}

impl Drop for BareRemote {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn paths(paths: &[&str]) -> impl FnOnce(&mut WorkspaceGitActionRequest) {
    let paths = paths
        .iter()
        .map(|path| path.to_string())
        .collect::<Vec<_>>();
    move |request| request.paths = Some(paths)
}

fn patch(patch: &str, target: &str, reverse: bool) -> impl FnOnce(&mut WorkspaceGitActionRequest) {
    let patch = patch.to_string();
    let target = target.to_string();
    move |request| {
        request.patch = Some(patch);
        request.patch_target = Some(target);
        request.reverse = Some(reverse);
    }
}

fn text(repository: &TestRepository, path: &str) -> String {
    fs::read_to_string(repository.path().join(path))
        .expect("the file should read")
        .replace("\r\n", "\n")
}

fn head_subject(repository: &TestRepository) -> String {
    repository
        .git(&["log", "-1", "--format=%s"])
        .trim()
        .to_string()
}

#[test]
fn commits_with_sign_off_co_authors_push_and_amend() {
    let repository = TestRepository::new("commit-options");
    let _remote = BareRemote::attach(&repository);
    repository.write("feature.txt", "one\n");
    repository.git(&["add", "feature.txt"]);
    repository
        .action("commit", |request| {
            request.message = Some("Add feature".to_string());
            request.sign_off = Some(true);
            request.co_authors = Some(vec!["Ada Example <ada@example.test>".to_string()]);
            request.push_after_commit = Some(true);
        })
        .expect("the commit should succeed");
    let message = repository.git(&["log", "-1", "--format=%B"]);
    assert!(message.contains("Signed-off-by: Audit <audit@example.test>"));
    assert!(message.contains("Co-authored-by: Ada Example <ada@example.test>"));
    assert_eq!(
        repository.git(&["rev-parse", "HEAD"]),
        repository.git(&["rev-parse", "origin/main"])
    );

    let count = repository.git(&["rev-list", "--count", "HEAD"]);
    repository
        .action("commit", |request| {
            request.message = Some("Add the feature".to_string());
            request.amend = Some(true);
        })
        .expect("the amend should succeed");
    assert_eq!(repository.git(&["rev-list", "--count", "HEAD"]), count);
    assert_eq!(head_subject(&repository), "Add the feature");
    let invalid = repository
        .action("commit", |request| {
            request.message = Some("Invalid co-author".to_string());
            request.amend = Some(true);
            request.co_authors = Some(vec!["no email".to_string()]);
        })
        .expect_err("a co-author needs a name and email");
    assert!(!invalid.is_empty());
    assert_eq!(head_subject(&repository), "Add the feature");
}

#[test]
fn stages_unstages_and_discards_selected_lines() {
    let repository = TestRepository::new("line-patches");
    repository.commit_file("lines.txt", "a\nb\nc\n", "lines");
    repository.write("lines.txt", "a\nB\nc\nd\n");
    let added_line = "diff --git a/lines.txt b/lines.txt\n--- a/lines.txt\n+++ b/lines.txt\n@@ -1,3 +1,4 @@\n a\n b\n c\n+d\n";
    let changed_line = "diff --git a/lines.txt b/lines.txt\n--- a/lines.txt\n+++ b/lines.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n";

    repository
        .action("apply-patch", patch(added_line, "index", false))
        .expect("the selected line should stage");
    let staged = repository.git(&["diff", "--cached"]);
    assert!(staged.contains("+d"));
    assert!(!staged.contains("+B"));

    repository
        .action("apply-patch", patch(added_line, "index", true))
        .expect("the selected line should unstage");
    assert!(repository.git(&["diff", "--cached"]).trim().is_empty());

    repository
        .action("apply-patch", patch(changed_line, "worktree", true))
        .expect("the selected line should be discarded");
    assert_eq!(text(&repository, "lines.txt"), "a\nb\nc\nd\n");
    assert!(repository
        .action("apply-patch", patch("not a patch", "index", false))
        .is_err());
}

#[test]
fn resolves_conflicts_per_file_then_continues_the_merge() {
    let repository = TestRepository::new("conflict-resolution");
    repository.commit_file("ours.txt", "base\n", "ours base");
    repository.commit_file("edited.txt", "base\n", "edited base");
    repository.git(&["switch", "-c", "side"]);
    repository.commit_file("ours.txt", "side\n", "side ours");
    repository.commit_file("edited.txt", "side\n", "side edited");
    repository.git(&["switch", "main"]);
    repository.commit_file("ours.txt", "main\n", "main ours");
    repository.commit_file("edited.txt", "main\n", "main edited");
    repository
        .action("merge", |request| {
            request.branch_name = Some("side".to_string())
        })
        .expect_err("the merge should conflict");
    assert_eq!(repository.overview().conflicted_count, 2);

    repository
        .action("resolve-conflict", |request| {
            request.paths = Some(vec!["ours.txt".to_string()]);
            request.side = Some("theirs".to_string());
        })
        .expect("the file should take their side");
    assert_eq!(text(&repository, "ours.txt"), "side\n");
    repository.write("edited.txt", "main and side\n");
    let resolved = repository
        .action("mark-resolved", paths(&["edited.txt"]))
        .expect("the edited file should be marked resolved");
    assert_eq!(resolved.conflicted_count, 0);
    let continued = repository
        .action("continue-operation", |_| {})
        .expect("the merge should continue");
    assert_eq!(continued.operation, None);
    assert!(
        repository
            .git(&["log", "-1", "--format=%P"])
            .split_whitespace()
            .count()
            == 2
    );
}

#[test]
fn cherry_picks_reverts_and_manages_tags_on_the_remote() {
    let repository = TestRepository::new("history-actions");
    let remote = BareRemote::attach(&repository);
    repository.git(&["switch", "-c", "side"]);
    repository.commit_file("picked.txt", "picked\n", "picked change");
    let picked = repository.git(&["rev-parse", "HEAD"]).trim().to_string();
    repository.git(&["switch", "main"]);

    repository
        .action("cherry-pick", |request| {
            request.commit = Some(picked.clone())
        })
        .expect("the commit should be cherry-picked");
    assert_eq!(head_subject(&repository), "picked change");
    let applied = repository.git(&["rev-parse", "HEAD"]).trim().to_string();
    repository
        .action("revert", |request| request.commit = Some(applied.clone()))
        .expect("the commit should be reverted");
    assert!(head_subject(&repository).starts_with("Revert"));
    assert!(!repository.path().join("picked.txt").exists());

    let tag = |action: &str, remote: bool| {
        repository.action(action, move |request| {
            request.tag_name = Some("v1.0.0".to_string());
            request.remote = Some(remote);
        })
    };
    tag("create-tag", false).expect("the tag should be created");
    tag("push-tag", false).expect("the tag should be pushed");
    assert!(remote.git(&["tag", "--list"]).contains("v1.0.0"));
    tag("delete-tag", true).expect("the tag should be deleted everywhere");
    assert!(repository.git(&["tag", "--list"]).trim().is_empty());
    assert!(remote.git(&["tag", "--list"]).trim().is_empty());
}

#[test]
fn undoes_the_last_commit_after_reviewing_it() {
    let repository = TestRepository::new("undo");
    let before = repository.git(&["rev-parse", "HEAD"]).trim().to_string();
    repository.commit_file("undo.txt", "undo\n", "to undo");
    let root = repository.path().display().to_string();
    let preview = load_undo(WorkspaceGitRepositoryRequest {
        workspace_root: root.clone(),
        repository_root: root,
    })
    .expect("the undo should load")
    .expect("the commit should be undoable");
    let preview = serde_json::to_value(preview).expect("the preview should serialize");
    assert_eq!(preview["kind"], "commit");
    assert_eq!(preview["target"], before.as_str());
    assert_eq!(preview["files"][0]["path"], "undo.txt");

    assert!(repository
        .action("undo", |request| request.target = Some("0".repeat(40)))
        .is_err());
    repository
        .action("undo", |request| request.target = Some(before.clone()))
        .expect("the commit should be undone");
    assert_eq!(repository.git(&["rev-parse", "HEAD"]).trim(), before);
    assert!(repository
        .git(&["diff", "--cached", "--name-only"])
        .contains("undo.txt"));
}

#[test]
fn deletes_selected_branches_and_keeps_unmerged_ones_without_force() {
    let repository = TestRepository::new("branch-cleanup");
    repository.git(&["branch", "merged"]);
    repository.git(&["switch", "-c", "unmerged"]);
    repository.commit_file("unmerged.txt", "work\n", "unmerged work");
    repository.git(&["switch", "main"]);
    let names = || {
        |request: &mut WorkspaceGitActionRequest| {
            request.branch_names = Some(vec!["merged".to_string(), "unmerged".to_string()]);
        }
    };

    let error = repository
        .action("delete-branches", names())
        .expect_err("the unmerged branch should be kept");
    assert!(error.starts_with("unmerged:"));
    let branches = repository.git(&["branch", "--format=%(refname:short)"]);
    assert!(!branches.lines().any(|name| name == "merged"));
    assert!(branches.lines().any(|name| name == "unmerged"));

    repository
        .action("delete-branches", |request| {
            request.branch_names = Some(vec!["unmerged".to_string()]);
            request.force = Some(true);
        })
        .expect("the unmerged branch should be force deleted");
    assert_eq!(
        repository
            .git(&["branch", "--format=%(refname:short)"])
            .trim(),
        "main"
    );
}

#[test]
fn fixes_a_missing_upstream_a_stale_lock_and_a_diverged_branch() {
    let repository = TestRepository::new("error-fixes");
    let remote = BareRemote::attach(&repository);
    repository.git(&["switch", "-c", "feature"]);
    repository.commit_file("feature.txt", "feature\n", "feature");
    let published = repository
        .action("set-upstream", |_| {})
        .expect("the branch should be published");
    assert_eq!(published.upstream.as_deref(), Some("origin/feature"));

    let lock = repository.path().join(".git/index.lock");
    fs::write(&lock, "").expect("the lock should be created");
    repository
        .action("remove-index-lock", |_| {})
        .expect("the stale lock should be removed");
    assert!(!lock.exists());
    assert!(repository.action("remove-index-lock", |_| {}).is_err());

    let clone = repository.path().with_extension("clone");
    let clone_path = clone.display().to_string();
    remote.git(&[
        "clone",
        "--quiet",
        "--branch",
        "feature",
        &remote.0.display().to_string(),
        &clone_path,
    ]);
    let in_clone = |arguments: &[&str]| {
        super::run_required("git", arguments, &clone)
            .unwrap_or_else(|error| panic!("git {arguments:?} failed in the clone: {error}"))
    };
    in_clone(&["config", "user.email", "audit@example.test"]);
    in_clone(&["config", "user.name", "Audit"]);
    in_clone(&["config", "commit.gpgsign", "false"]);
    fs::write(clone.join("remote.txt"), "remote\n").expect("the clone file should write");
    in_clone(&["add", "remote.txt"]);
    in_clone(&["commit", "--quiet", "-m", "remote change"]);
    in_clone(&["push", "--quiet"]);
    let _ = fs::remove_dir_all(&clone);

    repository.commit_file("local.txt", "local\n", "local change");
    repository
        .action("fetch", |_| {})
        .expect("the remote should fetch");
    assert!(repository.action("push", |_| {}).is_err());
    let rebased = repository
        .action("pull-rebase", |_| {})
        .expect("the branch should rebase onto its upstream");
    assert_eq!((rebased.ahead, rebased.behind), (1, 0));
    repository
        .action("push", |_| {})
        .expect("the rebased branch should push");
}

#[test]
fn discarded_changes_stay_recoverable_as_a_stash() {
    let repository = TestRepository::new("discard");
    repository.commit_file("kept.txt", "kept\n", "kept");
    repository.write("kept.txt", "edited\n");
    repository.write("new.txt", "new\n");
    let discarded = repository
        .action("discard", paths(&["kept.txt", "new.txt"]))
        .expect("the changes should be discarded");
    assert!(discarded.clean);
    assert_eq!(text(&repository, "kept.txt"), "kept\n");
    assert!(!repository.path().join("new.txt").exists());
    repository.git(&["stash", "pop", "--quiet"]);
    assert_eq!(text(&repository, "kept.txt"), "edited\n");
    assert!(repository.path().join("new.txt").exists());
}
