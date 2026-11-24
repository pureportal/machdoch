use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::Error, Deserialize, Deserializer};
use serde_json::{Map, Value};

fn fields<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    (object.len() == names.len() && names.iter().all(|name| object.contains_key(*name)))
        .then_some(object)
}

fn fields_with_optional<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    (required.iter().all(|name| object.contains_key(*name))
        && object
            .keys()
            .all(|key| required.contains(&key.as_str()) || optional.contains(&key.as_str())))
    .then_some(object)
}

fn optional_boolean(object: &Map<String, Value>, name: &str) -> bool {
    object.get(name).is_none_or(Value::is_boolean)
}

fn branch_switch_target(value: &Value) -> bool {
    fields_with_optional(value, &["repositoryRoot", "branchName"], &["create"]).is_some_and(
        |target| {
            root(&target["repositoryRoot"])
                && text(&target["branchName"], 240, true)
                && optional_boolean(target, "create")
        },
    )
}

fn text(value: &Value, maximum: usize, trim: bool) -> bool {
    value.as_str().is_some_and(|value| {
        let value = if trim {
            super::ecmascript_trim(value)
        } else {
            value
        };
        !value.is_empty() && value.encode_utf16().count() <= maximum
    })
}

fn root(value: &Value) -> bool {
    text(value, 2048, true) && value.as_str().is_some_and(|value| !value.contains('\0'))
}

fn run_identifier(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn run_input_values(value: &Value) -> bool {
    value.as_object().is_some_and(|values| {
        values.len() <= 64
            && values.iter().all(|(id, value)| {
                run_identifier(id)
                    && (value.is_boolean()
                        || value.as_str().is_some_and(|value| {
                            value.encode_utf16().count() <= 1024 && !value.contains('\0')
                        }))
            })
    })
}

fn path(value: &Value) -> bool {
    text(value, 2048, false)
        && value.as_str().is_some_and(|value| {
            let bytes = value.as_bytes();
            !value.contains('\0')
                && !value.starts_with(['/', '\\'])
                && !(bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
                && !value.split(['/', '\\']).any(|part| part == "..")
        })
}

fn reachable_path(value: &Value) -> bool {
    text(value, 2048, false) && value.as_str().is_some_and(|value| !value.contains('\0'))
}

fn name(value: &Value) -> bool {
    text(value, 255, false)
        && value.as_str().is_some_and(|value| {
            !value.contains(['\0', '/', '\\']) && value != "." && value != ".."
        })
}

fn content(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() <= (1024 * 1024 + 2) / 3 * 4
            && STANDARD.decode(value).is_ok_and(|bytes| {
                bytes.len() <= 1024 * 1024 && std::str::from_utf8(&bytes).is_ok()
            })
    })
}

fn integer(value: &Value, maximum: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|value| (0.0..=maximum).contains(&value) && value.fract() == 0.0)
}

fn terminal(command: &str, args: &Value) -> bool {
    if command == "start_workspace_terminal" {
        return fields(args, &["request"]).is_some_and(|args| {
            fields_with_optional(
                &args["request"],
                &["workspaceRoot", "shellId", "columns", "rows"],
                &["cwd"],
            )
            .is_some_and(|request| {
                request.get("cwd").is_none_or(path)
                    && root(&request["workspaceRoot"])
                    && text(&request["shellId"], 240, false)
                    && integer(&request["columns"], 500.0)
                    && request["columns"].as_f64().unwrap() > 0.0
                    && integer(&request["rows"], 300.0)
                    && request["rows"].as_f64().unwrap() > 0.0
            })
        });
    }
    let names: &[&str] = match command {
        "read_workspace_terminal_events" => &["workspaceRoot", "sessionId", "after"],
        "write_workspace_terminal" | "write_workspace_terminal_binary" => {
            &["workspaceRoot", "sessionId", "data"]
        }
        "acknowledge_workspace_terminal_output" => &["workspaceRoot", "sessionId", "bytes"],
        "resize_workspace_terminal" => &["workspaceRoot", "sessionId", "columns", "rows"],
        "stop_workspace_terminal" => &["workspaceRoot", "sessionId"],
        _ => return false,
    };
    let Some(args) = fields(args, names) else {
        return false;
    };
    if !root(&args["workspaceRoot"]) || !text(&args["sessionId"], 240, false) {
        return false;
    }
    match command {
        "read_workspace_terminal_events" => integer(&args["after"], 9_007_199_254_740_991.0),
        "write_workspace_terminal" => args["data"]
            .as_str()
            .is_some_and(|value| value.len() <= 65536),
        "write_workspace_terminal_binary" => args["data"].as_str().is_some_and(|value| {
            value.len() <= 87384
                && STANDARD
                    .decode(value)
                    .is_ok_and(|bytes| bytes.len() <= 65536)
        }),
        "acknowledge_workspace_terminal_output" => integer(&args["bytes"], (896 * 1024) as f64),
        "resize_workspace_terminal" => {
            integer(&args["columns"], 500.0)
                && args["columns"].as_f64().unwrap() > 0.0
                && integer(&args["rows"], 300.0)
                && args["rows"].as_f64().unwrap() > 0.0
        }
        "stop_workspace_terminal" => true,
        _ => false,
    }
}

