// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import axe from "axe-core";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceRunConfigurationDocument,
  WorkspaceRunConfigurationStatus,
  WorkspaceRunLogBatch,
  WorkspaceRunSnapshot,
} from "../../../shared/workspace-run.js";
import { WorkspaceRunPanel } from "./workspace-run-panel";

const runtime = vi.hoisted(() => ({
  detectWorkspaceRunConfigurations: vi.fn(),
  listenWorkspaceRunLogs: vi.fn(),
  listenWorkspaceRunState: vi.fn(),
  loadWorkspaceRunConfigurationDocument: vi.fn(),
  loadWorkspaceRunSnapshot: vi.fn(),
  openExternalUrl: vi.fn(),
  restartWorkspaceRunConfiguration: vi.fn(),
  saveWorkspaceRunConfigurationDocument: vi.fn(),
  startWorkspaceRunConfiguration: vi.fn(),
  stopWorkspaceRunConfiguration: vi.fn(),
}));

vi.mock("../runtime", () => runtime);

const taskStatus = (
  id: string,
  state: WorkspaceRunConfigurationStatus["state"] = "stopped",
): WorkspaceRunConfigurationStatus => ({
  configuration: {
    id,
    name: id,
    kind: "task",
    command: "example",
    workingDirectory: ".",
    environment: {},
    hotReload: false,
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

const documentFromSnapshot = (
  snapshot: WorkspaceRunSnapshot,
): WorkspaceRunConfigurationDocument => ({
  schemaVersion: 1,
  primaryConfigurationId: snapshot.primaryConfigurationId,
  configurations: snapshot.configurations.map((status) => status.configuration),
});

beforeEach(() => {
  vi.clearAllMocks();
  runtime.listenWorkspaceRunLogs.mockResolvedValue(() => undefined);
  runtime.listenWorkspaceRunState.mockResolvedValue(() => undefined);
  runtime.openExternalUrl.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("WorkspaceRunPanel", () => {
  it("opens configuration for an unconfigured chat workspace", async () => {
    const snapshot: WorkspaceRunSnapshot = {
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: null,
      configurations: [],
    };
    runtime.loadWorkspaceRunSnapshot.mockResolvedValue(snapshot);
    runtime.loadWorkspaceRunConfigurationDocument.mockResolvedValue({
      schemaVersion: 1,
      primaryConfigurationId: null,
      configurations: [],
    });

    render(
      createElement(WorkspaceRunPanel, {
        workspaceRoot: "C:/workspace",
        variant: "chat",
      }),
    );

    expect(await screen.findByLabelText("Run configuration JSON")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Detect" })).toBeTruthy();
  });

  it("shows live composite stdout and stderr without disclosure", async () => {
    const backend = taskStatus("Backend", "running");
    backend.logs = [
      { sequence: 2, at: 2, stream: "stderr", line: "backend error" },
    ];
    const frontend = taskStatus("Frontend", "running");
    frontend.logs = [
      { sequence: 1, at: 1, stream: "stdout", line: "frontend ready" },
    ];
    const composite: WorkspaceRunConfigurationStatus = {
      ...taskStatus("Fullstack", "running"),
      configuration: {
        id: "fullstack",
        name: "Fullstack",
        kind: "composite",
        children: ["Backend", "Frontend"],
        startOrder: "parallel",
      },
      pid: null,
      children: [backend, frontend],
    };
    const snapshot: WorkspaceRunSnapshot = {
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: "fullstack",
      configurations: [backend, frontend, composite],
    };
    runtime.loadWorkspaceRunSnapshot.mockResolvedValue(snapshot);
    runtime.loadWorkspaceRunConfigurationDocument.mockResolvedValue(
      documentFromSnapshot(snapshot),
    );

    render(
      createElement(WorkspaceRunPanel, {
        workspaceRoot: "C:/workspace",
        variant: "chat",
      }),
    );

    expect(await screen.findByText("frontend ready")).toBeTruthy();
    expect(screen.getByText("backend error")).toBeTruthy();
    const output = screen.getByRole("log", { name: "Fullstack output" });
    expect(output).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Stop" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      (screen.getByRole("button", { name: "Restart" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(screen.queryByText("Details")).toBeNull();
    Object.defineProperties(output, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    fireEvent.scroll(output);
    fireEvent.click(screen.getByRole("button", { name: "Latest" }));
    expect(output.scrollTop).toBe(1_000);
    const accessibility = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("retains output and presents successful exits as completed", async () => {
    const completed = taskStatus("Build");
    completed.startedAt = 1;
    completed.stoppedAt = 2;
    completed.exitCode = 0;
    completed.logs = [
      { sequence: 1, at: 1, stream: "stdout", line: "build complete" },
    ];
    const snapshot: WorkspaceRunSnapshot = {
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: "Build",
      configurations: [completed],
    };
    runtime.loadWorkspaceRunSnapshot.mockResolvedValue(snapshot);
    runtime.loadWorkspaceRunConfigurationDocument.mockResolvedValue(
      documentFromSnapshot(snapshot),
    );

    render(createElement(WorkspaceRunPanel, { workspaceRoot: "C:/workspace" }));

    expect(await screen.findByText("build complete")).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("streams canonical log batches into an active terminal", async () => {
    const running = taskStatus("Server", "running");
    const snapshot: WorkspaceRunSnapshot = {
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: "Server",
      configurations: [running],
    };
    runtime.loadWorkspaceRunSnapshot.mockResolvedValue(snapshot);
    runtime.loadWorkspaceRunConfigurationDocument.mockResolvedValue(
      documentFromSnapshot(snapshot),
    );
    let emitLogs: ((batch: WorkspaceRunLogBatch) => void) | undefined;
    runtime.listenWorkspaceRunLogs.mockImplementation(
      async (listener: (batch: WorkspaceRunLogBatch) => void) => {
        emitLogs = listener;
        return () => undefined;
      },
    );

    render(createElement(WorkspaceRunPanel, { workspaceRoot: "C:/workspace" }));
    expect(await screen.findByText("No output yet")).toBeTruthy();
    act(() =>
      emitLogs?.({
        workspaceRoot: "C:/workspace",
        entries: [
          {
            configurationId: "Server",
            startedAt: 1,
            entry: {
              sequence: 1,
              at: 1,
              stream: "stderr",
              line: "live failure detail",
            },
          },
        ],
      }),
    );

    expect(await screen.findByText("live failure detail")).toBeTruthy();
  });

  it("keeps invalid configurations recoverable", async () => {
    runtime.loadWorkspaceRunSnapshot.mockRejectedValue(
      new Error("Failed to parse .machdoch/run.json"),
    );
    runtime.loadWorkspaceRunConfigurationDocument.mockRejectedValue(
      new Error("Failed to parse .machdoch/run.json"),
    );

    render(createElement(WorkspaceRunPanel, { workspaceRoot: "C:/workspace" }));

    expect(
      await screen.findByText("Failed to parse .machdoch/run.json"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Run configuration JSON")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("suppresses repeated start actions while one request is pending", async () => {
    const stopped = taskStatus("Server");
    const snapshot: WorkspaceRunSnapshot = {
      workspaceRoot: "C:/workspace",
      primaryConfigurationId: "Server",
      configurations: [stopped],
    };
    runtime.loadWorkspaceRunSnapshot.mockResolvedValue(snapshot);
    runtime.loadWorkspaceRunConfigurationDocument.mockResolvedValue(
      documentFromSnapshot(snapshot),
    );
    let finishStart: ((snapshot: WorkspaceRunSnapshot) => void) | undefined;
    runtime.startWorkspaceRunConfiguration.mockImplementation(
      () =>
        new Promise<WorkspaceRunSnapshot>((resolve) => {
          finishStart = resolve;
        }),
    );
    render(createElement(WorkspaceRunPanel, { workspaceRoot: "C:/workspace" }));
    const start = await screen.findByRole("button", { name: "Start" });

    fireEvent.click(start);
    fireEvent.click(start);

    expect(runtime.startWorkspaceRunConfiguration).toHaveBeenCalledTimes(1);
    finishStart?.(snapshot);
    await waitFor(() =>
      expect((start as HTMLButtonElement).disabled).toBe(false),
    );
  });
});
