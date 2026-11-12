use std::{
    env, fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::SystemTime,
};

use super::{
    actions::execute_workspace_git_action, command_succeeds, load_overview, run_required,
    stack::read_parents, WorkspaceGitActionRequest, WorkspaceGitOverview,
};

static NEXT_REPOSITORY: AtomicU64 = AtomicU64::new(0);

struct TestRepository {
    root: PathBuf,
}

impl TestRepository {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!(
            "machdoch-git-actions-{}-{unique}-{}-{name}",
            std::process::id(),
            NEXT_REPOSITORY.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("the repository should be created");
        let repository = Self { root };
        repository.git(&["init", "-b", "main"]);
        repository.git(&["config", "user.email", "audit@example.test"]);
        repository.git(&["config", "user.name", "Audit"]);
        repository.git(&["config", "commit.gpgsign", "false"]);
        repository.commit_file("readme.md", "base\n", "base");
        repository
    }

    fn git(&self, arguments: &[&str]) -> String {
        run_required("git", arguments, &self.root)
            .unwrap_or_else(|error| panic!("git {arguments:?} failed: {error}"))
    }

    fn write(&self, path: &str, content: &str) {
        let path = self.root.join(path);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("the parent directory should be created");
        }
        fs::write(path, content).expect("the file should write");
    }

    fn commit_file(&self, path: &str, content: &str, message: &str) {
        self.write(path, content);
        self.git(&["add", "--", path]);
        self.git(&["commit", "-m", message]);
    }

    fn action(
        &self,
        action: &str,
        configure: impl FnOnce(&mut WorkspaceGitActionRequest),
    ) -> Result<WorkspaceGitOverview, String> {
        let mut request = WorkspaceGitActionRequest {
            workspace_root: self.root.display().to_string(),
            repository_root: self.root.display().to_string(),
            action: action.to_string(),
            ..Default::default()
        };
        configure(&mut request);
        execute_workspace_git_action(request)
    }

    fn overview(&self) -> WorkspaceGitOverview {
        load_overview(
            &self.root.display().to_string(),
            &self.root.display().to_string(),
        )
        .expect("the overview should load")
    }

    fn is_ancestor(&self, ancestor: &str, descendant: &str) -> bool {
        command_succeeds(
            "git",
            &["merge-base", "--is-ancestor", ancestor, descendant],
            &self.root,
        )
        .expect("ancestry should be readable")
    }

    fn path(&self) -> &Path {
        &self.root
    }
}

impl Drop for TestRepository {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn branch(name: &str) -> impl FnOnce(&mut WorkspaceGitActionRequest) + '_ {
    move |request| request.branch_name = Some(name.to_string())
}

#[test]
fn stages_commits_and_stashes_changes() {
    let repository = TestRepository::new("changes");
    repository.write("readme.md", "changed\n");
    repository.write("src/new.ts", "export {};\n");

    let staged = repository
        .action("stage", |request| {
            request.paths = Some(vec!["readme.md".to_string()])
        })
        .expect("a file should stage");
    assert_eq!((staged.staged_count, staged.untracked_count), (1, 1));

    let unstaged = repository
        .action("unstage", |request| {
            request.paths = Some(vec!["readme.md".to_string()])
        })
        .expect("a file should unstage");
    assert_eq!(unstaged.staged_count, 0);

    assert!(repository
        .action("commit", |request| request.message = Some("  ".to_string()))
        .is_err());
    repository.action("stage-all", |_| {}).expect("all files should stage");
    let committed = repository
        .action("commit", |request| {
            request.message = Some("Add module".to_string())
        })
        .expect("the commit should succeed");
    assert!(committed.clean);
    assert_eq!(committed.recent_commits[0].subject, "Add module");
    assert_eq!(committed.recent_commits.len(), 2);

    repository.write("readme.md", "work in progress\n");
    repository.write("scratch.txt", "scratch\n");
    let stashed = repository
        .action("stash-push", |request| {
            request.message = Some("wip\nnotes".to_string());
            request.include_untracked = Some(true);
        })
        .expect("changes should stash");
    assert!(stashed.clean);
    assert_eq!(stashed.stashes.len(), 1);
    assert_eq!(stashed.stashes[0].reference, "stash@{0}");
    assert!(stashed.stashes[0].message.ends_with("wip notes"));

    assert!(repository
        .action("stash-pop", |request| request.stash_ref = Some("stash@{x}".to_string()))
        .is_err());
    let popped = repository
        .action("stash-pop", |request| {
            request.stash_ref = Some("stash@{0}".to_string())
        })
        .expect("the stash should pop");
    assert!(popped.stashes.is_empty());
    assert_eq!(popped.total_changes, 2);
}

