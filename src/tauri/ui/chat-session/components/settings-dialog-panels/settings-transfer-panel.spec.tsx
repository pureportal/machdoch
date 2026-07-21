import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  desktopEventListeners,
  disableInvokeMock,
  enableInvokeMock,
  invokeMock,
  openMock,
  saveMock,
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
    openMock.mockReset();
    openMock.mockResolvedValue("C:\\Backups\\settings.machdoch-settings");
    saveMock.mockReset();
    saveMock.mockResolvedValue("C:\\Backups\\settings.machdoch-settings");
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_settings_transfer_catalog") return catalogStatus;
      if (command === "stop_settings_transfer") return status({ phase: "cancelled" });
      if (command === "cancel_encrypted_settings_file_import") return false;
      if (command === "export_encrypted_settings_file") {
        return {
          categories: CATEGORY_FIXTURES.filter(([, , selected]) => selected).map(
            ([id]) => id,
          ),
          itemCount: 12,
          fileBytes: 4096,
        };
      }
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

  it("exports the same category selection to a passphrase-encrypted file", async () => {
    render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Export Encrypted File" }),
    );

    for (const [, label] of CATEGORY_FIXTURES) {
      expect(screen.getByText(label)).toBeDefined();
    }
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Encrypted file destination") as HTMLInputElement)
          .value,
      ).toBe("C:\\Backups\\settings.machdoch-settings");
    });
    fireEvent.change(screen.getByLabelText("File passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export encrypted file" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("export_encrypted_settings_file", {
        request: {
          categories: CATEGORY_FIXTURES.filter(([, , selected]) => selected)
            .map(([id]) => id)
            .sort(),
          destinationPath: "C:\\Backups\\settings.machdoch-settings",
          passphrase: "correct horse battery staple",
        },
      });
    });
    expect(await screen.findByText("Encrypted settings exported")).toBeDefined();
  });

  it("prunes a category that becomes unavailable without dropping other export selections", async () => {
    const unavailableCatalog = status({
      categories: CATEGORY_FIXTURES.map((fixture) => {
        const value = category(fixture);
        return value.id === "mcp.global"
          ? {
              ...value,
              availability: "unavailable" as const,
              reason: "The global MCP document is invalid.",
            }
          : value;
      }),
    });
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_settings_transfer_catalog") return catalogStatus;
      if (command === "cancel_encrypted_settings_file_import") return false;
      if (command === "stop_settings_transfer") {
        return status({ phase: "cancelled" });
      }
      if (command === "export_encrypted_settings_file") {
        return { categories: [], itemCount: 0, fileBytes: 1024 };
      }
      return undefined;
    });

    render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Export Encrypted File" }),
    );
    const initiallyAvailable = screen.getByRole("checkbox", {
      name: /MCP Servers & Registries/,
    }) as HTMLInputElement;
    expect(initiallyAvailable.checked).toBe(true);
    expect(initiallyAvailable.disabled).toBe(false);

    act(() => emitStatus(unavailableCatalog));
    await waitFor(() => {
      const unavailable = screen.getByRole("checkbox", {
        name: /MCP Servers & Registries/,
      }) as HTMLInputElement;
      expect(unavailable.checked).toBe(false);
      expect(unavailable.disabled).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Encrypted file destination") as HTMLInputElement)
          .value,
      ).toBe("C:\\Backups\\settings.machdoch-settings");
    });
    fireEvent.change(screen.getByLabelText("File passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export encrypted file" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("export_encrypted_settings_file", {
        request: {
          categories: CATEGORY_FIXTURES.filter(
            ([id, , selected]) => selected && id !== "mcp.global",
          )
            .map(([id]) => id)
            .sort(),
          destinationPath: "C:\\Backups\\settings.machdoch-settings",
          passphrase: "correct horse battery staple",
        },
      });
    });
  });

  it("authenticates an encrypted file and does not let cleanup failure trap the result", async () => {
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "get_settings_transfer_catalog") return catalogStatus;
      if (command === "stop_settings_transfer") return status({ phase: "cancelled" });
      if (command === "cancel_encrypted_settings_file_import") {
        throw new Error("cleanup unavailable");
      }
      if (command === "inspect_encrypted_settings_file") {
        return {
          token: "file-review-token",
          fileCreatedAt: Date.now() - 1_000,
          reviewExpiresAt: Date.now() + 600_000,
          effectiveCategories: [
            "preferences.agent-provider",
            "preferences.desktop-appearance",
          ],
          categories: CATEGORY_FIXTURES.map((fixture, index) =>
            category(
              fixture,
              index === 1
                ? "replace"
                : index === 2
                  ? "clear"
                  : fixture[2]
                    ? "preserveNotOffered"
                    : "preserveNotSelected",
            ),
          ),
        };
      }
      if (command === "commit_encrypted_settings_file_import") {
        expect(args).toEqual({ request: { token: "file-review-token" } });
        return {
          categories: [
            "preferences.agent-provider",
            "preferences.desktop-appearance",
          ],
          recoveryCleanupPending: false,
        };
      }
      return undefined;
    });

    render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Import Encrypted File" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Encrypted settings file") as HTMLInputElement)
          .value,
      ).toBe("C:\\Backups\\settings.machdoch-settings");
    });
    fireEvent.change(screen.getByLabelText("File passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review encrypted file" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("inspect_encrypted_settings_file", {
        request: {
          operationId: expect.any(String),
          categories: CATEGORY_FIXTURES.filter(([, , selected]) => selected)
            .map(([id]) => id)
            .sort(),
          sourcePath: "C:\\Backups\\settings.machdoch-settings",
          passphrase: "correct horse battery staple",
        },
      });
    });
    expect(await screen.findByText("Review Encrypted File Import")).toBeDefined();
    expect(screen.getByText("Replace")).toBeDefined();
    expect(screen.getByText("Clear")).toBeDefined();
    for (const [, label] of CATEGORY_FIXTURES) {
      expect(screen.getByText(label)).toBeDefined();
    }
    expect(screen.queryByLabelText("File passphrase")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Replace selected settings" }),
    );
    expect(await screen.findByText("Encrypted settings imported")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(
      await screen.findByRole("button", { name: "Import Encrypted File" }),
    ).toBeDefined();
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "get_settings_transfer_catalog",
      ),
    ).toHaveLength(2);
  });

  it("directs an unverified rollback failure to startup recovery instead of a blind retry", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_settings_transfer_catalog") return catalogStatus;
      if (command === "stop_settings_transfer") return status({ phase: "cancelled" });
      if (command === "cancel_encrypted_settings_file_import") return false;
      if (command === "inspect_encrypted_settings_file") {
        return {
          token: "file-review-token",
          fileCreatedAt: Date.now() - 1_000,
          reviewExpiresAt: Date.now() + 600_000,
          effectiveCategories: ["preferences.agent-provider"],
          categories: CATEGORY_FIXTURES.map((fixture, index) =>
            category(fixture, index === 1 ? "replace" : "preserveNotSelected"),
          ),
        };
      }
      if (command === "commit_encrypted_settings_file_import") {
        throw new Error(
          "COMMIT_AND_ROLLBACK_FAILED:write failed:rollback verification failed",
        );
      }
      return undefined;
    });

    render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Import Encrypted File" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Encrypted settings file") as HTMLInputElement)
          .value,
      ).not.toBe("");
    });
    fireEvent.change(screen.getByLabelText("File passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review encrypted file" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Replace selected settings" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Restart Machdoch now");
    expect(alert.textContent).not.toContain("Inspect the file again");
    expect(screen.getByText("Import Encrypted File")).toBeDefined();
  });

  it("serializes native file dialogs and recovers cleanly after cancellation", async () => {
    let resolveSave: ((value: string | null) => void) | undefined;
    saveMock.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveSave = resolve;
        }),
    );

    render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Export Encrypted File" }),
    );
    const choose = screen.getByRole("button", { name: "Choose destination" });
    fireEvent.click(choose);
    fireEvent.click(choose);

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    await act(async () => {
      resolveSave?.(null);
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Choose destination" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(false);
  });

  it("enforces the backend passphrase byte limit before invoking export", async () => {
    render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Export Encrypted File" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose destination" }));
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Encrypted file destination") as HTMLInputElement)
          .value,
      ).not.toBe("");
    });

    const oversized = "🔐".repeat(300);
    fireEvent.change(screen.getByLabelText("File passphrase"), {
      target: { value: oversized },
    });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: oversized },
    });

    expect(
      screen
        .getByRole("button", { name: "Export encrypted file" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "export_encrypted_settings_file",
      ),
    ).toBe(false);
  });

  it("expires stale reviews in the UI and returns empty intersections to file selection", async () => {
    let inspection = 0;
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_settings_transfer_catalog") return catalogStatus;
      if (command === "stop_settings_transfer") return status({ phase: "cancelled" });
      if (command === "cancel_encrypted_settings_file_import") return false;
      if (command === "inspect_encrypted_settings_file") {
        inspection += 1;
        return inspection === 1
          ? {
              token: null,
              fileCreatedAt: Date.now() - 1_000,
              reviewExpiresAt: null,
              effectiveCategories: [],
              categories: CATEGORY_FIXTURES.map((fixture) =>
                category(
                  fixture,
                  fixture[2] ? "preserveNotOffered" : "preserveNotSelected",
                ),
              ),
            }
          : {
              token: "file-review-token",
              fileCreatedAt: Date.now() - 1_000,
              reviewExpiresAt: Date.now() + 100,
              effectiveCategories: ["preferences.agent-provider"],
              categories: CATEGORY_FIXTURES.map((fixture, index) =>
                category(fixture, index === 1 ? "replace" : "preserveNotSelected"),
              ),
            };
      }
      return undefined;
    });

    render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Import Encrypted File" }),
    );
    const selectAndInspect = async (): Promise<void> => {
      fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
      await waitFor(() => {
        expect(
          (screen.getByLabelText("Encrypted settings file") as HTMLInputElement)
            .value,
        ).not.toBe("");
      });
      fireEvent.change(screen.getByLabelText("File passphrase"), {
        target: { value: "correct horse battery staple" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Review encrypted file" }));
      expect(await screen.findByText("Review Encrypted File Import")).toBeDefined();
    };

    await selectAndInspect();
    fireEvent.click(screen.getByRole("button", { name: "Choose another file" }));
    expect(await screen.findByText("Import Encrypted File")).toBeDefined();
    expect(screen.getByRole("button", { name: "Choose file" })).toBeDefined();

    await selectAndInspect();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The encrypted settings file review expired",
    );
    expect(screen.getByText("Import Encrypted File")).toBeDefined();
    expect(screen.queryByText("Review Encrypted File Import")).toBeNull();
  });

  it("scopes teardown cancellation and retries it after an in-flight inspection settles", async () => {
    let resolveInspection:
      | ((value: {
          token: string;
          fileCreatedAt: number;
          reviewExpiresAt: number;
          effectiveCategories: SettingsCategoryId[];
          categories: SettingsTransferCategory[];
        }) => void)
      | undefined;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_settings_transfer_catalog") {
        return Promise.resolve(catalogStatus);
      }
      if (command === "stop_settings_transfer") {
        return Promise.resolve(status({ phase: "cancelled" }));
      }
      if (command === "cancel_encrypted_settings_file_import") {
        return Promise.resolve(false);
      }
      if (command === "inspect_encrypted_settings_file") {
        return new Promise((resolve) => {
          resolveInspection = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    const view = render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Import Encrypted File" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }));
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Encrypted settings file") as HTMLInputElement)
          .value,
      ).not.toBe("");
    });
    fireEvent.change(screen.getByLabelText("File passphrase"), {
      target: { value: "correct horse battery staple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review encrypted file" }));
    await waitFor(() => {
      expect(resolveInspection).toBeDefined();
    });
    expect(
      (screen.getByLabelText("File passphrase") as HTMLInputElement).value,
    ).toBe("");
    const inspectionCall = invokeMock.mock.calls.find(
      ([command]) => command === "inspect_encrypted_settings_file",
    );
    const operationId = (
      inspectionCall?.[1] as { request?: { operationId?: string } } | undefined
    )?.request?.operationId;
    expect(operationId).toMatch(/^[0-9a-f]{32}$/u);

    view.unmount();
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith(
        "cancel_encrypted_settings_file_import",
        { request: { operationId } },
      );
    });

    await act(async () => {
      resolveInspection?.({
        token: "file-review-token",
        fileCreatedAt: Date.now() - 1_000,
        reviewExpiresAt: Date.now() + 600_000,
        effectiveCategories: ["preferences.agent-provider"],
        categories: CATEGORY_FIXTURES.map((fixture, index) =>
          category(fixture, index === 1 ? "replace" : "preserveNotSelected"),
        ),
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(
        invokeMock.mock.calls.filter(
          ([command, args]) =>
            command === "cancel_encrypted_settings_file_import" &&
            (args as { request?: { operationId?: string } } | undefined)?.request
              ?.operationId === operationId,
        ).length,
      ).toBeGreaterThanOrEqual(2);
    });
  });

  it("renders mandatory pairing and the complete replacement review", async () => {
    render(<SettingsTransferPanel />);
    await screen.findByRole("button", { name: "Receive Settings" });
    await waitFor(() => {
      expect(desktopEventListeners.has(SETTINGS_TRANSFER_EVENT)).toBe(true);
    });

    act(() => {
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
    });
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

    act(() => {
      emitStatus(
        status({
          mode: "receive",
          phase: "review",
          categories: CATEGORY_FIXTURES.map((fixture, index) =>
            category(fixture, index === 0 ? "clear" : index === 1 ? "replace" : "preserveNotSelected"),
          ),
        }),
      );
    });
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

    act(() => {
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
    });
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

  it("does not overwrite a live event with an older start response or submit duplicate starts", async () => {
    let resolveStart: ((value: SettingsTransferStatus) => void) | undefined;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_settings_transfer_catalog") {
        return Promise.resolve(catalogStatus);
      }
      if (command === "stop_settings_transfer") {
        return Promise.resolve(status({ phase: "cancelled" }));
      }
      if (command === "start_settings_transfer") {
        return new Promise<SettingsTransferStatus>((resolve) => {
          resolveStart = resolve;
        });
      }
      return Promise.resolve(undefined);
    });

    render(<SettingsTransferPanel />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Transfer Settings" }),
    );
    const start = screen.getByRole("button", { name: "Make available" });
    fireEvent.click(start);
    fireEvent.click(start);
    await waitFor(() => expect(resolveStart).toBeDefined());
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "start_settings_transfer",
      ),
    ).toHaveLength(1);

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
      resolveStart?.(
        status({
          mode: "send",
          phase: "inspecting",
          message: "stale start response",
        }),
      );
      await Promise.resolve();
    });
    expect(screen.getByText("Machdoch Transfer LIVE")).toBeDefined();
    expect(screen.queryByText("stale start response")).toBeNull();
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
