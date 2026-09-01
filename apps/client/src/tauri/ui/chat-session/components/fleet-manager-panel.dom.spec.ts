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
import { CommandProvider } from "../../commands/command-context";
import { Dialog } from "../../components/ui/dialog";
import { TooltipProvider } from "../../components/ui/tooltip";
import { FleetManagerPanel } from "./fleet-manager-panel";

const runtime = vi.hoisted(() => ({
  getFleetConnectionStatus: vi.fn(),
  enrollFleetManager: vi.fn(),
  resetFleetManagerConnection: vi.fn(),
}));
const requestManagedSettingsSync = vi.hoisted(() => vi.fn());

vi.mock("../../runtime", () => runtime);
vi.mock("../_helpers/fleet-managed-settings-sync", () => ({
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
          content,
        ),
      ),
    }),
  );
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Fleet Manager dialog", () => {
  it("enrolls from the dedicated Fleet Manager dialog", async () => {
    runtime.getFleetConnectionStatus.mockResolvedValue({
      enabled: false,
      phase: "disabled",
    });
    runtime.enrollFleetManager.mockResolvedValue({
      enabled: true,
      phase: "connected",
      managerUrl: "https://fleet.example.com",
      displayName: "Studio workstation",
    });

    renderDialog(createElement(FleetManagerPanel), "fleet-manager");

    expect(screen.getByRole("heading", { name: "Fleet Manager" })).toBeTruthy();
    expect(screen.queryByText("Remote Access")).toBeNull();
    await waitFor(() =>
      expect(runtime.getFleetConnectionStatus).toHaveBeenCalledOnce(),
    );

    fireEvent.change(screen.getByLabelText("Manager URL"), {
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
      expect(runtime.enrollFleetManager).toHaveBeenCalledWith(
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

    renderDialog(createElement(FleetManagerPanel), "fleet-manager");

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
