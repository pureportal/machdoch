import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverCustomizations } from "./customizations.ts";

const workspacesToClean: string[] = [];

const createWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "machdoch-custom-"));
  workspacesToClean.push(workspaceRoot);
  return workspaceRoot;
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

describe("discoverCustomizations", () => {
  it("returns empty discovery results when no customization folders exist", async () => {
    const workspaceRoot = await createWorkspace();

    await expect(discoverCustomizations(workspaceRoot)).resolves.toEqual({
      workspaceRoot,
      instructions: [],
      prompts: [],
      skills: [],
    });
  });

  it("discovers instructions, prompts, and skills from .machdoch", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".machdoch", "instructions"), {
      recursive: true,
    });
    await mkdir(join(workspaceRoot, ".machdoch", "prompts"), {
      recursive: true,
    });
    await mkdir(
      join(workspaceRoot, ".machdoch", "skills", "browser-automation"),
      { recursive: true },
    );

    await writeFile(
      join(workspaceRoot, ".machdoch", "instructions.md"),
      "Always-on rules",
    );
    await writeFile(
      join(
        workspaceRoot,
        ".machdoch",
        "instructions",
        "security.instructions.md",
      ),
      `---
name: Security defaults
description: Apply security rules
keywords: ["auth", "token"]
priority: 90
---
Protect secrets.
`,
    );
    await writeFile(
      join(workspaceRoot, ".machdoch", "prompts", "debug-build.prompt.md"),
      `---
name: debug-build
description: Diagnose build failures
agent: agent
model: auto
argument-hint: "Build error"
tools:
  - filesystem
  - terminal
inputs:
  - error
  - logs
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
        "browser-automation",
        "SKILL.md",
      ),
      `---
description: Automates browser tasks
user-invocable: false
disable-model-invocation: true
---
Skill body.
`,
    );

    const customizations = await discoverCustomizations(workspaceRoot);

    expect(customizations.instructions).toHaveLength(2);
    expect(customizations.instructions[0]).toMatchObject({
      kind: "always-on",
      path: ".machdoch/instructions.md",
      body: "Always-on rules",
      keywords: [],
    });
    expect(customizations.instructions[1]).toEqual({
      kind: "conditional",
      path: ".machdoch/instructions/security.instructions.md",
      name: "Security defaults",
      description: "Apply security rules",
      keywords: ["auth", "token"],
      priority: 90,
      body: "Protect secrets.",
    });
    expect(customizations.prompts).toEqual([
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
    ]);
    expect(customizations.skills).toEqual([
      {
        path: ".machdoch/skills/browser-automation/SKILL.md",
        name: "browser-automation",
        description: "Automates browser tasks",
        userInvocable: false,
        disableModelInvocation: true,
      },
    ]);
  });

  it("derives fallback names and normalizes aliased prompt tools", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".machdoch", "instructions"), {
      recursive: true,
    });
    await mkdir(join(workspaceRoot, ".machdoch", "prompts"), {
      recursive: true,
    });
    await mkdir(join(workspaceRoot, ".machdoch", "skills", "fallback-skill"), {
      recursive: true,
    });

    await writeFile(
      join(workspaceRoot, ".machdoch", "instructions", "repo.instructions.md"),
      `---
applyTo: src/**/*.ts
---
Rules.
`,
    );
    await writeFile(
      join(workspaceRoot, ".machdoch", "prompts", "review.prompt.md"),
      `---
description: Review the workspace
tools: [terminal, bash, website, uuid, terminal, unknown]
---
Prompt body.
`,
    );
    await writeFile(
      join(workspaceRoot, ".machdoch", "skills", "fallback-skill", "SKILL.md"),
      "Skill body without frontmatter.",
    );

    const customizations = await discoverCustomizations(workspaceRoot);

    expect(customizations.instructions).toEqual([
      {
        kind: "conditional",
        path: ".machdoch/instructions/repo.instructions.md",
        name: "repo",
        body: "Rules.",
        applyTo: "src/**/*.ts",
        keywords: [],
      },
    ]);
    expect(customizations.prompts).toEqual([
      {
        path: ".machdoch/prompts/review.prompt.md",
        name: "review",
        description: "Review the workspace",
        inputs: [],
        tools: ["shell", "browser", "utilities"],
        body: "Prompt body.",
      },
    ]);
    expect(customizations.skills).toEqual([
      {
        path: ".machdoch/skills/fallback-skill/SKILL.md",
        name: "fallback-skill",
        description: "No description provided.",
        userInvocable: true,
        disableModelInvocation: false,
      },
    ]);
  });

  it("ignores GitHub-style customization files unless compatibility mode is enabled", async () => {
    const workspaceRoot = await createWorkspace();

    await mkdir(join(workspaceRoot, ".github", "instructions"), {
      recursive: true,
    });
    await mkdir(join(workspaceRoot, ".github", "prompts"), {
      recursive: true,
    });
    await mkdir(join(workspaceRoot, ".github", "skills", "repo-skill"), {
      recursive: true,
    });

    await writeFile(
      join(workspaceRoot, ".github", "copilot-instructions.md"),
      "GitHub instructions",
    );
    await writeFile(join(workspaceRoot, "AGENTS.md"), "Agent instructions");
    await writeFile(
      join(workspaceRoot, ".github", "instructions", "repo.instructions.md"),
      `---
name: Repo rules
keywords: ["release"]
---
Rules.
`,
    );
    await writeFile(
      join(workspaceRoot, ".github", "prompts", "release.prompt.md"),
      `---
name: release
tools: ["git"]
---
Prompt body.
`,
    );
    await writeFile(
      join(workspaceRoot, ".github", "skills", "repo-skill", "SKILL.md"),
      `---
description: Repo skill
---
Skill body.
`,
    );

    const withoutCompatibility = await discoverCustomizations(workspaceRoot);
    const withCompatibility = await discoverCustomizations(workspaceRoot, {
      discoverGithubCustomizations: true,
    });

    expect(withoutCompatibility.instructions).toHaveLength(0);
    expect(withoutCompatibility.prompts).toHaveLength(0);
    expect(withoutCompatibility.skills).toHaveLength(0);

    expect(withCompatibility.instructions.map((entry) => entry.path)).toEqual([
      ".github/copilot-instructions.md",
      "AGENTS.md",
      ".github/instructions/repo.instructions.md",
    ]);
    expect(withCompatibility.prompts).toEqual([
      {
        path: ".github/prompts/release.prompt.md",
        name: "release",
        inputs: [],
        tools: ["git"],
        body: "Prompt body.",
      },
    ]);
    expect(withCompatibility.skills).toEqual([
      {
        path: ".github/skills/repo-skill/SKILL.md",
        name: "repo-skill",
        description: "Repo skill",
        userInvocable: true,
        disableModelInvocation: false,
      },
    ]);
  });
});
