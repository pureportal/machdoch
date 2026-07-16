import type {
  RalphBlockSettings,
  RalphFlowBlock,
  RalphUtilityConfig,
} from "../../../../core/ralph.js";
import { getProviderLabel } from "../../model-catalog";
import { REASONING_LABELS } from "../../reasoning-options";
import {
  compactPreviewText,
  formatMaxBytes,
  formatSeconds,
  formatUtilityConditionSummary,
  formatUtilityTypeLabel,
  titleFromId,
} from "./format-ralph-flow-labels.helper";

export interface RalphNodePreview {
  primary: string;
  secondary?: string;
  chips: string[];
}

export const getPromptLikeText = (block: RalphFlowBlock): string => {
  switch (block.type) {
    case "PROMPT":
    case "VALIDATOR":
    case "DECISION":
    case "INTERVIEW":
      return block.prompt;
    case "ASK_USER":
      return block.prompt ?? "";
    case "START":
    case "PACK":
    case "END":
      return "";
    case "NOTE":
      return block.text;
    case "GROUP":
      return block.description ?? "";
    case "UTILITY":
      return formatUtilityTypeLabel(block.utility.type);
    case "MCP_TOOL":
      return [block.serverId, block.toolName].filter(Boolean).join(".");
    case "MCP_RESOURCE":
      return block.uri;
    case "MCP_PROMPT":
      return [block.serverId, block.promptName].filter(Boolean).join(".");
    case "MEDIA_FLOW":
      return [block.flowId, block.revisionId].filter(Boolean).join(" · ");
  }
};

