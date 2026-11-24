import { useEffect, useMemo, useRef } from "react";
import { onWorkspaceAgentRequest } from "./workspace-agent-requests";
import {
  formatFileContextForChat,
  latestAgentChangedFiles,
} from "./workspace-agent-changes";
import type { WorkspaceFilesChatBridge } from "./workspace-files-panel";
import type { WorkspaceTerminalChatBridge } from "./workspace-terminal";
import { workspaceEntryAbsolutePath } from "./workspace-tools-model";

interface WorkspaceChatActions {
  attachPaths: (paths: string[]) => Promise<void>;
  appendText: (text: string) => void;
}

const focusComposer = (): void => {
  document
    .querySelector<HTMLTextAreaElement>('textarea[aria-label="Task composer"]')
    ?.focus();
};

export const useWorkspaceChatBridges = (
  workspaceRoot: string | null | undefined,
  messages: Parameters<typeof latestAgentChangedFiles>[0],
  actions: WorkspaceChatActions,
  showChat: () => void,
): {
  filesChat?: WorkspaceFilesChatBridge;
  terminalChat?: WorkspaceTerminalChatBridge;
} => {
  const root = workspaceRoot?.trim() || null;
  const agentChangedFiles = useMemo(
    () => latestAgentChangedFiles(messages),
    [messages],
  );
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const showChatRef = useRef(showChat);
  showChatRef.current = showChat;

  useEffect(
    () =>
      onWorkspaceAgentRequest((request) => {
        showChatRef.current();
        actionsRef.current.appendText(request.prompt);
        window.requestAnimationFrame(focusComposer);
      }),
    [],
  );

  return useMemo(() => {
    if (!root) return {};
    const appendText = (text: string) => actionsRef.current.appendText(text);
    const attachPaths = (paths: string[]) =>
      actionsRef.current.attachPaths(paths);
    return {
      filesChat: {
        agentChangedFiles,
        addPaths: (paths) => {
          void attachPaths(
            paths.map((path) => workspaceEntryAbsolutePath(root, path)),
          ).catch((error: unknown) =>
            console.error("Adding files to the chat failed", error),
          );
        },
        addContext: (context) => appendText(formatFileContextForChat(context)),
        ask: (context) => {
          appendText(formatFileContextForChat(context));
          focusComposer();
        },
      },
      terminalChat: {
        addText: (text) => appendText(`\`\`\`text\n${text}\n\`\`\``),
      },
    };
  }, [agentChangedFiles, root]);
};
