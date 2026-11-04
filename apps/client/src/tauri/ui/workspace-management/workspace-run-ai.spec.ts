import type { WorkspaceRunConfigurationDocument } from "../../../shared/workspace-run.js";
import {
  generateWorkspaceRunDetection,
  readWorkspaceRunDetectionResponse,
  validateWorkspaceRunDetections,
} from "./workspace-run-ai";

const internalTask = vi.hoisted(() => ({
  loadInternalTaskModelSelection: vi.fn(),
}));
const runtime = vi.hoisted(() => ({
  runWorkspaceRunDetection: vi.fn(),
}));

vi.mock("../internal-task-model", () => internalTask);
vi.mock("../runtime", () => runtime);

const document: WorkspaceRunConfigurationDocument = {
  schemaVersion: 2,
  inputs: [],
  configurations: [
    {
      id: "server",
      name: "Server",
      kind: "task",
      primary: true,
      runType: "service",
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

const detection = {
  configurationId: "server",
  confidence: "high" as const,
  evidence: ["apps/server/package.json defines the dev script."],
  uncertainFields: ["ports"],
};

describe("workspace run AI detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the detection response and rejects malformed metadata", () => {
    const result = readWorkspaceRunDetectionResponse({
      document,
      detections: [detection],
    });

    expect(JSON.parse(result.documentJson)).toEqual(document);
    expect(result.detections).toEqual([detection]);
    expect(() => readWorkspaceRunDetectionResponse({ detections: [] })).toThrow(
      "configuration document",
    );
    expect(() =>
      readWorkspaceRunDetectionResponse({
        document,
        detections: [{ ...detection, confidence: "low" }],
      }),
    ).toThrow("invalid detection metadata");
  });

  it("requires detection metadata to match every generated configuration", () => {
    expect(() =>
      validateWorkspaceRunDetections(document, [
        { ...detection, configurationId: "other" },
      ]),
    ).toThrow("does not match");
  });

  it("requires one primary configuration in generated documents", () => {
    const withoutPrimary = {
      ...document,
      configurations: document.configurations.map((configuration) => ({
        ...configuration,
        primary: false,
      })),
    };

    expect(() =>
      validateWorkspaceRunDetections(withoutPrimary, [detection]),
    ).toThrow("exactly one primary");
  });

  it("runs a single detection command with the configured internal model", async () => {
    internalTask.loadInternalTaskModelSelection.mockResolvedValue({
      provider: "openai",
      model: "gpt-5.4-mini",
      reasoning: "low",
    });
    runtime.runWorkspaceRunDetection.mockResolvedValue({
      document,
      detections: [detection],
    });

    const result = await generateWorkspaceRunDetection("C:/active-workspace");

    expect(runtime.runWorkspaceRunDetection).toHaveBeenCalledWith(
      "C:/active-workspace",
    );
    expect(result.detections).toEqual([detection]);
  });

  it("asks for an internal model before detecting", async () => {
    internalTask.loadInternalTaskModelSelection.mockResolvedValue(null);

    await expect(
      generateWorkspaceRunDetection("C:/active-workspace"),
    ).rejects.toThrow("Choose an internal task model");
    expect(runtime.runWorkspaceRunDetection).not.toHaveBeenCalled();
  });
});
