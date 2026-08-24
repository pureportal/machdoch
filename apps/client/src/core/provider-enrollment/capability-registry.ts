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
import { compareCanonicalStrings, sha256 } from "./digests.js";

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
    instructionMechanism: "run-scoped custom agent selected with --agent",
    mcpMechanism: "native-config",
    supportedMcpTransports: ["stdio", "streamable-http", "sse"],
    supportsPerServerProxy: true,
    refreshBoundary: "invocation",
  },
} as const satisfies Record<ConfiguredModelProvider, ProviderCapabilityProfile>;

const PROVIDER_PROBE_CACHE_TTL_MS = 5 * 60 * 1_000;
const PROVIDER_PROBE_TIMEOUT_MS = 4_000;
const PROVIDER_PROBE_RETRY_TIMEOUT_MS = 12_000;
const probeCache = new Map<
  string,
  { expiresAt: number; result: Promise<ProviderProbeResult> }
>();

const shouldUseShell = (executable: string): boolean => {
  return (
    process.platform === "win32" &&
    [".cmd", ".bat"].includes(extname(executable).toLowerCase())
  );
};

const captureCommand = (
  executable: string,
  args: string[],
  timeoutMs = PROVIDER_PROBE_TIMEOUT_MS,
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
    timeout: timeoutMs,
    maxBuffer: 64_000,
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
      .trim()
      .slice(-64_000),
    exitCode: result.status,
  };
};

const detectFeatures = (provider: AgentCliProvider, help: string): string[] => {
  const candidates =
    provider === "codex-cli"
      ? ["--config", "--json", "developer_instructions", "mcp_servers"]
      : provider === "claude-cli"
        ? [
            "--append-system-prompt-file",
            "--effort",
            "--mcp-config",
            "--output-format",
            "--strict-mcp-config",
            "--bare",
            "--setting-sources",
            "--verbose",
          ]
        : [
            "--agent",
            "--attachment",
            "--context",
            "--effort",
            "--no-auto-update",
            "--no-custom-instructions",
            "--output-format",
            "--stream",
            "--additional-mcp-config",
            "--disable-builtin-mcps",
            "--disable-mcp-server",
          ];

  return candidates.filter((feature) => {
    const escaped = feature.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(
      `(?:^|[^A-Za-z0-9_-])${escaped}(?=$|[^A-Za-z0-9_-])`,
      "mu",
    ).test(help);
  });
};

export const probeProviderCli = async (
  provider: AgentCliProvider,
  executable: string,
  options: { force?: boolean } = {},
): Promise<ProviderProbeResult> => {
  const key = `${provider}:${executable}`;
  const cached = probeCache.get(key);
  if (options.force !== true && cached && cached.expiresAt > Date.now()) {
    return await cached.result;
  }
  probeCache.delete(key);

  const pending = (async (): Promise<ProviderProbeResult> => {
    const versionResult = captureCommand(executable, ["--version"]);
    let helpResult = captureCommand(executable, ["--help"]);
    const warnings: string[] = [];

    if (helpResult.exitCode !== 0) {
      helpResult = captureCommand(
        executable,
        ["--help"],
        PROVIDER_PROBE_RETRY_TIMEOUT_MS,
      );
      warnings.push(
        "Provider help probe did not complete successfully on the first attempt and was retried.",
      );
    }

    if (provider === "codex-cli") {
      let execHelpResult = captureCommand(executable, ["exec", "--help"]);
      if (execHelpResult.exitCode !== 0) {
        execHelpResult = captureCommand(
          executable,
          ["exec", "--help"],
          PROVIDER_PROBE_RETRY_TIMEOUT_MS,
        );
        warnings.push(
          "Codex exec help probe did not complete successfully on the first attempt and was retried.",
        );
      }
      helpResult = {
        output: `${helpResult.output}\n${execHelpResult.output}`.trim(),
        exitCode:
          helpResult.exitCode === null || execHelpResult.exitCode === null
            ? null
            : helpResult.exitCode !== 0
              ? helpResult.exitCode
              : execHelpResult.exitCode,
      };
    }

    if (helpResult.exitCode === null) {
      warnings.push(
        "Provider help probe did not complete; required run-scoped instruction flags could not be confirmed.",
      );
    } else if (helpResult.exitCode !== 0) {
      warnings.push(
        "Provider help probe returned a non-zero exit code; required run-scoped instruction flags must still be observed before launch.",
      );
    }

    return {
      provider,
      executable,
      available:
        versionResult.exitCode !== null || helpResult.exitCode !== null,
      ...(versionResult.output
        ? { version: versionResult.output.split(/\r?\n/u)[0] }
        : {}),
      features: detectFeatures(provider, helpResult.output),
      warnings,
    };
  })();

  probeCache.set(key, {
    expiresAt: Date.now() + PROVIDER_PROBE_CACHE_TTL_MS,
    result: pending,
  });
  pending.catch(() => {
    if (probeCache.get(key)?.result === pending) {
      probeCache.delete(key);
    }
  });
  return await pending;
};

export const createProviderProbeEvidence = (
  probe: ProviderProbeResult,
): string =>
  `cli-probe:${sha256(
    JSON.stringify({
      provider: probe.provider,
      executable: probe.executable,
      available: probe.available,
      version: probe.version ?? null,
      features: [...probe.features].sort(compareCanonicalStrings),
    }),
  )}`;
