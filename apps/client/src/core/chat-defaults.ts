import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getUserConfigPath } from "./env.js";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.js";
import {
  writeJsonAtomically,
  writeFileAtomically,
} from "./_helpers/write-file-atomically.helper.js";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_PROVIDER,
  isConfiguredModelProvider,
  isReasoningMode,
  isRunMode,
  type ConfiguredModelProvider,
  type ReasoningMode,
  type RunMode,
} from "./runtime-contract.generated.js";

export const CHAT_DEFAULT_SHELL_KEYS = {
  provider: "lastSelectedProvider",
  model: "lastSelectedModelByProvider",
  mode: "lastSelectedMode",
  reasoning: "lastSelectedReasoning",
  sessionMemoryEnabled: "lastSelectedSessionMemoryEnabled",
  useWorkspaceMemory: "lastSelectedUseWorkspaceMemory",
  useGlobalMemory: "lastSelectedUseGlobalMemory",
  uiControlEnabled: "lastSelectedUiControlEnabled",
} as const;

export interface ChatDefaults {
  provider?: ConfiguredModelProvider;
  models: Partial<Record<ConfiguredModelProvider, string>>;
  mode?: RunMode;
  reasoning?: ReasoningMode;
  sessionMemoryEnabled?: boolean;
  useWorkspaceMemory?: boolean;
  useGlobalMemory?: boolean;
  uiControlEnabled?: boolean;
}

interface ShellSnapshot {
  state: Record<string, unknown>;
  revision: number;
}

export const getDesktopDataDirectory = (): string => {
  if (process.env.MACHDOCH_USER_CONFIG_DIR?.trim())
    return join(dirname(getUserConfigPath()), "desktop");
  if (process.platform === "win32")
    return join(
      process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
      "com.machdoch.desktop",
    );
  if (process.platform === "darwin")
    return join(
      homedir(),
      "Library",
      "Application Support",
      "com.machdoch.desktop",
    );
  return join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "com.machdoch.desktop",
  );
};

export const getChatDefaultsPath = (): string =>
  join(getDesktopDataDirectory(), "machdoch-shell-state.snapshot.json");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const loadSnapshot = async (): Promise<ShellSnapshot> => {
  let raw: string;
  try {
    raw = await readFile(getChatDefaultsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { state: { version: 2 }, revision: 0 };
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    !isRecord(value.state) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  )
    throw new Error(
      "Chat defaults are invalid. Restore the desktop settings snapshot.",
    );
  return value as unknown as ShellSnapshot;
};

export const loadChatDefaultState = async (): Promise<
  Record<string, unknown>
> => (await loadSnapshot()).state;

export const loadChatDefaults = async (): Promise<ChatDefaults> => {
  const state = await loadChatDefaultState();
  const provider = state.lastSelectedProvider;
  const mode = state.lastSelectedMode;
  const reasoning = state.lastSelectedReasoning;
  const models: ChatDefaults["models"] = {};
  if (isRecord(state.lastSelectedModelByProvider)) {
    for (const [provider, model] of Object.entries(
      state.lastSelectedModelByProvider,
    )) {
      if (
        isConfiguredModelProvider(provider) &&
        typeof model === "string" &&
        model.trim()
      )
        models[provider] = model.trim();
    }
  }
  const defaults: ChatDefaults = {
    ...(typeof provider === "string" && isConfiguredModelProvider(provider)
      ? { provider }
      : {}),
    models,
    ...(typeof mode === "string" && isRunMode(mode) ? { mode } : {}),
    ...(typeof reasoning === "string" && isReasoningMode(reasoning)
      ? { reasoning }
      : {}),
  };
  for (const key of [
    "sessionMemoryEnabled",
    "useWorkspaceMemory",
    "useGlobalMemory",
    "uiControlEnabled",
  ] as const) {
    const value = state[CHAT_DEFAULT_SHELL_KEYS[key]];
    if (typeof value === "boolean") defaults[key] = value;
  }
  return defaults;
};

export const saveChatPreference = async (
  setting: string,
  value: unknown,
): Promise<string> => {
  const path = getChatDefaultsPath();
  await withCooperativeFileLock(path, async () => {
    const snapshot = await loadSnapshot();
    if (setting.startsWith("defaults.")) {
      const key = setting.slice(
        "defaults.".length,
      ) as keyof typeof CHAT_DEFAULT_SHELL_KEYS;
      const shellKey = CHAT_DEFAULT_SHELL_KEYS[key];
      if (!shellKey) throw new Error("Unknown chat default.");
      if (key === "model") {
        const provider =
          typeof snapshot.state.lastSelectedProvider === "string" &&
          isConfiguredModelProvider(snapshot.state.lastSelectedProvider)
            ? snapshot.state.lastSelectedProvider
            : DEFAULT_MODEL_PROVIDER;
        const models = isRecord(snapshot.state[shellKey])
          ? snapshot.state[shellKey]
          : {};
        snapshot.state.lastSelectedProvider = provider;
        snapshot.state[shellKey] = {
          ...models,
          [provider]: value || DEFAULT_MODEL_BY_PROVIDER[provider],
        };
      } else if (value === null) {
        delete snapshot.state[shellKey];
      } else {
        snapshot.state[shellKey] = value;
      }
    } else if (setting.startsWith("spoken-reply.")) {
      const voice = isRecord(snapshot.state.voice) ? snapshot.state.voice : {};
      snapshot.state.voice = {
        ...voice,
        [setting.slice("spoken-reply.".length)]: value,
      };
    } else {
      throw new Error("Unknown chat preference.");
    }
    snapshot.revision += 1;
    await writeJsonAtomically(path, snapshot, { mode: 0o600 });
    await writeFileAtomically(
      join(dirname(path), "machdoch-shell-state.snapshot.revision"),
      String(snapshot.revision),
      "utf8",
      { mode: 0o600 },
    );
  });
  return path;
};
