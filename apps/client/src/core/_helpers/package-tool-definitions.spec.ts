/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolExecutionContext } from "./agent-tools-shared.js";

import type {
  LocalCommandOptions,
  LocalCommandResult,
} from "./process-execution.ts";

type ExecuteCommandMock = (
  file: string,
  args: string[],
  options: LocalCommandOptions,
) => Promise<LocalCommandResult>;

const { executeCommandMock } = vi.hoisted(() => ({
  executeCommandMock: vi.fn<ExecuteCommandMock>(),
}));

vi.mock("./process-execution.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./process-execution.ts")>();

  return {
    ...actual,
    executeLocalCommand: executeCommandMock,
  };
});

import { createPackageToolDefinitions } from "./package-tool-definitions.ts";

interface CommandResponse {
  stdout?: string;
  stderr?: string;
  error?: Error;
}

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-packages-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

const resolveExpectedPackageRoot = async (
  workspaceRoot: string,
): Promise<string> => {
  return await realpath(workspaceRoot);
};

const createExecutionContext = (
  workspaceRoot: string,
): AgentToolExecutionContext => {
  return {
    workspaceRoot,
    memory: {
      sessionEnabled: false,
      sessionEntries: [],
      globalEnabled: false,
      globalEntries: [],
    },
  };
};

