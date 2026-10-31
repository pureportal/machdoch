use std::collections::{BTreeMap, HashSet};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::Manager as _;

use super::{
    agent_activity::read_agent_activity,
    manager::RunManager,
    model::{
        RunConfigurationStatus, RunLifecycleState, RunLogEntry, RunLogStream, RunWorkspaceSnapshot,
    },
    presence::{ActiveWorkspaceAgent, WorkspacePresenceRegistry},
    redact_text, status_environment_values,
};
use crate::{
    desktop_task::{active_task_summaries, DesktopTaskCancelMap},
    fleet_control::FleetControlState,
    shell_state::load_authoritative_shell_state,
    workspace_tools::{
        terminal::{normalized_workspace_key, WorkspaceTerminalSummary},
        WorkspaceTerminalState,
    },
};

const MAX_PAGE_ITEMS: usize = 50;
pub(super) const MAX_ACTIVITY_PAGE_ITEMS: usize = 200;
const MAX_LOG_PAGE_ENTRIES: usize = 400;
pub(super) const MAX_PAGE_CONTENT_CHARS: usize = 20_000;
const MAX_LOG_PAGE_CHARS: usize = 40_000;
const MAX_TERMINAL_TAIL_LINES: usize = 2_000;
const MAX_LISTED_WORKSPACES: usize = 100;
const MAX_TITLE_CHARS: usize = 80;
const MAX_QUEUED_MESSAGE_CHARS: usize = 2_000;
const AGENT_LIVE_FIELDS: &[&str] = &[
    "provider",
    "model",
    "usage",
    "plan",
    "tasks",
    "fileChanges",
    "question",
];
const EXCERPT_CHARS_BEFORE: usize = 160;
const EXCERPT_CHARS_AFTER: usize = 460;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum DesktopStateQuery {
    Overview {},
    ListChatSessions {
        workspace_root: Option<String>,
        query: Option<String>,
        include_archived: Option<bool>,
        start_index: Option<usize>,
        limit: Option<usize>,
    },
    ReadChatSession {
        session_id: String,
        start_index: Option<usize>,
        limit: Option<usize>,
        offset: Option<usize>,
    },
    ReadChatActivity {
        session_id: String,
        message_index: usize,
        start_index: Option<usize>,
        limit: Option<usize>,
    },
    ReadAgentActivity {
        task_id: String,
        since: Option<u64>,
        limit: Option<usize>,
    },
    ReadTerminalOutput {
        terminal_id: String,
        tail_lines: Option<usize>,
    },
    ReadRunLogs {
        workspace_root: Option<String>,
        configuration_id: Option<String>,
        stream: Option<RunLogStream>,
        query: Option<String>,
        limit: Option<usize>,
    },
}

pub(super) fn read_desktop_state(
    app: &tauri::AppHandle,
    manager: &RunManager,
    presence: &WorkspacePresenceRegistry,
    workspace_root: &str,
    query: DesktopStateQuery,
) -> Result<Value, String> {
    let tasks = || {
        active_task_summaries(&app.state::<DesktopTaskCancelMap>()).and_then(|tasks| {
            serde_json::to_value(tasks)
                .map_err(|error| format!("Failed to serialize active tasks: {error}"))
        })
    };
    let terminals = app.state::<WorkspaceTerminalState>();
    let fleet = app.state::<FleetControlState>();
    match query {
        DesktopStateQuery::Overview {} => {
            let mut tasks = tasks()?;
            if let Some(tasks) = tasks.as_array_mut() {
                for task in tasks {
                    let activity = task["id"]
                        .as_str()
                        .map(|task_id| fleet.task_activity(task_id))
                        .transpose()?
                        .flatten();
                    if let Some(activity) = activity {
                        task["activity"] = activity;
                    }
                }
            }
            let mut overview = build_overview(
                &load_authoritative_shell_state(app)?,
                &tasks,
                &presence.all_agents()?,
                &terminals.summaries()?,
                &active_run_snapshots(manager)?,
            );
            overview["appVersion"] = json!(app.package_info().version.to_string());
            Ok(overview)
        }
        DesktopStateQuery::ListChatSessions {
            workspace_root,
            query,
            include_archived,
            start_index,
            limit,
        } => list_chat_sessions(
            &load_authoritative_shell_state(app)?,
            &tasks()?,
            ChatSessionFilter {
                workspace_root: workspace_root.as_deref(),
                query: query.as_deref(),
                include_archived: include_archived.unwrap_or(false),
                start_index: start_index.unwrap_or(0),
                limit: limit.unwrap_or(20),
            },
        ),
        DesktopStateQuery::ReadChatSession {
            session_id,
            start_index,
            limit,
            offset,
        } => read_chat_session(
            &load_authoritative_shell_state(app)?,
            &tasks()?,
            &session_id,
            start_index,
            limit.unwrap_or(10),
            offset,
        ),
        DesktopStateQuery::ReadChatActivity {
            session_id,
            message_index,
            start_index,
            limit,
        } => read_chat_activity(
            &load_authoritative_shell_state(app)?,
            &tasks()?,
            &session_id,
            message_index,
            start_index.unwrap_or(0),
            limit.unwrap_or(100),
        ),
        DesktopStateQuery::ReadAgentActivity {
            task_id,
            since,
            limit,
        } => {
            let tasks = tasks()?;
            read_agent_activity(
                &task_id,
                active_tasks(&tasks)
                    .iter()
                    .find(|task| task["id"] == task_id.as_str()),
                fleet.task_activity(&task_id)?.as_ref(),
                since.unwrap_or(0),
                limit.unwrap_or(100),
            )
        }
        DesktopStateQuery::ReadTerminalOutput {
            terminal_id,
            tail_lines,
        } => {
            let tail_lines = tail_lines.unwrap_or(200);
            require_limit(tail_lines, MAX_TERMINAL_TAIL_LINES, "tailLines")?;
            serde_json::to_value(terminals.read_output(&terminal_id, tail_lines)?)
                .map_err(|error| format!("Failed to serialize terminal output: {error}"))
        }
        DesktopStateQuery::ReadRunLogs {
            workspace_root: requested_workspace,
            configuration_id,
            stream,
            query,
            limit,
        } => {
            if let Some(requested) = requested_workspace.as_deref() {
                require_known_workspace(&load_authoritative_shell_state(app)?, requested)?;
            }
            let snapshot =
                manager.snapshot(requested_workspace.as_deref().unwrap_or(workspace_root))?;
            read_run_logs(
                &snapshot,
                configuration_id.as_deref(),
                stream,
                query.as_deref(),
                limit.unwrap_or(100),
            )
        }
    }
}

