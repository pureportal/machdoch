import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSnapshot } from "../../runtime";
import * as runtime from "../../runtime";
import {
  disableInvokeMock,
  isTauriMock,
} from "../../test/tauri-test-mocks";
import { useChatSessionRuntime } from "./use-chat-session-runtime";

const createRuntimeSnapshot = (
  overrides: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot => ({
  workspaceRoot: "C:\\Project",
  availableProfiles: [],
  mode: "ask",
  provider: "openai",
  model: "gpt-5.5",
  offline: false,
  agentLimits: {
    executorTurns: 64,
    autopilotExecutorIterations: 16,
  },
  compatibility: {
    discoverGithubCustomizations: false,
  },
  providerAvailability: [],
  webSearch: {
    activeProvider: "none",
    providerAvailability: [],
  },
  reviewModel: {
    mode: "base",
  },
  ...overrides,
});

describe("useChatSessionRuntime", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    isTauriMock.mockReturnValue(false);
  });

  afterEach(() => {
    disableInvokeMock();
    vi.restoreAllMocks();
  });

  it("keeps the current runtime snapshot when the same workspace refresh is transiently unavailable", async () => {
    vi.spyOn(runtime, "loadWorkspaceRuntimeSnapshot")
      .mockResolvedValueOnce(
        createRuntimeSnapshot({
          workspaceRoot: "C:\\Project",
          activeProfile: "workspace",
          mode: "ask",
          model: "gpt-5.5",
        }),
      )
      .mockResolvedValueOnce(null);

    const { result } = renderHook(() =>
      useChatSessionRuntime({
        activeSessionProfile: "workspace",
        activeSessionProvider: "openai",
        activeSessionWorkspace: "C:\\Project",
        catalogOpen: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.runtimeSnapshot?.mode).toBe("ask");
    });

    await act(async () => {
      await result.current.refreshWorkspaceRuntimeSnapshot(
        "C:\\Project",
        "workspace",
      );
    });

    expect(result.current.runtimeSnapshot?.mode).toBe("ask");
    expect(result.current.runtimeSnapshot?.model).toBe("gpt-5.5");
  });

  it("clears stale runtime snapshots when another workspace refresh is unavailable", async () => {
    vi.spyOn(runtime, "loadWorkspaceRuntimeSnapshot")
      .mockResolvedValueOnce(
        createRuntimeSnapshot({
          workspaceRoot: "C:\\Project",
          activeProfile: "workspace",
          mode: "ask",
        }),
      )
      .mockResolvedValueOnce(null);

    const { result } = renderHook(() =>
      useChatSessionRuntime({
        activeSessionProfile: "workspace",
        activeSessionProvider: "openai",
        activeSessionWorkspace: "C:\\Project",
        catalogOpen: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.runtimeSnapshot?.workspaceRoot).toBe("C:\\Project");
    });

    await act(async () => {
      await result.current.refreshWorkspaceRuntimeSnapshot(
        "D:\\Other",
        "workspace",
      );
    });

    expect(result.current.runtimeSnapshot).toBeNull();
  });
});
