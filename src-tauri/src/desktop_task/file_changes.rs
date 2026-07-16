use std::{fs, path::PathBuf, time::Duration};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tauri::Manager as _;

use super::DesktopTaskRunResponse;

const DEFAULT_PAGE_SIZE: u32 = 100;
const MAX_PAGE_SIZE: u32 = 200;
const SCHEMA_VERSION: i64 = 2;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChangePageRequest {
    change_set_id: String,
    after_id: Option<i64>,
    limit: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangePage {
    files: Vec<Value>,
    next_cursor: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileChangeHunkPageRequest {
    change_set_id: String,
    file_id: i64,
    after_ordinal: Option<i64>,
    limit: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeHunkPage {
    ranges: Vec<Value>,
    next_cursor: Option<i64>,
}

fn storage_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("failed to resolve file-change data directory: {error}"))?
        .join("file-changes")
        .join("file-changes.sqlite3"))
}

fn open(app: &tauri::AppHandle) -> Result<Connection, String> {
    let path = storage_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create file-change data directory: {error}"))?;
    }
    let mut connection = Connection::open(path)
        .map_err(|error| format!("failed to open file-change database: {error}"))?;
    initialize_connection(&mut connection)?;
    Ok(connection)
}

fn initialize_connection(connection: &mut Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("failed to configure file-change database timeout: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;
             PRAGMA trusted_schema = OFF;",
        )
        .map_err(|error| format!("failed to configure file-change database: {error}"))?;
    let schema_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|error| format!("failed to read file-change schema version: {error}"))?;

    if schema_version == SCHEMA_VERSION {
        return Ok(());
    }
    if schema_version > SCHEMA_VERSION {
        return Err(format!(
            "file-change database schema {schema_version} is newer than supported schema {SCHEMA_VERSION}"
        ));
    }

    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin file-change schema transaction: {error}"))?;
    transaction
        .execute_batch(
            "DROP TABLE IF EXISTS changed_hunks;
             DROP TABLE IF EXISTS changed_files;
             DROP TABLE IF EXISTS change_sets;
             CREATE TABLE change_sets (
               id TEXT PRIMARY KEY
             ) WITHOUT ROWID;
             CREATE TABLE changed_files (
               id INTEGER PRIMARY KEY,
               change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
               payload_json TEXT NOT NULL,
               hunk_count INTEGER NOT NULL
             );
             CREATE TABLE changed_hunks (
               file_id INTEGER NOT NULL REFERENCES changed_files(id) ON DELETE CASCADE,
               ordinal INTEGER NOT NULL,
               payload_json TEXT NOT NULL,
               PRIMARY KEY(file_id, ordinal)
             ) WITHOUT ROWID;
             CREATE INDEX changed_files_page_idx
               ON changed_files(change_set_id, id);",
        )
        .map_err(|error| format!("failed to initialize file-change database: {error}"))?;
    transaction
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|error| format!("failed to set file-change schema version: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("failed to commit file-change schema: {error}"))?;
    Ok(())
}

fn create_change_set_id(task_id: Option<&str>) -> String {
    let timestamp = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let mut digest = Sha256::new();
    digest.update(task_id.unwrap_or("desktop-task").as_bytes());
    digest.update(b":");
    digest.update(timestamp.to_string().as_bytes());
    format!("changes-{:x}", digest.finalize())
}

fn required_change_set_id(value: &str) -> Result<&str, String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 128 {
        return Err("The file-change set ID is invalid.".to_string());
    }
    Ok(value)
}

pub(super) fn persist_response(
    app: &tauri::AppHandle,
    task_id: Option<&str>,
    response: &mut DesktopTaskRunResponse,
) -> Result<bool, String> {
    let has_files = response
        .execution
        .get("fileChanges")
        .and_then(Value::as_object)
        .and_then(|file_changes| file_changes.get("files"))
        .and_then(Value::as_array)
        .is_some_and(|files| !files.is_empty());
    if !has_files {
        return Ok(false);
    }

    let mut connection = open(app)?;
    persist_response_with_connection(&mut connection, task_id, response)
}