struct ChatSessionFilter<'a> {
    workspace_root: Option<&'a str>,
    query: Option<&'a str>,
    include_archived: bool,
    start_index: usize,
    limit: usize,
}

pub(super) fn require_limit(value: usize, maximum: usize, field: &str) -> Result<(), String> {
    if value == 0 || value > maximum {
        return Err(format!("{field} must be between 1 and {maximum}."));
    }
    Ok(())
}

fn sessions(shell: &Value) -> &[Value] {
    shell["sessions"].as_array().map_or(&[], Vec::as_slice)
}

fn find_session<'a>(shell: &'a Value, session_id: &str) -> Result<&'a Value, String> {
    sessions(shell)
        .iter()
        .find(|session| session["id"].as_str() == Some(session_id))
        .ok_or_else(|| format!("Chat session `{session_id}` was not found."))
}

fn session_messages(session: &Value) -> &[Value] {
    session["messages"].as_array().map_or(&[], Vec::as_slice)
}

fn session_title(session: &Value) -> String {
    let manual_title = session["manualTitle"].as_str().map(str::trim);
    let title = manual_title
        .filter(|title| !title.is_empty())
        .or_else(|| {
            session_messages(session)
                .iter()
                .find(|message| message["role"].as_str() == Some("user"))
                .and_then(|message| message["content"].as_str())
                .and_then(|content| content.lines().map(str::trim).find(|line| !line.is_empty()))
        })
        .unwrap_or("Untitled chat");
    title.chars().take(MAX_TITLE_CHARS).collect()
}

fn active_tasks(tasks: &Value) -> &[Value] {
    tasks.as_array().map_or(&[], Vec::as_slice)
}

pub(super) fn copy_present(target: &mut Map<String, Value>, source: &Value, fields: &[&str]) {
    for field in fields {
        if let Some(value) = source.get(*field).filter(|value| !value.is_null()) {
            target.insert((*field).to_string(), value.clone());
        }
    }
}

pub(super) fn agent_live_summary(agent_live: &Value) -> Option<Value> {
    let mut live = Map::new();
    copy_present(&mut live, agent_live, AGENT_LIVE_FIELDS);
    (!live.is_empty()).then_some(Value::Object(live))
}

fn session_summary(shell: &Value, session: &Value, tasks: &Value) -> Map<String, Value> {
    let id = session["id"].as_str().unwrap_or_default();
    let mut summary = Map::new();
    summary.insert("id".to_string(), json!(id));
    summary.insert("title".to_string(), json!(session_title(session)));
    copy_present(
        &mut summary,
        session,
        &[
            "workspace",
            "provider",
            "model",
            "mode",
            "reasoning",
            "parallelAgentMode",
            "goal",
            "createdAt",
            "updatedAt",
            "archivedAt",
            "specialSession",
            "tags",
        ],
    );
    summary.insert(
        "messageCount".to_string(),
        json!(session_messages(session).len()),
    );
    let active_task_ids = active_tasks(tasks)
        .iter()
        .filter(|task| task["sessionId"].as_str() == Some(id))
        .map(|task| task["id"].clone())
        .collect::<Vec<_>>();
    if !active_task_ids.is_empty() {
        summary.insert("activeTaskIds".to_string(), Value::Array(active_task_ids));
    }
    if let Some(outcome) = session_messages(session)
        .iter()
        .rev()
        .map(|message| &message["outcome"])
        .find(|outcome| !outcome.is_null())
    {
        summary.insert("lastOutcome".to_string(), outcome.clone());
    }
    let queued_messages = queued_session_messages(shell, id).count();
    if queued_messages > 0 {
        summary.insert("queuedMessageCount".to_string(), json!(queued_messages));
    }
    summary
}

fn queued_session_messages<'a>(
    shell: &'a Value,
    session_id: &'a str,
) -> impl Iterator<Item = &'a Value> {
    shell["queuedSessionMessages"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter(move |message| message["sessionId"].as_str() == Some(session_id))
}

fn queued_message_entry(message: &Value) -> Value {
    let mut entry = Map::new();
    copy_present(
        &mut entry,
        message,
        &[
            "id",
            "status",
            "createdAt",
            "blockedByTaskId",
            "failureMessage",
        ],
    );
    let content = message["visibleMessageContent"]
        .as_str()
        .or_else(|| message["task"].as_str())
        .unwrap_or_default();
    entry.insert(
        "content".to_string(),
        json!(content
            .chars()
            .take(MAX_QUEUED_MESSAGE_CHARS)
            .collect::<String>()),
    );
    Value::Object(entry)
}

