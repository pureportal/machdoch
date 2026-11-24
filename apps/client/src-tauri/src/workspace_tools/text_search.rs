use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex, PoisonError,
    },
};

use ignore::{overrides::OverrideBuilder, WalkBuilder, WalkState};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::atomic_file::{write_file_atomic, AtomicWriteOptions};

const MAX_SEARCH_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_MATCHES: usize = 5_000;
const MAX_PREVIEW_CHARS: usize = 240;
const MAX_QUERY_CHARS: usize = 2_000;
const BINARY_SCAN_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTextQuery {
    query: String,
    #[serde(default)]
    regex: bool,
    #[serde(default)]
    case_sensitive: bool,
    #[serde(default)]
    whole_word: bool,
    #[serde(default)]
    include: Option<String>,
    #[serde(default)]
    exclude: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceTextSearchRequest {
    workspace_root: String,
    #[serde(flatten)]
    query: WorkspaceTextQuery,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTextMatch {
    line: usize,
    column: usize,
    length: usize,
    preview: String,
    preview_column: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTextFileMatches {
    path: String,
    revision: String,
    matches: Vec<WorkspaceTextMatch>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTextSearchResult {
    files: Vec<WorkspaceTextFileMatches>,
    total_matches: usize,
    searched_files: usize,
    limit_reached: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReplaceTarget {
    path: String,
    revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceTextReplaceRequest {
    workspace_root: String,
    #[serde(flatten)]
    query: WorkspaceTextQuery,
    replacement: String,
    files: Vec<WorkspaceReplaceTarget>,
    apply: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplaceLine {
    line: usize,
    before: String,
    after: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceReplaceFile {
    path: String,
    replacements: usize,
    lines: Vec<WorkspaceReplaceLine>,
    status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTextReplaceResult {
    files: Vec<WorkspaceReplaceFile>,
    applied: bool,
}

fn revision(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn compile(query: &WorkspaceTextQuery) -> Result<Regex, String> {
    if query.query.is_empty() || query.query.chars().count() > MAX_QUERY_CHARS {
        return Err("Enter a search term.".to_string());
    }
    let pattern = if query.regex {
        query.query.clone()
    } else {
        regex::escape(&query.query)
    };
    let pattern = if query.whole_word {
        format!(r"\b(?:{pattern})\b")
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!query.case_sensitive)
        .multi_line(true)
        .size_limit(8 * 1024 * 1024)
        .build()
        .map_err(|error| format!("The search pattern is invalid: {error}"))
}

fn canonical_root(workspace_root: &str) -> Result<PathBuf, String> {
    let trimmed = workspace_root.trim();
    if trimmed.is_empty() {
        return Err("Select a workspace first.".to_string());
    }
    fs::canonicalize(trimmed)
        .map_err(|error| format!("Workspace {trimmed} is unavailable: {error}"))
}

fn relative_text(root: &Path, path: &Path) -> Option<String> {
    let text = path
        .strip_prefix(root)
        .ok()?
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    (!text.is_empty()).then_some(text)
}

fn read_text(path: &Path) -> Option<(Vec<u8>, String)> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_SEARCH_FILE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.iter().take(BINARY_SCAN_BYTES).any(|byte| *byte == 0) {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?.to_string();
    Some((bytes, text))
}

fn preview(line: &str, start: usize, length: usize) -> (String, usize) {
    let characters = line
        .trim_end_matches(['\r', '\n'])
        .chars()
        .collect::<Vec<_>>();
    let before = MAX_PREVIEW_CHARS.saturating_sub(length.min(MAX_PREVIEW_CHARS)) / 2;
    let from = start.saturating_sub(before.min(40));
    let to = (from + MAX_PREVIEW_CHARS).min(characters.len());
    (
        characters[from..to].iter().collect(),
        characters[from..start]
            .iter()
            .map(|character| character.len_utf16())
            .sum::<usize>()
            + 1,
    )
}

fn line_matches(text: &str, pattern: &Regex) -> Vec<WorkspaceTextMatch> {
    let mut matches = Vec::new();
    let mut line_starts = vec![0usize];
    line_starts.extend(text.match_indices('\n').map(|(index, _)| index + 1));
    for found in pattern.find_iter(text) {
        if found.as_str().is_empty() {
            continue;
        }
        let line = line_starts.partition_point(|start| *start <= found.start()) - 1;
        let line_start = line_starts[line];
        let line_end = line_starts.get(line + 1).copied().unwrap_or(text.len());
        let line_text = &text[line_start..line_end];
        let column = text[line_start..found.start()].chars().count();
        let (preview, preview_column) = preview(line_text, column, found.as_str().chars().count());
        matches.push(WorkspaceTextMatch {
            line: line + 1,
            column: text[line_start..found.start()].encode_utf16().count() + 1,
            length: found.as_str().encode_utf16().count(),
            preview,
            preview_column,
        });
    }
    matches
}

fn overrides(
    root: &Path,
    query: &WorkspaceTextQuery,
) -> Result<ignore::overrides::Override, String> {
    let mut builder = OverrideBuilder::new(root);
    for glob in query
        .include
        .iter()
        .flat_map(|globs| globs.split(','))
        .filter(|glob| !glob.trim().is_empty())
    {
        builder
            .add(glob.trim())
            .map_err(|error| format!("The include pattern `{glob}` is invalid: {error}"))?;
    }
    for glob in query
        .exclude
        .iter()
        .flat_map(|globs| globs.split(','))
        .filter(|glob| !glob.trim().is_empty())
    {
        builder
            .add(&format!("!{}", glob.trim()))
            .map_err(|error| format!("The exclude pattern `{glob}` is invalid: {error}"))?;
    }
    builder
        .build()
        .map_err(|error| format!("The file patterns are invalid: {error}"))
}

pub(crate) fn search_text(
    request: WorkspaceTextSearchRequest,
) -> Result<WorkspaceTextSearchResult, String> {
    let root = canonical_root(&request.workspace_root)?;
    let pattern = compile(&request.query)?;
    let overrides = overrides(&root, &request.query)?;
    let limit = request.limit.unwrap_or(MAX_MATCHES).clamp(1, MAX_MATCHES);
    let files = Mutex::new(Vec::<WorkspaceTextFileMatches>::new());
    let total = AtomicUsize::new(0);
    let searched_files = AtomicUsize::new(0);
    let truncated = AtomicBool::new(false);
    WalkBuilder::new(&root)
        .hidden(false)
        .git_ignore(true)
        .git_global(false)
        .require_git(false)
        .overrides(overrides)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build_parallel()
        .run(|| {
            Box::new(|entry| {
                if truncated.load(Ordering::Relaxed) {
                    return WalkState::Quit;
                }
                let Ok(entry) = entry else {
                    return WalkState::Continue;
                };
                if !entry.file_type().is_some_and(|kind| kind.is_file()) {
                    return WalkState::Continue;
                }
                let Some((bytes, text)) = read_text(entry.path()) else {
                    return WalkState::Continue;
                };
                searched_files.fetch_add(1, Ordering::Relaxed);
                let mut matches = line_matches(&text, &pattern);
                if matches.is_empty() {
                    return WalkState::Continue;
                }
                let previous = total.fetch_add(matches.len(), Ordering::Relaxed);
                if previous + matches.len() > limit {
                    matches.truncate(limit.saturating_sub(previous));
                    truncated.store(true, Ordering::Relaxed);
                }
                if matches.is_empty() {
                    return WalkState::Continue;
                }
                if let Some(path) = relative_text(&root, entry.path()) {
                    files.lock().unwrap_or_else(PoisonError::into_inner).push(
                        WorkspaceTextFileMatches {
                            path,
                            revision: revision(&bytes),
                            matches,
                        },
                    );
                }
                WalkState::Continue
            })
        });
    let mut files = files.into_inner().unwrap_or_else(PoisonError::into_inner);
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(WorkspaceTextSearchResult {
        total_matches: files.iter().map(|file| file.matches.len()).sum(),
        files,
        searched_files: searched_files.into_inner(),
        limit_reached: truncated.into_inner(),
    })
}

fn replace_in(
    text: &str,
    pattern: &Regex,
    replacement: &str,
    regex: bool,
) -> (String, usize, Vec<WorkspaceReplaceLine>) {
    let mut count = 0;
    let mut lines = Vec::new();
    let mut output = String::with_capacity(text.len());
    for (index, line) in text.split_inclusive('\n').enumerate() {
        let replaced = if regex {
            pattern.replace_all(line, replacement)
        } else {
            pattern.replace_all(line, regex::NoExpand(replacement))
        };
        let found = pattern
            .find_iter(line)
            .filter(|found| !found.as_str().is_empty())
            .count();
        if found > 0 && replaced != line {
            count += found;
            lines.push(WorkspaceReplaceLine {
                line: index + 1,
                before: line.trim_end_matches(['\r', '\n']).to_string(),
                after: replaced.trim_end_matches(['\r', '\n']).to_string(),
            });
        }
        output.push_str(&replaced);
    }
    (output, count, lines)
}

pub(crate) fn replace_text(
    request: WorkspaceTextReplaceRequest,
) -> Result<WorkspaceTextReplaceResult, String> {
    let root = canonical_root(&request.workspace_root)?;
    let pattern = compile(&request.query)?;
    if request.files.is_empty() || request.files.len() > 2_000 {
        return Err("Select between 1 and 2000 files to replace in.".to_string());
    }
    let mut files = Vec::new();
    for target in &request.files {
        let relative = Path::new(&target.path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            return Err(format!(
                "`{}` is not a workspace-relative path.",
                target.path
            ));
        }
        let path = root.join(relative);
        let Some((bytes, text)) = read_text(&path) else {
            files.push(WorkspaceReplaceFile {
                path: target.path.clone(),
                replacements: 0,
                lines: Vec::new(),
                status: "unreadable".to_string(),
            });
            continue;
        };
        if revision(&bytes) != target.revision {
            files.push(WorkspaceReplaceFile {
                path: target.path.clone(),
                replacements: 0,
                lines: Vec::new(),
                status: "changed".to_string(),
            });
            continue;
        }
        let (output, replacements, lines) =
            replace_in(&text, &pattern, &request.replacement, request.query.regex);
        let status = if replacements == 0 {
            "unchanged"
        } else if request.apply {
            write_file_atomic(&path, output.as_bytes(), AtomicWriteOptions::default())
                .map_err(|error| format!("Unable to save `{}`: {error}", target.path))?;
            "replaced"
        } else {
            "preview"
        };
        files.push(WorkspaceReplaceFile {
            path: target.path.clone(),
            replacements,
            lines,
            status: status.to_string(),
        });
    }
    Ok(WorkspaceTextReplaceResult {
        files,
        applied: request.apply,
    })
}

#[tauri::command]
pub async fn search_workspace_text(
    request: WorkspaceTextSearchRequest,
) -> Result<WorkspaceTextSearchResult, String> {
    tauri::async_runtime::spawn_blocking(move || search_text(request))
        .await
        .map_err(|error| format!("The text search stopped unexpectedly: {error}"))?
}

#[tauri::command]
pub async fn replace_workspace_text(
    request: WorkspaceTextReplaceRequest,
) -> Result<WorkspaceTextReplaceResult, String> {
    tauri::async_runtime::spawn_blocking(move || replace_text(request))
        .await
        .map_err(|error| format!("The replacement stopped unexpectedly: {error}"))?
}

#[cfg(test)]
mod tests {
    use std::{env, time::SystemTime};

    use super::*;

    fn workspace() -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("the clock should be valid")
            .as_nanos();
        let root = env::temp_dir().join(format!("machdoch-text-search-{unique}"));
        fs::create_dir_all(root.join("src")).expect("folder should be created");
        fs::create_dir_all(root.join("dist")).expect("folder should be created");
        fs::write(root.join(".gitignore"), "dist/\n").expect("ignore should write");
        fs::write(
            root.join("src/a.ts"),
            "const value = 1;\nconst values = [value];\n",
        )
        .expect("write");
        fs::write(root.join("src/b.md"), "Value docs\n").expect("write");
        fs::write(root.join("dist/a.js"), "const value = 1;\n").expect("write");
        fs::write(root.join("src/binary.bin"), b"value\0value").expect("write");
        root
    }

    fn query(text: &str) -> WorkspaceTextQuery {
        WorkspaceTextQuery {
            query: text.to_string(),
            regex: false,
            case_sensitive: false,
            whole_word: false,
            include: None,
            exclude: None,
        }
    }

    fn search(root: &Path, query: WorkspaceTextQuery) -> WorkspaceTextSearchResult {
        search_text(WorkspaceTextSearchRequest {
            workspace_root: root.display().to_string(),
            query,
            limit: None,
        })
        .expect("search should succeed")
    }

    #[test]
    fn honours_case_word_regex_and_glob_options_and_groups_by_file() {
        let root = workspace();
        let all = search(&root, query("value"));
        assert_eq!(
            all.files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["src/a.ts", "src/b.md"]
        );
        assert_eq!(all.total_matches, 4);
        let first = &all.files[0].matches[0];
        assert_eq!((first.line, first.column, first.length), (1, 7, 5));

        let cased = search(
            &root,
            WorkspaceTextQuery {
                case_sensitive: true,
                ..query("Value")
            },
        );
        assert_eq!(cased.total_matches, 1);
        let words = search(
            &root,
            WorkspaceTextQuery {
                whole_word: true,
                ..query("value")
            },
        );
        assert_eq!(words.total_matches, 3);
        let regex = search(
            &root,
            WorkspaceTextQuery {
                regex: true,
                ..query(r"values?\b")
            },
        );
        assert_eq!(regex.total_matches, 4);
        let included = search(
            &root,
            WorkspaceTextQuery {
                include: Some("*.md".into()),
                ..query("value")
            },
        );
        assert_eq!(included.files.len(), 1);
        let excluded = search(
            &root,
            WorkspaceTextQuery {
                exclude: Some("*.md".into()),
                ..query("value")
            },
        );
        assert_eq!(excluded.files[0].path, "src/a.ts");
        assert!(compile(&WorkspaceTextQuery {
            regex: true,
            ..query("(")
        })
        .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn native_search_and_replace_accept_the_fleet_wire_contract() {
        let root = workspace();
        let request = serde_json::from_value(serde_json::json!({
            "workspaceRoot": root.display().to_string(),
            "query": "value",
            "regex": false,
            "caseSensitive": false,
            "wholeWord": true,
            "include": "*.ts, *.md",
            "exclude": "dist/**",
            "limit": 1
        }))
        .expect("the public search request should deserialize");
        let result = search_text(request).expect("search should succeed");
        assert_eq!(result.total_matches, 1);
        assert!(result.searched_files >= 1);
        assert!(result.limit_reached);
        let serialized = serde_json::to_value(&result).expect("search should serialize");
        assert!(serialized["searchedFiles"].is_number());
        assert_eq!(serialized["limitReached"], true);
        assert!(serialized["files"][0]["matches"][0]["previewColumn"].is_number());
        assert!(serialized.get("truncated").is_none());
        let file = &result.files[0];
        let replacement = serde_json::from_value(serde_json::json!({
            "workspaceRoot": root.display().to_string(),
            "query": "value",
            "regex": false,
            "caseSensitive": false,
            "wholeWord": true,
            "include": "*.ts, *.md",
            "replacement": "amount",
            "apply": false,
            "files": [{ "path": file.path, "revision": file.revision }]
        }))
        .expect("the public replace request should deserialize");
        let replaced = replace_text(replacement).expect("replace preview should succeed");
        assert!(replaced.files[0].replacements > 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_columns_use_utf16_offsets_in_clipped_previews() {
        let prefix = "\u{1f600}".repeat(80);
        let matches = line_matches(
            &format!("{prefix}value"),
            &compile(&query("value")).expect("pattern should compile"),
        );
        assert_eq!(matches[0].column, 161);
        assert_eq!(matches[0].preview_column, 81);
        assert_eq!(matches[0].length, 5);
    }

    #[test]
    fn replace_previews_then_applies_and_refuses_changed_files() {
        let root = workspace();
        let found = search(
            &root,
            WorkspaceTextQuery {
                whole_word: true,
                ..query("value")
            },
        );
        let file = &found.files[0];
        let request = |apply| WorkspaceTextReplaceRequest {
            workspace_root: root.display().to_string(),
            query: WorkspaceTextQuery {
                whole_word: true,
                ..query("value")
            },
            replacement: "amount".to_string(),
            files: vec![WorkspaceReplaceTarget {
                path: file.path.clone(),
                revision: file.revision.clone(),
            }],
            apply,
        };
        let preview = replace_text(request(false)).expect("preview should succeed");
        assert_eq!(preview.files[0].replacements, 2);
        assert_eq!(preview.files[0].lines[1].after, "const values = [amount];");
        assert_eq!(
            fs::read_to_string(root.join("src/a.ts")).expect("read"),
            "const value = 1;\nconst values = [value];\n"
        );
        let applied = replace_text(request(true)).expect("apply should succeed");
        assert_eq!(applied.files[0].status, "replaced");
        assert_eq!(
            fs::read_to_string(root.join("src/a.ts")).expect("read"),
            "const amount = 1;\nconst values = [amount];\n"
        );
        let stale = replace_text(request(true)).expect("stale replace should report");
        assert_eq!(stale.files[0].status, "changed");
        let _ = fs::remove_dir_all(root);
    }
}
