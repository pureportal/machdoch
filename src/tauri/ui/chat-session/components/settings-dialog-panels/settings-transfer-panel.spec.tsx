import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  desktopEventListeners,
  disableInvokeMock,
  enableInvokeMock,
  invokeMock,
} from "../../../test/tauri-test-mocks";
import {
  SETTINGS_TRANSFER_EVENT,
  type CategoryEffect,
  type SettingsCategoryId,
  type SettingsTransferCategory,
  type SettingsTransferStatus,
} from "../../../settings-transfer";
import { SettingsTransferPanel } from "./settings-transfer-panel";

const CATEGORY_FIXTURES: ReadonlyArray<
  readonly [SettingsCategoryId, string, boolean]
> = [
  ["credentials.api-keys", "API Keys", false],
  ["preferences.agent-provider", "Agent & Provider Preferences", true],
  ["preferences.desktop-appearance", "Desktop & Appearance", true],
  ["memory.global", "Global Memory", false],
  ["customizations.instructions-global", "Instruction Files", true],
  ["customizations.prompts-global", "Global Prompts", true],
  ["mcp.global", "MCP Servers & Registries", true],
  ["ralph.flows-global", "Global RALPH Flows", true],
];

const category = (
  [id, label, defaultSelected]: (typeof CATEGORY_FIXTURES)[number],
  effect: CategoryEffect | null = null,
): SettingsTransferCategory => ({
  id,
  label,
  description: `${label} description`,
  warning: id === "credentials.api-keys" ? "Contains credentials." : null,
  defaultSelected,
  sensitive: id !== "preferences.desktop-appearance",
  selected: defaultSelected,
  availability: "available",
  effect,
  itemCount: effect === "clear" ? 0 : 2,
  byteCount: effect === "clear" ? 2 : 128,
  transferredBytes: 0,
  transferTotalBytes: 0,
  currentItemCount: effect === "preserveNotSelected" ? null : effect ? 3 : null,
  reason: null,
});

const status = (
  overrides: Partial<SettingsTransferStatus> = {},
): SettingsTransferStatus => ({
  mode: null,
  phase: "idle",
  sessionLabel: null,
  peerName: null,
  peerCategories: [],
  effectiveCategories: [],
  pairingCode: null,
  createdAt: null,
  expiresAt: null,
  categories: CATEGORY_FIXTURES.map((fixture) => category(fixture)),
  networkInterfaces: [
    {
      id: "12:Ethernet",
      name: "Ethernet",
      addresses: ["192.168.1.10", "fe80::10"],
      selected: true,
      recommended: true,
      reason: null,
    },
  ],
  discoveredSessions: [],
  manualCode: null,
  qrSvg: null,
  transferredBytes: 0,
  totalBytes: 0,
  message: null,
  errorCode: null,
  completedLocally: false,
  ...overrides,
});

const catalogStatus = status();

const emitStatus = (nextStatus: SettingsTransferStatus): void => {
  const listener = desktopEventListeners.get(SETTINGS_TRANSFER_EVENT);
  if (!listener) throw new Error("Settings-transfer listener is not registered.");
  listener({ payload: nextStatus });
};

