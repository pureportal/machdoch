import {
  applyMcpLifecycleCleanupPlan,
  createMcpLifecycleCleanupPlan,
  createMcpUsageEventFromHookPayload,
  getUserMcpLifecyclePath,
  loadMcpLifecycleState,
  normalizeMcpLifecycleAgent,
  normalizeMcpLifecyclePhase,
  recordMcpUsageEvent,
  type McpLifecycleCleanupApplyResult,
  type McpLifecycleCleanupPlan,
  type McpLifecycleRecord,
} from "../../core/mcp/lifecycle.js";
import type { McpCliOptions, ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";

const fail = (message: string): never => {
  throw new Error(message);
};

const printJson = (value: unknown): void => {
  writeStdoutLine(JSON.stringify(value, null, 2));
};

const readStdinText = async (): Promise<string> => {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  return Buffer.concat(chunks).toString("utf8");
};

export const summarizeLifecycleRecord = (
  record: McpLifecycleRecord,
): Record<string, unknown> => {
  return {
    managedId: record.managedId,
    sourceServerId: record.sourceServerId ?? null,
    agent: record.agent,
    state: record.state,
    protected: record.protected === true,
    transportType: record.transportType ?? null,
    workspaceRoot: record.workspaceRoot ?? null,
    addedAt: record.addedAt,
    updatedAt: record.updatedAt,
    lastObservedAt: record.lastObservedAt ?? null,
    lastInvokedAt: record.lastInvokedAt ?? null,
    lastCacheHitAt: record.lastCacheHitAt ?? null,
    lastRemoteExecutedAt: record.lastRemoteExecutedAt ?? null,
    lastSucceededAt: record.lastSucceededAt ?? null,
    lastFailedAt: record.lastFailedAt ?? null,
    usageCount: record.usageCount,
    eventCount: record.eventCount,
    remoteExecutionCount: record.remoteExecutionCount ?? 0,
    cacheHitCount: record.cacheHitCount ?? 0,
    failureCount: record.failureCount ?? 0,
    cleanup: record.cleanup ?? null,
  };
};

const summarizeLifecycleUsage = async (): Promise<Record<string, unknown>> => {
  const state = await loadMcpLifecycleState();
  const records = Object.values(state.records)
    .sort((left, right) => left.managedId.localeCompare(right.managedId))
    .map(summarizeLifecycleRecord);

  return {
    lifecyclePath: getUserMcpLifecyclePath(),
    updatedAt: state.updatedAt,
    records,
  };
};

const printLifecycleUsageLines = async (): Promise<void> => {
  const state = await loadMcpLifecycleState();
  const records = Object.values(state.records).sort((left, right) =>
    left.managedId.localeCompare(right.managedId),
  );

  writeStdoutLine(`mcp lifecycle records: ${records.length}`);
  writeStdoutLine(`path: ${getUserMcpLifecyclePath()}`);

  for (const record of records) {
    writeStdoutLine(
      `- ${record.managedId} ${record.state} agent=${record.agent} used=${record.lastObservedAt ?? "never"} usage=${record.usageCount} events=${record.eventCount}`,
    );
  }
};

const printCleanupPlanLines = (
  plan: McpLifecycleCleanupPlan,
  applyResult?: McpLifecycleCleanupApplyResult,
): void => {
  writeStdoutLine(`mcp cleanup candidates: ${plan.candidates.length}`);
  writeStdoutLine(
    `policy: unused=${plan.policy.unusedDays}d never-used=${plan.policy.neverUsedDays}d`,
  );

  for (const candidate of plan.candidates) {
    writeStdoutLine(
      `- ${candidate.managedId} ${candidate.reason} action=${candidate.recommendedAction}`,
    );
  }

  if (applyResult) {
    writeStdoutLine(`marked stale: ${applyResult.markedCount}`);
    writeStdoutLine(`path: ${applyResult.statePath}`);
  }
};

export const printMcpLifecycleUsage = async (
  args: ParsedCliArgs,
): Promise<void> => {
  if (args.json) {
    printJson({
      workspaceRoot: args.workspaceRoot,
      ...(await summarizeLifecycleUsage()),
    });
    return;
  }

  await printLifecycleUsageLines();
};

export const recordMcpLifecycleHook = async (
  args: ParsedCliArgs,
  options: McpCliOptions,
): Promise<void> => {
  const agent = options.agent
    ? normalizeMcpLifecycleAgent(options.agent) ??
      fail(
        "Expected --agent to be one of machdoch, codex-cli, claude-cli, copilot-cli, openai-api, or anthropic-api.",
      )
    : "codex-cli";
  const phase = options.phase
    ? normalizeMcpLifecyclePhase(options.phase) ??
      fail(
        "Expected --phase to be one of invoked, cache-hit, remote-started, succeeded, or failed.",
      )
    : undefined;
  const payloadText = (await readStdinText()).trim();

  if (!payloadText) {
    fail("Expected a JSON MCP lifecycle hook payload on stdin.");
  }

  const payload = JSON.parse(payloadText) as unknown;
  const event = createMcpUsageEventFromHookPayload(payload, {
    agent,
    ...(phase ? { phase } : {}),
    workspaceRoot: args.workspaceRoot,
  });

  if (!event) {
    if (args.json) {
      printJson({
        workspaceRoot: args.workspaceRoot,
        recorded: false,
        reason: "not-managed-mcp-tool",
      });
    }
    return;
  }

  const record = await recordMcpUsageEvent(event);

  if (args.json) {
    printJson({
      workspaceRoot: args.workspaceRoot,
      recorded: true,
      event,
      record: summarizeLifecycleRecord(record),
    });
  }
};

export const printMcpLifecycleCleanup = async (
  args: ParsedCliArgs,
  options: McpCliOptions,
): Promise<void> => {
  const plan = await createMcpLifecycleCleanupPlan({
    ...(options.unusedDays !== undefined ? { unusedDays: options.unusedDays } : {}),
    ...(options.neverUsedDays !== undefined
      ? { neverUsedDays: options.neverUsedDays }
      : {}),
  });
  const applyResult = options.apply
    ? await applyMcpLifecycleCleanupPlan(plan)
    : undefined;

  if (args.json) {
    printJson({
      workspaceRoot: args.workspaceRoot,
      plan,
      applied: applyResult ?? null,
    });
    return;
  }

  printCleanupPlanLines(plan, applyResult);
};
