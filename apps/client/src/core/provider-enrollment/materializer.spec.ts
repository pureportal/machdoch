import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInstructionPlanFixture,
  createInstructionResolutionFixture,
} from "../__test__/instruction-test-helpers.js";
import type { AgentCliProvider } from "../runtime-contract.generated.js";

const readdirMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => {
      readdirMock(...args);
      return actual.readdir(...args);
    },
  };
});

const probeProviderCliMock = vi.hoisted(() =>
  vi.fn(async (provider: AgentCliProvider, executable: string) => ({
    provider,
    executable,
    available: true,
    version: "fixture-cli 1.0.0",
    features:
      provider === "claude-cli"
        ? [
            "--append-system-prompt-file",
            "--mcp-config",
            "--setting-sources",
            "--strict-mcp-config",
          ]
        : provider === "copilot-cli"
          ? [
              "--agent",
              "--attachment",
              "--no-auto-update",
              "--no-custom-instructions",
              "--additional-mcp-config",
              "--disable-builtin-mcps",
              "--disable-mcp-server",
            ]
          : ["--config"],
    warnings: [],
  })),
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

import {
  cleanupStaleEnrollmentArtifacts,
  materializeCliEnrollment as materializeCliEnrollmentRaw,
} from "./materializer.js";
import { createCliInstructionCapabilityFromProbe } from "./instruction-delivery-preflight.js";
import {
  createInstructionProfile,
  createInstructionDeliveryPlan,
  configureInstructionWorkspace,
  resolveInstructionSet,
  setWorkspaceInstructionScope,
} from "../instruction-system/index.js";
import type { FrozenInstructionSet } from "../instruction-system/index.js";
import type { ProviderProbeResult } from "./types.js";
import { inventoryNativeInstructions } from "../instruction-system/native-inventory.js";

const roots: string[] = [];
const runtimeSystemInstructions = "Fixture run-scoped system instructions.";
const machdochCliLaunch = {
  command: process.execPath,
  args: process.argv[1] ? [process.argv[1]] : [],
  cwd: process.cwd(),
  environment: {},
};
const materializeCliEnrollment = (
  params: Omit<
    Parameters<typeof materializeCliEnrollmentRaw>[0],
    "runtimeSystemInstructions" | "machdochCliLaunch"
  >,
) =>
  materializeCliEnrollmentRaw({
    ...params,
    runtimeSystemInstructions,
    machdochCliLaunch,
  });

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-materializer-test-"));
  roots.push(root);
  vi.stubEnv("CODEX_HOME", join(root, "isolated-provider-home", "codex"));
  vi.stubEnv(
    "CLAUDE_CONFIG_DIR",
    join(root, "isolated-provider-home", "claude"),
  );
  vi.stubEnv("COPILOT_HOME", join(root, "isolated-provider-home", "copilot"));
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  return root;
};

