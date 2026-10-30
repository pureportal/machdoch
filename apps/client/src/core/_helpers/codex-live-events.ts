import { isAbsolute, relative } from "node:path";
import type { AgentModelStreamUsage } from "@machdoch/model-runtime/types";
import type {
  AgentLiveFileChange,
  AgentLiveLimit,
} from "@machdoch/fleet-protocol/task-thinking";
import type { AgentLiveTracker } from "./agent-live-tracker.js";
import {
  isRecord,
  readNumber,
  readString,
  toEpochMs,
} from "./agent-interactive-session.js";

const windowLabel = (minutes: number | undefined, fallback: string): string => {
  if (!minutes) return fallback;
  if (minutes % 10_080 === 0) return minutes === 10_080 ? "Weekly limit" : `${minutes / 10_080}-week limit`;
  if (minutes % 1_440 === 0) return minutes === 1_440 ? "Daily limit" : `${minutes / 1_440}-day limit`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour limit`;
  return `${minutes}-minute limit`;
};

/** Shows the command Codex ran without the shell it was wrapped in. */
export const describeShellCommand = (command: string): string => {
  const match =
    /^\s*"?(?:[^"]*[\\/])?(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+|-NonInteractive\s+)*(?:-Command|-lc|-c|\/c)\s+([\s\S]+)$/iu.exec(
      command,
    );
  const inner = match?.[1]?.trim();
  if (!inner) return command.trim();
  const quote = inner[0];
  return (quote === "'" || quote === '"') && inner.endsWith(quote) && inner.length > 1
    ? inner.slice(1, -1)
    : inner;
};

/** Counts added and removed lines per file in a unified diff. */
export const summarizeUnifiedDiff = (diff: string): AgentLiveFileChange[] => {
  const files = new Map<string, AgentLiveFileChange>();
  let current: AgentLiveFileChange | undefined;
  for (const line of diff.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      // Git quotes paths that contain spaces or special characters.
      const match = / "?b\/(.+?)"?$/u.exec(line);
      current = match?.[1]
        ? { path: match[1], kind: "update", additions: 0, deletions: 0 }
        : undefined;
      if (current) files.set(current.path, current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) current.kind = "add";
    else if (line.startsWith("deleted file mode")) current.kind = "delete";
    else if (line.startsWith("+++") || line.startsWith("---")) continue;
    else if (line.startsWith("+")) current.additions = (current.additions ?? 0) + 1;
    else if (line.startsWith("-")) current.deletions = (current.deletions ?? 0) + 1;
  }
  return [...files.values()];
};

/** Turns what `codex app-server` reports into live run details. */
export class CodexLiveEventReader {
  private usage: AgentModelStreamUsage | undefined;

  constructor(
    private readonly live: AgentLiveTracker,
    private readonly cwd: string | undefined,
  ) {}

  getUsage(): AgentModelStreamUsage | undefined {
    return this.usage;
  }

  notification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan) ? params.plan.filter(isRecord) : [];
        this.live.setPlan(
          plan.map((step) => ({
            text: readString(step, "step") ?? "",
            status:
              step.status === "completed"
                ? "completed"
                : step.status === "inProgress"
                  ? "in_progress"
                  : "pending",
          })),
        );
        return;
      }
      case "turn/diff/updated": {
        const diff = readString(params, "diff");
        if (diff) this.live.setFileChanges(summarizeUnifiedDiff(diff));
        return;
      }
      case "thread/tokenUsage/updated":
        this.applyTokenUsage(params.tokenUsage);
        return;
      case "account/rateLimits/updated":
        this.applyRateLimits(params.rateLimits);
        return;
      case "model/rerouted":
        this.live.addNotice(
          "info",
          `Codex switched to ${readString(params, "toModel") ?? readString(params, "model") ?? "another model"}.`,
        );
        return;
      case "item/started":
        this.trackItem(params.item, "running");
        return;
      case "item/completed":
        this.trackItem(params.item, "done");
        return;
      case "error":
        if (params.willRetry === true)
          this.live.addNotice("warning", "Codex is retrying after a temporary error.");
        return;
      default:
        return;
    }
  }

  applyRateLimits(value: unknown): void {
    if (!isRecord(value)) return;
    const limits: AgentLiveLimit[] = [];
    const reached = readString(value, "rateLimitReachedType");
    for (const key of ["primary", "secondary"] as const) {
      const window = isRecord(value[key]) ? value[key] : undefined;
      if (!window) continue;
      const usedPercent = readNumber(window, "usedPercent");
      if (usedPercent === undefined) continue;
      const minutes = readNumber(window, "windowDurationMins");
      const resetsAt = toEpochMs(window.resetsAt);
      limits.push({
        id: `codex-${key}`,
        label: windowLabel(minutes, key === "primary" ? "Short-term limit" : "Weekly limit"),
        usedPercent,
        ...(resetsAt ? { resetsAt } : {}),
        ...(usedPercent >= 100 || reached === key ? { limited: true } : {}),
      });
    }
    if (limits.length > 0) this.live.setLimits(limits);
  }

  private trackItem(value: unknown, phase: "running" | "done"): void {
    if (!isRecord(value)) return;
    const id = readString(value, "id");
    const type = readString(value, "type");
    if (!id) return;
    if (type === "commandExecution") {
      const status = readString(value, "status");
      this.live.upsertTask({
        id,
        kind: "shell",
        description: describeShellCommand(readString(value, "command") ?? "Shell command"),
        status:
          phase === "running" || status === "inProgress"
            ? "running"
            : status === "failed" || status === "declined"
              ? "failed"
              : "completed",
        background: false,
        canStop: false,
        ...(phase === "running" ? { startedAt: Date.now() } : {}),
      });
    } else if (type === "collabAgentToolCall" || type === "subAgentActivity") {
      this.live.upsertTask({
        id,
        kind: "agent",
        description:
          readString(value, "prompt") ?? readString(value, "description") ?? "Sub-agent",
        status: phase === "running" ? "running" : "completed",
        background: false,
        canStop: false,
      });
    } else if (type === "fileChange" && phase === "done") {
      const changes = Array.isArray(value.changes) ? value.changes.filter(isRecord) : [];
      this.live.setFileChanges(
        changes.flatMap((change) => {
          const path = this.toWorkspacePath(readString(change, "path"));
          if (!path) return [];
          const kind = isRecord(change.kind)
            ? readString(change.kind, "type")
            : readString(change, "kind");
          return [
            {
              path,
              kind: kind === "add" ? "add" : kind === "delete" ? "delete" : "update",
            } satisfies AgentLiveFileChange,
          ];
        }),
      );
    }
  }

  /** Matches the workspace-relative paths that Codex diffs report. */
  private toWorkspacePath(path: string | undefined): string | undefined {
    if (!path) return undefined;
    const relativePath = this.cwd && isAbsolute(path) ? relative(this.cwd, path) : path;
    const shown = relativePath && !relativePath.startsWith("..") ? relativePath : path;
    return shown.replace(/\\/gu, "/");
  }

  private applyTokenUsage(value: unknown): void {
    if (!isRecord(value)) return;
    const total = isRecord(value.total) ? value.total : {};
    const last = isRecord(value.last) ? value.last : {};
    const window = readNumber(value, "modelContextWindow");
    const input = readNumber(total, "inputTokens");
    const outputTokens = readNumber(total, "outputTokens");
    const cached = readNumber(total, "cachedInputTokens");
    const reasoning = readNumber(total, "reasoningOutputTokens");
    if (input !== undefined && outputTokens !== undefined) {
      this.usage = {
        inputTokens: input,
        outputTokens,
        totalTokens: readNumber(total, "totalTokens") ?? input + outputTokens,
        ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
        ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
      };
    }
    const contextUsed = readNumber(last, "inputTokens");
    this.live.setUsage({
      ...(input !== undefined ? { inputTokens: input } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
      ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
      ...(contextUsed !== undefined ? { contextUsedTokens: contextUsed } : {}),
      ...(window ? { contextWindowTokens: window } : {}),
    });
  }
}
