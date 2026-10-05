use super::*;

fn attachment() -> Shape {
    Shape::Union(vec![
        object(vec![
            required("id", identifier()),
            required("source", enumeration(&["path"])),
            required("kind", short_text()),
            required("name", text()),
            required("path", text()),
            optional("parent", text()),
        ]),
        object(vec![
            required("id", identifier()),
            required("source", enumeration(&["media-asset"])),
            required("kind", short_text()),
            required("name", text()),
            required("workspaceRoot", workspace()),
            required("assetId", identifier()),
        ]),
    ])
}

fn memory_entry() -> Shape {
    object(vec![
        required("id", identifier()),
        required("content", text()),
        required("createdAt", Shape::Integer),
        optional(
            "sourceSession",
            object(vec![
                required("id", identifier()),
                required("title", text()),
            ]),
        ),
    ])
}

fn goal_mode() -> Shape {
    enumeration(&["machdoch", "native"])
}

fn session_goal() -> Shape {
    object(vec![
        required("id", identifier()),
        required("objective", Shape::String(4_000, true)),
        required("mode", goal_mode()),
        required(
            "status",
            enumeration(&["active", "paused", "blocked", "budget-limited", "complete"]),
        ),
        required("turns", Shape::Integer),
        required("tokensUsed", Shape::Integer),
        required("elapsedMs", Shape::Integer),
        optional("tokenBudget", Shape::PositiveInteger),
        optional("turnBudget", Shape::PositiveInteger),
        optional("timeBudgetMs", Shape::PositiveInteger),
        required("reason", text()),
        required("createdAt", Shape::Integer),
        required("updatedAt", Shape::Integer),
    ])
}

fn product_session() -> Shape {
    object(vec![
        required("id", identifier()),
        required("title", text()),
        required("status", short_text()),
        optional("workspace", workspace()),
        required("provider", string(240)),
        required("model", string(240)),
        optional("mode", string(240)),
        required("effectiveMode", string(240)),
        optional("parallelAgentMode", parallel_agent_mode()),
        optional("goalMode", goal_mode()),
        optional("reasoning", string(240)),
        optional("effectiveReasoning", string(240)),
        required("createdAt", Shape::Integer),
        required("updatedAt", Shape::Integer),
        optional("archivedAt", Shape::Integer),
        optional("pinnedAt", Shape::Integer),
        required("tags", array(string(64), 24)),
        required("messageCount", Shape::Integer),
        required("promptHistoryCount", Shape::Integer),
        required("attachmentCount", Shape::Integer),
        optional("runningTaskId", identifier()),
        required("canRename", Shape::Bool),
        required("canDelete", Shape::Bool),
        required("canArchive", Shape::Bool),
        required("canPin", Shape::Bool),
        required("canDuplicate", Shape::Bool),
        required("canBranch", Shape::Bool),
        optional("specialKind", string(240)),
    ])
}

fn trace_entry() -> Shape {
    object(vec![
        required("label", text()),
        required("detail", text()),
        optional("tone", string(240)),
        optional("timestamp", Shape::Integer),
    ])
}

fn product_message() -> Shape {
    object(vec![
        required("id", identifier()),
        required("role", string(64)),
        required("content", text()),
        optional("createdAt", Shape::Integer),
        optional("taskId", identifier()),
        optional(
            "taskAction",
            object(vec![
                required("kind", enumeration(&["retry-task", "continue-task"])),
                required("objective", text()),
            ]),
        ),
        required(
            "presentation",
            enumeration(&["message", "prompt-enhancement"]),
        ),
        required("attachments", array(attachment(), 64)),
        optional(
            "source",
            object(vec![
                required("kind", string(64)),
                optional("status", string(64)),
                optional("title", text()),
                optional("summary", text()),
                optional("mode", string(64)),
                required("entries", array(trace_entry(), 24)),
                required("timeline", array(trace_entry(), 40)),
            ]),
        ),
        required(
            "actions",
            object(vec![
                required("canRetry", Shape::Bool),
                required("canContinue", Shape::Bool),
                required("canSaveAsContextPack", Shape::Bool),
                required("canSpeak", Shape::Bool),
                required("isSpeaking", Shape::Bool),
            ]),
        ),
    ])
}

fn parallel_agent_mode() -> Shape {
    enumeration(&["disabled", "read-only", "machdoch", "native"])
}
fn reasoning_mode() -> Shape {
    enumeration(&[
        "default", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "aeon",
    ])
}
fn runtime_capability() -> Shape {
    object(vec![
        required("available", Shape::Bool),
        optional("reason", text()),
    ])
}

