import {
  CircleAlert,
  Cloud,
  Cpu,
  GitFork,
  LayoutTemplate,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { useMemo, useState, type JSX } from "react";
import { compileMediaFlow } from "../../../../core/media/compiler.js";
import type {
  InstantiateMediaFlowTemplateResult,
  MediaFlowTemplateCategory,
  MediaModelDescriptor,
} from "../../../../core/media/contracts.js";
import {
  instantiateMediaFlowTemplate,
  listBuiltInMediaFlowTemplates,
} from "../../../../core/media/templates.js";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { cn } from "../../lib/utils";

interface MediaFlowTemplatesPanelProps {
  models: readonly MediaModelDescriptor[];
  hasUnsavedChanges: boolean;
  onApply: (result: InstantiateMediaFlowTemplateResult) => void;
  onClose: () => void;
}

const TEMPLATE_CATEGORIES: readonly ("All" | MediaFlowTemplateCategory)[] = [
  "All",
  "Generation",
  "Product",
  "Quality",
];

const createForkId = (templateId: string): string =>
  `media-flow-${templateId}-${Date.now().toString(36)}`;

export const MediaFlowTemplatesPanel = ({
  models,
  hasUnsavedChanges,
  onApply,
  onClose,
}: MediaFlowTemplatesPanelProps): JSX.Element => {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<(typeof TEMPLATE_CATEGORIES)[number]>("All");
  const [pendingTemplateId, setPendingTemplateId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const templates = useMemo(() => listBuiltInMediaFlowTemplates(), []);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleTemplates = templates.filter((template) =>
    (category === "All" || template.category === category) &&
    (!normalizedQuery || [
      template.name,
      template.description,
      template.workflowSummary,
      ...template.tags,
    ].join(" ").toLocaleLowerCase().includes(normalizedQuery)),
  );

  const forkTemplate = (templateId: string): void => {
    try {
      const createdAt = new Date().toISOString();
      onApply(instantiateMediaFlowTemplate({
        templateId,
        flowId: createForkId(templateId),
        createdAt,
      }));
      onClose();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The template could not be forked.");
    }
  };

  return (
    <aside
      aria-label="Flow templates"
      className="absolute inset-y-0 right-0 z-20 min-h-0 w-[min(410px,calc(100%-2rem))] overflow-y-auto border-l border-slate-800/80 bg-slate-950/95 p-5 shadow-2xl xl:static xl:w-auto xl:bg-slate-950/90 xl:shadow-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <LayoutTemplate className="h-4 w-4 text-violet-300" />
            Built-in flow templates
          </div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            Fork a versioned semantic graph, then edit only the intent-level controls you need.
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close flow templates" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {notice ? (
        <div role="status" className="mt-4 flex gap-2 rounded-lg border border-rose-400/20 bg-rose-400/5 p-2 text-[10px] leading-4 text-rose-100">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{notice}
        </div>
      ) : null}

      <div className="relative mt-4">
        <Search className="pointer-events-none absolute top-2.5 left-3 h-3.5 w-3.5 text-slate-600" />
        <Input
          type="search"
          aria-label="Search flow templates"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search purpose, node, or capability"
          className="border-slate-700 bg-slate-900/60 pl-9 text-xs text-slate-100 placeholder:text-slate-600"
        />
      </div>
      <div className="mt-3 grid grid-cols-4 gap-1" aria-label="Template category">
        {TEMPLATE_CATEGORIES.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={category === candidate}
            onClick={() => setCategory(candidate)}
            className={cn(
              "rounded-md border px-1 py-1.5 text-[9px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/30",
              category === candidate
                ? "border-violet-400/30 bg-violet-400/10 text-violet-200"
                : "border-slate-800 bg-slate-900/35 text-slate-500 hover:text-slate-300",
            )}
          >
            {candidate}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {visibleTemplates.map((template) => {
          const plan = compileMediaFlow({
            flow: template.flow,
            models,
            compiledAt: new Date().toISOString(),
          });
          const pending = pendingTemplateId === template.id;
          const errors = plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
          return (
            <article key={template.id} className="rounded-xl border border-slate-800 bg-slate-900/45 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-100">{template.name}</div>
                  <div className="mt-1 font-mono text-[8px] text-slate-600">{template.id}@1</div>
                </div>
                <Badge variant="outline" className="border-violet-400/20 text-[8px] text-violet-300">{template.category}</Badge>
              </div>
              <p className="mt-3 text-[10px] leading-4 text-slate-400">{template.description}</p>
              <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/45 p-2.5 text-[9px] leading-4 text-slate-500">
                {template.workflowSummary}
              </div>

              <dl className="mt-3 grid grid-cols-2 gap-1.5 text-[9px]">
                <div className="rounded border border-slate-800 bg-slate-950/30 p-2">
                  <dt className="text-slate-600">Current target</dt>
                  <dd className="mt-1 flex items-center gap-1 text-slate-300">
                    {plan.preflight.target === "remote" ? <Cloud className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
                    {plan.preflight.target ?? "Unresolved"}
                  </dd>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/30 p-2">
                  <dt className="text-slate-600">Outputs</dt>
                  <dd className="mt-1 text-slate-300">
                    {plan.preflight.estimatedOutputs} bounded
                    {plan.preflight.requiresHumanReview
                      ? ` · review ${plan.preflight.generatedCandidates}`
                      : ""}
                  </dd>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/30 p-2">
                  <dt className="text-slate-600">Variables</dt>
                  <dd className="mt-1 text-slate-300">{template.flow.variables.length} · {template.flow.presets.length} presets</dd>
                </div>
                <div className="rounded border border-slate-800 bg-slate-950/30 p-2">
                  <dt className="text-slate-600">Preflight</dt>
                  <dd className={cn("mt-1", errors.length === 0 ? "text-emerald-300" : "text-amber-300")}>
                    {errors.length === 0 ? "Ready" : `${errors.length} setup item${errors.length === 1 ? "" : "s"}`}
                  </dd>
                </div>
              </dl>

              <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950/30">
                <summary className="cursor-pointer px-3 py-2 text-[9px] font-medium text-slate-400">Privacy, resources & graph contract</summary>
                <div className="space-y-3 border-t border-slate-800 p-3">
                  <p className="flex gap-2 text-[9px] leading-4 text-slate-500">
                    <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-cyan-400" />
                    {template.privacySummary}
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {template.flow.nodes.map((node) => (
                      <span key={node.id} className="rounded border border-slate-800 px-1.5 py-0.5 text-[8px] text-slate-600">{node.label}</span>
                    ))}
                  </div>
                  <dl className="space-y-1 text-[9px] text-slate-500">
                    <div className="flex justify-between gap-3"><dt>VRAM estimate</dt><dd>{plan.preflight.estimatedVramGb === null ? "Unresolved" : `${plan.preflight.estimatedVramGb} GB`}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Model download</dt><dd>{plan.preflight.estimatedDownloadGb === null ? "None" : `${plan.preflight.estimatedDownloadGb} GB`}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Human review</dt><dd>{plan.preflight.requiresHumanReview ? "Required" : "No"}</dd></div>
                    <div className="flex justify-between gap-3"><dt>Cost</dt><dd className="max-w-48 text-right">{plan.preflight.costHint}</dd></div>
                  </dl>
                  {errors.length > 0 ? (
                    <ul className="space-y-1 text-[9px] leading-4 text-amber-200/70">
                      {errors.slice(0, 3).map((diagnostic) => <li key={`${diagnostic.code}-${diagnostic.nodeId ?? "flow"}`}>{diagnostic.message}</li>)}
                    </ul>
                  ) : null}
                </div>
              </details>

              {pending ? (
                <div role="alert" className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 p-3">
                  <p className="text-[9px] leading-4 text-amber-100">
                    The current unsaved draft remains in semantic undo history, but this template starts a new persisted flow identity.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button type="button" size="sm" onClick={() => forkTemplate(template.id)} className="h-7 bg-violet-500 px-2 text-[9px] text-white hover:bg-violet-400">Confirm fork</Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setPendingTemplateId(null)} className="h-7 px-2 text-[9px] text-slate-400">Cancel</Button>
                  </div>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => hasUnsavedChanges ? setPendingTemplateId(template.id) : forkTemplate(template.id)}
                  className="mt-3 h-8 w-full border-violet-400/25 bg-violet-400/5 text-[10px] text-violet-200 hover:bg-violet-400/10"
                >
                  <GitFork className="h-3.5 w-3.5" />Fork editable flow
                </Button>
              )}
            </article>
          );
        })}
        {visibleTemplates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-800 p-5 text-center text-[10px] text-slate-600">No built-in template matches this search.</div>
        ) : null}
      </div>
    </aside>
  );
};
