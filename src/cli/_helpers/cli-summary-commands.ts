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
import { resolveToolPolicies } from "../../core/policy.js";
import { getToolRegistry } from "../../core/tools.js";
import { createToolDefinitions } from "../../core/_helpers/agent-tools.js";
import type { ToolName } from "../../core/types.js";
import type { ParsedCliArgs } from "./cli-args.js";
import { writeStdoutLine } from "./cli-io.js";
import { createDiscoveryOptions, formatProfileLine } from "./cli-output.js";

export const printConfigSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );
  const memorySettings = await loadUserMemorySettings();

  if (args.json) {
    writeStdoutLine(JSON.stringify(config, null, 2));
    return;
  }

  const activeWebSearchConfigured =
    config.webSearch.activeProvider !== "none" &&
    config.webSearch.providerAvailability.some(
      (entry) =>
        entry.provider === config.webSearch.activeProvider && entry.configured,
    );

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(`mode: ${config.mode}`);
  writeStdoutLine(`provider: ${config.provider}`);
  writeStdoutLine(`model: ${config.model}`);
  writeStdoutLine(`offline: ${config.offline ? "true" : "false"}`);
  writeStdoutLine(`enabled tools: ${config.enabledTools.join(", ")}`);
  writeStdoutLine(`web search provider: ${config.webSearch.activeProvider}`);
  writeStdoutLine(
    `web search status: ${activeWebSearchConfigured ? "available" : "hidden"}`,
  );
  writeStdoutLine(
    `global memory: ${memorySettings.globalEnabled ? "enabled" : "disabled"} (${memorySettings.entries.length} saved fact${memorySettings.entries.length === 1 ? "" : "s"})`,
  );
  if (config.availableProfiles.length > 0) {
    writeStdoutLine("profiles:");
    for (const profile of config.availableProfiles) {
      writeStdoutLine(formatProfileLine(profile, config.activeProfile));
    }
  }
  writeStdoutLine("provider availability:");

  for (const entry of config.providerAvailability) {
    writeStdoutLine(
      `  - ${entry.provider}: ${entry.configured ? "configured" : "not configured"}`,
    );
  }
};

export const printCustomizationSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );
  const customizations = await discoverCustomizations(
    args.workspaceRoot,
    createDiscoveryOptions(config.compatibility.discoverGithubCustomizations),
  );

  if (args.json) {
    writeStdoutLine(JSON.stringify(customizations, null, 2));
    return;
  }

  writeStdoutLine(`workspace: ${customizations.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(
    `github compatibility: ${config.compatibility.discoverGithubCustomizations ? "enabled" : "disabled"}`,
  );
  writeStdoutLine(`instructions: ${customizations.instructions.length}`);
  for (const entry of customizations.instructions) {
    writeStdoutLine(`  - [${entry.kind}] ${entry.path}`);
  }
  writeStdoutLine(`prompts: ${customizations.prompts.length}`);
  for (const entry of customizations.prompts) {
    writeStdoutLine(`  - ${entry.name} (${entry.path})`);
  }
  writeStdoutLine(`skills: ${customizations.skills.length}`);
  for (const entry of customizations.skills) {
    writeStdoutLine(`  - ${entry.name} (${entry.path})`);
  }
};

export const printToolSummary = async (args: ParsedCliArgs): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );
  const toolPolicies = resolveToolPolicies(config);
  const agentTools = createToolDefinitions(config, {
    sessionEnabled: false,
    sessionEntries: [],
    globalEnabled: false,
    globalEntries: [],
  });
  const agentToolsByBackingTool = new Map(
    getToolRegistry().map((tool) => [
      tool.name,
      agentTools
        .filter((agentTool) => agentTool.backingTool === tool.name)
        .sort((left, right) => left.spec.name.localeCompare(right.spec.name)),
    ] satisfies [ToolName, typeof agentTools]),
  );

  if (args.json) {
    writeStdoutLine(JSON.stringify(toolPolicies, null, 2));
    return;
  }

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`profile: ${config.activeProfile ?? "none"}`);
  writeStdoutLine(`mode: ${config.mode}`);
  writeStdoutLine(`registered tools: ${getToolRegistry().length}`);
  writeStdoutLine(`agent tools: ${agentTools.length}`);

  for (const policy of toolPolicies) {
    writeStdoutLine(
      `- ${policy.tool.name} [${policy.tool.riskLevel}] -> ${policy.decision}`,
    );
    writeStdoutLine(`  ${policy.tool.description}`);
    writeStdoutLine(`  ${policy.reason}`);

    const backingAgentTools = agentToolsByBackingTool.get(policy.tool.name);

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

export const printProfileSummary = async (
  args: ParsedCliArgs,
): Promise<void> => {
  const config = await loadRuntimeConfig(
    args.workspaceRoot,
    args.mode,
    args.profile,
    args.model,
    args.runtimeProvider,
  );

  if (args.json) {
    writeStdoutLine(
      JSON.stringify(
        {
          workspaceRoot: config.workspaceRoot,
          activeProfile: config.activeProfile ?? null,
          availableProfiles: config.availableProfiles,
        },
        null,
        2,
      ),
    );
    return;
  }

  writeStdoutLine(`workspace: ${config.workspaceRoot}`);
  writeStdoutLine(`active profile: ${config.activeProfile ?? "none"}`);

  if (config.availableProfiles.length === 0) {
    writeStdoutLine("profiles: none configured");
    return;
  }

  writeStdoutLine("profiles:");
  for (const profile of config.availableProfiles) {
    writeStdoutLine(formatProfileLine(profile, config.activeProfile));
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

  writeStdoutLine(`workspace: ${args.workspaceRoot}`);
  writeStdoutLine(`updated config: ${configPath}`);
  writeStdoutLine(`default model: ${model}`);
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

  writeStdoutLine(`provider: ${provider}`);
  writeStdoutLine(`updated user config: ${configPath}`);
  writeStdoutLine("status: configured");
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

  writeStdoutLine(`updated user config: ${configPath}`);
  writeStdoutLine(`global memory: ${enabled ? "enabled" : "disabled"}`);
};

const fail = (message: string): never => {
  throw new Error(message);
};