fn model_provider() -> Shape {
    object(vec![
        required("provider", string(240)),
        required("label", text()),
        required("available", Shape::Bool),
        optional("error", text()),
        required(
            "models",
            array(
                object(vec![
                    required("id", string(240)),
                    required("label", text()),
                    required("reasoningOptions", bounded_array(reasoning_mode(), 1, 10)),
                ]),
                256,
            ),
        ),
    ])
}

fn project() -> Shape {
    object(vec![
        required("id", Shape::Uuid),
        required("name", Shape::ProjectName),
        required("kind", enumeration(&["empty", "git", "imported"])),
        required(
            "status",
            enumeration(&["creating", "cloning", "ready", "failed", "cancelled"]),
        ),
        optional("repository", string(2048)),
        optional("branch", string(240)),
        optional("shallow", Shape::Bool),
        optional("initializeGit", Shape::Bool),
        optional("error", string(1000)),
        required("createdAt", Shape::Integer),
        required("updatedAt", Shape::Integer),
    ])
}

fn project_library() -> Shape {
    object(vec![
        required("root", workspace()),
        required("projects", array(Shape::ProjectListItem, 100)),
        required("maximumProjects", Shape::PositiveInteger),
        required("maximumConcurrentOperations", Shape::PositiveInteger),
    ])
}

pub(super) fn project_list_item() -> Shape {
    if let Shape::Object(mut fields) = project() {
        fields.push(required("workspace", workspace()));
        fields.push(optional("progress", string(500)));
        object(fields)
    } else {
        unreachable!()
    }
}

fn composer() -> Shape {
    object(vec![
        required("sessionId", identifier()),
        required("draft", string(8_000)),
        required("provider", string(240)),
        required("providerLabel", text()),
        required("model", string(240)),
        required("modelLabel", text()),
        required("modelCatalogLoading", Shape::Bool),
        required("modelCatalog", array(model_provider(), 32)),
        required("mode", enumeration(&["ask", "machdoch"])),
        required("defaultMode", enumeration(&["ask", "machdoch"])),
        optional("parallelAgentMode", parallel_agent_mode()),
        optional("goalMode", goal_mode()),
        optional(
            "availableParallelAgentModes",
            array(parallel_agent_mode(), usize::MAX),
        ),
        optional("availableGoalModes", array(goal_mode(), usize::MAX)),
        optional("goal", Shape::Nullable(Box::new(session_goal()))),
        required("reasoning", reasoning_mode()),
        required("defaultReasoning", reasoning_mode()),
        required("reasoningOptions", bounded_array(reasoning_mode(), 1, 10)),
        required(
            "promptEnhancementMode",
            enumeration(&["off", "simple", "web-search"]),
        ),
        required("interviewEnabled", Shape::Bool),
        required("interviewAvailable", Shape::Bool),
        optional("workspace", workspace()),
        required("workspaceLabel", text()),
        required("canSend", Shape::Bool),
        optional("sendDisabledReason", text()),
        required("isExecuting", Shape::Bool),
        required("sessionMemoryEnabled", Shape::Bool),
        required("sessionMemory", array(memory_entry(), 24)),
        optional("workspaceMemoryAvailable", Shape::Bool),
        optional("workspaceMemoryEnabled", Shape::Bool),
        required("globalMemoryAvailable", Shape::Bool),
        required("globalMemoryEnabled", Shape::Bool),
        required("uiControlAvailable", Shape::Bool),
        required("uiControlEnabled", Shape::Bool),
        required("uiControlDescription", text()),
        required("attachments", array(attachment(), 64)),
        required("chooserProviders", array(string(240), 32)),
        required(
            "matchedContextPackIds",
            array(identifier(), crate::MAX_MANAGED_SETTINGS_COLLECTION_ENTRIES),
        ),
    ])
}

fn runtime() -> Shape {
    object(vec![
        required("loading", Shape::Bool),
        optional("error", text()),
        required("hasAnyProvider", Shape::Bool),
        required(
            "providerStatuses",
            array(
                object(vec![
                    required("provider", string(240)),
                    required("available", Shape::Bool),
                    optional("reason", text()),
                ]),
                32,
            ),
        ),
        optional("mode", string(240)),
        optional("reasoning", string(240)),
        optional("uiControl", runtime_capability()),
        optional("webSearch", runtime_capability()),
    ])
}

