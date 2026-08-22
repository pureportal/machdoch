import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCustomizations } from "./customizations.ts";

const pathsToClean: string[] = [];
const originalUserConfigDirectory = process.env.MACHDOCH_USER_CONFIG_DIR;

const createTemporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "machdoch-custom-"));
  pathsToClean.push(path);
  return path;
};

afterEach(async () => {
  if (originalUserConfigDirectory === undefined) {
    delete process.env.MACHDOCH_USER_CONFIG_DIR;
  } else {
    process.env.MACHDOCH_USER_CONFIG_DIR = originalUserConfigDirectory;
  }
  await Promise.all(
    pathsToClean.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("discoverCustomizations", () => {
  it("returns an empty prompt and skill inventory", async () => {
    const workspaceRoot = await createTemporaryDirectory();
    await expect(discoverCustomizations(workspaceRoot)).resolves.toEqual({
      workspaceRoot,
      prompts: [],
      skills: [],
    });
  });

  it("discovers workspace prompts and skills", async () => {
    const workspaceRoot = await createTemporaryDirectory();
    await mkdir(join(workspaceRoot, ".machdoch", "prompts"), {
      recursive: true,
    });
    await mkdir(
      join(workspaceRoot, ".machdoch", "skills", "release-automation"),
      { recursive: true },
    );
    await writeFile(
      join(workspaceRoot, ".machdoch", "prompts", "debug-build.prompt.md"),
      `---
name: debug-build
description: Diagnose build failures
agent: agent
model: auto
argument-hint: Build error
tools: [filesystem, terminal]
inputs: [error, logs]
---
Prompt body.
Second line.
`,
    );
    await writeFile(
      join(
        workspaceRoot,
        ".machdoch",
        "skills",
        "release-automation",
        "SKILL.md",
      ),
      `---
description: Automates release tasks
user-invocable: false
disable-model-invocation: true
---
Skill body.
`,
    );

    await expect(discoverCustomizations(workspaceRoot)).resolves.toEqual({
      workspaceRoot,
      prompts: [
        {
          path: ".machdoch/prompts/debug-build.prompt.md",
          name: "debug-build",
          description: "Diagnose build failures",
          agent: "agent",
          model: "auto",
          argumentHint: "Build error",
          inputs: ["error", "logs"],
          tools: ["filesystem", "shell"],
          body: "Prompt body.\nSecond line.",
        },
      ],
      skills: [
        {
          path: ".machdoch/skills/release-automation/SKILL.md",
          name: "release-automation",
          description: "Automates release tasks",
          userInvocable: false,
          disableModelInvocation: true,
        },
      ],
    });
  });

  it("discovers user prompts and skills when requested", async () => {
    const workspaceRoot = await createTemporaryDirectory();
    const userRoot = await createTemporaryDirectory();
    process.env.MACHDOCH_USER_CONFIG_DIR = userRoot;
    const promptPath = join(userRoot, "prompts", "release.prompt.md");
    const skillPath = join(userRoot, "skills", "review", "SKILL.md");
    await mkdir(join(userRoot, "prompts"), { recursive: true });
    await mkdir(join(userRoot, "skills", "review"), { recursive: true });
    await writeFile(promptPath, "---\nname: release\n---\nAudit releases.\n");
    await writeFile(
      skillPath,
      "---\ndescription: Reviews releases\n---\nReview.\n",
    );

    const result = await discoverCustomizations(workspaceRoot, {
      discoverUserCustomizations: true,
    });
    expect(result.prompts[0]).toMatchObject({
      path: promptPath,
      scope: "user",
      name: "release",
    });
    expect(result.skills[0]).toMatchObject({
      path: skillPath,
      scope: "user",
      name: "review",
    });
  });

  it("discovers GitHub prompts and skills only when enabled", async () => {
    const workspaceRoot = await createTemporaryDirectory();
    await mkdir(join(workspaceRoot, ".github", "prompts"), {
      recursive: true,
    });
    await mkdir(join(workspaceRoot, ".github", "skills", "review"), {
      recursive: true,
    });
    await writeFile(
      join(workspaceRoot, ".github", "prompts", "review.prompt.md"),
      "---\ntools: [git, terminal, uuid, unknown]\n---\nReview.\n",
    );
    await writeFile(
      join(workspaceRoot, ".github", "skills", "review", "SKILL.md"),
      "Review skill.",
    );

    const disabled = await discoverCustomizations(workspaceRoot);
    expect(disabled.prompts).toEqual([]);
    expect(disabled.skills).toEqual([]);

    const enabled = await discoverCustomizations(workspaceRoot, {
      discoverGithubCustomizations: true,
    });
    expect(enabled.prompts[0]).toMatchObject({
      path: ".github/prompts/review.prompt.md",
      scope: "github",
      name: "review",
      tools: ["git", "shell", "utilities"],
    });
    expect(enabled.skills[0]).toMatchObject({
      path: ".github/skills/review/SKILL.md",
      scope: "github",
      name: "review",
    });
  });
});
