import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  projectSchema,
  workspaceCommandSchema,
  type FleetProject,
  type WorkspaceCommand,
  type CommandReceipt,
  type ProductShell,
} from "@machdoch/fleet-protocol";
import { getUserConfigPath } from "./env.js";
import { writeJsonAtomically } from "./_helpers/write-file-atomically.helper.js";
import { runStreamingCommand } from "./_helpers/streaming-command.js";

const maximumProjects = 100;
const maximumConcurrentOperations = 2;
const running = (project: FleetProject): boolean =>
  project.status === "creating" || project.status === "cloning";
const librarySchema = z.strictObject({
  version: z.literal(1),
  root: z.string().min(1).max(12_000).refine(isAbsolute),
  projects: z
    .array(z.unknown().transform((value) => projectSchema.parse(value)))
    .max(maximumProjects),
  receipts: z
    .array(
      z.strictObject({
        commandId: z.string().min(1).max(128),
        digest: z.string().regex(/^[a-f0-9]{64}$/u),
      }),
    )
    .max(100),
});
type LibraryState = z.infer<typeof librarySchema>;

export class FleetProjectError extends Error {
  constructor(
    readonly code: "invalidRequest" | "conflict" | "unavailable",
    message: string,
  ) {
    super(message);
  }
}

/** Credentials stay in the service account's Git/SSH configuration, never in browser URLs. */
export function validateProjectRepository(value: string): string {
  const repository = value.trim();
  if (
    !repository ||
    repository.length > 2048 ||
    /[\s\p{Cc}\p{Cf}\\]/u.test(repository)
  )
    throw new FleetProjectError(
      "invalidRequest",
      "Enter an HTTPS or SSH Git repository URL without credentials.",
    );
  if (
    /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*:[a-zA-Z0-9_./~-]+$/u.test(
      repository,
    )
  )
    return repository;
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw new FleetProjectError(
      "invalidRequest",
      "Use an HTTPS URL or an SSH URL such as git@github.com:owner/repository.git.",
    );
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    !url.hostname ||
    url.hostname.startsWith("-") ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "https:" && url.username) ||
    (url.username && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(url.username)) ||
    !url.pathname ||
    url.pathname === "/"
  )
    throw new FleetProjectError(
      "invalidRequest",
      "Use an HTTPS or SSH repository URL without passwords, tokens, query parameters, or fragments.",
    );
  return repository;
}