fn build_overview(
    shell: &Value,
    tasks: &Value,
    presence: &[(String, ActiveWorkspaceAgent)],
    terminals: &[WorkspaceTerminalSummary],
    active_runs: &[RunWorkspaceSnapshot],
) -> Value {
    let presence = presence
        .iter()
        .map(|(workspace_root, agent)| {
            let mut entry = json!(agent);
            entry["workspaceRoot"] = json!(workspace_root);
            entry
        })
        .collect::<Vec<_>>();
    let task_list = active_tasks(tasks);
    let task_ids = task_list
        .iter()
        .filter_map(|task| task["id"].as_str())
        .collect::<HashSet<_>>();
    let active_agents = task_list
        .iter()
        .map(|task| active_agent(shell, task, &presence))
        .collect::<Vec<_>>();
    let other_agents = presence
        .iter()
        .filter(|agent| {
            agent["taskId"]
                .as_str()
                .is_none_or(|task_id| !task_ids.contains(task_id))
        })
        .collect::<Vec<_>>();

    json!({
        "focusedSessionId": shell["activeSessionId"],
        "workspaces": workspace_rollup(shell, task_list, &presence, terminals, active_runs),
        "activeAgents": active_agents,
        "otherAgents": other_agents,
        "terminals": terminals,
    })
}

fn active_agent(shell: &Value, task: &Value, presence: &[Value]) -> Value {
    let task_id = task["id"].as_str();
    let mut agent = Map::new();
    agent.insert("taskId".to_string(), task["id"].clone());
    copy_present(
        &mut agent,
        task,
        &["kind", "sessionId", "workspaceRoot", "startedAt"],
    );
    if let Some(session) = task["sessionId"]
        .as_str()
        .and_then(|session_id| find_session(shell, session_id).ok())
    {
        agent.insert("title".to_string(), json!(session_title(session)));
        copy_present(&mut agent, session, &["provider", "model", "mode"]);
    }
    copy_present(
        &mut agent,
        &task["activity"],
        &["state", "message", "updatedAt"],
    );
    if task["kind"].as_str() == Some("ralph") {
        copy_present(&mut agent, task, &["arguments"]);
    }
    agent.insert(
        "presence".to_string(),
        Value::Array(
            presence
                .iter()
                .filter(|entry| task_id.is_some() && entry["taskId"].as_str() == task_id)
                .cloned()
                .collect(),
        ),
    );
    Value::Object(agent)
}

#[derive(Default)]
struct WorkspaceRollup {
    root: String,
    chat_count: usize,
    active_agent_count: usize,
    terminal_count: usize,
    last_activity_at: u64,
    active_runs: Vec<Value>,
}

fn rollup_for<'a>(
    rollups: &'a mut BTreeMap<String, WorkspaceRollup>,
    root: &str,
) -> &'a mut WorkspaceRollup {
    rollups
        .entry(normalized_workspace_key(root))
        .or_insert_with(|| WorkspaceRollup {
            root: root.to_string(),
            ..WorkspaceRollup::default()
        })
}

