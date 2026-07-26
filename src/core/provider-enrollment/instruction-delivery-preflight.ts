import { extname } from "node:path";
import { loadWorkspaceEnv } from "../env.js";
import {
  isAgentCliProvider,
  resolveAgentCliProviderBinary,
} from "../_helpers/agent-cli-providers.js";
import {
  createInstructionDeliveryPlan,
  getInstructionCapabilityDescriptor,
} from "../instruction-system/delivery.js";
import type {
  FrozenInstructionSet,
  InstructionCapabilityDescriptor,
  InstructionDeliveryPlan,
} from "../instruction-system/types.js";
import type { AgentCliProvider } from "../runtime-contract.generated.js";
import { renderInstructionTransportPayload } from "../mcp/initialization-instructions.js";
import {
  createProviderProbeEvidence,
  probeProviderCli,
} from "./capability-registry.js";
import type { ProviderProbeResult } from "./types.js";

const CLAUDE_SUBAGENT_ENVELOPE_MAX_CHARS = 16_000;
const CODEX_CONFIG_OVERRIDE_MAX_CHARS = 16_000;

export const createCodexDeveloperInstructionOverride = (
  envelope: string,
): string | undefined => {
  const override = `developer_instructions=${JSON.stringify(envelope)}`;
  return override.length <= CODEX_CONFIG_OVERRIDE_MAX_CHARS
    ? override
    : undefined;
};

const requiresWindowsCommandShell = (executable: string): boolean =>
  process.platform === "win32" &&
  [".cmd", ".bat"].includes(extname(executable).toLocaleLowerCase("en-US"));

const REQUIRED_DELIVERY_FEATURES: Record<
  AgentCliProvider,
  readonly string[]
> = {
  "codex-cli": ["--config"],
  "claude-cli": [
    "--append-system-prompt-file",
    "--mcp-config",
    "--strict-mcp-config",
  ],
  "copilot-cli": [
    "--no-auto-update",
    "--no-custom-instructions",
    "--additional-mcp-config",
    "--disable-builtin-mcps",
    "--disable-mcp-server",
  ],
};

const withProviderLimit = (
  capability: InstructionCapabilityDescriptor,
  resolution: FrozenInstructionSet,
): InstructionCapabilityDescriptor => ({
  ...capability,
  ...(resolution.budget.providerLimitTokens === undefined
    ? {}
    : { maxInputTokens: resolution.budget.providerLimitTokens }),
});

export const createCliInstructionCapabilityFromProbe = (
  resolution: FrozenInstructionSet,
  probe: ProviderProbeResult,
  environment: NodeJS.ProcessEnv = process.env,
): InstructionCapabilityDescriptor => {
  const provider = resolution.providerId as AgentCliProvider;
  const base = withProviderLimit(
    getInstructionCapabilityDescriptor(provider, "cli", {
      ...(probe.version === undefined ? {} : { version: probe.version }),
      evidence: createProviderProbeEvidence(probe),
    }),
    resolution,
  );
  if (!probe.available) {
    return {
      ...base,
      authority: "none",
      contentFidelity: "none",
      acceptsArbitraryContent: false,
      nativeDiscovery: "uncontrolled",
      acceptsTemporaryInstructionFile: false,
      lifecycle: {
        initial: "unsupported",
        continuation: "unsupported",
        retry: "unsupported",
        roles: "unsupported",
        subagents: "unsupported",
      },
      mechanism: "Unavailable CLI executable",
      evidence: [
        ...base.evidence,
        "The selected CLI executable could not be version/help probed.",
      ],
    };
  }

  const features = new Set(probe.features);
  const missing = REQUIRED_DELIVERY_FEATURES[provider].filter(
    (feature) => !features.has(feature),
  );
  if (missing.length > 0) {
    return {
      ...base,
      contentFidelity: "none",
      acceptsArbitraryContent: false,
      nativeDiscovery: "uncontrolled",
      lifecycle: {
        ...base.lifecycle,
        initial: "unsupported",
        continuation: "unsupported",
        retry: "unsupported",
      },
      mechanism: `${base.mechanism} (required flags unavailable)`,
      evidence: [
        ...base.evidence,
        `The probed executable is missing required flag(s): ${missing.join(", ")}.`,
      ],
    };
  }

  if (provider === "codex-cli") {
    if (requiresWindowsCommandShell(probe.executable)) {
      return {
        ...base,
        contentFidelity: "none",
        acceptsArbitraryContent: false,
        lifecycle: {
          ...base.lifecycle,
          initial: "unsupported",
          continuation: "unsupported",
          retry: "unsupported",
        },
        mechanism: `${base.mechanism} (safe Windows argument transport unavailable)`,
        evidence: [
          ...base.evidence,
          "Codex requires the complete developer instructions in a runtime override, but a Windows .cmd/.bat wrapper would route that workspace-controlled argument through cmd.exe. Configure a native executable instead.",
        ],
      };
    }
    const transportPayload = renderInstructionTransportPayload(
      resolution.renderedEnvelope,
      resolution.mcpInitializationInstructions,
    );
    const developerOverride = createCodexDeveloperInstructionOverride(
      transportPayload,
    );
    if (developerOverride === undefined) {
      return {
        ...base,
        contentFidelity: "none",
        acceptsArbitraryContent: false,
        lifecycle: {
          ...base.lifecycle,
          initial: "unsupported",
          continuation: "unsupported",
          retry: "unsupported",
        },
        mechanism: `${base.mechanism} (safe command override unavailable)`,
        evidence: [
          ...base.evidence,
          `The complete developer-instruction override exceeds the conservative ${CODEX_CONFIG_OVERRIDE_MAX_CHARS}-character command-argument bound. A temporary CODEX_HOME alone cannot prove that closer project configuration will not replace the canonical developer instructions.`,
        ],
      };
    }
    return {
      ...base,
      evidence: [
        ...base.evidence,
        "The adapter uses the documented --config runtime override in addition to the temporary CODEX_HOME so project-scoped configuration cannot replace the canonical developer instructions.",
      ],
    };
  }

  if (provider !== "claude-cli") {
    return {
      ...base,
      evidence: [
        ...base.evidence,
        `Runtime probe observed: ${[...features].sort().join(", ") || "no required help flags"}.`,
        ...(provider === "copilot-cli"
          ? [
              "The adapter disables native custom instructions, isolates user configuration in a temporary COPILOT_HOME, disables built-in and discovered workspace MCP servers, and does not globally opt unrelated MCP initialization instructions into the system prompt.",
            ]
          : []),
      ],
    };
  }

  const bareAdvertised = features.has("--bare");
  const bareAuthenticationAvailable =
    typeof environment.ANTHROPIC_API_KEY === "string" &&
    environment.ANTHROPIC_API_KEY.trim().length > 0;
  const useBareMode = bareAdvertised && bareAuthenticationAvailable;
  const transportPayload = renderInstructionTransportPayload(
    resolution.renderedEnvelope,
    resolution.mcpInitializationInstructions,
  );
  const subagentEnvelope =
    features.has("--append-subagent-system-prompt") &&
    !requiresWindowsCommandShell(probe.executable) &&
    !transportPayload.includes("\0") &&
    transportPayload.length <=
      CLAUDE_SUBAGENT_ENVELOPE_MAX_CHARS;
  return {
    ...base,
    nativeDiscovery: useBareMode ? "suppressed" : "unknown",
    lifecycle: {
      ...base.lifecycle,
      subagents: subagentEnvelope ? "reattached" : "unknown",
    },
    evidence: [
      ...base.evidence,
      useBareMode
        ? "The adapter uses the documented --bare scripted mode because an explicit ANTHROPIC_API_KEY is available; local hooks, skills, plugins, MCP discovery, auto memory, CLAUDE.md, and settings are suppressed while the run-scoped system prompt and MCP file remain explicit."
        : bareAdvertised
          ? "The executable advertises --bare, but bare mode skips OAuth and keychain authentication. No explicit ANTHROPIC_API_KEY is available, so Machdoch preserves authentication and grades reloadable native settings, memory imports, and provider customizations as unknown extras."
          : "The probed invocation does not expose --bare; reloadable native settings, memory imports, and provider customizations remain unknown extras.",
      "The adapter requires --strict-mcp-config and uses it with the run-scoped MCP projection so no other MCP configuration is loaded.",
      "The adapter disables Claude auto memory for this run so mutable MEMORY.md content cannot appear outside the frozen instruction boundary.",
      subagentEnvelope
        ? "The complete envelope fits the bounded command argument and is appended to every nested subagent."
        : "Nested-subagent delivery is not claimed because the required flag is absent, the complete envelope exceeds the safe command-argument bound, or the executable is a Windows command wrapper that cannot safely carry arbitrary instruction text as an argument.",
    ],
  };
};

