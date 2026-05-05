/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolExecutionContext } from "./agent-tools-shared.js";

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

type ExecFileMock = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
  callback: ExecFileCallback,
) => unknown;

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn<ExecFileMock>(),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();

  return {
    ...actual,
    execFile: execFileMock,
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

const createExecError = (
  message: string,
  stderr: string,
  code = 1,
): Error => {
  return Object.assign(new Error(message), {
    code,
    stdout: "",
    stderr,
  });
};

const queueCommandResponses = (...responses: CommandResponse[]): void => {
  const pendingResponses = [...responses];

  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    const response = pendingResponses.shift() ?? {};

    callback(
      response.error ?? null,
      response.stdout ?? "",
      response.stderr ?? "",
    );

    return undefined;
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
  execFileMock.mockReset();

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
    expect(result.toolResult.output).toContain("Scripts: build, test");
    expect(result.toolResult.output).toContain("lockfileVersion=3");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("runs declared package scripts through the detected manager", async () => {
    const workspaceRoot = await createWorkspace();

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
    expect(execFileMock).toHaveBeenCalledWith(
      "npm",
      ["run", "test", "--", "--runInBand"],
      expect.objectContaining({
        cwd: workspaceRoot,
        timeout: 10_000,
        maxBuffer: 1_500_000,
        windowsHide: true,
      }),
      expect.any(Function),
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
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("parses npm outdated JSON even when npm exits with code 1 for outdated dependencies", async () => {
    const workspaceRoot = await createWorkspace();

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
      "react · current=19.0.0 · wanted=19.2.5 · latest=19.2.5",
    );
    expect(execFileMock).toHaveBeenCalledWith(
      "npm",
      ["outdated", "--json"],
      expect.objectContaining({
        cwd: workspaceRoot,
      }),
      expect.any(Function),
    );
  });

  it("installs registry package specs with safe direct argv construction", async () => {
    const workspaceRoot = await createWorkspace();

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
    expect(execFileMock).toHaveBeenCalledWith(
      "npm",
      [
        "install",
        "--save-dev",
        "--save-exact",
        "--package-lock-only",
        "@types/node@latest",
      ],
      expect.objectContaining({
        cwd: workspaceRoot,
      }),
      expect.any(Function),
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
    expect(execFileMock).not.toHaveBeenCalled();
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
});