fn repository(request: &Map<String, Value>) -> bool {
    root(&request["workspaceRoot"]) && root(&request["repositoryRoot"])
}

fn commit_id(value: &Value) -> bool {
    value.as_str().is_some_and(|commit| {
        (4..=64).contains(&commit.len()) && commit.bytes().all(|byte| byte.is_ascii_hexdigit())
    })
}

fn stash_reference(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value
            .strip_prefix("stash@{")
            .and_then(|rest| rest.strip_suffix('}'))
            .is_some_and(|index| {
                !index.is_empty() && index.bytes().all(|byte| byte.is_ascii_digit())
            })
    })
}

const OVERVIEW_SECTIONS: [&str; 5] = [
    "branches",
    "numstat",
    "recentCommits",
    "stashes",
    "worktrees",
];

fn overview_sections(value: &Value) -> bool {
    value.as_array().is_some_and(|sections| {
        sections.len() <= OVERVIEW_SECTIONS.len()
            && sections.iter().all(|section| {
                section
                    .as_str()
                    .is_some_and(|section| OVERVIEW_SECTIONS.contains(&section))
            })
    })
}

fn untracked_files(value: &Value) -> bool {
    matches!(value.as_str(), Some("normal" | "all"))
}

fn bounded_array(
    value: &Value,
    minimum: usize,
    maximum: usize,
    item: impl Fn(&Value) -> bool,
) -> bool {
    value
        .as_array()
        .is_some_and(|items| (minimum..=maximum).contains(&items.len()) && items.iter().all(item))
}

fn plain_string(value: &Value, maximum: usize) -> bool {
    value
        .as_str()
        .is_some_and(|value| value.encode_utf16().count() <= maximum)
}

fn git_action_fields(action: &str) -> Option<(&'static [&'static str], &'static [&'static str])> {
    Some(match action {
        "fetch" | "pull" | "stage-all" | "unstage-all" | "restack" | "continue-operation"
        | "abort-operation" | "skip-operation" | "set-upstream" | "pull-rebase"
        | "remove-index-lock" | "prune-worktrees" => (&[], &[]),
        "push" => (&[], &["force"]),
        "submit-pull-requests" => (&[], &["draft"]),
        "checkout"
        | "checkout-remote"
        | "create-stacked-branch"
        | "unstack-branch"
        | "merge"
        | "rebase" => (&["branchName"], &[]),
        "create-branch" | "add-worktree" => (&["branchName"], &["startPoint"]),
        "delete-branch" => (&["branchName"], &["force"]),
        "stack-branch" => (&["branchName", "parentBranch"], &[]),
        "reset" => (&[], &["startPoint", "resetMode"]),
        "stage" | "unstage" | "discard" | "mark-resolved" => (&["paths"], &[]),
        "commit" => (
            &["message"],
            &["amend", "signOff", "coAuthors", "pushAfterCommit"],
        ),
        "apply-patch" => (&["patch", "patchTarget", "reverse"], &[]),
        "cherry-pick" | "revert" => (&["commit"], &[]),
        "create-tag" => (&["tagName"], &["startPoint", "message"]),
        "push-tag" => (&["tagName"], &[]),
        "delete-tag" => (&["tagName"], &["remote"]),
        "resolve-conflict" => (&["paths", "side"], &[]),
        "undo" => (&["target"], &[]),
        "delete-branches" => (&["branchNames"], &["force"]),
        "create-pull-request" => (&["title"], &["body", "baseBranch", "draft"]),
        "stash-push" => (&[], &["message", "includeUntracked"]),
        "stash-apply" | "stash-pop" | "stash-drop" => (&["stashRef"], &[]),
        "add-remote" => (&["remoteName", "remoteUrl"], &[]),
        "remove-remote" => (&["remoteName"], &[]),
        "remove-worktree" => (&["worktreePath"], &["force"]),
        "lock-worktree" | "unlock-worktree" => (&["worktreePath"], &[]),
        _ => return None,
    })
}