export const createInstructionDeliveryPlanForRuntime = async (
  resolution: FrozenInstructionSet,
  input: {
    workspaceRoot: string;
    unattended?: boolean;
    acknowledgedCompatible?: boolean;
    reasoning?: string;
  },
): Promise<InstructionDeliveryPlan> => {
  if (
    resolution.surface !== "cli" ||
    !isAgentCliProvider(resolution.providerId)
  ) {
    const baseCapability = getInstructionCapabilityDescriptor(
      resolution.providerId,
      resolution.surface,
    );
    const capability =
      resolution.providerId === "openai" && input.reasoning === "ultra"
        ? {
            ...baseCapability,
            lifecycle: {
              ...baseCapability.lifecycle,
              subagents: "unknown" as const,
            },
            evidence: [
              ...baseCapability.evidence,
              "Ultra reasoning enables the Responses multi-agent beta; inheritance of the parent instructions by every provider-managed subagent has not been independently verified.",
            ],
          }
        : baseCapability;
    return createInstructionDeliveryPlan(resolution, {
      capability: withProviderLimit(capability, resolution),
      ...(input.unattended === undefined
        ? {}
        : { unattended: input.unattended }),
      ...(input.acknowledgedCompatible === undefined
        ? {}
        : { acknowledgedCompatible: input.acknowledgedCompatible }),
    });
  }

  const env = await loadWorkspaceEnv(input.workspaceRoot);
  const binary = resolveAgentCliProviderBinary(resolution.providerId, env);
  const probe: ProviderProbeResult =
    binary.available && binary.executable
      ? await probeProviderCli(resolution.providerId, binary.executable)
      : {
          provider: resolution.providerId,
          executable: binary.executable ?? "<unavailable>",
          available: false,
          features: [],
          warnings: [binary.reason ?? "CLI executable is unavailable."],
        };
  const capability = createCliInstructionCapabilityFromProbe(
    resolution,
    probe,
  );
  return createInstructionDeliveryPlan(resolution, {
    capability,
    ...(input.unattended === undefined
      ? {}
      : { unattended: input.unattended }),
    ...(input.acknowledgedCompatible === undefined
      ? {}
      : { acknowledgedCompatible: input.acknowledgedCompatible }),
  });
};

export const claudePlanUsesSubagentEnvelope = (
  capability: InstructionCapabilityDescriptor,
): boolean =>
  capability.providerId === "claude-cli" &&
  capability.lifecycle.subagents === "reattached";