export const getUtilityNodePreview = (
  utility: RalphUtilityConfig,
): RalphNodePreview => {
  switch (utility.type) {
    case "WAIT": {
      const mode = utility.mode ?? "delay";
      if (mode === "until-time") {
        return {
          primary: `Wait until ${compactPreviewText(utility.runAt, "a configured time")}`,
          secondary: "Schedules the next block after the target time.",
          chips: ["single success route"],
        };
      }

      if (mode === "condition" || mode === "poll") {
        return {
          primary:
            mode === "poll" ? "Poll until condition passes" : "Wait for condition",
          secondary: formatUtilityConditionSummary(utility.condition),
          chips: [`every ${formatSeconds(utility.intervalSeconds ?? 30)}`],
        };
      }

      return {
        primary: `Delay for ${formatSeconds(utility.delaySeconds ?? 0)}`,
        secondary: "Pauses the flow, then continues.",
        chips: ["single success route"],
      };
    }
    case "HTTP_FETCH":
      return {
        primary: `${utility.method ?? "GET"} ${compactPreviewText(utility.url, "URL not set")}`,
        secondary: utility.outputPath
          ? `Stores response in ${utility.outputPath}`
          : "Returns status, headers, and body.",
        chips: [
          `${formatSeconds(utility.timeoutSeconds ?? 30)} timeout`,
          formatMaxBytes(utility.maxOutputBytes),
        ],
      };
    case "POLL":
      return {
        primary: `${utility.method ?? "GET"} ${compactPreviewText(utility.url, "URL not set")}`,
        secondary: formatUtilityConditionSummary(utility.condition),
        chips: [
          `every ${formatSeconds(utility.intervalSeconds ?? 30)}`,
          utility.maxAttempts === null || utility.maxAttempts === undefined
            ? "endless"
          : `${utility.maxAttempts} attempts`,
        ],
      };
    case "CONDITION":
      return {
        primary: "Route by condition",
        secondary: formatUtilityConditionSummary(utility.condition),
        chips: ["MATCH", "NO_MATCH", "ERROR"],
      };
    case "RUN_COMMAND":
      return {
        primary: compactPreviewText(utility.command, "Command not set"),
        secondary: utility.cwd ? `Working dir: ${utility.cwd}` : "Runs in the block workspace.",
        chips: [`${formatSeconds(utility.timeoutSeconds ?? 120)} timeout`],
      };
    case "RUN_CHECK":
      return {
        primary: compactPreviewText(utility.command, "Check command not set"),
        secondary: "Failed exit codes route to FAILED.",
        chips: [`${formatSeconds(utility.timeoutSeconds ?? 120)} timeout`],
      };
    case "UI_ANALYZE":
      return {
        primary:
          utility.adapter === "image"
            ? `Screenshot ${compactPreviewText(utility.screenshotPath, "path not set")}`
            : compactPreviewText(
                utility.targetUrl ?? utility.url,
                "Target URL not set",
              ),
        secondary:
          utility.adapter === "tauri-mcp" || utility.adapter === "playwright-mcp"
            ? `${utility.mcpServerId ?? "mcp"}.${utility.mcpToolName ?? "tool"}`
            : `Server: ${utility.server?.mode ?? "existing"}`,
        chips: [
          utility.adapter ?? "auto",
          `${utility.viewports?.length ?? 4} viewport(s)`,
          `${formatSeconds(utility.timeoutSeconds ?? 30)} timeout`,
        ],
      };
    case "READ_FILE":
      return {
        primary: `Read ${compactPreviewText(utility.path, "file path not set")}`,
        secondary: "Makes file content available to later blocks.",
        chips: utility.encoding ? [utility.encoding] : [],
      };
    case "WRITE_FILE":
      return {
        primary: `${utility.append ? "Append" : "Write"} ${compactPreviewText(
          utility.path,
          "file path not set",
        )}`,
        secondary: compactPreviewText(utility.content, "Content not set"),
        chips: utility.encoding ? [utility.encoding] : [],
      };
    case "READ_JSON":
      return {
        primary: `Read JSON ${compactPreviewText(utility.path, "file path not set")}`,
        secondary:
          utility.schema === undefined ? "No schema validation" : "Schema configured",
        chips: ["SUCCESS", "NOT_FOUND", "INVALID"],
      };
    case "READ_JSONL":
    case "QUERY_JSONL":
      return {
        primary: `${utility.type === "QUERY_JSONL" ? "Query" : "Read"} JSONL ${compactPreviewText(utility.path, "file path not set")}`,
        secondary:
          utility.type === "QUERY_JSONL"
            ? formatUtilityConditionSummary(utility.condition)
            : utility.schema === undefined
              ? "No schema validation"
              : "Schema configured",
        chips: [
          "SUCCESS",
          "EMPTY",
          utility.maxResults ? `max ${utility.maxResults}` : "all",
        ],
      };
    case "WRITE_JSON":
    case "PATCH_JSON":
    case "APPEND_JSONL":
      return {
        primary: `${utility.type === "PATCH_JSON" ? "Patch" : utility.type === "APPEND_JSONL" ? "Append" : "Write"} ${compactPreviewText(
          utility.path,
          "file path not set",
        )}`,
        secondary:
          utility.input ?? utility.content
            ? compactPreviewText(utility.input ?? utility.content, "JSON input")
            : "Uses previous result data",
        chips: [
          ...(utility.type === "PATCH_JSON"
            ? [utility.jsonPatchMode ?? "merge"]
            : []),
          utility.schema === undefined ? "no schema" : "schema",
        ],
      };
    case "FILE_EXISTS":
      return {
        primary: `Check ${compactPreviewText(utility.path, "file path not set")}`,
        secondary: "Routes by whether the path exists.",
        chips: ["EXISTS", "MISSING", "ERROR"],
      };
    case "DELETE_FILE":
      return {
        primary: `Delete ${compactPreviewText(utility.path, "file path not set")}`,
        secondary: "Deletes a workspace-contained file.",
        chips: ["SUCCESS", "NOT_FOUND", "ERROR"],
      };
    case "MOVE_FILE":
      return {
        primary: `Move ${compactPreviewText(utility.path, "file path not set")}`,
        secondary: `To ${compactPreviewText(utility.outputPath, "output path not set")}`,
        chips: ["SUCCESS", "NOT_FOUND", "ERROR"],
      };
    case "ARCHIVE_FILE":
      return {
        primary: `Archive ${compactPreviewText(utility.path, "file path not set")}`,
        secondary: utility.outputPath
          ? `To ${utility.outputPath}`
          : `Root: ${compactPreviewText(utility.rootPath, ".machdoch/ralph/archive")}`,
        chips: ["SUCCESS", "NOT_FOUND", "ERROR"],
      };
    case "LOOP_COUNTER":
      return {
        primary: `Counter ${compactPreviewText(utility.counterName, "loop")}`,
        secondary: `State: ${compactPreviewText(utility.path, ".machdoch/ralph/counters.json")}`,
        chips: [
          `limit ${utility.maxAttempts ?? "none"}`,
          utility.reset ? "reset" : "increment",
        ],
      };
    case "PROMPT_JSON":
      return {
        primary: "Prompt for schema JSON",
        secondary: compactPreviewText(utility.prompt, "Prompt not set"),
        chips: [
          utility.schema === undefined ? "no schema" : "schema",
          `tries ${utility.maxAttempts ?? 2}`,
        ],
      };
    case "VALIDATOR_JSON":
      return {
        primary: "Validate with schema JSON",
        secondary: compactPreviewText(utility.prompt, "Prompt not set"),
        chips: ["DONE", "CONTINUE", "RETRY", "ERROR"],
      };
    case "SELECT_JSON_TASK":
      return {
        primary: `Select task from ${compactPreviewText(utility.path, "file path not set")}`,
        secondary: `Path: ${compactPreviewText(utility.jsonPath, "tasks")}`,
        chips: [utility.strategy ?? "start-to-end", "SELECTED", "EMPTY"],
      };
    case "MARK_JSON_TASK":
      return {
        primary: `Mark task in ${compactPreviewText(utility.path, "file path not set")}`,
        secondary: compactPreviewText(
          utility.taskId,
          "Uses selected/in-progress task",
        ),
        chips: [utility.status ?? utility.result ?? "done"],
      };
    case "SCAN_SCOPE_EVIDENCE":
      return {
        primary: `Scan scopes under ${compactPreviewText(utility.rootPath, ".")}`,
        secondary: compactPreviewText(
          utility.excludePaths,
          "Uses default repository excludes.",
        ),
        chips: [
          `depth ${utility.maxDepth ?? 4}`,
          `max ${utility.maxResults ?? 200}`,
        ],
      };
    case "UPDATE_SCOPE_REGISTRY":
      return {
        primary: `Update ${compactPreviewText(utility.registryPath ?? utility.path, "default registry")}`,
        secondary: `Flow: ${compactPreviewText(utility.flowAlias, "ralph-flow")}`,
        chips: [utility.strategy ?? "round-robin", "JSON"],
      };
    case "SELECT_SCOPE":
      return {
        primary: `Select scope from ${compactPreviewText(utility.registryPath ?? utility.path, "default registry")}`,
        secondary: `Strategy: ${utility.strategy ?? "round-robin"}`,
        chips: ["SELECTED", "EMPTY", "ERROR"],
      };
    case "MARK_SCOPE_RESULT":
      return {
        primary: `Mark ${compactPreviewText(utility.scopeId, "current scope")}`,
        secondary: compactPreviewText(utility.result, "Uses previous output"),
        chips: ["SUCCESS", "NOT_FOUND", "ERROR"],
      };
    case "CHANGE_SCOPE_GUARD":
      return {
        primary: "Guard changed files against scope",
        secondary: compactPreviewText(
          utility.input,
          "Uses previous result or selected scope",
        ),
        chips: ["IN_SCOPE", "OUT_OF_SCOPE", "EMPTY"],
      };
    case "SEARCH_FILES":
      return {
        primary: utility.glob
          ? `Glob ${utility.glob}`
          : `Find ${compactPreviewText(utility.pattern, "pattern not set")}`,
        secondary: `Root: ${compactPreviewText(utility.rootPath, ".")}`,
        chips: utility.maxResults ? [`max ${utility.maxResults}`] : [],
      };
    case "GIT_STATUS":
      return {
        primary: "git status --short",
        secondary: `Repository: ${compactPreviewText(utility.cwd, ".")}`,
        chips: [],
      };
    case "GIT_SNAPSHOT":
      return {
        primary: "Capture git snapshot",
        secondary: `Repository: ${compactPreviewText(utility.cwd, ".")}`,
        chips: utility.outputPath ? [utility.outputPath] : [],
      };
    case "GIT_DIFF_SUMMARY":
      return {
        primary: "Summarize git diff",
        secondary: `Repository: ${compactPreviewText(utility.cwd, ".")}`,
        chips: utility.outputPath ? [utility.outputPath] : [],
      };
    case "DETECT_PROJECT_COMMANDS":
      return {
        primary: `Detect commands in ${compactPreviewText(utility.rootPath ?? utility.cwd, ".")}`,
        secondary: "Infers package/test/build validation commands.",
        chips: utility.outputPath ? [utility.outputPath] : [],
      };
    case "SET_VARIABLE":
      return {
        primary: `Set ${compactPreviewText(utility.variableName, "variable name")}`,
        secondary: compactPreviewText(utility.value, "Value not set"),
        chips: [],
      };
    case "TRANSFORM_JSON":
      return {
        primary: "Transform JSON",
        secondary: compactPreviewText(utility.expression, "Expression not set"),
        chips: utility.input ? [`input ${utility.input}`] : [],
      };
    case "VALIDATE_JSON":
      return {
        primary: "Validate JSON schema",
        secondary:
          utility.schema === undefined ? "Schema not set" : "Schema configured",
        chips: utility.input ? [`input ${utility.input}`] : [],
      };
    case "FINAL_REPORT":
      return {
        primary: "Write final run report",
        secondary: compactPreviewText(
          utility.path ?? utility.outputPath,
          "No artifact path set",
        ),
        chips: [
          ...(utility.path ? ["JSON"] : []),
          ...(utility.outputPath ?? utility.markdownPath ? ["Markdown"] : []),
        ],
      };
    case "NOTIFY":
      return {
        primary: compactPreviewText(utility.message, "Notification message not set"),
        secondary: "Shows an execution notification.",
        chips: [],
      };
  }
};

