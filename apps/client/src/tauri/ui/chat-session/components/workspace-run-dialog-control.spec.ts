// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceRunConfigurationDocument,
  WorkspaceRunConfigurationStatus,
  WorkspaceRunHealthStatus,
  WorkspaceRunSnapshot,
} from "../../../../shared/workspace-run.js";
import { clearWorkspaceRunDetection } from "../../workspace-management/workspace-run-detection-state";
import { WorkspaceRunDialogControl } from "./workspace-run-dialog-control";

const runtime = vi.hoisted(() => ({
  listenWorkspaceRunLogs: vi.fn(),
  listenWorkspaceRunState: vi.fn(),
  loadWorkspaceRunConfigurationDocument: vi.fn(),
  loadWorkspaceRunSnapshot: vi.fn(),
  openExternalUrl: vi.fn(),
  precheckWorkspaceRunConfigurationJson: vi.fn(),
  restartWorkspaceRunConfiguration: vi.fn(),
  runDesktopTask: vi.fn(),
  saveWorkspaceRunConfigurationDocument: vi.fn(),
  startWorkspaceRunConfiguration: vi.fn(),
  stopWorkspaceRunConfiguration: vi.fn(),
}));
const ai = vi.hoisted(() => ({
  generateWorkspaceRunDetection: vi.fn(),
  validateWorkspaceRunDetections: vi.fn(),
}));

vi.mock("../../runtime", () => runtime);
vi.mock("../../workspace-management/workspace-run-ai", () => ai);