#[test]
fn merge_and_rebase_conflicts_can_be_aborted_or_continued() {
    let repository = TestRepository::new("conflicts");
    repository.git(&["switch", "-c", "side"]);
    repository.commit_file("readme.md", "side\n", "side");
    repository.git(&["switch", "main"]);
    repository.commit_file("readme.md", "main\n", "main");

    let error = repository
        .action("merge", branch("side"))
        .expect_err("the merge should conflict");
    assert!(error.contains("stopped with conflicts"));
    assert_eq!(repository.overview().operation.as_deref(), Some("merge"));
    let aborted = repository
        .action("abort-operation", |_| {})
        .expect("the merge should abort");
    assert_eq!(aborted.operation, None);
    assert!(aborted.clean);

    repository.git(&["switch", "side"]);
    repository
        .action("rebase", branch("main"))
        .expect_err("the rebase should conflict");
    assert_eq!(repository.overview().operation.as_deref(), Some("rebase"));
    repository.write("readme.md", "resolved\n");
    repository
        .action("stage", |request| {
            request.paths = Some(vec!["readme.md".to_string()])
        })
        .expect("the resolution should stage");
    let continued = repository
        .action("continue-operation", |_| {})
        .expect("the rebase should continue");
    assert_eq!(continued.operation, None);
    assert!(repository.is_ancestor("main", "side"));
    assert!(repository.action("abort-operation", |_| {}).is_err());
}

#[test]
fn stacked_branches_restack_after_parent_changes() {
    let repository = TestRepository::new("stack");
    repository
        .action("create-stacked-branch", branch("feat/a"))
        .expect("the first stacked branch should create");
    repository.commit_file("a.txt", "a\n", "a");
    let stacked = repository
        .action("create-stacked-branch", branch("feat/b"))
        .expect("the second stacked branch should create");
    repository.commit_file("b.txt", "b\n", "b");
    let feat_b = stacked
        .local_branches
        .iter()
        .find(|candidate| candidate.name == "feat/b")
        .expect("feat/b should be listed");
    assert_eq!(feat_b.parent.as_deref(), Some("feat/a"));
    assert!(!feat_b.needs_restack);

    repository.git(&["switch", "main"]);
    repository.commit_file("main.txt", "main\n", "main moves");
    repository.git(&["switch", "feat/a"]);
    repository.write("a.txt", "a amended\n");
    repository.git(&["commit", "-am", "a amended", "--amend"]);
    repository.git(&["switch", "feat/b"]);
    let stale = repository.overview();
    assert!(stale
        .local_branches
        .iter()
        .any(|candidate| candidate.name == "feat/a" && candidate.needs_restack));
    assert!(stale
        .local_branches
        .iter()
        .any(|candidate| candidate.name == "feat/b" && candidate.needs_restack));

    let restacked = repository
        .action("restack", |_| {})
        .expect("the stack should restack");
    assert_eq!(restacked.branch, "feat/b");
    assert!(restacked
        .local_branches
        .iter()
        .all(|candidate| !candidate.needs_restack));
    assert!(repository.is_ancestor("main", "feat/a"));
    assert!(repository.is_ancestor("feat/a", "feat/b"));
    assert_eq!(repository.git(&["rev-list", "--count", "feat/a..feat/b"]), "1");
    assert_eq!(repository.git(&["rev-list", "--count", "main..feat/b"]), "2");

    let cycle = repository.action("stack-branch", |request| {
        request.branch_name = Some("feat/a".to_string());
        request.parent_branch = Some("feat/b".to_string());
    });
    assert!(cycle.expect_err("cycles should be rejected").contains("cycle"));

    repository.git(&["switch", "main"]);
    let unmerged = repository
        .action("delete-branch", branch("feat/a"))
        .expect_err("unmerged branches should need force");
    assert!(unmerged.contains("unmerged commits"));
    repository
        .action("delete-branch", |request| {
            request.branch_name = Some("feat/a".to_string());
            request.force = Some(true);
        })
        .expect("a forced delete should succeed");
    assert_eq!(
        read_parents(repository.path()).get("feat/b").map(String::as_str),
        Some("main")
    );

    repository
        .action("unstack-branch", branch("feat/b"))
        .expect("the branch should unstack");
    assert!(read_parents(repository.path()).is_empty());
}

