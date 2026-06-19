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
    case "INPUT":
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
          `${utility.viewports?.length ?? 3} viewport(s)`,
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

  if (settings?.provider && settings.provider !== "default") {
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
      secondary: titleFromId(block.propagationMode),
      chips: [],
    };
  }

  if (block.type === "INPUT") {
    return {
      primary: compactPreviewText(block.prompt, "Collect human input"),
      secondary: `${block.fields.length} field${block.fields.length === 1 ? "" : "s"}`,
      chips: [
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

  return {
    primary: compactPreviewText(promptText, block.id),
    chips: getBlockSettingsPreviewChips(block.settings),
  };
};
