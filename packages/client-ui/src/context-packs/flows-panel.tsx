import type { JSX } from "react";
import {
  ArrowRight,
  Folder,
  Globe2,
  Pencil,
  Play,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { EmptyState } from "@machdoch/media-studio/tauri/ui/components/ui/empty-state.js";
import { ControlTooltip } from "@machdoch/media-studio/tauri/ui/components/ui/tooltip.js";
import { getContextPackFlowIssue, resolveContextPackFlowSteps } from "./flows";
import {
  getSmartContextPackScope,
  getSmartContextPackScopeLabel,
} from "./helpers";
import type { ContextPackFlow, SmartContextPack } from "./model";

export interface ContextPackFlowDeletion {
  flow: ContextPackFlow;
  deleting: boolean;
  error: string | null;
}

const ContextPackFlowCard = ({
  flow,
  contextPacks,
  runningFlowId,
  onEdit,
  onRun,
  onDelete,
}: {
  flow: ContextPackFlow;
  contextPacks: SmartContextPack[];
  runningFlowId: string | null;
  onEdit: (flow: ContextPackFlow) => void;
  onRun: (flow: ContextPackFlow) => void;
  onDelete: (flow: ContextPackFlow) => void;
}): JSX.Element => {
  const scope = getSmartContextPackScope(flow);
  const scopeLabel = getSmartContextPackScopeLabel(scope);
  const resolvedSteps = resolveContextPackFlowSteps(flow, contextPacks);
  const issue = getContextPackFlowIssue(resolvedSteps);
  const stepNames = resolvedSteps.map(
    ({ pack }) => pack?.name ?? "Unavailable pack",
  );

  return (
    <div className="min-w-0 rounded-xl border border-slate-800/90 bg-slate-900/55 px-2.5 py-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-100">
            {flow.name}
          </p>
          <ControlTooltip content={`${scopeLabel} flow`}>
            <span
              role="img"
              aria-label={`${scopeLabel} flow`}
              className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-slate-800/80 bg-slate-950/60"
            >
              {scope === "global" ? (
                <Globe2 className="h-3 w-3 text-emerald-200" />
              ) : (
                <Folder className="h-3 w-3 text-slate-400" />
              )}
            </span>
          </ControlTooltip>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Edit flow ${flow.name}`}
            tooltip={`Edit ${flow.name}`}
            disabled={runningFlowId !== null}
            onClick={() => onEdit(flow)}
            className="h-7 w-7 rounded-full border-slate-800 bg-transparent text-slate-400 shadow-none hover:border-slate-700 hover:bg-slate-900 hover:text-slate-100 disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
          >
            <Pencil className="h-3 w-3" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Run flow ${flow.name}`}
            tooltip={issue ?? `Run ${flow.name}`}
            disabled={issue !== null || runningFlowId !== null}
            onClick={() => onRun(flow)}
            className="h-7 w-7 rounded-full border-sky-500/20 bg-sky-500/10 text-sky-100 shadow-none hover:bg-sky-500/15 hover:text-white disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
          >
            <Play className="h-3 w-3 fill-current" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={`Delete flow ${flow.name}`}
            tooltip={`Delete ${flow.name}`}
            disabled={runningFlowId === flow.id}
            onClick={() => onDelete(flow)}
            className="h-7 w-7 rounded-full border-rose-500/20 bg-transparent text-rose-200 shadow-none hover:bg-rose-500/10 hover:text-white disabled:border-slate-800 disabled:bg-transparent disabled:text-slate-600"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <ol
        aria-label={`${flow.name} steps`}
        title={stepNames.join(" → ")}
        className="mt-1 flex min-w-0 items-center gap-1 overflow-hidden text-[11px] text-slate-400"
      >
        {resolvedSteps.map(({ step, issue: stepIssue }, index) => (
          <li
            key={step.id}
            className="flex min-w-0 shrink items-center gap-1 first:shrink-0"
          >
            {index > 0 ? (
              <ArrowRight
                aria-hidden="true"
                className="h-3 w-3 shrink-0 text-slate-600"
              />
            ) : null}
            <span
              className={stepIssue ? "truncate text-amber-300" : "truncate"}
            >
              {stepNames[index]}
            </span>
          </li>
        ))}
      </ol>
      {issue ? (
        <p className="mt-0.5 truncate text-[11px] text-amber-300">{issue}</p>
      ) : null}
    </div>
  );
};

export function ContextPackFlowList({
  flows,
  hasFlowsInScope,
  contextPacks,
  runningFlowId,
  onCreate,
  onEdit,
  onRun,
  onDelete,
}: {
  flows: ContextPackFlow[];
  hasFlowsInScope: boolean;
  contextPacks: SmartContextPack[];
  runningFlowId: string | null;
  onCreate: () => void;
  onEdit: (flow: ContextPackFlow) => void;
  onRun: (flow: ContextPackFlow) => void;
  onDelete: (flow: ContextPackFlow) => void;
}): JSX.Element {
  return (
    <div className="grid max-h-[26rem] gap-1.5 overflow-y-auto p-3">
      {!hasFlowsInScope ? (
        <button
          type="button"
          onClick={onCreate}
          className="grid gap-2 rounded-2xl border border-dashed border-slate-800 bg-slate-900/45 px-4 py-5 text-left text-slate-300 hover:border-sky-500/30 hover:bg-sky-500/10 hover:text-sky-100"
        >
          <span className="text-sm font-semibold">New flow</span>
          <span className="text-xs leading-5 text-slate-500">
            Run context packs in order.
          </span>
        </button>
      ) : null}
      {hasFlowsInScope && flows.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching flows"
          size="compact"
          role="status"
          className="rounded-2xl bg-slate-900/60"
        />
      ) : null}
      {flows.map((flow) => (
        <ContextPackFlowCard
          key={flow.id}
          flow={flow}
          contextPacks={contextPacks}
          runningFlowId={runningFlowId}
          onEdit={onEdit}
          onRun={onRun}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}

export function ContextPackFlowDeleteDialog({
  deletion,
  onCancel,
  onConfirm,
}: {
  deletion: ContextPackFlowDeletion;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const { flow, deleting, error } = deletion;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !deleting) onCancel();
      }}
    >
      <DialogContent showCloseButton={false} aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Delete {flow.name}?</DialogTitle>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-(--destructive)">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" disabled={deleting} onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={deleting} onClick={onConfirm}>
            {deleting ? "Deleting..." : "Delete flow"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