export function validateProjectBranch(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const branch = value.trim();
  if (
    !branch ||
    branch.length > 240 ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    /[\s\p{Cc}\p{Cf}~^:?*[\\]/u.test(branch) ||
    branch
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    throw new FleetProjectError(
      "invalidRequest",
      "Enter a valid Git branch or tag name.",
    );
  return branch;
}

export const getFleetProjectStatePath = (workspace: string): string =>
  join(
    dirname(getUserConfigPath()),
    `fleet-projects-${createHash("sha256").update(workspace).digest("hex").slice(0, 24)}.json`,
  );

export function projectGitEnvironment(): NodeJS.ProcessEnv {
  // Drop inherited repository selectors, trace paths, injected config and askpass commands.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !/^(GIT_|GCM_|SSH_ASKPASS)/iu.test(key),
    ),
  );
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_ALLOW_PROTOCOL: "https:ssh",
    GIT_SSH_COMMAND:
      "ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -oConnectTimeout=20",
    GIT_SSH_VARIANT: "ssh",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

export class FleetProjectLibrary {
  private tail: Promise<void> = Promise.resolve();
  private readonly jobs = new Map<
    string,
    { controller: AbortController; settled: Promise<void> }
  >();
  private readonly progress = new Map<string, string>();
  private stopping = false;

  private constructor(
    private state: LibraryState,
    private readonly path: string,
    private readonly runGit: typeof runStreamingCommand,
  ) {}

  static async create(
    serviceWorkspace: string,
    options: { root?: string; runGit?: typeof runStreamingCommand } = {},
  ): Promise<FleetProjectLibrary> {
    const path = getFleetProjectStatePath(serviceWorkspace);
    let saved: LibraryState | undefined;
    try {
      saved = librarySchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const configured = options.root ?? process.env.MACHDOCH_WORKSPACE_ROOT;
    if (
      configured !== undefined &&
      (!isAbsolute(configured) || /[\p{Cc}\p{Cf}]/u.test(configured))
    )
      throw new FleetProjectError(
        "invalidRequest",
        "MACHDOCH_WORKSPACE_ROOT must be an absolute directory path.",
      );
    const requested =
      configured ?? saved?.root ?? join(serviceWorkspace, "projects");
    await mkdir(requested, { recursive: true, mode: 0o700 });
    const root = await realpath(requested);
    if (saved && saved.root !== root)
      throw new FleetProjectError(
        "conflict",
        "The configured workspace root differs from the saved project library. Move the library and its projects together while the service is stopped.",
      );
    const state = saved ?? {
      version: 1 as const,
      root,
      projects: [],
      receipts: [],
    };
    if (
      new Set(state.receipts.map((receipt) => receipt.commandId)).size !==
        state.receipts.length ||
      new Set(state.projects.map((project) => project.id)).size !==
        state.projects.length ||
      new Set(state.projects.map((project) => project.name.toLowerCase()))
        .size !== state.projects.length
    )
      throw new FleetProjectError(
        "invalidRequest",
        "The project library contains duplicate projects.",
      );
    for (const project of state.projects) {
      if (project.repository) validateProjectRepository(project.repository);
      validateProjectBranch(project.branch);
      if (running(project)) {
        project.status = "failed";
        project.error =
          "Project setup was interrupted when the host stopped. Any existing files were preserved. Import the folder if it is complete, or retry with a new folder name.";
        project.updatedAt = Date.now();
      }
    }
    const library = new FleetProjectLibrary(
      state,
      path,
      options.runGit ?? runStreamingCommand,
    );
    await library.persist(state);
    return library;
  }

  getSnapshot(): NonNullable<ProductShell["projectLibrary"]> {
    return {
      root: this.state.root,
      projects: this.state.projects.map((project) => ({
        ...project,
        workspace: this.projectPath(project),
        ...(this.progress.has(project.id)
          ? { progress: this.progress.get(project.id) }
          : {}),
      })),
      maximumProjects,
      maximumConcurrentOperations,
    };
  }

  hasCommandId(commandId: string): boolean {
    return this.state.receipts.some(
      (receipt) => receipt.commandId === commandId,
    );
  }

  private async persist(state: LibraryState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await writeJsonAtomically(this.path, librarySchema.parse(state), {
      mode: 0o600,
    });
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async assertRoot(): Promise<void> {
    const info = await lstat(this.state.root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(this.state.root)) !== this.state.root
    )
      throw new FleetProjectError(
        "unavailable",
        "The workspace root has moved or is no longer a regular directory.",
      );
  }

  private projectPath(project: FleetProject): string {
    return join(this.state.root, project.name);
  }

  async resolveWorkspace(workspace: string): Promise<string> {
    const project = this.state.projects.find(
      (project) =>
        project.status === "ready" && this.projectPath(project) === workspace,
    );
    if (!project)
      throw new FleetProjectError(
        "invalidRequest",
        "Select a ready project from this host's project library.",
      );
    await this.assertDirectory(project);
    return this.projectPath(project);
  }

  private async assertDirectory(project: FleetProject): Promise<void> {
    await this.assertRoot();
    const path = this.projectPath(project);
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      throw new FleetProjectError(
        "invalidRequest",
        "Projects must be regular folders directly inside the workspace root; linked folders are not supported.",
      );
  }

  async execute(
    input: WorkspaceCommand,
    isInUse: (workspace: string) => boolean,
  ): Promise<CommandReceipt> {
    const command = workspaceCommandSchema.parse(input);
    return await this.serialize(async () => {
      if (this.stopping)
        throw new FleetProjectError(
          "unavailable",
          "The project service is stopping.",
        );
      const commandId = command.commandId ?? randomUUID();
      const digest = createHash("sha256")
        .update(JSON.stringify(command))
        .digest("hex");
      const prior = this.state.receipts.find(
        (receipt) => receipt.commandId === commandId,
      );
      if (prior) {
        if (prior.digest !== digest)
          throw new FleetProjectError(
            "conflict",
            "This command ID was already used for another project operation.",
          );
        return { commandId, duplicate: true };
      }
      const next = structuredClone(this.state);
      let start: FleetProject | undefined;
      let cancel: string | undefined;
      const now = Date.now();
      if ("name" in command) {
        if (next.projects.length >= maximumProjects)
          throw new FleetProjectError(
            "conflict",
            "The project library is full. Remove an unused entry first; files are preserved.",
          );
        if (
          next.projects.some(
            (project) =>
              project.name.toLowerCase() === command.name.toLowerCase(),
          )
        )
          throw new FleetProjectError(
            "conflict",
            "A project with that folder name is already registered.",
          );
        const project: FleetProject = {
          id: randomUUID(),
          name: command.name,
          kind:
            command.kind === "clone-project"
              ? "git"
              : command.kind === "import-project"
                ? "imported"
                : "empty",
          status: command.kind === "clone-project" ? "cloning" : "creating",
          createdAt: now,
          updatedAt: now,
        };
        if (command.kind === "clone-project") {
          project.repository = validateProjectRepository(command.repository);
          project.branch = validateProjectBranch(command.branch);
          project.shallow = command.shallow;
        }
        if (command.kind === "create-project")
          project.initializeGit = command.initializeGit;
        await this.assertRoot();
        if (command.kind === "import-project") {
          await this.assertDirectory(project);
          project.status = "ready";
        } else {
          this.assertCapacity();
          await this.assertVacant(project);
          start = project;
        }
        next.projects.unshift(project);
      } else {
        const project = next.projects.find(
          (project) => project.id === command.projectId,
        );
        if (!project)
          throw new FleetProjectError("invalidRequest", "Project not found.");
        if (command.kind === "forget-project") {
          if (running(project) || isInUse(this.projectPath(project)))
            throw new FleetProjectError(
              "conflict",
              "Delete this project's saved sessions and finish its setup before removing it from the library. Files will be preserved.",
            );
          next.projects = next.projects.filter(
            (entry) => entry.id !== project.id,
          );
        } else if (command.kind === "cancel-project-operation") {
          if (!running(project))
            throw new FleetProjectError(
              "conflict",
              "Project setup has already finished.",
            );
          cancel = project.id;
        } else {
          if (project.status !== "failed" && project.status !== "cancelled")
            throw new FleetProjectError(
              "conflict",
              "Only failed or cancelled project setup can be retried.",
            );
          this.assertCapacity();
          await this.assertVacant(project);
          project.status = project.kind === "git" ? "cloning" : "creating";
          project.updatedAt = now;
          delete project.error;
          start = project;
        }
      }
      next.receipts = [{ commandId, digest }, ...next.receipts].slice(0, 100);
      await this.persist(next);
      this.state = next;
      if (start) this.start(start);
      if (cancel)
        this.jobs.get(cancel)?.controller.abort("Project setup cancelled.");
      return { commandId, duplicate: false };
    });
  }

  private assertCapacity(): void {
    if (this.jobs.size >= maximumConcurrentOperations)
      throw new FleetProjectError(
        "conflict",
        "Two projects are already being prepared. Wait for one to finish or cancel it.",
      );
  }

  private async assertVacant(project: FleetProject): Promise<void> {
    await this.assertRoot();
    try {
      await lstat(this.projectPath(project));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new FleetProjectError(
      "conflict",
      "That folder already exists. Import it or choose another name; existing files are never overwritten.",
    );
  }

  private start(project: FleetProject): void {
    const controller = new AbortController();
    // Start after registering the job, so even a fast failure can be cancelled/drained.
    const settled = Promise.resolve()
      .then(() => this.prepare(project, controller.signal))
      .finally(() => {
        this.jobs.delete(project.id);
        this.progress.delete(project.id);
      });
    this.jobs.set(project.id, { controller, settled });
    void settled.catch(() => undefined);
  }

  private async prepare(
    project: FleetProject,
    signal: AbortSignal,
  ): Promise<void> {
    const path = this.projectPath(project);
    let owned: Awaited<ReturnType<typeof lstat>> | undefined;
    let complete = false;
    let failure: string | undefined;
    try {
      signal.throwIfAborted();
      await this.assertRoot();
      await mkdir(path, { mode: 0o700 }); // Atomic reservation. Never clone into a pre-existing directory.
      owned = await lstat(path);
      await this.assertDirectory(project);
      if (project.kind === "git" || project.initializeGit) {
        const common = [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "protocol.allow=never",
          "-c",
          "protocol.https.allow=always",
          "-c",
          "protocol.ssh.allow=always",
          "-c",
          "credential.interactive=false",
          "-c",
          "http.followRedirects=false",
        ];
        const args =
          project.kind === "git"
            ? [
                ...common,
                "clone",
                "--progress",
                "--template=",
                ...(project.shallow ? ["--depth=1"] : []),
                ...(project.branch ? ["--branch", project.branch] : []),
                "--",
                validateProjectRepository(project.repository ?? ""),
                ".",
              ]
            : [...common, "init", "--template=", "--initial-branch=main", "."];
        await this.runGit("git", args, {
          cwd: path,
          timeoutMs: 30 * 60_000,
          maxBufferBytes: 8 * 1024 * 1024,
          env: projectGitEnvironment(),
          signal,
          onOutput: ({ chunk }) => {
            // Never relay raw subprocess output, remote URLs or credential-helper errors.
            const match = [
              ...chunk.matchAll(
                /(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Updating files):\s*(\d{1,3})%/gu,
              ),
            ].at(-1);
            if (match)
              this.progress.set(
                project.id,
                `${match[1]}: ${Math.min(100, Number(match[2]))}%`,
              );
          },
        });
      }
      signal.throwIfAborted();
      await this.assertDirectory(project);
      complete = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      failure = signal.aborted
        ? "Project setup was cancelled."
        : code === "ENOENT"
          ? "Git or the workspace folder is unavailable. Install Git on the host and check the workspace root."
          : code === "EEXIST"
            ? "The folder already exists. Import it or choose another name."
            : code === "ENOSPC"
              ? "The host has insufficient disk space."
              : code === "EACCES" || code === "EPERM"
                ? "The service account cannot write to the workspace root."
                : "Project setup failed. Check the repository URL, branch, disk space and the host account's Git credentials. SSH hosts must already be trusted. Setup has a 30-minute timeout.";
      if (owned) {
        try {
          await this.assertDirectory(project);
          const current = await lstat(path);
          if (
            current.dev === owned.dev &&
            current.ino === owned.ino &&
            resolve(path) === join(this.state.root, project.name)
          )
            await rm(path, { recursive: true });
          else
            failure +=
              " The folder changed during setup; its files were preserved.";
        } catch {
          failure +=
            " Some files could not be cleaned up; import the folder or choose another name.";
        }
      }
    }
    await this.serialize(async () => {
      const next = structuredClone(this.state);
      const entry = next.projects.find((entry) => entry.id === project.id);
      if (!entry) return;
      entry.status = complete
        ? "ready"
        : signal.aborted
          ? "cancelled"
          : "failed";
      entry.updatedAt = Date.now();
      if (failure) entry.error = failure.slice(0, 1000);
      try {
        await this.persist(next);
        this.state = next;
      } catch {
        // Keep the live UI usable if disk exhaustion prevents the final write.
        // Startup will recover the persisted in-progress record without deleting files.
        entry.status = "failed";
        entry.error =
          "The host could not save the project result. Existing files were preserved. Check free disk space and config directory permissions before restarting.";
        this.state = next;
      }
    });
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.tail;
    for (const job of this.jobs.values())
      job.controller.abort("Fleet service stopped.");
    await Promise.allSettled([...this.jobs.values()].map((job) => job.settled));
  }
}