const createPackageJson = async (
  workspaceRoot: string,
  overrides: Record<string, unknown> = {},
): Promise<void> => {
  await writeFile(
    join(workspaceRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "demo-package",
        version: "1.2.3",
        private: true,
        scripts: {
          test: "vitest run",
          build: "tsc -p tsconfig.json",
        },
        dependencies: {
          react: "^19.0.0",
        },
        devDependencies: {
          typescript: "^5.8.3",
        },
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const createExecError = (message: string, stderr: string, code = 1): Error => {
  return Object.assign(new Error(message), {
    code,
    stdout: "",
    stderr,
  });
};

const queueCommandResponses = (...responses: CommandResponse[]): void => {
  const pendingResponses = [...responses];

  executeCommandMock.mockImplementation(async (_file, _args, options) => {
    const response = pendingResponses.shift() ?? {};

    const code =
      response.error && "code" in response.error
        ? response.error.code
        : undefined;
    if (
      response.error &&
      !(typeof code === "number" && options.acceptedExitCodes?.includes(code))
    ) {
      throw Object.assign(response.error, {
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      });
    }
    return {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      exitCode: typeof code === "number" ? code : 0,
    };
  });
};

const getPackageTool = (name: string) => {
  const tool = createPackageToolDefinitions().find(
    (definition) => definition.spec.name === name,
  );

  if (!tool) {
    throw new Error(`Missing package tool ${name}`);
  }

  return tool;
};

afterEach(async () => {
  executeCommandMock.mockReset();

  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("createPackageToolDefinitions", () => {
  it("registers read, network-inspection, and mutating package tools", () => {
    expect(
      createPackageToolDefinitions().map((definition) => ({
        name: definition.spec.name,
        riskLevel: definition.riskLevel,
        backingTool: definition.backingTool,
      })),
    ).toEqual([
      {
        name: "inspect_node_package",
        riskLevel: "low",
        backingTool: "packages",
      },
      {
        name: "run_node_package_script",
        riskLevel: "high",
        backingTool: "packages",
      },
      {
        name: "check_node_package_outdated",
        riskLevel: "medium",
        backingTool: "packages",
      },
      {
        name: "audit_node_package_dependencies",
        riskLevel: "medium",
        backingTool: "packages",
      },
      {
        name: "install_node_packages",
        riskLevel: "high",
        backingTool: "packages",
      },
    ]);
  });

  it("inspects a package manifest and package-lock metadata without running commands", async () => {
    const workspaceRoot = await createWorkspace();

    await createPackageJson(workspaceRoot);
    await writeFile(
      join(workspaceRoot, "package-lock.json"),
      JSON.stringify(
        {
          name: "demo-package",
          version: "1.2.3",
          lockfileVersion: 3,
          packages: {
            "": {},
            "node_modules/react": {},
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await getPackageTool("inspect_node_package").execute(
      {},
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("Package: demo-package");
    expect(result.toolResult.output).toContain("Manager: npm");
    expect(result.toolResult.output).toContain("Manager source: lockfile");
    expect(result.toolResult.output).toContain("Scripts: build, test");
    expect(result.toolResult.output).toContain("lockfileVersion=3");
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it("runs declared package scripts through the detected manager", async () => {
    const workspaceRoot = await createWorkspace();
    const packageRoot = await resolveExpectedPackageRoot(workspaceRoot);

    await createPackageJson(workspaceRoot);
    queueCommandResponses({ stdout: "tests passed" });

    const result = await getPackageTool("run_node_package_script").execute(
      {
        script: "test",
        args: ["--runInBand"],
        timeoutMs: 10_000,
      },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("tests passed");
    expect(executeCommandMock).toHaveBeenCalledWith(
      "npm",
      ["run", "test", "--", "--runInBand"],
      expect.objectContaining({
        cwd: packageRoot,
        timeoutMs: 10_000,
        maxBufferBytes: 1_500_000,
      }),
    );
  });

  it("refuses to run scripts that are not declared in package.json", async () => {
    const workspaceRoot = await createWorkspace();

    await createPackageJson(workspaceRoot);

    const result = await getPackageTool("run_node_package_script").execute(
      { script: "deploy" },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("does not declare");
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it("parses npm outdated JSON even when npm exits with code 1 for outdated dependencies", async () => {
    const workspaceRoot = await createWorkspace();
    const packageRoot = await resolveExpectedPackageRoot(workspaceRoot);

    await createPackageJson(workspaceRoot);
    queueCommandResponses({
      error: createExecError("npm outdated", ""),
      stdout: JSON.stringify({
        react: {
          current: "19.0.0",
          wanted: "19.2.5",
          latest: "19.2.5",
          type: "dependencies",
        },
      }),
    });

    const result = await getPackageTool("check_node_package_outdated").execute(
      { maxResults: 5 },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("Outdated dependencies: 1");
    expect(result.toolResult.output).toContain(
      "react - current=19.0.0 - wanted=19.2.5 - latest=19.2.5",
    );
    expect(executeCommandMock).toHaveBeenCalledWith(
      "npm",
      ["outdated", "--json"],
      expect.objectContaining({
        cwd: packageRoot,
      }),
    );
  });

  it("checks pnpm outdated metadata using pnpm JSON output", async () => {
    const workspaceRoot = await createWorkspace();
    const packageRoot = await resolveExpectedPackageRoot(workspaceRoot);

    await createPackageJson(workspaceRoot, {
      packageManager: "pnpm@10.0.0",
    });
    queueCommandResponses({
      stdout: JSON.stringify([
        {
          name: "vite",
          current: "8.0.0",
          wanted: "8.0.8",
          latest: "8.0.8",
          dependencyType: "devDependencies",
        },
      ]),
    });

    const result = await getPackageTool("check_node_package_outdated").execute(
      { maxResults: 5 },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("Manager: pnpm");
    expect(result.toolResult.output).toContain("vite - current=8.0.0");
    expect(executeCommandMock).toHaveBeenCalledWith(
      "pnpm",
      ["outdated", "--format", "json"],
      expect.objectContaining({
        cwd: packageRoot,
      }),
    );
  });

  it("summarizes npm audit JSON without treating vulnerabilities as command failures", async () => {
    const workspaceRoot = await createWorkspace();
    const packageRoot = await resolveExpectedPackageRoot(workspaceRoot);

    await createPackageJson(workspaceRoot);
    queueCommandResponses({
      error: createExecError("npm audit", ""),
      stdout: JSON.stringify({
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 1,
            critical: 0,
            total: 1,
          },
        },
        vulnerabilities: {
          vite: {
            severity: "high",
            range: "<8.0.8",
            via: [{ title: "Vite dev server exposure" }],
            fixAvailable: true,
          },
        },
      }),
    });

    const result = await getPackageTool(
      "audit_node_package_dependencies",
    ).execute(
      {
        auditLevel: "moderate",
        productionOnly: true,
        maxResults: 5,
      },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("Vulnerabilities: 1");
    expect(result.toolResult.output).toContain(
      "Severity counts: info=0, low=0, moderate=0, high=1, critical=0",
    );
    expect(result.toolResult.output).toContain("vite (high)");
    expect(executeCommandMock).toHaveBeenCalledWith(
      "npm",
      ["audit", "--json", "--audit-level=moderate", "--production"],
      expect.objectContaining({
        cwd: packageRoot,
      }),
    );
  });

  it("installs registry package specs with safe direct argv construction", async () => {
    const workspaceRoot = await createWorkspace();
    const packageRoot = await resolveExpectedPackageRoot(workspaceRoot);

    await createPackageJson(workspaceRoot);
    queueCommandResponses({ stdout: "added 1 package" });

    const result = await getPackageTool("install_node_packages").execute(
      {
        packages: ["@types/node@latest"],
        dev: true,
        exact: true,
        lockfileOnly: true,
      },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("added 1 package");
    expect(executeCommandMock).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "--save-dev",
        "--save-exact",
        "--package-lock-only",
        "@types/node@latest",
      ],
      expect.objectContaining({
        cwd: packageRoot,
      }),
    );
  });

  it("rejects local file package specs", async () => {
    const workspaceRoot = await createWorkspace();

    await createPackageJson(workspaceRoot);

    const result = await getPackageTool("install_node_packages").execute(
      { packages: ["file:../outside-package"] },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain("registry package specs");
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it("rejects Git and remote package specs", async () => {
    const workspaceRoot = await createWorkspace();

    await createPackageJson(workspaceRoot);

    for (const packageSpec of [
      "github:owner/repo",
      "alias@github:owner/repo",
      "alias@file:../outside-package",
      "zod@https://registry.npmjs.org/zod/-/zod-3.21.4.tgz",
    ]) {
      const result = await getPackageTool("install_node_packages").execute(
        { packages: [packageSpec] },
        createExecutionContext(workspaceRoot),
      );

      expect(result.toolResult.isError).toBe(true);
      expect(result.toolResult.output).toContain("Git specs");
    }

    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it("uses bun lockfile-only installs when bun is the detected manager", async () => {
    const workspaceRoot = await createWorkspace();
    const packageRoot = await resolveExpectedPackageRoot(workspaceRoot);

    await createPackageJson(workspaceRoot, {
      packageManager: "bun@1.2.0",
    });
    queueCommandResponses({ stdout: "saved lockfile" });

    const result = await getPackageTool("install_node_packages").execute(
      {
        packages: ["vite@latest"],
        lockfileOnly: true,
      },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(executeCommandMock).toHaveBeenCalledWith(
      "bun",
      ["add", "--lockfile-only", "vite@latest"],
      expect.objectContaining({
        cwd: packageRoot,
      }),
    );
  });

  it("resolves package.json files inside nested workspace packages", async () => {
    const workspaceRoot = await createWorkspace();
    const packageRoot = join(workspaceRoot, "packages", "app");

    await mkdir(packageRoot, { recursive: true });
    await createPackageJson(packageRoot, {
      name: "nested-app",
      packageManager: "pnpm@10.0.0",
    });

    const result = await getPackageTool("inspect_node_package").execute(
      { packagePath: "packages/app/package.json" },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("Package: nested-app");
    expect(result.toolResult.output).toContain("Manager: pnpm");
  });

  it("discovers declared package workspaces during inspection", async () => {
    const workspaceRoot = await createWorkspace();
    const appRoot = join(workspaceRoot, "packages", "app");
    const libRoot = join(workspaceRoot, "packages", "lib");

    await mkdir(appRoot, { recursive: true });
    await mkdir(libRoot, { recursive: true });
    await createPackageJson(workspaceRoot, {
      workspaces: ["packages/*"],
    });
    await createPackageJson(appRoot, {
      name: "workspace-app",
      scripts: {
        test: "vitest",
      },
    });
    await createPackageJson(libRoot, {
      name: "workspace-lib",
      private: false,
      dependencies: {
        zod: "^4.0.0",
      },
    });

    const result = await getPackageTool("inspect_node_package").execute(
      {},
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain(
      "Workspace patterns: packages/*",
    );
    expect(result.toolResult.output).toContain("Workspace packages: 2");
    expect(result.toolResult.output).toContain("packages/app: workspace-app");
    expect(result.toolResult.output).toContain("packages/lib: workspace-lib");
  });
});
