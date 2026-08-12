import { describe, expect, it } from "vitest";
import type {
  WorkspaceRunConfigurationStatus,
  WorkspaceRunSnapshot,
} from "../../shared/workspace-run.js";
import { serializeWorkspaceRunContext } from "./conversation-prompt-context.js";

const taskStatus = (
  id: string,
  command = "pnpm run dev",
): WorkspaceRunConfigurationStatus => ({
  configuration: {
    id,
    name: id,
    kind: "task",
    command,
    workingDirectory: ".",
    environment: { API_TOKEN: "secret-value" },
    hotReload: true,
    ports: [5173],
    urls: ["http://localhost:5173"],
    restartPolicy: {
      onCrash: true,
      maxRestarts: 5,
      windowMs: 60_000,
      backoffMs: 1_000,
      maxBackoffMs: 30_000,
    },
  },
  state: "running",
  pid: 42,
  startedAt: 1,
  stoppedAt: null,
  exitCode: null,
  restartCount: 0,
  health: {
    state: "failed",
    checkedAt: 1,
    consecutiveFailures: 1,
    message: "request used secret-value",
  },
  recentFailures: [
    { at: 1, kind: "launch", message: "failed with secret-value" },
  ],
  logs: [
    {
      sequence: 1,
      at: 1,
      stream: "stderr",
      line: "server printed secret-value",
    },
  ],
  children: [],
});

describe("workspace run prompt context", () => {
  it("redacts environment values while preserving structured state", () => {
    const serialized = serializeWorkspaceRunContext({
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: "application",
      configurations: [taskStatus("application", "run secret-value")],
    });

    expect(JSON.parse(serialized)).toMatchObject({
      primaryConfigurationId: "application",
      configurations: [
        {
          configuration: {
            id: "application",
            environment: { API_TOKEN: "<redacted>" },
          },
          state: "running",
        },
      ],
    });
    expect(serialized).not.toContain("secret-value");
  });

  it("keeps oversized snapshots bounded and valid JSON", () => {
    const snapshot: WorkspaceRunSnapshot = {
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: "application-0",
      configurations: Array.from({ length: 64 }, (_, index) =>
        taskStatus(`application-${index}`, "x".repeat(8_192)),
      ),
    };

    const serialized = serializeWorkspaceRunContext(snapshot);

    expect(serialized.length).toBeLessThanOrEqual(12_000);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(serialized).not.toContain("secret-value");
  });
});
