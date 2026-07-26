import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInstructionPlanFixture,
  createInstructionResolutionFixture,
} from "../__test__/instruction-test-helpers.js";
import type { AgentCliProvider } from "../runtime-contract.generated.js";

const probeProviderCliMock = vi.hoisted(() =>
  vi.fn(
    async (provider: AgentCliProvider, executable: string) => ({
      provider,
      executable,
      available: true,
      version: "fixture-cli 1.0.0",
      features:
        provider === "claude-cli"
          ? [
              "--append-system-prompt-file",
              "--mcp-config",
              "--strict-mcp-config",
            ]
          : provider === "copilot-cli"
            ? [
                "--no-auto-update",
                "--no-custom-instructions",
                "--additional-mcp-config",
                "--disable-builtin-mcps",
                "--disable-mcp-server",
              ]
            : ["--config"],
      warnings: [],
    }),
  ),
);

vi.mock("./capability-registry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./capability-registry.js")>();
  return {
    ...actual,
    probeProviderCli: probeProviderCliMock,
    createProviderProbeEvidence: (probe: {
      provider: string;
      executable: string;
      available: boolean;
      version?: string;
      features: string[];
    }) =>
      `fixture-probe:${JSON.stringify({
        provider: probe.provider,
        executable: probe.executable,
        available: probe.available,
        version: probe.version ?? null,
        features: [...probe.features].sort(),
      })}`,
  };
});

import { materializeCliEnrollment } from "./materializer.js";
import { createCliInstructionCapabilityFromProbe } from "./instruction-delivery-preflight.js";
import {
  createInstructionDeliveryPlan,
  resolveInstructionSet,
} from "../instruction-system/index.js";
import type { FrozenInstructionSet } from "../instruction-system/index.js";
import type { ProviderProbeResult } from "./types.js";
import { inventoryNativeInstructions } from "../instruction-system/native-inventory.js";

const roots: string[] = [];

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-materializer-test-"));
  roots.push(root);
  vi.stubEnv("CODEX_HOME", join(root, "isolated-provider-home", "codex"));
  vi.stubEnv(
    "CLAUDE_CONFIG_DIR",
    join(root, "isolated-provider-home", "claude"),
  );
  vi.stubEnv("COPILOT_HOME", join(root, "isolated-provider-home", "copilot"));
  return root;
};

const createProbe = (
  provider: AgentCliProvider,
  features?: string[],
) => ({
  provider,
  executable: process.execPath,
  available: true,
  version: "fixture-cli 1.0.0",
  features:
    features ??
    (provider === "claude-cli"
      ? [
          "--append-system-prompt-file",
          "--mcp-config",
          "--strict-mcp-config",
        ]
      : provider === "copilot-cli"
        ? [
            "--no-auto-update",
            "--no-custom-instructions",
            "--additional-mcp-config",
            "--disable-builtin-mcps",
            "--disable-mcp-server",
          ]
        : ["--config"]),
  warnings: [],
});