#[test]
fn branches_start_from_a_chosen_point_and_push_with_upstream() {
    let repository = TestRepository::new("push");
    let first = repository.git(&["rev-parse", "HEAD"]);
    repository.commit_file("next.txt", "next\n", "next");
    let from_first = repository
        .action("create-branch", |request| {
            request.branch_name = Some("hotfix".to_string());
            request.start_point = Some(first.clone());
        })
        .expect("a branch should start from a chosen commit");
    assert_eq!(from_first.branch, "hotfix");
    assert_eq!(repository.git(&["rev-parse", "HEAD"]), first);
    assert!(repository
        .action("create-branch", |request| {
            request.branch_name = Some("bad".to_string());
            request.start_point = Some("--orphan".to_string());
        })
        .is_err());

    let remote = TestRepository::new("remote");
    remote.git(&["config", "receive.denyCurrentBranch", "ignore"]);
    assert!(repository
        .action("push", |_| {})
        .expect_err("pushing without a remote should fail")
        .contains("Add a Git remote"));
    repository.git(&["remote", "add", "origin", &remote.path().display().to_string()]);
    let pushed = repository
        .action("push", |_| {})
        .expect("the branch should publish");
    assert_eq!(pushed.upstream.as_deref(), Some("origin/hotfix"));
    assert_eq!((pushed.ahead, pushed.behind), (0, 0));
}

#[test]
fn overview_tracks_the_current_branch_upstream() {
    let repository = TestRepository::new("tracking");
    let remote = TestRepository::new("tracking-remote");
    remote.git(&["fetch", &repository.path().display().to_string(), "main"]);
    remote.git(&["reset", "--hard", "FETCH_HEAD"]);
    repository.git(&["remote", "add", "origin", &remote.path().display().to_string()]);
    repository
        .action("fetch", |_| {})
        .expect("the remote should fetch");
    repository.git(&["branch", "--set-upstream-to", "origin/main"]);
    repository.commit_file("local.txt", "local\n", "local");
    remote.commit_file("remote.txt", "remote\n", "remote");
    let fetched = repository
        .action("fetch", |_| {})
        .expect("the remote should fetch again");
    assert_eq!(fetched.branch, "main");
    assert_eq!(fetched.upstream.as_deref(), Some("origin/main"));
    assert_eq!((fetched.ahead, fetched.behind), (1, 1));
    assert!(fetched
        .remote_branches
        .iter()
        .any(|branch| branch.name == "origin/main"));

    repository.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    let gone = repository.overview();
    assert_eq!(gone.upstream, None);
    assert_eq!((gone.ahead, gone.behind), (0, 0));

    repository.git(&["switch", "--detach", "HEAD"]);
    let detached = repository.overview();
    assert!(detached.detached);
    assert_eq!(detached.branch, "Detached HEAD");
    assert_eq!(detached.upstream, None);
}

#[test]
fn resets_the_current_branch_keeping_or_discarding_changes() {
    let repository = TestRepository::new("reset");
    repository.commit_file("feature.txt", "feature\n", "feature");
    repository.write("readme.md", "local edit\n");

    let kept = repository
        .action("reset", |request| {
            request.start_point = Some("HEAD~1".to_string());
            request.reset_mode = Some("keep".to_string());
        })
        .expect("the reset should keep changes");
    assert_eq!(kept.recent_commits[0].subject, "base");
    assert_eq!((kept.unstaged_count, kept.untracked_count), (1, 1));

    let discarded = repository
        .action("reset", |request| {
            request.start_point = Some("HEAD".to_string());
            request.reset_mode = Some("discard".to_string());
        })
        .expect("the reset should discard changes");
    assert_eq!((discarded.unstaged_count, discarded.untracked_count), (0, 1));

    let without_upstream = repository
        .action("reset", |_| {})
        .expect_err("a reset without a target needs an upstream");
    assert!(without_upstream.contains("no upstream"));
    assert!(repository
        .action("reset", |request| {
            request.start_point = Some("--hard".to_string())
        })
        .is_err());
    assert!(repository
        .action("reset", |request| {
            request.reset_mode = Some("everything".to_string())
        })
        .is_err());
}