fn scheduler() -> Shape {
    object(vec![
        optional("workspaceRoot", workspace()),
        required("loading", Shape::Bool),
        optional("error", text()),
        required(
            "jobs",
            array(
                object(vec![
                    required("id", identifier()),
                    required("name", text()),
                    required("status", string(64)),
                    required("schedule", text()),
                    required("promptPreview", text()),
                    optional("nextRunAt", Shape::Integer),
                    optional("lastStartedAt", Shape::Integer),
                    optional("lastFinishedAt", Shape::Integer),
                ]),
                80,
            ),
        ),
        required(
            "runs",
            array(
                object(vec![
                    required("id", identifier()),
                    required("jobId", identifier()),
                    required("source", string(64)),
                    required("status", string(64)),
                    required("scheduledFor", Shape::Integer),
                    required("updatedAt", Shape::Integer),
                    required("attempt", Shape::Integer),
                    required("maxAttempts", Shape::Integer),
                    optional("startedAt", Shape::Integer),
                    optional("finishedAt", Shape::Integer),
                    optional("nextAttemptAt", Shape::Integer),
                    optional("error", text()),
                    optional("summary", text()),
                ]),
                120,
            ),
        ),
        required("updatedAt", Shape::Integer),
    ])
}

fn context_pack() -> Shape {
    object(vec![
        required("id", identifier()),
        required("name", text()),
        optional("scope", enumeration(&["workspace", "global"])),
        optional("scopeLabel", text()),
        optional("workspace", workspace()),
        required("instructionsPreview", text()),
        required("promptPreview", text()),
        required("attachmentCount", Shape::Integer),
        required("variables", array(string(240), 64)),
        required("matched", Shape::Bool),
        optional("provider", string(240)),
        optional("model", string(240)),
        optional("mode", string(240)),
        optional("reasoning", string(240)),
        optional("promptEnhancementMode", string(240)),
        optional("interviewEnabled", Shape::Bool),
        optional("sessionMemoryEnabled", Shape::Bool),
        optional("useGlobalMemory", Shape::Bool),
        optional("uiControlEnabled", Shape::Bool),
    ])
}

fn instructions() -> Shape {
    object(vec![
        required("loading", Shape::Bool),
        optional("revision", Shape::Integer),
        optional("error", text()),
        required(
            "profiles",
            array(
                object(vec![
                    required("id", identifier()),
                    required("name", text()),
                    optional("description", text()),
                    optional("body", text()),
                    required("enabled", Shape::Bool),
                    required("global", Shape::Bool),
                    required("tags", array(string(80), 64)),
                ]),
                128,
            ),
        ),
    ])
}

fn voice() -> Shape {
    object(vec![
        required("supported", Shape::Bool),
        required("autoSpeakResponses", Shape::Bool),
        optional("speakingMessageId", identifier()),
        required("speechInputSupported", Shape::Bool),
        required("speechInputEnabled", Shape::Bool),
        optional("speechInputStatus", text()),
    ])
}

fn quick_task() -> Shape {
    object(vec![
        required("status", string(64)),
        required("draft", string(8_000)),
        required("isExecuting", Shape::Bool),
        required("provider", string(240)),
        required("model", string(240)),
        required("autopilotEnabled", Shape::Bool),
        required("globalMemoryEnabled", Shape::Bool),
        required("uiControlEnabled", Shape::Bool),
        required("attachmentCount", Shape::Integer),
    ])
}

fn ralph() -> Shape {
    object(vec![
        optional("workspaceRoot", workspace()),
        required("loading", Shape::Bool),
        optional("error", text()),
        required(
            "flows",
            array(
                object(vec![
                    required("id", identifier()),
                    optional("alias", identifier()),
                    required("name", text()),
                    required("scope", enumeration(&["workspace", "user"])),
                    optional("description", text()),
                    required("blockCount", Shape::Integer),
                    required("edgeCount", Shape::Integer),
                    required(
                        "variables",
                        array(
                            object(vec![
                                required("name", identifier()),
                                required(
                                    "type",
                                    enumeration(&[
                                        "string", "text", "path", "file", "files", "url", "number",
                                        "boolean", "image", "images", "model", "provider", "pack",
                                    ]),
                                ),
                                optional("default", text()),
                                required("required", Shape::Bool),
                            ]),
                            64,
                        ),
                    ),
                    optional("maxTransitions", Shape::BoundedInteger(1, 1_000_000)),
                ]),
                160,
            ),
        ),
        required(
            "runs",
            array(
                object(vec![
                    required("id", identifier()),
                    required("flowId", identifier()),
                    required("flowName", text()),
                    required("scope", enumeration(&["workspace", "user"])),
                    required(
                        "status",
                        enumeration(&[
                            "running",
                            "completed",
                            "crashed",
                            "blocked",
                            "stopped",
                            "waiting-for-input",
                            "abandoned",
                            "partial",
                        ]),
                    ),
                    required("summary", text()),
                    required("createdAt", Shape::Integer),
                    optional("finishedAt", Shape::Integer),
                    required("blockCount", Shape::Integer),
                    required("eventCount", Shape::Integer),
                    optional("taskId", identifier()),
                    required("cancellable", Shape::Bool),
                    required("recoverable", Shape::Bool),
                ]),
                160,
            ),
        ),
        required("updatedAt", Shape::Integer),
    ])
}

