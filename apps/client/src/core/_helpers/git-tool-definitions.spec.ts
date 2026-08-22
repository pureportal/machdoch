/// <reference types="vitest/globals" />

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

import {
  createGitToolDefinitions,
  parseGitStatusPorcelain,
} from "./git-tool-definitions.ts";

interface GitMockResponse {
  stdout?: string;
  stderr?: string;
  error?: Error;
}

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-git-tools-"));
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

const queueGitResponses = (...responses: GitMockResponse[]): void => {
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

const getGitTool = (name: string) => {
  const tool = createGitToolDefinitions().find(
    (definition) => definition.spec.name === name,
  );

  if (!tool) {
    throw new Error(`Missing Git tool ${name}`);
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

describe("parseGitStatusPorcelain", () => {
  it("extracts branch metadata and changed-path counts", () => {
    expect(
      parseGitStatusPorcelain(
        [
          "## main...origin/main [ahead 1]",
          "M  src/core/config.ts",
          " M README.md",
          "?? src/new-file.ts",
          "UU src/conflict.ts",
        ].join("\n"),
      ),
    ).toEqual({
      branchLine: "main...origin/main [ahead 1]",
      entries: [
        "M  src/core/config.ts",
        " M README.md",
        "?? src/new-file.ts",
        "UU src/conflict.ts",
      ],
      stagedCount: 2,
      unstagedCount: 2,
      untrackedCount: 1,
      conflictedCount: 1,
    });
  });
});

describe("createGitToolDefinitions", () => {
  it("registers low-risk read tools and a medium-risk commit tool", () => {
    expect(
      createGitToolDefinitions().map((definition) => ({
        name: definition.spec.name,
        riskLevel: definition.riskLevel,
        backingTool: definition.backingTool,
      })),
    ).toEqual([
      {
        name: "get_git_status",
        riskLevel: "low",
        backingTool: "git",
      },
      {
        name: "get_git_diff_summary",
        riskLevel: "low",
        backingTool: "git",
      },
      {
        name: "get_git_log",
        riskLevel: "low",
        backingTool: "git",
      },
      {
        name: "create_git_commit",
        riskLevel: "medium",
        backingTool: "git",
      },
    ]);
  });

  it("inspects Git status with stable porcelain output", async () => {
    const workspaceRoot = await createWorkspace();

    queueGitResponses(
      { stdout: workspaceRoot },
      {
        stdout: [
          "## main...origin/main [ahead 1]",
          "M  src/core/config.ts",
          "?? src/new-file.ts",
        ].join("\n"),
      },
    );

    const result = await getGitTool("get_git_status").execute(
      { maxEntries: 10 },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain(
      "Branch: main...origin/main [ahead 1]",
    );
    expect(result.toolResult.output).toContain("Staged: 1");
    expect(result.toolResult.output).toContain("Untracked: 1");
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "git",
      ["status", "--porcelain=v1", "--branch", "--untracked-files=all"],
      expect.objectContaining({
        timeout: 15_000,
        maxBuffer: 1_000_000,
        windowsHide: true,
      }),
      expect.any(Function),
    );
  });

  it("limits a staged diff summary to validated repository paths", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, "src"), { recursive: true });
    await writeFile(join(workspaceRoot, "src", "app.ts"), "export {};\n");
    queueGitResponses(
      { stdout: workspaceRoot },
      {
        stdout: [
          "M\tsrc/app.ts",
          " src/app.ts | 2 +-",
          " 1 file changed, 1 insertion(+), 1 deletion(-)",
        ].join("\n"),
      },
    );

    const result = await getGitTool("get_git_diff_summary").execute(
      { scope: "staged", paths: ["src/app.ts"], maxFiles: 5 },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("Scope: staged");
    expect(result.toolResult.output).toContain("M\tsrc/app.ts");
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "git",
      [
        "diff",
        "--no-color",
        "--name-status",
        "--stat",
        "--cached",
        "--",
        "src/app.ts",
      ],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("creates a commit by staging only the requested paths first", async () => {
    const workspaceRoot = await createWorkspace();

    await writeFile(join(workspaceRoot, "README.md"), "# machdoch\n");
    queueGitResponses(
      { stdout: workspaceRoot },
      { stdout: "" },
      { stdout: "[main abc1234] Improve README\n 1 file changed" },
      { stdout: "abc1234" },
    );

    const result = await getGitTool("create_git_commit").execute(
      {
        message: "Improve README",
        paths: ["README.md"],
      },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBeUndefined();
    expect(result.toolResult.output).toContain("Created commit: abc1234");
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "git",
      ["add", "--", "README.md"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      3,
      "git",
      ["commit", "-m", "Improve README"],
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("blocks Git execution when the repository root escapes the workspace", async () => {
    const workspaceRoot = await createWorkspace();
    const parentRoot = dirname(workspaceRoot);

    queueGitResponses({ stdout: parentRoot });

    const result = await getGitTool("get_git_status").execute(
      {},
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain(
      "outside the active workspace boundary",
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces Git command stderr on failures", async () => {
    const workspaceRoot = await createWorkspace();

    queueGitResponses(
      { stdout: workspaceRoot },
      {
        error: createExecError(
          "git commit failed",
          "nothing to commit, working tree clean",
        ),
        stderr: "nothing to commit, working tree clean",
      },
    );

    const result = await getGitTool("create_git_commit").execute(
      { message: "No changes" },
      createExecutionContext(workspaceRoot),
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.output).toContain(
      "nothing to commit, working tree clean",
    );
  });
});
