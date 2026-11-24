use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock, PoisonError},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    actions::{current_branch, push},
    command_output, config, output_error, output_text, repository_context,
};

const PULL_REQUEST_TTL: Duration = Duration::from_secs(60);
const LIST_FIELDS: &str =
    "number,title,state,url,headRefName,baseRefName,isDraft,author,updatedAt,statusCheckRollup,reviewDecision";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspacePullRequestChecksRequest {
    pub(super) workspace_root: String,
    pub(super) repository_root: String,
    pub(super) number: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePullRequest {
    number: u64,
    title: String,
    state: String,
    url: String,
    head_branch: String,
    base_branch: String,
    draft: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    checks: Option<CheckState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    review_decision: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePullRequestOverview {
    available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    items: Vec<WorkspacePullRequest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fetched_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    template: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum CheckState {
    Success,
    Neutral,
    Pending,
    Failure,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePullRequestCheck {
    name: String,
    state: CheckState,
    #[serde(skip_serializing_if = "Option::is_none")]
    workflow: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePullRequestChecks {
    number: u64,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    review_decision: Option<String>,
    checks: Vec<WorkspacePullRequestCheck>,
}

struct CachedPullRequests {
    loaded_at: Instant,
    overview: WorkspacePullRequestOverview,
    refreshing: bool,
}

static CACHE: OnceLock<Mutex<HashMap<PathBuf, CachedPullRequests>>> = OnceLock::new();

fn cache() -> MutexGuard<'static, HashMap<PathBuf, CachedPullRequests>> {
    CACHE
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn unavailable(reason: String) -> WorkspacePullRequestOverview {
    WorkspacePullRequestOverview {
        available: false,
        reason: Some(reason),
        items: Vec::new(),
        fetched_at: None,
        template: None,
    }
}

const TEMPLATE_PATHS: [&str; 6] = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "docs/pull_request_template.md",
    "docs/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
];
const MAX_TEMPLATE_BYTES: u64 = 64 * 1024;

fn read_template(repository: &Path) -> Option<String> {
    TEMPLATE_PATHS.iter().find_map(|relative| {
        let path = repository.join(relative);
        let metadata = std::fs::metadata(&path).ok()?;
        (metadata.is_file() && metadata.len() <= MAX_TEMPLATE_BYTES)
            .then(|| std::fs::read_to_string(&path).ok())
            .flatten()
    })
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn check_state(check: &Value) -> CheckState {
    let upper = |key: &str| text(check, key).map(|value| value.to_ascii_uppercase());
    if let Some(state) = upper("state") {
        return match state.as_str() {
            "SUCCESS" => CheckState::Success,
            "PENDING" | "EXPECTED" => CheckState::Pending,
            "ERROR" | "FAILURE" => CheckState::Failure,
            _ => CheckState::Neutral,
        };
    }
    if upper("status").as_deref() != Some("COMPLETED") {
        return CheckState::Pending;
    }
    match upper("conclusion").as_deref() {
        Some("SUCCESS") => CheckState::Success,
        Some("FAILURE" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE") => {
            CheckState::Failure
        }
        _ => CheckState::Neutral,
    }
}

fn parse_checks(rollup: Option<&Value>) -> Vec<WorkspacePullRequestCheck> {
    rollup
        .and_then(Value::as_array)
        .map(|checks| {
            checks
                .iter()
                .map(|check| WorkspacePullRequestCheck {
                    name: text(check, "name")
                        .or_else(|| text(check, "context"))
                        .unwrap_or_else(|| "Check".to_string()),
                    state: check_state(check),
                    workflow: text(check, "workflowName"),
                    url: text(check, "detailsUrl").or_else(|| text(check, "targetUrl")),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn summarize_checks(checks: &[WorkspacePullRequestCheck]) -> Option<CheckState> {
    checks
        .iter()
        .map(|check| check.state)
        .max()
        .map(|state| match state {
            CheckState::Neutral => CheckState::Success,
            other => other,
        })
}

fn parse_pull_request(value: &Value) -> Option<WorkspacePullRequest> {
    let checks = parse_checks(value.get("statusCheckRollup"));
    Some(WorkspacePullRequest {
        number: value.get("number")?.as_u64()?,
        title: value.get("title")?.as_str()?.to_string(),
        state: value.get("state")?.as_str()?.to_string(),
        url: value.get("url")?.as_str()?.to_string(),
        head_branch: value.get("headRefName")?.as_str()?.to_string(),
        base_branch: value.get("baseRefName")?.as_str()?.to_string(),
        draft: value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        author: value
            .get("author")
            .and_then(|author| author.get("login"))
            .and_then(Value::as_str)
            .map(str::to_string),
        updated_at: text(value, "updatedAt"),
        checks: summarize_checks(&checks),
        review_decision: text(value, "reviewDecision"),
    })
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

fn fetch_pull_requests(repository: &Path) -> WorkspacePullRequestOverview {
    if config::read_repository_config(repository)
        .remotes
        .is_empty()
    {
        return unavailable("Add a Git remote to load pull requests.".to_string());
    }
    let args = ["pr", "list", "--limit", "50", "--json", LIST_FIELDS];
    let output = match command_output("gh", &args, repository) {
        Ok(output) if output.status.success() => output_text(&output),
        Ok(output) => return unavailable(output_error("gh", &args, &output)),
        Err(error) => return unavailable(error),
    };
    match serde_json::from_str::<Vec<Value>>(&output) {
        Ok(values) => WorkspacePullRequestOverview {
            available: true,
            reason: None,
            items: values.iter().filter_map(parse_pull_request).collect(),
            fetched_at: Some(now_millis()),
            template: read_template(repository),
        },
        Err(error) => unavailable(format!(
            "GitHub CLI returned invalid pull-request data: {error}"
        )),
    }
}

fn refresh_in_background(repository: PathBuf) {
    let spawned = thread::Builder::new()
        .name("workspace-pull-requests".to_string())
        .spawn({
            let repository = repository.clone();
            move || {
                let overview = fetch_pull_requests(&repository);
                cache().insert(
                    repository,
                    CachedPullRequests {
                        loaded_at: Instant::now(),
                        overview,
                        refreshing: false,
                    },
                );
            }
        });
    if spawned.is_err() {
        if let Some(entry) = cache().get_mut(&repository) {
            entry.refreshing = false;
        }
    }
}

pub(super) fn pull_requests(repository: &Path) -> WorkspacePullRequestOverview {
    {
        let mut cache = cache();
        if let Some(entry) = cache.get_mut(repository) {
            let overview = entry.overview.clone();
            if entry.loaded_at.elapsed() >= PULL_REQUEST_TTL && !entry.refreshing {
                entry.refreshing = true;
                drop(cache);
                refresh_in_background(repository.to_path_buf());
            }
            return overview;
        }
    }
    let overview = fetch_pull_requests(repository);
    cache().insert(
        repository.to_path_buf(),
        CachedPullRequests {
            loaded_at: Instant::now(),
            overview: overview.clone(),
            refreshing: false,
        },
    );
    overview
}

pub(super) fn forget(repository: &Path) {
    cache().remove(repository);
}

pub(super) fn load_request_checks(
    request: WorkspacePullRequestChecksRequest,
) -> Result<WorkspacePullRequestChecks, String> {
    let (_, repository) = repository_context(&request.workspace_root, &request.repository_root)?;
    load_checks(&repository, request.number)
}

fn load_checks(repository: &Path, number: u64) -> Result<WorkspacePullRequestChecks, String> {
    let number = number.to_string();
    let args = [
        "pr",
        "view",
        number.as_str(),
        "--json",
        "number,url,reviewDecision,statusCheckRollup",
    ];
    let output = command_output("gh", &args, repository)?;
    if !output.status.success() {
        return Err(output_error("gh", &args, &output));
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|error| format!("GitHub CLI returned invalid check data: {error}"))?;
    Ok(WorkspacePullRequestChecks {
        number: value
            .get("number")
            .and_then(Value::as_u64)
            .ok_or_else(|| "GitHub CLI returned no pull-request number.".to_string())?,
        url: text(&value, "url").unwrap_or_default(),
        review_decision: text(&value, "reviewDecision"),
        checks: parse_checks(value.get("statusCheckRollup")),
    })
}

pub(super) fn create_pull_request(
    repository: &Path,
    title: &str,
    body: Option<&str>,
    base: Option<&str>,
    draft: bool,
) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 500 {
        return Err("Enter a pull-request title.".to_string());
    }
    let branch = current_branch(repository)?;
    push(repository, false)?;
    let body = body.unwrap_or_default();
    let mut args = vec![
        "pr",
        "create",
        "--title",
        title,
        "--body",
        body,
        "--head",
        branch.as_str(),
    ];
    if let Some(base) = base.map(str::trim).filter(|base| !base.is_empty()) {
        if base.starts_with('-') {
            return Err("Select a valid base branch.".to_string());
        }
        args.extend(["--base", base]);
    }
    if draft {
        args.push("--draft");
    }
    let output = command_output("gh", &args, repository)?;
    forget(repository);
    if output.status.success() {
        Ok(())
    } else {
        Err(output_error("gh", &args, &output))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn summarizes_check_runs_status_contexts_and_review_state() {
        let pull_request = parse_pull_request(&json!({
            "number": 7,
            "title": "Fix login",
            "state": "OPEN",
            "url": "https://github.com/acme/app/pull/7",
            "headRefName": "cloud-1-fix",
            "baseRefName": "main",
            "isDraft": false,
            "author": { "login": "dev" },
            "reviewDecision": "APPROVED",
            "statusCheckRollup": [
                { "__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS", "workflowName": "CI" },
                { "__typename": "CheckRun", "name": "lint", "status": "IN_PROGRESS", "conclusion": "" },
                { "__typename": "StatusContext", "context": "deploy", "state": "SUCCESS", "targetUrl": "https://ci.example.test" }
            ]
        }))
        .expect("the pull request should parse");
        assert_eq!(pull_request.checks, Some(CheckState::Pending));
        assert_eq!(pull_request.review_decision.as_deref(), Some("APPROVED"));
        let checks = parse_checks(Some(&json!([
            { "name": "test", "status": "COMPLETED", "conclusion": "FAILURE", "detailsUrl": "https://ci.example.test/1" },
            { "name": "skip", "status": "COMPLETED", "conclusion": "SKIPPED" }
        ])));
        assert_eq!(checks[0].state, CheckState::Failure);
        assert_eq!(checks[0].url.as_deref(), Some("https://ci.example.test/1"));
        assert_eq!(checks[1].state, CheckState::Neutral);
        assert_eq!(summarize_checks(&checks), Some(CheckState::Failure));
        assert_eq!(summarize_checks(&checks[1..]), Some(CheckState::Success));
        assert_eq!(summarize_checks(&[]), None);
    }
}