fn media_target() -> Shape {
    enumeration(&["image", "svg"])
}
fn media_ratio() -> Shape {
    enumeration(&["1:1", "4:5", "16:9", "9:16"])
}
fn media_format() -> Shape {
    enumeration(&["png", "jpeg", "webp", "svg"])
}

fn media() -> Shape {
    object(vec![
        required("loading", Shape::Bool),
        optional("error", text()),
        optional("runtimeMode", enumeration(&["native", "browser-preview"])),
        required(
            "generation",
            object(vec![
                required("prompt", string(8_000)),
                required("target", media_target()),
                optional("modelId", identifier()),
                required("aspectRatio", media_ratio()),
                required("outputCount", Shape::BoundedInteger(1, 8)),
                required("outputFormat", media_format()),
                required("transparentBackground", Shape::Bool),
                required("available", Shape::Bool),
                optional("unavailableReason", text()),
            ]),
        ),
        required(
            "models",
            array(
                object(vec![
                    required("id", identifier()),
                    required("label", text()),
                    required("target", enumeration(&["local", "remote"])),
                    required("targets", bounded_array(media_target(), 1, 2)),
                    required("recommended", Shape::Bool),
                    optional("costHint", text()),
                ]),
                128,
            ),
        ),
        required(
            "assets",
            array(
                object(vec![
                    required("id", identifier()),
                    required("runId", identifier()),
                    required("kind", enumeration(&["image", "video", "vector", "report"])),
                    required("mimeType", string(80)),
                    required("byteSize", Shape::Integer),
                    required("width", Shape::Integer),
                    required("height", Shape::Integer),
                    required("createdAt", string(80)),
                    optional("previewDataUrl", Shape::ImageDataUrl),
                    required("tags", array(string(80), 8)),
                ]),
                48,
            ),
        ),
        required("assetCount", Shape::Integer),
        required(
            "runs",
            array(
                object(vec![
                    required("id", identifier()),
                    required(
                        "status",
                        enumeration(&[
                            "queued",
                            "running",
                            "needs-review",
                            "waiting-for-review",
                            "canceling",
                            "completed",
                            "failed",
                            "canceled",
                        ]),
                    ),
                    required("createdAt", string(80)),
                    required("updatedAt", string(80)),
                    required("prompt", text()),
                    required("modelLabel", text()),
                    required(
                        "target",
                        Shape::Nullable(Box::new(enumeration(&["local", "remote"]))),
                    ),
                    required("outputCount", Shape::Integer),
                    required("progress", Shape::Number(0.0, 1.0)),
                    required("currentStep", text()),
                    optional("error", text()),
                ]),
                80,
            ),
        ),
        required("runCount", Shape::Integer),
        required("busy", Shape::Bool),
        required("updatedAt", Shape::Integer),
    ])
}

pub(super) fn shape() -> Shape {
    object(vec![
        optional("projectLibrary", project_library()),
        optional("poseSceneSvg", string(64_000)),
        required("version", Shape::Version),
        required("capturedAt", Shape::Integer),
        optional("activeSessionId", identifier()),
        required("sessions", array(product_session(), 80)),
        required(
            "workspaces",
            array(
                object(vec![
                    required("root", workspace()),
                    required("label", text()),
                    required("sessionCount", Shape::Integer),
                ]),
                128,
            ),
        ),
        required("visibleMessages", array(product_message(), 80)),
        optional("composer", composer()),
        optional("runtime", runtime()),
        optional("scheduler", scheduler()),
        optional("ralph", ralph()),
        required("contextPacks", array(context_pack(), 128)),
        optional("instructions", instructions()),
        required("promptHistory", array(string(8_000), 30)),
        optional("voice", voice()),
        optional("quickTask", quick_task()),
        optional("media", media()),
    ])
}
