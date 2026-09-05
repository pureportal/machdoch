import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FleetProjectLibrary,
  getFleetProjectStatePath,
  projectGitEnvironment,
  validateProjectBranch,
  validateProjectRepository,
} from "./fleet-projects.ts";
import type { runStreamingCommand } from "./_helpers/streaming-command.ts";

const roots: string[] = [];
const libraries: FleetProjectLibrary[] = [];
async function setup(runGit?: typeof runStreamingCommand) {
  const root = await mkdtemp(join(tmpdir(), "machdoch-projects-test-"));
  roots.push(root);
  vi.stubEnv("MACHDOCH_USER_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("MACHDOCH_WORKSPACE_ROOT", join(root, "projects"));
  const library = await FleetProjectLibrary.create(
    root,
    runGit ? { runGit } : {},
  );
  libraries.push(library);
  return { root, library, projectRoot: library.getSnapshot().root };
}
async function finished(library: FleetProjectLibrary, name: string) {
  await vi.waitFor(() =>
    expect(
      library.getSnapshot().projects.find((project) => project.name === name)
        ?.status,
    ).not.toMatch(/^(creating|cloning)$/u),
  );
  return library
    .getSnapshot()
    .projects.find((project) => project.name === name)!;
}
afterEach(async () => {
  await Promise.all(libraries.splice(0).map((library) => library.shutdown()));
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.sequential("Fleet project library", () => {
  it("creates empty and Git projects, persists them and deduplicates commands after restart", async () => {
    const { root, library, projectRoot } = await setup();
    const command = {
      kind: "create-project" as const,
      commandId: "new-project",
      name: "my-project",
      initializeGit: true,
    };
    expect(await library.execute(command, () => false)).toMatchObject({
      duplicate: false,
    });
    expect((await finished(library, "my-project")).status).toBe("ready");
    expect(
      await readFile(join(projectRoot, "my-project", ".git", "HEAD"), "utf8"),
    ).toContain("refs/heads/main");
    await library.execute(
      { kind: "create-project", name: "plain", initializeGit: false },
      () => false,
    );
    expect((await finished(library, "plain")).status).toBe("ready");
    await expect(
      lstat(join(projectRoot, "plain", ".git")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await library.shutdown();
    const restored = await FleetProjectLibrary.create(root);
    libraries.push(restored);
    expect(await restored.execute(command, () => false)).toMatchObject({
      duplicate: true,
    });
    await expect(
      restored.execute({ ...command, name: "different" }, () => false),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(restored.getSnapshot().projects).toHaveLength(2);
  });

  it("passes clone arguments without a shell and only exposes structured progress", async () => {
    let cloneOptions: Parameters<typeof runStreamingCommand>[2] | undefined;
    const runGit: typeof runStreamingCommand = vi.fn(
      async (executable, args, options) => {
        expect(executable).toBe("git");
        expect(args).toContain("--depth=1");
        expect(args.slice(-5)).toEqual([
          "--branch",
          "feature/work",
          "--",
          "git@example.com:team/repo.git",
          ".",
        ]);
        cloneOptions = options;
        await options.onOutput?.({
          stream: "stderr",
          chunk: "secret-token\rReceiving objects: 42% (42/100)",
        });
        await writeFile(join(options.cwd, "README.md"), "project");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    const { library, projectRoot } = await setup(runGit);
    await library.execute(
      {
        kind: "clone-project",
        name: "repo",
        repository: "git@example.com:team/repo.git",
        branch: "feature/work",
        shallow: true,
      },
      () => false,
    );
    expect((await finished(library, "repo")).status).toBe("ready");
    expect(cloneOptions?.cwd).toBe(join(projectRoot, "repo"));
    expect(cloneOptions?.shell).toBeUndefined();
    expect(cloneOptions?.env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(cloneOptions?.env?.GIT_ALLOW_PROTOCOL).toBe("https:ssh");
    expect(JSON.stringify(library.getSnapshot())).not.toContain("secret-token");
  });

  it("does not overwrite existing directories, rejects linked imports and protects referenced projects", async () => {
    const { root, library, projectRoot } = await setup();
    await mkdir(join(projectRoot, "existing"));
    await writeFile(join(projectRoot, "existing", "keep.txt"), "keep");
    await expect(
      library.execute(
        { kind: "create-project", name: "existing", initializeGit: false },
        () => false,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await library.execute(
      { kind: "import-project", name: "existing" },
      () => false,
    );
    const existing = library.getSnapshot().projects[0]!;
    expect(await library.resolveWorkspace(existing.workspace)).toBe(
      existing.workspace,
    );
    await expect(
      library.execute(
        { kind: "forget-project", projectId: existing.id },
        () => true,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await library.execute(
      { kind: "forget-project", projectId: existing.id },
      () => false,
    );
    expect(
      await readFile(join(projectRoot, "existing", "keep.txt"), "utf8"),
    ).toBe("keep");
    await symlink(
      join(root, "config"),
      join(projectRoot, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      library.execute({ kind: "import-project", name: "linked" }, () => false),
    ).rejects.toMatchObject({ code: "invalidRequest" });
    await expect(library.resolveWorkspace(root)).rejects.toMatchObject({
      code: "invalidRequest",
    });
  });

  it("bounds concurrent clones, cancels and drains their subprocesses on shutdown", async () => {
    const aborted = vi.fn();
    const runGit: typeof runStreamingCommand = async (
      _executable,
      _args,
      options,
    ) => {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) return reject(new Error("cancelled"));
        options.signal?.addEventListener(
          "abort",
          () => {
            aborted();
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const { library, projectRoot } = await setup(runGit);
    for (const name of ["one", "two"])
      await library.execute(
        {
          kind: "clone-project",
          name,
          repository: "https://example.com/repo.git",
          shallow: false,
        },
        () => false,
      );
    await expect(
      library.execute(
        {
          kind: "clone-project",
          name: "three",
          repository: "https://example.com/repo.git",
          shallow: false,
        },
        () => false,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await vi.waitFor(async () =>
      expect((await lstat(join(projectRoot, "two"))).isDirectory()).toBe(true),
    );
    await library.shutdown();
    expect(
      library
        .getSnapshot()
        .projects.every((project) => project.status === "cancelled"),
    ).toBe(true);
    expect(aborted).toHaveBeenCalled();
    await expect(lstat(join(projectRoot, "one"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      library.execute(
        { kind: "create-project", name: "stopped", initializeGit: false },
        () => false,
      ),
    ).rejects.toMatchObject({ code: "unavailable" });
  });

  it("cleans only its own failed setup and supports retry without leaking Git errors", async () => {
    let fail = true;
    const { library, projectRoot } = await setup(
      async (_executable, _args, options) => {
        await writeFile(join(options.cwd, "partial.txt"), "partial");
        if (fail)
          throw new Error(
            "https://user:secret@example.com/private?token=secret",
          );
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    );
    await library.execute(
      {
        kind: "clone-project",
        name: "retry",
        repository: "https://example.com/repo.git",
        shallow: false,
      },
      () => false,
    );
    const project = await finished(library, "retry");
    expect(project.status).toBe("failed");
    expect(project.error).not.toContain("secret");
    await expect(lstat(join(projectRoot, "retry"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    fail = false;
    await library.execute(
      { kind: "retry-project-operation", projectId: project.id },
      () => false,
    );
    expect((await finished(library, "retry")).status).toBe("ready");
  });

  it("recovers interrupted setup without deleting files and refuses a changed root", async () => {
    const { root, library, projectRoot } = await setup();
    await library.execute(
      { kind: "create-project", name: "interrupted", initializeGit: false },
      () => false,
    );
    await finished(library, "interrupted");
    await library.shutdown();
    const path = getFleetProjectStatePath(root);
    const state = JSON.parse(await readFile(path, "utf8"));
    state.projects[0].status = "cloning";
    await writeFile(path, JSON.stringify(state));
    await writeFile(join(projectRoot, "interrupted", "keep.txt"), "preserved");
    const restored = await FleetProjectLibrary.create(root);
    libraries.push(restored);
    expect(restored.getSnapshot().projects[0]?.status).toBe("failed");
    expect(
      await readFile(join(projectRoot, "interrupted", "keep.txt"), "utf8"),
    ).toBe("preserved");
    await expect(
      FleetProjectLibrary.create(root, { root: join(root, "elsewhere") }),
    ).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("Fleet project input boundaries", () => {
  it.each([
    "file:///etc/passwd",
    "/local/repo",
    "../repo",
    "-upload-pack=evil",
    "ext::sh -c evil",
    "http://example.com/repo",
    "https://token@example.com/repo",
    "https://example.com/repo?token=secret",
    "ssh://user:password@example.com/repo",
    "ssh://-oProxyCommand=evil/repo",
    "https://example.com/repo\n--config=evil",
  ])("rejects unsafe remote %s", (value) =>
    expect(() => validateProjectRepository(value)).toThrow(),
  );
  it.each([
    "https://github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@example.com:2222/team/repo.git",
  ])("accepts secure remote %s", (value) =>
    expect(validateProjectRepository(value)).toBe(value),
  );
  it.each([
    "--upload-pack=evil",
    "main\nother",
    "foo..bar",
    "a.lock",
    "a//b",
    "x@{y}",
    "/main",
  ])("rejects invalid branch %s", (value) =>
    expect(() => validateProjectBranch(value)).toThrow(),
  );
  it("drops inherited Git selectors, tracing and config injection", () => {
    vi.stubEnv("GIT_DIR", "outside");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_TRACE", "/outside/log");
    vi.stubEnv("GIT_SSH_COMMAND", "unsafe");
    const env = projectGitEnvironment();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(env.GIT_TRACE).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toContain("BatchMode=yes");
  });
});
