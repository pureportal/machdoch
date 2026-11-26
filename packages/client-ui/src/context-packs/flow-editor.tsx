import {
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  ChevronDown,
  ChevronUp,
  Folder,
  Globe2,
  GripVertical,
  Plus,
  Save,
  X,
} from "lucide-react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { Input } from "@machdoch/media-studio/tauri/ui/components/ui/input.js";
import { SearchField } from "@machdoch/media-studio/tauri/ui/components/ui/search-field.js";
import {
  SUBMIT_SHORTCUT_ACTION_PROPS,
  SubmitShortcut,
} from "@machdoch/media-studio/tauri/ui/components/ui/submit-shortcut.js";
import {
  MAX_CONTEXT_PACK_FLOW_STEPS,
  collectContextPackFlowPlaceholders,
  getContextPackFlowIssue,
  getContextPackFlowPackOptions,
  getContextPackFlowStepDropIndex,
  getContextPackFlowStepIssueLabel,
  moveContextPackFlowStep,
  resolveContextPackFlowSteps,
} from "./flows";
import {
  getSmartContextPackScope,
  getSmartContextPackScopeLabel,
} from "./helpers";
import type {
  ContextPackFlow,
  ContextPackFlowStep,
  SaveContextPackFlowInput,
  SmartContextPack,
  SmartContextPackScope,
} from "./model";
import "./editor.css";
import "./flow-editor.css";

const AUTO_SCROLL_EDGE_PX = 32;
const AUTO_SCROLL_STEP_PX = 12;

interface StepDragState {
  index: number;
  dropSlot: number | null;
}

const getStepDropSlot = (list: HTMLElement, clientY: number): number =>
  [...list.querySelectorAll<HTMLElement>("[data-flow-step]")].filter((item) => {
    const rect = item.getBoundingClientRect();
    return (rect.top + rect.bottom) / 2 < clientY;
  }).length;

const scrollListNearEdge = (list: HTMLElement, clientY: number): void => {
  const { top, bottom } = list.getBoundingClientRect();

  if (clientY < top + AUTO_SCROLL_EDGE_PX) {
    list.scrollBy({ top: -AUTO_SCROLL_STEP_PX });
  } else if (clientY > bottom - AUTO_SCROLL_EDGE_PX) {
    list.scrollBy({ top: AUTO_SCROLL_STEP_PX });
  }
};

const matchesPackSearch = (pack: SmartContextPack, query: string): boolean => {
  const terms = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const haystack = `${pack.name} ${pack.prompt}`.toLowerCase();

  return terms.every((term) => haystack.includes(term));
};