const createProbedPlan = (
  resolution: FrozenInstructionSet,
  probe = createProbe(resolution.providerId as AgentCliProvider),
) =>
  createInstructionDeliveryPlan(resolution, {
    capability: createCliInstructionCapabilityFromProbe(resolution, probe),
  });

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI provider enrollment materializer", () => {
  it.each([
    "codex-cli",
    "claude-cli",
    "copilot-cli",
  ] satisfies AgentCliProvider[])("renders and cleans a native %s enrollment", async (provider) => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const codexSourceHome = join(root, "source-codex-home");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(codexSourceHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8"),
      writeFile(
        join(codexSourceHome, "auth.json"),
        '{"tokens":{"fixture":"redacted"}}\n',
        "utf8",
      ),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("CODEX_HOME", codexSourceHome);

    const resolution = createInstructionResolutionFixture({
      providerId: provider,
      surface: "cli",
      body: "Use the managed test policy.",
    });
    const deliveryPlan = createProbedPlan(resolution);
    const enrollment = await materializeCliEnrollment({
      provider,
      executable: process.execPath,
      runId: `test-${provider}`,
      workspaceRoot,
      resolution,
      deliveryPlan,
    });

    expect(enrollment.instructionDelivery.canonicalDigest).toBe(
      resolution.canonicalDigest,
    );
    expect(enrollment.instructionDelivery).toMatchObject({
      resolutionId: resolution.resolutionId,
      planId: deliveryPlan.planId,
      environmentDigest: resolution.environmentDigest,
      truncation: "none",
      sources: [expect.objectContaining({ id: "fixture:profile" })],
    });
    expect(enrollment.manifest.coverageSummary.complete).toBe(true);
    expect(enrollment.manifest.instructionDelivery.sources).toEqual([
      expect.objectContaining({ id: "fixture:profile" }),
    ]);
    expect(enrollment.manifest.coverage).not.toContainEqual(
      expect.objectContaining({ entityId: "fixture:profile" }),
    );

    if (provider === "codex-cli") {
      const configPath = enrollment.manifest.renderedFiles[0]?.path;
      expect(configPath).toBeDefined();
      expect(await readFile(configPath!, "utf8")).toContain("developer_instructions");
      expect(enrollment.env.CODEX_HOME).toContain("codex-home");
      expect(enrollment.args[0]).toBe("--config");
      expect(enrollment.args[1]).toContain("developer_instructions=");
      expect(
        await readFile(join(enrollment.env.CODEX_HOME!, "auth.json"), "utf8"),
      ).toContain('"fixture":"redacted"');
    } else if (provider === "claude-cli") {
      expect(enrollment.args).toContain("--append-system-prompt-file");
      expect(enrollment.args).toContain("--mcp-config");
      expect(enrollment.args).toContain("--strict-mcp-config");
      expect(enrollment.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    } else {
      expect(enrollment.args).toContain("--no-custom-instructions");
      expect(enrollment.args).toContain("--no-auto-update");
      expect(enrollment.args).toContain("--disable-builtin-mcps");
      expect(enrollment.args).not.toContain(
        "--allow-all-mcp-server-instructions",
      );
      expect(enrollment.env.COPILOT_HOME).toContain("copilot-home");
      expect(enrollment.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined();
      expect(enrollment.promptFallback).toBe(resolution.renderedEnvelope);
    }

    const enrollmentRoot = enrollment.rootPath;
    await enrollment.dispose();
    await expect(stat(enrollmentRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "codex-cli",
    "claude-cli",
    "copilot-cli",
  ] satisfies AgentCliProvider[])(
    "delivers the frozen MCP initialization supplement through %s",
    async (provider) => {
      const root = await createRoot();
      const workspaceRoot = join(root, "workspace");
      const userConfigRoot = join(root, "user-config");
      const mcpRoot = join(workspaceRoot, ".machdoch", "mcp");
      await Promise.all([
        mkdir(mcpRoot, { recursive: true }),
        mkdir(userConfigRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8"),
        writeFile(
          join(mcpRoot, "mcp.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            servers: [
              {
                id: "fixture",
                enabled: true,
                transport: {
                  type: "streamable-http",
                  url: "https://example.com/mcp",
                },
              },
            ],
          })}\n`,
          "utf8",
        ),
        writeFile(
          join(mcpRoot, "discovery-cache.json"),
          `${JSON.stringify({
            schemaVersion: 1,
            servers: {
              fixture: {
                serverId: "fixture",
                discoveredAt: "2026-01-01T00:00:00.000Z",
                transportType: "streamable-http",
                instructions: "Use the frozen fixture MCP hint.",
                tools: [],
                resources: [],
                resourceTemplates: [],
                prompts: [],
              },
            },
          })}\n`,
          "utf8",
        ),
      ]);
      vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);

      const resolution = await resolveInstructionSet(
        {
          providerId: provider,
          surface: "cli",
          workspaceRoot,
        },
        {
          libraryPath: join(root, "instruction-library.json"),
        },
      );
      const deliveryPlan = createProbedPlan(resolution);
      const enrollment = await materializeCliEnrollment({
        provider,
        executable: process.execPath,
        runId: `test-mcp-supplement-${provider}`,
        workspaceRoot,
        resolution,
        deliveryPlan,
      });

      const transportText =
        provider === "copilot-cli"
          ? enrollment.promptFallback
          : provider === "claude-cli"
            ? await readFile(
                enrollment.manifest.renderedFiles.find((file) =>
                  file.purpose.includes("system prompt")
                )!.path,
                "utf8",
              )
            : enrollment.args.join("\n");
      expect(transportText).toContain("Use the frozen fixture MCP hint.");
      expect(resolution.budget.runtimeSupplementBytes).toBeGreaterThan(0);
      expect(enrollment.instructionDelivery.instructionPayloadBytes).toBe(
        resolution.budget.envelopeBytes +
          resolution.budget.runtimeSupplementBytes!,
      );
      await enrollment.dispose();
    },
  );

  it("rejects a mismatched frozen plan before creating provider artifacts", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("CODEX_HOME", join(root, "source-codex-home"));

    const resolution = createInstructionResolutionFixture({
      providerId: "codex-cli",
      surface: "cli",
    });
    const otherResolution = createInstructionResolutionFixture({
      providerId: "claude-cli",
      surface: "cli",
    });
    await expect(
      materializeCliEnrollment({
        provider: "codex-cli",
        executable: process.execPath,
        runId: "test-mismatched-plan",
        workspaceRoot,
        resolution,
        deliveryPlan: createInstructionPlanFixture(otherResolution),
      }),
    ).rejects.toThrow(
      "requires a matching frozen resolution and delivery plan",
    );
    await expect(stat(join(workspaceRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects provider-native changes made after delivery-plan review", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);

    const resolution = createInstructionResolutionFixture({
      providerId: "claude-cli",
      surface: "cli",
    });
    const deliveryPlan = createProbedPlan(resolution);
    await writeFile(
      join(workspaceRoot, "CLAUDE.md"),
      "New native instructions after review.\n",
      "utf8",
    );

    await expect(
      materializeCliEnrollment({
        provider: "claude-cli",
        executable: process.execPath,
        runId: "test-native-drift",
        workspaceRoot,
        resolution,
        deliveryPlan,
      }),
    ).rejects.toThrow(
      "Provider-native instructions or configuration changed after instruction-plan review",
    );
  });

  it("blocks Codex envelopes that cannot fit the safe runtime override", () => {
    const resolution = createInstructionResolutionFixture({
      providerId: "codex-cli",
      surface: "cli",
      body: "x".repeat(20_000),
    });
    const plan = createProbedPlan(resolution);

    expect(plan.grade).toBe("unsupported");
    expect(plan.blockingReasons.join(" ")).toContain(
      "command-argument bound",
    );
  });

  it("blocks arbitrary Codex overrides through Windows command wrappers", () => {
    const resolution = createInstructionResolutionFixture({
      providerId: "codex-cli",
      surface: "cli",
    });
    const probe = {
      ...createProbe("codex-cli"),
      executable: "C:\\tools\\codex.cmd",
    };

    const plan = createProbedPlan(resolution, probe);

    if (process.platform === "win32") {
      expect(plan.grade).toBe("unsupported");
      expect(plan.blockingReasons.join(" ")).toContain(
        "through cmd.exe",
      );
    } else {
      expect(plan.grade).not.toBe("unsupported");
    }
  });

  it("includes frozen MCP hints in the Codex runtime-override bound", () => {
    const base = createInstructionResolutionFixture({
      providerId: "codex-cli",
      surface: "cli",
      body: "x".repeat(6_000),
    });
    const resolution = {
      ...base,
      mcpInitializationInstructions: [
        {
          serverIds: ["fixture"],
          body: "m".repeat(10_000),
          digest: "a".repeat(64),
          byteLength: 10_000,
        },
      ],
      budget: {
        ...base.budget,
        runtimeSupplementBytes: 10_256,
        estimatedRuntimeSupplementTokens: 10_256,
        estimatedTotalInstructionTokens:
          (base.budget.estimatedTokens ?? 0) + 10_256,
      },
    } as FrozenInstructionSet;

    const plan = createProbedPlan(resolution);

    expect(plan.grade).toBe("unsupported");
    expect(plan.blockingReasons.join(" ")).toContain(
      "command-argument bound",
    );
  });

  it("isolates Copilot user state and disables unmanaged workspace MCP servers", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const sourceCopilotHome = join(root, "source-copilot-home");
    await Promise.all([
      mkdir(join(workspaceRoot, ".github"), { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(sourceCopilotHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8"),
      writeFile(
        join(sourceCopilotHome, "config.json"),
        `${JSON.stringify({
          loggedInUsers: ["fixture"],
          installedPlugins: { ambient: { enabled: true } },
          enabledPlugins: { "ambient@example": true },
          extraKnownMarketplaces: { ambient: { source: "fixture" } },
          firstLaunchAt: "fixture",
        })}\n`,
        "utf8",
      ),
      writeFile(
        join(workspaceRoot, ".mcp.json"),
        '{"mcpServers":{"unmanaged-root":{"command":"root"},"My Server ✓":{"command":"unicode"}}}\n',
        "utf8",
      ),
      writeFile(
        join(workspaceRoot, ".github", "mcp.json"),
        '{"mcpServers":{"unmanaged-github":{"command":"github"}}}\n',
        "utf8",
      ),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("COPILOT_HOME", sourceCopilotHome);

    const baseResolution = createInstructionResolutionFixture({
      providerId: "copilot-cli",
      surface: "cli",
    });
    const resolution = {
      ...baseResolution,
      nativeInventory: await inventoryNativeInstructions({
        workspaceRoot,
        providerId: "copilot-cli",
        surface: "cli",
        locals: [],
      }),
    } as FrozenInstructionSet;
    const enrollment = await materializeCliEnrollment({
      provider: "copilot-cli",
      executable: process.execPath,
      runId: "test-copilot-mcp-isolation",
      workspaceRoot,
      resolution,
      deliveryPlan: createProbedPlan(resolution),
    });

    expect(enrollment.args).toEqual(
      expect.arrayContaining([
        "--disable-builtin-mcps",
        "--disable-mcp-server=My Server ✓",
        "--disable-mcp-server=unmanaged-github",
        "--disable-mcp-server=unmanaged-root",
      ]),
    );
    expect(enrollment.args).not.toContain(
      "--allow-all-mcp-server-instructions",
    );
    expect(enrollment.env.COPILOT_HOME).not.toBe(sourceCopilotHome);
    expect(enrollment.env.COPILOT_CACHE_HOME).toContain("copilot-cache");
    expect(enrollment.env.COPILOT_PLUGIN_DIR_ONLY).toBe("true");
    const isolatedState = JSON.parse(
      await readFile(join(enrollment.env.COPILOT_HOME!, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(isolatedState).toMatchObject({
      loggedInUsers: ["fixture"],
      firstLaunchAt: "fixture",
    });
    expect(isolatedState).not.toHaveProperty("installedPlugins");
    expect(isolatedState).not.toHaveProperty("enabledPlugins");
    expect(isolatedState).not.toHaveProperty("extraKnownMarketplaces");

    await enrollment.dispose();
  });

  it("fails closed when reviewed Copilot internal state is malformed", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const sourceCopilotHome = join(root, "source-copilot-home");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(sourceCopilotHome, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8"),
      writeFile(
        join(sourceCopilotHome, "config.json"),
        '{"loggedInUsers":',
        "utf8",
      ),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("COPILOT_HOME", sourceCopilotHome);

    const baseResolution = createInstructionResolutionFixture({
      providerId: "copilot-cli",
      surface: "cli",
    });
    const resolution = {
      ...baseResolution,
      nativeInventory: await inventoryNativeInstructions({
        workspaceRoot,
        providerId: "copilot-cli",
        surface: "cli",
        locals: [],
      }),
    } as FrozenInstructionSet;

    await expect(
      materializeCliEnrollment({
        provider: "copilot-cli",
        executable: process.execPath,
        runId: "test-copilot-malformed-state",
        workspaceRoot,
        resolution,
        deliveryPlan: createProbedPlan(resolution),
      }),
    ).rejects.toThrow("must be a valid JSON object");
  });

  it("does not infer Claude bare-mode conformance from help text alone", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    const probe = createProbe("claude-cli", [
      "--append-system-prompt-file",
      "--append-subagent-system-prompt",
      "--mcp-config",
      "--strict-mcp-config",
      "--bare",
    ]);
    probeProviderCliMock.mockResolvedValueOnce(probe);
    const resolution = createInstructionResolutionFixture({
      providerId: "claude-cli",
      surface: "cli",
      body: "Keep the complete provider-neutral policy.",
    });
    const deliveryPlan = createProbedPlan(resolution, probe);

    expect(deliveryPlan.capability.nativeDiscovery).toBe("unknown");
    expect(deliveryPlan.capability.lifecycle.subagents).toBe("reattached");
    const enrollment = await materializeCliEnrollment({
      provider: "claude-cli",
      executable: process.execPath,
      runId: "test-claude-conservative-bare",
      workspaceRoot,
      resolution,
      deliveryPlan,
    });

    expect(enrollment.args).not.toContain("--bare");
    expect(enrollment.args).toContain("--strict-mcp-config");
    expect(enrollment.args).toContain("--append-subagent-system-prompt");
    await enrollment.dispose();
  });

  it("uses documented Claude bare isolation when explicit API-key authentication is available", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-sent");
    const probe = createProbe("claude-cli", [
      "--append-system-prompt-file",
      "--append-subagent-system-prompt",
      "--mcp-config",
      "--strict-mcp-config",
      "--bare",
    ]);
    probeProviderCliMock.mockResolvedValueOnce(probe);
    const resolution = createInstructionResolutionFixture({
      providerId: "claude-cli",
      surface: "cli",
    });
    const deliveryPlan = createProbedPlan(resolution, probe);

    expect(deliveryPlan.capability.nativeDiscovery).toBe("suppressed");
    const enrollment = await materializeCliEnrollment({
      provider: "claude-cli",
      executable: process.execPath,
      runId: "test-claude-bare",
      workspaceRoot,
      resolution,
      deliveryPlan,
    });

    expect(enrollment.args).toContain("--bare");
    expect(enrollment.args).toContain("--strict-mcp-config");
    await enrollment.dispose();
  });

  it("fails closed when a Copilot workspace MCP server cannot be disabled portably", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8"),
      writeFile(
        join(workspaceRoot, ".mcp.json"),
        `${JSON.stringify({
          mcpServers: {
            "unsafe\u0001name": { command: "fixture" },
          },
        })}\n`,
        "utf8",
      ),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);

    const resolution = createInstructionResolutionFixture({
      providerId: "copilot-cli",
      surface: "cli",
    });
    await expect(
      materializeCliEnrollment({
        provider: "copilot-cli",
        executable: process.execPath,
        runId: "test-copilot-unsafe-mcp-name",
        workspaceRoot,
        resolution,
        deliveryPlan: createProbedPlan(resolution),
      }),
    ).rejects.toThrow("outside Copilot CLI's documented printable-name contract");
  });

  it("fails closed on linked Copilot workspace MCP configuration", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const sourcePath = join(root, "linked-mcp-source.json");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8"),
      writeFile(
        sourcePath,
        '{"mcpServers":{"linked":{"command":"fixture"}}}\n',
        "utf8",
      ),
    ]);
    try {
      await symlink(sourcePath, join(workspaceRoot, ".mcp.json"), "file");
    } catch {
      // Symlink creation can be unavailable on locked-down Windows hosts.
      return;
    }
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);

    const resolution = createInstructionResolutionFixture({
      providerId: "copilot-cli",
      surface: "cli",
    });
    await expect(
      materializeCliEnrollment({
        provider: "copilot-cli",
        executable: process.execPath,
        runId: "test-copilot-linked-mcp",
        workspaceRoot,
        resolution,
        deliveryPlan: createProbedPlan(resolution),
      }),
    ).rejects.toThrow("regular, unlinked file");
  });

  it("blocks a probed CLI that lacks a required complete-delivery flag", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    const missingFlagProbe = {
      provider: "claude-cli",
      executable: process.execPath,
      available: true,
      version: "fixture-cli-without-system-file 1.0.0",
      features: ["--mcp-config"],
      warnings: [],
    } satisfies ProviderProbeResult;
    probeProviderCliMock.mockResolvedValueOnce(missingFlagProbe);
    const resolution = createInstructionResolutionFixture({
      providerId: "claude-cli",
      surface: "cli",
    });

    const blockedPlan = createProbedPlan(resolution, missingFlagProbe);
    expect(blockedPlan.grade).toBe("unsupported");
    expect(blockedPlan.blockingReasons.join(" ")).toContain(
      "--append-system-prompt-file",
    );
    await expect(
      materializeCliEnrollment({
        provider: "claude-cli",
        executable: process.execPath,
        runId: "test-missing-required-flag",
        workspaceRoot,
        resolution,
        deliveryPlan: blockedPlan,
      }),
    ).rejects.toThrow(/requires a matching frozen resolution and delivery plan/u);
    await expect(stat(join(workspaceRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("blocks Copilot when the probed executable cannot disable auto-update", () => {
    const resolution = createInstructionResolutionFixture({
      providerId: "copilot-cli",
      surface: "cli",
    });
    const probeWithoutUpdatePin = createProbe("copilot-cli");
    probeWithoutUpdatePin.features = probeWithoutUpdatePin.features.filter(
      (feature) => feature !== "--no-auto-update",
    );

    const blockedPlan = createProbedPlan(resolution, probeWithoutUpdatePin);

    expect(blockedPlan.grade).toBe("unsupported");
    expect(blockedPlan.blockingReasons.join(" ")).toContain("--no-auto-update");
  });
});
