import { describe, expect, it } from "vitest";
import { DEFAULT_TERMINAL_PROFILE_SETTINGS } from "../lib/_helpers/shell-store-normalizers.helper";
import type { WorkspaceShellDiscovery } from "../runtime";
import { resolveTerminalProfiles } from "./workspace-terminal-profiles";

const discovery = {
  platform: "windows",
  defaultShellId: "pwsh",
  externalTerminal: null,
  shells: [
    { id: "pwsh", label: "PowerShell", kind: "powershell" },
    {
      id: "windows-powershell",
      label: "Windows PowerShell",
      kind: "powershell",
    },
    { id: "cmd", label: "Command Prompt", kind: "cmd" },
  ],
} satisfies WorkspaceShellDiscovery;

describe("terminal profile resolution", () => {
  it("keeps every discovered profile visible until customized", () => {
    const resolved = resolveTerminalProfiles(
      { ...DEFAULT_TERMINAL_PROFILE_SETTINGS },
      discovery,
    );

    expect(resolved.visibleShells.map((shell) => shell.id)).toEqual([
      "pwsh",
      "windows-powershell",
      "cmd",
    ]);
    expect(resolved.defaultShellId).toBe("pwsh");
    expect(resolved.settings).toEqual(DEFAULT_TERMINAL_PROFILE_SETTINGS);
  });

  it("preserves distinct PowerShell profiles in a customized selection", () => {
    const resolved = resolveTerminalProfiles(
      {
        version: 1,
        visibleShellIds: ["windows-powershell"],
        defaultShellId: "windows-powershell",
      },
      discovery,
    );

    expect(resolved.availableShells.map((shell) => shell.id)).toContain("pwsh");
    expect(resolved.visibleShells.map((shell) => shell.id)).toEqual([
      "windows-powershell",
    ]);
    expect(resolved.defaultShellId).toBe("windows-powershell");
  });

  it("removes unavailable references and falls back within the visible set", () => {
    const resolved = resolveTerminalProfiles(
      {
        version: 1,
        visibleShellIds: ["removed", "cmd"],
        defaultShellId: "removed",
      },
      discovery,
    );

    expect(resolved.settings).toEqual({
      version: 1,
      visibleShellIds: ["cmd"],
      defaultShellId: null,
    });
    expect(resolved.visibleShells.map((shell) => shell.id)).toEqual(["cmd"]);
    expect(resolved.defaultShellId).toBe("cmd");
  });

  it("restores existing behavior when no configured profile remains", () => {
    const resolved = resolveTerminalProfiles(
      {
        version: 1,
        visibleShellIds: ["removed"],
        defaultShellId: "removed",
      },
      discovery,
    );

    expect(resolved.settings).toEqual(DEFAULT_TERMINAL_PROFILE_SETTINGS);
    expect(resolved.visibleShells).toEqual(discovery.shells);
    expect(resolved.defaultShellId).toBe(discovery.defaultShellId);
  });

  it("clears a hidden default and selects the first valid visible profile", () => {
    const resolved = resolveTerminalProfiles(
      {
        version: 1,
        visibleShellIds: ["windows-powershell", "cmd"],
        defaultShellId: "pwsh",
      },
      discovery,
    );

    expect(resolved.settings.defaultShellId).toBeNull();
    expect(resolved.defaultShellId).toBe("windows-powershell");
  });
});
