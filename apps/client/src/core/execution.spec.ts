import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { loadUserMemorySettings, saveUserGlobalMemoryEnabled } from "./env.ts";
import { executeTask } from "./execution.ts";
import { createInstructionResolutionFixture } from "./__test__/instruction-test-helpers.ts";
import { createInstructionDeliveryPlan } from "./instruction-system/index.ts";
import type { AgentToolDefinition } from "./_helpers/agent-tools-shared.ts";
import { mcpClientManager } from "./mcp/client.ts";
import type {
  AgentModelAdapter,
  AgentModelToolCall,
  AgentModelStartParams,
  CustomizationDiscoveryResult,
  TaskExecutionProgress,
} from "./types.ts";
import type {
  ProviderAvailability,
  RunMode,
  RuntimeConfig,
} from "./runtime-contract.generated.ts";

const workspacesToClean: string[] = [];
const originalUserConfigDir = process.env.MACHDOCH_USER_CONFIG_DIR;

const providerAvailability: ProviderAvailability[] = [
  { provider: "openai", configured: false },
  { provider: "anthropic", configured: false },
  { provider: "google", configured: false },
];

const configuredProviderAvailability: ProviderAvailability[] = [
  { provider: "openai", configured: true },
  { provider: "anthropic", configured: false },
  { provider: "google", configured: false },
];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-exec-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