pub(super) fn annotate_persistence_failure(response: &mut DesktopTaskRunResponse, error: &str) {
    let Some(file_changes) = response
        .execution
        .get_mut("fileChanges")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let message = format!("Changed paths could not be stored durably: {error}");
    file_changes.insert("status".to_string(), Value::String("partial".to_string()));
    let completeness = file_changes
        .entry("completeness")
        .or_insert_with(|| Value::Object(Default::default()));
    if let Some(completeness) = completeness.as_object_mut() {
        completeness.insert(
            "persistence".to_string(),
            serde_json::json!({
                "state": "failed",
                "code": "storage-failed",
                "message": message.clone(),
            }),
        );
    }
    let issues = file_changes
        .entry("issues")
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(issues) = issues.as_array_mut() {
        issues.push(serde_json::json!({
            "stage": "persistence",
            "code": "storage-failed",
            "message": message,
        }));
    }
}

fn persist_response_with_connection(
    connection: &mut Connection,
    task_id: Option<&str>,
    response: &mut DesktopTaskRunResponse,
) -> Result<bool, String> {
    let Some(file_changes_object) = response
        .execution
        .get("fileChanges")
        .and_then(Value::as_object)
    else {
        return Ok(false);
    };
    let files = file_changes_object
        .get("files")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();

    if files.is_empty() {
        return Ok(false);
    }

    let change_set_id = create_change_set_id(task_id);
    let mut summary_object = serde_json::Map::new();
    for (key, value) in file_changes_object {
        if key != "files" {
            summary_object.insert(key.clone(), value.clone());
        }
    }
    summary_object.insert("files".to_string(), Value::Array(Vec::new()));
    summary_object.insert(
        "changeSetId".to_string(),
        Value::String(change_set_id.clone()),
    );
    let summary = Value::Object(summary_object);
    let transaction = connection
        .transaction()
        .map_err(|error| format!("failed to begin file-change transaction: {error}"))?;
    transaction
        .execute(
            "INSERT INTO change_sets(id) VALUES (?1)",
            params![change_set_id],
        )
        .map_err(|error| format!("failed to store file-change set: {error}"))?;

    for file in files {
        let file_object = file
            .as_object()
            .ok_or_else(|| "file-change entry was not an object".to_string())?;
        let ranges = file_object
            .get("ranges")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default();
        if file_object
            .get("path")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err("file-change entry did not contain a path".to_string());
        }
        let mut payload = file.clone();
        let payload_object = payload
            .as_object_mut()
            .ok_or_else(|| "file-change entry was not an object".to_string())?;
        payload_object.remove("ranges");
        payload_object.remove("hunkCount");
        payload_object.remove("storedId");
        let payload_json = serde_json::to_string(&payload)
            .map_err(|error| format!("failed to serialize changed file: {error}"))?;
        transaction
            .execute(
                "INSERT INTO changed_files(change_set_id, payload_json, hunk_count)
                 VALUES (?1, ?2, ?3)",
                params![change_set_id, payload_json, ranges.len() as i64],
            )
            .map_err(|error| format!("failed to store changed file: {error}"))?;
        let file_id = transaction.last_insert_rowid();

        for (range_ordinal, range) in ranges.iter().enumerate() {
            let range_json = serde_json::to_string(&range)
                .map_err(|error| format!("failed to serialize changed hunk: {error}"))?;
            transaction
                .execute(
                    "INSERT INTO changed_hunks(file_id, ordinal, payload_json)
                     VALUES (?1, ?2, ?3)",
                    params![file_id, range_ordinal as i64, range_json],
                )
                .map_err(|error| format!("failed to store changed hunk: {error}"))?;
        }
    }

    transaction
        .commit()
        .map_err(|error| format!("failed to commit file-change transaction: {error}"))?;
    response.execution["fileChanges"] = summary;
    Ok(true)
}

fn normalized_limit(value: Option<u32>) -> usize {
    value.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE) as usize
}

struct StoredFilePreview {
    id: i64,
    payload_json: String,
    hunk_count: i64,
    ranges: Vec<Value>,
}

pub(super) fn list_files(
    app: &tauri::AppHandle,
    request: FileChangePageRequest,
) -> Result<FileChangePage, String> {
    let connection = open(app)?;
    list_files_from_connection(&connection, request)
}

