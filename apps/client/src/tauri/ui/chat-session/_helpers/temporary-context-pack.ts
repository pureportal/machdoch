import type { ChatSessionRecord } from "../../chat-session.model";

const settingKeys = [
  "provider",
  "model",
  "mode",
  "reasoning",
  "contextWindow",
  "sessionMemoryEnabled",
  "useWorkspaceMemory",
  "useGlobalMemory",
  "uiControlEnabled",
] as const;

export const resetTemporaryContextPackSettings = (
  session: ChatSessionRecord,
): ChatSessionRecord => {
  const temporary = session.temporaryPackSettings;
  if (!temporary) return session;

  const restored = { ...session };
  const modelUnchanged =
    session.provider === temporary.applied.provider &&
    session.model === temporary.applied.model;

  for (const key of settingKeys) {
    if (
      session[key] !== temporary.applied[key] ||
      ((key === "provider" || key === "model" || key === "reasoning" || key === "contextWindow") &&
        !modelUnchanged)
    )
      continue;

    const value = temporary.previous[key];
    if (value === undefined) {
      Reflect.deleteProperty(restored, key);
    } else {
      Object.assign(restored, { [key]: value });
    }
  }
  delete restored.temporaryPackSettings;
  return restored;
};
