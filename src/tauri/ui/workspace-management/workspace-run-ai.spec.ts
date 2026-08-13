import type { WorkspaceRunConfigurationDocument } from "../../../shared/workspace-run.js";
import {
  createWorkspaceRunDetectionTask,
  extractWorkspaceRunDetection,
  generateWorkspaceRunDetection,
  validateWorkspaceRunDetections,
} from "./workspace-run-ai";

const runtime = vi.hoisted(() => ({
  runDesktopTask: vi.fn(),
}));

vi.mock("../runtime", () => runtime);

const document: WorkspaceRunConfigurationDocument = {
  schemaVersion: 1,
  primaryConfigurationId: "server",
  configurations: [
    {
      id: "server",
      name: "Server",
      kind: "task",
      command: "pnpm run dev",
      workingDirectory: "apps/server",
      environment: {},
      hotReload: true,
      ports: [],
      urls: [],
      restartPolicy: {
        onCrash: false,
        maxRestarts: 5,
        windowMs: 60_000,
        backoffMs: 1_000,
        maxBackoffMs: 30_000,
      },
    },
  ],
};

describe("workspace run AI detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires evidence-based read-only workspace inspection", () => {
    const task = createWorkspaceRunDetectionTask();

    expect(task).toContain("read-only workspace tools");
    expect(task).toContain("Do not execute project commands");
    expect(task).toContain("Do not select from or assume a fixed catalog");
    expect(task).toContain("workingDirectory must be relative");
  });

  it("extracts tagged JSON and rejects malformed output", () => {
    const result = extractWorkspaceRunDetection(
      `<machdoch_workspace_run_detection>${JSON.stringify({
        document,
        detections: [
          {
            configurationId: "server",
            confidence: "high",
            evidence: ["apps/server/package.json defines the dev script."],
            uncertainFields: ["ports"],
          },
        ],
      })}</machdoch_workspace_run_detection>`,
    );

    expect(JSON.parse(result.documentJson)).toEqual(document);
    expect(result.detections[0]?.configurationId).toBe("server");
    expect(() =>
      extractWorkspaceRunDetection(
        "<machdoch_workspace_run_detection>{</machdoch_workspace_run_detection>",
      ),
    ).toThrow("invalid JSON");
  });

  it("requires detection metadata to match every generated configuration", () => {
    expect(() =>
      validateWorkspaceRunDetections(document, [
        {
          configurationId: "other",
          confidence: "medium",
          evidence: [],
          uncertainFields: [],
        },
      ]),
    ).toThrow("does not match");
  });

  it("runs the AI inspection in the active workspace and Ask mode", async () => {
    const response = `<machdoch_workspace_run_detection>${JSON.stringify({
      document,
      detections: [
        {
          configurationId: "server",
          confidence: "high",
          evidence: ["apps/server/package.json"],
          uncertainFields: [],
        },
      ],
    })}</machdoch_workspace_run_detection>`;
    runtime.runDesktopTask.mockResolvedValue({
      execution: {
        task: "detect",
        mode: "ask",
        status: "executed",
        summary: response,
        executedTools: ["files"],
        outputSections: [],
      },
    });

    await generateWorkspaceRunDetection("C:/active-workspace", {
      provider: "openai",
      model: "gpt-5.4",
      reasoning: "high",
      sessionId: "session-1",
    });

    expect(runtime.runDesktopTask).toHaveBeenCalledWith(
      "C:/active-workspace",
      expect.stringContaining("Inspect the active workspace"),
      expect.objectContaining({
        mode: "ask",
        provider: "openai",
        model: "gpt-5.4",
        reasoning: "high",
        sessionId: "session-1",
      }),
    );
  });
});
