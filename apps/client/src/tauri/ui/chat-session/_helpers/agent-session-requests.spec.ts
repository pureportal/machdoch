import { describe, expect, it } from "vitest";
import {
  createInitialShellState,
  createSession,
  type ShellPersistedState,
} from "../../chat-session.model";
import {
  createAgentSession,
  describeAgentSession,
  findAgentSession,
  resolveKnownWorkspace,
} from "./agent-session-requests";
import type { ProviderChooserState } from "./session-shell-view-model";

const providers = (
  chooserProviders: ProviderChooserState["chooserProviders"],
): ProviderChooserState => ({
  activeProviderStats: [],
  runtimeProviderLookup: new Map(),
  configuredProviders: chooserProviders,
  chooserProviders,
  hasAnyProvider: chooserProviders.length > 0,
});

const shellState = (): ShellPersistedState => ({
  ...createInitialShellState(),
  recentWorkspaces: ["C:\\Work\\App", "/home/user/site"],
});

describe("agent session requests", () => {
  it("resolves known workspaces regardless of extended path prefixes and case", () => {
    const known = shellState().recentWorkspaces;
    expect(resolveKnownWorkspace(known, "\\\\?\\c:\\work\\app\\")).toBe(
      "C:\\Work\\App",
    );
    expect(resolveKnownWorkspace(known, "/home/user/site")).toBe(
      "/home/user/site",
    );
    expect(() => resolveKnownWorkspace(known, "D:\\Other")).toThrow(
      "Add D:\\Other as a Machdoch workspace first. Known workspaces: C:\\Work\\App, /home/user/site.",
    );
  });

  it("creates a session with the requested workspace, title, provider, model, and mode", () => {
    const session = createAgentSession(
      shellState(),
      providers(["codex-cli", "claude-cli"]),
      {
        workspace: "c:/work/app",
        title: "  Review tests  ",
        provider: "claude-cli",
        model: "claude-opus-5-5",
        mode: "ask",
      },
    );
    expect(session).toMatchObject({
      workspace: "C:\\Work\\App",
      manualTitle: "Review tests",
      provider: "claude-cli",
      model: "claude-opus-5-5",
      mode: "ask",
      messages: [],
    });
    expect(describeAgentSession(session)).toEqual({
      sessionId: session.id,
      title: "Review tests",
      workspace: "C:\\Work\\App",
      provider: "claude-cli",
      model: "claude-opus-5-5",
      mode: "ask",
    });
  });

  it("uses the last selected provider and model by default", () => {
    const state: ShellPersistedState = {
      ...shellState(),
      lastSelectedProvider: "codex-cli",
      lastSelectedModelByProvider: { "codex-cli": "gpt-test" },
    };
    expect(
      createAgentSession(state, providers(["claude-cli", "codex-cli"]), {
        workspace: "/home/user/site",
      }),
    ).toMatchObject({ provider: "codex-cli", model: "gpt-test" });
  });

  it("rejects unavailable providers and models without a provider", () => {
    const chooser = providers(["codex-cli"]);
    expect(() =>
      createAgentSession(shellState(), chooser, {
        workspace: "/home/user/site",
        provider: "claude-cli",
      }),
    ).toThrow("claude-cli is not available. Available providers: codex-cli.");
    expect(() =>
      createAgentSession(shellState(), chooser, {
        workspace: "/home/user/site",
        model: "gpt-test",
      }),
    ).toThrow("Choose the provider of this model.");
  });

  it("finds existing sessions by id", () => {
    const session = createSession({ id: "chat-1" });
    expect(findAgentSession([session], "chat-1")).toBe(session);
    expect(() => findAgentSession([session], "chat-2")).toThrow(
      "No chat has that id.",
    );
  });
});
