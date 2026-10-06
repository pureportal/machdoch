import process from "node:process";
import { loadRuntimeConfig } from "../../core/config.js";
import { loadUserMemorySettings } from "../../core/env.js";
import { resolveRuntimeAgentLimits } from "../../core/_helpers/agent-runtime-types.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";
import { createUserConfigSummaryLines } from "./cli-output.js";
import { createCliStyle, formatKeyValueRows } from "./cli-terminal.js";
import {
  ADDITIONAL_CONFIG_SETTINGS,
  loadAdditionalConfigEntries,
} from "./cli-config-additional.js";
import {
  DESKTOP_CONFIG_DEFINITIONS,
  loadDesktopConfigEntries,
} from "./cli-desktop-config.js";
import {
  CONFIG_DOCUMENT_DEFINITIONS,
  loadConfigDocumentEntries,
} from "./cli-config-documents.js";
import { configSettingLabel } from "./cli-config-labels.js";
import {
  WORKSPACE_CONFIG_DEFINITIONS,
  workspaceConfigFamily,
} from "./cli-config-workspace.js";
import {
  PROVIDER_CONFIG_DEFINITIONS,
  VOICE_CONFIG_DEFINITIONS,
  providersConfigFamily,
} from "./cli-config-providers.js";
import {
  ANSWER_LANGUAGE_CONFIG_DEFINITIONS,
  AGENT_PREFERENCE_CONFIG_DEFINITIONS,
  agentConfigFamily,
} from "./cli-config-agent.js";
import {
  USER_DESKTOP_CONFIG_DEFINITIONS,
  userDesktopConfigFamily,
} from "./cli-config-user-desktop.js";
import {
  WORKSPACE_RUN_CONFIG_DEFINITIONS,
  workspaceRunConfigFamily,
} from "./cli-config-workspace-run.js";
import type {
  CliConfigFamily,
  ConfigSetResult,
  CliConfigEntry,
} from "./cli-config-types.js";
import { loadConfigSnapshot } from "./cli-config-snapshot.js";
import { fail, unsupportedConfigSetting } from "./cli-config-values.js";
import { additionalConfigFamily } from "./cli-config-additional.js";
import { desktopConfigFamily } from "./cli-desktop-config.js";
import { documentConfigFamily } from "./cli-config-documents.js";
export const CLI_CONFIG_SETTING_DEFINITIONS = [
  ...ADDITIONAL_CONFIG_SETTINGS,
  ...DESKTOP_CONFIG_DEFINITIONS,
  ...CONFIG_DOCUMENT_DEFINITIONS,
  ...ANSWER_LANGUAGE_CONFIG_DEFINITIONS,
  ...WORKSPACE_CONFIG_DEFINITIONS,
  ...PROVIDER_CONFIG_DEFINITIONS,
  ...AGENT_PREFERENCE_CONFIG_DEFINITIONS,
  ...VOICE_CONFIG_DEFINITIONS,
  ...USER_DESKTOP_CONFIG_DEFINITIONS,
  ...WORKSPACE_RUN_CONFIG_DEFINITIONS,
].map((definition) => ({
  ...definition,
  label: definition.label ?? configSettingLabel(definition.setting),
}));
const configFamilies: readonly CliConfigFamily[] = [
  documentConfigFamily,
  additionalConfigFamily,
  desktopConfigFamily,
  agentConfigFamily,
  workspaceConfigFamily,
  providersConfigFamily,
  userDesktopConfigFamily,
  workspaceRunConfigFamily,
];
const findFamily = (setting: string): CliConfigFamily | undefined =>
  configFamilies.find((family) =>
    family.definitions.some((definition) => definition.setting === setting),
  );