#[test]
fn overview_reports_the_trunk_branch() {
    let repository = TestRepository::new("trunk");
    repository.git(&["switch", "-c", "feature"]);
    assert_eq!(repository.overview().default_branch.as_deref(), Some("main"));
}

struct RemoveOnDrop(PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn worktree_entries(overview: &WorkspaceGitOverview) -> Vec<serde_json::Value> {
    serde_json::to_value(overview).expect("the overview should serialize")["worktrees"]
        .as_array()
        .expect("worktrees should be listed")
        .clone()
}

fn worktree_for(overview: &WorkspaceGitOverview, branch: &str) -> serde_json::Value {
    worktree_entries(overview)
        .into_iter()
        .find(|entry| entry["branch"] == branch)
        .unwrap_or_else(|| panic!("no worktree for {branch}"))
}

fn ui_path(path: &Path) -> String {
    crate::desktop_task::format_path_for_ui(
        &fs::canonicalize(path).expect("the worktree should exist"),
    )
}

#[test]
fn worktrees_open_beside_the_repository_and_can_be_cleaned_up() {
    let repository = TestRepository::new("worktrees");
    let name = repository
        .root
        .file_name()
        .expect("the repository should have a name")
        .to_string_lossy()
        .to_string();
    let base = repository
        .root
        .parent()
        .expect("the repository should have a parent")
        .join(format!("{name}.worktrees"));
    let _cleanup = RemoveOnDrop(base.clone());
    repository.git(&["branch", "feature/existing"]);

    let created = repository
        .action("add-worktree", branch("feature/plat-12"))
        .expect("a worktree should open on a new branch");
    let entries = worktree_entries(&created);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["main"], true);
    assert_eq!(entries[0]["current"], true);
    let feature = base.join("feature-plat-12");
    let plat = worktree_for(&created, "feature/plat-12");
    assert_eq!(plat["path"], ui_path(&feature));
    assert_eq!(plat["main"], false);
    assert_eq!(plat["changes"], 0);
    assert!(created
        .local_branches
        .iter()
        .any(|candidate| candidate.name == "feature/plat-12"));

    let existing = repository
        .action("add-worktree", branch("feature/existing"))
        .expect("a worktree should open on an existing branch");
    assert_eq!(worktree_entries(&existing).len(), 3);
    assert!(repository
        .action("add-worktree", branch("feature/existing"))
        .expect_err("a branch cannot be checked out twice")
        .contains("feature/existing"));

    fs::write(feature.join("notes.md"), "draft\n").expect("the file should write");
    let path = feature.display().to_string();
    let target = |request: &mut WorkspaceGitActionRequest| {
        request.worktree_path = Some(path.clone());
    };
    assert_eq!(
        worktree_for(&repository.overview(), "feature/plat-12")["changes"],
        1
    );
    let locked = repository
        .action("lock-worktree", target)
        .expect("the worktree should lock");
    assert_eq!(worktree_for(&locked, "feature/plat-12")["locked"], true);
    assert!(repository
        .action("remove-worktree", |request| {
            target(request);
            request.force = Some(true);
        })
        .is_err());
    repository
        .action("unlock-worktree", target)
        .expect("the worktree should unlock");
    assert!(repository.action("remove-worktree", target).is_err());
    let removed = repository
        .action("remove-worktree", |request| {
            target(request);
            request.force = Some(true);
        })
        .expect("a forced removal should discard local changes");
    assert_eq!(worktree_entries(&removed).len(), 2);
    assert!(!feature.exists());

    assert!(repository
        .action("remove-worktree", |request| {
            request.worktree_path = Some(repository.root.display().to_string())
        })
        .expect_err("the main worktree stays")
        .contains("main worktree"));
    assert!(repository
        .action("remove-worktree", |request| {
            request.worktree_path = Some(env::temp_dir().display().to_string())
        })
        .expect_err("only listed worktrees can be removed")
        .contains("Select a worktree"));

    fs::remove_dir_all(base.join("feature-existing")).expect("the folder should delete");
    assert_eq!(
        worktree_for(&repository.overview(), "feature/existing")["prunable"],
        true
    );
    let pruned = repository
        .action("prune-worktrees", |_| {})
        .expect("stale worktrees should prune");
    assert_eq!(worktree_entries(&pruned).len(), 1);
}