export const getBlockSettingsPreviewChips = (
  settings: RalphBlockSettings | undefined,
): string[] => {
  const chips: string[] = [];

  if (
    settings?.provider &&
    settings.provider !== "default" &&
    settings.provider !== "unconfigured"
  ) {
    chips.push(getProviderLabel(settings.provider));
  }

  if (settings?.model && settings.model !== "default") {
    chips.push(settings.model);
  }

  if (settings?.reasoning && settings.reasoning !== "default") {
    chips.push(`${REASONING_LABELS[settings.reasoning]} reasoning`);
  }

  if (settings?.webAccess === false) {
    chips.push("no web");
  }

  if (settings?.fileAccess === false) {
    chips.push("no files");
  }

  const attachments = settings?.attachments?.length ?? 0;
  if (attachments > 0) {
    chips.push(`${attachments} attachment${attachments === 1 ? "" : "s"}`);
  }

  return chips;
};

export const getBlockNodePreview = (block: RalphFlowBlock): RalphNodePreview => {
  if (block.type === "UTILITY") {
    return getUtilityNodePreview(block.utility);
  }

  if (block.type === "START") {
    return {
      primary: "Start execution",
      secondary: "Entry point for this flow.",
      chips: ["single start"],
    };
  }

  if (block.type === "PACK") {
    return {
      primary:
        block.packIds.length > 0
          ? block.packIds.join(", ")
          : "No packs selected",
      secondary: titleFromId(block.propagationMode ?? "nextBlockOnly"),
      chips: [],
    };
  }

  if (block.type === "ASK_USER") {
    const mode = block.mode ?? "missingOnly";

    return {
      primary: compactPreviewText(block.prompt, "Ask user"),
      secondary: `${block.fields.length} field${block.fields.length === 1 ? "" : "s"}`,
      chips: [
        mode === "missingOnly"
          ? "missing only"
          : mode === "alwaysAsk"
            ? "always ask"
            : "confirm only",
        "SUCCESS",
        "CANCELLED",
        "TIMEOUT",
        "ERROR",
        ...getBlockSettingsPreviewChips(block.settings),
      ],
    };
  }

  if (block.type === "INTERVIEW") {
    return {
      primary: compactPreviewText(block.prompt, "AI-led interview"),
      secondary: block.completionCriteria
        ? compactPreviewText(block.completionCriteria, "Completion criteria")
        : "Asks AI-generated follow-up questions.",
      chips: [
        `${block.questionsPerTurn ?? 3}/turn`,
        `${block.maxTurns ?? 5} turns`,
        "DONE",
        "INCOMPLETE",
        ...getBlockSettingsPreviewChips(block.settings),
      ],
    };
  }

  if (block.type === "END") {
    return {
      primary: `${titleFromId(block.status ?? "success")} end`,
      secondary: "Stops the current flow run.",
      chips: [],
    };
  }

  if (block.type === "NOTE") {
    return {
      primary: compactPreviewText(block.text, "Empty note"),
      secondary: block.pinnedBlockIds?.length
        ? `Pinned to ${block.pinnedBlockIds.length} block(s)`
        : "Canvas annotation",
      chips: [block.tone ?? "slate", ...(block.tags ?? [])],
    };
  }

  if (block.type === "GROUP") {
    return {
      primary: compactPreviewText(block.description, "Visual group"),
      secondary: `${block.childBlockIds.length} child block(s)`,
      chips: [
        block.tone ?? "slate",
        block.collapsed ? "collapsed" : "expanded",
        block.layoutMode ?? "freeform",
      ],
    };
  }

  const promptText = getPromptLikeText(block);

  if (block.type === "VALIDATOR") {
    return {
      primary: compactPreviewText(promptText, block.id),
      secondary: `Scope: ${titleFromId(block.validationScope?.mode ?? "sinceLastValidator")}`,
      chips: ["DONE", "CONTINUE", "RETRY", "ERROR", ...getBlockSettingsPreviewChips(block.settings)],
    };
  }

  if (block.type === "DECISION") {
    return {
      primary: compactPreviewText(promptText, block.id),
      secondary: "Routes by decision label.",
      chips: [...block.labels, "ERROR", ...getBlockSettingsPreviewChips(block.settings)],
    };
  }

  if (block.type === "MCP_TOOL") {
    return {
      primary: compactPreviewText(promptText, "MCP tool not selected"),
      secondary: "Calls an MCP server tool.",
      chips: block.arguments ? ["arguments"] : [],
    };
  }

  if (block.type === "MCP_RESOURCE") {
    return {
      primary: compactPreviewText(promptText, "MCP resource not selected"),
      secondary: compactPreviewText(block.serverId, "Server not set"),
      chips: [],
    };
  }

  if (block.type === "MCP_PROMPT") {
    return {
      primary: compactPreviewText(promptText, "MCP prompt not selected"),
      secondary: "Fetches a reusable MCP prompt.",
      chips: block.arguments ? ["arguments"] : [],
    };
  }

  if (block.type === "MEDIA_FLOW") {
    return {
      primary: compactPreviewText(promptText, "Media flow not pinned"),
      secondary:
        block.runPolicy === "submit-and-continue"
          ? "Submits a detached durable Media Studio run."
          : "Waits for durable Media Studio outputs.",
      chips: [
        block.runPolicy === "wait" ? "wait" : "detached",
        block.approvalPolicy === "always-review-preflight"
          ? "preflight review"
          : "workspace approval",
        `${Object.keys(block.inputBindings).length} in`,
        `${Object.keys(block.outputBindings).length} out`,
      ],
    };
  }

  return {
    primary: compactPreviewText(promptText, block.id),
    chips: getBlockSettingsPreviewChips(block.settings),
  };
};
