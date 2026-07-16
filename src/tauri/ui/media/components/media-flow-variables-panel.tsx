import {
  BookmarkCheck,
  BookmarkPlus,
  Braces,
  Check,
  CircleAlert,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type JSX } from "react";
import type {
  MediaFlow,
  MediaFlowVariable,
  MediaFlowVariableValue,
} from "../../../../core/media/contracts.js";
import {
  addMediaFlowVariable,
  applyMediaFlowPreset,
  createMediaFlowPreset,
  getMediaFlowVariableValue,
  removeMediaFlowPreset,
  removeMediaFlowVariable,
  replaceMediaFlowVariable,
  resolveMediaFlowVariables,
  setMediaFlowVariableBinding,
  updateMediaFlowPreset,
} from "../../../../core/media/variables.js";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";

interface MediaFlowVariablesPanelProps {
  flow: MediaFlow;
  onChange: (flow: MediaFlow) => void;
  onClose: () => void;
}

const now = (): string => new Date().toISOString();

const VariableTextField = ({
  ariaLabel,
  value,
  onCommit,
  className,
}: {
  ariaLabel: string;
  value: string;
  onCommit: (value: string) => void;
  className?: string;
}): JSX.Element => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      aria-label={ariaLabel}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
};

const VariableValueField = ({
  variable,
  value,
  ariaLabel,
  onCommit,
}: {
  variable: MediaFlowVariable;
  value: MediaFlowVariableValue;
  ariaLabel: string;
  onCommit: (value: MediaFlowVariableValue) => void;
}): JSX.Element => {
  if (variable.type === "boolean") {
    return (
      <button
        type="button"
        role="switch"
        aria-label={ariaLabel}
        aria-checked={value === true}
        onClick={() => onCommit(value !== true)}
        className={cn(
          "relative h-7 w-12 rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/30",
          value === true
            ? "border-cyan-400/40 bg-cyan-400/25"
            : "border-slate-700 bg-slate-900",
        )}
      >
        <span
          className={cn(
            "absolute top-1 left-1 h-4 w-4 rounded-full bg-slate-200 transition-transform",
            value === true ? "translate-x-5" : "translate-x-0",
          )}
        />
      </button>
    );
  }
  if (variable.type === "choice") {
    return (
      <select
        aria-label={ariaLabel}
        value={String(value)}
        onChange={(event) => onCommit(event.target.value)}
        className="h-8 w-full rounded-md border border-slate-700 bg-slate-950 px-2 text-xs text-slate-200 outline-none focus:border-cyan-400/50"
      >
        {variable.constraints.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    );
  }
  if (variable.type === "number") {
    return (
      <VariableTextField
        ariaLabel={ariaLabel}
        value={String(value)}
        onCommit={(draft) => {
          const parsed = Number(draft);
          if (Number.isFinite(parsed)) onCommit(parsed);
        }}
        className="h-8 border-slate-700 bg-slate-950 text-xs text-slate-200"
      />
    );
  }
  return (
    <VariableTextField
      ariaLabel={ariaLabel}
      value={String(value)}
      onCommit={onCommit}
      className="h-8 border-slate-700 bg-slate-950 text-xs text-slate-200"
    />
  );
};

const fallbackValue = (variable: MediaFlowVariable): MediaFlowVariableValue => {
  switch (variable.type) {
    case "text": return "";
    case "number": return variable.constraints.min;
    case "boolean": return false;
    case "choice": return variable.constraints.options[0] ?? "";
  }
};

export const MediaFlowVariablesPanel = ({
  flow,
  onChange,
  onClose,
}: MediaFlowVariablesPanelProps): JSX.Element => {
  const [notice, setNotice] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const resolution = useMemo(() => resolveMediaFlowVariables(flow), [flow]);

  const commit = (operation: () => MediaFlow, success?: string): void => {
    try {
      onChange(operation());
      setNotice(success ?? null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The variable change could not be applied.");
    }
  };

  const replaceVariable = (variable: MediaFlowVariable): void => {
    commit(() => replaceMediaFlowVariable({ flow, variable, updatedAt: now() }));
  };

  const insertToken = (variable: MediaFlowVariable): void => {
    const prompt = flow.nodes.find((node) => node.type === "source.prompt");
    if (!prompt) {
      setNotice("Add a Creative brief node before inserting a variable token.");
      return;
    }
    const currentPrompt = typeof prompt.config.prompt === "string" ? prompt.config.prompt.trimEnd() : "";
    const token = `{{${variable.id}}}`;
    onChange({
      ...flow,
      updatedAt: now(),
      nodes: flow.nodes.map((node) => node.id === prompt.id ? {
        ...node,
        config: { ...node.config, prompt: currentPrompt ? `${currentPrompt} ${token}` : token },
      } : node),
    });
    setNotice(`Inserted ${token} into Creative brief.`);
  };

  return (
    <aside
      aria-label="Variables and presets"
      className="absolute inset-y-0 right-0 z-20 min-h-0 w-[min(390px,calc(100%-2rem))] overflow-y-auto border-l border-slate-800/80 bg-slate-950/95 p-5 shadow-2xl xl:static xl:w-auto xl:bg-slate-950/90 xl:shadow-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Braces className="h-4 w-4 text-cyan-300" />
            Variables & presets
          </div>
          <p className="mt-1 text-[10px] leading-4 text-slate-500">
            Reuse one semantic flow with typed, validated run inputs.
          </p>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close variables and presets" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      {notice ? (
        <div className="mt-4 flex gap-2 rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-2 text-[10px] leading-4 text-cyan-100" role="status" aria-live="polite">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{notice}
        </div>
      ) : null}

      <section className="mt-5" aria-labelledby="flow-variables-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="flow-variables-heading" className="text-[10px] font-bold tracking-[0.14em] text-slate-500 uppercase">
            Run variables · {flow.variables.length}
          </h2>
          <span className="text-[9px] text-slate-600">max 32</span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1" aria-label="Add typed variable">
          {(["text", "number", "boolean", "choice"] as const).map((type) => (
            <Button
              key={type}
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Add ${type} variable`}
              disabled={flow.variables.length >= 32}
              onClick={() => commit(
                () => addMediaFlowVariable({ flow, type, updatedAt: now() }).flow,
                `Added a ${type} variable.`,
              )}
              className="h-7 border-slate-700 bg-slate-900/50 px-1 text-[9px] capitalize text-slate-300 hover:bg-slate-800"
            >
              <Plus className="h-3 w-3" />{type}
            </Button>
          ))}
        </div>

        <div className="mt-3 space-y-3">
          {flow.variables.map((variable) => {
            const resolved = getMediaFlowVariableValue(flow, variable);
            const usageCount = flow.nodes.filter((node) => JSON.stringify(node.config).includes(`{{${variable.id}}}`)).length;
            const hasOverride = Object.hasOwn(flow.variableBindings, variable.id);
            return (
              <article key={variable.id} className="rounded-xl border border-slate-800 bg-slate-900/45 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <VariableTextField
                      ariaLabel={`Name for ${variable.id}`}
                      value={variable.name}
                      onCommit={(name) => replaceVariable({ ...variable, name: name.trim() })}
                      className="h-7 border-transparent bg-transparent px-1 text-xs font-semibold text-slate-100 hover:border-slate-700 focus:border-cyan-400/40"
                    />
                    <code className="mt-1 block select-all px-1 text-[9px] text-cyan-300">{`{{${variable.id}}}`}</code>
                  </div>
                  <Badge variant="outline" className="border-slate-700 text-[8px] capitalize text-slate-500">{variable.type}</Badge>
                </div>

                <div className="mt-3 grid grid-cols-[1fr_auto] items-end gap-2">
                  <label className="text-[9px] text-slate-500">
                    Current value <span className="text-slate-600">· {resolved.source}</span>
                    <span className="mt-1 block">
                      <VariableValueField
                        variable={variable}
                        value={resolved.value ?? fallbackValue(variable)}
                        ariaLabel={`Current value for ${variable.name}`}
                        onCommit={(value) => commit(() => setMediaFlowVariableBinding({ flow, variableId: variable.id, value, updatedAt: now() }))}
                      />
                    </span>
                  </label>
                  {hasOverride ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => commit(() => setMediaFlowVariableBinding({ flow, variableId: variable.id, value: null, updatedAt: now() }), "Using the declared default.")}
                      className="h-8 px-2 text-[9px] text-slate-500"
                    >Use default</Button>
                  ) : null}
                </div>

                <details className="mt-3 rounded-lg border border-slate-800/80 bg-slate-950/35 p-2">
                  <summary className="cursor-pointer text-[9px] font-medium text-slate-400">Definition & constraints</summary>
                  <div className="mt-3 space-y-3">
                    <label className="block text-[9px] text-slate-500">
                      Description
                      <VariableTextField
                        ariaLabel={`Description for ${variable.name}`}
                        value={variable.description}
                        onCommit={(description) => replaceVariable({ ...variable, description: description.trim() })}
                        className="mt-1 h-8 border-slate-700 bg-slate-950 text-xs text-slate-200"
                      />
                    </label>
                    <label className="flex items-center justify-between gap-3 text-[9px] text-slate-400">
                      Required before running
                      <input
                        type="checkbox"
                        aria-label={`${variable.name} is required`}
                        checked={variable.required}
                        onChange={(event) => replaceVariable({ ...variable, required: event.target.checked })}
                        className="h-3.5 w-3.5 accent-cyan-400"
                      />
                    </label>
                    <div className="text-[9px] text-slate-500">
                      <div className="flex items-center justify-between gap-2">
                        <span>Declared default</span>
                        <button
                          type="button"
                          onClick={() => replaceVariable({
                            ...variable,
                            defaultValue: variable.defaultValue === null ? fallbackValue(variable) : null,
                          } as MediaFlowVariable)}
                          className="text-[8px] text-cyan-400/70 hover:text-cyan-300"
                        >
                          {variable.defaultValue === null ? "Set default" : "Unset default"}
                        </button>
                      </div>
                      {variable.defaultValue === null ? (
                        <div className="mt-1 rounded-md border border-dashed border-slate-700 px-2 py-2 text-[9px] text-slate-600">No fallback value</div>
                      ) : (
                        <div className="mt-1">
                          <VariableValueField
                            variable={variable}
                            value={variable.defaultValue}
                            ariaLabel={`Default value for ${variable.name}`}
                            onCommit={(defaultValue) => replaceVariable({ ...variable, defaultValue } as MediaFlowVariable)}
                          />
                        </div>
                      )}
                    </div>
                    {variable.type === "text" ? (
                      <label className="block text-[9px] text-slate-500">
                        Maximum characters
                        <VariableTextField
                          ariaLabel={`Maximum characters for ${variable.name}`}
                          value={String(variable.constraints.maxLength)}
                          onCommit={(draft) => replaceVariable({ ...variable, constraints: { maxLength: Number(draft) } })}
                          className="mt-1 h-8 border-slate-700 bg-slate-950 text-xs text-slate-200"
                        />
                      </label>
                    ) : null}
                    {variable.type === "number" ? (
                      <div className="grid grid-cols-3 gap-2">
                        {(["min", "max", "step"] as const).map((constraint) => (
                          <label key={constraint} className="text-[9px] capitalize text-slate-500">
                            {constraint}
                            <VariableTextField
                              ariaLabel={`${constraint} for ${variable.name}`}
                              value={String(variable.constraints[constraint])}
                              onCommit={(draft) => replaceVariable({ ...variable, constraints: { ...variable.constraints, [constraint]: Number(draft) } })}
                              className="mt-1 h-8 border-slate-700 bg-slate-950 px-2 text-xs text-slate-200"
                            />
                          </label>
                        ))}
                      </div>
                    ) : null}
                    {variable.type === "choice" ? (
                      <label className="block text-[9px] text-slate-500">
                        Options · one per line
                        <Textarea
                          aria-label={`Options for ${variable.name}`}
                          defaultValue={variable.constraints.options.join("\n")}
                          onBlur={(event) => {
                            const options = event.target.value.split("\n").map((option) => option.trim()).filter(Boolean);
                            if (options.join("\n") !== variable.constraints.options.join("\n")) {
                              replaceVariable({
                                ...variable,
                                defaultValue: options.includes(variable.defaultValue ?? "") ? variable.defaultValue : (options[0] ?? ""),
                                constraints: { options },
                              });
                            }
                          }}
                          className="mt-1 min-h-16 border-slate-700 bg-slate-950 text-xs text-slate-200"
                        />
                      </label>
                    ) : null}
                  </div>
                </details>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <Button type="button" variant="outline" size="sm" onClick={() => insertToken(variable)} className="h-7 border-cyan-400/20 bg-cyan-400/5 px-2 text-[9px] text-cyan-200">
                    <Braces className="h-3 w-3" />Insert in brief
                  </Button>
                  <span className="mr-auto text-[9px] text-slate-600">used by {usageCount} node{usageCount === 1 ? "" : "s"}</span>
                  {pendingDeleteId === variable.id ? (
                    <>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setPendingDeleteId(null)} className="h-7 px-2 text-[9px] text-slate-500">Cancel</Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => {
                        commit(() => removeMediaFlowVariable({ flow, variableId: variable.id, updatedAt: now() }), `Removed ${variable.name}. Existing tokens now require review.`);
                        setPendingDeleteId(null);
                      }} className="h-7 px-2 text-[9px] text-rose-300">Confirm</Button>
                    </>
                  ) : (
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove ${variable.name}`} onClick={() => setPendingDeleteId(variable.id)} className="text-slate-600 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></Button>
                  )}
                </div>
              </article>
            );
          })}
          {flow.variables.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-800 p-4 text-center text-[10px] leading-4 text-slate-600">
              Add a typed variable, then insert its token into any text-capable node field.
            </div>
          ) : null}
        </div>
      </section>

      <section className="mt-6 border-t border-slate-800 pt-5" aria-labelledby="flow-presets-heading">
        <div className="flex items-center justify-between gap-3">
          <h2 id="flow-presets-heading" className="text-[10px] font-bold tracking-[0.14em] text-slate-500 uppercase">Binding presets · {flow.presets.length}</h2>
          <span className="text-[9px] text-slate-600">document-only names</span>
        </div>
        <form className="mt-2 flex gap-2" onSubmit={(event) => {
          event.preventDefault();
          try {
            const result = createMediaFlowPreset({ flow, name: presetName, updatedAt: now() });
            onChange(result.flow);
            setPresetName("");
            setNotice(`Saved preset ${presetName.trim()}.`);
          } catch (error) {
            setNotice(error instanceof Error ? error.message : "The preset could not be saved.");
          }
        }}>
          <Input aria-label="New preset name" value={presetName} onChange={(event) => setPresetName(event.target.value)} placeholder="e.g. Social portrait" className="h-8 border-slate-700 bg-slate-950 text-xs text-slate-200" />
          <Button type="submit" variant="outline" size="sm" disabled={!presetName.trim() || flow.variables.length === 0 || flow.presets.length >= 32} className="h-8 border-violet-400/20 bg-violet-400/5 px-2 text-[9px] text-violet-200">
            <BookmarkPlus className="h-3.5 w-3.5" />Save
          </Button>
        </form>
        <div className="mt-3 space-y-2">
          {flow.presets.map((preset) => {
            const active = flow.activePresetId === preset.id;
            return (
              <article key={preset.id} className={cn("rounded-lg border p-3", active ? "border-violet-400/30 bg-violet-400/5" : "border-slate-800 bg-slate-900/35")}>
                <div className="flex items-center gap-2">
                  {active ? <BookmarkCheck className="h-3.5 w-3.5 text-violet-300" /> : <Braces className="h-3.5 w-3.5 text-slate-600" />}
                  <div className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-200">{preset.name}</div>
                  {active ? <span className="text-[8px] font-semibold tracking-wide text-violet-300 uppercase">active</span> : null}
                </div>
                <div className="mt-2 flex items-center gap-1">
                  <Button type="button" variant="outline" size="sm" onClick={() => commit(() => applyMediaFlowPreset({ flow, presetId: preset.id, updatedAt: now() }), `Applied ${preset.name}.`)} className="h-7 border-slate-700 px-2 text-[9px] text-slate-300"><Check className="h-3 w-3" />Apply</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => commit(() => updateMediaFlowPreset({ flow, presetId: preset.id, updatedAt: now() }), `Updated ${preset.name} from current values.`)} className="h-7 px-2 text-[9px] text-slate-500">Update values</Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`Delete preset ${preset.name}`} onClick={() => commit(() => removeMediaFlowPreset({ flow, presetId: preset.id, updatedAt: now() }), `Deleted ${preset.name}.`)} className="ml-auto text-slate-600 hover:text-rose-300"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {resolution.issues.length > 0 ? (
        <section className="mt-5 rounded-xl border border-amber-400/20 bg-amber-400/5 p-3" aria-label="Variable validation issues">
          <div className="text-[10px] font-semibold text-amber-200">{resolution.issues.length} issue{resolution.issues.length === 1 ? "" : "s"} block preflight</div>
          <ul className="mt-2 space-y-1 text-[9px] leading-4 text-amber-100/70">
            {resolution.issues.slice(0, 4).map((issue, index) => <li key={`${issue.code}-${issue.variableId ?? "flow"}-${index}`}>{issue.message}</li>)}
          </ul>
        </section>
      ) : null}
    </aside>
  );
};