export const saveConfigSetting = async (
  workspaceRoot: string,
  setting: string,
  value: string,
): Promise<ConfigSetResult> => {
  const normalizedSetting = setting.trim().toLowerCase();
  const family =
    findFamily(normalizedSetting) ??
    (normalizedSetting.split(".").length === 2 &&
    normalizedSetting.startsWith("desktop.")
      ? userDesktopConfigFamily
      : undefined);
  if (!family) return unsupportedConfigSetting(setting);
  return await family.save(workspaceRoot, setting, value);
};
export const clearConfigSetting = async (
  workspaceRoot: string,
  setting: string,
): Promise<ConfigSetResult> => {
  const family = findFamily(setting.trim().toLowerCase());
  if (!family) return unsupportedConfigSetting(setting);
  return await family.reset(workspaceRoot, setting);
};
export const loadCliConfigEntries = async (
  workspaceRoot: string,
): Promise<CliConfigEntry[]> => {
  const snapshot = await loadConfigSnapshot(workspaceRoot);
  const additional = await loadAdditionalConfigEntries(workspaceRoot);
  const desktop = await loadDesktopConfigEntries();
  const documents = await loadConfigDocumentEntries(workspaceRoot);
  return CLI_CONFIG_SETTING_DEFINITIONS.map((definition) => {
    const loaded =
      additional.find((entry) => entry.setting === definition.setting) ??
      desktop.find((entry) => entry.setting === definition.setting) ??
      documents.find((entry) => entry.setting === definition.setting);
    if (loaded) return loaded;
    const family = findFamily(definition.setting);
    if (!family?.resolve) return unsupportedConfigSetting(definition.setting);
    return family.resolve(definition, snapshot);
  });
};

const printConfigList = async (args: ParsedCliArgs): Promise<void> => {
  const entries = await loadCliConfigEntries(args.workspaceRoot);
  const runtime = await loadRuntimeConfig(args.workspaceRoot);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: args.workspaceRoot,
          workspaceConfigPath: runtime.workspaceConfigPath ?? null,
          userConfigPath: runtime.userConfigPath ?? null,
          settings: entries,
        },
        null,
        2,
      ),
    );
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.heading("Machdoch configuration settings"));
  writeStdoutLine(style.muted(`Workspace: ${args.workspaceRoot}`));

  for (const category of Array.from(
    new Set(entries.map((entry) => entry.category)),
  )) {
    writeStdoutLine();
    writeStdoutLine(style.label(category));
    const rows = entries
      .filter((entry) => entry.category === category)
      .map(
        (entry) =>
          [
            entry.setting,
            `${String(entry.value)} ${style.muted(`(${entry.source})`)}`,
          ] as const,
      );
    for (const line of formatKeyValueRows(rows)) writeStdoutLine(line);
  }

  writeStdoutLine();
  writeStdoutLine(
    style.muted(
      "Use `machdoch config get <setting>` for details or `machdoch config edit` for the interactive editor.",
    ),
  );
};

const printConfigEntry = async (args: ParsedCliArgs): Promise<void> => {
  const requested =
    args.config?.setting?.trim().toLowerCase() ??
    fail("Expected `machdoch config get <setting>`.");
  const entry = (await loadCliConfigEntries(args.workspaceRoot)).find(
    (candidate) => candidate.setting === requested,
  );
  if (!entry) return unsupportedConfigSetting(requested);

  if (args.json) {
    writeStdoutLine(JSON.stringify(entry, null, 2));
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.heading(entry.setting));
  for (const line of formatKeyValueRows([
    ["Value", String(entry.value)],
    ["Source", entry.source],
    ["Scope", entry.scope],
    ["Accepted", entry.acceptedValues],
  ])) {
    writeStdoutLine(line);
  }
  writeStdoutLine();
  writeStdoutLine(entry.description);
};

