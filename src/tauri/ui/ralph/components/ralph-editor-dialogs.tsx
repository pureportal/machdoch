import { Copy, LoaderCircle, Plus, Workflow } from "lucide-react";
import {
  type Dispatch,
  type JSX,
  type RefObject,
  type SetStateAction,
} from "react";

import type {
  RalphFlowScope,
} from "../../../../core/ralph.js";
import type { RalphStarterFlowSummary } from "../../../../core/ralph-starter-flows.js";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import {
  RALPH_FLOW_SCOPES,
  RALPH_FLOW_SCOPE_LABELS,
} from "../_helpers/normalize-ralph-flow-scope.helper";
import {
  STARTER_RALPH_FLOW_SUMMARIES,
  formatStarterFlowSubtitle,
  getStarterFlowAutonomyReadiness,
  getStarterFlowEmoji,
} from "../_helpers/ralph-starter-flow-presentation.helper";

export type RalphExpandedEditorMode = "text" | "code" | "json";

export interface RalphExpandedEditorState {
  title: string;
  description: string;
  ariaLabel: string;
  mode: RalphExpandedEditorMode;
  value: string;
  supportsVariables?: boolean;
  contextKey?: string;
  onApply: (value: string) => void;
}

interface RalphStarterFlowDialogProps {
  open: boolean;
  workspaceRoot: string | null;
  loading: boolean;
  errorMessage: string | null;
  starterImportScope: RalphFlowScope;
  starterImportScopeLabel: string;
  onOpenChange: Dispatch<SetStateAction<boolean>>;
  onStarterImportScopeChange: Dispatch<SetStateAction<RalphFlowScope>>;
  onImportStarterFlow: (
    starterFlow: RalphStarterFlowSummary,
    targetScope: RalphFlowScope,
  ) => void;
}

