import { useRef, useState } from "react";
import { FolderOpen, Plus, Search } from "lucide-react";
import type { SpeechRuntime } from "@machdoch/speech";
import { Field, type Run } from "./controls.tsx";
import type { useProjects } from "./projects.ts";

export function ProjectLibrary({ runtime, workspace, run, busy, openProject, onCreated }: {
  runtime: SpeechRuntime;
  workspace: ReturnType<typeof useProjects>;
  run: Run;
  busy: boolean;
  openProject(id: string): Promise<void>;
  onCreated(): void;
}) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const { projectPage } = workspace;

  return <aside className="tts-projects" aria-label="Projects">
    <div className="tts-section-heading"><h2>{projectPage.total ? "Projects" : "New project"}</h2>
      {(workspace.project || projectPage.total > 0) && <button ref={newButton} className="tts-icon-button" aria-label="New project" aria-expanded={creating} disabled={busy} onClick={() => setCreating(value => !value)}><Plus size={18} /></button>}
    </div>
    {(creating || !workspace.project && !projectPage.total) && <form className="tts-stack" aria-label="New project" onSubmit={event => {
      event.preventDefault();
      void run(async () => {
        await workspace.create(title);
        setTitle("");
        setSearch("");
        setArchived(false);
        setCreating(false);
        onCreated();
      });
    }}>
      <Field label="Project name"><input autoFocus={creating} value={title} required maxLength={1024} onChange={event => setTitle(event.target.value)} /></Field>
      <button className="tts-primary" disabled={busy || !title.trim()}><Plus size={16} />Create project</button>
      {creating && <button type="button" onClick={() => { setCreating(false); newButton.current?.focus(); }}>Cancel</button>}
    </form>}
    {(projectPage.total > 0 || search || archived) && <form className="tts-project-search" role="search" aria-label="Projects" onSubmit={event => {
      event.preventDefault();
      void run(() => workspace.loadProjects({ search, archived, offset: 0 }));
    }}>
      <input aria-label="Search projects" placeholder="Search projects" type="search" value={search} onChange={event => setSearch(event.target.value)} />
      <button aria-label="Search projects" className="tts-icon-button" disabled={busy}><Search size={16} /></button>
    </form>}
    <ul className="tts-project-list">
      {workspace.projects.map(item => <li key={item.id}>
        <button aria-current={item.id === workspace.project?.id ? "page" : undefined} disabled={busy || !!workspace.conflict} onClick={() => void run(() => openProject(item.id))}>
          <FolderOpen size={16} aria-hidden="true" /><span>{item.title}</span>
        </button>
      </li>)}
    </ul>
    {!workspace.projects.length && (search || archived) && <p className="tts-muted">No projects found.</p>}
    {(projectPage.total > projectPage.limit || projectPage.offset > 0) && <div className="tts-row" role="group" aria-label="Project pages">
      <button type="button" disabled={busy || projectPage.offset === 0} onClick={() => void run(() => workspace.loadProjects({ offset: Math.max(0, projectPage.offset - projectPage.limit) }))}>Previous projects</button>
      <span className="tts-muted">{Math.floor(projectPage.offset / projectPage.limit) + 1} / {Math.ceil(projectPage.total / projectPage.limit)}</span>
      <button type="button" disabled={busy || projectPage.offset + workspace.projects.length >= projectPage.total} onClick={() => void run(() => workspace.loadProjects({ offset: projectPage.offset + projectPage.limit }))}>Next projects</button>
    </div>}
    <details className="tts-library-tools">
      <summary>Manage projects</summary>
      <label className="tts-check"><input type="checkbox" checked={archived} onChange={event => {
        const selected = event.target.checked;
        setArchived(selected);
        void run(() => workspace.loadProjects({ search, archived: selected, offset: 0 }));
      }} />Archived</label>
      <form className="tts-stack" onSubmit={event => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void run(async () => {
          await workspace.save();
          await workspace.open(await runtime.execute("importProject", { path: String(data.get("path")) }));
          await workspace.loadProjects({ search, archived, offset: 0 });
          onCreated();
        });
      }}>
        <Field label="Project file path"><input name="path" required /></Field>
        <button disabled={busy}>Import project</button>
      </form>
    </details>
  </aside>;
}
