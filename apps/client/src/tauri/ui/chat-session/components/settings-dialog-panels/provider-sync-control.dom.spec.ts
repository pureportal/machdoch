// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProviderSyncStatus } from "../../../runtime";
import { ProviderSyncControl } from "./provider-sync-control";

const mocks = vi.hoisted(() => ({
  getProviderSyncStatus: vi.fn(),
  refreshProviderSync: vi.fn(),
  doctorProviderSync: vi.fn(),
  planProviderSync: vi.fn(),
  setProviderSyncEnabled: vi.fn(),
}));
vi.mock("../../../runtime", () => mocks);

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const createStatus = (
  state: ProviderSyncStatus["targets"][number]["state"],
): ProviderSyncStatus => ({
  schemaVersion: 1,
  enabled: true,
  daemon: { running: false, autostartInstalled: false },
  workspaceRoot: "C:\\workspace",
  targets: [
    {
      provider: "codex-cli",
      scope: "user",
      state,
      targetPaths: [],
      updatedAt: new Date().toISOString(),
      warnings: [],
    },
  ],
});

it("shows sync completion and the action for existing runs after refresh", async () => {
  mocks.getProviderSyncStatus.mockResolvedValue(createStatus("writing"));
  render(
    createElement(ProviderSyncControl, {
      workspaceRoot: "C:\\workspace",
      showDiagnostics: true,
    }),
  );
  await screen.findByText(/codex-cli · user: writing/);
  expect(screen.queryByText(/Start a new run/)).toBeNull();

  const synced = createStatus("filesystem-current");
  mocks.refreshProviderSync.mockResolvedValue(synced);
  mocks.getProviderSyncStatus.mockResolvedValue(synced);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("MCP settings synced.");
  expect(screen.getByText(/codex-cli · user: Settings synced/)).toBeTruthy();
  expect(
    screen.getByText(
      /Existing provider runs keep their MCP settings. Start a new run to use changes./,
    ),
  ).toBeTruthy();
  expect(
    screen.queryByText(/awaiting-provider-refresh|provider-current/),
  ).toBeNull();
});

it("shows sync failures without claiming settings were synced", async () => {
  const status = createStatus("degraded");
  status.targets[0]!.error = "Could not write MCP settings.";
  mocks.getProviderSyncStatus.mockResolvedValue(status);
  render(
    createElement(ProviderSyncControl, {
      workspaceRoot: "C:\\workspace",
      showDiagnostics: true,
    }),
  );
  await screen.findByText("Could not write MCP settings.");
  expect(screen.queryByText(/Settings synced|Start a new run/)).toBeNull();
});

it("shows a failed sync attempt after reopening the settings", async () => {
  mocks.getProviderSyncStatus.mockResolvedValue({
    ...createStatus("filesystem-current"),
    targets: [],
    error: "Could not write MCP settings.",
  });
  render(
    createElement(ProviderSyncControl, {
      workspaceRoot: "C:\\workspace",
      showDiagnostics: true,
    }),
  );

  await screen.findByText("Could not write MCP settings.");
  expect(screen.queryByText(/Settings synced|Start a new run/)).toBeNull();
});

