// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandProvider } from "@machdoch/media-studio/tauri/ui/commands/command-context.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { TooltipProvider } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { RemoteAccessPanel } from "./remote-access-panel";

const runtime = vi.hoisted(() => ({
  getFleetConnectionStatus: vi.fn(),
  enrollCloudServer: vi.fn(),
  resetCloudServerConnection: vi.fn(),
  reconnectCloudServer: vi.fn(),
}));
const requestManagedSettingsSync = vi.hoisted(() => vi.fn());

vi.mock("../runtime", () => runtime);
vi.mock("../chat-session/_helpers/fleet-managed-settings-sync", () => ({
  requestFleetManagedSettingsSync: requestManagedSettingsSync,
}));

const renderDialog = (content: ReactNode, overlayId: string): void => {
  render(
    createElement(CommandProvider, {
      activeView: "chat",
      platform: "windows",
      runtime: "browser",
      children: createElement(
        TooltipProvider,
        null,
        createElement(
          Dialog,
          { open: true, commandOverlayId: overlayId },
          createElement(
            DialogContent,
            { "aria-describedby": undefined },
            createElement(DialogTitle, null, "Remote access"),
            content,
          ),
        ),
      ),
    }),
  );
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("machdoch.cloud dialog", () => {
  it("reconnects a failed gateway without removing the enrollment", async () => {
    const connection = {
      enabled: true,
      phase: "error",
      managerUrl: "https://fleet.example.com",
      displayName: "Studio workstation",
      lastError:
        "machdoch.cloud rejected the connection: Invalid gateway message.",
    };
    runtime.getFleetConnectionStatus.mockResolvedValue(connection);
    runtime.reconnectCloudServer.mockResolvedValue({
      ...connection,
      phase: "connecting",
      lastError: undefined,
    });
    renderDialog(createElement(RemoteAccessPanel), "cloud");
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(runtime.reconnectCloudServer).toHaveBeenCalledOnce(),
    );
    expect(await screen.findByText("connecting")).toBeTruthy();
    expect(requestManagedSettingsSync).toHaveBeenCalledOnce();
    expect(runtime.resetCloudServerConnection).not.toHaveBeenCalled();
    expect(screen.queryByText(connection.lastError)).toBeNull();
  });

  it("keeps a reconnect failure visible for another attempt", async () => {
    runtime.getFleetConnectionStatus.mockResolvedValue({
      enabled: true,
      phase: "error",
      displayName: "Studio workstation",
    });
    runtime.reconnectCloudServer.mockRejectedValue(
      new Error("Fleet connection state is unavailable."),
    );
    renderDialog(createElement(RemoteAccessPanel), "cloud");
    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(
      await screen.findByText("Fleet connection state is unavailable."),
    ).toBeTruthy();
    expect(requestManagedSettingsSync).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "Reconnect" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("enrolls from the dedicated machdoch.cloud dialog", async () => {
    runtime.getFleetConnectionStatus.mockResolvedValue({
      enabled: false,
      phase: "disabled",
    });
    runtime.enrollCloudServer.mockResolvedValue({
      enabled: true,
      phase: "connected",
      managerUrl: "https://fleet.example.com",
      displayName: "Studio workstation",
    });

    renderDialog(createElement(RemoteAccessPanel), "cloud");

    expect(screen.getByRole("heading", { name: "Remote access" })).toBeTruthy();
    expect(screen.queryByText("Remote Access")).toBeNull();
    await waitFor(() =>
      expect(runtime.getFleetConnectionStatus).toHaveBeenCalledOnce(),
    );

    fireEvent.change(screen.getByLabelText("Cloud URL"), {
      target: { value: "https://fleet.example.com" },
    });
    fireEvent.change(screen.getByLabelText("Enrollment key"), {
      target: { value: "fleet_enrollment_key" },
    });
    fireEvent.change(screen.getByLabelText("Instance name"), {
      target: { value: "Studio workstation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(runtime.enrollCloudServer).toHaveBeenCalledWith(
        "https://fleet.example.com",
        "fleet_enrollment_key",
        "Studio workstation",
      ),
    );
    expect(await screen.findByText("Studio workstation")).toBeTruthy();
  });

  it("shows managed settings failures and requests an immediate retry", async () => {
    runtime.getFleetConnectionStatus.mockResolvedValue({
      enabled: true,
      phase: "connected",
      managerUrl: "https://fleet.example.com",
      displayName: "Studio workstation",
      settingsSync: {
        phase: "error",
        profileName: "Engineering",
        revision: 4,
        lastAttemptAt: 1_788_000_000,
        lastError: "Managed prompt could not be written.",
      },
    });

    renderDialog(createElement(RemoteAccessPanel), "cloud");

    expect(await screen.findByText("Sync failed")).toBeTruthy();
    expect(
      screen.getByText("Managed prompt could not be written."),
    ).toBeTruthy();
    expect(screen.getByText(/Engineering.*Revision 4/u)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry sync" }));

    expect(requestManagedSettingsSync).toHaveBeenCalledOnce();
    expect(screen.getByText("Syncing")).toBeTruthy();
  });
});