export function ContextPackFlowEditorDialog({
  flow,
  initialScope,
  contextPacks,
  workspaceRoot,
  onOpenChange,
  onSubmit,
}: {
  flow: ContextPackFlow | null;
  initialScope: SmartContextPackScope;
  contextPacks: SmartContextPack[];
  workspaceRoot: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (input: SaveContextPackFlowInput) => void | Promise<void>;
}): JSX.Element {
  const nameId = useId();
  const stepsLabelId = useId();
  const [name, setName] = useState(flow?.name ?? "");
  const [scope, setScope] = useState<SmartContextPackScope>(
    workspaceRoot
      ? flow
        ? getSmartContextPackScope(flow)
        : initialScope
      : "global",
  );
  const [steps, setSteps] = useState<ContextPackFlowStep[]>(flow?.steps ?? []);
  const [packSearch, setPackSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [drag, setDrag] = useState<StepDragState | null>(null);
  const dragRef = useRef<StepDragState | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const workspace = scope === "global" ? null : workspaceRoot;
  const resolvedSteps = useMemo(
    () => resolveContextPackFlowSteps({ steps, workspace }, contextPacks),
    [contextPacks, steps, workspace],
  );
  const packOptions = useMemo(
    () => getContextPackFlowPackOptions(contextPacks, scope, workspaceRoot),
    [contextPacks, scope, workspaceRoot],
  );
  const visiblePackOptions = useMemo(
    () => packOptions.filter((pack) => matchesPackSearch(pack, packSearch)),
    [packOptions, packSearch],
  );
  const variableNames = useMemo(
    () =>
      collectContextPackFlowPlaceholders(
        resolvedSteps.flatMap((entry) => (entry.pack ? [entry.pack] : [])),
        {},
      ).map((placeholder) => placeholder.key),
    [resolvedSteps],
  );
  const issue = getContextPackFlowIssue(resolvedSteps);
  const atStepLimit = steps.length >= MAX_CONTEXT_PACK_FLOW_STEPS;
  const canSave = Boolean(name.trim()) && issue === null && !saving;
  const hint = issue ?? (name.trim() ? null : "Add a name");
  const visibleDropSlot =
    drag?.dropSlot !== null &&
    drag !== null &&
    getContextPackFlowStepDropIndex(drag.index, drag.dropSlot, steps.length) !==
      null
      ? drag.dropSlot
      : null;

  const updateDrag = (next: StepDragState | null): void => {
    dragRef.current = next;
    setDrag(next);
  };

  const addStep = (pack: SmartContextPack): void => {
    if (atStepLimit) {
      return;
    }

    setSaveError(null);
    setSteps((current) => [
      ...current,
      { id: crypto.randomUUID(), packId: pack.id },
    ]);
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    });
  };

  const moveStep = (fromIndex: number, toIndex: number): void => {
    setSteps((current) => moveContextPackFlowStep(current, fromIndex, toIndex));
  };

  const removeStep = (stepId: string): void => {
    setSaveError(null);
    setSteps((current) => current.filter((step) => step.id !== stepId));
  };

  const handleDragStart = (
    event: PointerEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.button !== 0 || steps.length < 2) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateDrag({ index, dropSlot: null });
  };

  const handleDragMove = (event: PointerEvent<HTMLButtonElement>): void => {
    const current = dragRef.current;
    const list = listRef.current;

    if (!current || !list) {
      return;
    }

    scrollListNearEdge(list, event.clientY);
    const dropSlot = getStepDropSlot(list, event.clientY);

    if (dropSlot !== current.dropSlot) {
      updateDrag({ ...current, dropSlot });
    }
  };

  const handleDragEnd = (): void => {
    const current = dragRef.current;

    if (!current) {
      return;
    }

    updateDrag(null);
    const targetIndex =
      current.dropSlot === null
        ? null
        : getContextPackFlowStepDropIndex(
            current.index,
            current.dropSlot,
            steps.length,
          );

    if (targetIndex !== null) {
      moveStep(current.index, targetIndex);
    }
  };

  const handleStepKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }

    event.preventDefault();
    moveStep(index, event.key === "ArrowUp" ? index - 1 : index + 1);
  };

  const handlePackSearchKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
  ): void => {
    const firstPack = visiblePackOptions[0];

    if (event.key !== "Enter" || !packSearch.trim() || !firstPack) {
      return;
    }

    event.preventDefault();
    addStep(firstPack);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();

    if (!canSave) {
      return;
    }

    setSaving(true);
    setSaveError(null);

    try {
      await onSubmit({
        ...(flow ? { id: flow.id } : {}),
        name: name.trim(),
        scope,
        steps: steps.map((step) => ({ id: step.id, packId: step.packId })),
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="app-context-pack-dialog app-pack-flow-dialog"
      >
        <DialogHeader className="app-pack-header">
          <DialogTitle>{flow ? "Edit flow" : "Create flow"}</DialogTitle>
        </DialogHeader>
        <SubmitShortcut asChild>
          <form
            onSubmit={(event) => void submit(event)}
            className="app-pack-form"
          >
            <div className="app-pack-flow-body">
              <div className="app-pack-identity app-pack-flow-identity">
                <div className="app-pack-field">
                  <label htmlFor={nameId}>Name</label>
                  <Input
                    id={nameId}
                    autoFocus
                    required
                    maxLength={240}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="app-pack-control"
                  />
                </div>
                <fieldset className="app-pack-scope">
                  <legend className="app-pack-scope-label">Scope</legend>
                  <div className="app-pack-scope-options">
                    {(["workspace", "global"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        disabled={option === "workspace" && !workspaceRoot}
                        title={
                          option === "workspace" && !workspaceRoot
                            ? "Open a workspace to use this scope"
                            : undefined
                        }
                        aria-pressed={scope === option}
                        onClick={() => setScope(option)}
                        className="app-pack-scope-option"
                      >
                        {getSmartContextPackScopeLabel(option)}
                      </button>
                    ))}
                  </div>
                </fieldset>
              </div>
              <section
                className="app-pack-flow-steps"
                aria-labelledby={stepsLabelId}
              >
                <div className="app-pack-flow-section-heading">
                  <h3 id={stepsLabelId}>Steps</h3>
                  <span className="app-pack-flow-count">
                    {steps.length}/{MAX_CONTEXT_PACK_FLOW_STEPS}
                  </span>
                </div>
                {steps.length === 0 ? (
                  <p className="app-pack-flow-empty">No steps yet</p>
                ) : (
                  <ol ref={listRef} className="app-pack-flow-step-list">
                    {resolvedSteps.map(
                      ({ step, pack, issue: stepIssue }, index) => {
                        const label = pack?.name ?? "Unavailable pack";

                        return (
                          <li
                            key={step.id}
                            data-flow-step
                            data-issue={stepIssue ? "true" : undefined}
                            data-dragging={
                              drag?.index === index ? "true" : undefined
                            }
                            className="app-pack-flow-step"
                          >
                            {visibleDropSlot === index ? (
                              <span
                                aria-hidden="true"
                                className="app-pack-flow-drop-line"
                              />
                            ) : null}
                            {visibleDropSlot === steps.length &&
                            index === steps.length - 1 ? (
                              <span
                                aria-hidden="true"
                                className="app-pack-flow-drop-line app-pack-flow-drop-line-after"
                              />
                            ) : null}
                            <button
                              type="button"
                              aria-label={`Move step ${index + 1}: ${label}`}
                              title="Drag to reorder"
                              disabled={steps.length < 2}
                              onPointerDown={(event) =>
                                handleDragStart(event, index)
                              }
                              onPointerMove={handleDragMove}
                              onPointerUp={handleDragEnd}
                              onPointerCancel={() => updateDrag(null)}
                              onLostPointerCapture={handleDragEnd}
                              onKeyDown={(event) =>
                                handleStepKeyDown(event, index)
                              }
                              className="app-pack-flow-grip"
                            >
                              <GripVertical size={14} />
                            </button>
                            <span className="app-pack-flow-step-index">
                              {index + 1}
                            </span>
                            <span className="app-pack-flow-step-main">
                              <span className="app-pack-flow-step-name">
                                {label}
                              </span>
                              {stepIssue ? (
                                <span className="app-pack-flow-step-issue">
                                  {getContextPackFlowStepIssueLabel(stepIssue)}
                                </span>
                              ) : null}
                            </span>
                            <span className="app-pack-flow-step-actions">
                              <button
                                type="button"
                                aria-label={`Move ${label} up`}
                                title="Move up"
                                disabled={index === 0}
                                onClick={() => moveStep(index, index - 1)}
                                className="app-pack-flow-icon-button"
                              >
                                <ChevronUp size={14} />
                              </button>
                              <button
                                type="button"
                                aria-label={`Move ${label} down`}
                                title="Move down"
                                disabled={index === steps.length - 1}
                                onClick={() => moveStep(index, index + 1)}
                                className="app-pack-flow-icon-button"
                              >
                                <ChevronDown size={14} />
                              </button>
                              <button
                                type="button"
                                aria-label={`Remove ${label}`}
                                title="Remove"
                                onClick={() => removeStep(step.id)}
                                className="app-pack-flow-icon-button app-pack-flow-remove"
                              >
                                <X size={14} />
                              </button>
                            </span>
                          </li>
                        );
                      },
                    )}
                  </ol>
                )}
                {variableNames.length > 0 ? (
                  <div className="app-pack-flow-variables">
                    <span>Variables</span>
                    <ul>
                      {variableNames.map((variableName) => (
                        <li key={variableName}>{variableName}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
              <section className="app-pack-flow-library" aria-label="Packs">
                <SearchField
                  value={packSearch}
                  onChange={(event) => setPackSearch(event.target.value)}
                  onKeyDown={handlePackSearchKeyDown}
                  aria-label="Search packs"
                  placeholder="Search packs"
                  autoComplete="off"
                  spellCheck={false}
                  className="app-pack-control"
                />
                <ul className="app-pack-flow-pack-list">
                  {visiblePackOptions.map((pack) => {
                    const packScope = getSmartContextPackScope(pack);

                    return (
                      <li key={pack.id}>
                        <button
                          type="button"
                          disabled={atStepLimit}
                          onClick={() => addStep(pack)}
                          aria-label={`Add ${pack.name}`}
                          className="app-pack-flow-pack"
                        >
                          <Plus size={14} aria-hidden="true" />
                          <span className="app-pack-flow-pack-name">
                            {pack.name}
                          </span>
                          {packScope === "global" ? (
                            <Globe2
                              size={13}
                              aria-label="Global"
                              className="app-pack-flow-pack-scope-global"
                            />
                          ) : (
                            <Folder size={13} aria-label="Workspace" />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {visiblePackOptions.length === 0 ? (
                  <p className="app-pack-flow-empty">
                    {packOptions.length === 0
                      ? "No packs"
                      : "No matching packs"}
                  </p>
                ) : null}
              </section>
            </div>
            <DialogFooter className="app-pack-footer">
              {saveError ? (
                <p role="alert" className="app-pack-error">
                  {saveError}
                </p>
              ) : hint ? (
                <p className="app-pack-hint">{hint}</p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                className="app-pack-cancel"
                disabled={saving}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="app-pack-save"
                disabled={!canSave}
                {...SUBMIT_SHORTCUT_ACTION_PROPS}
              >
                <Save className="h-4 w-4" />
                {saving ? "Saving..." : "Save flow"}
              </Button>
            </DialogFooter>
          </form>
        </SubmitShortcut>
      </DialogContent>
    </Dialog>
  );
}
