import { useCallback, useEffect, useId, useState, type JSX } from "react";
import {
  researchProjectInputSchema,
  type ResearchProject,
  type ResearchProjectInput,
  type ResearchSourceCheck,
} from "@machdoch/fleet-protocol/workspace-library";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { invokeWorkspaceLibrary } from "./workspace-library-client";
import { ResearchEvidenceEditor } from "./research-evidence-editor";

function editableProject({
  createdAt: _created,
  updatedAt: _updated,
  ...project
}: ResearchProject): ResearchProjectInput {
  return project;
}

export function WorkspaceResearchPanel({
  workspaceRoot,
  onDirtyChange,
}: {
  workspaceRoot: string;
  onDirtyChange: (dirty: boolean) => void;
}): JSX.Element {
  const id = useId();
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [draft, setDraft] = useState<ResearchProjectInput | null>(null);
  const [saved, setSaved] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<ResearchSourceCheck[]>([]);
  const dirty = draft !== null && JSON.stringify(draft) !== saved;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const refresh = useCallback(async (): Promise<ResearchProject[]> => {
    const next = await invokeWorkspaceLibrary<ResearchProject[]>(
      workspaceRoot,
      {
        action: "projects",
      },
    );
    setProjects(next);
    return next;
  }, [workspaceRoot]);
  useEffect(() => {
    void refresh().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [refresh]);
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const select = (project: ResearchProjectInput | null): void => {
    if (dirty && !window.confirm("Discard unsaved research changes?")) return;
    setDraft(project);
    setSaved(project?.id ? JSON.stringify(project) : "");
    setChecks([]);
    setError(null);
  };
  const update = (project: ResearchProjectInput): void => {
    setDraft(project);
    setChecks([]);
  };
  return (
    <section
      className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]"
      aria-label="Research projects"
    >
      <div className="space-y-3">
        <div className="flex gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              select({
                revision: 0,
                title: "",
                question: "",
                notes: "",
                status: "active",
                sources: [],
                findings: [],
              })
            }
          >
            New project
          </Button>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (dirty && !window.confirm("Discard unsaved research changes?"))
                return;
              void perform(async () => {
                const next = await refresh();
                const selected = next.find(
                  (project) => project.id === draft?.id,
                );
                const project = selected ? editableProject(selected) : null;
                setDraft(project);
                setSaved(project ? JSON.stringify(project) : "");
                setChecks([]);
              });
            }}
          >
            Refresh
          </Button>
        </div>
        <Input
          aria-label="Search research projects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className="space-y-1">
          {projects
            .filter((project) =>
              `${project.title} ${project.question}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((project) => (
              <li key={project.id}>
                <button
                  disabled={busy}
                  aria-current={draft?.id === project.id ? "true" : undefined}
                  className={`w-full rounded-md p-3 text-left text-sm ${draft?.id === project.id ? "bg-sky-950 text-sky-100" : "hover:bg-slate-900"}`}
                  onClick={() => select(editableProject(project))}
                >
                  {project.title}
                  <span className="mt-1 block text-xs text-slate-500">
                    {project.status}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      </div>
      <div className="min-w-0 space-y-3">
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
        {draft && (
          <form
            className="space-y-4 rounded-lg border border-slate-800 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const validated = researchProjectInputSchema.safeParse(draft);
                if (!validated.success)
                  throw new Error(
                    validated.error.issues[0]?.message ??
                      "Check the project fields.",
                  );
                const project = await invokeWorkspaceLibrary<ResearchProject>(
                  workspaceRoot,
                  { action: "save-project", project: validated.data },
                );
                const next = editableProject(project);
                setDraft(next);
                setSaved(JSON.stringify(next));
                setChecks([]);
                await refresh();
              });
            }}
          >
            <fieldset disabled={busy} className="space-y-4">
              <label className="block space-y-1 text-xs">
                Title
                <Input
                  required
                  maxLength={200}
                  value={draft.title}
                  onChange={(event) =>
                    update({ ...draft, title: event.target.value })
                  }
                />
              </label>
              <div className="space-y-1 text-xs">
                <label htmlFor={`${id}-question`}>Research question</label>
                <textarea
                  id={`${id}-question`}
                  required
                  maxLength={4000}
                  className="min-h-20 w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-sm"
                  value={draft.question}
                  onChange={(event) =>
                    update({ ...draft, question: event.target.value })
                  }
                />
              </div>
              <label className="flex items-center gap-2 text-xs">
                Status
                <select
                  className="rounded border border-slate-700 bg-slate-950 p-2"
                  value={draft.status}
                  onChange={(event) =>
                    update({
                      ...draft,
                      status: event.target.value as typeof draft.status,
                    })
                  }
                >
                  <option value="active">Active</option>
                  <option value="complete">Complete</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
              <div className="space-y-1 text-xs">
                <label htmlFor={`${id}-notes`}>Notes</label>
                <textarea
                  id={`${id}-notes`}
                  maxLength={100000}
                  className="min-h-40 w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-sm"
                  value={draft.notes}
                  onChange={(event) =>
                    update({ ...draft, notes: event.target.value })
                  }
                />
              </div>
              <ResearchEvidenceEditor
                project={draft}
                checks={checks}
                onChange={update}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  disabled={
                    !dirty || !draft.title.trim() || !draft.question.trim()
                  }
                >
                  Save project
                </Button>
                {draft.id && (
                  <>
                    <Button
                      variant="outline"
                      disabled={dirty}
                      onClick={() =>
                        void perform(async () => {
                          setChecks(
                            await invokeWorkspaceLibrary<ResearchSourceCheck[]>(
                              workspaceRoot,
                              { action: "check-sources", id: draft.id! },
                            ),
                          );
                        })
                      }
                    >
                      Check sources
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void perform(async () => {
                          if (
                            !window.confirm(
                              `Delete research project “${draft.title}” and its saved findings?`,
                            )
                          )
                            return;
                          await invokeWorkspaceLibrary(workspaceRoot, {
                            action: "delete-project",
                            id: draft.id!,
                            revision: draft.revision,
                          });
                          setDraft(null);
                          setSaved("");
                          await refresh();
                        })
                      }
                    >
                      Delete project
                    </Button>
                  </>
                )}
              </div>
            </fieldset>
          </form>
        )}
      </div>
    </section>
  );
}