describe("SettingsTransferPanel", () => {
  beforeEach(() => {
    enableInvokeMock();
    desktopEventListeners.clear();
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_settings_transfer_catalog") return catalogStatus;
      if (command === "stop_settings_transfer") return status({ phase: "cancelled" });
      if (command === "start_settings_transfer") {
        return status({
          mode: "send",
          phase: "advertising",
          sessionLabel: "Machdoch Transfer TEST",
          expiresAt: Date.now() + 600_000,
        });
      }
      return undefined;
    });
  });

  afterEach(() => {
    desktopEventListeners.clear();
    disableInvokeMock();
  });

  it("shows the complete closed catalog and starts with only safe defaults", async () => {
    render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Transfer Settings" }),
    );

    for (const [, label] of CATEGORY_FIXTURES) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.getByText("Contains credentials.")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Make available" }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_settings_transfer", {
        request: {
          categories: CATEGORY_FIXTURES.filter(([, , selected]) => selected)
            .map(([id]) => id)
            .sort(),
          displayName: "This PC",
          interfaceIds: ["12:Ethernet"],
        },
      });
    });
  });

  it("renders mandatory pairing and the complete replacement review", async () => {
    render(<SettingsTransferPanel />);
    await screen.findByRole("button", { name: "Receive Settings" });
    await waitFor(() => {
      expect(desktopEventListeners.has(SETTINGS_TRANSFER_EVENT)).toBe(true);
    });

    emitStatus(
      status({
        mode: "receive",
        phase: "pairing",
        peerName: "Sender PC",
        peerCategories: [
          "credentials.api-keys",
          "preferences.agent-provider",
          "memory.global",
        ],
        effectiveCategories: ["preferences.agent-provider", "memory.global"],
        pairingCode: "123456",
      }),
    );
    expect(await screen.findByText("123 456")).toBeDefined();
    expect(screen.getByText(/Sender PC/u)).toBeDefined();
    expect(screen.getByText("Sender offered (3)")).toBeDefined();
    expect(screen.getByText("Effective intersection (2)")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Codes match/u }));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "confirm_settings_transfer_pairing",
      );
    });
    const pairingPending = await screen.findByRole("button", {
      name: /Confirmed locally — waiting for other PC/u,
    });
    expect(pairingPending.hasAttribute("disabled")).toBe(true);
    fireEvent.click(pairingPending);
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "confirm_settings_transfer_pairing",
      ),
    ).toHaveLength(1);

    emitStatus(
      status({
        mode: "receive",
        phase: "review",
        categories: CATEGORY_FIXTURES.map((fixture, index) =>
          category(fixture, index === 0 ? "clear" : index === 1 ? "replace" : "preserveNotSelected"),
        ),
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Replace selected settings" }),
    ).toBeDefined();
    for (const [, label] of CATEGORY_FIXTURES) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.getByText("Clear")).toBeDefined();
    expect(screen.getByText("Replace")).toBeDefined();
    expect(screen.getAllByText("Keep — not selected").length).toBe(6);
    expect(screen.getAllByText(/not inspected — unchanged/u).length).toBe(6);
    fireEvent.click(
      screen.getByRole("button", { name: "Replace selected settings" }),
    );
    const approvalPending = await screen.findByRole("button", {
      name: /Approved locally — waiting for other PC/u,
    });
    expect(approvalPending.hasAttribute("disabled")).toBe(true);
    fireEvent.click(approvalPending);
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "approve_settings_transfer",
      ),
    ).toHaveLength(1);

    emitStatus(
      status({
        mode: "receive",
        phase: "transferring",
        transferredBytes: 256,
        totalBytes: 512,
        categories: CATEGORY_FIXTURES.map((fixture, index) => ({
          ...category(fixture),
          transferredBytes: index === 0 ? 128 : 0,
          transferTotalBytes: index === 0 ? 256 : index === 1 ? 128 : 0,
        })),
      }),
    );
    expect(
      await screen.findByLabelText("Category transfer progress"),
    ).toBeDefined();
    expect(screen.getByText("128 B / 256 B")).toBeDefined();
    expect(
      screen
        .getByRole("progressbar", {
          name: "Overall settings transfer progress",
        })
        .getAttribute("aria-valuenow"),
    ).toBe("50");
    expect(
      screen
        .getByRole("progressbar", { name: "API Keys transfer progress" })
        .getAttribute("aria-valuetext"),
    ).toBe("128 B of 256 B");
  });

  it("always asks the backend to stop when the panel unmounts", async () => {
    const view = render(<SettingsTransferPanel />);
    await screen.findByRole("button", { name: "Transfer Settings" });
    invokeMock.mockClear();

    view.unmount();

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("stop_settings_transfer");
    });
  });

  it("does not overwrite a live event with an older catalog response", async () => {
    let resolveCatalog: ((value: SettingsTransferStatus) => void) | undefined;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_settings_transfer_catalog") {
        return new Promise<SettingsTransferStatus>((resolve) => {
          resolveCatalog = resolve;
        });
      }
      if (command === "stop_settings_transfer") {
        return Promise.resolve(status({ phase: "cancelled" }));
      }
      return Promise.resolve(undefined);
    });

    render(<SettingsTransferPanel />);
    await waitFor(() => {
      expect(desktopEventListeners.has(SETTINGS_TRANSFER_EVENT)).toBe(true);
      expect(resolveCatalog).toBeDefined();
    });
    act(() => {
      emitStatus(
        status({
          mode: "send",
          phase: "advertising",
          sessionLabel: "Machdoch Transfer LIVE",
          expiresAt: Date.now() + 600_000,
        }),
      );
    });
    expect(await screen.findByText("Machdoch Transfer LIVE")).toBeDefined();

    await act(async () => {
      resolveCatalog?.(catalogStatus);
      await Promise.resolve();
    });
    expect(screen.getByText("Machdoch Transfer LIVE")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Transfer Settings" })).toBeNull();
  });

  it("does not offer cancellation while a journaled rollback is in progress", async () => {
    render(<SettingsTransferPanel />);
    await screen.findByRole("button", { name: "Transfer Settings" });
    await waitFor(() => {
      expect(desktopEventListeners.has(SETTINGS_TRANSFER_EVENT)).toBe(true);
    });

    act(() => {
      emitStatus(
        status({
          mode: "receive",
          phase: "rollingBack",
          message: "Restoring every original setting...",
        }),
      );
    });

    expect(screen.getAllByText("Restoring every original setting...")).toHaveLength(2);
    expect(
      screen.getByText(/finish and verify the journaled commit or rollback/u),
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
