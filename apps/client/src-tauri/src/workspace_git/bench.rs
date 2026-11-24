use std::{
    cell::Cell,
    env, fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant},
};

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;

use super::{
    actions::execute_workspace_git_action, branches, diff::load_diff, history, index_update,
    overview, repositories_status, run_required, summary,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BenchFixtures {
    large_repository: PathBuf,
    large_repository_changed_file: String,
    multi_repository_workspace: PathBuf,
    branch_repository: PathBuf,
    reference_workspace: Option<PathBuf>,
    samples: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurement {
    name: String,
    fixture: String,
    temperature: String,
    samples: Vec<f64>,
    p50: f64,
    p95: f64,
}

fn percentile(sorted: &[f64], fraction: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn request<T: DeserializeOwned>(value: serde_json::Value) -> T {
    serde_json::from_value(value).expect("the benchmark request should deserialize")
}

struct Recorder {
    samples: usize,
    measurements: Vec<Measurement>,
}

impl Recorder {
    fn measure<R>(
        &mut self,
        name: &str,
        fixture: &str,
        reset: impl Fn(),
        operation: impl FnMut() -> Result<R, String>,
    ) {
        self.measure_after(name, fixture, reset, || Ok(()), operation);
    }

    fn measure_after<R>(
        &mut self,
        name: &str,
        fixture: &str,
        reset: impl Fn(),
        mut setup: impl FnMut() -> Result<(), String>,
        mut operation: impl FnMut() -> Result<R, String>,
    ) {
        for temperature in ["cold", "warm"] {
            let mut samples = Vec::with_capacity(self.samples);
            if temperature == "warm" {
                for _ in 0..2 {
                    setup().unwrap_or_else(|error| panic!("{name} setup failed: {error}"));
                    operation().unwrap_or_else(|error| panic!("{name} failed: {error}"));
                }
            }
            for _ in 0..self.samples {
                setup().unwrap_or_else(|error| panic!("{name} setup failed: {error}"));
                if temperature == "cold" {
                    reset();
                }
                let started = Instant::now();
                operation().unwrap_or_else(|error| panic!("{name} failed: {error}"));
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
            }
            let mut sorted = samples.clone();
            sorted.sort_by(f64::total_cmp);
            self.measurements.push(Measurement {
                name: name.to_string(),
                fixture: fixture.to_string(),
                temperature: temperature.to_string(),
                p50: percentile(&sorted, 0.5),
                p95: percentile(&sorted, 0.95),
                samples,
            });
        }
    }
}

fn edit_and_wait(repository: &Path, file: &str, toggle: &Cell<bool>) -> Result<(), String> {
    let before = crate::workspace_watch::worktree_generation(repository);
    toggle.set(!toggle.get());
    let content = if toggle.get() {
        "edited a\n"
    } else {
        "edited b\n"
    };
    fs::write(repository.join(file), content).map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while crate::workspace_watch::worktree_generation(repository) == before {
        if Instant::now() > deadline {
            return Err("The watcher did not report the edit.".to_string());
        }
        thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}

fn root_text(path: &Path) -> String {
    path.display().to_string()
}

fn reset_caches() {
    super::reset_process_caches();
    crate::workspace_tools::file_index::reset_indexes();
}

fn overview_options() -> overview::OverviewOptions {
    overview::OverviewOptions::parse(
        Some(&[
            "branches".to_string(),
            "numstat".to_string(),
            "recentCommits".to_string(),
        ]),
        Some("all"),
    )
    .expect("the overview options should parse")
}

fn measure_repository(recorder: &mut Recorder, fixture: &str, repository: &Path) {
    let root = root_text(repository);
    recorder.measure("summary", fixture, reset_caches, || {
        summary::load_summary(&root)
    });
    recorder.measure("overview", fixture, reset_caches, || {
        overview::load_overview(&root, &root, &overview_options())
    });
}

fn measure_large_repository(recorder: &mut Recorder, repository: &Path, changed_file: &str) {
    let root = root_text(repository);
    measure_repository(recorder, "large repo", repository);
    crate::workspace_watch::ensure_watching(repository);
    let toggle = Cell::new(false);
    let edit = || edit_and_wait(repository, changed_file, &toggle);
    recorder.measure_after(
        "summary after edit",
        "large repo",
        reset_caches,
        edit,
        || summary::load_summary(&root),
    );
    recorder.measure_after(
        "overview after edit",
        "large repo",
        reset_caches,
        edit,
        || overview::load_overview(&root, &root, &overview_options()),
    );
    recorder.measure_after(
        "single-file diff after edit",
        "large repo",
        reset_caches,
        edit,
        || {
            load_diff(request(json!({
                "workspaceRoot": root,
                "repositoryRoot": root,
                "relativePath": changed_file,
            })))
        },
    );
    recorder.measure("single-file diff", "large repo", reset_caches, || {
        load_diff(request(json!({
            "workspaceRoot": root,
            "repositoryRoot": root,
            "relativePath": changed_file,
        })))
    });
    recorder.measure("graph page", "large repo", reset_caches, || {
        history::load_graph(request(json!({
            "workspaceRoot": root,
            "repositoryRoot": root,
        })))
    });
    let path_action = |action: &str| {
        execute_workspace_git_action(request(json!({
            "workspaceRoot": root,
            "repositoryRoot": root,
            "action": action,
            "paths": [changed_file],
            "sections": ["numstat"],
            "untrackedFiles": "all",
        })))
    };
    recorder.measure_after(
        "stage → UI updated",
        "large repo",
        reset_caches,
        || path_action("unstage").map(|_| ()),
        || path_action("stage"),
    );
    recorder.measure_after(
        "index stage (git process)",
        "large repo",
        reset_caches,
        || path_action("unstage").map(|_| ()),
        || {
            run_required(
                "git",
                &["update-index", "--add", "--remove", "--", changed_file],
                repository,
            )
        },
    );
    recorder.measure_after(
        "index stage (gix)",
        "large repo",
        reset_caches,
        || path_action("unstage").map(|_| ()),
        || {
            index_update::update_paths(
                repository,
                &[changed_file],
                index_update::IndexUpdate::Stage,
            )
        },
    );
    path_action("unstage").expect("the benchmark file should unstage");
    recorder.measure(
        "stage → commit → refresh",
        "large repo",
        reset_caches,
        || {
            execute_workspace_git_action(request(json!({
                "workspaceRoot": root,
                "repositoryRoot": root,
                "action": "stage",
                "paths": [changed_file],
            })))?;
            let committed = execute_workspace_git_action(request(json!({
                "workspaceRoot": root,
                "repositoryRoot": root,
                "action": "commit",
                "message": "Benchmark commit",
            })));
            run_required(
                "git",
                &["reset", "--quiet", "--mixed", "HEAD~1"],
                repository,
            )?;
            committed
        },
    );
}

fn measure_quick_open(recorder: &mut Recorder, repository: &Path) {
    let root = root_text(repository);
    recorder.measure("quick open", "large repo", reset_caches, || {
        crate::workspace_tools::file_index::search_files(request(json!({
            "workspaceRoot": root,
            "query": "file-4999",
        })))
    });
}

fn measure_branch_repository(recorder: &mut Recorder, repository: &Path) {
    let root = root_text(repository);
    recorder.measure("branch picker open", "1k branches", reset_caches, || {
        branches::load_branch_list(request(json!({
            "workspaceRoot": root,
            "repositoryRoot": root,
        })))
    });
    recorder.measure("graph page", "1k branches", reset_caches, || {
        history::load_graph(request(json!({
            "workspaceRoot": root,
            "repositoryRoot": root,
            "scope": "all",
        })))
    });
}

fn measure_workspace(recorder: &mut Recorder, fixture: &str, workspace: &Path) {
    let root = root_text(workspace);
    recorder.measure("repositories status", fixture, reset_caches, || {
        repositories_status::load_repositories_status(request(json!({
            "workspaceRoot": root,
        })))
    });
}

fn measure_workspace_after_edit(recorder: &mut Recorder, fixture: &str, workspace: &Path) {
    let root = root_text(workspace);
    crate::workspace_watch::ensure_watching(workspace);
    let toggle = Cell::new(false);
    recorder.measure_after(
        "repositories status after edit",
        fixture,
        reset_caches,
        || edit_and_wait(workspace, "bench-edit.txt", &toggle),
        || {
            repositories_status::load_repositories_status(request(json!({
                "workspaceRoot": root,
            })))
        },
    );
    let _ = fs::remove_file(workspace.join("bench-edit.txt"));
}

#[test]
#[ignore = "run through scripts/bench-workspace-git.mjs"]
fn workspace_git_benchmark() {
    let fixtures_path = env::var("MACHDOCH_GIT_BENCH_FIXTURES")
        .expect("MACHDOCH_GIT_BENCH_FIXTURES should point to the fixture description");
    let output_path = env::var("MACHDOCH_GIT_BENCH_OUTPUT")
        .expect("MACHDOCH_GIT_BENCH_OUTPUT should point to the result file");
    let fixtures: BenchFixtures = serde_json::from_str(
        &fs::read_to_string(&fixtures_path).expect("the fixture description should be readable"),
    )
    .expect("the fixture description should be valid");
    let mut recorder = Recorder {
        samples: fixtures.samples.max(3),
        measurements: Vec::new(),
    };
    measure_large_repository(
        &mut recorder,
        &fixtures.large_repository,
        &fixtures.large_repository_changed_file,
    );
    measure_quick_open(&mut recorder, &fixtures.large_repository);
    measure_branch_repository(&mut recorder, &fixtures.branch_repository);
    measure_workspace(
        &mut recorder,
        "6 repos",
        &fixtures.multi_repository_workspace,
    );
    measure_workspace_after_edit(
        &mut recorder,
        "6 repos",
        &fixtures.multi_repository_workspace,
    );
    if let Some(reference) = fixtures.reference_workspace.as_deref() {
        measure_repository(&mut recorder, "alphartis.annie", reference);
        measure_workspace(&mut recorder, "alphartis.annie", reference);
    }
    fs::write(
        &output_path,
        serde_json::to_string_pretty(&recorder.measurements)
            .expect("the measurements should serialize"),
    )
    .expect("the measurements should be written");
}
