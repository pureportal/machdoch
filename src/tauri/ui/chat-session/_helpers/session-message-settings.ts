import type {
  ChatSessionMessage,
  ChatSessionMessageSettings,
  ChatSessionRecord,
} from "../../chat-session.model";
import type { PromptEnhancementMode } from "./prompt-enhancement";

export const createSessionMessageSettings = (
  session: ChatSessionRecord,
  promptEnhancementMode: PromptEnhancementMode = "off",
  interviewEnabled = false,
): ChatSessionMessageSettings => ({
  workspace: session.workspace,
  provider: session.provider,
  model: session.model,
  ...(session.mode ? { mode: session.mode } : {}),
  ...(session.reasoning ? { reasoning: session.reasoning } : {}),
  sessionMemoryEnabled: session.sessionMemoryEnabled,
  useGlobalMemory: session.useGlobalMemory,
  uiControlEnabled: session.uiControlEnabled,
  promptEnhancementMode,
  interviewEnabled,
});

export const getSessionMessageSettings = (
  message: ChatSessionMessage,
  fallbackSession: ChatSessionRecord,
): ChatSessionMessageSettings => {
  if (message.settings) {
    return { ...message.settings };
  }

  return createSessionMessageSettings(
    fallbackSession,
    message.promptEnhancement ? "simple" : "off",
    false,
  );
};

export const applySessionMessageSettings = (
  session: ChatSessionRecord,
  settings: ChatSessionMessageSettings,
): ChatSessionRecord => {
  const nextSession: ChatSessionRecord = {
    ...session,
    workspace: settings.workspace,
    provider: settings.provider,
    model: settings.model,
    sessionMemoryEnabled: settings.sessionMemoryEnabled,
    useGlobalMemory: settings.useGlobalMemory,
    uiControlEnabled: settings.uiControlEnabled,
  };

  if (settings.mode) {
    nextSession.mode = settings.mode;
  } else {
    delete nextSession.mode;
  }

  if (settings.reasoning) {
    nextSession.reasoning = settings.reasoning;
  } else {
    delete nextSession.reasoning;
  }

  return nextSession;
};
