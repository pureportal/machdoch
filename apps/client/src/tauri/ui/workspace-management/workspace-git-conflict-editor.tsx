import { oneDark } from "@codemirror/theme-one-dark";
import CodeMirror from "@uiw/react-codemirror";
import { Bot, Check, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  readWorkspaceFile,
  saveWorkspaceFile,
  type WorkspaceGitChange,
  type WorkspaceGitOverview,
} from "../runtime";
import type { WorkspaceGitControls } from "./use-workspace-git";
import {
  askWorkspaceAgent,
  conflictResolutionPrompt,
} from "./workspace-agent-requests";
import {
  hasConflictMarkers,
  parseConflictText,
  resolveAllConflicts,
  resolveConflictRegion,
  type ConflictChoice,
} from "./workspace-git-conflicts";
import { workspaceGitPathInWorkspace } from "./workspace-git-model";
import { comparisonView } from "./workspace-file-editor-extensions";
import { loadWorkspaceGitConflict } from "./workspace-tools-runtime";

interface ConflictDocument {
  ours: string | null;
  theirs: string | null;
  result: string;
  revision: string | null;
  binary: boolean;
}

const REGION_CHOICES: { choice: ConflictChoice; label: string }[] = [
  { choice: "ours", label: "Ours" },
  { choice: "theirs", label: "Theirs" },
  { choice: "both", label: "Both" },
];

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const SidePane = ({
  label,
  text,
}: {
  label: string;
  text: string | null;
}): JSX.Element => (
  <section className="min-w-0 overflow-hidden rounded-lg border border-slate-800 bg-slate-950/70">
    <h5 className="border-b border-slate-800 px-3 py-1.5 text-[11px] font-medium text-slate-400">
      {label}
    </h5>
    <pre className="max-h-56 overflow-auto px-3 py-2 font-mono text-[11px] leading-5 text-slate-300">
      {text ?? ""}
    </pre>
  </section>
);

export const WorkspaceGitConflictEditor = ({
  controls,
  overview,
  change,
}: {
  controls: WorkspaceGitControls;
  overview: WorkspaceGitOverview;
  change: WorkspaceGitChange;
}): JSX.Element => {
  const workspacePath = workspaceGitPathInWorkspace(
    controls.selectedRepository,
    change.path,
  );
  const [document, setDocument] = useState<ConflictDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setDocument(null);
    setError(null);
    Promise.all([
      loadWorkspaceGitConflict(
        overview.workspaceRoot,
        overview.repositoryRoot,
        change.path,
      ),
      readWorkspaceFile(overview.workspaceRoot, workspacePath).catch(
        () => null,
      ),
    ])
      .then(([versions, file]) => {
        if (!active) return;
        const result = versions.result ?? file?.content ?? "";
        setDocument({
          ours: versions.ours,
          theirs: versions.theirs,
          result,
          revision: file?.revision ?? null,
          binary: versions.binary,
        });
        setDraft(result);
      })
      .catch((failure: unknown) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [
    change.path,
    overview.repositoryRoot,
    overview.workspaceRoot,
    workspacePath,
  ]);

  const regions = useMemo(() => parseConflictText(draft).regions, [draft]);
  const unresolved = hasConflictMarkers(draft);
  const ours = document?.ours ?? "";
  const extensions = useMemo(() => [comparisonView(ours, false)], [ours]);

  const acceptFile = (side: "ours" | "theirs"): void => {
    void controls.runAction("resolve-conflict", { paths: [change.path], side });
  };

  const markResolved = async (): Promise<void> => {
    if (!document) return;
    setSaving(true);
    setError(null);
    try {
      if (draft !== document.result) {
        if (!document.revision)
          throw new Error("Reload the file before saving.");
        const saved = await saveWorkspaceFile(
          overview.workspaceRoot,
          workspacePath,
          draft,
          document.revision,
        );
        if (saved.status === "conflict") {
          throw new Error("The file changed on disk. Reload it and try again.");
        }
      }
      await controls.runAction("mark-resolved", { paths: [change.path] });
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label={`Conflict in ${change.path}`}
      className="flex min-w-0 flex-col gap-3"
    >
      <header className="flex min-h-8 flex-wrap items-center gap-1">
        <h4 className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200">
          {change.path}
        </h4>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={controls.busy}
          onClick={() => acceptFile("ours")}
        >
          Accept ours
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={controls.busy}
          onClick={() => acceptFile("theirs")}
        >
          Accept theirs
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={!document || document.binary}
          onClick={() =>
            askWorkspaceAgent({
              workspaceRoot: overview.workspaceRoot,
              prompt: conflictResolutionPrompt(
                overview.repositoryRoot,
                change.path,
                draft,
              ),
            })
          }
        >
          <Bot />
          Ask agent
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={
            controls.busy ||
            saving ||
            !document ||
            document.binary ||
            unresolved
          }
          tooltip={unresolved ? "Resolve every conflict first." : undefined}
          onClick={() => void markResolved()}
        >
          {saving ? <LoaderCircle className="animate-spin" /> : <Check />}
          Mark resolved
        </Button>
      </header>
      {error ? (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
      {!document ? (
        error ? null : (
          <div
            role="status"
            aria-label="Loading conflict"
            className="grid h-28 place-items-center"
          >
            <LoaderCircle className="size-5 animate-spin text-slate-500" />
          </div>
        )
      ) : document.binary ? (
        <p className="text-xs text-slate-400">Binary file. Accept one side.</p>
      ) : (
        <>
          <div className="grid gap-2 md:grid-cols-2">
            <SidePane label="Ours" text={document.ours} />
            <SidePane label="Theirs" text={document.theirs} />
          </div>
          {regions.length > 0 ? (
            <ol className="flex flex-wrap gap-2">
              {regions.map((region) => (
                <li
                  key={region.index}
                  className="flex items-center gap-1 rounded-md border border-slate-800 px-2 py-1 text-[11px] text-slate-400"
                >
                  <span>Line {region.startLine + 1}</span>
                  {REGION_CHOICES.map(({ choice, label }) => (
                    <Button
                      key={choice}
                      type="button"
                      size="xs"
                      variant="ghost"
                      className="h-5"
                      onClick={() =>
                        setDraft(
                          resolveConflictRegion(draft, region.index, choice),
                        )
                      }
                    >
                      {label}
                    </Button>
                  ))}
                </li>
              ))}
              <li className="flex items-center gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setDraft(resolveAllConflicts(draft, "ours"))}
                >
                  All ours
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setDraft(resolveAllConflicts(draft, "theirs"))}
                >
                  All theirs
                </Button>
              </li>
            </ol>
          ) : null}
          <section className="overflow-hidden rounded-lg border border-slate-800">
            <h5 className="border-b border-slate-800 px-3 py-1.5 text-[11px] font-medium text-slate-400">
              Result
            </h5>
            <CodeMirror
              value={draft}
              height="22rem"
              theme={oneDark}
              aria-label="Merge result"
              extensions={extensions}
              onChange={setDraft}
              className="text-[12px] [&_.cm-editor]:bg-slate-950/35 [&_.cm-gutters]:bg-slate-950/70 [&_.cm-scroller]:font-mono"
            />
          </section>
        </>
      )}
    </section>
  );
};
