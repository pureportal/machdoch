import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFlow } from "../../core/__test__/ralph-test-helpers.ts";
import { parseCliArgs } from "./cli-args.ts";
import { printInstructionSummary } from "./cli-instruction-commands.ts";

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-cli-instr-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

const captureStdout = async (run: () => Promise<void>): Promise<string> => {
  let output = "";
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });

  try {
    await run();
  } finally {
    writeSpy.mockRestore();
  }

  return output;
};

const writeStoredRalphFlow = async (
  workspaceRoot: string,
  id: string,
): Promise<void> => {
  await mkdir(join(workspaceRoot, ".machdoch", "ralph", "flows"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, ".machdoch", "ralph", "flows", `${id}.json`),
    JSON.stringify(
      createFlow({
        id,
        alias: "flow-alias",
        name: "Flow Alias",
      }),
      null,
      2,
    ),
  );
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

describe("printInstructionSummary", () => {
  it("filters JSON instruction lists by compatibility scope", async () => {
    const workspaceRoot = await createWorkspace();
    await mkdir(join(workspaceRoot, ".machdoch"), { recursive: true });
    await mkdir(join(workspaceRoot, ".github"), { recursive: true });
    await writeFile(
      join(workspaceRoot, ".machdoch", "config.json"),
      JSON.stringify({
        compatibility: { discoverGithubCustomizations: true },
      }),
    );
    await writeFile(
      join(workspaceRoot, ".machdoch", "instructions.md"),
      "---\nmode: sometimes\n---\nWorkspace rules.",
    );
    await writeFile(
      join(workspaceRoot, ".github", "copilot-instructions.md"),
      "Compatibility rules.",
    );

    const output = await captureStdout(async () => {
      await printInstructionSummary(
        parseCliArgs(
          [
            "--json",
            "--cwd",
            workspaceRoot,
            "instructions",
            "list",
            "--scope",
            "compatibility",
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      );
    });
    const parsed = JSON.parse(output) as {
      instructions: Array<{ path: string; scope?: string }>;
      diagnostics: unknown[];
    };

    expect(parsed.instructions).toEqual([
      {
        kind: "always-on",
        path: ".github/copilot-instructions.md",
        name: "copilot-instructions",
        body: "Compatibility rules.",
        keywords: [],
        scope: "compatibility",
      },
    ]);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("creates and lists instructions scoped to a Ralph flow", async () => {
    const workspaceRoot = await createWorkspace();
    await writeStoredRalphFlow(workspaceRoot, "flow-one");

    const createOutput = await captureStdout(async () => {
      await printInstructionSummary(
        parseCliArgs(
          [
            "--json",
            "--cwd",
            workspaceRoot,
            "instructions",
            "create",
            "Flow Rules",
            "--scope",
            "ralph-flow",
            "--ralph-flow",
            "flow-alias",
            "--keyword",
            "flow",
            "--prompt",
            "Keep flow steps focused.",
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      );
    });
    const created = JSON.parse(createOutput) as {
      scope: string;
      ralphFlow?: { id: string; scope: string };
      path: string;
    };

    expect(created).toMatchObject({
      scope: "ralph-flow",
      ralphFlow: {
        id: "flow-one",
        scope: "workspace",
      },
    });
    expect(created.path).toBe(
      join(
        workspaceRoot,
        ".machdoch",
        "ralph",
        "instructions",
        "flow-one",
        "instructions",
        "flow-rules.instructions.md",
      ),
    );

    const listOutput = await captureStdout(async () => {
      await printInstructionSummary(
        parseCliArgs(
          [
            "--json",
            "--cwd",
            workspaceRoot,
            "instructions",
            "list",
            "--scope",
            "ralph-flow",
            "--ralph-flow",
            "flow-one",
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      );
    });
    const listed = JSON.parse(listOutput) as {
      instructions: Array<{
        name: string;
        scope?: string;
        ralphFlowId?: string;
        ralphFlowScope?: string;
      }>;
      diagnostics: unknown[];
    };

    expect(listed.instructions).toMatchObject([
      {
        name: "Flow Rules",
        scope: "ralph-flow",
        ralphFlowId: "flow-one",
        ralphFlowScope: "workspace",
      },
    ]);
    expect(listed.diagnostics).toEqual([]);
  });
});
