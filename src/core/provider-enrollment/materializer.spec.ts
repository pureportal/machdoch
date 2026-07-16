import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentCliProvider } from "../runtime-contract.generated.js";
import type { ResolvedTaskContext } from "../types.js";
import { materializeCliEnrollment } from "./materializer.js";
import { compileInstructionBundle } from "./instruction-compiler.js";

const roots: string[] = [];

const createRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "machdoch-materializer-test-"));
  roots.push(root);
  return root;
};

const createTaskContext = (): ResolvedTaskContext => ({
  task: "test native enrollment",
  effectiveTask: "test native enrollment",
  taskContextText: "test native enrollment",
  instructionContextText: "test native enrollment",
  workspacePaths: [],
  suggestedTools: [],
  instructionAudience: "executor",
  applicableInstructions: [{
    id: "instruction-test",
    bodyHash: "ignored-and-recomputed",
    kind: "always-on",
    name: "Test policy",
    path: ".machdoch/instructions.md",
    priority: 1,
    body: "Use the managed test policy.",
    reason: "always",
  }],
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
    await writeFile(join(userConfigRoot, "user-config.json"), "{}\n", "utf8");
    vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", userConfigRoot);
    vi.stubEnv("CODEX_HOME", codexSourceHome);

    const taskContext = createTaskContext();
    const enrollment = await materializeCliEnrollment({
      provider,
      executable: process.execPath,
      runId: `test-${provider}`,
      workspaceRoot,
      taskContext,
    });

    expect(enrollment.instructionBundle.digest).toBe(
      compileInstructionBundle(taskContext).digest,
    );
    expect(enrollment.manifest.coverageSummary.complete).toBe(true);
    expect(enrollment.manifest.instructionBundle.sources).toEqual([
      expect.objectContaining({ id: "instruction-test" }),
    ]);
    expect(enrollment.manifest.coverage).toContainEqual(expect.objectContaining({
      entityId: "instruction-test",
      route: "cli-native-instruction",
      fidelity: "exact",
      refreshState: "filesystem-current",
    }));

    if (provider === "codex-cli") {
      const configPath = enrollment.manifest.renderedFiles[0]?.path;
      expect(configPath).toBeDefined();
      expect(await readFile(configPath!, "utf8")).toContain("developer_instructions");
      expect(enrollment.env.CODEX_HOME).toContain("codex-home");
    } else if (provider === "claude-cli") {
      expect(enrollment.args).toContain("--append-system-prompt-file");
      expect(enrollment.args).toContain("--mcp-config");
      expect(enrollment.args).not.toContain("--strict-mcp-config");
    } else {
      expect(enrollment.args).toContain("--allow-all-mcp-server-instructions");
      expect(enrollment.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS).toContain("custom-instructions");
    }

    const enrollmentRoot = enrollment.rootPath;
    await enrollment.dispose();
    await expect(stat(enrollmentRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("renders the Codex isolated AGENTS fallback without replacing built-in model instructions", async () => {
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

    const enrollment = await materializeCliEnrollment({
      provider: "codex-cli",
      executable: process.execPath,
      runId: "test-codex-agents-fallback",
      workspaceRoot,
      taskContext: createTaskContext(),
      codexInstructionFallback: true,
    });
    const configFile = enrollment.manifest.renderedFiles.find(
      (file) => file.path.endsWith("config.toml"),
    );
    const agentsFile = enrollment.manifest.renderedFiles.find(
      (file) => file.path.endsWith("AGENTS.md"),
    );
    expect(await readFile(configFile!.path, "utf8")).not.toContain("developer_instructions");
    expect(await readFile(agentsFile!.path, "utf8")).toContain("Use the managed test policy.");
    expect(enrollment.manifest.warnings).toContainEqual(
      expect.stringContaining("isolated-home AGENTS fallback"),
    );
    await enrollment.dispose();
  });
});