fn git_action(value: &Value) -> bool {
    let Some(action) = value["action"].as_str() else {
        return false;
    };
    let Some((required, optional)) = git_action_fields(action) else {
        return false;
    };
    let base = ["workspaceRoot", "repositoryRoot", "action"];
    let overview = ["sections", "untrackedFiles"];
    let Some(request) = value.as_object() else {
        return false;
    };
    let known = |key: &str| {
        base.contains(&key)
            || overview.contains(&key)
            || required.contains(&key)
            || optional.contains(&key)
    };
    if !base
        .iter()
        .chain(required)
        .all(|name| request.contains_key(*name))
        || !request.keys().all(|key| known(key))
    {
        return false;
    }
    let message_limit = if action == "commit" { 20_000 } else { 500 };
    let check = |field: &str, valid: &dyn Fn(&Value) -> bool| request.get(field).is_none_or(valid);
    repository(request)
        && [
            "branchName",
            "parentBranch",
            "startPoint",
            "remoteName",
            "tagName",
            "baseBranch",
        ]
        .iter()
        .all(|field| check(field, &|value| text(value, 240, true)))
        && check("remoteUrl", &|value| text(value, 2048, true))
        && check("worktreePath", &root)
        && check("message", &|value| text(value, message_limit, true))
        && check("title", &|value| text(value, 500, true))
        && check("body", &|value| plain_string(value, 60_000))
        && check("patch", &|value| {
            value
                .as_str()
                .is_some_and(|patch| !patch.is_empty() && patch.encode_utf16().count() <= 2_000_000)
        })
        && check("patchTarget", &|value| {
            matches!(value.as_str(), Some("index" | "worktree"))
        })
        && check("side", &|value| {
            matches!(value.as_str(), Some("ours" | "theirs"))
        })
        && check("commit", &commit_id)
        && check("target", &commit_id)
        && check("stashRef", &stash_reference)
        && check("resetMode", &|value| {
            matches!(value.as_str(), Some("keep" | "discard"))
        })
        && [
            "force",
            "draft",
            "includeUntracked",
            "amend",
            "signOff",
            "pushAfterCommit",
            "remote",
            "reverse",
        ]
        .iter()
        .all(|field| check(field, &Value::is_boolean))
        && check("coAuthors", &|value| {
            bounded_array(value, 0, 20, |author| text(author, 240, true))
        })
        && check("branchNames", &|value| {
            bounded_array(value, 1, 500, |branch| text(branch, 240, true))
        })
        && check("paths", &|value| bounded_array(value, 1, 2000, path))
        && check("sections", &overview_sections)
        && check("untrackedFiles", &untracked_files)
}

fn binary_chunk(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() <= (1024 * 1024 + 2) / 3 * 4
            && STANDARD
                .decode(value)
                .is_ok_and(|bytes| bytes.len() <= 1024 * 1024)
    })
}

fn revision(value: &Value) -> bool {
    value.as_str().is_some_and(|value| {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    })
}

fn text_search(request: &Map<String, Value>) -> bool {
    root(&request["workspaceRoot"])
        && request["query"]
            .as_str()
            .is_some_and(|query| !query.is_empty() && query.encode_utf16().count() <= 2000)
        && ["regex", "caseSensitive", "wholeWord"]
            .iter()
            .all(|field| request[*field].is_boolean())
        && ["include", "exclude"].iter().all(|field| {
            request
                .get(*field)
                .is_none_or(|value| plain_string(value, 2000))
        })
}

fn repository_request(
    args: &Value,
    extra: &[&str],
    optional: &[&str],
) -> Option<Map<String, Value>> {
    let args = fields(args, &["request"])?;
    let mut required = vec!["workspaceRoot", "repositoryRoot"];
    required.extend_from_slice(extra);
    let request = fields_with_optional(&args["request"], &required, optional)?;
    repository(request).then(|| request.clone())
}

fn cloud_issue_query(payload: &str) -> bool {
    payload.encode_utf16().count() <= 1024
        && serde_json::from_str::<Value>(payload)
            .ok()
            .as_ref()
            .and_then(|arguments| fields(arguments, &["query"]))
            .and_then(|arguments| arguments["query"].as_str())
            .is_some_and(|query| {
                !query.is_empty()
                    && query.encode_utf16().count() <= 200
                    && super::ecmascript_trim(query) == query
                    && !query.contains('\0')
            })
}

