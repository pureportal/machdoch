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
  WorkspaceRunSnapshot,
} from "../../../../shared/workspace-run.js";
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

vi.mock("../../runtime", () => runtime);

const taskStatus = (
  state: WorkspaceRunConfigurationStatus["state"],
): WorkspaceRunConfigurationStatus => ({
  configuration: {
    id: "server",
    name: "Server",
    kind: "task",
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
  pid: state === "running" ? 42 : null,
  startedAt: state === "stopped" ? null : 1,
  stoppedAt: null,
  exitCode: null,
  restartCount: 0,
  health: null,
  recentFailures: [],
  logs: [],
  children: [],
});

const createSnapshot = (
  state: WorkspaceRunConfigurationStatus["state"],
): WorkspaceRunSnapshot => ({
  workspaceRoot: "C:/workspace",
  primaryConfigurationId: "server",
  configurations: [taskStatus(state)],
});

beforeEach(() => {
  vi.clearAllMocks();
  const stopped = createSnapshot("stopped");
  const document: WorkspaceRunConfigurationDocument = {
    schemaVersion: 1,
    primaryConfigurationId: "server",
    configurations: stopped.configurations.map(
      (status) => status.configuration,
    ),
  };
  runtime.loadWorkspaceRunSnapshot.mockResolvedValue(stopped);
  runtime.loadWorkspaceRunConfigurationDocument.mockResolvedValue(document);
  runtime.listenWorkspaceRunLogs.mockResolvedValue(() => undefined);
  runtime.openExternalUrl.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("WorkspaceRunDialogControl", () => {
  it("keeps controls in a dialog and follows live process lifecycle state", async () => {
    const stateListeners: Array<(snapshot: WorkspaceRunSnapshot) => void> = [];
    runtime.listenWorkspaceRunState.mockImplementation(
      async (listener: (snapshot: WorkspaceRunSnapshot) => void) => {
        stateListeners.push(listener);
        return () => undefined;
      },
    );
    render(
      createElement(WorkspaceRunDialogControl, {
        workspaceRoot: "C:/workspace",
      }),
    );

    const play = await screen.findByRole("button", { name: "Play workspace" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();

    fireEvent.click(play);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Start" })).toBeTruthy();
    fireEvent.click(screen.getByText("Configuration"));
    expect(await screen.findByRole("button", { name: "Detect" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => {
      for (const listener of stateListeners)
        listener(createSnapshot("running"));
    });
    const runningPlay = await screen.findByRole("button", {
      name: "Play, workspace running",
    });
    expect(runningPlay.getAttribute("data-running")).toBe("true");
    expect(runningPlay.querySelector(".animate-ping")).toBeTruthy();

    act(() => {
      for (const listener of stateListeners)
        listener(createSnapshot("stopped"));
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Play workspace" })
          .getAttribute("data-running"),
      ).toBe("false"),
    );
    expect(play.querySelector(".animate-ping")).toBeNull();
  });
});
