// @vitest-environment jsdom

import { createElement } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlow } from "../../../core/__test__/ralph-test-helpers";
import { flowToSummary } from "./_helpers/upsert-flow-summary.helper";
import { RalphFlowEditor } from "./ralph-flow-editor";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";

const mocks = vi.hoisted(() => ({
  listFlows: vi.fn(),
  showFlow: vi.fn(),
  activeTasks: vi.fn(),
  run: vi.fn(),
}));

vi.mock("../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime")>()),
  listRalphFlows: mocks.listFlows,
  showRalphFlow: mocks.showFlow,
  loadActiveDesktopTasks: mocks.activeTasks,
  runRalphFlow: mocks.run,
  listRalphRuns: vi.fn().mockResolvedValue({ runs: [] }),
  listRalphFlowRevisions: vi.fn().mockResolvedValue({ revisions: [] }),
  loadProviderModelCatalog: vi.fn().mockResolvedValue(null),
  subscribeToDesktopTaskProgress: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../settings-transfer", () => ({
  subscribeToSettingsImport: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../lib/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@machdoch/media-studio/tauri/ui/flow/flow-canvas.js", () => ({
  FlowCanvas: () => null,
}));

const flow = createFlow({
  settings: { autonomy: true },
  blocks: [
    { id: "start", type: "START", title: "Start" },
    { id: "end", type: "END", title: "Done", status: "success" },
  ],
  edges: [{ id: "finish", from: "start", fromOutput: "SUCCESS", to: "end" }],
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  mocks.listFlows.mockResolvedValue({
    flows: [flowToSummary(flow, "/repo/flow.json", "workspace")],
  });
  mocks.showFlow.mockResolvedValue({ flow, path: "/repo/flow.json" });
  mocks.activeTasks.mockResolvedValue([
    {
      id: "other-flow-task",
      kind: "ralph",
      workspaceRoot: "/repo",
      arguments: ["run", "other-flow", "--scope", "workspace"],
      startedAt: Date.now(),
    },
  ]);
  mocks.run.mockReset();
  mocks.run.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const openEditor = () =>
  render(
    createElement(TooltipProvider, {
      children: createElement(RalphFlowEditor, {
        workspaceRoot: "/repo",
        initialSelection: { flowId: flow.id, scope: "workspace" },
        runMode: "machdoch",
        generationProvider: "openai",
        generationModel: "test-model",
        runProvider: "openai",
        runModel: "test-model",
      }),
    }),
  );

describe("RALPH concurrent flow launches", () => {
  it("starts an autonomous flow in a separate worktree while another flow is active", async () => {
    openEditor();
    await waitFor(() => expect(mocks.activeTasks).toHaveBeenCalled());
    const runButton = await screen.findByRole("button", {
      name: "Run Ralph flow",
    });
    await waitFor(() =>
      expect((runButton as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(runButton);

    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ name: flow.id, isolated: true }),
      ),
    );
    expect(screen.queryByText("Wait for Other Flow to finish.")).toBeNull();
  });

  it("keeps the workspace lock when separate worktrees are explicitly disabled", async () => {
    openEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    const separateWorktree = await screen.findByRole("checkbox", {
      name: /Separate worktree/u,
    });
    expect((separateWorktree as HTMLInputElement).checked).toBe(true);

    fireEvent.click(separateWorktree);

    await waitFor(() =>
      expect(
        screen
          .getAllByRole("button", { name: "Run Ralph flow" })
          .every((button) => (button as HTMLButtonElement).disabled),
      ).toBe(true),
    );
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("recognizes a restored isolated run as independent of the shared workspace", async () => {
    mocks.activeTasks.mockResolvedValue([
      {
        id: "other-isolated-flow-task",
        kind: "ralph",
        workspaceRoot: "/repo",
        arguments: ["run", "other-flow", "--isolated", "--scope", "workspace"],
        startedAt: Date.now(),
      },
    ]);
    openEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Separate worktree/u }),
    );
    const runButton = screen.getAllByRole("button", {
      name: "Run Ralph flow",
    })[0]!;
    await waitFor(() =>
      expect((runButton as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.click(runButton);

    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith(
        "/repo",
        expect.objectContaining({ name: flow.id, isolated: false }),
      ),
    );
  });
});
