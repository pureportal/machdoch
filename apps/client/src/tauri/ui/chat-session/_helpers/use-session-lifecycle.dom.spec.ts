// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createInitialShellState,
  normalizeShellState,
  type ShellPersistedState,
} from "../../chat-session.model";
import { useSessionLifecycle } from "./use-session-lifecycle";
import type { ChatSessionShellStateController } from "./use-chat-session-shell-state";
import type { ProviderChooserState } from "./session-shell-view-model";

describe("new session parallel agents", () => {
  it("uses the last selected mode after restoring shell state", () => {
    let shellState: ShellPersistedState = normalizeShellState({
      ...createInitialShellState(),
      lastSelectedProvider: "codex-cli",
      lastSelectedModelByProvider: { "codex-cli": "gpt-5.6-terra" },
      lastSelectedParallelAgentMode: "native",
    });
    let activeSessionId = shellState.activeSessionId;
    const state = {
      shellState,
      activeSessionId,
      activeSession: shellState.sessions[0],
      applyShellState: (
        updater: (previous: ShellPersistedState) => ShellPersistedState,
      ) => {
        shellState = updater(shellState);
      },
      setActiveSessionId: (id: string) => {
        activeSessionId = id;
      },
    } as unknown as ChatSessionShellStateController;
    const providerChooserState = {
      chooserProviders: ["codex-cli"],
    } as ProviderChooserState;
    const { result } = renderHook(() =>
      useSessionLifecycle({ state, providerChooserState }),
    );

    act(() => result.current.createNewSession());

    expect(shellState.sessions[0]?.parallelAgentMode).toBe("native");
    expect(shellState.activeSessionId).toBe(activeSessionId);
  });
});
