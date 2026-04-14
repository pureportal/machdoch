import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTaskExecutionController, executeTask } from "./execution.ts";
import type {
  CustomizationDiscoveryResult,
  ProviderAvailability,
  RunMode,
  RuntimeConfig,
  ToolName,
} from "./types.ts";

const workspacesToClean: string[] = [];

const providerAvailability: ProviderAvailability[] = [
  { provider: "openai", configured: false },
  { provider: "anthropic", configured: false },
  { provider: "google", configured: false },
];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-exec-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

const createConfig = (
  workspaceRoot: string,
  mode: RunMode,
  enabledTools: ToolName[],
): RuntimeConfig => {
  return {
    workspaceRoot,
    activeProfile: "workspace",
    availableProfiles: [{ name: "workspace", description: "Default profile" }],
    mode,
    enabledTools,
    provider: "unconfigured",
    model: "gpt-5.4-mini",
    offline: false,
    compatibility: {
      discoverGithubCustomizations: false,
    },
    providerAvailability,
  };
};

const emptyCustomizations = (
  workspaceRoot: string,
): CustomizationDiscoveryResult => {
  return {
    workspaceRoot,
    instructions: [],
    prompts: [],
    skills: [],
  };
};

afterEach(async () => {
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
      createConfig(workspaceRoot, "ask", ["filesystem", "shell"]),
      emptyCustomizations(workspaceRoot),
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

  it("runs through a real execution state machine before returning a successful result", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "README.md"), "# Example\n");

    const observedStates: string[] = [];

    const result = await executeTask(
      "show README.md",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
      {
        onStateChange: (progress) => {
          observedStates.push(progress.state);
        },
      },
    );

    expect(result.status).toBe("executed");
    expect(observedStates).toEqual([
      "starting",
      "resolving-context",
      "checking-inputs",
      "checking-policies",
      "executing",
      "verifying",
      "completed",
    ]);
  });

  it("supports cancelling the execution loop midway through the controller", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "README.md"), "# Example\n");

    const observedStates: string[] = [];
    const controller = createTaskExecutionController(
      "show README.md",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
      {
        onStateChange: (progress) => {
          observedStates.push(progress.state);

          if (progress.state === "checking-policies") {
            controller?.cancel("User cancelled the task.");
          }
        },
      },
    );

    const result = await controller.execute();

    expect(result.status).toBe("cancelled");
    expect(result.reason).toContain("User cancelled the task.");
    expect(result.outputSections.at(-1)?.title).toBe("Cancellation");
    expect(observedStates).toEqual([
      "starting",
      "resolving-context",
      "checking-inputs",
      "checking-policies",
      "cancelled",
    ]);
  });

  it("executes a safe runtime-config inspection instead of falling back to a generic workspace summary", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "inspect config",
      {
        ...createConfig(workspaceRoot, "ask", ["filesystem"]),
        workspaceConfigPath: join(workspaceRoot, ".machdoch", "config.json"),
      },
      emptyCustomizations(workspaceRoot),
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

  it("executes a safe profile inspection for named profiles", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "show profiles",
      {
        ...createConfig(workspaceRoot, "ask", ["filesystem"]),
        activeProfile: "workspace",
        availableProfiles: [
          { name: "workspace", description: "Default profile" },
          { name: "offline", description: "Offline development" },
        ],
      },
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("available runtime profiles");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Profiles",
    ]);
    expect(result.outputSections[1]?.lines).toContain(
      "workspace (active): Default profile",
    );
    expect(result.outputSections[1]?.lines).toContain(
      "offline: Offline development",
    );
  });

  it("executes a safe tool-policy inspection with resolved decisions", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "show tool policies",
      createConfig(workspaceRoot, "ask", ["filesystem", "network"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("registered tools");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Tool policies",
    ]);
    expect(result.outputSections[1]?.lines).toContain(
      "filesystem [low] -> allow",
    );
    expect(result.outputSections[1]?.lines).toContain(
      "shell [high] -> blocked",
    );
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
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      customizations,
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

  it("executes instruction-file inspection with detailed instruction metadata", async () => {
    const workspaceRoot = await createWorkspace();

    const customizations: CustomizationDiscoveryResult = {
      ...emptyCustomizations(workspaceRoot),
      instructions: [
        {
          kind: "conditional",
          path: ".machdoch/instructions/testing.instructions.md",
          name: "Testing conventions",
          description: "Prefer behavior-focused tests.",
          applyTo: "src/**/*.ts",
          keywords: ["test", "coverage"],
          priority: 70,
          body: "Prefer behavior-focused tests with clear assertions.",
        },
      ],
    };

    const result = await executeTask(
      "inspect instructions",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      customizations,
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("instruction files");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Customization summary",
      "Instruction files",
    ]);
    expect(result.outputSections[2]?.lines).toContain(
      "[conditional] Testing conventions (.machdoch/instructions/testing.instructions.md)",
    );
    expect(result.outputSections[2]?.lines).toContain("  applyTo: src/**/*.ts");
    expect(result.outputSections[2]?.lines).toContain(
      "  body: Prefer behavior-focused tests with clear assertions.",
    );
  });

  it("executes skill inspection with discovered skill metadata", async () => {
    const workspaceRoot = await createWorkspace();

    const customizations: CustomizationDiscoveryResult = {
      ...emptyCustomizations(workspaceRoot),
      skills: [
        {
          path: ".machdoch/skills/browser-automation/SKILL.md",
          name: "browser-automation",
          description: "Automates browser tasks.",
          argumentHint: "Target site and desired outcome",
          userInvocable: true,
          disableModelInvocation: false,
        },
      ],
    };

    const result = await executeTask(
      "show skills",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      customizations,
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("skill folders");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Customization summary",
      "Skill files",
    ]);
    expect(result.outputSections[2]?.lines).toContain(
      "browser-automation (.machdoch/skills/browser-automation/SKILL.md)",
    );
    expect(result.outputSections[2]?.lines).toContain("  user invocable: true");
  });

  it("executes generic customization inspection and reports empty states cleanly", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "inspect customizations",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("executed");
    expect(result.summary).toContain("workspace customizations");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Task context",
      "Customization summary",
      "Instruction files",
      "Prompt files",
      "Skill files",
    ]);
    expect(result.outputSections[2]?.lines).toEqual([
      "No instruction files were discovered.",
    ]);
    expect(result.outputSections[3]?.lines).toEqual([
      "No prompt files were discovered.",
    ]);
    expect(result.outputSections[4]?.lines).toEqual([
      "No skill folders were discovered.",
    ]);
  });

  it("does not treat mixed read-only and mutating tasks as deterministic inspections", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "inspect config and update profiles",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("unsupported");
    expect(result.executedTools).toEqual([]);
  });

  it("requires approval in safe mode before even low-risk filesystem inspection", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "summarize this project setup",
      createConfig(workspaceRoot, "safe", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("approval-required");
    expect(result.executedTools).toEqual([]);
    expect(result.reason).toContain("requires approval");
  });

  it("blocks execution when the filesystem tool is disabled", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "inspect this workspace",
      createConfig(workspaceRoot, "ask", ["shell"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("not enabled");
  });

  it("falls back to preview mode for unsupported tasks", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "install dependencies and commit the changes",
      createConfig(workspaceRoot, "ask", ["filesystem", "shell", "git"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("unsupported");
    expect(result.executedTools).toEqual([]);
  });

  it("executes a safe text preview for an explicit file request inside the workspace", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(
      join(workspaceRoot, "README.md"),
      ["# machdoch", "", "Local-first OS AI agent"].join("\n"),
    );

    const result = await executeTask(
      "show README.md",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
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
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      customizations,
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
      createConfig(workspaceRoot, "ask", ["filesystem"]),
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

  it("surfaces applicable instruction context during prompt-driven execution", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, "src", "core"), { recursive: true });
    await writeFile(
      join(workspaceRoot, "src", "core", "config.ts"),
      "export const config = {}\n",
    );

    const customizations: CustomizationDiscoveryResult = {
      ...emptyCustomizations(workspaceRoot),
      instructions: [
        {
          kind: "always-on",
          path: ".machdoch/instructions.md",
          name: "Workspace defaults",
          body: "Always follow the shared workspace defaults.",
          keywords: [],
        },
        {
          kind: "conditional",
          path: ".machdoch/instructions/typescript.instructions.md",
          name: "TypeScript rules",
          body: "Prefer strict TypeScript conventions in source files.",
          applyTo: "src/**/*.ts",
          keywords: [],
          priority: 80,
        },
      ],
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
      "/show-file file=src/core/config.ts",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      customizations,
    );

    expect(result.status).toBe("executed");
    expect(result.outputSections.map((section) => section.title)).toEqual([
      "Prompt context",
      "Task context",
      "Instruction context",
      "File target",
      "File preview",
    ]);
    expect(result.outputSections[2]?.lines).toContain(
      "TypeScript rules (.machdoch/instructions/typescript.instructions.md) [priority 80]",
    );
    expect(result.outputSections[2]?.lines).toContain(
      "  body: Prefer strict TypeScript conventions in source files.",
    );
  });

  it("executes a safe directory listing for an explicit workspace folder", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, "src", "core"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "main.ts"), "export {};\n");

    const result = await executeTask(
      "list src",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
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
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("executed");
    expect(result.outputSections[2]?.lines).toEqual(["Directory is empty."]);
  });

  it("reports a missing explicit path cleanly", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      "show missing.txt",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("missing.txt");
  });

  it("blocks file reads that resolve outside the workspace", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await executeTask(
      'read "../machdoch-secret.txt"',
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("blocked");
    expect(result.reason).toContain("outside");
  });

  it("handles binary-looking files without dumping raw bytes", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "sample.bin"), Buffer.from([0, 1, 2]));

    const result = await executeTask(
      "inspect sample.bin",
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
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
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
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
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("executed");
    expect(result.outputSections[3]?.lines).toContain(
      "package.json: present but invalid JSON",
    );
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
      createConfig(workspaceRoot, "ask", ["filesystem"]),
      emptyCustomizations(workspaceRoot),
    );

    expect(result.status).toBe("executed");
    expect(result.outputSections[2]?.lines.at(-1)).toBe(
      "… 3 more top-level entries",
    );
  });
});
