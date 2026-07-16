import { spawnSync } from "node:child_process";
import { extname } from "node:path";
import type {
  AgentCliProvider,
  ConfiguredModelProvider,
} from "../runtime-contract.generated.js";
import type {
  ProviderCapabilityProfile,
  ProviderProbeResult,
} from "./types.js";

export const PROVIDER_CAPABILITY_REGISTRY = {
  openai: {
    provider: "openai",
    instructionAuthority: "developer",
    instructionMechanism: "Responses API instructions",
    mcpMechanism: "application-managed",
    supportedMcpTransports: ["stdio", "streamable-http", "sse"],
    supportsPerServerProxy: false,
    refreshBoundary: "request",
  },
  anthropic: {
    provider: "anthropic",
    instructionAuthority: "system",
    instructionMechanism: "Messages API system",
    mcpMechanism: "application-managed",
    supportedMcpTransports: ["stdio", "streamable-http", "sse"],
    supportsPerServerProxy: false,
    refreshBoundary: "request",
  },
  google: {
    provider: "google",
    instructionAuthority: "system",
    instructionMechanism: "Gemini systemInstruction",
    mcpMechanism: "application-managed",
    supportedMcpTransports: ["stdio", "streamable-http", "sse"],
    supportsPerServerProxy: false,
    refreshBoundary: "request",
  },
  langdock: {
    provider: "langdock",
    instructionAuthority: "system",
    instructionMechanism: "first system message",
    mcpMechanism: "application-managed",
    supportedMcpTransports: ["stdio", "streamable-http", "sse"],
    supportsPerServerProxy: false,
    refreshBoundary: "request",
  },
  "codex-cli": {
    provider: "codex-cli",
    instructionAuthority: "developer",
    instructionMechanism: "isolated config.toml developer_instructions",
    mcpMechanism: "native-config",
    supportedMcpTransports: ["stdio", "streamable-http"],
    supportsPerServerProxy: true,
    refreshBoundary: "invocation",
  },
  "claude-cli": {
    provider: "claude-cli",
    instructionAuthority: "system",
    instructionMechanism: "--append-system-prompt-file",
    mcpMechanism: "native-config",
    supportedMcpTransports: ["stdio", "streamable-http", "sse"],
    supportsPerServerProxy: true,
    refreshBoundary: "invocation",
  },
  "copilot-cli": {
    provider: "copilot-cli",
    instructionAuthority: "native-file",
    instructionMechanism: "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
    mcpMechanism: "native-config",
    supportedMcpTransports: ["stdio", "streamable-http", "sse"],
    supportsPerServerProxy: true,
    refreshBoundary: "invocation",
  },
} as const satisfies Record<ConfiguredModelProvider, ProviderCapabilityProfile>;

const probeCache = new Map<string, Promise<ProviderProbeResult>>();

const shouldUseShell = (executable: string): boolean => {
  return process.platform === "win32" && [".cmd", ".bat"].includes(extname(executable).toLowerCase());
};

const captureCommand = (
  executable: string,
  args: string[],
): { output: string; exitCode: number | null } => {
  if (typeof spawnSync !== "function") {
    return { output: "", exitCode: null };
  }
  const result = spawnSync(executable, args, {
    env: process.env,
    shell: shouldUseShell(executable),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    encoding: "utf8",
    timeout: 4_000,
    maxBuffer: 64_000,
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-64_000),
    exitCode: result.status,
  };
};

const detectFeatures = (provider: AgentCliProvider, help: string): string[] => {
  const candidates =
    provider === "codex-cli"
      ? ["--config", "developer_instructions", "mcp_servers"]
      : provider === "claude-cli"
        ? ["--append-system-prompt-file", "--mcp-config", "--strict-mcp-config"]
        : [
            "COPILOT_CUSTOM_INSTRUCTIONS_DIRS",
            "--additional-mcp-config",
            "--allow-all-mcp-server-instructions",
          ];

  return candidates.filter((feature) => help.includes(feature));
};

export const probeProviderCli = async (
  provider: AgentCliProvider,
  executable: string,
): Promise<ProviderProbeResult> => {
  const key = `${provider}:${executable}`;
  const cached = probeCache.get(key);
  if (cached) {
    return await cached;
  }

  const pending = (async (): Promise<ProviderProbeResult> => {
    const [versionResult, helpResult] = [
      captureCommand(executable, ["--version"]),
      captureCommand(executable, ["--help"]),
    ];
    const warnings: string[] = [];
    if (helpResult.exitCode !== 0 && helpResult.exitCode !== null) {
      warnings.push("Provider help probe returned a non-zero exit code; documented renderer defaults remain active.");
    }

    return {
      provider,
      executable,
      available: versionResult.exitCode !== null || helpResult.exitCode !== null,
      ...(versionResult.output ? { version: versionResult.output.split(/\r?\n/u)[0] } : {}),
      features: detectFeatures(provider, helpResult.output),
      warnings,
    };
  })();

  probeCache.set(key, pending);
  return await pending;
};
