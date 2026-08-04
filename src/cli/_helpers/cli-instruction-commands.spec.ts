import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs } from "./cli-args.ts";
import { printInstructionSummary } from "./cli-instruction-commands.ts";

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-cli-instr-"));
  workspacesToClean.push(workspaceRoot);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(workspaceRoot, ".user-config"));
  return workspaceRoot;
};

const captureStdout = async (run: () => Promise<void>): Promise<string> => {
  let output = "";
  const writeSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      output +=
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    });

  try {
    await run();
  } finally {
    writeSpy.mockRestore();
  }

  return output;
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    workspacesToClean
      .splice(0)
      .map((workspaceRoot) =>
        rm(workspaceRoot, { recursive: true, force: true }),
      ),
  );
});

describe("printInstructionSummary", () => {
  it("creates one reusable profile and lists metadata without bodies by default", async () => {
    const workspaceRoot = await createWorkspace();
    const createOutput = await captureStdout(async () => {
      await printInstructionSummary(
        parseCliArgs(
          [
            "--json",
            "--cwd",
            workspaceRoot,
            "instructions",
            "profiles",
            "create",
            "Review Rules",
            "--description",
            "Shared review policy",
            "--prompt",
            "Verify behavior before completion.",
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      );
    });
    const created = JSON.parse(createOutput) as {
      profile: { id: string; name: string; body: string };
      library: { revision: number };
    };
    expect(created.profile).toMatchObject({
      name: "Review Rules",
      body: "Verify behavior before completion.",
    });
    expect(created.profile.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(created.library.revision).toBe(1);

    const listOutput = await captureStdout(async () => {
      await printInstructionSummary(
        parseCliArgs(
          [
            "--json",
            "--cwd",
            workspaceRoot,
            "instructions",
            "profiles",
            "list",
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      );
    });
    const listed = JSON.parse(listOutput) as {
      profiles: Array<Record<string, unknown>>;
    };
    expect(listed.profiles).toEqual([
      expect.objectContaining({
        id: created.profile.id,
        name: "Review Rules",
      }),
    ]);
    expect(listed.profiles[0]).not.toHaveProperty("body");
    await expect(stat(join(workspaceRoot, "AGENTS.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("persists workspace tags and resolves only enabled automatic selections", async () => {
    const workspaceRoot = await createWorkspace();
    const runJson = async (argv: string[]): Promise<Record<string, unknown>> =>
      JSON.parse(
        await captureStdout(async () => {
          await printInstructionSummary(
            parseCliArgs(["--json", "--cwd", workspaceRoot, ...argv], {
              currentWorkingDirectory: workspaceRoot,
            }),
          );
        }),
      ) as Record<string, unknown>;

    const created = (await runJson([
      "instructions",
      "profiles",
      "create",
      "React policy",
      "--prompt",
      "Use React conventions.",
      "--metadata-json",
      JSON.stringify({
        enabled: false,
        tags: ["Frontend"],
        match: { op: "tag", tag: "React" },
      }),
    ])) as { profile: { id: string } };
    const configured = (await runJson([
      "instructions",
      "workspaces",
      "configure",
      workspaceRoot,
      "--metadata-json",
      JSON.stringify({ tags: ["React", "TypeScript"], profileIds: [] }),
      "--expected-revision",
      "1",
    ])) as { workspace: { id: string } };

    const disabled = (await runJson([
      "instructions",
      "profiles",
      "list",
      "--include-content",
    ])) as {
      profiles: Array<{
        id: string;
        enabled: boolean;
        tags: string[];
        match: unknown;
      }>;
      workspaces: Array<{ id: string; tags: string[] }>;
    };
    expect(disabled.profiles).toEqual([
      expect.objectContaining({
        id: created.profile.id,
        enabled: false,
        tags: ["Frontend"],
        match: { op: "tag", tag: "React" },
      }),
    ]);
    expect(disabled.workspaces).toEqual([
      expect.objectContaining({
        id: configured.workspace.id,
        tags: ["React", "TypeScript"],
      }),
    ]);

    await runJson([
      "instructions",
      "profiles",
      "edit",
      created.profile.id,
      "--metadata-json",
      JSON.stringify({ enabled: true }),
      "--expected-revision",
      "2",
    ]);
    const resolved = (await runJson(["instructions", "resolve"])) as {
      explanation: {
        sources: Array<{
          kind: string;
          profileId?: string;
          status: string;
        }>;
      };
    };
    expect(resolved.explanation.sources).toContainEqual(
      expect.objectContaining({
        kind: "profile-auto",
        profileId: created.profile.id,
        status: "selected",
      }),
    );
  });

  it("prefers an exact profile id over another profile with the same text as its name", async () => {
    const workspaceRoot = await createWorkspace();
    const runJson = async (argv: string[]): Promise<Record<string, unknown>> =>
      JSON.parse(
        await captureStdout(async () => {
          await printInstructionSummary(
            parseCliArgs(["--json", "--cwd", workspaceRoot, ...argv], {
              currentWorkingDirectory: workspaceRoot,
            }),
          );
        }),
      ) as Record<string, unknown>;
    const first = (await runJson([
      "instructions",
      "profiles",
      "create",
      "Primary",
      "--prompt",
      "Primary body.",
    ])) as { profile: { id: string } };
    await runJson([
      "instructions",
      "profiles",
      "create",
      first.profile.id,
      "--prompt",
      "Name collision body.",
    ]);

    const shown = (await runJson([
      "instructions",
      "profiles",
      "show",
      first.profile.id,
    ])) as { id: string; body: string };
    expect(shown).toMatchObject({
      id: first.profile.id,
      body: "Primary body.",
    });
  });

  it("rejects undecodable instruction input files before mutation", async () => {
    const workspaceRoot = await createWorkspace();
    const promptPath = join(workspaceRoot, "invalid-policy.md");
    await writeFile(promptPath, Buffer.from([0xff, 0xfe, 0xfd]));

    await expect(
      printInstructionSummary(
        parseCliArgs(
          [
            "--cwd",
            workspaceRoot,
            "instructions",
            "profiles",
            "create",
            "Invalid bytes",
            "--prompt-file",
            promptPath,
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      ),
    ).rejects.toThrow(/not valid UTF-8/u);
    await expect(
      stat(join(workspaceRoot, ".user-config", "instruction-library.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts a byte-bounded instruction file with Windows line endings", async () => {
    const workspaceRoot = await createWorkspace();
    const promptPath = join(workspaceRoot, "windows-policy.md");
    const rawBody = `${"\r\n".repeat(100_000)}Policy`;
    await writeFile(promptPath, rawBody, "utf8");

    await expect(
      printInstructionSummary(
        parseCliArgs(
          [
            "--cwd",
            workspaceRoot,
            "instructions",
            "profiles",
            "create",
            "Windows lines",
            "--prompt-file",
            promptPath,
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      ),
    ).resolves.toBeUndefined();

    const library = JSON.parse(
      await readFile(
        join(workspaceRoot, ".user-config", "instruction-library.json"),
        "utf8",
      ),
    ) as { profiles: Array<{ body: string }> };
    expect(library.profiles[0]?.body).toBe(`${"\n".repeat(100_000)}Policy`);
  });

  it("reports malformed library imports without exposing parser internals", async () => {
    const workspaceRoot = await createWorkspace();
    const importPath = join(workspaceRoot, "invalid-library.json");
    await writeFile(importPath, "{ invalid", "utf8");

    await expect(
      printInstructionSummary(
        parseCliArgs(
          [
            "--cwd",
            workspaceRoot,
            "instructions",
            "transfer",
            "import",
            "--prompt-file",
            importPath,
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      ),
    ).rejects.toThrow("Instruction library import must contain valid JSON.");
  });

  it("requires an explicit remove action to clear an assignment", async () => {
    const workspaceRoot = await createWorkspace();

    await expect(
      printInstructionSummary(
        parseCliArgs(
          [
            "--cwd",
            workspaceRoot,
            "instructions",
            "assignments",
            "set",
            "00000000-0000-4000-8000-000000000001",
            "--path",
            ".",
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      ),
    ).rejects.toThrow("Use assignments remove to clear a scope");
  });

  it("validates the profile resolver and provider boundary", async () => {
    const workspaceRoot = await createWorkspace();

    const output = await captureStdout(async () => {
      await printInstructionSummary(
        parseCliArgs(
          ["--json", "--cwd", workspaceRoot, "instructions", "validate"],
          { currentWorkingDirectory: workspaceRoot },
        ),
      );
    });
    const validation = JSON.parse(output) as {
      valid: boolean;
      diagnostics: Array<{ code: string; severity: string }>;
    };

    expect(validation.valid).toBe(true);
    expect(validation.diagnostics).not.toContainEqual(
      expect.objectContaining({ severity: "error" }),
    );
  });

  it("exposes reviewed status, sensitive export, restore, and reset recovery flows", async () => {
    const workspaceRoot = await createWorkspace();
    const runJson = async (argv: string[]): Promise<Record<string, unknown>> =>
      JSON.parse(
        await captureStdout(async () => {
          await printInstructionSummary(
            parseCliArgs(["--json", "--cwd", workspaceRoot, ...argv], {
              currentWorkingDirectory: workspaceRoot,
            }),
          );
        }),
      ) as Record<string, unknown>;

    await runJson([
      "instructions",
      "profiles",
      "create",
      "First",
      "--prompt",
      "First recovery body.",
    ]);
    await runJson([
      "instructions",
      "profiles",
      "create",
      "Second",
      "--prompt",
      "Second recovery body.",
    ]);

    const libraryPath = join(
      workspaceRoot,
      ".user-config",
      "instruction-library.json",
    );
    await writeFile(libraryPath, "{broken library", "utf8");
    const status = (await runJson(["instructions", "recovery", "status"])) as {
      primaryValid: boolean;
      primaryDigest: string;
      backupValid: boolean;
      backupDigest: string;
      backupRevision: number;
    };
    expect(status).toMatchObject({
      primaryValid: false,
      backupValid: true,
      backupRevision: 1,
    });

    await expect(
      printInstructionSummary(
        parseCliArgs(
          [
            "--json",
            "--cwd",
            workspaceRoot,
            "instructions",
            "recovery",
            "export",
            "--expected-digest",
            status.backupDigest,
          ],
          { currentWorkingDirectory: workspaceRoot },
        ),
      ),
    ).rejects.toThrow(/sensitive instruction bodies.*--include-content/su);

    const exported = (await runJson([
      "instructions",
      "recovery",
      "export",
      "--expected-digest",
      status.backupDigest,
      "--include-content",
    ])) as { profiles: Array<{ name: string; body: string }> };
    expect(exported.profiles).toEqual([
      expect.objectContaining({
        name: "First",
        body: "First recovery body.",
      }),
    ]);

    const restored = (await runJson([
      "instructions",
      "recovery",
      "restore",
      "--expected-digest",
      status.backupDigest,
    ])) as {
      recovered: boolean;
      library: { revision: number; profiles: Array<{ name: string }> };
    };
    expect(restored).toMatchObject({
      recovered: true,
      library: {
        revision: 1,
        profiles: [{ name: "First" }],
      },
    });

    await writeFile(libraryPath, "{broken again", "utf8");
    const resetStatus = (await runJson([
      "instructions",
      "recovery",
      "status",
    ])) as { primaryDigest: string };
    const reset = (await runJson([
      "instructions",
      "recovery",
      "reset",
      "--expected-digest",
      resetStatus.primaryDigest,
    ])) as {
      reset: boolean;
      corruptCopy: string;
      library: { revision: number; profiles: unknown[] };
    };
    expect(reset).toMatchObject({
      reset: true,
      library: { revision: 0, profiles: [] },
    });
    await expect(stat(reset.corruptCopy)).resolves.toMatchObject({
      size: Buffer.byteLength("{broken again"),
    });
  });
});
