import process from "node:process";
import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
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
import { createCliStyle } from "./cli-terminal.js";

export interface InteractiveMenuChoice {
  value: string;
  label: string;
  description?: string;
}

export interface InteractiveConfigPrompter {
  select(
    title: string,
    choices: readonly InteractiveMenuChoice[],
    options?: { currentValue?: string; hint?: string },
  ): Promise<string | undefined>;
  input(
    title: string,
    options?: { initialValue?: string; secret?: boolean; hint?: string },
  ): Promise<string | undefined>;
  status(message: string): void;
  close(message?: string): void;
}

export const moveMenuSelection = (
  index: number,
  keyName: string | undefined,
  choiceCount: number,
): number => {
  if (choiceCount <= 0) return 0;
  if (keyName === "home") return 0;
  if (keyName === "end") return choiceCount - 1;
  if (keyName === "up" || keyName === "k") {
    return (index - 1 + choiceCount) % choiceCount;
  }
  if (keyName === "down" || keyName === "j") {
    return (index + 1) % choiceCount;
  }
  return index;
};

class InteractiveConfigCancelledError extends Error {
  constructor() {
    super("Interactive configuration cancelled.");
    this.name = "InteractiveConfigCancelledError";
  }
}

const normalizeCurrentChoice = (entry: CliConfigEntry): string => {
  if (typeof entry.value === "boolean") {
    return entry.value ? "on" : "off";
  }
  return String(entry.value);
};

const printableKeyText = (sequence: string | undefined): string =>
  Array.from(sequence ?? "")
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("");

export const createTerminalConfigPrompter = (options?: {
  input?: ReadStream;
  output?: WriteStream;
}): InteractiveConfigPrompter => {
  const input = options?.input ?? process.stdin;
  const output = options?.output ?? process.stdout;
  const style = createCliStyle({ isTTY: output.isTTY });
  const initiallyRaw = input.isRaw === true;
  const initiallyPaused = input.isPaused();
  let message: string | undefined;
  let closed = false;

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  const clearScreen = (): void => {
    output.write("\u001b[2J\u001b[H");
  };

  const renderHeader = (): void => {
    output.write(`${style.heading("Machdoch configuration")}\n`);
    output.write(
      `${style.muted("Use arrow keys and Enter. Press Esc to go back.")}\n`,
    );
    if (message) {
      output.write(`\n${style.success(message)}\n`);
      message = undefined;
    }
    output.write("\n");
  };

  const readKey = async (): Promise<{ text: string; key: Key }> =>
    await new Promise((resolve) => {
      input.once("keypress", (text: string, key: Key) =>
        resolve({ text, key }),
      );
    });

  const select: InteractiveConfigPrompter["select"] = async (
    title,
    choices,
    selectOptions,
  ) => {
    if (choices.length === 0) return undefined;
    let index = Math.max(
      0,
      choices.findIndex(
        (choice) => choice.value === selectOptions?.currentValue,
      ),
    );

    output.write("\u001b[?25l");
    try {
      while (true) {
        clearScreen();
        renderHeader();
        output.write(`${style.label(title)}\n`);
        if (selectOptions?.hint) {
          output.write(`${style.muted(selectOptions.hint)}\n`);
        }
        output.write("\n");

        for (const [choiceIndex, choice] of choices.entries()) {
          const active = choiceIndex === index;
          const current = choice.value === selectOptions?.currentValue;
          const marker = active ? ">" : " ";
          const currentMarker = current ? " *" : "";
          const label = `${marker} ${choice.label}${currentMarker}`;
          output.write(`${active ? style.command(label) : label}\n`);
          if (active && choice.description) {
            output.write(`    ${style.muted(choice.description)}\n`);
          }
        }

        const { text, key } = await readKey();
        if (key.ctrl && key.name === "c") {
          throw new InteractiveConfigCancelledError();
        }
        if (key.name === "escape") return undefined;
        if (key.name === "return" || key.name === "enter") {
          return choices[index]?.value;
        }

        const keyName = key.name ?? text;
        index = moveMenuSelection(index, keyName, choices.length);
      }
    } finally {
      output.write("\u001b[?25h");
    }
  };

  const readInput: InteractiveConfigPrompter["input"] = async (
    title,
    inputOptions,
  ) => {
    let value = inputOptions?.secret ? "" : (inputOptions?.initialValue ?? "");

    while (true) {
      clearScreen();
      renderHeader();
      output.write(`${style.label(title)}\n`);
      if (inputOptions?.hint) {
        output.write(`${style.muted(inputOptions.hint)}\n`);
      }
      output.write("\n");
      output.write(
        `> ${inputOptions?.secret ? "*".repeat(value.length) : value}`,
      );

      const { text, key } = await readKey();
      if (key.ctrl && key.name === "c") {
        throw new InteractiveConfigCancelledError();
      }
      if (key.name === "escape") return undefined;
      if (key.name === "return" || key.name === "enter") {
        const normalized = value.trim();
        if (normalized) {
          output.write("\n");
          return normalized;
        }
        output.write("\u0007");
        continue;
      }
      if (key.name === "backspace" || key.name === "delete") {
        value = Array.from(value).slice(0, -1).join("");
        continue;
      }
      if (!key.ctrl && !key.meta) {
        value += printableKeyText(text || key.sequence);
      }
    }
  };

  return {
    select,
    input: readInput,
    status: (nextMessage): void => {
      message = nextMessage;
    },
    close: (finalMessage): void => {
      if (closed) return;
      closed = true;
      output.write("\u001b[?25h");
      clearScreen();
      input.setRawMode(initiallyRaw);
      if (initiallyPaused) input.pause();
      if (finalMessage) output.write(`${finalMessage}\n`);
    },
  };
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
  const prompter = options?.prompter ?? createTerminalConfigPrompter();
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

        await saveSetting(workspaceRoot, setting, value);
        prompter.status(`${setting} updated.`);
      }
    }
    finalMessage = "Configuration complete.";
  } catch (error) {
    if (!(error instanceof InteractiveConfigCancelledError)) throw error;
    process.exitCode = 130;
    finalMessage = "Configuration cancelled.";
  } finally {
    prompter.close(finalMessage);
  }
};
