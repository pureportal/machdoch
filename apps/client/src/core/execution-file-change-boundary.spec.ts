import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./runtime-contract.generated.ts";
import type { CustomizationDiscoveryResult } from "./types.ts";

const fileChangeCaptureMocks = vi.hoisted(() => ({
  startTaskFileChangeCapture: vi.fn(),
}));

vi.mock("./_helpers/task-file-change-capture.js", () => ({
  startTaskFileChangeCapture: fileChangeCaptureMocks.startTaskFileChangeCapture,
}));

import { createTaskExecutionController } from "./execution.ts";

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(
    join(tmpdir(), "machdoch-execution-file-changes-"),
  );
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

const createConfig = (workspaceRoot: string): RuntimeConfig => ({
  workspaceRoot,
  mode: "machdoch",
  provider: "unconfigured",
  model: "gpt-5.5",
  reasoning: "default",
  contextWindow: "default",
  offline: false,
  compatibility: { discoverGithubCustomizations: false },
  providerAvailability: [],
  webSearch: { activeProvider: "none", providerAvailability: [] },
  reviewModel: { mode: "base" },
  internalTaskModel: {
    provider: "unconfigured",
    model: "gpt-5.5",
    reasoning: "default",
  },
});

const createCustomizations = (
  workspaceRoot: string,
): CustomizationDiscoveryResult => ({
  workspaceRoot,
  prompts: [],
  skills: [],
});

const executeInspection = async (
  workspaceRoot: string,
  captureFileChanges?: boolean,
): Promise<void> => {
  const controller = createTaskExecutionController(
    "Inspect the workspace",
    createConfig(workspaceRoot),
    createCustomizations(workspaceRoot),
    {
      deterministicAction: { kind: "inspect", target: "workspace" },
      ...(captureFileChanges !== undefined ? { captureFileChanges } : {}),
    },
  );

  await controller.execute();
};

afterEach(async () => {
  fileChangeCaptureMocks.startTaskFileChangeCapture.mockReset();
  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("task execution file-change boundary", () => {
  it("does not start repository discovery when workspace tracking is disabled", async () => {
    const fallbackWorkspaceRoot = await createWorkspace();

    await executeInspection(fallbackWorkspaceRoot, false);

    expect(
      fileChangeCaptureMocks.startTaskFileChangeCapture,
    ).not.toHaveBeenCalled();
  });

  it("tracks only the configured workspace root", async () => {
    const workspaceRoot = await createWorkspace();

    await executeInspection(workspaceRoot);

    expect(
      fileChangeCaptureMocks.startTaskFileChangeCapture,
    ).toHaveBeenCalledOnce();
    expect(
      fileChangeCaptureMocks.startTaskFileChangeCapture,
    ).toHaveBeenCalledWith(workspaceRoot);
  });
});
