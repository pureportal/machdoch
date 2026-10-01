// @vitest-environment jsdom

import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { createFlow } from "../../../core/__test__/ralph-test-helpers";
import { flowToSummary } from "./_helpers/upsert-flow-summary.helper";
import { RalphFlowEditor } from "./ralph-flow-editor";

const mocks = vi.hoisted(() => ({
  listFlows: vi.fn(),
  showFlow: vi.fn(),
  activeTasks: vi.fn(),
  recentTasks: vi.fn(),
  listRuns: vi.fn(),
}));

let poll: (() => void) | undefined;

vi.mock("../runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime")>()),
  listRalphFlows: mocks.listFlows,
  showRalphFlow: mocks.showFlow,
  loadActiveDesktopTasks: mocks.activeTasks,
  loadRecentDesktopTaskResults: mocks.recentTasks,
  listRalphRuns: mocks.listRuns,
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

const flow = createFlow();

beforeEach(() => {
  vi.clearAllMocks();
  const setInterval = window.setInterval.bind(window);
  vi.spyOn(window, "setInterval").mockImplementation(
    (handler, timeout, ...args) => {
      if (timeout === 5_000 && typeof handler === "function")
        poll = () => handler();
      return setInterval(handler, timeout, ...args) as unknown as ReturnType<
        typeof window.setInterval
      >;
    },
  );
  mocks.recentTasks.mockResolvedValue([]);
  mocks.listRuns.mockResolvedValue({ runs: [] });
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
      id: "running-flow",
      kind: "ralph",
      workspaceRoot: "/repo",
      arguments: ["run", flow.id, "--scope", "workspace"],
      startedAt: Date.now() - 60 * 60 * 1000,
      progressEvents: [
        {
          timestamp: Date.now() - 1000,
          progress: {
            task: flow.name,
            mode: "machdoch",
            state: "executing",
            message: "Implementing saved task",
            executedTools: [],
            outputSections: [],
            timelineEvent: {
              kind: "state",
              phase: "started",
              label: "Implementing saved task",
              metadata: {
                ralphEventType: "block-start",
                ralphBlockId: "fix-tsc",
                ralphBlockTitle: "Fix TSC",
              },
            },
          },
        },
      ],
    },
  ]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  poll = undefined;
});

const openEditor = () =>
  render(
    createElement(TooltipProvider, {
      children: createElement(RalphFlowEditor, {
        workspaceRoot: "/repo",
        initialSelection: { flowId: flow.id, scope: "workspace" },
        runMode: "machdoch",
        runProvider: "codex-cli",
        runModel: "gpt-6.1-sol",
        generationProvider: "codex-cli",
        generationModel: "gpt-6.1-sol",
        isActive: true,
      }),
    }),
  );

describe("RALPH live run restoration", () => {
  it("restores generation activity and its final result, then follows the next generation", async () => {
    const generationTask = (id: string, label: string) => ({
      id,
      kind: "ralph",
      workspaceRoot: "/repo",
      arguments: ["create", "generated-flow", "--scope", "workspace"],
      startedAt: Date.now() - 60_000,
      progressEvents: [
        {
          timestamp: Date.now() - 1_000,
          progress: {
            task: "Generate flow",
            mode: "machdoch",
            state: "executing",
            message: label,
            executedTools: [],
            outputSections: [],
            cancellable: true,
            timelineEvent: {
              kind: "state",
              phase: "started",
              label,
              metadata: {
                ralphGenerationEventType: "validator-start",
                ralphGenerationRound: 2,
              },
            },
          },
        },
      ],
    });
    mocks.activeTasks.mockResolvedValue([
      generationTask("generation-1", "Validating restored generation"),
    ]);
    openEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Generate" }));
    await screen.findAllByText("Validating restored generation");

    mocks.activeTasks.mockResolvedValue([]);
    mocks.recentTasks.mockResolvedValue([
      {
        id: "generation-1",
        kind: "ralph",
        workspaceRoot: "/repo",
        arguments: ["create", "generated-flow"],
        startedAt: 1,
        finishedAt: 2,
        outcome: {
          status: "succeeded",
          response: {
            execution: {
              status: "created",
              summary: "Background generation completed",
            },
          },
        },
      },
    ]);
    await act(async () => poll?.());
    await screen.findAllByText("Background generation completed");

    mocks.activeTasks.mockResolvedValue([
      generationTask("generation-2", "Validating the next generation"),
    ]);
    await act(async () => poll?.());
    await screen.findAllByText("Validating the next generation");
    expect(screen.queryByText("Validating restored generation")).toBeNull();
  });

  it("recovers a startup failure when a restored background task disappears", async () => {
    openEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Live/u }));
    await screen.findAllByText("Implementing saved task");
    const callsBeforeCompletion = mocks.listRuns.mock.calls.length;
    mocks.activeTasks.mockResolvedValue([]);
    mocks.recentTasks.mockResolvedValue([
      {
        id: "running-flow",
        kind: "ralph",
        workspaceRoot: "/repo",
        arguments: ["run", flow.id, "--scope", "workspace"],
        startedAt: 1,
        finishedAt: 2,
        outcome: {
          status: "failed",
          failure: {
            kind: "runtime",
            message: "The verification CLI could not start.",
          },
        },
      },
    ]);

    await act(async () => poll?.());
    await screen.findByText("The verification CLI could not start.");
    expect(mocks.recentTasks).toHaveBeenCalledWith(["running-flow"]);
    await waitFor(() =>
      expect(mocks.listRuns.mock.calls.length).toBeGreaterThan(
        callsBeforeCompletion,
      ),
    );
  });

  it("retries loading a completion result after a temporary bridge failure", async () => {
    openEditor();
    fireEvent.click(await screen.findByRole("button", { name: "Run" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Live/u }));
    await screen.findAllByText("Implementing saved task");
    mocks.activeTasks.mockResolvedValue([]);
    mocks.recentTasks.mockResolvedValueOnce(null).mockResolvedValue([
      {
        id: "running-flow",
        kind: "ralph",
        workspaceRoot: "/repo",
        arguments: ["run", flow.id],
        startedAt: 1,
        finishedAt: 2,
        outcome: {
          status: "succeeded",
          response: {
            execution: { run: { summary: "Run finished after recovery" } },
          },
        },
      },
    ]);

    await act(async () => poll?.());
    await screen.findByText("The flow result could not be loaded. Try again.");
    await act(async () => poll?.());
    await screen.findByText("Run finished after recovery");
    expect(mocks.recentTasks).toHaveBeenCalledTimes(2);
  });

  it("restores progress when opening and reopening an hour-old running flow", async () => {
    for (let index = 0; index < 2; index += 1) {
      const editor = openEditor();
      fireEvent.click(await screen.findByRole("button", { name: "Run" }));
      fireEvent.click(await screen.findByRole("button", { name: /^Live/u }));
      await waitFor(() => {
        expect(screen.queryByText("Waiting for block start")).toBeNull();
        expect(
          screen.getAllByText("Implementing saved task").length,
        ).toBeGreaterThan(0);
      });
      expect(
        screen.queryByText("Waiting for first progress event."),
      ).toBeNull();
      expect(screen.queryByText("No node internals captured yet.")).toBeNull();
      editor.unmount();
    }
  });
});
