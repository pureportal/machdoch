import type { RunMode } from "../../../../core/runtime-contract.generated.js";
import {
  createSession,
  getSessionTitle,
  type ChatSessionRecord,
  type ShellPersistedState,
} from "../../chat-session.model";
import { createWorkspaceRootKey } from "../../workspace-management/workspace-management-model";
import type { ProviderChooserState } from "./session-shell-view-model";
import { createNewSessionDefaults } from "./use-session-lifecycle";

export interface AgentSessionRequest {
  workspace: string;
  title?: string;
  provider?: string;
  model?: string;
  mode?: RunMode;
}

export const resolveKnownWorkspace = (
  recentWorkspaces: readonly string[],
  workspace: string,
): string => {
  const key = createWorkspaceRootKey(workspace);
  const known = recentWorkspaces.find(
    (entry) => createWorkspaceRootKey(entry) === key,
  );
  if (!known)
    throw new Error(
      `Add ${workspace} as a Machdoch workspace first. Known workspaces: ${recentWorkspaces.join(", ") || "none"}.`,
    );
  return known;
};

export const createAgentSession = (
  state: ShellPersistedState,
  providerChooserState: ProviderChooserState,
  request: AgentSessionRequest,
): ChatSessionRecord => {
  const workspace = resolveKnownWorkspace(
    state.recentWorkspaces,
    request.workspace,
  );
  if (request.model && !request.provider)
    throw new Error("Choose the provider of this model.");
  const provider = providerChooserState.chooserProviders.find(
    (entry) => entry === request.provider,
  );
  if (request.provider !== undefined && !provider)
    throw new Error(
      `${request.provider} is not available. Available providers: ${providerChooserState.chooserProviders.join(", ") || "none"}.`,
    );
  return createSession({
    ...createNewSessionDefaults(
      state,
      providerChooserState,
      workspace,
      provider
        ? { provider, ...(request.model ? { model: request.model } : {}) }
        : undefined,
    ),
    ...(request.mode ? { mode: request.mode } : {}),
    ...(request.title?.trim() ? { manualTitle: request.title.trim() } : {}),
  });
};

export const findAgentSession = (
  sessions: readonly ChatSessionRecord[],
  sessionId: string,
): ChatSessionRecord => {
  const session = sessions.find((entry) => entry.id === sessionId);
  if (!session)
    throw new Error(
      "No chat has that id. Find chat ids with list_chat_sessions.",
    );
  return session;
};

export const describeAgentSession = (session: ChatSessionRecord) => ({
  sessionId: session.id,
  title: getSessionTitle(session),
  workspace: session.workspace,
  provider: session.provider,
  model: session.model,
  ...(session.mode ? { mode: session.mode } : {}),
});