fn list_files_from_connection(
    connection: &Connection,
    request: FileChangePageRequest,
) -> Result<FileChangePage, String> {
    let change_set_id = required_change_set_id(&request.change_set_id)?;
    let limit = normalized_limit(request.limit);
    let exists = connection
        .query_row(
            "SELECT 1 FROM change_sets WHERE id = ?1",
            params![change_set_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("failed to find file-change set: {error}"))?
        .is_some();
    if !exists {
        return Err("The requested file-change set was not found.".to_string());
    }
    let mut statement = connection
        .prepare(
            "WITH file_page AS (
               SELECT id, payload_json, hunk_count
               FROM changed_files
               WHERE change_set_id = ?1 AND id > ?2
               ORDER BY id
               LIMIT ?3
             )
             SELECT file_page.id,
                    file_page.payload_json,
                    file_page.hunk_count,
                    changed_hunks.payload_json
             FROM file_page
             LEFT JOIN changed_hunks
               ON changed_hunks.file_id = file_page.id
              AND changed_hunks.ordinal < 2
             ORDER BY file_page.id, changed_hunks.ordinal",
        )
        .map_err(|error| format!("failed to prepare changed-file query: {error}"))?;
    let rows = statement
        .query_map(
            params![
                change_set_id,
                request.after_id.unwrap_or(0),
                (limit + 1) as i64
            ],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .map_err(|error| format!("failed to query changed files: {error}"))?;
    let mut entries: Vec<StoredFilePreview> = Vec::with_capacity(limit + 1);

    for row in rows {
        let (file_id, payload_json, hunk_count, range_json) =
            row.map_err(|error| format!("failed to read changed file: {error}"))?;
        if entries.last().is_none_or(|entry| entry.id != file_id) {
            entries.push(StoredFilePreview {
                id: file_id,
                payload_json,
                hunk_count,
                ranges: Vec::with_capacity(2),
            });
        }
        if let Some(range_json) = range_json {
            let range = serde_json::from_str::<Value>(&range_json)
                .map_err(|error| format!("stored changed hunk is invalid: {error}"))?;
            let entry = entries
                .last_mut()
                .ok_or_else(|| "changed hunk did not have a stored file".to_string())?;
            entry.ranges.push(range);
        }
    }

    let has_more = entries.len() > limit;
    entries.truncate(limit);
    let next_cursor = has_more
        .then(|| entries.last().map(|entry| entry.id))
        .flatten();
    let mut files = Vec::with_capacity(entries.len());

    for entry in entries {
        let mut payload: Value = serde_json::from_str(&entry.payload_json)
            .map_err(|error| format!("stored changed file is invalid: {error}"))?;
        if let Some(object) = payload.as_object_mut() {
            object.insert("storedId".to_string(), Value::from(entry.id));
            object.insert("hunkCount".to_string(), Value::from(entry.hunk_count));
            if !entry.ranges.is_empty() {
                object.insert("ranges".to_string(), Value::Array(entry.ranges));
            }
        }
        files.push(payload);
    }

    Ok(FileChangePage { files, next_cursor })
}

pub(super) fn list_hunks(
    app: &tauri::AppHandle,
    request: FileChangeHunkPageRequest,
) -> Result<FileChangeHunkPage, String> {
    let connection = open(app)?;
    list_hunks_from_connection(&connection, request)
}

fn list_hunks_from_connection(
    connection: &Connection,
    request: FileChangeHunkPageRequest,
) -> Result<FileChangeHunkPage, String> {
    let change_set_id = required_change_set_id(&request.change_set_id)?;
    let limit = normalized_limit(request.limit);
    let mut statement = connection
        .prepare(
            "SELECT changed_hunks.ordinal, changed_hunks.payload_json
             FROM changed_files
             LEFT JOIN changed_hunks
               ON changed_hunks.file_id = changed_files.id
              AND changed_hunks.ordinal > ?3
             WHERE changed_files.id = ?1
               AND changed_files.change_set_id = ?2
             ORDER BY changed_hunks.ordinal
             LIMIT ?4",
        )
        .map_err(|error| format!("failed to prepare changed-hunk query: {error}"))?;
    let rows = statement
        .query_map(
            params![
                request.file_id,
                change_set_id,
                request.after_ordinal.unwrap_or(-1),
                (limit + 1) as i64
            ],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .map_err(|error| format!("failed to query changed hunks: {error}"))?;
    let raw_entries = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("failed to read changed hunks: {error}"))?;
    if raw_entries.is_empty() {
        return Err("The requested changed file was not found.".to_string());
    }
    let mut entries = raw_entries
        .into_iter()
        .filter_map(|(ordinal, payload)| ordinal.zip(payload))
        .collect::<Vec<_>>();
    let has_more = entries.len() > limit;
    entries.truncate(limit);
    let next_cursor = has_more
        .then(|| entries.last().map(|entry| entry.0))
        .flatten();
    let ranges = entries
        .into_iter()
        .map(|(_, json)| {
            serde_json::from_str::<Value>(&json)
                .map_err(|error| format!("stored changed hunk is invalid: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(FileChangeHunkPage {
        ranges,
        next_cursor,
    })
}

#[cfg(test)]
mod tests {
    use rusqlite::Connection;
    use serde_json::json;

    use super::{
        annotate_persistence_failure, initialize_connection, list_files_from_connection,
        list_hunks_from_connection, normalized_limit, persist_response_with_connection,
        FileChangeHunkPageRequest, FileChangePageRequest,
    };
    use crate::desktop_task::DesktopTaskRunResponse;

    #[test]
    fn page_limits_are_bounded_without_truncating_stored_data() {
        assert_eq!(normalized_limit(None), 100);
        assert_eq!(normalized_limit(Some(0)), 1);
        assert_eq!(normalized_limit(Some(1_000)), 200);
    }

    #[test]
    fn persists_complete_payloads_and_pages_files_and_hunks() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_connection(&mut connection).expect("initialize database");
        let ranges = json!([
            { "oldStart": 1, "oldLines": 1, "newStart": 1, "newLines": 1 },
            { "oldStart": 10, "oldLines": 0, "newStart": 11, "newLines": 2 },
            { "oldStart": 20, "oldLines": 3, "newStart": 20, "newLines": 0 }
        ]);
        let mut response = DesktopTaskRunResponse {
            execution: json!({
                "fileChanges": {
                    "files": [
                        {
                            "path": "src/first.ts",
                            "repositoryPath": ".",
                            "operation": "modified",
                            "entryType": "text",
                            "lineAnalysis": {
                                "state": "complete",
                                "additions": 3,
                                "deletions": 4
                            },
                            "storedId": 999,
                            "hunkCount": 999,
                            "ranges": ranges
                        },
                        {
                            "path": "modules/dependency",
                            "repositoryPath": ".",
                            "operation": "modified",
                            "entryType": "gitlink",
                            "lineAnalysis": {
                                "state": "not-applicable",
                                "reason": "gitlink"
                            },
                            "ranges": []
                        }
                    ],
                    "totalFiles": 2,
                    "additions": 3,
                    "deletions": 4,
                    "status": "complete"
                }
            }),
            preview: None,
        };

        assert!(
            persist_response_with_connection(&mut connection, Some("task-1"), &mut response)
                .expect("persist response")
        );
        let change_set_id = response.execution["fileChanges"]["changeSetId"]
            .as_str()
            .expect("change-set ID")
            .to_string();
        assert_eq!(
            response.execution["fileChanges"]["files"],
            json!([]),
            "the desktop response should carry only the durable reference"
        );
        let stored_payload: String = connection
            .query_row(
                "SELECT payload_json FROM changed_files ORDER BY id LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("read stored file payload");
        let stored_payload: serde_json::Value =
            serde_json::from_str(&stored_payload).expect("parse stored file payload");
        assert!(stored_payload.get("ranges").is_none());
        assert!(stored_payload.get("hunkCount").is_none());
        assert!(stored_payload.get("storedId").is_none());

        let first_page = list_files_from_connection(
            &connection,
            FileChangePageRequest {
                change_set_id: change_set_id.clone(),
                after_id: None,
                limit: Some(1),
            },
        )
        .expect("read first file page");
        assert_eq!(first_page.files.len(), 1);
        assert_eq!(first_page.files[0]["path"], "src/first.ts");
        assert_eq!(first_page.files[0]["hunkCount"], 3);
        assert_eq!(first_page.files[0]["ranges"].as_array().unwrap().len(), 2);
        let file_id = first_page.files[0]["storedId"]
            .as_i64()
            .expect("stored file ID");
        let file_cursor = first_page.next_cursor.expect("file cursor");

        let second_page = list_files_from_connection(
            &connection,
            FileChangePageRequest {
                change_set_id: change_set_id.clone(),
                after_id: Some(file_cursor),
                limit: Some(1),
            },
        )
        .expect("read second file page");
        assert_eq!(second_page.files.len(), 1);
        assert_eq!(second_page.files[0]["entryType"], "gitlink");
        assert_eq!(second_page.next_cursor, None);
        let gitlink_file_id = second_page.files[0]["storedId"]
            .as_i64()
            .expect("stored Gitlink file ID");
        let empty_hunks = list_hunks_from_connection(
            &connection,
            FileChangeHunkPageRequest {
                change_set_id: change_set_id.clone(),
                file_id: gitlink_file_id,
                after_ordinal: None,
                limit: Some(2),
            },
        )
        .expect("read empty Gitlink hunk page");
        assert!(empty_hunks.ranges.is_empty());
        assert_eq!(empty_hunks.next_cursor, None);

        let first_hunks = list_hunks_from_connection(
            &connection,
            FileChangeHunkPageRequest {
                change_set_id: change_set_id.clone(),
                file_id,
                after_ordinal: None,
                limit: Some(2),
            },
        )
        .expect("read first hunk page");
        assert_eq!(first_hunks.ranges.len(), 2);
        let hunk_cursor = first_hunks.next_cursor.expect("hunk cursor");

        let remaining_hunks = list_hunks_from_connection(
            &connection,
            FileChangeHunkPageRequest {
                change_set_id,
                file_id,
                after_ordinal: Some(hunk_cursor),
                limit: Some(2),
            },
        )
        .expect("read remaining hunk page");
        assert_eq!(remaining_hunks.ranges.len(), 1);
        assert_eq!(remaining_hunks.ranges[0]["oldStart"], 20);
        assert_eq!(remaining_hunks.next_cursor, None);
    }

    #[test]
    fn keeps_inline_changes_and_marks_partial_when_persistence_fails() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_connection(&mut connection).expect("initialize database");
        let mut response = DesktopTaskRunResponse {
            execution: json!({
                "fileChanges": {
                    "files": [{ "operation": "modified", "ranges": [] }],
                    "totalFiles": 1,
                    "status": "complete",
                    "completeness": {
                        "persistence": { "state": "complete" }
                    },
                    "issues": []
                }
            }),
            preview: None,
        };

        let error = persist_response_with_connection(
            &mut connection,
            Some("task-with-invalid-file"),
            &mut response,
        )
        .expect_err("the missing file path should reject persistence");
        annotate_persistence_failure(&mut response, &error);

        assert_eq!(
            response.execution["fileChanges"]["files"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(response.execution["fileChanges"]["status"], "partial");
        assert_eq!(
            response.execution["fileChanges"]["completeness"]["persistence"]["state"],
            "failed"
        );
        assert_eq!(
            response.execution["fileChanges"]["issues"][0]["stage"],
            "persistence"
        );
    }

    #[test]
    fn initializes_the_lean_schema_once_without_dropping_current_data() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        initialize_connection(&mut connection).expect("initialize database");
        connection
            .execute("INSERT INTO change_sets(id) VALUES ('changes-1')", [])
            .expect("insert current-schema row");

        initialize_connection(&mut connection).expect("reopen current schema");

        let schema_version = connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .expect("read schema version");
        let stored_sets = connection
            .query_row("SELECT COUNT(*) FROM change_sets", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("count stored change sets");
        let mut columns_statement = connection
            .prepare("PRAGMA table_info(changed_files)")
            .expect("prepare schema inspection");
        let columns = columns_statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("inspect changed-file columns")
            .collect::<Result<Vec<_>, _>>()
            .expect("read changed-file columns");

        assert_eq!(schema_version, 2);
        assert_eq!(stored_sets, 1);
        assert_eq!(
            columns,
            ["id", "change_set_id", "payload_json", "hunk_count"]
        );
    }

    #[test]
    fn refuses_to_downgrade_a_newer_schema() {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                "CREATE TABLE future_file_changes(value TEXT NOT NULL);
                 INSERT INTO future_file_changes(value) VALUES ('preserved');
                 PRAGMA user_version = 3;",
            )
            .expect("create future schema");

        let error = initialize_connection(&mut connection)
            .expect_err("a newer schema must not be overwritten");
        let preserved: String = connection
            .query_row("SELECT value FROM future_file_changes", [], |row| {
                row.get(0)
            })
            .expect("future schema data should remain intact");

        assert!(error.contains("newer than supported"));
        assert_eq!(preserved, "preserved");
    }
}
