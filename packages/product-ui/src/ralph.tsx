import type { ProductRalph, ProductShell } from "@machdoch/fleet-protocol";
import { CirclePlay, RotateCcw, Square, Workflow, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { ComposerModelPicker } from "./composer-model-picker";
import { formatTimestamp } from "./format";
import type { ProductCommandHandler } from "./product-runtime";
import {
  createDefaultRalphVariableValues,
  getRalphVariableValue,
  maximumRalphParameterValueLength,
  validateRalphFlowVariableValue,
  validateRalphFlowVariableValues,
} from "./ralph-variable-values";

type ProductComposer = NonNullable<ProductShell["composer"]>;
type RalphFlow = ProductRalph["flows"][number];
type RalphRun = ProductRalph["runs"][number];
type RalphVariable = RalphFlow["variables"][number];

const getFlowKey = (flow: Pick<RalphFlow, "id" | "scope">): string =>
  `${flow.scope}:${flow.id}`;

const getInputType = (type: RalphVariable["type"]): string => {
  if (type === "number") return "number";
  if (type === "url") return "url";
  return "text";
};

const getCountLabel = (count: number, singular: string): string =>
  `${count} ${singular}${count === 1 ? "" : "s"}`;

export function Ralph({
  ralph,
  composer,
  pending,
  onCommand,
}: {
  ralph: ProductRalph;
  composer?: ProductComposer;
  pending: boolean;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [view, setView] = useState<"flows" | "runs">("flows");
  const [provider, setProvider] = useState(composer?.provider ?? "");
  const [model, setModel] = useState(composer?.model ?? "");
  const [reasoning, setReasoning] = useState<ProductComposer["reasoning"]>(
    composer?.reasoning ?? "default",
  );
  const [selectedFlowKey, setSelectedFlowKey] = useState<string | null>(null);
  const [parameters, setParameters] = useState<Record<string, string>>({});
  const [validationErrors, setValidationErrors] = useState<
    Record<string, string>
  >({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const parameterErrorPrefix = useId();
  const selectedFlow =
    ralph.flows.find((flow) => getFlowKey(flow) === selectedFlowKey) ?? null;
  const selectedProvider = composer?.modelCatalog.find(
    (entry) => entry.provider === provider,
  );
  const selectedModel = selectedProvider?.models.find(
    (entry) => entry.id === model,
  );
  const reasoningOptions = selectedModel?.reasoningOptions ?? ["default"];
  const effectiveReasoning = reasoningOptions.includes(reasoning)
    ? reasoning
    : "default";
  const activeFlowKeys = useMemo(
    () =>
      new Set(
        ralph.runs
          .filter((run) => run.status === "running")
          .map((run) => `${run.scope}:${run.flowId}`),
      ),
    [ralph.runs],
  );

  useEffect(() => {
    if (!composer) return;
    setProvider(composer.provider);
    setModel(composer.model);
    setReasoning(composer.reasoning);
  }, [composer?.model, composer?.provider, composer?.reasoning]);

  const runtimeAvailable = Boolean(
    composer &&
    ralph.workspaceRoot &&
    selectedProvider?.available &&
    selectedModel,
  );
  const flowIsActive = (flow: RalphFlow): boolean =>
    activeFlowKeys.has(getFlowKey(flow));
  const closeRunDialog = (): void => {
    setSelectedFlowKey(null);
    setValidationErrors({});
  };
  const updateParameter = (variable: RalphVariable, value: string): void => {
    setParameters((current) => ({ ...current, [variable.name]: value }));
    setValidationErrors((current) => {
      if (!Object.hasOwn(current, variable.name)) return current;
      const next = { ...current };
      const error = validateRalphFlowVariableValue(variable, value, {
        maximumValueLength: maximumRalphParameterValueLength,
      });
      if (error) next[variable.name] = error;
      else delete next[variable.name];
      return next;
    });
  };
  const executeFlow = async (
    flow: RalphFlow,
    values: Record<string, string>,
  ): Promise<void> => {
    if (
      !composer ||
      !ralph.workspaceRoot ||
      !runtimeAvailable ||
      flowIsActive(flow)
    ) {
      return;
    }

    const errors = validateRalphFlowVariableValues(flow.variables, values, {
      maximumValueLength: maximumRalphParameterValueLength,
    });
    setValidationErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setActionError(null);
    try {
      const commandParameters = Object.fromEntries(
        Object.entries(values).filter(([, value]) => value.length > 0),
      );
      const accepted = await onCommand({
        kind: "ralph-run",
        workspace: ralph.workspaceRoot,
        scope: flow.scope,
        flowId: flow.id,
        parameters: commandParameters,
        provider,
        model,
        reasoning: effectiveReasoning,
        ...(flow.maxTransitions ? { maxTransitions: flow.maxTransitions } : {}),
      });
      if (accepted) {
        closeRunDialog();
        setView("runs");
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };
  const startFlow = (flow: RalphFlow): void => {
    if (!runtimeAvailable || flowIsActive(flow)) return;

    const initialParameters = createDefaultRalphVariableValues(flow.variables);
    setParameters(initialParameters);
    setValidationErrors({});
    setActionError(null);
    if (flow.variables.length === 0) {
      void executeFlow(flow, initialParameters);
      return;
    }
    setSelectedFlowKey(getFlowKey(flow));
  };
  const resumeRun = async (run: RalphRun): Promise<void> => {
    if (!ralph.workspaceRoot || !runtimeAvailable) return;

    setSubmitting(true);
    setActionError(null);
    try {
      await onCommand({
        kind: "ralph-resume-run",
        workspace: ralph.workspaceRoot,
        scope: run.scope,
        runId: run.id,
        provider,
        model,
        reasoning: effectiveReasoning,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="m-ralph">
      <header className="m-feature-header m-ralph-header">
        <div>
          <Workflow aria-hidden="true" />
          <h1>RALPH</h1>
        </div>
        <div className="m-ralph-runtime">
          {composer ? (
            <>
              <ComposerModelPicker
                label="RALPH run model"
                placement="bottom"
                providers={composer.modelCatalog.map((entry) => ({
                  id: entry.provider,
                  label: entry.label,
                  available: entry.available,
                  ...(entry.error ? { error: entry.error } : {}),
                  models: entry.models,
                }))}
                activeProvider={provider}
                activeProviderLabel={selectedProvider?.label ?? provider}
                activeModel={model}
                activeModelLabel={selectedModel?.label ?? model}
                loading={composer.modelCatalogLoading}
                onSelect={(nextProvider, nextModel) => {
                  const nextReasoningOptions = composer.modelCatalog
                    .find((entry) => entry.provider === nextProvider)
                    ?.models.find(
                      (entry) => entry.id === nextModel,
                    )?.reasoningOptions;
                  setProvider(nextProvider);
                  setModel(nextModel);
                  if (!nextReasoningOptions?.includes(reasoning)) {
                    setReasoning("default");
                  }
                }}
              />
              <label className="m-ralph-reasoning">
                <span className="m-product-visually-hidden">Reasoning</span>
                <select
                  aria-label="RALPH reasoning"
                  value={effectiveReasoning}
                  onChange={(event) =>
                    setReasoning(
                      event.target.value as ProductComposer["reasoning"],
                    )
                  }
                >
                  {reasoningOptions.map((option) => (
                    <option key={option} value={option}>
                      {option === "default" ? "Default" : option}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          <div className="m-feature-tabs">
            <button
              type="button"
              data-active={view === "flows"}
              onClick={() => setView("flows")}
            >
              Flows
            </button>
            <button
              type="button"
              data-active={view === "runs"}
              onClick={() => setView("runs")}
            >
              Runs
            </button>
          </div>
        </div>
      </header>
      {ralph.error || actionError ? (
        <div className="m-media-error" role="alert">
          {ralph.error ?? actionError}
        </div>
      ) : null}
      <div className="m-ralph-body">
        {view === "flows" ? (
          ralph.flows.length ? (
            <div className="m-ralph-grid">
              {ralph.flows.map((flow) => (
                <article key={getFlowKey(flow)} className="m-ralph-card">
                  <header>
                    <strong>{flow.name}</strong>
                    <span>{flow.scope}</span>
                  </header>
                  {flow.description ? <p>{flow.description}</p> : null}
                  <footer>
                    <span>
                      {getCountLabel(flow.blockCount, "block")} ·{" "}
                      {getCountLabel(flow.edgeCount, "edge")}
                    </span>
                    <button
                      type="button"
                      aria-label={`Run ${flow.name}`}
                      disabled={
                        pending ||
                        submitting ||
                        !runtimeAvailable ||
                        ralph.loading ||
                        flowIsActive(flow)
                      }
                      onClick={() => startFlow(flow)}
                    >
                      <CirclePlay aria-hidden="true" /> Run
                    </button>
                  </footer>
                </article>
              ))}
            </div>
          ) : (
            <div className="m-product-empty-small">No flows</div>
          )
        ) : ralph.runs.length ? (
          <div className="m-ralph-run-list">
            {ralph.runs.map((run) => (
              <article key={`${run.scope}:${run.id}`} className="m-ralph-run">
                <header>
                  <strong>{run.flowName}</strong>
                  <span data-state={run.status}>{run.status}</span>
                </header>
                {run.summary ? <p>{run.summary}</p> : null}
                <footer>
                  <span>
                    {run.scope} · {formatTimestamp(run.createdAt)}
                  </span>
                  {run.cancellable && run.taskId ? (
                    <button
                      type="button"
                      aria-label={`Cancel ${run.flowName}`}
                      disabled={pending || submitting}
                      onClick={() =>
                        void onCommand({ kind: "cancel", taskId: run.taskId! })
                      }
                    >
                      <Square aria-hidden="true" /> Cancel
                    </button>
                  ) : run.recoverable && composer && ralph.workspaceRoot ? (
                    <button
                      type="button"
                      disabled={pending || submitting || !runtimeAvailable}
                      onClick={() => void resumeRun(run)}
                    >
                      <RotateCcw aria-hidden="true" /> Resume
                    </button>
                  ) : null}
                </footer>
              </article>
            ))}
          </div>
        ) : (
          <div className="m-product-empty-small">No runs</div>
        )}
      </div>
      {selectedFlow ? (
        <div className="m-media-modal-backdrop" role="presentation">
          <div
            className="m-media-modal m-ralph-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="m-ralph-run-title"
          >
            <button
              type="button"
              className="m-media-modal-close"
              aria-label="Close"
              disabled={submitting}
              onClick={closeRunDialog}
            >
              <X aria-hidden="true" />
            </button>
            <h2 id="m-ralph-run-title">Run {selectedFlow.name}</h2>
            <div className="m-ralph-parameters">
              {selectedFlow.variables.map((variable, index) => {
                const error = Object.hasOwn(validationErrors, variable.name)
                  ? validationErrors[variable.name]
                  : undefined;
                const errorId = error
                  ? `${parameterErrorPrefix}-${index}`
                  : undefined;
                const controlProps = {
                  value: getRalphVariableValue(variable, parameters),
                  required: variable.required,
                  "aria-label": variable.name,
                  "aria-invalid": Boolean(error),
                  "aria-describedby": errorId,
                  onChange: (
                    event: React.ChangeEvent<
                      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
                    >,
                  ) => updateParameter(variable, event.target.value),
                };

                return (
                  <label key={variable.name}>
                    <span>{variable.name}</span>
                    {variable.type === "boolean" ? (
                      <select {...controlProps}>
                        <option value="" />
                        <option value="true">True</option>
                        <option value="false">False</option>
                      </select>
                    ) : variable.type === "text" ? (
                      <textarea {...controlProps} />
                    ) : (
                      <input
                        {...controlProps}
                        type={getInputType(variable.type)}
                      />
                    )}
                    {error ? (
                      <span
                        id={errorId}
                        className="m-ralph-validation"
                        role="alert"
                      >
                        {error}
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
            <div>
              <button
                type="button"
                className="m-product-secondary-button"
                disabled={submitting}
                onClick={closeRunDialog}
              >
                Cancel
              </button>
              <button
                type="button"
                className="m-product-primary-button"
                disabled={
                  pending ||
                  submitting ||
                  !runtimeAvailable ||
                  ralph.loading ||
                  flowIsActive(selectedFlow)
                }
                onClick={() => void executeFlow(selectedFlow, parameters)}
              >
                <CirclePlay aria-hidden="true" /> Run
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