fn workspace_rollup(
    shell: &Value,
    tasks: &[Value],
    presence: &[Value],
    terminals: &[WorkspaceTerminalSummary],
    active_runs: &[RunWorkspaceSnapshot],
) -> Vec<Value> {
    let mut rollups = BTreeMap::new();
    for root in shell["recentWorkspaces"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(Value::as_str)
    {
        rollup_for(&mut rollups, root);
    }
    for session in sessions(shell) {
        let Some(root) = session["workspace"].as_str() else {
            continue;
        };
        let rollup = rollup_for(&mut rollups, root);
        rollup.chat_count += usize::from(!session["archivedAt"].is_number());
        rollup.last_activity_at = rollup
            .last_activity_at
            .max(session["updatedAt"].as_u64().unwrap_or(0));
    }
    for task in tasks {
        let Some(root) = task["workspaceRoot"].as_str() else {
            continue;
        };
        let rollup = rollup_for(&mut rollups, root);
        rollup.active_agent_count += 1;
        rollup.last_activity_at = rollup
            .last_activity_at
            .max(task["startedAt"].as_u64().unwrap_or(0));
    }
    for root in presence
        .iter()
        .filter_map(|agent| agent["workspaceRoot"].as_str())
    {
        rollup_for(&mut rollups, root);
    }
    for terminal in terminals {
        rollup_for(&mut rollups, &terminal.workspace_root).terminal_count += 1;
    }
    for snapshot in active_runs {
        let rollup = rollup_for(&mut rollups, &snapshot.workspace_root);
        collect_active_runs(&snapshot.configurations, &mut rollup.active_runs);
    }
    let mut rollups = rollups.into_values().collect::<Vec<_>>();
    rollups.sort_by(|left, right| right.last_activity_at.cmp(&left.last_activity_at));
    rollups.truncate(MAX_LISTED_WORKSPACES);
    rollups
        .into_iter()
        .map(|rollup| {
            json!({
                "root": rollup.root,
                "chatCount": rollup.chat_count,
                "activeAgentCount": rollup.active_agent_count,
                "terminalCount": rollup.terminal_count,
                "activeRuns": rollup.active_runs,
                "lastActivityAt": rollup.last_activity_at,
            })
        })
        .collect()
}

fn active_run_snapshots(manager: &RunManager) -> Result<Vec<RunWorkspaceSnapshot>, String> {
    manager
        .active_workspace_roots()?
        .iter()
        .map(|root| manager.snapshot(root))
        .collect()
}

fn collect_active_runs(statuses: &[RunConfigurationStatus], active_runs: &mut Vec<Value>) {
    for status in statuses {
        if status.state != RunLifecycleState::Stopped {
            active_runs.push(json!({
                "configurationId": status.configuration.id(),
                "state": status.state,
            }));
        }
        collect_active_runs(&status.children, active_runs);
    }
}

fn require_known_workspace(shell: &Value, workspace_root: &str) -> Result<(), String> {
    let requested = normalized_workspace_key(workspace_root);
    let is_known = shell["recentWorkspaces"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .filter_map(Value::as_str)
        .chain(
            sessions(shell)
                .iter()
                .filter_map(|session| session["workspace"].as_str()),
        )
        .any(|root| normalized_workspace_key(root) == requested);
    if is_known {
        Ok(())
    } else {
        Err(format!("`{workspace_root}` is not a known workspace."))
    }
}

fn find_ignoring_case(text: &str, needle: &[char]) -> Option<usize> {
    let first = *needle.first()?;
    text.char_indices()
        .find(|(index, character)| {
            lowercase_eq(*character, first)
                && text[*index..]
                    .chars()
                    .zip(needle)
                    .filter(|(left, right)| lowercase_eq(*left, **right))
                    .count()
                    == needle.len()
        })
        .map(|(index, _)| index)
}

fn lowercase_eq(left: char, right: char) -> bool {
    left == right || left.to_lowercase().eq(right.to_lowercase())
}

fn excerpt(text: &str, match_index: usize) -> String {
    let before = text[..match_index].chars().rev().take(EXCERPT_CHARS_BEFORE);
    let mut excerpt = before.collect::<Vec<_>>();
    excerpt.reverse();
    excerpt.extend(text[match_index..].chars().take(EXCERPT_CHARS_AFTER));
    excerpt.into_iter().collect()
}

fn find_session_match(session: &Value, needle: &[char]) -> Option<Value> {
    let title = session_title(session);
    if find_ignoring_case(&title, needle).is_some() {
        return Some(json!({ "in": "title" }));
    }
    session_messages(session)
        .iter()
        .enumerate()
        .find_map(|(index, message)| {
            let content = message["content"].as_str()?;
            let match_index = find_ignoring_case(content, needle)?;
            Some(json!({
                "in": "message",
                "index": index,
                "role": message["role"],
                "excerpt": excerpt(content, match_index),
            }))
        })
}

fn list_chat_sessions(
    shell: &Value,
    tasks: &Value,
    filter: ChatSessionFilter<'_>,
) -> Result<Value, String> {
    require_limit(filter.limit, MAX_PAGE_ITEMS, "limit")?;
    let workspace_key = filter.workspace_root.map(normalized_workspace_key);
    let needle = filter
        .query
        .map(str::trim)
        .filter(|query| !query.is_empty())
        .map(|query| query.chars().collect::<Vec<_>>());
    if filter.query.is_some() && needle.is_none() {
        return Err("query must contain text to search for.".to_string());
    }
    let mut candidates = sessions(shell)
        .iter()
        .filter(|session| filter.include_archived || !session["archivedAt"].is_number())
        .filter(|session| {
            workspace_key.as_ref().is_none_or(|key| {
                session["workspace"]
                    .as_str()
                    .is_some_and(|root| normalized_workspace_key(root) == *key)
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|session| std::cmp::Reverse(session["updatedAt"].as_u64().unwrap_or(0)));
    if filter.start_index > candidates.len() {
        return Err(format!(
            "startIndex must be between 0 and {}.",
            candidates.len()
        ));
    }

    let mut listed = Vec::new();
    let mut index = filter.start_index;
    while index < candidates.len() && listed.len() < filter.limit {
        let session = candidates[index];
        index += 1;
        let session_match = match &needle {
            Some(needle) => match find_session_match(session, needle) {
                Some(found) => Some(found),
                None => continue,
            },
            None => None,
        };
        let mut summary = session_summary(shell, session, tasks);
        if let Some(session_match) = session_match {
            summary.insert("match".to_string(), session_match);
        }
        listed.push(Value::Object(summary));
    }
    Ok(json!({
        "totalSessions": candidates.len(),
        "sessions": listed,
        "nextIndex": (index < candidates.len()).then_some(index),
    }))
}

fn message_kind(message: &Value) -> Option<&str> {
    message["source"]["kind"].as_str()
}

fn read_chat_session(
    shell: &Value,
    tasks: &Value,
    session_id: &str,
    start_index: Option<usize>,
    limit: usize,
    offset: Option<usize>,
) -> Result<Value, String> {
    require_limit(limit, MAX_PAGE_ITEMS, "limit")?;
    if offset.is_some() && start_index.is_none() {
        return Err("Provide startIndex when using offset.".to_string());
    }
    let session = find_session(shell, session_id)?;
    let messages = session_messages(session);
    let first_index = start_index.unwrap_or_else(|| messages.len().saturating_sub(limit));
    if first_index > messages.len() {
        return Err(format!(
            "startIndex must be between 0 and {}.",
            messages.len()
        ));
    }
    let mut index = first_index;
    let mut next_offset = offset.unwrap_or(0);
    let first_length = messages
        .get(index)
        .and_then(|message| message["content"].as_str())
        .map_or(0, |content| content.chars().count());
    if next_offset > first_length {
        return Err(format!("offset must be between 0 and {first_length}."));
    }
    let mut remaining_chars = MAX_PAGE_CONTENT_CHARS;
    let mut page = Vec::new();
    while index < messages.len() && page.len() < limit && remaining_chars > 0 {
        let message = &messages[index];
        let content = message["content"].as_str().unwrap_or_default();
        let content_length = content.chars().count();
        let text = content
            .chars()
            .skip(next_offset)
            .take(remaining_chars)
            .collect::<String>();
        let text_length = text.chars().count();
        let mut entry = Map::new();
        entry.insert("index".to_string(), json!(index));
        copy_present(
            &mut entry,
            message,
            &["id", "taskId", "role", "createdAt", "outcome"],
        );
        if let Some(kind) = message_kind(message) {
            entry.insert("kind".to_string(), json!(kind));
        }
        entry.insert("content".to_string(), json!(text));
        entry.insert("offset".to_string(), json!(next_offset));
        entry.insert("contentLength".to_string(), json!(content_length));
        entry.insert(
            "hasActivity".to_string(),
            json!(message["source"]["thinking"].is_object()),
        );
        page.push(Value::Object(entry));
        remaining_chars -= text_length;
        next_offset += text_length;
        if next_offset < content_length {
            break;
        }
        index += 1;
        next_offset = 0;
    }
    let queued_messages = queued_session_messages(shell, session_id)
        .take(MAX_PAGE_ITEMS)
        .map(queued_message_entry)
        .collect::<Vec<_>>();
    Ok(json!({
        "session": session_summary(shell, session, tasks),
        "startIndex": first_index,
        "messages": page,
        "queuedMessages": queued_messages,
        "nextIndex": (index < messages.len()).then_some(index),
        "nextOffset": next_offset,
    }))
}

fn activity_events(trace: &Value) -> Vec<Value> {
    let timeline = trace["timelineEvents"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|event| {
            let mut entry = Map::new();
            entry.insert("type".to_string(), json!("event"));
            copy_present(
                &mut entry,
                event,
                &[
                    "kind",
                    "phase",
                    "label",
                    "detail",
                    "toolName",
                    "stream",
                    "timestamp",
                ],
            );
            Value::Object(entry)
        });
    let output = trace["actionOutputLines"]
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|line| {
            let mut entry = Map::new();
            entry.insert("type".to_string(), json!("output"));
            copy_present(
                &mut entry,
                line,
                &["toolName", "stream", "text", "timestamp"],
            );
            Value::Object(entry)
        });
    let mut events = timeline.chain(output).collect::<Vec<_>>();
    events.sort_by_key(|event| event["timestamp"].as_u64().unwrap_or(0));
    events
}

pub(super) fn activity_event_chars(event: &Value) -> usize {
    ["label", "detail", "text"]
        .iter()
        .filter_map(|field| event[*field].as_str())
        .map(|text| text.chars().count())
        .sum()
}

fn read_chat_activity(
    shell: &Value,
    tasks: &Value,
    session_id: &str,
    message_index: usize,
    start_index: usize,
    limit: usize,
) -> Result<Value, String> {
    require_limit(limit, MAX_ACTIVITY_PAGE_ITEMS, "limit")?;
    let session = find_session(shell, session_id)?;
    let message = session_messages(session)
        .get(message_index)
        .ok_or_else(|| format!("Message {message_index} was not found in this chat."))?;
    let trace = &message["source"]["thinking"];
    if !trace.is_object() {
        return Err(format!("Message {message_index} has no recorded activity."));
    }
    let events = activity_events(trace);
    if start_index > events.len() {
        return Err(format!(
            "startIndex must be between 0 and {}.",
            events.len()
        ));
    }
    let mut page = Vec::new();
    let mut used_chars = 0;
    for event in events[start_index..].iter().take(limit) {
        let event_chars = activity_event_chars(event);
        if !page.is_empty() && used_chars + event_chars > MAX_PAGE_CONTENT_CHARS {
            break;
        }
        used_chars += event_chars;
        page.push(event.clone());
    }
    let next_index = start_index + page.len();
    let mut result = Map::new();
    result.insert("sessionId".to_string(), json!(session_id));
    result.insert("messageIndex".to_string(), json!(message_index));
    if active_tasks(tasks)
        .iter()
        .any(|task| !task["id"].is_null() && task["id"] == message["taskId"])
    {
        result.insert("activeTaskId".to_string(), message["taskId"].clone());
    }
    result.insert("totalEvents".to_string(), json!(events.len()));
    result.insert("events".to_string(), Value::Array(page));
    result.insert(
        "nextIndex".to_string(),
        json!((next_index < events.len()).then_some(next_index)),
    );
    if start_index == 0 {
        copy_present(
            &mut result,
            trace,
            &[
                "status",
                "startedAt",
                "completedAt",
                "lastActivityAt",
                "tokenUsage",
                "assistantText",
                "actionOutputSummaries",
            ],
        );
        if let Some(live) = agent_live_summary(&trace["agentLive"]) {
            result.insert("live".to_string(), live);
        }
    }
    Ok(Value::Object(result))
}

fn find_status<'a>(
    statuses: &'a [RunConfigurationStatus],
    configuration_id: &str,
) -> Option<&'a RunConfigurationStatus> {
    statuses.iter().find_map(|status| {
        if status.configuration.id() == configuration_id {
            Some(status)
        } else {
            find_status(&status.children, configuration_id)
        }
    })
}

fn collect_logs<'a>(
    status: &'a RunConfigurationStatus,
    collected: &mut Vec<(&'a RunConfigurationStatus, &'a RunLogEntry)>,
) {
    collected.extend(status.logs.iter().map(|entry| (status, entry)));
    for child in &status.children {
        collect_logs(child, collected);
    }
}

fn read_run_logs(
    snapshot: &RunWorkspaceSnapshot,
    configuration_id: Option<&str>,
    stream: Option<RunLogStream>,
    query: Option<&str>,
    limit: usize,
) -> Result<Value, String> {
    require_limit(limit, MAX_LOG_PAGE_ENTRIES, "limit")?;
    let target_id = configuration_id
        .or(snapshot.primary_configuration_id.as_deref())
        .ok_or_else(|| "This workspace has no run configuration.".to_string())?;
    let target = find_status(&snapshot.configurations, target_id)
        .ok_or_else(|| format!("Run configuration `{target_id}` was not found."))?;
    let needle = query.map(|query| query.chars().collect::<Vec<_>>());
    let mut collected = Vec::new();
    collect_logs(target, &mut collected);
    collected.sort_by_key(|(_, entry)| (entry.at, entry.sequence));
    let matching = collected
        .into_iter()
        .filter(|(_, entry)| stream.is_none_or(|expected| entry.stream == expected))
        .map(|(status, entry)| {
            let mut line = entry.line.clone();
            redact_text(&mut line, &status_environment_values(status));
            (status, entry, line)
        })
        .filter(|(_, _, line)| {
            needle
                .as_deref()
                .is_none_or(|needle| find_ignoring_case(line, needle).is_some())
        })
        .collect::<Vec<_>>();
    let mut remaining_chars = MAX_LOG_PAGE_CHARS;
    let mut entries = matching
        .iter()
        .rev()
        .take(limit)
        .take_while(|(_, _, line)| {
            let line_chars = line.chars().count();
            let fits = line_chars <= remaining_chars;
            remaining_chars = remaining_chars.saturating_sub(line_chars);
            fits
        })
        .map(|(status, entry, line)| {
            json!({
                "configurationId": status.configuration.id(),
                "sequence": entry.sequence,
                "at": entry.at,
                "stream": entry.stream,
                "line": line,
            })
        })
        .collect::<Vec<_>>();
    entries.reverse();
    Ok(json!({
        "workspaceRoot": snapshot.workspace_root,
        "configurationId": target_id,
        "state": target.state,
        "totalEntries": matching.len(),
        "entries": entries,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        let agent_message = json!({
            "id": "m1",
            "taskId": "task-1",
            "role": "agent",
            "content": "Done ünïcode",
            "outcome": { "status": "succeeded" },
            "source": {
                "kind": "execution",
                "execution": { "sections": [] },
                "thinking": {
                    "status": "complete",
                    "startedAt": 11,
                    "assistantText": "Working",
                    "timelineEvents": [
                        { "id": "e1", "kind": "tool-call", "phase": "completed", "label": "run", "detail": "pnpm test", "toolName": "run_shell_command", "tone": "info", "timestamp": 12, "elapsedMs": 1 }
                    ],
                    "actionOutputLines": [
                        { "id": "o1", "toolName": "run_shell_command", "stream": "stdout", "text": "12 passed", "timestamp": 13 }
                    ],
                    "agentLive": { "provider": "claude-cli", "transport": "stream-json", "capabilities": [], "plan": [{ "text": "step", "status": "completed" }] }
                }
            }
        });
        json!({
            "activeSessionId": "chat-a",
            "recentWorkspaces": ["C:\\Work\\Alpha", "C:\\Work\\Beta"],
            "queuedSessionMessages": [{ "sessionId": "chat-a", "id": "q1", "status": "queued", "task": "expanded prompt", "visibleMessageContent": "next", "settings": { "model": "private" } }],
            "sessions": [
                {
                    "id": "chat-a",
                    "workspace": "C:\\Work\\Alpha",
                    "provider": "claude-cli",
                    "model": "opus",
                    "createdAt": 1,
                    "updatedAt": 30,
                    "goal": { "objective": "Ship login", "status": "active" },
                    "draft": "private draft",
                    "sessionMemory": [{ "fact": "private" }],
                    "messages": [
                        { "id": "m0", "role": "user", "content": "Fix the Login page\nnow", "createdAt": 10 },
                        agent_message
                    ]
                },
                {
                    "id": "chat-b",
                    "workspace": "c:/work/alpha/",
                    "manualTitle": "Named chat",
                    "updatedAt": 20,
                    "archivedAt": 25,
                    "messages": []
                },
                {
                    "id": "chat-c",
                    "workspace": "C:\\Work\\Beta",
                    "updatedAt": 40,
                    "messages": [{ "id": "m0", "role": "user", "content": "Other project login discussion" }]
                }
            ]
        })
    }

    fn tasks() -> Value {
        json!([
            { "id": "task-1", "kind": "desktop", "sessionId": "chat-a", "workspaceRoot": "C:\\Work\\Alpha", "arguments": [], "startedAt": 50, "activity": { "state": "executing", "message": "Running tests", "updatedAt": 55, "logs": [{ "chunk": "private output" }] } },
            { "id": "ralph-1", "kind": "ralph", "workspaceRoot": "C:\\Work\\Beta", "arguments": ["run", "flow"], "progressEvents": [{ "timestamp": 1, "progress": "private progress" }], "startedAt": 60 }
        ])
    }

    #[test]
    fn overview_groups_agents_workspaces_and_omits_drafts() {
        let overview = build_overview(&fixture(), &tasks(), &[], &[], &[run_snapshot()]);
        assert_eq!(overview["focusedSessionId"], "chat-a");
        assert_eq!(overview["activeAgents"][0]["title"], "Fix the Login page");
        assert_eq!(overview["activeAgents"][0]["state"], "executing");
        assert_eq!(overview["activeAgents"][0]["message"], "Running tests");
        assert_eq!(overview["activeAgents"][0]["provider"], "claude-cli");
        assert!(overview["activeAgents"][0].get("arguments").is_none());
        assert_eq!(overview["activeAgents"][1]["arguments"][1], "flow");
        let workspaces = overview["workspaces"].as_array().expect("workspaces");
        assert_eq!(workspaces.len(), 2);
        let alpha = workspaces
            .iter()
            .find(|workspace| workspace["root"] == "C:\\Work\\Alpha")
            .expect("alpha workspace");
        assert_eq!(alpha["chatCount"], 1);
        assert_eq!(alpha["activeAgentCount"], 1);
        assert_eq!(alpha["activeRuns"][0]["configurationId"], "app");
        assert_eq!(alpha["activeRuns"][1]["configurationId"], "api");
        assert_eq!(alpha["activeRuns"][1]["state"], "running");
        let serialized = overview.to_string();
        assert!(!serialized.contains("private"));
    }

    #[test]
    fn list_filters_by_workspace_archive_and_searches_case_insensitively() {
        let shell = fixture();
        let listed = |workspace_root, query, include_archived| {
            list_chat_sessions(
                &shell,
                &tasks(),
                ChatSessionFilter {
                    workspace_root,
                    query,
                    include_archived,
                    start_index: 0,
                    limit: 20,
                },
            )
            .expect("listing should succeed")
        };

        let all = listed(None, None, false);
        assert_eq!(all["sessions"][0]["id"], "chat-c");
        assert_eq!(all["sessions"][1]["id"], "chat-a");
        assert_eq!(all["sessions"][1]["activeTaskIds"], json!(["task-1"]));
        assert_eq!(all["sessions"][1]["queuedMessageCount"], 1);
        assert_eq!(all["sessions"][1]["lastOutcome"]["status"], "succeeded");
        assert_eq!(all["sessions"][1]["goal"]["objective"], "Ship login");
        assert!(all["sessions"][0].get("activeTaskIds").is_none());
        assert_eq!(all["totalSessions"], 2);
        assert!(!all.to_string().contains("private"));

        let beta = listed(Some("c:\\work\\beta\\"), None, false);
        if cfg!(windows) {
            assert_eq!(beta["sessions"].as_array().map(Vec::len), Some(1));
        }

        assert_eq!(listed(None, None, true)["totalSessions"], 3);

        let searched = listed(None, Some("LOGIN"), false);
        assert_eq!(searched["sessions"].as_array().map(Vec::len), Some(2));
        assert_eq!(searched["sessions"][1]["match"]["in"], "title");
        let in_message = listed(None, Some("ÜNÏCODE"), false);
        assert_eq!(in_message["sessions"][0]["match"]["in"], "message");
        assert_eq!(in_message["sessions"][0]["match"]["index"], 1);
        assert_eq!(
            in_message["sessions"][0]["match"]["excerpt"],
            "Done ünïcode"
        );
    }

    #[test]
    fn list_rejects_invalid_pages_and_blank_queries() {
        let shell = fixture();
        let attempt = |query, start_index, limit| {
            list_chat_sessions(
                &shell,
                &tasks(),
                ChatSessionFilter {
                    workspace_root: None,
                    query,
                    include_archived: false,
                    start_index,
                    limit,
                },
            )
        };
        assert!(attempt(Some("  "), 0, 10).is_err());
        assert!(attempt(None, 99, 10).is_err());
        assert!(attempt(None, 0, 0).is_err());
        assert!(attempt(None, 0, MAX_PAGE_ITEMS + 1).is_err());
    }

    #[test]
    fn read_session_returns_messages_with_activity_flags() {
        let page = read_chat_session(&fixture(), &tasks(), "chat-a", None, 10, None)
            .expect("read should succeed");
        assert_eq!(page["session"]["id"], "chat-a");
        assert_eq!(page["messages"][0]["hasActivity"], false);
        assert_eq!(page["messages"][1]["hasActivity"], true);
        assert_eq!(page["messages"][1]["kind"], "execution");
        assert_eq!(page["messages"][1]["outcome"]["status"], "succeeded");
        assert_eq!(page["queuedMessages"][0]["id"], "q1");
        assert_eq!(page["queuedMessages"][0]["content"], "next");
        assert!(page["queuedMessages"][0].get("settings").is_none());
        assert_eq!(page["nextIndex"], Value::Null);
        assert!(read_chat_session(&fixture(), &tasks(), "missing", None, 10, None).is_err());
        assert!(read_chat_session(&fixture(), &tasks(), "chat-a", None, 10, Some(1)).is_err());
        assert!(read_chat_session(&fixture(), &tasks(), "chat-a", Some(3), 10, None).is_err());
        assert!(read_chat_session(&fixture(), &tasks(), "chat-a", Some(0), 10, Some(999)).is_err());
    }

    #[test]
    fn long_messages_page_on_character_boundaries() {
        let content = "ü".repeat(MAX_PAGE_CONTENT_CHARS + 10);
        let shell = json!({
            "sessions": [{
                "id": "long",
                "messages": [{ "role": "agent", "content": content }, { "role": "user", "content": "after" }]
            }]
        });
        let first = read_chat_session(&shell, &json!([]), "long", Some(0), 10, None)
            .expect("first page should succeed");
        assert_eq!(first["messages"].as_array().map(Vec::len), Some(1));
        assert_eq!(first["nextIndex"], 0);
        assert_eq!(first["nextOffset"], MAX_PAGE_CONTENT_CHARS);
        let second = read_chat_session(
            &shell,
            &json!([]),
            "long",
            Some(0),
            10,
            Some(MAX_PAGE_CONTENT_CHARS),
        )
        .expect("second page should succeed");
        assert_eq!(second["messages"][0]["content"], "ü".repeat(10));
        assert_eq!(second["messages"][1]["content"], "after");
        assert_eq!(second["nextIndex"], Value::Null);
    }

    #[test]
    fn activity_merges_timeline_and_output_in_time_order() {
        let shell = fixture();
        let activity = read_chat_activity(&shell, &tasks(), "chat-a", 1, 0, 100).expect("activity");
        assert_eq!(activity["activeTaskId"], "task-1");
        assert_eq!(activity["assistantText"], "Working");
        assert_eq!(activity["totalEvents"], 2);
        assert_eq!(activity["events"][0]["detail"], "pnpm test");
        assert_eq!(activity["events"][1]["text"], "12 passed");
        assert_eq!(activity["status"], "complete");
        assert_eq!(activity["live"]["plan"][0]["text"], "step");
        assert!(activity["live"].get("capabilities").is_none());

        let idle = read_chat_activity(&shell, &json!([]), "chat-a", 1, 0, 100).expect("idle");
        assert!(idle.get("activeTaskId").is_none());

        let tail = read_chat_activity(&shell, &tasks(), "chat-a", 1, 1, 100).expect("tail");
        assert_eq!(tail["events"].as_array().map(Vec::len), Some(1));
        assert!(tail.get("live").is_none());

        assert!(read_chat_activity(&shell, &tasks(), "chat-a", 0, 0, 100).is_err());
        assert!(read_chat_activity(&shell, &tasks(), "chat-a", 9, 0, 100).is_err());
        assert!(read_chat_activity(&shell, &tasks(), "chat-a", 1, 9, 100).is_err());
    }

    #[test]
    fn activity_pages_stay_within_the_character_budget() {
        let lines = (0..4)
            .map(|index| json!({ "toolName": "shell", "stream": "stdout", "text": "x".repeat(MAX_PAGE_CONTENT_CHARS / 2), "timestamp": index }))
            .collect::<Vec<_>>();
        let shell = json!({
            "sessions": [{
                "id": "busy",
                "messages": [{ "role": "agent", "content": "", "source": { "kind": "thinking", "thinking": { "status": "running", "timelineEvents": [], "actionOutputLines": lines } } }]
            }]
        });
        let first = read_chat_activity(&shell, &json!([]), "busy", 0, 0, 100).expect("first page");
        assert_eq!(first["events"].as_array().map(Vec::len), Some(2));
        assert_eq!(first["nextIndex"], 2);
    }

    fn run_snapshot() -> RunWorkspaceSnapshot {
        serde_json::from_value(json!({
            "workspaceRoot": "C:\\Work\\Alpha",
            "primaryConfigurationId": "app",
            "configurations": [{
                "configuration": {
                    "kind": "composite",
                    "id": "app",
                    "name": "App",
                    "primary": true,
                    "children": ["api"]
                },
                "state": "running",
                "pid": null,
                "startedAt": 1,
                "stoppedAt": null,
                "exitCode": null,
                "restartCount": 0,
                "health": null,
                "recentFailures": [],
                "logs": [],
                "children": [{
                    "configuration": {
                        "kind": "task",
                        "id": "api",
                        "name": "API",
                        "primary": false,
                        "command": "serve",
                        "environment": { "TOKEN": "top-secret" }
                    },
                    "state": "running",
                    "pid": 7,
                    "startedAt": 1,
                    "stoppedAt": null,
                    "exitCode": null,
                    "restartCount": 0,
                    "health": null,
                    "recentFailures": [],
                    "logs": [
                        { "sequence": 1, "at": 5, "stream": "stdout", "line": "listening with top-secret" },
                        { "sequence": 2, "at": 6, "stream": "stderr", "line": "ERROR boom" },
                        { "sequence": 3, "at": 7, "stream": "stdout", "line": "recovered" }
                    ],
                    "children": []
                }]
            }]
        }))
        .expect("run snapshot fixture should parse")
    }

    #[test]
    fn run_logs_include_children_and_redact_environment_values() {
        let logs = read_run_logs(&run_snapshot(), None, None, None, 100).expect("logs");
        assert_eq!(logs["configurationId"], "app");
        assert_eq!(logs["entries"].as_array().map(Vec::len), Some(3));
        assert_eq!(logs["entries"][0]["configurationId"], "api");
        assert_eq!(logs["entries"][0]["line"], "listening with <redacted>");
        assert!(!logs.to_string().contains("top-secret"));
    }

    #[test]
    fn run_logs_filter_by_stream_query_and_tail_limit() {
        let snapshot = run_snapshot();
        let errors = read_run_logs(
            &snapshot,
            Some("api"),
            Some(RunLogStream::Stderr),
            None,
            100,
        )
        .expect("stderr logs");
        assert_eq!(errors["entries"][0]["line"], "ERROR boom");
        let searched =
            read_run_logs(&snapshot, Some("api"), None, Some("recover"), 100).expect("search");
        assert_eq!(searched["totalEntries"], 1);
        let tail = read_run_logs(&snapshot, Some("api"), None, None, 1).expect("tail");
        assert_eq!(tail["totalEntries"], 3);
        assert_eq!(tail["entries"][0]["line"], "recovered");
        assert!(read_run_logs(&snapshot, Some("missing"), None, None, 10).is_err());
        assert!(read_run_logs(&snapshot, None, None, None, 0).is_err());
    }

    #[test]
    fn run_logs_of_other_workspaces_require_a_known_workspace() {
        let shell = fixture();
        assert!(require_known_workspace(&shell, "C:\\Work\\Beta").is_ok());
        assert!(require_known_workspace(&shell, "C:\\Elsewhere").is_err());
    }

    #[test]
    fn queries_reject_unknown_kinds_and_fields() {
        assert!(serde_json::from_value::<DesktopStateQuery>(json!({ "kind": "drop" })).is_err());
        assert!(serde_json::from_value::<DesktopStateQuery>(
            json!({ "kind": "overview", "sessionId": "x" })
        )
        .is_err());
        assert!(matches!(
            serde_json::from_value::<DesktopStateQuery>(
                json!({ "kind": "readChatSession", "sessionId": "x", "limit": 2 })
            ),
            Ok(DesktopStateQuery::ReadChatSession { limit: Some(2), .. })
        ));
        assert!(matches!(
            serde_json::from_value::<DesktopStateQuery>(
                json!({ "kind": "readAgentActivity", "taskId": "x", "since": 5 })
            ),
            Ok(DesktopStateQuery::ReadAgentActivity { since: Some(5), .. })
        ));
    }
}
