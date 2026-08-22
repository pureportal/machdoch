import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRunConfigurationDocument } from "../../../shared/workspace-run.js";

const runtime = vi.hoisted(() => ({
  precheckWorkspaceRunConfigurationJson: vi.fn(),
}));
const ai = vi.hoisted(() => ({
  generateWorkspaceRunDetection: vi.fn(),
  validateWorkspaceRunDetections: vi.fn(),
}));

vi.mock("../runtime", () => runtime);
vi.mock("./workspace-run-ai", () => ai);

import {
  getWorkspaceRunDetectionState,
  startWorkspaceRunDetection,
  subscribeWorkspaceRunDetection,
} from "./workspace-run-detection-state";

const document: WorkspaceRunConfigurationDocument = {
  schemaVersion: 1,
  primaryConfigurationId: null,
  configurations: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  runtime.precheckWorkspaceRunConfigurationJson.mockResolvedValue(document);
  ai.generateWorkspaceRunDetection.mockResolvedValue({
    documentJson: JSON.stringify(document),
    detections: [],
  });
});

describe("workspace run detection lifecycle", () => {
  it("releases completed results when the last workspace subscriber leaves", async () => {
    const workspaceRoot = "C:/workspace/completed";
    const unsubscribe = subscribeWorkspaceRunDetection(workspaceRoot, vi.fn());

    await startWorkspaceRunDetection(workspaceRoot);
    expect(getWorkspaceRunDetectionState(workspaceRoot).phase).toBe(
      "complete",
    );

    unsubscribe();

    expect(getWorkspaceRunDetectionState(workspaceRoot)).toEqual({
      phase: "idle",
      revision: 0,
      result: null,
      error: null,
    });
  });

  it("abandons pending work before it starts another native operation", async () => {
    const workspaceRoot = "C:/workspace/pending";
    let resolveGeneration: (value: unknown) => void = () => undefined;
    ai.generateWorkspaceRunDetection.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );
    const unsubscribe = subscribeWorkspaceRunDetection(workspaceRoot, vi.fn());
    const operation = startWorkspaceRunDetection(workspaceRoot);

    unsubscribe();
    resolveGeneration({
      documentJson: JSON.stringify(document),
      detections: [],
    });
    await operation;

    expect(runtime.precheckWorkspaceRunConfigurationJson).not.toHaveBeenCalled();
    expect(getWorkspaceRunDetectionState(workspaceRoot).phase).toBe("idle");
  });

  it("keeps retained detection state stable across repeated workspace cycles", async () => {
    for (let index = 0; index < 30; index += 1) {
      const workspaceRoot = `C:/workspace/cycle-${index}`;
      const unsubscribe = subscribeWorkspaceRunDetection(
        workspaceRoot,
        vi.fn(),
      );
      await startWorkspaceRunDetection(workspaceRoot);
      unsubscribe();
      expect(getWorkspaceRunDetectionState(workspaceRoot).phase).toBe("idle");
    }
  });
});