const taskStatus = (
  state: WorkspaceRunConfigurationStatus["state"],
  {
    id = "server",
    name = "Server",
    primary = true,
    health = null,
  }: {
    id?: string;
    name?: string;
    primary?: boolean;
    health?: WorkspaceRunHealthStatus | null;
  } = {},
): WorkspaceRunConfigurationStatus => ({
  configuration: {
    id,
    name,
    kind: "task",
    primary,
    command: "pnpm run dev",
    workingDirectory: ".",
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
  state,
  pid: state === "running" || state === "unhealthy" ? 42 : null,
  startedAt: state === "stopped" ? null : 1,
  stoppedAt: null,
  exitCode: null,
  restartCount: 0,
  health,
  recentFailures: [],
  logs: [],
  children: [],
});

const createSnapshot = (
  state: WorkspaceRunConfigurationStatus["state"],
  options?: Parameters<typeof taskStatus>[1],
): WorkspaceRunSnapshot => ({
  workspaceRoot: "C:/workspace",
  primaryConfigurationId: options?.id ?? "server",
  configurations: [taskStatus(state, options)],
});

const failedHealth: WorkspaceRunHealthStatus = {
  state: "failed",
  checkedAt: 2,
  consecutiveFailures: 1,
  message: "Health check failed",
};

beforeEach(() => {
  clearWorkspaceRunDetection("C:/workspace");
  vi.clearAllMocks();
  const stopped = createSnapshot("stopped");
  const document: WorkspaceRunConfigurationDocument = {
    schemaVersion: 2,
    configurations: stopped.configurations.map(
      (status) => status.configuration,
    ),
  };
  runtime.loadWorkspaceRunSnapshot.mockResolvedValue(stopped);
  runtime.loadWorkspaceRunConfigurationDocument.mockResolvedValue(document);
  runtime.listenWorkspaceRunLogs.mockResolvedValue(() => undefined);
  runtime.listenWorkspaceRunState.mockResolvedValue(() => undefined);
  runtime.openExternalUrl.mockResolvedValue(undefined);
  ai.validateWorkspaceRunDetections.mockImplementation(() => undefined);
});

afterEach(() => cleanup());

describe("WorkspaceRunDialogControl", () => {
  it.each([
    {
      state: "idle",
      snapshot: createSnapshot("stopped"),
      accessibleName: "Run workspace",
      running: false,
      unhealthy: false,
      accentClass: null,
    },
    {
      state: "running",
      snapshot: createSnapshot("running"),
      accessibleName: "Run workspace, process running",
      running: true,
      unhealthy: false,
      accentClass: "bg-emerald-500/10",
    },
    {
      state: "unhealthy",
      snapshot: createSnapshot("unhealthy", { health: failedHealth }),
      accessibleName: "Run workspace, process running, health check failed",
      running: true,
      unhealthy: true,
      accentClass: "bg-emerald-500/10",
    },
  ])("presents the $state state", async (scenario) => {
    runtime.loadWorkspaceRunSnapshot.mockResolvedValue(scenario.snapshot);

    render(
      createElement(WorkspaceRunDialogControl, {
        workspaceRoot: "C:/workspace",
        primaryTaskRunning: false,
      }),
    );

    const run = await screen.findByRole("button", {
      name: scenario.accessibleName,
    });
    expect(run.getAttribute("data-script-running")).toBe(
      String(scenario.running),
    );
    expect(run.getAttribute("data-health-check-failed")).toBe(
      String(scenario.unhealthy),
    );

    const activity = run.querySelector('[data-run-activity="script"]');
    expect(Boolean(activity)).toBe(scenario.running);
    if (activity)
      expect(activity.classList.contains("animate-ping")).toBe(true);

    expect(Boolean(run.querySelector('[data-run-health="failed"]'))).toBe(
      scenario.unhealthy,
    );
    if (scenario.accentClass) {
      expect(run.classList.contains(scenario.accentClass)).toBe(true);
    } else {
      expect(run.classList.contains("bg-emerald-500/10")).toBe(false);
    }
  });

  it("keeps unwrapped controls in a dialog and combines live activity states", async () => {
    const stateListeners: Array<(snapshot: WorkspaceRunSnapshot) => void> = [];
    runtime.listenWorkspaceRunState.mockImplementation(
      async (listener: (snapshot: WorkspaceRunSnapshot) => void) => {
        stateListeners.push(listener);
        return () => undefined;
      },
    );
    const view = render(
      createElement(WorkspaceRunDialogControl, {
        workspaceRoot: "C:/workspace",
        primaryTaskRunning: false,
      }),
    );

    const run = await screen.findByRole("button", { name: "Run workspace" });
    expect(run.textContent).toContain("Run");
    expect(run.textContent).not.toContain("Play");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Run Server/u })).toBeNull();

    fireEvent.click(run);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Run Server" }),
    ).toBeTruthy();
    const panel = screen.getByRole("region", { name: "Workspace run" });
    expect(panel.classList.contains("border")).toBe(true);
    expect(panel.classList.contains("rounded-xl")).toBe(true);
    expect(panel.querySelectorAll(".lucide-play")).toHaveLength(1);
    expect(panel.querySelector(".lucide-play")?.closest("button")).toBe(
      screen.getByRole("button", { name: "Run Server" }),
    );
    fireEvent.click(screen.getByText("Configuration"));
    expect(await screen.findByRole("button", { name: "Detect" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => {
      for (const listener of stateListeners)
        listener(createSnapshot("running"));
    });
    const runningRun = await screen.findByRole("button", {
      name: /Run workspace/,
    });
    expect(runningRun.getAttribute("data-script-running")).toBe("true");
    expect(
      runningRun.querySelector('[data-run-activity="script"]'),
    ).toBeTruthy();

    view.rerender(
      createElement(WorkspaceRunDialogControl, {
        workspaceRoot: "C:/workspace",
        primaryTaskRunning: true,
      }),
    );
    expect(runningRun.getAttribute("data-primary-task-running")).toBe("true");
    expect(
      runningRun.querySelector('[data-run-activity="primary-task"]'),
    ).toBeTruthy();

    act(() => {
      for (const listener of stateListeners)
        listener(createSnapshot("stopped"));
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Run workspace" })
          .getAttribute("data-script-running"),
      ).toBe("false"),
    );
    expect(run.querySelector('[data-run-activity="script"]')).toBeNull();
    expect(run.getAttribute("data-primary-task-running")).toBe("true");
  });

  it("selects the flagged primary configuration whenever the dialog opens", async () => {
    const server = taskStatus("stopped", {
      id: "server",
      name: "Server",
      primary: false,
    });
    const completeStack = taskStatus("stopped", {
      id: "complete-stack",
      name: "Complete Stack",
      primary: true,
    });
    const snapshot: WorkspaceRunSnapshot = {
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: "server",
      configurations: [server, completeStack],
    };
    runtime.loadWorkspaceRunSnapshot.mockResolvedValue(snapshot);
    runtime.loadWorkspaceRunConfigurationDocument.mockResolvedValue({
      schemaVersion: 2,
      configurations: snapshot.configurations.map(
        (status) => status.configuration,
      ),
    });
    runtime.startWorkspaceRunConfiguration.mockResolvedValue(snapshot);

    render(
      createElement(WorkspaceRunDialogControl, {
        workspaceRoot: "C:/workspace",
        primaryTaskRunning: false,
      }),
    );
    const trigger = await screen.findByRole("button", {
      name: "Run workspace",
    });

    fireEvent.click(trigger);
    const selector = (await screen.findByLabelText(
      "Run configuration",
    )) as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe("complete-stack"));
    expect(
      screen.getByRole("option", { name: "Complete Stack (Default)" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Run Complete Stack" }),
    ).toBeTruthy();

    fireEvent.change(selector, { target: { value: "server" } });
    expect(selector.value).toBe("server");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(trigger);
    const reopenedSelector = (await screen.findByLabelText(
      "Run configuration",
    )) as HTMLSelectElement;
    await waitFor(() => expect(reopenedSelector.value).toBe("complete-stack"));
    fireEvent.click(screen.getByRole("button", { name: "Run Complete Stack" }));
    await waitFor(() =>
      expect(runtime.startWorkspaceRunConfiguration).toHaveBeenCalledWith(
        "C:/workspace",
        "complete-stack",
      ),
    );
  });

  it("keeps detection running and retains its result across control mounts", async () => {
    let finishDetection:
      | ((result: { documentJson: string; detections: [] }) => void)
      | undefined;
    ai.generateWorkspaceRunDetection.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDetection = resolve;
        }),
    );
    const detectedDocument: WorkspaceRunConfigurationDocument = {
      schemaVersion: 2,
      configurations: [
        {
          id: "detected",
          name: "Detected",
          kind: "task",
          primary: true,
          command: "pnpm dev",
          workingDirectory: ".",
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
    runtime.precheckWorkspaceRunConfigurationJson.mockResolvedValue(
      detectedDocument,
    );
    runtime.loadWorkspaceRunSnapshot.mockResolvedValue(
      createSnapshot("running"),
    );
    runtime.listenWorkspaceRunState.mockResolvedValue(() => undefined);

    const firstSession = render(
      createElement(WorkspaceRunDialogControl, {
        workspaceRoot: "C:/workspace",
        primaryTaskRunning: true,
      }),
    );
    const detectingRun = await screen.findByRole("button", {
      name: /Run workspace/,
    });
    fireEvent.click(detectingRun);
    fireEvent.click(await screen.findByText("Configuration"));
    fireEvent.click(await screen.findByRole("button", { name: "Detect" }));

    await waitFor(() =>
      expect(detectingRun.getAttribute("data-detecting")).toBe("true"),
    );
    expect(
      detectingRun.querySelector('[data-run-activity="detection"]'),
    ).toBeTruthy();
    expect(detectingRun.getAttribute("data-script-running")).toBe("true");
    expect(detectingRun.getAttribute("data-primary-task-running")).toBe("true");
    expect(
      detectingRun.querySelector('[data-run-activity="script"]'),
    ).toBeTruthy();
    expect(
      detectingRun.querySelector('[data-run-activity="primary-task"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    firstSession.unmount();

    render(
      createElement(WorkspaceRunDialogControl, {
        workspaceRoot: "C:/workspace",
        primaryTaskRunning: true,
      }),
    );
    const nextSessionRun = await screen.findByRole("button", {
      name: /Run workspace/,
    });
    expect(nextSessionRun.getAttribute("data-detecting")).toBe("true");

    await act(async () => {
      finishDetection?.({ documentJson: "{}", detections: [] });
    });
    await waitFor(() =>
      expect(nextSessionRun.getAttribute("data-detecting")).toBe("false"),
    );
    expect(ai.generateWorkspaceRunDetection).toHaveBeenCalledTimes(1);

    fireEvent.click(nextSessionRun);
    fireEvent.click(await screen.findByText("Configuration"));
    const editor = await screen.findByLabelText("Run configuration JSON");
    await waitFor(() =>
      expect((editor as HTMLTextAreaElement).value).toContain('"detected"'),
    );
  });
});
