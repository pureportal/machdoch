import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConfigDocument, RuntimeSnapshot } from "../../runtime";
import * as runtime from "../../runtime";
import {
  disableInvokeMock,
  isTauriMock,
} from "../../test/tauri-test-mocks";
import { useChatSessionRuntime } from "./use-chat-session-runtime";

const createRuntimeSnapshot = (
  overrides: Partial<RuntimeSnapshot> = {},
): RuntimeSnapshot => {
  const baseSnapshot: RuntimeSnapshot = {
    workspaceRoot: "C:\\Project",
    mode: "ask",
    defaultMode: "ask",
    provider: "openai",
    model: "gpt-5.5",
    reasoning: "default",
    defaultReasoning: "default",
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
  };

  return {
    ...baseSnapshot,
    ...overrides,
  };
};

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
          mode: "ask",
          model: "gpt-5.5",
        }),
      )
      .mockResolvedValueOnce(null);

    const { result } = renderHook(() =>
      useChatSessionRuntime({
        activeSessionProvider: "openai",
        activeSessionWorkspace: "C:\\Project",
        catalogOpen: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.runtimeSnapshot?.mode).toBe("ask");
    });

    await act(async () => {
      await result.current.refreshWorkspaceRuntimeSnapshot("C:\\Project");
    });

    expect(result.current.runtimeSnapshot?.mode).toBe("ask");
    expect(result.current.runtimeSnapshot?.model).toBe("gpt-5.5");
  });

  it("clears stale runtime snapshots when another workspace refresh is unavailable", async () => {
    vi.spyOn(runtime, "loadWorkspaceRuntimeSnapshot")
      .mockResolvedValueOnce(
        createRuntimeSnapshot({
          workspaceRoot: "C:\\Project",
          mode: "ask",
        }),
      )
      .mockResolvedValueOnce(null);

    const { result, rerender } = renderHook(
      ({ workspace }) =>
        useChatSessionRuntime({
          activeSessionProvider: "openai",
          activeSessionWorkspace: workspace,
          catalogOpen: false,
        }),
      { initialProps: { workspace: "C:\\Project" } },
    );

    await waitFor(() => {
      expect(result.current.runtimeSnapshot?.workspaceRoot).toBe("C:\\Project");
    });

    rerender({ workspace: "D:\\Other" });

    await waitFor(() => {
      expect(result.current.runtimeSnapshot).toBeNull();
    });
  });

  it("does not overwrite an MCP draft edited while config documents are loading", async () => {
    let resolveUserDocument!: (document: McpConfigDocument) => void;
    let resolveWorkspaceDocument!: (document: McpConfigDocument) => void;
    const userDocument = new Promise<McpConfigDocument>((resolve) => {
      resolveUserDocument = resolve;
    });
    const workspaceDocument = new Promise<McpConfigDocument>((resolve) => {
      resolveWorkspaceDocument = resolve;
    });

    vi.spyOn(runtime, "loadMcpConfigDocument").mockImplementation((scope) =>
      scope === "user" ? userDocument : workspaceDocument,
    );

    const { result } = renderHook(() =>
      useChatSessionRuntime({
        activeSessionProvider: "openai",
        activeSessionWorkspace: "C:\\Project",
        catalogOpen: true,
      }),
    );

    const originalBase = result.current.mcpConfigDocument.raw;

    act(() => {
      result.current.handleMcpConfigDraftChange('{"servers":{"draft":{}}}');
    });

    await act(async () => {
      resolveUserDocument({
        scope: "user",
        path: "user.json",
        exists: true,
        raw: '{"servers":{"loaded":{}}}',
      });
      resolveWorkspaceDocument({
        scope: "workspace",
        path: "workspace.json",
        exists: true,
        raw: '{"servers":{}}',
      });
      await Promise.all([userDocument, workspaceDocument]);
    });

    await waitFor(() => {
      expect(result.current.mcpConfigLoading).toBe(false);
    });
    expect(result.current.mcpConfigDraft).toBe(
      '{"servers":{"draft":{}}}',
    );
    expect(result.current.mcpConfigDocument.raw).toBe(originalBase);
  });

  it("reloads the conflict base while preserving the MCP draft", async () => {
    const latestDocument: McpConfigDocument = {
      scope: "user",
      path: "user.json",
      exists: true,
      raw: '{"servers":{"external":{}}}',
    };
    vi.spyOn(runtime, "saveMcpConfigDocument").mockRejectedValueOnce(
      new Error("MACHDOCH_MCP_CONFIG_CONFLICT:user.json"),
    );
    vi.spyOn(runtime, "loadMcpConfigDocument").mockResolvedValue(latestDocument);

    const { result } = renderHook(() =>
      useChatSessionRuntime({
        activeSessionProvider: "openai",
        activeSessionWorkspace: "C:\\Project",
        catalogOpen: false,
      }),
    );

    act(() => {
      result.current.handleMcpConfigDraftChange('{"servers":{"draft":{}}}');
    });
    await act(async () => {
      await result.current.handleMcpConfigSave();
    });

    expect(result.current.mcpConfigDraft).toBe('{"servers":{"draft":{}}}');
    expect(result.current.mcpConfigDocument.raw).toBe(latestDocument.raw);
    expect(result.current.mcpConfigMessage?.text).toContain(
      "latest version is now the comparison base",
    );
  });

  it("keeps workspace MCP drafts separate when switching workspaces", async () => {
    vi.spyOn(runtime, "loadMcpConfigDocument").mockImplementation(
      async (scope, workspace) => ({
        scope,
        path: scope === "user" ? "user.json" : `${workspace}.json`,
        exists: true,
        raw:
          scope === "user"
            ? '{"servers":{}}'
            : `{"workspace":"${workspace}"}`,
      }),
    );

    const { result, rerender } = renderHook(
      ({ workspace }) =>
        useChatSessionRuntime({
          activeSessionProvider: "openai",
          activeSessionWorkspace: workspace,
          catalogOpen: true,
        }),
      { initialProps: { workspace: "C:\\One" } },
    );

    await waitFor(() => {
      expect(result.current.mcpConfigLoading).toBe(false);
    });
    act(() => {
      result.current.handleMcpConfigScopeChange("workspace");
    });
    act(() => {
      result.current.handleMcpConfigDraftChange("draft-one");
    });

    rerender({ workspace: "D:\\Two" });
    await waitFor(() => {
      expect(result.current.mcpConfigDocument.path).toContain("Two");
    });
    act(() => {
      result.current.handleMcpConfigDraftChange("draft-two");
    });

    rerender({ workspace: "C:\\One" });
    await waitFor(() => {
      expect(result.current.mcpConfigDraft).toBe("draft-one");
    });
  });
});