const writeWorkspaceMcpConfig = async (
  workspaceRoot: string,
  serverId: string,
): Promise<void> => {
  const configDirectory = join(workspaceRoot, ".machdoch", "mcp");

  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    join(configDirectory, "mcp.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        servers: [
          {
            id: serverId,
            enabled: true,
            transport: {
              type: "streamable-http",
              url: `https://example.com/${serverId}/mcp/`,
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const createConfig = (
  workspaceRoot: string,
  mode: RunMode,
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig => {
  return {
    workspaceRoot,
    mode,
    provider: "unconfigured",
    model: "gpt-5.5",
    reasoning: "default",
    contextWindow: "default",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability,
    webSearch: {
      activeProvider: "none",
      providerAvailability: [
        { provider: "perplexity", configured: false },
        { provider: "tavily", configured: false },
      ],
    },
    reviewModel: {
      mode: "base",
    },
    internalTaskModel: {
      provider: "unconfigured",
      model: "gpt-5.5",
      reasoning: "default",
    },
    ...overrides,
  };
};

const emptyCustomizations = (
  workspaceRoot: string,
): CustomizationDiscoveryResult => {
  return {
    workspaceRoot,
    prompts: [],
    skills: [],
  };
};

const createFinalResponseToolCall = (
  overrides: Partial<Record<string, unknown>> = {},
): AgentModelToolCall => {
  return {
    id: "final-response",
    name: "submit_final_response",
    arguments: {
      summary: "Completed the model-driven task.",
      status: "completed",
      blockerReason: "",
      markdown: "Completed the model-driven task.",
      highlights: [],
      relatedFiles: [],
      verification: [],
      followUps: [],
      ...overrides,
    },
  };
};

const createAcceptingMonitorAdapter = (): AgentModelAdapter => ({
  startTurn: async () => ({
    text: "",
    toolCalls: [
      {
        id: "monitor-1",
        name: "report_autopilot_decision",
        arguments: {
          decision: "complete",
          confidence: "high",
          rationale: "The execution result satisfies the task.",
          missingRequirements: [],
          requiredActions: [],
        },
      },
    ],
  }),
  continueTurn: async (): Promise<never> => {
    throw new Error("The monitor adapter should only run one turn.");
  },
});

const createFinalOnlyAdapter = (summary: string): AgentModelAdapter => ({
  startTurn: async () => ({
    text: "",
    toolCalls: [
      createFinalResponseToolCall({
        summary,
        markdown: summary,
      }),
    ],
  }),
  continueTurn: async (): Promise<never> => {
    throw new Error("The final-only adapter should not continue.");
  },
});

afterEach(async () => {
  vi.restoreAllMocks();

  if (originalUserConfigDir === undefined) {
    delete process.env.MACHDOCH_USER_CONFIG_DIR;
  } else {
    process.env.MACHDOCH_USER_CONFIG_DIR = originalUserConfigDir;
  }

  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("executeTask", () => {
  it("executes a safe read-only workspace inspection when filesystem access is allowed", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".machdoch"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "package.json"),
      JSON.stringify(
        {
          name: "machdoch",
          type: "module",
          scripts: {
            build: "tsc -p tsconfig.json",
            test: "vitest run",
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(workspaceRoot, "README.md"), "# Example");

    const result = await executeTask(
      "scan this workspace and explain the setup",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect", target: "workspace" } },
    );

    expect(result.status).toBe("executed");
    expect(result.executedTools).toEqual(["filesystem"]);
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Workspace context",
      "Top-level entries",
      "Project signals",
      "Customization summary",
    ]);
    expect(
      result.outputSections[2]?.lines.some((line) =>
        line.includes("package.json"),
      ),
    ).toBe(true);
    expect(result.outputSections[3]?.lines).toContain(
      "package.json: present (machdoch)",
    );
  });

  it("executes a safe runtime-config inspection instead of falling back to a generic workspace summary", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "inspect config",
      {
        ...createConfig(workspaceRoot, "ask"),
        workspaceConfigPath: join(workspaceRoot, ".machdoch", "config.json"),
      },
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect", target: "runtime-config" } },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("runtime configuration");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Runtime config",
      "Provider availability",
    ]);
    expect(result.outputSections[1]?.lines).toContain(
      `workspace config file: ${join(workspaceRoot, ".machdoch", "config.json")}`,
    );
  });

  it("executes a safe tool surface inspection", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "show tools",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect", target: "tools" } },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("registered tools");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Function-call surface",
    ]);
    expect(result.outputSections[1]?.lines).toContain(
      "mode surface: ask exposes only read-only function calls",
    );
    expect(result.outputSections[1]?.lines).toContain("shell [high]");
  });

  it("executes prompt-file inspection with customization summary context", async () => {
    const workspaceRoot = await createWorkspace();

    const customizations: CustomizationDiscoveryResult = {
      ...emptyCustomizations(workspaceRoot),
      prompts: [
        {
          path: ".machdoch/prompts/debug-build.prompt.md",
          name: "debug-build",
          description: "Diagnose build failures.",
          argumentHint: "Build error",
          inputs: ["error", "logs"],
          tools: ["filesystem", "shell"],
          body: "Investigate the failing build and explain the fix.",
        },
      ],
    };

    const result = await executeTask(
      "list prompts",
      createConfig(workspaceRoot, "ask"),
      customizations,
      { deterministicAction: { kind: "inspect", target: "prompts" } },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("prompt files");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Customization summary",
      "Prompt files",
    ]);
    expect(result.outputSections[2]?.lines).toContain(
      "debug-build (.machdoch/prompts/debug-build.prompt.md)",
    );
    expect(result.outputSections[2]?.lines).toContain(
      "  tools: filesystem, shell",
    );
  });

  it("executes skill inspection with discovered skill metadata", async () => {
    const workspaceRoot = await createWorkspace();

    const customizations: CustomizationDiscoveryResult = {
      ...emptyCustomizations(workspaceRoot),
      skills: [
        {
          path: ".machdoch/skills/release-automation/SKILL.md",
          name: "release-automation",
          description: "Automates release tasks.",
          argumentHint: "Release and desired outcome",
          userInvocable: true,
          disableModelInvocation: false,
        },
      ],
    };

    const result = await executeTask(
      "show skills",
      createConfig(workspaceRoot, "ask"),
      customizations,
      { deterministicAction: { kind: "inspect", target: "skills" } },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("skill folders");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Customization summary",
      "Skill files",
    ]);
    expect(result.outputSections[2]?.lines).toContain(
      "release-automation (.machdoch/skills/release-automation/SKILL.md)",
    );
    expect(result.outputSections[2]?.lines).toContain("  user invocable: true");
  });

  it("executes generic customization inspection and reports empty states cleanly", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "inspect customizations",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect", target: "customizations" } },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("workspace customizations");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Customization summary",
      "Prompt files",
      "Skill files",
    ]);
    expect(result.outputSections[2]?.lines).toEqual([
      "No prompt files were discovered.",
    ]);
    expect(result.outputSections[3]?.lines).toEqual([
      "No skill folders were discovered.",
    ]);
  });

  it("does not treat mixed read-only and mutating tasks as deterministic inspections", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "inspect config and update settings",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("unsupported");
    expect(result.executedTools).toEqual([]);
  });

  it("executes read-only filesystem inspections in ask mode", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "summarize this project setup",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect", target: "workspace" } },
    );

    expect(result.status).toBe("executed");
    expect(result.executedTools).toEqual(["filesystem"]);
  });

  it("reports compatible provider delivery as telemetry for deterministic offline work", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "summarize this project setup",
      createConfig(workspaceRoot, "ask", {
        provider: "copilot-cli",
        model: "gpt-5.4",
        offline: true,
      }),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect", target: "workspace" } },
    );

    expect(result.status).toBe("executed");
    expect(result.executedTools).toEqual(["filesystem"]);
    expect(result.metadata?.instructionDeliveryGrade).toBe("compatible");
  });

  it("blocks deterministic file writes in ask mode", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "create notes.txt with hello world",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        deterministicAction: {
          kind: "create-file",
          path: "notes.txt",
          content: "hello world",
        },
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("Switch to machdoch mode");
  });

  it("explains unsupported tasks that need an unconfigured model provider", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "install dependencies and commit the changes",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("unsupported");
    expect(result.executedTools).toEqual([]);
    expect(result.summary).toContain("no model provider is configured");
    expect(result.reason).toContain("machdoch config set api.openai.key");
    expect(result.outputSections.map((section) => section.title)).toContain(
      "Live execution",
    );
  });

  it("explains unsupported tasks when the selected provider is unavailable", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "install dependencies and commit the changes",
      createConfig(workspaceRoot, "machdoch", {
        provider: "openai",
      }),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("unsupported");
    expect(result.summary).toContain("selected provider `openai`");
    expect(result.reason).toContain("api.openai.key");
  });

  it("explains unsupported tasks when offline mode disables live execution", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "install dependencies and commit the changes",
      createConfig(workspaceRoot, "machdoch", {
        provider: "openai",
        providerAvailability: configuredProviderAvailability,
        offline: true,
      }),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("unsupported");
    expect(result.summary).toContain("offline mode is enabled");
    expect(result.reason).toContain("workspace.offline off");
  });

  it("executes a safe text preview for an explicit file request inside the workspace", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(
      join(workspaceRoot, "README.md"),
      ["# machdoch", "", "Local-first OS AI agent"].join("\n"),
    );

    const result = await executeTask(
      "show README.md",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect-path", path: "README.md" } },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("file inspection");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "File target",
      "File preview",
    ]);
    expect(result.outputSections[2]?.lines[0]).toBe("1: # machdoch");
  });

  it("executes a prompt invocation by expanding it into a safe file preview", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(
      join(workspaceRoot, "README.md"),
      ["# prompt-driven", "", "Expanded from a prompt file"].join("\n"),
    );

    const customizations: CustomizationDiscoveryResult = {
      ...emptyCustomizations(workspaceRoot),
      prompts: [
        {
          path: ".machdoch/prompts/show-file.prompt.md",
          name: "show-file",
          description: "Preview a workspace file.",
          inputs: ["file"],
          tools: ["filesystem"],
          body: "show ${input:file}",
        },
      ],
    };

    const result = await executeTask(
      "/show-file file=README.md",
      createConfig(workspaceRoot, "ask"),
      customizations,
      { deterministicAction: { kind: "inspect-path", path: "README.md" } },
    );

    expect(result.status).toBe("executed");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Prompt context",
      "Task context",
      "File target",
      "File preview",
    ]);
    expect(result.outputSections[0]?.lines).toContain("prompt: /show-file");
    expect(result.outputSections[0]?.lines).toContain(
      "expanded task: show README.md",
    );
    expect(result.outputSections[1]?.lines).toContain(
      "effective task: show README.md",
    );
    expect(result.outputSections[3]?.lines[0]).toBe("1: # prompt-driven");
  });

  it("blocks prompt invocations that still have unresolved required inputs", async () => {
    const workspaceRoot = await createWorkspace();

    const customizations: CustomizationDiscoveryResult = {
      ...emptyCustomizations(workspaceRoot),
      prompts: [
        {
          path: ".machdoch/prompts/show-file.prompt.md",
          name: "show-file",
          description: "Preview a workspace file.",
          inputs: ["file"],
          tools: ["filesystem"],
          body: "show ${input:file}",
        },
      ],
    };

    const result = await executeTask(
      "/show-file",
      createConfig(workspaceRoot, "ask"),
      customizations,
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("missing input(s): file");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Prompt context",
      "Task context",
    ]);
    expect(result.outputSections[0]?.lines).toContain("missing inputs: file");
  });

  it("executes a safe directory listing for an explicit workspace folder", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, "src", "core"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "main.ts"), "export {};\n");

    const result = await executeTask(
      "list src",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect-path", path: "src" } },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("directory inspection");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Directory target",
      "Directory entries",
    ]);
    expect(result.outputSections[2]?.lines).toEqual([
      "dir: core",
      "file: main.ts",
    ]);
  });

  it("reports when an explicitly requested directory is empty", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, "empty-dir"), { recursive: true });

    const result = await executeTask(
      "list empty-dir",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect-path", path: "empty-dir" } },
    );

    expect(result.status).toBe("executed");
    expect(result.outputSections[2]?.lines).toEqual(["Directory is empty."]);
  });

  it("reports a missing explicit path cleanly", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "show missing.txt",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect-path", path: "missing.txt" } },
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("missing.txt");
  });

  it("blocks file reads that resolve outside the workspace", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      'read "../machdoch-secret.txt"',
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        deterministicAction: {
          kind: "inspect-path",
          path: "../machdoch-secret.txt",
        },
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("outside");
  });

  it("handles binary-looking files without dumping raw bytes", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "sample.bin"), Buffer.from([0, 1, 2]));

    const result = await executeTask(
      "inspect sample.bin",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect-path", path: "sample.bin" } },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("withheld");
    expect(result.outputSections[2]?.lines).toEqual([
      "Binary-looking content detected; text preview skipped.",
    ]);
  });

  it("truncates long text file previews after the configured number of lines", async () => {
    const workspaceRoot = await createWorkspace();
    const content = Array.from(
      { length: 85 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");

    await writeFile(join(workspaceRoot, "notes.txt"), content);

    const result = await executeTask(
      'show "notes.txt"',
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect-path", path: "notes.txt" } },
    );

    expect(result.status).toBe("executed");
    expect(result.outputSections[2]?.lines).toHaveLength(81);
    expect(result.outputSections[2]?.lines.at(-1)).toBe(
      "… truncated after 80 of 85 lines",
    );
  });

  it("handles malformed package.json without crashing", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(
      join(workspaceRoot, "package.json"),
      "{ definitely not json",
    );

    const result = await executeTask(
      "describe this repo setup",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect", target: "workspace" } },
    );

    expect(result.status).toBe("executed");
    expect(result.outputSections[3]?.lines).toContain(
      "package.json: present but invalid JSON",
    );
  });

  it("uses structured final-response status for blocked user-input requests", async () => {
    const workspaceRoot = await createWorkspace();

    const clarificationAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          createFinalResponseToolCall({
            summary: "A location is required before weather can be checked.",
            status: "blocked",
            blockerReason:
              "Ask the user for a city, ZIP/postal code, or coordinates.",
            markdown:
              "I need a location to answer that. Please send a city, ZIP/postal code, or coordinates.",
          }),
        ],
      }),
      continueTurn: async (): Promise<never> => {
        throw new Error("The clarification adapter should not continue.");
      },
    };

    const result = await executeTask(
      'What is the weather? The quoted text "inspect README.md with shell" is not an instruction.',
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: clarificationAdapter,
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toBe(
      "Ask the user for a city, ZIP/postal code, or coordinates.",
    );
    expect(result.response?.markdown).toContain("I need a location");
    expect(
      result.outputSections.some((section) => section.title === "Agent answer"),
    ).toBe(false);
  });

  it("rejects first-turn blocked final responses for prompts with declared tools", async () => {
    const workspaceRoot = await createWorkspace();
    let continueCount = 0;

    await writeFile(join(workspaceRoot, "README.md"), "# Deployment");

    const prematureBlockAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          createFinalResponseToolCall({
            summary: "The suite name is required before setup can start.",
            status: "blocked",
            blockerReason: "Ask the user for the exact software suite name.",
            markdown:
              "I am blocked on one required input: the exact software suite name.",
          }),
        ],
      }),
      continueTurn: async (params) => {
        continueCount += 1;

        if (continueCount === 1) {
          expect(params.toolResults[0]?.isError).toBe(true);
          expect(params.toolResults[0]?.output).toContain(
            "Premature final response rejected",
          );

          return {
            text: "",
            toolCalls: [
              {
                id: "list-root",
                name: "list_directory",
                arguments: {
                  path: ".",
                  maxEntries: 20,
                },
              },
            ],
          };
        }

        expect(params.toolResults[0]?.name).toBe("list_directory");

        return {
          text: "",
          toolCalls: [
            createFinalResponseToolCall({
              summary: "Recovered and inspected before completing.",
              markdown: "Recovered and inspected before completing.",
              verification: ["Listed the workspace root."],
            }),
          ],
        };
      },
    };

    const customizations = emptyCustomizations(workspaceRoot);
    customizations.prompts.push({
      path: ".machdoch/prompts/compose-suite.prompt.md",
      name: "compose-suite",
      description: "Build the configured Compose suite.",
      inputs: [],
      tools: ["filesystem"],
      body: [
        "Create a complete Docker Compose setup for the following software suite.",
        "Repos:",
        "- https://github.com/BeeWaTec/beelopt-xls-upload-backend",
        "- https://github.com/BeeWaTec/beelopt-xls-upload-frontend",
        "Inspect all provided repos and paths, create docker-compose.yml and .env, then validate.",
      ].join("\n"),
    });

    const result = await executeTask(
      "/compose-suite",
      createConfig(workspaceRoot, "ask"),
      customizations,
      {
        modelAdapter: prematureBlockAdapter,
      },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toBe("Recovered and inspected before completing.");
    expect(result.executedTools).toEqual(["filesystem"]);
    expect(
      result.outputSections.some(
        (section) => section.title === "Final response guard",
      ),
    ).toBe(true);
  });

  it("returns executed for model-driven machdoch completions", async () => {
    const workspaceRoot = await createWorkspace();

    const planningAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          createFinalResponseToolCall({
            summary: "Implementation outline is ready.",
            markdown:
              "Implementation outline is ready.\n\n1. Inspect files.\n2. Apply the targeted edit.\n3. Run focused tests.",
          }),
        ],
      }),
      continueTurn: async (): Promise<never> => {
        throw new Error("The planning adapter should not continue.");
      },
    };

    const result = await executeTask(
      "Plan a safe implementation.",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: planningAdapter,
        monitorModelAdapter: createAcceptingMonitorAdapter(),
      },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toBe("Implementation outline is ready.");
    expect(result.response?.markdown).toContain("Apply the targeted edit");
    expect(result.executedTools).toEqual([]);
  });

  it("blocks an oversized assembled API request before invoking the provider", async () => {
    const workspaceRoot = await createWorkspace();
    const baseResolution = createInstructionResolutionFixture({
      providerId: "openai",
      surface: "api",
      model: "fixture-runtime-budget",
    });
    const instructionResolution = {
      ...baseResolution,
      budget: {
        ...baseResolution.budget,
        providerLimitTokens: 20_000,
        providerReserveTokens: 16_384,
        availableInstructionTokens: 3_616,
      },
    };
    const startTurn = vi.fn<AgentModelAdapter["startTurn"]>();

    const result = await executeTask(
      "x".repeat(10_000),
      createConfig(workspaceRoot, "machdoch", {
        provider: "openai",
        model: "fixture-runtime-budget",
        providerAvailability: configuredProviderAvailability,
      }),
      emptyCustomizations(workspaceRoot),
      {
        resolvedInstructions: instructionResolution,
        instructionDeliveryPlan: createInstructionDeliveryPlan(
          instructionResolution,
        ),
        modelAdapter: {
          startTurn,
          continueTurn: async (): Promise<never> => {
            throw new Error("The provider must not be invoked.");
          },
        },
      },
    );

    expect(startTurn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(
        /initial request needs.*provider was not invoked.*not truncated/su,
      ),
    });
  });

  it("blocks continuation context growth before invoking the provider again", async () => {
    const workspaceRoot = await createWorkspace();
    const baseResolution = createInstructionResolutionFixture({
      providerId: "openai",
      surface: "api",
      model: "fixture-continuation-budget",
    });
    const instructionResolution = {
      ...baseResolution,
      budget: {
        ...baseResolution.budget,
        providerLimitTokens: 250_000,
        providerReserveTokens: 16_384,
        availableInstructionTokens: 233_616,
      },
    };
    const continueTurn = vi.fn<AgentModelAdapter["continueTurn"]>();
    const largeOutputTool: AgentToolDefinition = {
      spec: {
        name: "return_large_fixture",
        description: "Return a large deterministic fixture.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      },
      backingTool: "filesystem",
      riskLevel: "low",
      effect: "read",
      execute: async () => ({
        toolResult: {
          callId: "fixture-tool-result",
          name: "return_large_fixture",
          output: "y".repeat(300_000),
        },
        sections: [],
        traceLines: [],
      }),
    };

    const result = await executeTask(
      "Run the fixture tool and use its result.",
      createConfig(workspaceRoot, "machdoch", {
        provider: "openai",
        model: "fixture-continuation-budget",
        providerAvailability: configuredProviderAvailability,
      }),
      emptyCustomizations(workspaceRoot),
      {
        resolvedInstructions: instructionResolution,
        instructionDeliveryPlan: createInstructionDeliveryPlan(
          instructionResolution,
        ),
        additionalToolDefinitions: [largeOutputTool],
        modelAdapter: {
          startTurn: async () => ({
            text: "",
            toolCalls: [
              {
                id: "fixture-call",
                name: "return_large_fixture",
                arguments: {},
              },
            ],
          }),
          continueTurn,
        },
      },
    );

    expect(continueTurn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "blocked",
      reason: expect.stringMatching(
        /continuation request needs.*provider was not invoked.*not truncated/su,
      ),
    });
  });

  it("emits final response markdown on terminal progress", async () => {
    const workspaceRoot = await createWorkspace();
    const finalMarkdown =
      "Implementation completed.\n\n- Changed the target file.\n- Ran focused verification.";
    const terminalProgress: TaskExecutionProgress[] = [];
    const finalResponseAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          createFinalResponseToolCall({
            summary: "Implementation completed.",
            markdown: finalMarkdown,
          }),
        ],
      }),
      continueTurn: async (): Promise<never> => {
        throw new Error("The final response adapter should not continue.");
      },
    };

    const result = await executeTask(
      "Implement a small requested change.",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: finalResponseAdapter,
        onStateChange: (progress) => {
          if (!progress.cancellable) {
            terminalProgress.push(progress);
          }
        },
      },
    );

    expect(result.status).toBe("executed");
    expect(result.response?.markdown).toBe(finalMarkdown);
    expect(terminalProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "completed",
          assistantText: finalMarkdown,
        }),
      ]),
    );
  });

  it("emits unstructured assistant answers on terminal progress", async () => {
    const workspaceRoot = await createWorkspace();
    const assistantAnswer = "Fetched and summarized the current weather.";
    const terminalProgress: TaskExecutionProgress[] = [];
    const unstructuredAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: assistantAnswer,
        toolCalls: [],
      }),
      continueTurn: async (): Promise<never> => {
        throw new Error("The unstructured adapter should not continue.");
      },
    };

    const result = await executeTask(
      "What is the weather?",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: unstructuredAdapter,
        onStateChange: (progress) => {
          if (!progress.cancellable) {
            terminalProgress.push(progress);
          }
        },
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.response).toBeUndefined();
    expect(terminalProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "blocked",
          assistantText: assistantAnswer,
        }),
      ]),
    );
  });

  it("uses the dedicated review model for validator passes", async () => {
    const workspaceRoot = await createWorkspace();
    const executorAdapter = createFinalOnlyAdapter(
      "Completed with base model.",
    );
    const monitorAdapter: AgentModelAdapter = {
      startTurn: async (params) => {
        expect(params.model).toBe("gpt-5.4-mini");
        expect(params.systemPrompt).toContain("Selected model: gpt-5.4-mini");

        return {
          text: "",
          toolCalls: [
            {
              id: "monitor-1",
              name: "report_autopilot_decision",
              arguments: {
                decision: "complete",
                confidence: "high",
                rationale: "The execution result satisfies the task.",
                missingRequirements: [],
                requiredActions: [],
              },
            },
          ],
        };
      },
      continueTurn: async (): Promise<never> => {
        throw new Error("The monitor adapter should only run one turn.");
      },
    };

    const result = await executeTask(
      "Plan a safe implementation.",
      createConfig(workspaceRoot, "machdoch", {
        provider: "openai",
        model: "gpt-5.5",
        reviewModel: {
          mode: "dedicated",
          provider: "openai",
          model: "gpt-5.4-mini",
        },
      }),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: executorAdapter,
        monitorModelAdapter: monitorAdapter,
      },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toBe("Completed with base model.");
  });

  it("executes mutating tool calls in machdoch mode", async () => {
    const workspaceRoot = await createWorkspace();

    const mutatingAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "create-1",
            name: "create_file",
            arguments: {
              path: "planned-change.txt",
              content: "not yet",
            },
          },
        ],
      }),
      continueTurn: async (params) => {
        expect(params.toolResults[0]?.isError).not.toBe(true);

        return {
          text: "",
          toolCalls: [
            createFinalResponseToolCall({
              summary: "Created the requested file.",
              markdown: "Created planned-change.txt.",
              verification: ["Created planned-change.txt."],
            }),
          ],
        };
      },
    };

    const result = await executeTask(
      "Create planned-change.txt.",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: mutatingAdapter,
        monitorModelAdapter: createAcceptingMonitorAdapter(),
      },
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toBe("Created the requested file.");
    await expect(
      stat(join(workspaceRoot, "planned-change.txt")),
    ).resolves.toBeDefined();
  });

  it("returns session memory updates from model-driven memory tool calls", async () => {
    const workspaceRoot = await createWorkspace();
    const memoryFact = "Prefers concise implementation summaries.";

    const memoryAdapter: AgentModelAdapter = {
      startTurn: async (params) => {
        expect(
          params.tools.some((tool) => tool.name === "remember_session_memory"),
        ).toBe(true);

        return {
          text: "",
          toolCalls: [
            {
              id: "memory-1",
              name: "remember_session_memory",
              arguments: {
                fact: memoryFact,
                memory_key: "implementation-summary-style",
                kind: "preference",
                search_terms: ["response style"],
                importance: 3,
                sensitivity: "non-sensitive",
              },
            },
          ],
        };
      },
      continueTurn: async (params) => {
        expect(params.toolResults[0]?.name).toBe("remember_session_memory");
        expect(params.toolResults[0]?.isError).not.toBe(true);
        expect(params.toolResults[0]?.output).toContain(
          "saved session memory implementation-summary-style",
        );

        return {
          text: "",
          toolCalls: [
            createFinalResponseToolCall({
              summary: "Saved the requested session memory.",
              markdown: "Saved the requested session memory.",
            }),
          ],
        };
      },
    };

    const result = await executeTask(
      "Remember that the user prefers concise implementation summaries.",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        conversationContext: {
          history: [],
          sessionMemoryEnabled: true,
          sessionMemory: [],
        },
        modelAdapter: memoryAdapter,
        monitorModelAdapter: createAcceptingMonitorAdapter(),
      },
    );

    expect(result.status).toBe("executed");
    expect(result.memoryUpdates).toHaveLength(1);
    expect(result.memoryUpdates?.[0]).toMatchObject({
      scope: "session",
      entry: {
        scope: "session",
        key: "implementation-summary-style",
        kind: "preference",
        content: memoryFact,
        searchTerms: ["response style"],
      },
    });
    expect(
      result.outputSections.some(
        (section) =>
          section.title === "Memory update" &&
          section.lines.includes("scope: session") &&
          section.lines.includes("status: saved"),
      ),
    ).toBe(true);
  });

  it("does not derive session memory commands from task prose", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "Remember that the user prefers concise implementation summaries.",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        conversationContext: {
          history: [],
          sessionMemoryEnabled: true,
          sessionMemory: [],
        },
        modelAdapter: createFinalOnlyAdapter(
          "Completed without a memory tool.",
        ),
        monitorModelAdapter: createAcceptingMonitorAdapter(),
      },
    );

    expect(result.status).toBe("executed");
    expect(result.memoryUpdates).toBeUndefined();
  });

  it("does not automatically consolidate memory in ask mode", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "Remember that the user prefers concise implementation summaries.",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        conversationContext: {
          history: [],
          sessionMemoryEnabled: true,
          sessionMemory: [],
        },
        modelAdapter: createFinalOnlyAdapter("Answered read-only."),
      },
    );

    expect(result.status).toBe("executed");
    expect(result.memoryUpdates).toBeUndefined();
  });

  it("does not use secret-looking prose as a memory safety signal", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "Remember that my API key is sk-test-value.",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        conversationContext: {
          history: [],
          sessionMemoryEnabled: true,
          sessionMemory: [],
          globalMemoryEnabled: true,
        },
        modelAdapter: createFinalOnlyAdapter(
          "Completed without saving secrets.",
        ),
        monitorModelAdapter: createAcceptingMonitorAdapter(),
      },
    );

    expect(result.status).toBe("executed");
    expect(result.memoryUpdates).toBeUndefined();
  });

  it("does not derive global memory commands from task prose", async () => {
    const workspaceRoot = await createWorkspace();

    process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");
    await saveUserGlobalMemoryEnabled(true);

    const result = await executeTask(
      "Remember globally that the user prefers compact summaries.",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        conversationContext: {
          history: [],
          sessionMemoryEnabled: false,
          sessionMemory: [],
          globalMemoryEnabled: true,
        },
        modelAdapter: createFinalOnlyAdapter("Completed global memory update."),
        monitorModelAdapter: createAcceptingMonitorAdapter(),
      },
    );

    const settings = await loadUserMemorySettings();

    expect(result.status).toBe("executed");
    expect(result.memoryUpdates).toBeUndefined();
    expect(settings.entries).toEqual([]);
    expect(settings.globalEnabled).toBe(true);
  });

  it("hides side-effecting shell tools in ask mode", async () => {
    const workspaceRoot = await createWorkspace();

    const shellAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "shell-1",
            name: "run_shell_command",
            arguments: {
              command: "Get-Content C:\\Users\\someone\\.ssh\\id_rsa",
            },
          },
        ],
      }),
      continueTurn: async (params) => {
        expect(params.toolResults[0]?.isError).toBe(true);
        expect(params.toolResults[0]?.output).toContain("not registered");

        return {
          text: "",
          toolCalls: [
            createFinalResponseToolCall({
              status: "blocked",
              summary: "Shell access is unavailable in Ask mode.",
              blockerReason: "Ask mode exposes only read-only function calls.",
              markdown: "Switch to Machdoch mode to run shell commands.",
            }),
          ],
        };
      },
    };

    const result = await executeTask(
      "Inspect a sensitive file through shell.",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: shellAdapter,
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("read-only function calls");
  });

  it("blocks unstructured model answers instead of classifying prose", async () => {
    const workspaceRoot = await createWorkspace();

    const unstructuredAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "I need a location to answer that.",
        toolCalls: [],
      }),
      continueTurn: async (): Promise<never> => {
        throw new Error("The unstructured adapter should not continue.");
      },
    };

    const result = await executeTask(
      "What is the weather?",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: unstructuredAdapter,
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("structured final response");
    expect(result.reason).toContain("submit_final_response");
    expect(result.response).toBeUndefined();
    expect(
      result.outputSections.some((section) => section.title === "Agent answer"),
    ).toBe(true);
  });

  it("uses configured executor turn limits for model-driven execution", async () => {
    const workspaceRoot = await createWorkspace();

    const loopingAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            arguments: {
              path: "missing.txt",
            },
          },
        ],
      }),
      continueTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "call-loop",
            name: "read_file",
            arguments: {
              path: "missing.txt",
            },
          },
        ],
      }),
    };

    const result = await executeTask(
      "Loop until the runtime stops the executor.",
      {
        ...createConfig(workspaceRoot, "ask"),
        agentLimits: {
          executorTurns: 2,
          autopilotExecutorIterations: 16,
        },
      },
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: loopingAdapter,
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("turn limit");
    expect(result.reason).toContain("Stopped after 2 turns");
  });

  it("truncates top-level workspace summaries when many entries are present", async () => {
    const workspaceRoot = await createWorkspace();

    await Promise.all(
      Array.from({ length: 15 }, (_, index) =>
        writeFile(join(workspaceRoot, `file-${index + 1}.txt`), "content"),
      ),
    );

    const result = await executeTask(
      "scan this workspace setup",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      { deterministicAction: { kind: "inspect", target: "workspace" } },
    );

    expect(result.status).toBe("executed");
    expect(result.outputSections[2]?.lines.at(-1)).toBe(
      "… 3 more top-level entries",
    );
  });

  it("stops model-driven execution after the high safety timeout when a provider turn wedges", async () => {
    const workspaceRoot = await createWorkspace();
    const progress: TaskExecutionProgress[] = [];

    const hangingAdapter: AgentModelAdapter = {
      startTurn: ({ signal }: AgentModelStartParams) => {
        return new Promise((_, reject) => {
          const rejectWithReason = (): void => {
            const reason = signal?.reason;

            reject(
              reason instanceof Error
                ? reason
                : new Error(
                    typeof reason === "string" && reason.trim().length > 0
                      ? reason
                      : "Execution cancelled by user.",
                  ),
            );
          };

          if (signal?.aborted) {
            rejectWithReason();
            return;
          }

          signal?.addEventListener("abort", rejectWithReason, { once: true });
        });
      },
      continueTurn: (): Promise<never> => {
        throw new Error(
          "The hanging adapter should never continue after timing out.",
        );
      },
    };

    const result = await executeTask(
      "scan this workspace and explain the setup",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: hangingAdapter,
        maxDurationMs: 25,
        onStateChange: (snapshot) => {
          progress.push(snapshot);
        },
      },
    );

    expect(result.status).toBe("cancelled");
    expect(result.summary).toContain("safety timeout");
    expect(result.reason).toContain("25ms");
    expect(result.outputSections.at(-1)?.title).toBe("Execution limit");
    expect(progress[0]?.timeout).toMatchObject({
      idleTimeoutMs: 25,
      absoluteTimeoutMs: 25,
    });
  }, 10_000);

  it("keeps model-driven execution alive when stream progress arrives before the idle timeout", async () => {
    const workspaceRoot = await createWorkspace();
    const onStreamActivity = vi.fn();
    const streamingAdapter: AgentModelAdapter = {
      startTurn: ({ signal, onStreamEvent }: AgentModelStartParams) => {
        return new Promise((resolve, reject) => {
          const timers = [
            setTimeout(() => {
              onStreamEvent?.({
                type: "text-delta",
                provider: "openai",
                delta: "Still working.",
              });
            }, 100),
            setTimeout(() => {
              resolve({
                text: "",
                toolCalls: [createFinalResponseToolCall()],
              });
            }, 300),
          ];
          const rejectWithReason = (): void => {
            for (const timer of timers) {
              clearTimeout(timer);
            }

            const reason = signal?.reason;

            reject(
              reason instanceof Error
                ? reason
                : new Error(
                    typeof reason === "string" && reason.trim().length > 0
                      ? reason
                      : "Execution cancelled by user.",
                  ),
            );
          };

          if (signal?.aborted) {
            rejectWithReason();
            return;
          }

          signal?.addEventListener("abort", rejectWithReason, { once: true });
        });
      },
      continueTurn: (): Promise<never> => {
        throw new Error(
          "The streaming timeout adapter should not continue after final response.",
        );
      },
    };

    const result = await executeTask(
      "stream a final response after the original timeout",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: streamingAdapter,
        maxDurationMs: 1_000,
        idleTimeoutMs: 250,
        onStreamActivity,
      },
    );

    expect(result.status).toBe("executed");
    expect(result.reason).toBeUndefined();
    expect(onStreamActivity).toHaveBeenCalled();
  }, 10_000);

  it("classifies an idle timeout as an execution limit", async () => {
    const workspaceRoot = await createWorkspace();
    const hangingAdapter: AgentModelAdapter = {
      startTurn: ({ signal }: AgentModelStartParams) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new Error(String(signal.reason))),
            { once: true },
          );
        }),
      continueTurn: (): Promise<never> => {
        throw new Error("The hanging adapter should not continue.");
      },
    };

    const result = await executeTask(
      "wait without producing progress",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: hangingAdapter,
        maxDurationMs: 1_000,
        idleTimeoutMs: 25,
      },
    );

    expect(result.status).toBe("cancelled");
    expect(result.reason).toContain("without meaningful progress");
    expect(result.outputSections.at(-1)?.title).toBe("Execution limit");
  }, 10_000);

  it("guards against repeated identical failing tool calls in model-driven execution", async () => {
    const workspaceRoot = await createWorkspace();
    const observedToolOutputs: string[] = [];
    const progressMessages: string[] = [];
    let continueCount = 0;

    const loopingAdapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "call-1",
            name: "read_file",
            arguments: {
              path: "missing.txt",
              startLine: 1,
              endLine: 5,
            },
          },
        ],
      }),
      continueTurn: async ({ toolResults }) => {
        observedToolOutputs.push(toolResults[0]?.output ?? "");
        continueCount += 1;

        if (continueCount < 3) {
          return {
            text: "",
            toolCalls: [
              {
                id: `call-${continueCount + 1}`,
                name: "read_file",
                arguments: {
                  path: "missing.txt",
                  startLine: 1,
                  endLine: 5,
                },
              },
            ],
          };
        }

        return {
          text: "",
          toolCalls: [
            createFinalResponseToolCall({
              summary: "Changed strategy after repeated failures.",
              markdown: "Changed strategy after repeated failures.",
            }),
          ],
        };
      },
    };

    const result = await executeTask(
      "Inspect missing.txt until you find a clue.",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: loopingAdapter,
        onStateChange: (progress) => {
          progressMessages.push(progress.message);
        },
      },
    );

    expect(result.status).toBe("executed");
    expect(observedToolOutputs).toHaveLength(3);
    expect(observedToolOutputs[2]).toContain("Do not retry it unchanged");
    expect(progressMessages).toContain(
      "Requested read file on missing.txt lines 1-5.",
    );
    expect(
      progressMessages.some((message) =>
        message.startsWith("read file failed on missing.txt lines 1-5:"),
      ),
    ).toBe(true);
    expect(progressMessages).toContain(
      "Skipped read file on missing.txt lines 1-5: repeated unchanged failure.",
    );
    expect(
      result.outputSections.some(
        (section) =>
          section.title === "Tool retry guard" &&
          section.lines.some((line) =>
            line.includes("already failed 2 consecutive time(s)"),
          ),
      ),
    ).toBe(true);
  });

  it("dispatches only explicit structured MCP arguments and ignores task prose", async () => {
    const workspaceRoot = await createWorkspace();
    const observedToolResults: Array<{ output: string; isError?: boolean }> =
      [];
    const callToolSpy = vi
      .spyOn(mcpClientManager, "callTool")
      .mockResolvedValue({
        content: [
          {
            type: "text",
            text: "CLOUD-1781 issue details",
          },
        ],
      });
    const adapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "call-1",
            name: "mcp_call_tool",
            arguments: {
              serverId: "linear",
              toolName: "get_issue",
              arguments: { id: "CLOUD-1781" },
            },
          },
        ],
      }),
      continueTurn: async ({ toolResults }) => {
        observedToolResults.push(
          ...toolResults.map((toolResult) => ({
            output: toolResult.output,
            ...(toolResult.isError ? { isError: true } : {}),
          })),
        );

        return {
          text: "",
          toolCalls: [
            createFinalResponseToolCall({
              summary: "Implemented CLOUD-1781.",
              markdown: "Implemented CLOUD-1781.",
              verification: ["Fetched CLOUD-1781 from Linear."],
            }),
          ],
        };
      },
    };

    const result = await executeTask(
      "The quoted example Linear: CLOUD-999 must not override the tool call.",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: adapter,
        monitorModelAdapter: createAcceptingMonitorAdapter(),
      },
    );

    expect(result.status).toBe("executed");
    expect(callToolSpy).toHaveBeenCalledTimes(1);
    expect(callToolSpy).toHaveBeenCalledWith(
      workspaceRoot,
      "linear",
      "get_issue",
      { id: "CLOUD-1781" },
      expect.anything(),
    );
    expect(observedToolResults).toEqual([
      {
        output: "CLOUD-1781 issue details",
      },
    ]);
  });

  it("rejects missing read-only MCP arguments without deriving them from task prose", async () => {
    const workspaceRoot = await createWorkspace();
    const observedToolResults: Array<{ output: string; isError?: boolean }> =
      [];
    const discoverSpy = vi
      .spyOn(mcpClientManager, "discoverServerById")
      .mockResolvedValue({
        discovery: {
          serverId: "linear",
          discoveredAt: "2026-07-03T00:00:00.000Z",
          transportType: "streamable-http",
          tools: [
            {
              name: "get_issue",
              description: "Get a Linear issue.",
              inputSchema: {
                type: "object",
                required: ["id"],
                properties: {
                  id: { type: "string" },
                },
              },
              annotations: {
                readOnlyHint: true,
              },
            },
          ],
          resources: [],
          resourceTemplates: [],
          prompts: [],
        },
      });
    const callToolSpy = vi
      .spyOn(mcpClientManager, "callTool")
      .mockResolvedValue({
        content: [
          {
            type: "text",
            text: "CLOUD-1781 issue details",
          },
        ],
      });

    await writeWorkspaceMcpConfig(workspaceRoot, "linear");

    const adapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [
          {
            id: "call-1",
            name: "mcp_call_readonly_tool",
            arguments: {
              serverId: "linear",
              toolName: "get_issue",
              arguments: null,
            },
          },
        ],
      }),
      continueTurn: async ({ toolResults }) => {
        observedToolResults.push(
          ...toolResults.map((toolResult) => ({
            output: toolResult.output,
            ...(toolResult.isError ? { isError: true } : {}),
          })),
        );

        return {
          text: "",
          toolCalls: [
            createFinalResponseToolCall({
              summary: "Prepared CLOUD-1781 interview context.",
              markdown: "Prepared CLOUD-1781 interview context.",
              verification: ["Fetched CLOUD-1781 from Linear."],
            }),
          ],
        };
      },
    };

    const result = await executeTask(
      "Linear: CLOUD-1781\n\nAsk interview questions for this bug.",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: adapter,
      },
    );

    expect(result.status).toBe("executed");
    expect(discoverSpy).not.toHaveBeenCalled();
    expect(callToolSpy).not.toHaveBeenCalled();
    expect(observedToolResults).toHaveLength(1);
    expect(observedToolResults[0]).toMatchObject({ isError: true });
    expect(observedToolResults[0]?.output).toContain("arguments");
  });

  it("guards repeated invalid MCP calls after local argument validation fails", async () => {
    const workspaceRoot = await createWorkspace();
    const observedToolOutputs: string[] = [];
    const callToolSpy = vi.spyOn(mcpClientManager, "callTool");
    let continueCount = 0;
    const createInvalidMcpCall = (id: string): AgentModelToolCall => ({
      id,
      name: "mcp_call_tool",
      arguments: {
        serverId: "linear",
        toolName: "get_issue",
        arguments: null,
      },
    });
    const adapter: AgentModelAdapter = {
      startTurn: async () => ({
        text: "",
        toolCalls: [createInvalidMcpCall("call-1")],
      }),
      continueTurn: async ({ toolResults }) => {
        observedToolOutputs.push(toolResults[0]?.output ?? "");
        continueCount += 1;

        if (continueCount < 3) {
          return {
            text: "",
            toolCalls: [createInvalidMcpCall(`call-${continueCount + 1}`)],
          };
        }

        return {
          text: "",
          toolCalls: [
            createFinalResponseToolCall({
              summary: "Stopped retrying invalid MCP calls.",
              markdown: "Stopped retrying invalid MCP calls.",
            }),
          ],
        };
      },
    };

    const result = await executeTask(
      "Fetch the Linear issue details.",
      createConfig(workspaceRoot, "machdoch"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: adapter,
        monitorModelAdapter: createAcceptingMonitorAdapter(),
      },
    );

    expect(result.status).toBe("executed");
    expect(callToolSpy).not.toHaveBeenCalled();
    expect(observedToolOutputs).toHaveLength(3);
    expect(observedToolOutputs[0]).toContain(
      "Expected `arguments` to be a JSON object",
    );
    expect(observedToolOutputs[2]).toContain("Do not retry it unchanged");
  });

  it("does not leak rejected model stream progress callbacks", async () => {
    const workspaceRoot = await createWorkspace();
    let streamProgressCallbacks = 0;
    const streamingAdapter: AgentModelAdapter = {
      startTurn: async ({ onStreamEvent }) => {
        onStreamEvent?.({
          type: "text-delta",
          provider: "openai",
          delta: "Streaming draft.",
        });

        return {
          text: "",
          toolCalls: [createFinalResponseToolCall()],
        };
      },
      continueTurn: async () => {
        throw new Error("The streaming adapter should not continue.");
      },
    };

    const result = await executeTask(
      "stream a final response",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: streamingAdapter,
        onStateChange: (progress) => {
          if (progress.modelStream?.kind === "assistant") {
            streamProgressCallbacks += 1;
            return Promise.reject(new Error("progress sink failed"));
          }
        },
      },
    );

    expect(result.status).toBe("executed");
    expect(streamProgressCallbacks).toBeGreaterThan(0);
  });

  it("surfaces provider failure details in blocked model-driven results", async () => {
    const workspaceRoot = await createWorkspace();
    const progress: TaskExecutionProgress[] = [];
    const providerError = Object.assign(
      new Error(
        "The langdock provider returned 400 No body. Check MACHDOCH_LANGDOCK_BASE_URL.",
      ),
      {
        status: 400,
        code: "bad_request",
        request_id: "req_langdock_123",
      },
    );
    const failingAdapter: AgentModelAdapter = {
      startTurn: async () => {
        throw providerError;
      },
      continueTurn: async (): Promise<never> => {
        throw new Error("The failing adapter should not continue.");
      },
    };

    const result = await executeTask(
      "Run a model-driven task.",
      createConfig(workspaceRoot, "machdoch", {
        provider: "langdock",
        model: "gpt-5-mini",
      }),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: failingAdapter,
        onStateChange: (nextProgress) => {
          progress.push(nextProgress);
        },
      },
    );

    expect(result.status).toBe("blocked");
    expect(result.summary).toContain("provider langdock with model gpt-5-mini");
    expect(result.summary).toContain("400 No body");
    expect(progress.at(-1)?.message).toBe(result.summary);
    expect(
      result.outputSections.find(
        (section) => section.title === "Model runtime error",
      )?.lines,
    ).toEqual([
      "Provider: langdock",
      "Model: gpt-5-mini",
      "Status: 400",
      "Code: bad_request",
      "Request ID: req_langdock_123",
      "Delivery: DELIVERY_INDETERMINATE (automatic replay prohibited)",
      "Error: The langdock provider returned 400 No body. Check MACHDOCH_LANGDOCK_BASE_URL.",
    ]);
    expect(result.metadata?.instructionDeliveryReceipts).toEqual([
      expect.objectContaining({
        status: "indeterminate",
        requestId: "req_langdock_123",
        truncation: "none",
        bodyStored: false,
        assembledRequestDigest: expect.any(String),
      }),
    ]);
  });

  it("emits structured timeline telemetry for model usage and tool calls", async () => {
    const workspaceRoot = await createWorkspace();
    const timelineEvents: NonNullable<
      TaskExecutionProgress["timelineEvent"]
    >[] = [];

    await writeFile(join(workspaceRoot, "README.md"), "# Example");

    const telemetryAdapter: AgentModelAdapter = {
      startTurn: async ({ onStreamEvent }) => {
        onStreamEvent?.({
          type: "usage",
          provider: "openai",
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
          },
        });

        return {
          text: "",
          toolCalls: [
            {
              id: "read-readme",
              name: "read_file",
              arguments: {
                path: "README.md",
                startLine: 1,
                endLine: 2,
              },
            },
          ],
        };
      },
      continueTurn: async () => ({
        text: "",
        toolCalls: [createFinalResponseToolCall()],
      }),
    };

    const result = await executeTask(
      "Read README.md and summarize it.",
      createConfig(workspaceRoot, "ask"),
      emptyCustomizations(workspaceRoot),
      {
        modelAdapter: telemetryAdapter,
        onStateChange: (progress) => {
          if (progress.timelineEvent) {
            timelineEvents.push(progress.timelineEvent);
          }
        },
      },
    );

    expect(result.status).toBe("executed");
    expect(timelineEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "model-call",
          phase: "started",
          label: "Executor model call 1",
        }),
        expect.objectContaining({
          kind: "model-call",
          phase: "usage",
          metadata: {
            executorIteration: 1,
            modelCall: 1,
          },
          tokenUsage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
          },
        }),
        expect.objectContaining({
          kind: "tool-call",
          phase: "started",
          toolName: "read_file",
          callId: "read-readme",
        }),
        expect.objectContaining({
          kind: "tool-call",
          phase: "completed",
          toolName: "read_file",
          callId: "read-readme",
        }),
      ]),
    );
  });
});