export const printConfigSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );
  const memorySettings = await loadUserMemorySettings();
  const agentLimits = resolveRuntimeAgentLimits(config);
  const formatLimit = (limit: number | null): string =>
    limit === null ? "infinite" : String(limit);

  if (args.json) {
    writeStdoutLine(JSON.stringify(config, null, 2));
    return;
  }

  const style = createCliStyle();
  const activeWebSearchConfigured =
    config.webSearch.activeProvider !== "none" &&
    config.webSearch.providerAvailability.some(
      (entry) =>
        entry.provider === config.webSearch.activeProvider && entry.configured,
    );

  writeStdoutLine(style.heading("Machdoch configuration"));
  for (const line of formatKeyValueRows([
    ["Workspace", config.workspaceRoot],
    ["Workspace config", config.workspaceConfigPath ?? "not present"],
    ["User config", config.userConfigPath ?? "unknown"],
  ])) {
    writeStdoutLine(line);
  }
  for (const line of createUserConfigSummaryLines(config.userConfigPath).slice(
    1,
  )) {
    writeStdoutLine(style.warning(line));
  }

  writeStdoutLine();
  writeStdoutLine(style.label("Runtime"));
  for (const line of formatKeyValueRows([
    ["Mode", config.mode],
    ["Provider", config.provider],
    ["Model", config.model],
    ["Reasoning", config.reasoning],
    ["Reasoning mode", config.reasoningMode ?? "standard"],
    ["Context window", String(config.contextWindow ?? "default")],
    ["Offline", String(config.offline)],
    ["Executor turns", formatLimit(agentLimits.executorTurns)],
    [
      "Machdoch continuations",
      formatLimit(agentLimits.autopilotExecutorIterations),
    ],
    [
      "Review model",
      config.reviewModel.mode === "dedicated"
        ? `${config.reviewModel.provider}:${config.reviewModel.model}`
        : "base model",
    ],
  ])) {
    writeStdoutLine(line);
  }

  writeStdoutLine();
  writeStdoutLine(style.label("Capabilities"));
  for (const line of formatKeyValueRows([
    ["Web search provider", config.webSearch.activeProvider],
    [
      "Web search status",
      activeWebSearchConfigured ? "available" : "not available",
    ],
    [
      "Global memory",
      `${memorySettings.globalEnabled ? "enabled" : "disabled"} (${memorySettings.entries.length} saved fact${memorySettings.entries.length === 1 ? "" : "s"})`,
    ],
    [
      "GitHub customizations",
      config.compatibility.discoverGithubCustomizations
        ? "enabled"
        : "disabled",
    ],
  ])) {
    writeStdoutLine(line);
  }

  writeStdoutLine();
  writeStdoutLine(style.label("Provider availability"));
  for (const line of formatKeyValueRows(
    config.providerAvailability.map((entry) => [
      entry.provider,
      entry.configured ? "configured" : "not configured",
    ]),
  )) {
    writeStdoutLine(line);
  }

  writeStdoutLine();
  writeStdoutLine(
    style.muted(
      "Run `machdoch config list` to inspect every setting or `machdoch config edit` to configure interactively.",
    ),
  );
};

export const printSetConfigSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const setting =
    args.config?.setting ?? fail("No config setting was provided.");
  const value = args.config?.value ?? fail("No config value was provided.");
  const result = await saveConfigSetting(args.workspaceRoot, setting, value);

  if (args.json) {
    writeStdoutLine(JSON.stringify(result, null, 2));
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.success("Configuration updated"));
  for (const line of formatKeyValueRows([
    ["Setting", result.setting],
    ...(result.value !== undefined
      ? [["Value", String(result.value)] as const]
      : []),
    ["Scope", result.scope],
    ["Config file", result.configPath],
  ])) {
    writeStdoutLine(line);
  }
};

const printUnsetConfigSummary = async (args: ParsedCliArgs): Promise<void> => {
  const setting =
    args.config?.setting ?? fail("No config setting was provided.");
  const result = await clearConfigSetting(args.workspaceRoot, setting);

  if (args.json) {
    writeStdoutLine(JSON.stringify(result, null, 2));
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(
    style.success(
      result.setting === "answer-language"
        ? "Answer language cleared"
        : "Configuration reset",
    ),
  );
  for (const line of formatKeyValueRows([
    ["Setting", result.setting],
    ["Scope", result.scope],
    ["Config file", result.configPath],
  ])) {
    writeStdoutLine(line);
  }
  if (result.setting !== "answer-language") {
    writeStdoutLine(
      style.muted("The effective default or environment value now applies."),
    );
  }
};

export const runConfigCommand = async (args: ParsedCliArgs): Promise<void> => {
  switch (args.config?.action ?? "show") {
    case "show":
      await printConfigSummary(args);
      return;
    case "list":
      await printConfigList(args);
      return;
    case "get":
      await printConfigEntry(args);
      return;
    case "set":
      await printSetConfigSummary(args);
      return;
    case "unset":
      await printUnsetConfigSummary(args);
      return;
    case "edit": {
      if (args.json) {
        fail("Interactive configuration does not support --json.");
      }
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        fail(
          "Interactive configuration requires a terminal. Use `machdoch config list` and `machdoch config set <setting> <value>` in scripts.",
        );
      }
      const { runInteractiveConfig } =
        await import("./cli-config-interactive.js");
      await runInteractiveConfig(args.workspaceRoot);
      return;
    }
  }
};
