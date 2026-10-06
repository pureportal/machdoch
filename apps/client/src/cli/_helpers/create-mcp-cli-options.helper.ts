import { normalizeOptionalString } from "../../helpers/normalize-optional-string.helper.js";
import type { CliTokenValues } from "./cli-token-options.js";
import {
  MCP_ACTIONS,
  MCP_ACTIONS_REQUIRING_SERVER,
  MCP_ACTIONS_REQUIRING_TARGET,
} from "./cli-args-constants.js";
import type { McpCliAction, McpCliOptions } from "./cli-args-types.js";
import {
  fail,
  parseOptionalPositiveInteger,
} from "./parse-cli-primitive.helper.js";

export const createMcpCliOptions = ({
  rest,
  quickRunRequested,
  rawTask,
  values,
}: {
  rest: string[];
  quickRunRequested: boolean;
  rawTask: string | undefined;
  values:
    | Partial<
        Pick<
          CliTokenValues,
          | "arguments-json"
          | "include-disabled"
          | "agent"
          | "phase"
          | "unused-days"
          | "never-used-days"
          | "apply"
          | "scope"
        >
      >
    | undefined;
}): McpCliOptions => {
  const rawMcpArgumentsJson = normalizeOptionalString(
    values?.["arguments-json"],
  );
  const includeDisabledMcp = values?.["include-disabled"] === true;
  const rawMcpAgent = normalizeOptionalString(values?.agent);
  const rawMcpPhase = normalizeOptionalString(values?.phase);
  const rawMcpUnusedDays = normalizeOptionalString(values?.["unused-days"]);
  const rawMcpNeverUsedDays = normalizeOptionalString(
    values?.["never-used-days"],
  );
  const applyMcpCleanup = values?.apply === true;
  const rawMcpScope = normalizeOptionalString(values?.scope);
  if (quickRunRequested || rawTask) {
    fail("`machdoch mcp` cannot be combined with --quick or --task.");
  }

  const [rawAction, rawServerId, rawTarget, ...extraPositionals] = rest;
  const actionText = normalizeOptionalString(rawAction) ?? "servers";

  if (!MCP_ACTIONS.has(actionText as McpCliAction)) {
    fail(
      `Expected \`machdoch mcp\` action to be one of ${Array.from(
        MCP_ACTIONS,
      ).join(", ")}.`,
    );
  }

  const action = actionText as McpCliAction;
  const serverId = normalizeOptionalString(rawServerId);
  const target = normalizeOptionalString(rawTarget);

  if (extraPositionals.length > 0) {
    fail(
      `Command \`mcp ${action}\` does not accept positional arguments: ${extraPositionals.join(" ")}`,
    );
  }

  if (MCP_ACTIONS_REQUIRING_SERVER.has(action) && !serverId) {
    fail(`Expected a server id after \`machdoch mcp ${action}\`.`);
  }

  if (MCP_ACTIONS_REQUIRING_TARGET.has(action) && !target) {
    fail(
      `Expected a target after \`machdoch mcp ${action} ${serverId ?? ""}\`.`,
    );
  }

  if (!MCP_ACTIONS_REQUIRING_SERVER.has(action) && serverId) {
    fail(`Command \`mcp ${action}\` does not accept a server id.`);
  }

  if (!MCP_ACTIONS_REQUIRING_TARGET.has(action) && target) {
    fail(`Command \`mcp ${action}\` does not accept a target.`);
  }

  if (
    rawMcpArgumentsJson &&
    action !== "call-tool" &&
    action !== "get-prompt"
  ) {
    fail(
      "--arguments-json is only valid for `machdoch mcp call-tool` or `machdoch mcp get-prompt`.",
    );
  }

  if (includeDisabledMcp && action !== "servers") {
    fail("--include-disabled is only valid for `machdoch mcp servers`.");
  }

  if (rawMcpAgent && action !== "lifecycle-hook") {
    fail("--agent is only valid for `machdoch mcp lifecycle-hook`.");
  }

  if (rawMcpPhase && action !== "lifecycle-hook") {
    fail("--phase is only valid for `machdoch mcp lifecycle-hook`.");
  }

  if (action === "lifecycle-hook" && !rawMcpPhase) {
    fail("--phase is required for `machdoch mcp lifecycle-hook`.");
  }

  if (rawMcpUnusedDays && action !== "cleanup") {
    fail("--unused-days is only valid for `machdoch mcp cleanup`.");
  }

  if (rawMcpNeverUsedDays && action !== "cleanup") {
    fail("--never-used-days is only valid for `machdoch mcp cleanup`.");
  }

  if (applyMcpCleanup && action !== "cleanup") {
    fail("--apply is only valid for `machdoch mcp cleanup`.");
  }

  const acceptsMcpScope =
    action === "proxy" ||
    action === "oauth-authorize" ||
    action === "oauth-start" ||
    action === "oauth-finish";
  if (rawMcpScope && !acceptsMcpScope) {
    fail(
      "--scope is only valid for `machdoch mcp proxy` and MCP OAuth commands.",
    );
  }

  if (rawMcpScope && rawMcpScope !== "user") {
    fail("Expected `machdoch mcp --scope` to be followed by user.");
  }

  const unusedDays =
    action === "cleanup"
      ? parseOptionalPositiveInteger(rawMcpUnusedDays, "--unused-days")
      : undefined;
  const neverUsedDays =
    action === "cleanup"
      ? parseOptionalPositiveInteger(rawMcpNeverUsedDays, "--never-used-days")
      : undefined;

  return {
    action,
    ...(rawMcpScope === "user" ? { scope: rawMcpScope } : {}),
    ...(serverId ? { serverId } : {}),
    ...(target ? { target } : {}),
    ...(rawMcpArgumentsJson ? { argumentsJson: rawMcpArgumentsJson } : {}),
    ...(includeDisabledMcp ? { includeDisabled: true } : {}),
    ...(rawMcpAgent ? { agent: rawMcpAgent } : {}),
    ...(rawMcpPhase ? { phase: rawMcpPhase } : {}),
    ...(unusedDays !== undefined ? { unusedDays } : {}),
    ...(neverUsedDays !== undefined ? { neverUsedDays } : {}),
    ...(applyMcpCleanup ? { apply: true } : {}),
  };
};

export const validateMcpCommand = (
  command: string,
  applyCleanup: boolean,
): void => {
  if (command !== "mcp" && applyCleanup) {
    fail("--apply is only valid for `machdoch mcp cleanup`.");
  }
};
