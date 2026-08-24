import { loadRuntimeEnvironment } from "../env.js";
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
import {
  createProviderProbeEvidence,
  probeProviderCli,
} from "./capability-registry.js";
import type { ProviderProbeResult } from "./types.js";

const REQUIRED_DELIVERY_FEATURES: Record<AgentCliProvider, readonly string[]> =
  {
    "codex-cli": ["--config"],
    "claude-cli": [
      "--append-system-prompt-file",
      "--mcp-config",
      "--setting-sources",
      "--strict-mcp-config",
    ],
    "copilot-cli": [
      "--agent",
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

export const canUseClaudeBareMode = (
  features: ReadonlySet<string>,
  environment: NodeJS.ProcessEnv = process.env,
): boolean =>
  features.has("--bare") &&
  typeof environment.ANTHROPIC_API_KEY === "string" &&
  environment.ANTHROPIC_API_KEY.trim().length > 0;

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
    return {
      ...base,
      nativeDiscovery: "suppressed",
      mechanism:
        "run-scoped CODEX_HOME config.toml developer_instructions with project configuration disabled",
      evidence: [
        ...base.evidence,
        "The adapter writes the complete developer instructions to the isolated CODEX_HOME config.toml and marks the invocation workspace and its ancestors untrusted there, so provider-native project configuration cannot override them.",
        "Only bounded control settings are passed through --config; request and instruction content are never placed on the command line.",
      ],
    };
  }

  if (provider !== "claude-cli") {
    return {
      ...base,
      ...(provider === "copilot-cli"
        ? {
            authority: "native" as const,
            nativeDiscovery: "suppressed" as const,
            mechanism:
              "run-scoped custom-agent file selected with --agent while custom instruction discovery is disabled",
          }
        : {}),
      evidence: [
        ...base.evidence,
        `Runtime probe observed: ${[...features].sort().join(", ") || "no required help flags"}.`,
        ...(provider === "copilot-cli"
          ? [
              "The adapter writes the complete instructions to a uniquely named custom-agent file under an isolated COPILOT_HOME and selects it with --agent.",
              "The adapter also disables custom instruction discovery, so repository AGENTS.md and related files are not loaded a second time.",
            ]
          : []),
      ],
    };
  }

  const bareAdvertised = features.has("--bare");
  const useBareMode = canUseClaudeBareMode(features, environment);
  return {
    ...base,
    nativeDiscovery: "suppressed",
    evidence: [
      ...base.evidence,
      useBareMode
        ? "The adapter uses the documented --bare scripted mode because an explicit ANTHROPIC_API_KEY is available; local hooks, skills, plugins, MCP discovery, auto memory, CLAUDE.md, and settings are suppressed while the run-scoped system prompt and MCP file remain explicit."
        : bareAdvertised
          ? "The executable advertises --bare, but bare mode skips OAuth and keychain authentication. Without an explicit ANTHROPIC_API_KEY, the adapter instead isolates CLAUDE_CONFIG_DIR, loads no user/project/local setting sources, and disables all CLAUDE.md and auto-memory loading."
          : "The adapter isolates CLAUDE_CONFIG_DIR, loads no user/project/local setting sources, and disables all CLAUDE.md and auto-memory loading.",
      "The adapter requires --strict-mcp-config and uses it with the run-scoped MCP projection so no other MCP configuration is loaded.",
      "Nested-subagent delivery remains unknown because Claude's subagent system-prompt option accepts only inline command text; Machdoch does not duplicate large instructions onto argv.",
    ],
  };
};

export const createInstructionDeliveryPlanForRuntime = async (
  resolution: FrozenInstructionSet,
  input: {
    workspaceRoot: string;
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
    });
  }

  const env = await loadRuntimeEnvironment();
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
  const capability = createCliInstructionCapabilityFromProbe(resolution, probe);
  return createInstructionDeliveryPlan(resolution, {
    capability,
  });
};
