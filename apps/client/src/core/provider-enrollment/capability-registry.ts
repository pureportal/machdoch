import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { runStreamingCommand } from "../_helpers/streaming-command.js";
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
const MAX_CACHED_PROBES = 64;
let activeProbeCommands = 0;
const waitingProbeCommands: Array<() => void> = [];
const probeCache = new Map<
  string,
  { expiresAt: number; pending: boolean; result: Promise<ProviderProbeResult> }
>();

const shouldUseShell = (executable: string): boolean => {
  return (
    process.platform === "win32" &&
    [".cmd", ".bat"].includes(extname(executable).toLowerCase())
  );
};

const captureCommand = async (
  executable: string,
  args: string[],
  timeoutMs = PROVIDER_PROBE_TIMEOUT_MS,
): Promise<{ output: string; exitCode: number | null }> => {
  const shell = shouldUseShell(executable);
  if (
    shell &&
    (/["\r\n&|<>^%!]/u.test(executable) ||
      args.some((arg) => !/^[A-Za-z0-9-]+$/u.test(arg)))
  ) {
    throw new Error(
      "The provider command wrapper or probe arguments contain shell metacharacters.",
    );
  }
  await new Promise<void>((resolve) => {
    if (activeProbeCommands < 2) {
      activeProbeCommands += 1;
      resolve();
    } else waitingProbeCommands.push(resolve);
  });
  try {
    // Probe arguments are fixed flag/subcommand tokens, checked above. Supply
    // a complete command for .cmd/.bat wrappers; Node's shell+args API is deprecated.
    const result = await runStreamingCommand(
      shell ? `"${executable}" ${args.join(" ")}` : executable,
      shell ? [] : args,
      {
        cwd: process.cwd(),
        env: process.env,
        shell,
        timeoutMs,
        maxBufferBytes: 128_000,
      },
    );
    return {
      output: `${result.stdout}\n${result.stderr}`.trim().slice(-64_000),
      exitCode: result.exitCode,
    };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: unknown;
    };
    return {
      output: `${failure.stdout ?? ""}\n${failure.stderr ?? ""}`
        .trim()
        .slice(-64_000),
      exitCode: typeof failure.code === "number" ? failure.code : null,
    };
  } finally {
    const next = waitingProbeCommands.shift();
    if (next) next();
    else activeProbeCommands -= 1;
  }
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
  const metadata = await stat(executable).catch(() => undefined);
  const key = JSON.stringify([
    provider,
    executable,
    process.cwd(),
    process.env.PATH ?? process.env.Path,
    metadata && [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs],
  ]);
  const cached = probeCache.get(key);
  if (
    cached &&
    (cached.pending ||
      (options.force !== true && cached.expiresAt > Date.now()))
  ) {
    probeCache.delete(key);
    probeCache.set(key, cached);
    return structuredClone(await cached.result);
  }
  probeCache.delete(key);

  const pending = (async (): Promise<ProviderProbeResult> => {
    const warnings: string[] = [];
    let versionResult = await captureCommand(executable, ["--version"]);
    if (versionResult.exitCode !== 0) {
      versionResult = await captureCommand(
        executable,
        ["--version"],
        PROVIDER_PROBE_RETRY_TIMEOUT_MS,
      );
      warnings.push(
        "Provider version probe did not complete successfully on the first attempt and was retried.",
      );
    }

    let helpResult = await captureCommand(executable, ["--help"]);

    if (helpResult.exitCode !== 0) {
      helpResult = await captureCommand(
        executable,
        ["--help"],
        PROVIDER_PROBE_RETRY_TIMEOUT_MS,
      );
      warnings.push(
        "Provider help probe did not complete successfully on the first attempt and was retried.",
      );
    }

    if (provider === "codex-cli") {
      let execHelpResult = await captureCommand(executable, ["exec", "--help"]);
      if (execHelpResult.exitCode !== 0) {
        execHelpResult = await captureCommand(
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
    expiresAt: Infinity,
    pending: true,
    result: pending,
  });
  void pending.then(
    (result) => {
      const cached = probeCache.get(key);
      if (cached?.result === pending) {
        cached.pending = false;
        cached.expiresAt =
          Date.now() +
          (result.available ? PROVIDER_PROBE_CACHE_TTL_MS : 15_000);
      }
      for (const [cachedKey, entry] of probeCache) {
        if (
          !entry.pending &&
          (entry.expiresAt <= Date.now() || probeCache.size > MAX_CACHED_PROBES)
        )
          probeCache.delete(cachedKey);
      }
    },
    () => {
      if (probeCache.get(key)?.result === pending) {
        probeCache.delete(key);
      }
    },
  );
  return structuredClone(await pending);
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
