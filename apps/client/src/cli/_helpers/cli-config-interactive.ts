import process from "node:process";
import { VALID_MODEL_PROVIDERS } from "../../core/runtime-contract.generated.js";
import {
  CLI_CONFIG_SETTING_DEFINITIONS,
  loadCliConfigEntries,
  saveConfigSetting,
  clearConfigSetting,
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
import { getProviderModelMetadata } from "../../core/provider-model-registry.js";
import {
  DESKTOP_CONFIG_DEFINITIONS,
  requestDesktopSettings,
} from "./cli-desktop-config.js";
import { editPrompt } from "./cli-editor.js";
import {
  loadConfigDocument,
  saveConfigDocument,
} from "./cli-config-documents.js";
import { runConfigTransfer } from "./cli-config-transfer.js";
import { clipTerminalText } from "./cli-terminal-text.js";
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
  searching: boolean,
): InteractiveMenuChoice[] => [
  ...definitions.map((definition) => {
    const entry = entries.find(
      (candidate) => candidate.setting === definition.setting,
    );
    return {
      value: definition.setting,
      label: `${searching ? `${definition.category} · ` : ""}${definition.label ?? definition.setting}  ${entry ? clipTerminalText(String(entry.value), 36) : ""}${entry?.source === "environment" ? " (environment)" : ""}`,
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
  entries: readonly CliConfigEntry[],
): Promise<string | undefined> => {
  if (definition.setting === "review-model") {
    return await promptReviewModel(prompter, String(entry.value));
  }

  if (definition.choices) {
    return await prompter.select(
      definition.label ?? definition.setting,
      [
        ...definition.choices.map((value) => ({ value, label: value })),
        {
          value: "__reset",
          label:
            definition.setting === "answer-language"
              ? "Remove preference"
              : "Reset",
        },
      ],
      {
        currentValue: normalizeCurrentChoice(entry),
      },
    );
  }

  const action = await prompter.select(
    definition.label ?? definition.setting,
    [
      { value: "__edit", label: "Change value" },
      {
        value: "__reset",
        label:
          definition.setting === "answer-language"
            ? "Remove preference"
            : "Reset",
      },
    ],
    entry.source === "environment"
      ? { hint: "An environment variable overrides the saved value." }
      : {},
  );
  if (action !== "__edit") return action;
  if (
    ["workspace.model", "defaults.model", "internal-task.model"].includes(
      definition.setting,
    )
  ) {
    const providerSetting = definition.setting.replace(/model$/u, "provider");
    const provider = entries.find(
      (entry) => entry.setting === providerSetting,
    )?.value;
    if (
      VALID_MODEL_PROVIDERS.includes(
        provider as (typeof VALID_MODEL_PROVIDERS)[number],
      )
    ) {
      const model = await prompter.select(
        "Model",
        [
          ...getProviderModelMetadata(
            provider as (typeof VALID_MODEL_PROVIDERS)[number],
          )
            .filter(
              (model) =>
                model.lifecycle !== "deprecated" && model.capabilities.toolUse,
            )
            .map((model) => ({ value: model.id, label: model.label })),
          { value: "__custom", label: "Enter model id" },
        ],
        { currentValue: String(entry.value) },
      );
      if (model !== "__custom") return model;
    }
  }
  if (definition.multiline)
    return await prompter.suspend(() => editPrompt(String(entry.value)));

  const initialValue =
    definition.setting.startsWith("agent-cli.") &&
    (entry.source === "PATH" || entry.source === "default")
      ? ""
      : definition.setting.startsWith("agent-limits.") &&
          typeof entry.value !== "number"
        ? ""
        : String(entry.value);

  return await prompter.input(definition.label ?? definition.setting, {
    ...(definition.secret ? { secret: true } : { initialValue }),
    ...(!definition.secret ? { hint: definition.acceptedValues } : {}),
  });
};

export const runInteractiveConfig = async (
  workspaceRoot: string,
  options?: {
    prompter?: InteractiveConfigPrompter;
    loadEntries?: typeof loadCliConfigEntries;
    saveSetting?: typeof saveConfigSetting;
    clearSetting?: typeof clearConfigSetting;
  },
): Promise<void> => {
  const prompter =
    options?.prompter ??
    createTerminalPrompter({ title: "Machdoch configuration" });
  const loadEntries = options?.loadEntries ?? loadCliConfigEntries;
  const saveSetting = options?.saveSetting ?? saveConfigSetting;
  const clearSetting = options?.clearSetting ?? clearConfigSetting;
  const categories = Array.from(
    new Set(CLI_CONFIG_SETTING_DEFINITIONS.map((setting) => setting.category)),
  );
  let finalMessage: string | undefined;

  try {
    while (true) {
      let category = await prompter.select("Settings", [
        { value: "Workspace", label: "Workspace settings" },
        { value: "__global", label: "Global settings" },
        { value: "__defaults", label: "Defaults" },
        { value: "__search", label: "Find a setting" },
        { value: "__transfer", label: "Transfer settings" },
        { value: "__actions", label: "Desktop actions" },
        { value: "__done", label: "Exit configuration" },
      ]);
      if (!category || category === "__done") break;
      if (category === "__transfer") {
        try {
          await runConfigTransfer(prompter, workspaceRoot);
        } catch (error) {
          prompter.status(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
        continue;
      }
      if (category === "__global") {
        category = await prompter.select(
          "Global settings",
          categories
            .filter(
              (category) =>
                ![
                  "Workspace",
                  "Session defaults",
                  "New chat defaults",
                ].includes(category),
            )
            .map((value) => ({ value, label: value })),
        );
        if (!category) continue;
      }
      if (category === "__actions") {
        const action = await prompter.select("Desktop actions", [
          { value: "desktop.clear-cache", label: "Clear WebView cache" },
          { value: "assets.resume", label: "Resume asset move" },
        ]);
        if (!action) continue;
        if (
          action === "desktop.clear-cache" &&
          (await prompter.select("Clear cached browser data?", [
            { value: "no", label: "Keep data" },
            { value: "yes", label: "Clear data" },
          ])) !== "yes"
        )
          continue;
        try {
          await requestDesktopSettings("action", action);
          prompter.status(
            action === "desktop.clear-cache"
              ? "Cache cleared."
              : "Asset move resumed.",
          );
        } catch (error) {
          prompter.status(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
        continue;
      }

      while (true) {
        const entries = await loadEntries(workspaceRoot);
        const definitions = CLI_CONFIG_SETTING_DEFINITIONS.filter(
          (setting) =>
            category === "__search" ||
            (category === "__defaults"
              ? ["Session defaults", "New chat defaults"].includes(
                  setting.category,
                )
              : setting.category === category),
        );
        const setting = await prompter.select(
          category === "__search"
            ? "Find a setting"
            : category === "__defaults"
              ? "Defaults"
              : `${category} settings`,
          createSettingChoices(definitions, entries, category === "__search"),
        );
        if (!setting || setting === "__back") break;

        const definition = definitions.find(
          (candidate) => candidate.setting === setting,
        );
        const entry = entries.find(
          (candidate) => candidate.setting === setting,
        );
        if (!definition || !entry) continue;
        if (entry.unavailable) {
          prompter.status(entry.unavailable, "error");
          continue;
        }
        if (definition.document) {
          try {
            const document = await loadConfigDocument(workspaceRoot, setting);
            const raw = await prompter.suspend(() => editPrompt(document.raw));
            if (raw !== document.raw)
              await saveConfigDocument(workspaceRoot, setting, raw, document);
            prompter.status(`${definition.label ?? setting} saved.`);
          } catch (error) {
            prompter.status(
              error instanceof Error ? error.message : String(error),
              "error",
            );
          }
          continue;
        }

        let value: string | undefined;
        try {
          value = await promptSettingValue(
            prompter,
            definition,
            entry,
            entries,
          );
        } catch (error) {
          if (error instanceof InteractiveInputCancelledError) throw error;
          prompter.status(
            error instanceof Error ? error.message : String(error),
            "error",
          );
          continue;
        }
        if (value === undefined) continue;

        try {
          const native = DESKTOP_CONFIG_DEFINITIONS.find(
            (definition) => definition.setting === setting,
          );
          if (
            native?.consequence &&
            (await prompter.select(native.consequence, [
              { value: "no", label: "Cancel" },
              { value: "yes", label: "Move assets" },
            ])) !== "yes"
          )
            continue;
          if (value === "__reset") await clearSetting(workspaceRoot, setting);
          else await saveSetting(workspaceRoot, setting, value);
          prompter.status(
            `${definition.label ?? setting} ${value === "__reset" ? "reset" : "updated"}.${entry.source === "environment" ? " The environment value still applies." : ""}`,
          );
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
