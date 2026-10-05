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

describe("new session agent preferences", () => {
  it("creates and reopens the requested fleet identity in its selected workspace", () => {
    let shellState = createInitialShellState();
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
    const options = {
      id: "01234567-89ab-8def-8123-456789abcdef",
      workspace: "/projects/selected",
    };
    act(() => {
      expect(result.current.createNewSession(options)).toBe(options.id);
    });
    const session = shellState.sessions.find(
      (entry) => entry.id === options.id,
    )!;
    act(() => {
      result.current.createNewSession({
        ...options,
        id: "fedcba98-7654-8210-bedc-ba9876543210",
      });
    });
    expect(shellState.sessions.some((entry) => entry.id === options.id)).toBe(
      true,
    );
    session.draft = "Keep my draft";
    act(() => {
      expect(result.current.createNewSession(options)).toBe(options.id);
    });
    expect(activeSessionId).toBe(options.id);
    expect(shellState.activeSessionId).toBe(options.id);
    expect(shellState.recentWorkspaces[0]).toBe(options.workspace);
    expect(
      shellState.sessions.filter((entry) => entry.id === options.id),
    ).toEqual([
      expect.objectContaining({
        workspace: options.workspace,
        draft: "Keep my draft",
      }),
    ]);
    expect(() =>
      result.current.createNewSession({ ...options, workspace: "/other" }),
    ).toThrow("requested workspace");
  });

  it.each(["codex-cli", "claude-cli"] as const)(
    "uses the last selected modes after restoring shell state for %s",
    (provider) => {
      let shellState: ShellPersistedState = normalizeShellState({
        ...createInitialShellState(),
        lastSelectedProvider: provider,
        lastSelectedModelByProvider: {
          "codex-cli": "gpt-5.6-terra",
          "claude-cli": "claude-opus-4-6",
        },
        lastSelectedParallelAgentMode: "native",
        lastSelectedGoalMode: "native",
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
        chooserProviders: [provider],
      } as ProviderChooserState;
      const { result } = renderHook(() =>
        useSessionLifecycle({ state, providerChooserState }),
      );

      act(() => result.current.createNewSession());

      expect(shellState.sessions[0]?.parallelAgentMode).toBe("native");
      expect(shellState.sessions[0]?.goalMode).toBe("native");
      expect(shellState.sessions[0]?.goal).toBeUndefined();
      expect(shellState.activeSessionId).toBe(activeSessionId);
    },
  );
});
