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
  proposeFleetSetting: vi.fn(),
}));
const requestManagedSettingsSync = vi.hoisted(() => vi.fn());
const deviceSettings = vi.hoisted(() => ({
  uploadFleetDeviceSettings: vi.fn(),
  exportFleetDeviceSettings: vi.fn(),
}));

vi.mock("../runtime", () => runtime);
vi.mock("../chat-session/_helpers/fleet-managed-settings-sync", () => ({
  requestFleetManagedSettingsSync: requestManagedSettingsSync,
  ...deviceSettings,
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
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry sync" }));

    expect(requestManagedSettingsSync).toHaveBeenCalledOnce();
    expect(screen.getByText("Syncing")).toBeTruthy();
    expect(
      screen.queryByText("Managed prompt could not be written."),
    ).toBeNull();
  });

  it("removes managed settings right after disconnecting", async () => {
    runtime.getFleetConnectionStatus.mockResolvedValue(connectedStatus());
    runtime.resetCloudServerConnection.mockResolvedValue({
      enabled: false,
      phase: "disabled",
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderDialog(createElement(RemoteAccessPanel), "cloud");
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining("your own versions come back"),
    );
    expect(await screen.findByLabelText("Cloud URL")).toBeTruthy();
    expect(requestManagedSettingsSync).toHaveBeenCalledOnce();
  });

  it("lists assigned profiles and warnings, re-uploads and proposes settings", async () => {
    runtime.getFleetConnectionStatus.mockResolvedValue({
      enabled: true,
      phase: "connected",
      managerUrl: "https://fleet.example.com",
      managerId: "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
      instanceId: "instance_MDEyMzQ1Njc4OTAxMjM0NTY3",
      displayName: "Studio workstation",
      settingsSync: {
        phase: "applied",
        profileId: "profile_MDEyMzQ1Njc4OTAxMjM0NTY3",
        profileName: "Company + Frontend",
        revision: 3,
        layers: [
          {
            profileId: "profile_MDEyMzQ1Njc4OTAxMjM0NTY3",
            name: "Company",
            revision: 3,
          },
          {
            profileId: "profile_MDEyMzQ1Njc4OTAxMjM0NTY4",
            name: "Frontend",
            revision: 8,
          },
        ],
        warnings: [
          'Instruction "Code style" uses the machdoch.cloud version; your version returns when it is unassigned.',
        ],
        lastAttemptAt: 1_788_000_000,
        lastAppliedAt: 1_788_000_000,
      },
    });
    deviceSettings.uploadFleetDeviceSettings.mockResolvedValue(true);
    deviceSettings.exportFleetDeviceSettings.mockResolvedValue({
      defaults: {},
      agentLimits: {},
      instructions: [
        {
          id: "123e4567-e89b-42d3-a456-426614174000",
          name: "Review checklist",
          body: "Check tests.",
          enabled: true,
          global: true,
          tags: [],
        },
      ],
      contextPacks: [],
      prompts: [
        {
          id: "123e4567-e89b-42d3-a456-426614174001",
          relativePath: "release.prompt.md",
          content: "Prepare a release.",
        },
      ],
      mcpServers: [],
    });
    runtime.proposeFleetSetting.mockResolvedValue("proposal-1");

    renderDialog(createElement(RemoteAccessPanel), "cloud");

    const profiles = await screen.findByRole("list", {
      name: "Assigned profiles",
    });
    expect(profiles.textContent).toContain("1. Company");
    expect(profiles.textContent).toContain("2. Frontend");
    expect(
      screen.getByRole("list", { name: "Settings warnings" }).textContent,
    ).toContain("Code style");
    expect(screen.queryByText(/Company \+ Frontend/u)).toBeNull();

    expect(screen.getByText("Not uploaded yet")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Upload device settings" }),
    );
    expect(await screen.findByText("Device settings uploaded.")).toBeTruthy();
    expect(deviceSettings.uploadFleetDeviceSettings).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Re-upload device settings" }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Choose a setting to propose" }),
    );
    const type = await screen.findByRole("combobox", { name: "Setting type" });
    expect(document.activeElement).toBe(type);
    expect(
      [...(type as HTMLSelectElement).options].map((option) => option.text),
    ).toEqual(["Instruction", "Prompt"]);
    expect(screen.getByText("Check tests.")).toBeTruthy();
    fireEvent.change(type, { target: { value: "prompt" } });
    expect(
      (screen.getByRole("combobox", { name: "Setting" }) as HTMLSelectElement)
        .value,
    ).toBe("123e4567-e89b-42d3-a456-426614174001");
    expect(screen.getByText("Prepare a release.")).toBeTruthy();
    const note = screen.getByRole("textbox", { name: "Note (optional)" });
    fireEvent.change(note, { target: { value: "Used by the whole team." } });
    fireEvent.click(screen.getByRole("button", { name: "Send proposal" }));
    expect(
      await screen.findByText(
        'Sent "release.prompt.md" to machdoch.cloud for review.',
      ),
    ).toBeTruthy();
    expect(runtime.proposeFleetSetting).toHaveBeenCalledWith(
      "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
      "instance_MDEyMzQ1Njc4OTAxMjM0NTY3",
      expect.objectContaining({
        kind: "prompt",
        note: "Used by the whole team.",
        item: expect.objectContaining({ relativePath: "release.prompt.md" }),
      }),
    );
    expect((note as HTMLTextAreaElement).value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    const reopen = screen.getByRole("button", {
      name: "Choose a setting to propose",
    });
    await waitFor(() => expect(document.activeElement).toBe(reopen));
    expect(screen.queryByRole("combobox", { name: "Setting type" })).toBeNull();
  });

  it("previews MCP servers with secret placeholders", async () => {
    runtime.getFleetConnectionStatus.mockResolvedValue(connectedStatus());
    deviceSettings.exportFleetDeviceSettings.mockResolvedValue({
      defaults: {},
      agentLimits: {},
      instructions: [],
      contextPacks: [],
      prompts: [],
      mcpServers: [
        {
          id: "github",
          title: "GitHub",
          enabled: true,
          transport: {
            type: "stdio",
            command: "npx",
            args: ["github-mcp"],
            env: { GITHUB_TOKEN: "{{secret:mcp_github_github_token}}" },
          },
        },
      ],
    });
    renderDialog(createElement(RemoteAccessPanel), "cloud");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Choose a setting to propose",
      }),
    );
    expect(
      await screen.findByText(
        /GITHUB_TOKEN=\{\{secret:mcp_github_github_token\}\}/u,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/replaced by \{\{secret:…\}\} placeholders/u),
    ).toBeTruthy();
  });

  it("explains an empty device instead of showing an empty form", async () => {
    runtime.getFleetConnectionStatus.mockResolvedValue(connectedStatus());
    deviceSettings.exportFleetDeviceSettings.mockResolvedValue({
      defaults: {},
      agentLimits: {},
      instructions: [],
      contextPacks: [],
      prompts: [],
      mcpServers: [],
    });
    renderDialog(createElement(RemoteAccessPanel), "cloud");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Choose a setting to propose",
      }),
    );
    expect(
      await screen.findByText(
        "This device has no settings of its own to propose yet.",
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Done" }),
    );
  });

  it("shows a single profile, an unassigned device and many warnings compactly", async () => {
    runtime.getFleetConnectionStatus.mockResolvedValue(
      connectedStatus({
        phase: "applied",
        lastAttemptAt: 1_788_000_000,
        lastAppliedAt: 1_788_000_000,
        warnings: ["One", "Two", "Three", "Four", "Five"],
      }),
    );
    renderDialog(createElement(RemoteAccessPanel), "cloud");
    expect(
      await screen.findByText(
        "No profile is assigned to this device. Your own settings apply.",
      ),
    ).toBeTruthy();
    const warnings = screen.getByRole("list", { name: "Settings warnings" });
    expect(warnings.querySelectorAll("li")).toHaveLength(3);
    const toggle = screen.getByRole("button", { name: "Show all 5 warnings" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(warnings.querySelectorAll("li")).toHaveLength(5);
    expect(
      screen.getByRole("button", { name: "Show fewer warnings" }),
    ).toBeTruthy();
    cleanup();

    runtime.getFleetConnectionStatus.mockResolvedValue(
      connectedStatus({
        phase: "applied",
        profileId: "profile_MDEyMzQ1Njc4OTAxMjM0NTY3",
        profileName: "Company",
        revision: 3,
        layers: [
          {
            profileId: "profile_MDEyMzQ1Njc4OTAxMjM0NTY3",
            name: "Company",
            revision: 3,
          },
        ],
        lastAttemptAt: 1_788_000_000,
        lastAppliedAt: 1_788_000_000,
      }),
    );
    renderDialog(createElement(RemoteAccessPanel), "cloud");
    expect(await screen.findByText("Company · Revision 3")).toBeTruthy();
    expect(
      screen.queryByRole("list", { name: "Assigned profiles" }),
    ).toBeNull();
  });

  it("says it is checking the connection before the first status arrives", async () => {
    runtime.getFleetConnectionStatus.mockReturnValue(new Promise(() => {}));
    renderDialog(createElement(RemoteAccessPanel), "cloud");
    expect(screen.getByRole("status").textContent).toBe(
      "Checking the machdoch.cloud connection…",
    );
    expect(screen.queryByLabelText("Cloud URL")).toBeNull();
  });
});

function connectedStatus(
  settingsSync?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    enabled: true,
    phase: "connected",
    managerUrl: "https://fleet.example.com",
    managerId: "manager_MDEyMzQ1Njc4OTAxMjM0NTY3",
    instanceId: "instance_MDEyMzQ1Njc4OTAxMjM0NTY3",
    displayName: "Studio workstation",
    ...(settingsSync ? { settingsSync } : {}),
  };
}
