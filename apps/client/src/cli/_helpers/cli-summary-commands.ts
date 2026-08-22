import {
  loadRuntimeConfig,
  saveWorkspaceDefaultModel,
} from "../../core/config.js";
import { discoverCustomizations } from "../../core/customizations.js";
import {
  loadUserMemorySettings,
  saveUserApiKey,
  saveUserGlobalMemoryEnabled,
} from "../../core/env.js";
import { createToolDefinitions } from "../../core/_helpers/agent-tools.js";
import type { ToolName } from "../../core/runtime-contract.generated.js";
import { getToolRegistry } from "../../core/tools.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";
import { createDiscoveryOptions } from "./cli-output.js";
import { createCliStyle, formatKeyValueRows } from "./cli-terminal.js";

const fail = (message: string): never => {
  throw new Error(message);
};

export const printCustomizationSummary = async (
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
  const customizations = await discoverCustomizations(
    args.workspaceRoot,
    createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
  );

  if (args.json) {
    writeStdoutLine(JSON.stringify(customizations, null, 2));
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.heading("Discovered customizations"));
  for (const line of formatKeyValueRows([
    ["Workspace", customizations.workspaceRoot],
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
  writeStdoutLine(style.label(`Prompts (${customizations.prompts.length})`));
  for (const entry of customizations.prompts) {
    writeStdoutLine(`  - ${entry.name} (${entry.path})`);
  }
  if (customizations.prompts.length === 0) writeStdoutLine("  none");
  writeStdoutLine();
  writeStdoutLine(style.label(`Skills (${customizations.skills.length})`));
  for (const entry of customizations.skills) {
    writeStdoutLine(`  - ${entry.name} (${entry.path})`);
  }
  if (customizations.skills.length === 0) writeStdoutLine("  none");
};

export const printToolSummary = async (args: ParsedCliArgs): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.model,
    args.runtimeProvider,
    args.agentLimits,
    args.reasoning,
  );
  const agentTools = createToolDefinitions(config, {
    sessionEnabled: false,
    sessionEntries: [],
    globalEnabled: false,
    globalEntries: [],
  });
  const agentToolsByBackingTool = new Map(
    getToolRegistry().map(
      (tool) =>
        [
          tool.name,
          agentTools
            .filter((agentTool) => agentTool.backingTool === tool.name)
            .sort((left, right) =>
              left.spec.name.localeCompare(right.spec.name),
            ),
        ] satisfies [ToolName, typeof agentTools],
    ),
  );

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: config.workspaceRoot,
          mode: config.mode,
          modeSurface:
            config.mode === "ask"
              ? "read-only function calls"
              : "all function calls",
          tools: getToolRegistry(),
          agentTools: agentTools.map((agentTool) => ({
            name: agentTool.spec.name,
            backingTool: agentTool.backingTool,
            riskLevel: agentTool.riskLevel,
            effect: agentTool.effect,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.heading("Machdoch tools"));
  for (const line of formatKeyValueRows([
    ["Workspace", config.workspaceRoot],
    ["Mode", config.mode],
    [
      "Function-call surface",
      config.mode === "ask" ? "read-only calls only" : "all calls",
    ],
    ["Registered tools", String(getToolRegistry().length)],
    ["Agent tools", String(agentTools.length)],
  ])) {
    writeStdoutLine(line);
  }
  writeStdoutLine();

  for (const tool of getToolRegistry()) {
    writeStdoutLine(style.label(`${tool.name} [${tool.riskLevel}]`));
    writeStdoutLine(`  ${tool.description}`);

    const backingAgentTools = agentToolsByBackingTool.get(tool.name);
    if (backingAgentTools && backingAgentTools.length > 0) {
      writeStdoutLine("  agent tools:");
      for (const agentTool of backingAgentTools) {
        writeStdoutLine(
          `    - ${agentTool.spec.name} [${agentTool.riskLevel}]`,
        );
      }
    }
  }
};

export const printMemorySummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const settings = await loadUserMemorySettings();

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          globalEnabled: settings.globalEnabled,
          count: settings.entries.length,
          entries: settings.entries,
        },
        null,
        2,
      ),
    );
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.heading("Global memory"));
  for (const line of formatKeyValueRows([
    ["Enabled", settings.globalEnabled ? "yes" : "no"],
    ["Saved facts", String(settings.entries.length)],
  ])) {
    writeStdoutLine(line);
  }

  if (settings.entries.length === 0) {
    writeStdoutLine();
    writeStdoutLine(style.muted("No global memory facts are saved."));
    return;
  }

  for (const [index, entry] of settings.entries.entries()) {
    writeStdoutLine();
    writeStdoutLine(style.label(`${index + 1}.`));
    for (const contentLine of entry.content.split(/\r?\n/u)) {
      writeStdoutLine(`  ${contentLine}`);
    }
    for (const line of formatKeyValueRows([
      ["Id", entry.id],
      ["Updated", new Date(entry.updatedAt).toISOString()],
    ])) {
      writeStdoutLine(line);
    }
  }
};

export const printDefaultModelSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const model = args.defaultModel ?? fail("No default model was provided.");
  const configPath = await saveWorkspaceDefaultModel(args.workspaceRoot, model);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: args.workspaceRoot,
          configPath,
          model,
        },
        null,
        2,
      ),
    );
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.success("Configuration updated"));
  for (const line of formatKeyValueRows([
    ["Setting", "workspace.model"],
    ["Value", model],
    ["Workspace", args.workspaceRoot],
    ["Config file", configPath],
  ])) {
    writeStdoutLine(line);
  }
};

export const printSetApiSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const provider = args.provider ?? fail("No provider was provided.");
  const key = args.key ?? fail("No API key was provided.");
  const configPath = await saveUserApiKey(provider, key);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          provider,
          configured: true,
          configPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.success("Configuration updated"));
  for (const line of formatKeyValueRows([
    ["Setting", `api.${provider}.key`],
    ["Value", "configured"],
    ["Config file", configPath],
  ])) {
    writeStdoutLine(line);
  }
};

export const printSetGlobalMemorySummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const enabled =
    args.setGlobalMemoryEnabled ??
    fail("No global-memory setting was provided.");
  const configPath = await saveUserGlobalMemoryEnabled(enabled);

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          globalMemoryEnabled: enabled,
          configPath,
        },
        null,
        2,
      ),
    );
    return;
  }

  const style = createCliStyle();
  writeStdoutLine(style.success("Configuration updated"));
  for (const line of formatKeyValueRows([
    ["Setting", "memory.global"],
    ["Value", enabled ? "enabled" : "disabled"],
    ["Config file", configPath],
  ])) {
    writeStdoutLine(line);
  }
};
