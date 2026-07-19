import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateInstructionFileContent,
  writeInstructionFile,
} from "./instructions.ts";
import { withCooperativeFileLock } from "./_helpers/with-cooperative-file-lock.helper.ts";

const workspacesToClean: string[] = [];
const originalUserConfigDirectory = process.env.MACHDOCH_USER_CONFIG_DIR;

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-instructions-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
};

afterEach(async () => {
  if (originalUserConfigDirectory === undefined) {
    delete process.env.MACHDOCH_USER_CONFIG_DIR;
  } else {
    process.env.MACHDOCH_USER_CONFIG_DIR = originalUserConfigDirectory;
  }

  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("instruction file helpers", () => {
  it("creates workspace instruction files with structured metadata", async () => {
    const workspaceRoot = await createWorkspace();

    const result = await writeInstructionFile(workspaceRoot, {
      name: "Code Review",
      body: "Prefer strict TypeScript and focused regression tests.",
      scope: "workspace",
      mode: "auto",
      audience: "executor",
      applyTo: ["src/**/*.ts", "tests/**/*.ts"],
      exclude: ["src/generated/**"],
      keywords: ["review"],
      priority: 25,
    });

    expect(result).toEqual({
      path: join(
        workspaceRoot,
        ".machdoch",
        "instructions",
        "code-review.instructions.md",
      ),
      scope: "workspace",
      name: "Code Review",
      created: true,
    });

    await expect(readFile(result.path, "utf8")).resolves.toContain(
      "applyTo:\n  - src/**/*.ts\n  - tests/**/*.ts",
    );
    await expect(
      writeInstructionFile(workspaceRoot, {
        name: "Code Review",
        body: "Updated.",
        scope: "workspace",
      }),
    ).rejects.toThrow(/already exists/u);
  });

  it("overwrites an explicit instruction path when requested", async () => {
    const workspaceRoot = await createWorkspace();
    const path = ".machdoch/instructions/custom-name.instructions.md";

    const created = await writeInstructionFile(
      workspaceRoot,
      {
        name: "Original Name",
        body: "Original body.",
        scope: "workspace",
      },
      { path },
    );
    const updated = await writeInstructionFile(
      workspaceRoot,
      {
        name: "Updated Name",
        body: "Updated body.",
        scope: "workspace",
      },
      { path, overwrite: true },
    );

    expect(created.created).toBe(true);
    expect(updated.created).toBe(false);
    await expect(readFile(updated.path, "utf8")).resolves.toContain(
      "Updated body.",
    );
  });

  it("resolves user-scope relative paths inside the user instruction area", async () => {
    const workspaceRoot = await createWorkspace();
    const userConfigRoot = join(workspaceRoot, ".user-config");
    process.env.MACHDOCH_USER_CONFIG_DIR = userConfigRoot;

    const conditional = await writeInstructionFile(
      workspaceRoot,
      {
        name: "Global Review",
        body: "Apply global review preferences.",
        scope: "user",
      },
      { path: "global-review.instructions.md" },
    );
    const alwaysOn = await writeInstructionFile(
      workspaceRoot,
      {
        name: "Global Defaults",
        body: "Apply global defaults.",
        scope: "user",
      },
      { path: "instructions.md" },
    );

    expect(conditional.path).toBe(
      join(userConfigRoot, "instructions", "global-review.instructions.md"),
    );
    expect(alwaysOn.path).toBe(join(userConfigRoot, "instructions.md"));
  });

  it("serializes user instruction writes with the settings transfer boundary", async () => {
    const workspaceRoot = await createWorkspace();
    const userConfigRoot = join(workspaceRoot, ".user-config");
    const boundaryPath = join(
      userConfigRoot,
      "instructions.transfer-boundary",
    );
    const instructionPath = join(
      userConfigRoot,
      "instructions",
      "transfer-safe.instructions.md",
    );
    process.env.MACHDOCH_USER_CONFIG_DIR = userConfigRoot;

    let releaseBoundary = (): void => undefined;
    let signalBoundaryHeld = (): void => undefined;
    const boundaryHeld = new Promise<void>((resolve) => {
      signalBoundaryHeld = resolve;
    });
    const boundaryRelease = new Promise<void>((resolve) => {
      releaseBoundary = resolve;
    });
    const lockHolder = withCooperativeFileLock(boundaryPath, async () => {
      signalBoundaryHeld();
      await boundaryRelease;
    });
    await boundaryHeld;

    let writeSettled = false;
    const write = writeInstructionFile(workspaceRoot, {
      name: "Transfer Safe",
      body: "Do not interleave this write with a settings transfer.",
      scope: "user",
    }).finally(() => {
      writeSettled = true;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(writeSettled).toBe(false);
      expect(existsSync(instructionPath)).toBe(false);
    } finally {
      releaseBoundary();
      await lockHolder;
    }

    await expect(write).resolves.toMatchObject({
      path: instructionPath,
      created: true,
    });
  });

  it("writes Ralph flow instruction files under the flow instruction area", async () => {
    const workspaceRoot = await createWorkspace();

    const conditional = await writeInstructionFile(workspaceRoot, {
      name: "Flow Review",
      body: "Apply the review rules for this flow.",
      scope: "ralph-flow",
      ralphFlow: {
        id: "Review Flow",
        scope: "workspace",
      },
    });
    const alwaysOn = await writeInstructionFile(
      workspaceRoot,
      {
        name: "Flow Defaults",
        body: "Always apply this flow's defaults.",
        scope: "ralph-flow",
        ralphFlow: {
          id: "Review Flow",
          scope: "workspace",
        },
      },
      { path: "instructions.md" },
    );

    expect(conditional).toEqual({
      path: join(
        workspaceRoot,
        ".machdoch",
        "ralph",
        "instructions",
        "review-flow",
        "instructions",
        "flow-review.instructions.md",
      ),
      scope: "ralph-flow",
      name: "Flow Review",
      ralphFlow: {
        id: "review-flow",
        scope: "workspace",
      },
      created: true,
    });
    expect(alwaysOn.path).toBe(
      join(
        workspaceRoot,
        ".machdoch",
        "ralph",
        "instructions",
        "review-flow",
        "instructions.md",
      ),
    );
  });

  it("rejects workspace-shaped paths for user-scope instruction writes", async () => {
    const workspaceRoot = await createWorkspace();
    process.env.MACHDOCH_USER_CONFIG_DIR = join(workspaceRoot, ".user-config");

    await expect(
      writeInstructionFile(
        workspaceRoot,
        {
          name: "Global Review",
          body: "Apply global review preferences.",
          scope: "user",
        },
        { path: ".machdoch/instructions/global-review.instructions.md" },
      ),
    ).rejects.toThrow(
      "User instruction paths are relative to the user config directory",
    );
  });

  it("rejects invalid runtime metadata for instruction writes", async () => {
    const workspaceRoot = await createWorkspace();

    await expect(
      writeInstructionFile(workspaceRoot, {
        name: "Invalid Scope",
        body: "Body.",
        scope: "compatibility",
      } as unknown as Parameters<typeof writeInstructionFile>[1]),
    ).rejects.toThrow("Instruction scope must be user, workspace, or ralph-flow.");

    await expect(
      writeInstructionFile(workspaceRoot, {
        name: "Invalid Mode",
        body: "Body.",
        mode: "sometimes",
      } as unknown as Parameters<typeof writeInstructionFile>[1]),
    ).rejects.toThrow("Instruction mode must be always");
  });

  it("validates instruction frontmatter and body content", () => {
    const invalid = validateInstructionFileContent(
      "bad.instructions.md",
      "---\nname: Bad\nmode: sometimes\n---\n",
    );
    const weak = validateInstructionFileContent(
      "weak.instructions.md",
      "---\nname: Weak\nmode: auto\n---\nFollow review expectations.\n",
    );

    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "invalid-instruction-mode",
      "empty-instruction-body",
      "weak-instruction-activation",
    ]);
    expect(weak.valid).toBe(true);
    expect(weak.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "weak-instruction-activation",
    ]);
  });
});
