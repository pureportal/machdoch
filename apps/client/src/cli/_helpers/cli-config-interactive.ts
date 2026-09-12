import process from "node:process";
import { VALID_MODEL_PROVIDERS } from "../../core/runtime-contract.generated.js";
import {
  CLI_CONFIG_SETTING_DEFINITIONS,
  loadCliConfigEntries,
  saveConfigSetting,
} from "./cli-config-commands.js";
import type {
  CliConfigEntry,
  CliConfigSettingDefinition,
} from "./cli-config-commands.js";
import { createTerminalPrompter } from "./cli-prompter.js";
import type {
  InteractiveMenuChoice,
  InteractivePrompter,
} from "./cli-prompter.js";
import { InteractiveInputCancelledError } from "./cli-interactive-commands.js";
export { moveMenuSelection } from "./cli-prompter.js";
export type { InteractiveMenuChoice } from "./cli-prompter.js";
export type InteractiveConfigPrompter = InteractivePrompter;

const normalizeCurrentChoice = (entry: CliConfigEntry): string => {
  if (typeof entry.value === "boolean") {
    return entry.value ? "on" : "off";
  }
  return String(entry.value);
};

const createSettingChoices = (
  definitions: readonly CliConfigSettingDefinition[],
  entries: readonly CliConfigEntry[],
): InteractiveMenuChoice[] => [
  ...definitions.map((definition) => {
    const entry = entries.find(
      (candidate) => candidate.setting === definition.setting,
    );
    return {
      value: definition.setting,
      label: `${definition.setting} - ${entry ? String(entry.value) : "unknown"}`,
      description: definition.description,
    };
  }),
  { value: "__back", label: "Back" },
];

const promptReviewModel = async (
  prompter: InteractiveConfigPrompter,
  currentValue: string,
): Promise<string | undefined> => {
  const mode = await prompter.select(
    "Review model",
    [
      { value: "base", label: "Use the base task model" },
      { value: "dedicated", label: "Use a dedicated review model" },
    ],
    {
      currentValue: currentValue === "base" ? "base" : "dedicated",
    },
  );
  if (!mode || mode === "base") return mode;

  const separator = currentValue.indexOf(":");
  const currentProvider =
    separator > 0 ? currentValue.slice(0, separator) : undefined;
  const provider = await prompter.select(
    "Review provider",
    VALID_MODEL_PROVIDERS.map((value) => ({ value, label: value })),
    currentProvider ? { currentValue: currentProvider } : undefined,
  );
  if (!provider) return undefined;

  const currentModel =
    currentProvider === provider ? currentValue.slice(separator + 1) : "";
  const model = await prompter.input("Review model id", {
    initialValue: currentModel,
    hint: `Model id for ${provider}`,
  });
  return model ? `${provider}:${model}` : undefined;
};

const promptSettingValue = async (
  prompter: InteractiveConfigPrompter,
  definition: CliConfigSettingDefinition,
  entry: CliConfigEntry,
): Promise<string | undefined> => {
  if (definition.setting === "review-model") {
    return await promptReviewModel(prompter, String(entry.value));
  }

  if (definition.choices) {
    return await prompter.select(
      definition.setting,
      definition.choices.map((value) => ({ value, label: value })),
      {
        currentValue: normalizeCurrentChoice(entry),
        hint: definition.description,
      },
    );
  }

  const initialValue =
    definition.setting.startsWith("agent-cli.") &&
    (entry.source === "PATH" || entry.source === "default")
      ? ""
      : definition.setting.startsWith("agent-limits.") &&
          typeof entry.value !== "number"
        ? ""
        : String(entry.value);

  return await prompter.input(definition.setting, {
    ...(definition.secret ? { secret: true } : { initialValue }),
    hint: `${definition.description} Accepted: ${definition.acceptedValues}`,
  });
};

export const runInteractiveConfig = async (
  workspaceRoot: string,
  options?: {
    prompter?: InteractiveConfigPrompter;
    loadEntries?: typeof loadCliConfigEntries;
    saveSetting?: typeof saveConfigSetting;
  },
): Promise<void> => {
  const prompter =
    options?.prompter ??
    createTerminalPrompter({ title: "Machdoch configuration" });
  const loadEntries = options?.loadEntries ?? loadCliConfigEntries;
  const saveSetting = options?.saveSetting ?? saveConfigSetting;
  const categories = Array.from(
    new Set(CLI_CONFIG_SETTING_DEFINITIONS.map((setting) => setting.category)),
  );
  let finalMessage: string | undefined;

  try {
    while (true) {
      const category = await prompter.select("Choose a settings group", [
        ...categories.map((value) => ({ value, label: value })),
        { value: "__done", label: "Exit configuration" },
      ]);
      if (!category || category === "__done") break;

      while (true) {
        const entries = await loadEntries(workspaceRoot);
        const definitions = CLI_CONFIG_SETTING_DEFINITIONS.filter(
          (setting) => setting.category === category,
        );
        const setting = await prompter.select(
          `${category} settings`,
          createSettingChoices(definitions, entries),
        );
        if (!setting || setting === "__back") break;

        const definition = definitions.find(
          (candidate) => candidate.setting === setting,
        );
        const entry = entries.find(
          (candidate) => candidate.setting === setting,
        );
        if (!definition || !entry) continue;

        const value = await promptSettingValue(prompter, definition, entry);
        if (value === undefined) continue;

        try {
          await saveSetting(workspaceRoot, setting, value);
          prompter.status(`${setting} updated.`);
        } catch (error) {
          prompter.status(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      }
    }
    finalMessage = "Configuration complete.";
  } catch (error) {
    if (!(error instanceof InteractiveInputCancelledError)) throw error;
    process.exitCode = 130;
    finalMessage = "Configuration cancelled.";
  } finally {
    prompter.close(finalMessage);
  }
};
