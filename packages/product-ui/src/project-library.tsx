import {
  FolderPlus,
  GitBranch,
  LoaderCircle,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useRef, useState } from "react";
import {
  projectNameSchema,
  type ProductShell,
  type WorkspaceCommand,
} from "@machdoch/fleet-protocol";
import type { ProductCommandHandler } from "./product-runtime";

export function ProjectLibrary({
  library,
  servicesHref,
  sessions,
  pending,
  error,
  onCommand,
  onOpenChat,
}: {
  library: NonNullable<ProductShell["projectLibrary"]>;
  servicesHref?: string | undefined;
  sessions: ProductShell["sessions"];
  pending: boolean;
  error: string | null;
  onCommand: ProductCommandHandler;
  onOpenChat: () => void;
}): React.ReactElement {
  const [mode, setMode] = useState<"clone" | "empty" | "import" | null>(null);
  const [name, setName] = useState("");
  const [repository, setRepository] = useState("");
  const [branch, setBranch] = useState("");
  const [shallow, setShallow] = useState(false);
  const [initializeGit, setInitializeGit] = useState(true);
  const [query, setQuery] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const busy = useRef(false);
  const focusReturn = useRef<HTMLElement | null>(null);
  const create = (nextMode: NonNullable<typeof mode>): void => {
    focusReturn.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setMode(nextMode);
    setFormError(null);
    setName("");
    setRepository("");
    setBranch("");
    setShallow(false);
    setInitializeGit(true);
  };
  const execute = async (command: WorkspaceCommand): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setSubmitting(true);
    try {
      return await onCommand(command);
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  };
  const submit = async (): Promise<void> => {
    if (!mode || busy.current) return;
    const parsed = projectNameSchema.safeParse(name);
    if (!parsed.success) {
      setFormError(
        parsed.error.issues[0]?.message ?? "Choose a valid folder name.",
      );
      return;
    }
    const command: WorkspaceCommand =
      mode === "clone"
        ? {
            kind: "clone-project",
            name: parsed.data,
            repository,
            shallow,
            ...(branch.trim() ? { branch: branch.trim() } : {}),
          }
        : mode === "empty"
          ? { kind: "create-project", name: parsed.data, initializeGit }
          : { kind: "import-project", name: parsed.data };
    if (await execute(command)) setMode(null);
    else
      setFormError(
        "The host could not accept this project. Check the connection message and the folder or repository details, then try again.",
      );
  };
  const filtered = library.projects.filter((project) =>
    `${project.name} ${project.repository ?? ""}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  const preparing = library.projects.filter(
    (project) => project.status === "creating" || project.status === "cloning",
  ).length;
  const full = library.projects.length >= library.maximumProjects;
  return (
    <section className="m-project-library" aria-label="Projects">
      <div className="m-project-heading">
        <div>
          <h1>Projects</h1>
          <p>Create a project, then open a task for your agent.</p>
        </div>
        <div className="m-project-actions">
          <button
            type="button"
            className="m-product-primary-button"
            disabled={full || pending}
            onClick={() => create("clone")}
          >
            <GitBranch aria-hidden="true" />
            Clone repository
          </button>
          <button
            type="button"
            disabled={full || pending}
            onClick={() => create("empty")}
          >
            <Plus aria-hidden="true" />
            Empty project
          </button>
          <button
            type="button"
            disabled={full || pending}
            onClick={() => create("import")}
          >
            Import folder
          </button>
        </div>
      </div>
      <div className="m-project-root">
        <span>Workspace root on this host</span>
        <code>{library.root}</code>
        <small>
          {library.projects.length} / {library.maximumProjects} projects
          {preparing > 0 ? ` · ${preparing} preparing` : ""}
        </small>
      </div>
      <label className="m-product-search">
        <Search aria-hidden="true" />
        <span className="m-product-visually-hidden">Search projects</span>
        <input
          type="search"
          placeholder="Search projects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {filtered.length === 0 ? (
        <div className="m-project-empty">
          <FolderPlus aria-hidden="true" />
          <h2>
            {query
              ? "No matching projects"
              : "Your server is ready for projects"}
          </h2>
          <p>
            {query
              ? "Try another name or repository."
              : "Clone a Git repository, start with an empty folder, or import a folder already inside the workspace root."}
          </p>
        </div>
      ) : null}
      <div className="m-project-list">
        {filtered.map((project) => {
          const workspace = project.workspace;
          const projectSessions = sessions.filter(
            (session) => session.workspace === workspace,
          );
          const active =
            project.status === "creating" || project.status === "cloning";
          const latest = [...projectSessions]
            .filter((session) => session.archivedAt === undefined)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
          return (
            <article
              className="m-project-card"
              key={project.id}
              aria-label={project.name}
            >
              <div className="m-project-card-heading">
                <h2>{project.name}</h2>
                <span className="m-project-status" data-status={project.status}>
                  {active ? (
                    <LoaderCircle
                      className="m-product-spin"
                      aria-hidden="true"
                    />
                  ) : null}
                  {project.status === "ready"
                    ? "Ready"
                    : project.status === "cloning"
                      ? "Cloning"
                      : project.status === "creating"
                        ? "Creating"
                        : project.status === "cancelled"
                          ? "Cancelled"
                          : "Needs attention"}
                </span>
              </div>
              <p>
                {project.repository ??
                  (project.initializeGit
                    ? "Git project"
                    : project.kind === "imported"
                      ? "Imported folder"
                      : "Empty project")}
              </p>
              {project.branch || project.shallow ? (
                <small>
                  {project.branch ?? "Default branch"}
                  {project.shallow ? " · Shallow clone" : ""}
                </small>
              ) : null}
              {project.progress ? (
                <p className="m-project-progress" role="status">
                  {project.progress}
                </p>
              ) : null}
              {project.error ? (
                <p className="m-project-error" role="status">
                  {project.error}
                </p>
              ) : null}
              <div className="m-project-card-footer">
                <small>
                  {projectSessions.length} saved task
                  {projectSessions.length === 1 ? "" : "s"}
                  {projectSessions.some((session) => session.runningTaskId)
                    ? " · Agent working"
                    : ""}
                </small>
                <div className="m-project-actions">
                  {servicesHref && project.status === "ready" ? (
                    <a
                      className="m-product-secondary-button"
                      href={`${servicesHref}?workspace=${encodeURIComponent(project.workspace)}`}
                    >
                      Services & previews
                    </a>
                  ) : null}
                  {project.status === "ready" ? (
                    <>
                      {latest ? (
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() =>
                            void onCommand({
                              kind: "activate-session",
                              sessionId: latest.id,
                            }).then((accepted) => {
                              if (accepted) onOpenChat();
                            })
                          }
                        >
                          Resume
                        </button>
                      ) : null}
                      <button
                        className="m-product-primary-button"
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          void onCommand({
                            kind: "create-session",
                            workspace,
                          }).then((accepted) => {
                            if (accepted) onOpenChat();
                          })
                        }
                      >
                        New task
                      </button>
                    </>
                  ) : active ? (
                    <button
                      type="button"
                      disabled={pending || submitting}
                      onClick={() =>
                        void execute({
                          kind: "cancel-project-operation",
                          projectId: project.id,
                        })
                      }
                    >
                      Cancel setup
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={pending || submitting}
                      onClick={() =>
                        void execute({
                          kind: "retry-project-operation",
                          projectId: project.id,
                        })
                      }
                    >
                      Retry setup
                    </button>
                  )}
                  {!active && projectSessions.length === 0 ? (
                    <button
                      type="button"
                      disabled={pending || submitting}
                      title="Remove from the library. Files stay on the host."
                      onClick={() =>
                        void execute({
                          kind: "forget-project",
                          projectId: project.id,
                        })
                      }
                    >
                      Remove entry
                    </button>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
      <Dialog.Root
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open) setMode(null);
        }}
      >
        <Dialog.Overlay className="m-project-dialog-overlay" />
        <Dialog.Content
          className="m-project-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (focusReturn.current?.isConnected) focusReturn.current.focus();
          }}
        >
          <Dialog.Title>
            {mode === "clone"
              ? "Clone repository"
              : mode === "empty"
                ? "Create an empty project"
                : "Import an existing folder"}
          </Dialog.Title>
          <Dialog.Description>
            {mode === "clone"
              ? "Cloning continues on the host when you leave this page."
              : mode === "empty"
                ? "A new folder for your agent to work in."
                : "Register a folder directly inside the workspace root. Its files stay unchanged."}
          </Dialog.Description>
          <Dialog.Close
            className="m-product-icon-button m-project-dialog-close"
            aria-label="Close project form"
          >
            <X aria-hidden="true" />
          </Dialog.Close>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {mode === "clone" ? (
              <label>
                Repository URL
                <input
                  autoFocus
                  aria-label="Repository URL"
                  required
                  type="text"
                  inputMode="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  value={repository}
                  maxLength={2048}
                  placeholder="https://github.com/owner/repository.git"
                  onChange={(event) => {
                    const next = event.target.value;
                    setRepository(next);
                    if (
                      !name ||
                      name ===
                        repository
                          .split(/[/:]/u)
                          .at(-1)
                          ?.replace(/\.git$/u, "")
                    )
                      setName(
                        next
                          .split(/[/:]/u)
                          .at(-1)
                          ?.replace(/\.git$/u, "")
                          .replace(/[^a-zA-Z0-9._-]/gu, "")
                          .slice(0, 80) ?? "",
                      );
                  }}
                />
                <small>
                  HTTPS or SSH. Private repositories use Git credentials or SSH
                  keys configured on the host. Do not include passwords or
                  tokens.
                </small>
              </label>
            ) : null}
            <label>
              Folder name
              <input
                aria-label="Project folder name"
                required
                autoFocus={mode !== "clone"}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={name}
                maxLength={80}
                placeholder="my-project"
                onChange={(event) => setName(event.target.value)}
              />
              <small className="m-project-path">
                {library.root} / {name || "my-project"}
              </small>
            </label>
            {mode === "clone" ? (
              <>
                <label>
                  Branch or tag <span>(optional)</span>
                  <input
                    aria-label="Branch or tag"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={branch}
                    maxLength={240}
                    placeholder="Repository default"
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </label>
                <label className="m-project-checkbox">
                  <input
                    type="checkbox"
                    checked={shallow}
                    onChange={(event) => setShallow(event.target.checked)}
                  />
                  Shallow clone: faster download, latest history only
                </label>
              </>
            ) : null}
            {mode === "empty" ? (
              <label className="m-project-checkbox">
                <input
                  type="checkbox"
                  checked={initializeGit}
                  onChange={(event) => setInitializeGit(event.target.checked)}
                />
                Initialize Git with a main branch
              </label>
            ) : null}
            {formError ? (
              <p className="m-project-error" role="alert">
                {error ?? formError}
              </p>
            ) : null}
            <button
              className="m-product-primary-button"
              type="submit"
              disabled={submitting || pending}
            >
              {submitting
                ? "Preparing…"
                : mode === "clone"
                  ? "Clone project"
                  : mode === "empty"
                    ? "Create project"
                    : "Import project"}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Root>
    </section>
  );
}
