use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{de::Error, Deserialize, Deserializer};
use serde_json::{Map, Value};

fn fields<'a>(value: &'a Value, names: &[&str]) -> Option<&'a Map<String, Value>> {
    let object = value.as_object()?;
    (object.len() == names.len() && names.iter().all(|name| object.contains_key(*name)))
        .then_some(object)
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
            fields(
                &args["request"],
                &["workspaceRoot", "shellId", "columns", "rows"],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
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

fn git_action(value: &Value) -> bool {
    let Some(action) = value["action"].as_str() else {
        return false;
    };
    let names: &[&str] = match action {
        "fetch" | "pull" => &["workspaceRoot", "repositoryRoot", "action"],
        "checkout" | "checkout-remote" | "create-branch" => {
            &["workspaceRoot", "repositoryRoot", "action", "branchName"]
        }
        "add-remote" => &[
            "workspaceRoot",
            "repositoryRoot",
            "action",
            "remoteName",
            "remoteUrl",
        ],
        "remove-remote" => &["workspaceRoot", "repositoryRoot", "action", "remoteName"],
        _ => return false,
    };
    let Some(request) = fields(value, names) else {
        return false;
    };
    repository(request)
        && request
            .get("branchName")
            .is_none_or(|value| text(value, 240, true))
        && request
            .get("remoteName")
            .is_none_or(|value| text(value, 240, true))
        && request
            .get("remoteUrl")
            .is_none_or(|value| text(value, 2048, true))
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
        _ => false,
    }
}

pub fn valid_workspace_invocation(command: &str, args: &Value) -> bool {
    match command {
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
        "read_context_attachment_preview" => args.as_object().is_some_and(|args| {
            args.keys()
                .all(|key| matches!(key.as_str(), "path" | "sessionId" | "messageId"))
                && args.get("path").is_some_and(root)
                && args
                    .get("sessionId")
                    .is_some_and(|value| text(value, 240, true))
                && args
                    .get("messageId")
                    .is_none_or(|value| text(value, 240, true))
        }),
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
        "start_workspace_run_configuration"
        | "stop_workspace_run_configuration"
        | "restart_workspace_run_configuration" => fields(args, &["request"]).is_some_and(|args| {
            let request = &args["request"];
            let names: &[&str] = if request.get("configurationId").is_some() {
                &["workspaceRoot", "configurationId"]
            } else {
                &["workspaceRoot"]
            };
            fields(request, names).is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && request.get("configurationId").is_none_or(|value| {
                        value.as_str().is_some_and(|value| {
                            let bytes = value.as_bytes();
                            !bytes.is_empty()
                                && bytes.len() <= 64
                                && bytes[0].is_ascii_alphanumeric()
                                && bytes.iter().all(|byte| {
                                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
                                })
                        })
                    })
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
        "save_workspace_reasoning_bank_enabled" | "save_workspace_auto_gitignore" => {
            fields(args, &["workspaceRoot", "enabled"])
                .is_some_and(|args| root(&args["workspaceRoot"]) && args["enabled"].is_boolean())
        }
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
                    && (matches!(args["contextWindow"].as_str(), Some("default" | "long"))
                        || (integer(&args["contextWindow"], 10_000_000.0)
                            && args["contextWindow"].as_f64().unwrap() > 0.0))
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
                    && path(&args["relativePath"])
                    && args["offset"].as_f64().is_some_and(|offset| {
                        (0.0..=20_000.0).contains(&offset) && offset.fract() == 0.0
                    })
            }),
        "read_workspace_file" | "read_workspace_file_preview" | "open_workspace_path" => {
            fields(args, &["workspaceRoot", "relativePath"])
                .is_some_and(|args| root(&args["workspaceRoot"]) && path(&args["relativePath"]))
        }
        "discover_workspace_git_repositories"
        | "discover_workspace_shells"
        | "stop_workspace_terminals" => {
            fields(args, &["workspaceRoot"]).is_some_and(|args| root(&args["workspaceRoot"]))
        }
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
                    && path(&request["relativePath"])
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
                    && path(&request["parentPath"])
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
        "delete_workspace_entry" => fields(args, &["request"]).is_some_and(|args| {
            fields(
                &args["request"],
                &["workspaceRoot", "relativePath", "recursive"],
            )
            .is_some_and(|request| {
                root(&request["workspaceRoot"])
                    && path(&request["relativePath"])
                    && request["recursive"].is_boolean()
            })
        }),
        "get_workspace_git_overview" | "get_workspace_pull_requests" => fields(args, &["request"])
            .is_some_and(|args| {
                fields(&args["request"], &["workspaceRoot", "repositoryRoot"])
                    .is_some_and(repository)
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
