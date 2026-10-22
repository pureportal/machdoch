import { useRef, useState, type JSX } from "react";
import type {
  KnowledgeHit,
  KnowledgeSearchResult,
  KnowledgeSource,
  ResearchProject,
} from "@machdoch/fleet-protocol/workspace-library";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { invokeWorkspaceLibrary } from "./workspace-library-client";

export function WorkspaceKnowledgePanel({
  workspaceRoot,
}: {
  workspaceRoot: string;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<KnowledgeSearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<{
    hit: KnowledgeHit;
    file: KnowledgeSource;
  } | null>(null);
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [savingHit, setSavingHit] = useState<KnowledgeHit | null>(null);
  const [selectedProject, setSelectedProject] = useState("");
  const sequence = useRef(0);
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const search = (): Promise<void> =>
    perform(async () => {
      const request = ++sequence.current;
      const next = await invokeWorkspaceLibrary<KnowledgeSearchResult>(
        workspaceRoot,
        { action: "search", query, limit: 20 },
      );
      if (sequence.current === request) {
        setResult(next);
        setSource(null);
      }
    });
  const openSource = (hit: KnowledgeHit): Promise<void> =>
    perform(async () => {
      const file = await invokeWorkspaceLibrary<KnowledgeSource>(
        workspaceRoot,
        { action: "source", path: hit.path },
      );
      setSource({ hit, file });
    });
  return (
    <section className="space-y-4" aria-label="Workspace knowledge">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <Input
          aria-label="Search workspace knowledge"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={1000}
        />
        <Button type="submit" disabled={busy || !query.trim()}>
          {busy ? "Searching…" : "Search"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-sm text-red-300">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-xs text-slate-400">
          {result.hits.length} results · {result.indexedFiles} files
          {result.skippedFiles
            ? ` · ${result.skippedFiles} unreadable or unsupported files`
            : ""}
        </p>
      )}
      {result?.hits.map((hit, index) => (
        <article
          key={`${hit.path}:${hit.startLine}:${index}`}
          className="space-y-2 rounded-lg border border-slate-800 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              className="text-left text-sm text-sky-300 hover:underline"
              onClick={() => void openSource(hit)}
            >
              {hit.path}:{hit.startLine}–{hit.endLine}
            </button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const available = await invokeWorkspaceLibrary<
                    ResearchProject[]
                  >(workspaceRoot, { action: "projects" });
                  setProjects(
                    available.filter(
                      (project) => project.status !== "archived",
                    ),
                  );
                  setSavingHit(hit);
                  setSelectedProject("");
                })
              }
            >
              Save to research
            </Button>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs text-slate-300">
            {hit.excerpt}
          </pre>
        </article>
      ))}
      {savingHit && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-700 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const project = await invokeWorkspaceLibrary<ResearchProject>(
                workspaceRoot,
                { action: "project", id: selectedProject },
              );
              const {
                createdAt: _created,
                updatedAt: _updated,
                ...input
              } = project;
              await invokeWorkspaceLibrary(workspaceRoot, {
                action: "save-project",
                project: {
                  ...input,
                  sources: [
                    ...input.sources,
                    {
                      id: crypto.randomUUID(),
                      title: `${savingHit.path}:${savingHit.startLine}–${savingHit.endLine}`,
                      uri: savingHit.path,
                      excerpt: savingHit.excerpt,
                      fingerprint: savingHit.fingerprint,
                    },
                  ],
                },
              });
              setSavingHit(null);
            });
          }}
        >
          {projects.length ? (
            <select
              aria-label="Research project"
              value={selectedProject}
              onChange={(event) => setSelectedProject(event.target.value)}
              className="rounded border border-slate-700 bg-slate-950 p-2 text-sm"
            >
              <option value="">Select project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-sm text-slate-400">
              Create a project in Research first.
            </p>
          )}
          <Button type="submit" disabled={busy || !selectedProject}>
            Save source
          </Button>
          <Button variant="ghost" onClick={() => setSavingHit(null)}>
            Cancel
          </Button>
        </form>
      )}
      {source && (
        <section
          aria-label="Source preview"
          className="space-y-2 rounded-lg border border-slate-700 p-3"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm">{source.file.path}</h3>
            <Button variant="ghost" onClick={() => setSource(null)}>
              Close source
            </Button>
          </div>
          {source.file.fingerprint !== source.hit.fingerprint && (
            <p role="status" className="text-sm">
              This source changed. Search again for current results.
            </p>
          )}
          <pre className="max-h-96 overflow-auto text-xs">
            {source.file.content.split(/\r?\n/u).map((line, index) => (
              <span
                key={index}
                className={`block ${index + 1 >= source.hit.startLine && index + 1 <= source.hit.endLine ? "bg-sky-950/60" : ""}`}
              >
                <span className="mr-3 inline-block w-10 select-none text-right text-slate-500">
                  {index + 1}
                </span>
                {line || " "}
              </span>
            ))}
          </pre>
        </section>
      )}
    </section>
  );
}