const createProbe = (provider: AgentCliProvider, features?: string[]) => ({
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
          "--setting-sources",
          "--strict-mcp-config",
        ]
      : provider === "copilot-cli"
        ? [
            "--agent",
            "--attachment",
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

interface ExclusiveFileLock {
  release(): Promise<void>;
}

const openExclusiveWindowsFileLock = async (
  path: string,
): Promise<ExclusiveFileLock> => {
  const encodedPath = Buffer.from(path, "utf16le").toString("base64");
  const script = [
    `$path = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)",
    "[Console]::Out.WriteLine('locked')",
    "[Console]::Out.Flush()",
    "[Console]::In.ReadLine() | Out-Null",
    "$stream.Dispose()",
  ].join("; ");
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for the Windows file lock.")),
      5_000,
    );
    const settle = (operation: () => void): void => {
      clearTimeout(timeout);
      operation();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("locked")) settle(resolve);
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code) => {
      if (!stdout.includes("locked")) {
        settle(() =>
          reject(
            new Error(
              `Windows file-lock helper exited with code ${code ?? "unknown"}: ${stderr}`,
            ),
          ),
        );
      }
    });
  });
  let released = false;
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `Windows file-lock helper closed with code ${code ?? "unknown"}: ${stderr}`,
          ),
        );
      }
    });
  });
  return {
    release: async (): Promise<void> => {
      if (!released) {
        released = true;
        child.stdin.end("\n");
      }
      await closed;
    },
  };
};

const createCodexEnrollment = async (runId: string) => {
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
    providerId: "codex-cli",
    surface: "cli",
  });
  return materializeCliEnrollment({
    provider: "codex-cli",
    executable: process.execPath,
    runId,
    workspaceRoot,
    resolution,
    deliveryPlan: createProbedPlan(resolution),
  });
};

beforeEach(() => {
  probeProviderCliMock.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI provider enrollment materializer", () => {
  it("throttles automatic temporary-directory scans while allowing explicit cleanup", async () => {
    const now = Date.now() + 10 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    readdirMock.mockClear();
    const enrollments: Awaited<ReturnType<typeof createCodexEnrollment>>[] = [];
    try {
      enrollments.push(await createCodexEnrollment("cleanup-throttle-one"));
      enrollments.push(await createCodexEnrollment("cleanup-throttle-two"));
      const scans = () =>
        readdirMock.mock.calls.filter(([path]) => path === tmpdir()).length;
      expect(scans()).toBe(1);
      await cleanupStaleEnrollmentArtifacts();
      expect(scans()).toBe(2);
      clock.mockReturnValue(now + 5 * 60_000 + 1);
      enrollments.push(await createCodexEnrollment("cleanup-throttle-expired"));
      expect(scans()).toBe(3);
    } finally {
      clock.mockRestore();
      await Promise.all(enrollments.map((enrollment) => enrollment.dispose()));
    }
  });
  it("retries transient capability probes before materializing Codex", async () => {
    const expectedProbe = createProbe("codex-cli");
    probeProviderCliMock
      .mockResolvedValueOnce({
        ...expectedProbe,
        features: [],
      })
      .mockResolvedValueOnce({
        ...expectedProbe,
        version: "transient-version-output",
      })
      .mockResolvedValueOnce(expectedProbe);

    const enrollment = await createCodexEnrollment(
      "test-transient-capability-probes",
    );

    expect(probeProviderCliMock).toHaveBeenCalledTimes(3);
    expect(probeProviderCliMock).toHaveBeenNthCalledWith(
      1,
      "codex-cli",
      process.execPath,
      { force: true },
    );
    expect(enrollment.manifest.providerVersion).toBe(expectedProbe.version);
    await enrollment.dispose();
  });

  it("blocks after repeated capability probes disagree with preflight", async () => {
    const changedProbe = {
      ...createProbe("codex-cli"),
      version: "changed-cli 2.0.0",
    };
    probeProviderCliMock
      .mockResolvedValueOnce(changedProbe)
      .mockResolvedValueOnce(changedProbe)
      .mockResolvedValueOnce(changedProbe);

    await expect(
      createCodexEnrollment("test-persistent-capability-change"),
    ).rejects.toThrow(
      "provider capability probe changed after instruction preflight",
    );
    expect(probeProviderCliMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    "codex-cli",
    "claude-cli",
    "copilot-cli",
  ] satisfies AgentCliProvider[])(
    "renders and cleans a native %s enrollment",
    async (provider) => {
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
      await expect(
        stat(join(workspaceRoot, "AGENTS.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(join(workspaceRoot, "CLAUDE.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        stat(join(workspaceRoot, ".github", "copilot-instructions.md")),
      ).rejects.toMatchObject({ code: "ENOENT" });

      if (provider === "codex-cli") {
        const configPath = enrollment.manifest.renderedFiles[0]?.path;
        expect(configPath).toBeDefined();
        expect(await readFile(configPath!, "utf8")).toContain(
          "developer_instructions",
        );
        expect(enrollment.env.CODEX_HOME).toContain("codex-home");
        expect(enrollment.args[0]).toBe("--config");
        expect(enrollment.args).not.toContainEqual(
          expect.stringContaining("developer_instructions="),
        );
        expect(
          await readFile(join(enrollment.env.CODEX_HOME!, "auth.json"), "utf8"),
        ).toContain('"fixture":"redacted"');
      } else if (provider === "claude-cli") {
        expect(enrollment.args).toContain("--append-system-prompt-file");
        expect(enrollment.args).toContain("--mcp-config");
        expect(enrollment.args).toContain("--strict-mcp-config");
        expect(enrollment.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
        expect(enrollment.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
      } else {
        expect(enrollment.args).toContain("--no-custom-instructions");
        expect(enrollment.args).toContain("--no-auto-update");
        expect(enrollment.args).toContain("--disable-builtin-mcps");
        expect(
          enrollment.args.some((argument) => argument.startsWith("--agent=")),
        ).toBe(true);
        expect(enrollment.args).not.toContain(
          "--allow-all-mcp-server-instructions",
        );
        expect(enrollment.env.COPILOT_HOME).toContain("copilot-home");
        expect(enrollment.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toBeUndefined();
        const agentPath = enrollment.manifest.renderedFiles.find(
          (file) => file.role === "instruction-transport",
        )!.path;
        expect(await readFile(agentPath, "utf8")).toContain(
          resolution.renderedEnvelope,
        );
      }

      const enrollmentRoot = enrollment.rootPath;
      await enrollment.dispose();
      await expect(stat(enrollmentRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "retries a transient Windows lock while removing Codex SQLite state",
    async () => {
      const enrollment = await createCodexEnrollment(
        "test-transient-codex-sqlite-lock",
      );
      const databasePath = join(enrollment.env.CODEX_HOME!, "goals_1.sqlite");
      await writeFile(databasePath, "fixture", "utf8");
      const lock = await openExclusiveWindowsFileLock(databasePath);
      const releaseLock = new Promise<void>((resolve, reject) => {
        setTimeout(() => void lock.release().then(resolve, reject), 250);
      });

      try {
        await expect(enrollment.dispose()).resolves.toEqual({
          status: "removed",
        });
        await releaseLock;
        await expect(stat(enrollment.rootPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await lock.release().catch(() => undefined);
        await rm(enrollment.rootPath, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 20,
        });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "defers a persistent Codex SQLite lock and reaps it after release",
    async () => {
      const enrollment = await createCodexEnrollment(
        "test-persistent-codex-sqlite-lock",
      );
      const databasePath = join(enrollment.env.CODEX_HOME!, "goals_1.sqlite");
      await writeFile(databasePath, "fixture", "utf8");
      const lock = await openExclusiveWindowsFileLock(databasePath);

      try {
        await expect(enrollment.dispose()).resolves.toMatchObject({
          status: "deferred",
          errorCode: expect.stringMatching(/^(?:EACCES|EBUSY|EPERM)$/u),
        });
        const marker = JSON.parse(
          await readFile(
            join(enrollment.rootPath, ".machdoch-instruction-session.json"),
            "utf8",
          ),
        ) as Record<string, unknown>;
        expect(marker.state).toBe("cleanup-pending");

        await lock.release();
        await cleanupStaleEnrollmentArtifacts();
        await expect(stat(enrollment.rootPath)).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await lock.release().catch(() => undefined);
        await rm(enrollment.rootPath, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 20,
        });
      }
    },
    10_000,
  );

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

      const transportText = await readFile(
        enrollment.manifest.renderedFiles.find(
          (file) => file.role !== "mcp-configuration",
        )!.path,
        "utf8",
      );
      expect(transportText).toContain("Use the frozen fixture MCP hint.");
      expect(resolution.budget.runtimeSupplementBytes).toBeGreaterThan(0);
      expect(enrollment.instructionDelivery.instructionPayloadBytes).toBe(
        resolution.budget.envelopeBytes +
          resolution.budget.runtimeSupplementBytes!,
      );
      await enrollment.dispose();
    },
  );

  it("preserves centrally resolved scope precedence at the native Copilot boundary", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const nestedScope = join(workspaceRoot, "apps", "web");
    const userConfigRoot = join(root, "user-config");
    const libraryPath = join(root, "instruction-library.json");
    await Promise.all([
      mkdir(nestedScope, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);

    await createInstructionProfile(
      { name: "Global", body: "Global boundary policy.", global: true },
      { path: libraryPath },
    );
    const workspace = await createInstructionProfile(
      { name: "Workspace", body: "Workspace boundary policy." },
      { path: libraryPath, expectedRevision: 1 },
    );
    const nested = await createInstructionProfile(
      { name: "Nested", body: "Nested boundary policy." },
      { path: libraryPath, expectedRevision: 2 },
    );
    const registered = await configureInstructionWorkspace(
      workspaceRoot,
      {},
      { path: libraryPath, expectedRevision: 3 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      ".",
      [workspace.profile.id],
      { path: libraryPath, expectedRevision: 4 },
    );
    await setWorkspaceInstructionScope(
      registered.workspace.id,
      "apps/web",
      [nested.profile.id],
      { path: libraryPath, expectedRevision: 5 },
    );
    const resolution = await resolveInstructionSet(
      {
        providerId: "copilot-cli",
        surface: "cli",
        workspaceRoot,
      },
      { libraryPath },
    );
    const enrollment = await materializeCliEnrollment({
      provider: "copilot-cli",
      executable: process.execPath,
      runId: "test-central-scope-order",
      workspaceRoot,
      resolution,
      deliveryPlan: createProbedPlan(resolution),
    });
    const agentPath = enrollment.manifest.renderedFiles.find(
      (file) => file.role === "instruction-transport",
    )!.path;
    const agent = await readFile(agentPath, "utf8");
    const orderedBodies = [
      "Global boundary policy.",
      "Workspace boundary policy.",
      "Nested boundary policy.",
    ];

    for (const [index, body] of orderedBodies.entries()) {
      expect(
        agent.match(new RegExp(body.replace(".", "\\."), "gu")),
      ).toHaveLength(1);
      if (index > 0) {
        expect(agent.indexOf(orderedBodies[index - 1]!)).toBeLessThan(
          agent.indexOf(body),
        );
      }
    }
    await expect(
      stat(join(workspaceRoot, ".github", "copilot-instructions.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(workspaceRoot, "CLAUDE.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      stat(join(workspaceRoot, ".codex", "config.toml")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await enrollment.dispose();
  });

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
    ).rejects.toThrow("requires matching frozen instructions");
    await expect(stat(join(workspaceRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("ignores provider-native changes made after delivery-plan review", async () => {
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

    const enrollment = await materializeCliEnrollment({
      provider: "claude-cli",
      executable: process.execPath,
      runId: "test-native-drift",
      workspaceRoot,
      resolution,
      deliveryPlan,
    });

    expect(enrollment.env.CLAUDE_CONFIG_DIR).toContain("claude-home");
    await enrollment.dispose();
  });

  it("keeps large Codex instructions in the invocation-scoped config", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    const body = [
      "long-codex-instruction-start",
      '"quotes", backslashes \\\\, shell & | < > ^ % !, and Unicode 🦊',
      "x".repeat(70_000),
      "long-codex-instruction-end",
    ].join("\n");
    const resolution = createInstructionResolutionFixture({
      providerId: "codex-cli",
      surface: "cli",
      body,
    });
    const plan = createProbedPlan(resolution);

    expect(plan.grade).not.toBe("unsupported");
    const enrollment = await materializeCliEnrollment({
      provider: "codex-cli",
      executable: process.execPath,
      runId: "test-large-codex-instructions",
      workspaceRoot,
      resolution,
      deliveryPlan: plan,
    });
    const configPath = enrollment.manifest.renderedFiles.find(
      (file) => file.role === "instruction-and-mcp-configuration",
    )!.path;
    const config = await readFile(configPath, "utf8");
    const serializedInstructions = config
      .split("\n")
      .find((line) => line.startsWith("developer_instructions = "))
      ?.slice("developer_instructions = ".length);

    expect(serializedInstructions).toBeDefined();
    expect(JSON.parse(serializedInstructions!)).toBe(
      `${runtimeSystemInstructions}\n\n${resolution.renderedEnvelope}`,
    );
    expect(config).toContain(
      `[projects.${JSON.stringify(workspaceRoot)}]\ntrust_level = "untrusted"`,
    );
    expect(enrollment.args.join("\n")).not.toContain(
      "long-codex-instruction-start",
    );
    expect(enrollment.args.join(" ").length).toBeLessThan(8_191);

    const enrollmentRoot = enrollment.rootPath;
    await enrollment.dispose();
    await expect(stat(enrollmentRoot)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["claude-cli", "copilot-cli"] as const)(
    "keeps large %s instructions in its invocation-scoped native file",
    async (provider) => {
      const root = await createRoot();
      const workspaceRoot = join(root, "workspace");
      const userConfigRoot = join(root, "user-config");
      await Promise.all([
        mkdir(workspaceRoot, { recursive: true }),
        mkdir(userConfigRoot, { recursive: true }),
      ]);
      await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
      vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
      const body = [
        `long-${provider}-instruction-start`,
        '"quotes", backslashes \\\\, shell & | < > ^ % !, CRLF\r\nand Unicode 🦊',
        "y".repeat(70_000),
        `long-${provider}-instruction-end`,
      ].join("\n");
      const resolution = createInstructionResolutionFixture({
        providerId: provider,
        surface: "cli",
        body,
      });
      const enrollment = await materializeCliEnrollment({
        provider,
        executable: process.execPath,
        runId: `test-large-${provider}-instructions`,
        workspaceRoot,
        resolution,
        deliveryPlan: createProbedPlan(resolution),
      });
      const instructionPath = enrollment.manifest.renderedFiles.find(
        (file) => file.role === "instruction-transport",
      )!.path;
      const nativeInstructions = await readFile(instructionPath, "utf8");

      expect(nativeInstructions).toContain(
        `long-${provider}-instruction-start`,
      );
      expect(nativeInstructions).toContain(`long-${provider}-instruction-end`);
      expect(
        nativeInstructions.match(
          new RegExp(`long-${provider}-instruction-start`, "gu"),
        ),
      ).toHaveLength(1);
      expect(enrollment.args.join("\n")).not.toContain(
        `long-${provider}-instruction-start`,
      );
      expect(enrollment.args.join(" ").length).toBeLessThan(8_191);

      const enrollmentRoot = enrollment.rootPath;
      await enrollment.dispose();
      await expect(stat(enrollmentRoot)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("isolates concurrent native instruction files and cleanup", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
    ]);
    await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    const firstResolution = createInstructionResolutionFixture({
      providerId: "copilot-cli",
      surface: "cli",
      body: "First isolated instruction.",
    });
    const secondResolution = createInstructionResolutionFixture({
      providerId: "copilot-cli",
      surface: "cli",
      body: "Second isolated instruction.",
    });

    const [first, second] = await Promise.all([
      materializeCliEnrollment({
        provider: "copilot-cli",
        executable: process.execPath,
        runId: "test-isolated-first",
        workspaceRoot,
        resolution: firstResolution,
        deliveryPlan: createProbedPlan(firstResolution),
      }),
      materializeCliEnrollment({
        provider: "copilot-cli",
        executable: process.execPath,
        runId: "test-isolated-second",
        workspaceRoot,
        resolution: secondResolution,
        deliveryPlan: createProbedPlan(secondResolution),
      }),
    ]);
    const firstPath = first.manifest.renderedFiles.find(
      (file) => file.role === "instruction-transport",
    )!.path;
    const secondPath = second.manifest.renderedFiles.find(
      (file) => file.role === "instruction-transport",
    )!.path;

    expect(first.rootPath).not.toBe(second.rootPath);
    expect(firstPath).not.toBe(secondPath);
    expect(await readFile(firstPath, "utf8")).not.toContain(
      "Second isolated instruction.",
    );
    expect(await readFile(secondPath, "utf8")).not.toContain(
      "First isolated instruction.",
    );
    await first.dispose();
    await expect(stat(first.rootPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(stat(secondPath)).resolves.toBeDefined();
    await second.dispose();
    await expect(stat(second.rootPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not reap an old enrollment owned by a running process", async () => {
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
      providerId: "copilot-cli",
      surface: "cli",
      body: "Keep this active enrollment.",
    });
    const enrollment = await materializeCliEnrollment({
      provider: "copilot-cli",
      executable: process.execPath,
      runId: "test-active-stale-enrollment",
      workspaceRoot,
      resolution,
      deliveryPlan: createProbedPlan(resolution),
    });

    const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    await utimes(enrollment.rootPath, oldTimestamp, oldTimestamp);
    await cleanupStaleEnrollmentArtifacts();

    await expect(stat(enrollment.rootPath)).resolves.toBeDefined();
    await enrollment.dispose();
    await expect(stat(enrollment.rootPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps arbitrary Codex content off Windows command wrappers", () => {
    const resolution = createInstructionResolutionFixture({
      providerId: "codex-cli",
      surface: "cli",
    });
    const probe = {
      ...createProbe("codex-cli"),
      executable: "C:\\tools\\codex.cmd",
    };

    const plan = createProbedPlan(resolution, probe);

    expect(plan.grade).not.toBe("unsupported");
    expect(plan.blockingReasons.join(" ")).not.toContain("through cmd.exe");
  });

  it("does not put frozen MCP hints in Codex command arguments", () => {
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

    expect(plan.grade).not.toBe("unsupported");
    expect(plan.blockingReasons.join(" ")).not.toContain(
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
        '{"unmanaged-github":{"command":"github"}}\n',
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

  it("rejects malformed provider-native Copilot MCP shape during isolation", async () => {
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
        '{"mcpServers":[]}\n',
        "utf8",
      ),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
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
      }),
    } as FrozenInstructionSet;

    await expect(
      materializeCliEnrollment({
        provider: "copilot-cli",
        executable: process.execPath,
        runId: "test-copilot-invalid-mcp-shape",
        workspaceRoot,
        resolution,
        deliveryPlan: createProbedPlan(resolution),
      }),
    ).rejects.toThrow("has an invalid mcpServers value");
  });

  it("passes required central MCP environment only through the provider process", async () => {
    const root = await createRoot();
    const workspaceRoot = join(root, "workspace");
    const userConfigRoot = join(root, "user-config");
    const mcpConfigRoot = join(workspaceRoot, ".machdoch", "mcp");
    await Promise.all([
      mkdir(workspaceRoot, { recursive: true }),
      mkdir(userConfigRoot, { recursive: true }),
      mkdir(mcpConfigRoot, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8"),
      writeFile(
        join(mcpConfigRoot, "mcp.json"),
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "environment-server",
              enabled: true,
              transport: {
                type: "stdio",
                command: "node",
                env: { TOKEN: "${env:MATERIALIZER_MCP_TOKEN}" },
              },
            },
          ],
        }),
        "utf8",
      ),
    ]);
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("MATERIALIZER_MCP_TOKEN", "materializer-secret");
    const resolution = createInstructionResolutionFixture({
      providerId: "copilot-cli",
      surface: "cli",
    });

    const enrollment = await materializeCliEnrollment({
      provider: "copilot-cli",
      executable: process.execPath,
      runId: "test-copilot-mcp-environment",
      workspaceRoot,
      resolution,
      deliveryPlan: createProbedPlan(resolution),
    });

    expect(enrollment.env.MATERIALIZER_MCP_TOKEN).toBe("materializer-secret");
    const mcpPathArgument = enrollment.args.find((argument) =>
      argument.startsWith("--additional-mcp-config=@"),
    );
    expect(mcpPathArgument).toBeDefined();
    const mcpConfig = await readFile(
      mcpPathArgument!.slice("--additional-mcp-config=@".length),
      "utf8",
    );
    expect(mcpConfig).not.toContain("materializer-secret");
    expect(enrollment.manifest.environmentKeys).toContain(
      "MATERIALIZER_MCP_TOKEN",
    );
    await enrollment.dispose();
  });

  it("rejects malformed Copilot state instead of silently discarding it", async () => {
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
    ).rejects.toThrow(
      "Copilot internal state must be a valid JSON-with-comments object before authentication state can be isolated.",
    );
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
      "--mcp-config",
      "--setting-sources",
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

    expect(deliveryPlan.capability.nativeDiscovery).toBe("suppressed");
    expect(deliveryPlan.capability.lifecycle.subagents).toBe("unknown");
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
    expect(enrollment.args.join("\n")).not.toContain(
      resolution.renderedEnvelope,
    );
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
      "--mcp-config",
      "--setting-sources",
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

  it("fails closed for a Copilot workspace MCP server that cannot be disabled portably", async () => {
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
    ).rejects.toThrow("cannot be disabled safely");
  });

  it("fails closed for linked Copilot workspace MCP configuration", async () => {
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
    ).rejects.toThrow("could not inspect");
  });

  it("fails closed when a probed CLI lacks native delivery flags", async () => {
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
    ).rejects.toThrow("cannot satisfy the native instruction contract");
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