fn mcp_command(args: &Value) -> bool {
    let Some(args) = fields(args, &["request"]) else {
        return false;
    };
    let Some(request) = fields(&args["request"], &["workspaceRoot", "arguments"]) else {
        return false;
    };
    let Some(arguments) = request["arguments"].as_array() else {
        return false;
    };
    if !root(&request["workspaceRoot"]) {
        return false;
    }
    let server = |value: &Value| {
        text(value, 240, true)
            && value.as_str().is_some_and(|value| {
                let value = super::ecmascript_trim(value);
                !value.starts_with('-') && !value.contains('\0')
            })
    };
    match arguments.as_slice() {
        [action] => matches!(action.as_str(), Some("servers" | "cache")),
        [action, option] if action.as_str() == Some("servers") => {
            option.as_str() == Some("--include-disabled")
        }
        [action, id] => {
            matches!(
                action.as_str(),
                Some("discover" | "refresh" | "oauth-start" | "oauth-authorize")
            ) && server(id)
        }
        [action, id, response] => {
            action.as_str() == Some("oauth-finish")
                && server(id)
                && text(response, 8192, true)
                && response.as_str().is_some_and(|value| !value.contains('\0'))
        }
        [action, id, tool, flag, payload] => {
            action.as_str() == Some("call-tool")
                && id.as_str() == Some("machdoch-cloud")
                && tool.as_str() == Some("list_issues")
                && flag.as_str() == Some("--arguments-json")
                && payload.as_str().is_some_and(cloud_issue_query)
        }
        _ => false,
    }
}