export const RalphStarterFlowDialog = ({
  open,
  workspaceRoot,
  loading,
  errorMessage,
  starterImportScope,
  starterImportScopeLabel,
  onOpenChange,
  onStarterImportScopeChange,
  onImportStarterFlow,
}: RalphStarterFlowDialogProps): JSX.Element => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="h-[min(720px,calc(100vh-28px))] w-[min(880px,calc(100vw-28px))] max-w-none grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-xl border-slate-700/80 bg-slate-950 p-0 text-slate-100 shadow-[0_24px_80px_rgba(2,6,23,0.65)] sm:max-w-none">
        <DialogHeader className="border-b border-slate-800 bg-slate-950 px-5 py-4 pr-12">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-amber-400/25 bg-amber-400/10">
              <Workflow className="h-4 w-4 text-amber-200" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="truncate text-base font-semibold text-white">
                Starter Ralph flows
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm text-slate-500">
                Import a bundled flow as an editable copy in this workspace or in your global library.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-950 px-5 py-3">
          <div className="min-w-0 text-sm">
            <span className="font-medium text-slate-200">Import to</span>
            <span className="ml-2 text-slate-500">
              {starterImportScopeLabel}
            </span>
          </div>
          <div className="grid w-full grid-cols-2 gap-1 rounded-lg border border-slate-800 bg-slate-900/70 p-1 sm:w-64">
            {RALPH_FLOW_SCOPES.map((scope) => (
              <button
                key={scope}
                type="button"
                aria-pressed={starterImportScope === scope}
                aria-label={`Import starter flows to ${RALPH_FLOW_SCOPE_LABELS[scope]}`}
                onClick={() => onStarterImportScopeChange(scope)}
                className={cn(
                  "h-8 rounded-md px-2 text-xs font-semibold",
                  starterImportScope === scope
                    ? scope === "user"
                      ? "bg-sky-500/20 text-sky-100"
                      : "bg-emerald-500/20 text-emerald-100"
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-100",
                )}
              >
                {RALPH_FLOW_SCOPE_LABELS[scope]}
              </button>
            ))}
          </div>
        </div>

        <ScrollArea className="min-h-0 bg-slate-950" type="always">
          <div className="grid gap-3 p-4 md:grid-cols-2">
            {STARTER_RALPH_FLOW_SUMMARIES.map((starterFlow) => {
              const readiness = getStarterFlowAutonomyReadiness(starterFlow);

              return (
                <article
                  key={starterFlow.id}
                  className="grid content-between gap-4 rounded-lg border border-slate-800 bg-slate-950/70 p-4"
                >
                <div className="grid gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 shrink-0 text-base leading-none"
                    >
                      {getStarterFlowEmoji(starterFlow)}
                    </span>
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-white">
                        {starterFlow.name}
                      </h3>
                      <div className="mt-1 text-xs text-slate-600">
                        {formatStarterFlowSubtitle(starterFlow)}
                      </div>
                    </div>
                  </div>
                  <p className="text-sm leading-5 text-slate-400">
                    {starterFlow.description}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={cn(
                        "rounded-md border px-2 py-1 text-[0.68rem] font-semibold",
                        readiness.ready
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                          : "border-amber-500/30 bg-amber-500/10 text-amber-200",
                      )}
                    >
                      {readiness.label}
                    </span>
                    {readiness.capabilities.map((capability) => (
                      <span
                        key={capability}
                        className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[0.68rem] text-slate-400"
                      >
                        {capability}
                      </span>
                    ))}
                  </div>
                </div>

                <Button
                  type="button"
                  variant="outline"
                  disabled={!workspaceRoot || loading}
                  aria-label={`Add starter flow ${starterFlow.name} to ${starterImportScopeLabel}`}
                  onClick={() =>
                    onImportStarterFlow(starterFlow, starterImportScope)
                  }
                  className="h-8 justify-self-start rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-100 hover:bg-slate-800 hover:text-white disabled:opacity-60"
                >
                  {loading ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  Add
                </Button>
                </article>
              );
            })}
          </div>
        </ScrollArea>

        <DialogFooter className="items-center justify-between border-t border-slate-800 bg-slate-950 px-5 py-3 sm:flex-row">
          <div className="grid gap-1 text-xs">
            <span className="text-slate-500">
              Starter flows stay bundled; imported flows are saved as editable copies.
            </span>
            {errorMessage ? (
              <span role="alert" className="text-red-300">
                {errorMessage}
              </span>
            ) : null}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="text-slate-400 hover:bg-slate-900 hover:text-white"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface RalphExpandedEditorDialogProps {
  editor: RalphExpandedEditorState | null;
  draft: string;
  wrap: boolean;
  variableSnippets: readonly string[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onWrapChange: (wrap: boolean) => void;
  onClose: () => void;
  onApply: () => void;
  onCopy: () => void;
  onInsertSnippet: (snippet: string) => void;
}

export const RalphExpandedEditorDialog = ({
  editor,
  draft,
  wrap,
  variableSnippets,
  textareaRef,
  onDraftChange,
  onWrapChange,
  onClose,
  onApply,
  onCopy,
  onInsertSnippet,
}: RalphExpandedEditorDialogProps): JSX.Element => {
  const isJsonMode = editor?.mode === "json";

  return (
    <Dialog
      open={Boolean(editor)}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[calc(100vh-3rem)] max-w-[min(72rem,calc(100vw-3rem))] grid-rows-[auto_minmax(0,1fr)_auto] border-slate-700 bg-slate-950 p-0 text-slate-100">
        <DialogHeader className="border-b border-slate-800 px-5 py-4 pr-12">
          <DialogTitle className="text-base text-white">
            {editor?.title ?? "Expanded editor"}
          </DialogTitle>
          <DialogDescription className="text-slate-500">
            {editor?.description ?? "Edit the field in a larger workspace."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 gap-3 overflow-hidden px-5 py-4">
          {editor?.supportsVariables ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs font-medium text-slate-500">
                Insert
              </span>
              {variableSnippets.map((snippet) => (
                <button
                  key={snippet}
                  type="button"
                  onClick={() => onInsertSnippet(snippet)}
                  className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-[0.68rem] text-slate-300 hover:border-cyan-400/30 hover:bg-cyan-500/10 hover:text-cyan-100"
                >
                  {snippet}
                </button>
              ))}
            </div>
          ) : null}
          <Textarea
            ref={textareaRef}
            value={draft}
            aria-label={editor?.ariaLabel ?? "Expanded editor"}
            wrap={wrap ? "soft" : "off"}
            spellCheck={editor?.mode === "text"}
            onChange={(event) => onDraftChange(event.target.value)}
            className={cn(
              "min-h-[min(56vh,34rem)] resize-none overflow-auto rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm leading-6 text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-500/60 focus:ring-1 focus:ring-cyan-500/30",
              isJsonMode && "font-mono",
            )}
          />
        </div>
        <DialogFooter className="items-center justify-between border-t border-slate-800 px-5 py-3 sm:flex-row">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(event) => onWrapChange(event.target.checked)}
            />
            Wrap lines
          </label>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onCopy}
              className="h-8 rounded-lg px-3 text-xs text-slate-300 hover:bg-slate-900 hover:text-white"
            >
              <Copy className="h-3.5 w-3.5" />
              Copy
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              className="h-8 rounded-lg border-slate-700 bg-slate-900 px-3 text-xs text-slate-200 hover:bg-slate-800"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={onApply}
              className="h-8 rounded-lg bg-cyan-600 px-3 text-xs text-white hover:bg-cyan-500"
            >
              Apply
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