it("allows retrying a failed status load", async () => {
  mocks.getProviderSyncStatus.mockRejectedValueOnce(
    new Error("Status unavailable."),
  );
  render(
    createElement(ProviderSyncControl, {
      workspaceRoot: "C:\\workspace",
      showDiagnostics: true,
    }),
  );
  await screen.findByText("Status unavailable.");
  expect(screen.queryByText(/Loading provider sync status/)).toBeNull();

  mocks.getProviderSyncStatus.mockResolvedValue(
    createStatus("filesystem-current"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(/codex-cli · user: Settings synced/);
  expect(screen.queryByText("Status unavailable.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
});

it.each(["refresh", "enable", "plan", "doctor"] as const)(
  "ignores a late %s response after switching workspaces",
  async (action) => {
    let resolvePending!: (
      value: ProviderSyncStatus | Record<string, unknown>,
    ) => void;
    const pending = new Promise<ProviderSyncStatus | Record<string, unknown>>(
      (resolve) => {
        resolvePending = resolve;
      },
    );
    const initial = createStatus("filesystem-current");
    if (action === "enable") initial.enabled = false;
    mocks.getProviderSyncStatus.mockResolvedValue(initial);
    const { rerender } = render(
      createElement(ProviderSyncControl, {
        workspaceRoot: "C:\\workspace",
        showDiagnostics: true,
      }),
    );
    await screen.findByText(/codex-cli · user: Settings synced/);
    if (action === "enable") {
      mocks.setProviderSyncEnabled.mockReturnValue(pending);
      fireEvent.click(screen.getByRole("switch"));
    } else {
      const commands = {
        refresh: mocks.refreshProviderSync,
        plan: mocks.planProviderSync,
        doctor: mocks.doctorProviderSync,
      };
      commands[action].mockReturnValue(pending);
      fireEvent.click(
        screen.getByRole("button", {
          name: action[0]!.toUpperCase() + action.slice(1),
        }),
      );
    }

    const next = {
      ...createStatus("not-installed"),
      workspaceRoot: "C:\\other",
    };
    mocks.getProviderSyncStatus.mockResolvedValue(next);
    rerender(
      createElement(ProviderSyncControl, {
        workspaceRoot: next.workspaceRoot,
        showDiagnostics: true,
      }),
    );
    await screen.findByText(/codex-cli · user: not-installed/);
    expect(
      screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled"),
    ).toBe(false);

    await act(async () => {
      resolvePending(
        action === "plan"
          ? { providers: [{}] }
          : action === "doctor"
            ? { healthy: true }
            : initial,
      );
    });
    expect(
      screen.queryByText(
        /Settings synced|MCP settings synced|Provider MCP sync enabled|Plan is current|reports complete coverage/,
      ),
    ).toBeNull();
    expect(
      mocks.getProviderSyncStatus.mock.calls.map(([root]) => root),
    ).toEqual(["C:\\workspace", "C:\\other"]);
  },
);

it("uses the refresh result without overwriting it with another status read", async () => {
  mocks.getProviderSyncStatus.mockResolvedValue(createStatus("writing"));
  mocks.refreshProviderSync.mockResolvedValue(
    createStatus("filesystem-current"),
  );
  render(
    createElement(ProviderSyncControl, {
      workspaceRoot: "C:\\workspace",
      showDiagnostics: true,
    }),
  );
  await screen.findByText(/codex-cli · user: writing/);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("MCP settings synced.");
  expect(screen.getByText(/codex-cli · user: Settings synced/)).toBeTruthy();
  expect(mocks.getProviderSyncStatus).toHaveBeenCalledOnce();
});

it("reloads the recorded failure after refresh rejects", async () => {
  mocks.getProviderSyncStatus.mockResolvedValue(
    createStatus("filesystem-current"),
  );
  render(
    createElement(ProviderSyncControl, {
      workspaceRoot: "C:\\workspace",
      showDiagnostics: true,
    }),
  );
  await screen.findByText(/codex-cli · user: Settings synced/);
  mocks.refreshProviderSync.mockRejectedValue(
    new Error("Could not save MCP settings."),
  );
  mocks.getProviderSyncStatus.mockResolvedValue({
    ...createStatus("filesystem-current"),
    targets: [],
    error: "Could not save MCP settings.",
  });

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Could not save MCP settings.");
  expect(screen.queryByText(/Settings synced|Start a new run/)).toBeNull();
});

it("ignores an old failure while a refresh in the next workspace is pending", async () => {
  let rejectPrevious!: (error: Error) => void;
  const previousRefresh = new Promise<ProviderSyncStatus>(
    (_resolve, reject) => {
      rejectPrevious = reject;
    },
  );
  let resolveCurrent!: (status: ProviderSyncStatus) => void;
  const currentRefresh = new Promise<ProviderSyncStatus>((resolve) => {
    resolveCurrent = resolve;
  });
  mocks.getProviderSyncStatus.mockResolvedValue(
    createStatus("filesystem-current"),
  );
  mocks.refreshProviderSync
    .mockReturnValueOnce(previousRefresh)
    .mockReturnValueOnce(currentRefresh);
  const { rerender } = render(
    createElement(ProviderSyncControl, {
      workspaceRoot: "C:\\workspace",
      showDiagnostics: true,
    }),
  );
  await screen.findByText(/codex-cli · user: Settings synced/);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  const next = { ...createStatus("not-installed"), workspaceRoot: "C:\\other" };
  mocks.getProviderSyncStatus.mockResolvedValue(next);
  rerender(
    createElement(ProviderSyncControl, {
      workspaceRoot: next.workspaceRoot,
      showDiagnostics: true,
    }),
  );
  await screen.findByText(/codex-cli · user: not-installed/);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

  await act(async () => {
    rejectPrevious(new Error("Old workspace failed."));
  });
  expect(screen.queryByText("Old workspace failed.")).toBeNull();
  expect(
    screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled"),
  ).toBe(true);
  await act(async () => {
    resolveCurrent(next);
  });
  expect(
    screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled"),
  ).toBe(false);
  expect(mocks.getProviderSyncStatus).toHaveBeenCalledTimes(2);
});