pub fn valid_workspace_invocation(command: &str, args: &Value) -> bool {
    match command {
        "run_live_voice_command" => fields(args, &["workspaceRoot", "input"]).is_some_and(|args| {
            root(&args["workspaceRoot"])
                && match args["input"]["action"].as_str() {
                    Some("session") => fields(&args["input"], &["action"]).is_some(),
                    Some("process") => fields(&args["input"], &["action", "text"])
                        .is_some_and(|input| text(&input["text"], 20_000, false)),
                    _ => false,
                }
        }),
        "run_mcp_app_command" => fields(args, &["workspaceRoot", "input"]).is_some_and(|args| {
            text(&args["workspaceRoot"], 2048, true)
                && args["input"].is_object()
                && args["input"].to_string().len() <= 256 * 1024
                && matches!(
                    args["input"]["action"].as_str(),
                    Some("settings" | "set-enabled" | "load" | "call-tool")
                )
        }),
        "run_workspace_library_command" => {
            fields(args, &["workspaceRoot", "input"]).is_some_and(|args| {
                root(&args["workspaceRoot"])
                    && args["input"].is_object()
                    && args["input"].to_string().len() <= 2 * 1024 * 1024
                    && matches!(
                        args["input"]["action"].as_str(),
                        Some(
                            "source"
                                | "search"
                                | "index"
                                | "projects"
                                | "project"
                                | "save-project"
                                | "delete-project"
                                | "check-sources"
                        )
                    )
            })
        }
        "get_session_file_change_files" | "get_session_file_change_hunks" => {
            args.as_object().is_some_and(|args| {
                let hunks = command == "get_session_file_change_hunks";
                let cursor = if hunks { "afterOrdinal" } else { "afterId" };
                args.keys().all(|key| {
                    matches!(
                        key.as_str(),
                        "sessionId" | "messageId" | "changeSetId" | "limit"
                    ) || key == cursor
                        || (hunks && key == "fileId")
                }) && ["sessionId", "messageId"]
                    .iter()
                    .all(|key| args.get(*key).is_some_and(|value| text(value, 240, true)))
                    && args
                        .get("changeSetId")
                        .is_some_and(|value| text(value, 128, true))
                    && args.get("limit").is_some_and(|value| {
                        integer(value, 100.0) && value.as_f64().unwrap() >= 1.0
                    })
                    && args
                        .get(cursor)
                        .is_none_or(|value| integer(value, 9_007_199_254_740_991.0))
                    && (!hunks
                        || args.get("fileId").is_some_and(|value| {
                            integer(value, 9_007_199_254_740_991.0)
                                && value.as_f64().unwrap() >= 1.0
                        }))
            })
        }
        "reset_desktop_task_timeout" => args.as_object().is_some_and(|args| {
            args.keys()
                .all(|key| matches!(key.as_str(), "taskId" | "idleTimeoutMinutes"))
                && args
                    .get("taskId")
                    .is_some_and(|value| text(value, 240, true))
                && args
                    .get("idleTimeoutMinutes")
                    .is_none_or(|value| integer(value, 1440.0) && value.as_f64().unwrap() >= 1.0)
        }),
        "get_session_export" => fields(args, &["sessionIds"]).is_some_and(|args| {
            args["sessionIds"].as_array().is_some_and(|ids| {
                !ids.is_empty() && ids.len() <= 5_000 && ids.iter().all(|id| text(id, 240, true))
            })
        }),
        "import_session_export" => fields(args, &["path"]).is_some_and(|args| root(&args["path"])),
        "get_session_message_page" => args.as_object().is_some_and(|args| {
            args.keys().all(|key| {
                matches!(
                    key.as_str(),
                    "sessionId" | "beforeMessageId" | "expectedRevision" | "limit"
                )
            }) && args
                .get("sessionId")
                .is_some_and(|value| text(value, 240, true))
                && args
                    .get("limit")
                    .is_some_and(|value| integer(value, 80.0) && value.as_f64().unwrap() >= 1.0)
                && args
                    .get("beforeMessageId")
                    .is_none_or(|value| text(value, 240, true))
                && args.get("expectedRevision").is_none_or(|value| {
                    value.as_str().is_some_and(|value| {
                        value.len() == 64
                            && value
                                .bytes()
                                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                    })
                })
        }),
        "get_session_index" => fields(
            args,
            &[
                "offset", "limit", "query", "scope", "statuses", "project", "tags",
            ],
        )
        .is_some_and(|args| {
            integer(&args["offset"], 9_007_199_254_740_991.0)
                && integer(&args["limit"], 80.0)
                && args["limit"].as_f64().unwrap() >= 1.0
                && args["query"]
                    .as_str()
                    .is_some_and(|value| value.encode_utf16().count() <= 8_000)
                && matches!(args["scope"].as_str(), Some("all" | "open" | "archived"))
                && args["statuses"].as_array().is_some_and(|values| {
                    values.len() <= 10
                        && values.iter().all(|value| {
                            matches!(
                                value.as_str(),
                                Some(
                                    "empty"
                                        | "unread"
                                        | "running"
                                        | "done"
                                        | "failed"
                                        | "blocked"
                                        | "cancelled"
                                        | "timed-out"
                                        | "unsupported"
                                        | "crashed"
                                )
                            )
                        })
                })
                && args["project"]
                    .as_str()
                    .is_some_and(|value| value.encode_utf16().count() <= 2048)
                && args["tags"].as_array().is_some_and(|values| {
                    values.len() <= 24 && values.iter().all(|value| text(value, 240, true))
                })
        }),
        "get_context_pack_documents" | "get_session_composer_text" => {
            fields(args, &["sessionId"]).is_some_and(|args| text(&args["sessionId"], 240, true))
        }
        "import_context_attachment" => fields(args, &["path", "name"]).is_some_and(|args| {
            root(&args["path"])
                && text(&args["name"], 200, false)
                && args["name"].as_str().is_some_and(|name| {
                    !name.starts_with('.')
                        && !name.contains(['/', '\\', ':'])
                        && !name.chars().any(char::is_control)
                })
        }),
        "read_context_attachment_preview" => {
            fields(args, &["path"]).is_some_and(|args| root(&args["path"]))
        }
        "list_context_attachment_directory" => fields(args, &["path", "offset"])
            .is_some_and(|args| root(&args["path"]) && integer(&args["offset"], 20_000.0)),
        "get_workspace_run_configuration_document" | "get_workspace_run_snapshot" => {
            fields(args, &["workspaceRoot"]).is_some_and(|args| root(&args["workspaceRoot"]))
        }
        "save_workspace_run_configuration_document"
        | "precheck_workspace_run_configuration_json" => {
            fields(args, &["request"]).is_some_and(|args| {
                fields(&args["request"], &["workspaceRoot", "documentBase64"]).is_some_and(
                    |request| {
                        root(&request["workspaceRoot"]) && content(&request["documentBase64"])
                    },
                )
            })
        }
        "run_workspace_run_detection_command" => {
            fields(args, &["workspaceRoot"]).is_some_and(|args| root(&args["workspaceRoot"]))
        }
        "start_workspace_run_configuration"
        | "stop_workspace_run_configuration"
        | "restart_workspace_run_configuration" => fields(args, &["request"]).is_some_and(|args| {
            let request = &args["request"];
            let mut names = vec!["workspaceRoot"];
            if request.get("configurationId").is_some() {
                names.push("configurationId");
            }
            if command != "stop_workspace_run_configuration" && request.get("inputs").is_some() {
                names.push("inputs");
            }
            fields(request, &names).is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && request
                        .get("configurationId")
                        .is_none_or(|value| value.as_str().is_some_and(run_identifier))
                    && request.get("inputs").is_none_or(run_input_values)
            })
        }),
        "run_mcp_command" => mcp_command(args),
        "run_provider_sync_command" => fields(args, &["request"]).is_some_and(|args| {
            fields(&args["request"], &["workspaceRoot", "arguments"]).is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && request["arguments"].as_array().is_some_and(|arguments| {
                        arguments.len() == 1
                            && matches!(
                                arguments[0].as_str(),
                                Some(
                                    "status" | "refresh" | "enable" | "disable" | "doctor" | "plan"
                                )
                            )
                    })
            })
        }),
        "get_user_memory_settings" => fields(args, &[]).is_some(),
        "get_runtime_snapshot"
        | "stop_all_workspace_terminals"
        | "get_workspace_memory_entries"
        | "get_workspace_reasoning_bank_lessons"
        | "get_workspace_mcp_config_document" => {
            fields(args, &["workspaceRoot"]).is_some_and(|args| root(&args["workspaceRoot"]))
        }
        "forget_workspace_memory" => fields(args, &["workspaceRoot", "id"])
            .is_some_and(|args| root(&args["workspaceRoot"]) && text(&args["id"], 240, false)),
        "save_workspace_default_mode" => {
            fields(args, &["workspaceRoot", "mode"]).is_some_and(|args| {
                root(&args["workspaceRoot"])
                    && matches!(args["mode"].as_str(), Some("ask" | "machdoch"))
            })
        }
        "save_workspace_memory_override" | "save_workspace_adaptive_controller_override" => {
            fields(args, &["workspaceRoot", "enabled"]).is_some_and(|args| {
                root(&args["workspaceRoot"])
                    && (args["enabled"].is_boolean() || args["enabled"].is_null())
            })
        }
        "save_workspace_reasoning_bank_enabled"
        | "save_workspace_auto_gitignore"
        | "save_workspace_git_fsmonitor" => fields(args, &["workspaceRoot", "enabled"])
            .is_some_and(|args| root(&args["workspaceRoot"]) && args["enabled"].is_boolean()),
        "save_workspace_release_stage" => fields(args, &["workspaceRoot", "releaseStage"])
            .is_some_and(|args| {
                root(&args["workspaceRoot"])
                    && (args["releaseStage"].is_null()
                        || matches!(
                            args["releaseStage"].as_str(),
                            Some("early-alpha" | "beta" | "production")
                        ))
            }),
        "save_workspace_reasoning_mode" => fields(args, &["workspaceRoot", "reasoning"])
            .is_some_and(|args| {
                root(&args["workspaceRoot"])
                    && matches!(
                        args["reasoning"].as_str(),
                        Some(
                            "default"
                                | "none"
                                | "minimal"
                                | "low"
                                | "medium"
                                | "high"
                                | "xhigh"
                                | "max"
                                | "ultra"
                                | "aeon"
                        )
                    )
            }),
        "save_workspace_reasoning_execution_mode" => {
            fields(args, &["workspaceRoot", "reasoningMode"]).is_some_and(|args| {
                root(&args["workspaceRoot"])
                    && matches!(args["reasoningMode"].as_str(), Some("standard" | "pro"))
            })
        }
        "save_workspace_context_window" => fields(args, &["workspaceRoot", "contextWindow"])
            .is_some_and(|args| {
                root(&args["workspaceRoot"])
                    && matches!(
                        args["contextWindow"].as_str(),
                        Some("lowest" | "default" | "highest")
                    )
            }),
        "save_workspace_mcp_config_document" => {
            fields(args, &["workspaceRoot", "rawBase64", "expectedRawBase64"]).is_some_and(|args| {
                root(&args["workspaceRoot"])
                    && content(&args["rawBase64"])
                    && content(&args["expectedRawBase64"])
            })
        }
        "list_workspace_directory" => fields(args, &["workspaceRoot", "relativePath", "offset"])
            .is_some_and(|args| {
                root(&args["workspaceRoot"])
                    && reachable_path(&args["relativePath"])
                    && args["offset"].as_f64().is_some_and(|offset| {
                        (0.0..=20_000.0).contains(&offset) && offset.fract() == 0.0
                    })
            }),
        "read_workspace_file" | "read_workspace_file_preview" | "open_workspace_path" => {
            fields(args, &["workspaceRoot", "relativePath"]).is_some_and(|args| {
                root(&args["workspaceRoot"]) && reachable_path(&args["relativePath"])
            })
        }
        "discover_workspace_git_repositories" => {
            fields_with_optional(args, &["workspaceRoot"], &["refresh"]).is_some_and(|args| {
                root(&args["workspaceRoot"]) && optional_boolean(args, "refresh")
            })
        }
        "discover_workspace_shells" | "stop_workspace_terminals" => {
            fields(args, &["workspaceRoot"]).is_some_and(|args| root(&args["workspaceRoot"]))
        }
        "get_workspace_git_repositories_status" => fields(args, &["request"]).is_some_and(|args| {
            fields_with_optional(&args["request"], &["workspaceRoot"], &["refresh"]).is_some_and(
                |request| root(&request["workspaceRoot"]) && optional_boolean(request, "refresh"),
            )
        }),
        "get_workspace_git_branch_status" => fields(args, &["request"]).is_some_and(|args| {
            fields_with_optional(
                &args["request"],
                &["workspaceRoot"],
                &["branchName", "fetch"],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && request
                        .get("branchName")
                        .is_none_or(|value| text(value, 240, true))
                    && optional_boolean(request, "fetch")
            })
        }),
        "switch_workspace_git_branches" => fields(args, &["request"]).is_some_and(|args| {
            fields(
                &args["request"],
                &["workspaceRoot", "targets", "stashChanges"],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && request["stashChanges"].is_boolean()
                    && request["targets"].as_array().is_some_and(|targets| {
                        (1..=256).contains(&targets.len())
                            && targets.iter().all(branch_switch_target)
                    })
            })
        }),
        "save_workspace_file" => fields(args, &["request"]).is_some_and(|args| {
            fields(
                &args["request"],
                &[
                    "workspaceRoot",
                    "relativePath",
                    "contentBase64",
                    "expectedRevision",
                    "force",
                    "bom",
                ],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && reachable_path(&request["relativePath"])
                    && content(&request["contentBase64"])
                    && request["expectedRevision"].as_str().is_some_and(|value| {
                        value.len() == 64
                            && value
                                .bytes()
                                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
                    })
                    && request["force"].is_boolean()
                    && request["bom"].is_boolean()
            })
        }),
        "create_workspace_entry" => fields(args, &["request"]).is_some_and(|args| {
            fields(
                &args["request"],
                &["workspaceRoot", "parentPath", "name", "kind"],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && reachable_path(&request["parentPath"])
                    && name(&request["name"])
                    && matches!(request["kind"].as_str(), Some("file" | "directory"))
            })
        }),
        "rename_workspace_entry" => fields(args, &["request"]).is_some_and(|args| {
            fields(&args["request"], &["workspaceRoot", "relativePath", "name"]).is_some_and(
                |request| {
                    root(&request["workspaceRoot"])
                        && path(&request["relativePath"])
                        && name(&request["name"])
                },
            )
        }),
        "get_workspace_git_summary" | "get_workspace_git_fingerprint" => {
            fields(args, &["workspaceRoot"]).is_some_and(|args| root(&args["workspaceRoot"]))
        }
        "get_workspace_git_overview" => {
            repository_request(args, &[], &["sections", "untrackedFiles"]).is_some_and(|request| {
                request.get("sections").is_none_or(overview_sections)
                    && request.get("untrackedFiles").is_none_or(untracked_files)
            })
        }
        "get_workspace_pull_requests"
        | "list_workspace_git_branches"
        | "get_workspace_git_undo" => repository_request(args, &[], &[]).is_some(),
        "get_workspace_git_file_history" | "get_workspace_git_conflict" => {
            repository_request(args, &["relativePath"], &[])
                .is_some_and(|request| path(&request["relativePath"]))
        }
        "get_workspace_git_blame" | "get_workspace_git_file_revision" => {
            repository_request(args, &["relativePath"], &["revision"]).is_some_and(|request| {
                path(&request["relativePath"])
                    && request
                        .get("revision")
                        .is_none_or(|value| text(value, 240, true))
            })
        }
        "compare_workspace_git_revisions" => repository_request(args, &["base", "head"], &[])
            .is_some_and(|request| {
                text(&request["base"], 240, true) && text(&request["head"], 240, true)
            }),
        "get_workspace_pull_request_checks" => repository_request(args, &["number"], &[])
            .is_some_and(|request| {
                integer(&request["number"], 1_000_000_000.0)
                    && request["number"]
                        .as_f64()
                        .is_some_and(|number| number >= 1.0)
            }),
        "generate_workspace_git_commit_message" => {
            fields(args, &["workspaceRoot", "repositoryRoot"]).is_some_and(repository)
        }
        "get_workspace_git_call_log" | "watch_workspace" | "unwatch_workspace" => {
            fields(args, &["workspaceRoot"]).is_some_and(|args| root(&args["workspaceRoot"]))
        }
        "read_workspace_changes" => fields(args, &["workspaceRoot", "after"]).is_some_and(|args| {
            root(&args["workspaceRoot"]) && integer(&args["after"], 9_007_199_254_740_991.0)
        }),
        "search_workspace_files" => fields(args, &["request"]).is_some_and(|args| {
            fields_with_optional(&args["request"], &["workspaceRoot", "query"], &["limit"])
                .is_some_and(|request| {
                    root(&request["workspaceRoot"])
                        && plain_string(&request["query"], 500)
                        && request.get("limit").is_none_or(|limit| {
                            integer(limit, 500.0)
                                && limit.as_f64().is_some_and(|limit| limit >= 1.0)
                        })
                })
        }),
        "search_workspace_text" => fields(args, &["request"]).is_some_and(|args| {
            fields_with_optional(
                &args["request"],
                &[
                    "workspaceRoot",
                    "query",
                    "regex",
                    "caseSensitive",
                    "wholeWord",
                ],
                &["include", "exclude", "limit"],
            )
            .is_some_and(|request| {
                text_search(request)
                    && request.get("limit").is_none_or(|limit| {
                        integer(limit, 5000.0) && limit.as_f64().is_some_and(|limit| limit >= 1.0)
                    })
            })
        }),
        "replace_workspace_text" => fields(args, &["request"]).is_some_and(|args| {
            fields_with_optional(
                &args["request"],
                &[
                    "workspaceRoot",
                    "query",
                    "regex",
                    "caseSensitive",
                    "wholeWord",
                    "replacement",
                    "apply",
                    "files",
                ],
                &["include", "exclude"],
            )
            .is_some_and(|request| {
                text_search(request)
                    && plain_string(&request["replacement"], 20_000)
                    && request["apply"].is_boolean()
                    && bounded_array(&request["files"], 1, 2000, |file| {
                        fields(file, &["path", "revision"])
                            .is_some_and(|file| path(&file["path"]) && revision(&file["revision"]))
                    })
            })
        }),
        "delete_workspace_entries" => fields(args, &["request"]).is_some_and(|args| {
            fields(
                &args["request"],
                &["workspaceRoot", "relativePaths", "trash"],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && bounded_array(&request["relativePaths"], 1, 500, path)
                    && request["trash"].is_boolean()
            })
        }),
        "copy_workspace_entries" => fields(args, &["request"]).is_some_and(|args| {
            fields(
                &args["request"],
                &["workspaceRoot", "sources", "targetDirectory", "mode"],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && bounded_array(&request["sources"], 1, 500, path)
                    && reachable_path(&request["targetDirectory"])
                    && matches!(request["mode"].as_str(), Some("copy" | "move"))
            })
        }),
        "upload_workspace_file" => fields(args, &["request"]).is_some_and(|args| {
            fields(
                &args["request"],
                &["workspaceRoot", "relativePath", "chunkBase64", "append"],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && path(&request["relativePath"])
                    && binary_chunk(&request["chunkBase64"])
                    && request["append"].is_boolean()
            })
        }),
        "read_workspace_file_range" => fields(args, &["request"]).is_some_and(|args| {
            fields(
                &args["request"],
                &["workspaceRoot", "relativePath", "offset", "length"],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && reachable_path(&request["relativePath"])
                    && integer(&request["offset"], 9_007_199_254_740_991.0)
                    && integer(&request["length"], 1024.0 * 1024.0)
                    && request["length"]
                        .as_f64()
                        .is_some_and(|length| length >= 1.0)
            })
        }),
        "get_workspace_git_graph" => fields(args, &["request"]).is_some_and(|args| {
            fields_with_optional(
                &args["request"],
                &["workspaceRoot", "repositoryRoot"],
                &["scope"],
            )
            .is_some_and(|request| {
                repository(request)
                    && request
                        .get("scope")
                        .is_none_or(|scope| matches!(scope.as_str(), Some("current" | "all")))
            })
        }),
        "get_workspace_git_commit" => fields(args, &["request"]).is_some_and(|args| {
            fields_with_optional(
                &args["request"],
                &["workspaceRoot", "repositoryRoot", "commit"],
                &["base", "relativePath"],
            )
            .is_some_and(|request| {
                repository(request)
                    && commit_id(&request["commit"])
                    && request.get("base").is_none_or(commit_id)
                    && request.get("relativePath").is_none_or(path)
            })
        }),
        "get_workspace_git_diff" => fields(args, &["request"]).is_some_and(|args| {
            fields(
                &args["request"],
                &["workspaceRoot", "repositoryRoot", "relativePath"],
            )
            .is_some_and(|request| repository(request) && path(&request["relativePath"]))
        }),
        "run_workspace_git_action" => {
            fields(args, &["request"]).is_some_and(|args| git_action(&args["request"]))
        }
        "open_workspace_terminal_host" => fields(args, &["workspaceRoot", "terminalId"])
            .is_some_and(|args| {
                root(&args["workspaceRoot"]) && text(&args["terminalId"], 240, false)
            }),
        command if command.contains("workspace_terminal") => terminal(command, args),
        _ => false,
    }
}

pub(super) fn deserialize_workspace_request<'de, D>(deserializer: D) -> Result<Value, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    if value["kind"] == "events"
        || !super::operation::valid_request(&value, valid_workspace_invocation)
    {
        return Err(D::Error::custom("invalid workspace request"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use crate::HostRequest;
    use serde_json::{json, Value};

    #[test]
    fn workspace_requests_match_typescript_conformance() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../fixtures/workspace-tools-conformance.json"))
                .unwrap();
        for entry in cases {
            assert_eq!(
                serde_json::from_value::<HostRequest>(
                    json!({ "type": "workspace", "request": entry["request"] })
                )
                .is_ok(),
                entry["accepted"].as_bool().unwrap(),
                "{}",
                entry["name"]
            );
        }
    }
}
