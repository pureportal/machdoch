import { DEFAULT_USER_WORKSPACE_RUN_SETTINGS } from "../../../../../core/runtime-contract.generated.js";
import { describe, expect, it } from "vitest";
import {
  hasWorkspaceRunSettingsDraftChanges,
  normalizeWorkspaceRunSettingsDraft,
} from "./workspace-run-settings-panel";

describe("Workspace Run settings panel", () => {
  it("uses the global defaults without changes", () => {
    const settings = { ...DEFAULT_USER_WORKSPACE_RUN_SETTINGS };

    expect(normalizeWorkspaceRunSettingsDraft(settings)).toEqual(settings);
    expect(hasWorkspaceRunSettingsDraftChanges(settings, settings)).toBe(false);
  });

  it("keeps the health check timeout within the interval", () => {
    const settings = normalizeWorkspaceRunSettingsDraft({
      ...DEFAULT_USER_WORKSPACE_RUN_SETTINGS,
      healthCheckIntervalMs: 1000,
      healthCheckTimeoutMs: 5000,
    });

    expect(settings.healthCheckIntervalMs).toBe(1000);
    expect(settings.healthCheckTimeoutMs).toBe(1000);
    expect(
      hasWorkspaceRunSettingsDraftChanges(
        settings,
        DEFAULT_USER_WORKSPACE_RUN_SETTINGS,
      ),
    ).toBe(true);
  });
});
