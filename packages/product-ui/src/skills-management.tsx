import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import "./skills-management.css";

export interface ManagedSkill {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  fingerprint: string;
  path: string;
}

export interface SaveManagedSkillInput {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  expectedFingerprint?: string;
}

export interface SkillsManagementProps {
  onDirtyChange?: (dirty: boolean) => void;
  listSkills: () => Promise<ManagedSkill[]>;
  saveSkill: (input: SaveManagedSkillInput) => Promise<ManagedSkill>;
  deleteSkill: (name: string, fingerprint: string) => Promise<unknown>;
}

type SkillDraft = Omit<SaveManagedSkillInput, "expectedFingerprint">;

interface SkillEditor {
  original: ManagedSkill | null;
  draft: SkillDraft;
}

type SkillAction =
  | { type: "select"; skill: ManagedSkill | null }
  | { type: "reload" }
  | { type: "delete"; skill: ManagedSkill };

const emptySkill: SkillDraft = {
  name: "",
  description: "",
  content: "",
  enabled: true,
};

const fieldStyle: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: "1px solid color-mix(in srgb, currentColor 25%, transparent)",
  borderRadius: 8,
  padding: "8px 10px",
  background: "transparent",
  color: "inherit",
};

const editSkill = (skill: ManagedSkill | null): SkillEditor => ({
  original: skill,
  draft: skill
    ? {
        name: skill.name,
        description: skill.description,
        content: skill.content,
        enabled: skill.enabled,
      }
    : { ...emptySkill },
});

const errorMessage = (error: unknown, recovery: string): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return recovery;
};

function SkillConfirmation({
  action,
  onConfirm,
  onCancel,
}: {
  action: SkillAction;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement;
    dialog.showModal();
    cancelRef.current?.focus();

    return () => {
      dialog.close();
      if (
        previouslyFocused instanceof HTMLElement &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="m-memory-dialog-overlay"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <section className="m-memory-dialog">
        <header className="m-memory-dialog-header">
          <h2 id={titleId}>
            {action.type === "delete"
              ? `Delete “${action.skill.name}”?`
              : "Discard changes?"}
          </h2>
        </header>
        <div className="m-memory-dialog-actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm}>
            {action.type === "delete" ? "Delete" : "Discard"}
          </button>
        </div>
      </section>
    </dialog>
  );
}

export function SkillsManagement({
  onDirtyChange,
  listSkills,
  saveSkill,
  deleteSkill,
}: SkillsManagementProps): React.ReactElement {
  const id = useId();
  const [skills, setSkills] = useState<ManagedSkill[]>([]);
  const [editor, setEditor] = useState<SkillEditor | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"save" | "delete" | null>(null);
  const [confirmation, setConfirmation] = useState<SkillAction | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const preferredName = useRef<string | undefined>(undefined);
  const mutationInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    const load = async (): Promise<void> => {
      try {
        const next = [...(await listSkills())].sort((left, right) =>
          left.name.localeCompare(right.name),
        );
        if (cancelled) return;
        setSkills(next);
        setEditor(
          (current) =>
            current ??
            editSkill(
              next.find((skill) => skill.name === preferredName.current) ??
                next[0] ??
                null,
            ),
        );
      } catch (cause) {
        if (!cancelled) {
          setLoadError(
            errorMessage(cause, "Could not load skills. Try reloading."),
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [listSkills, reloadVersion]);

  const baseline = editor?.original ?? emptySkill;
  const dirty =
    editor !== null &&
    (editor.draft.name !== baseline.name ||
      editor.draft.description !== baseline.description ||
      editor.draft.content !== baseline.content ||
      editor.draft.enabled !== baseline.enabled);
  const busy = loading || pending !== null;
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const disabled = busy || loadError !== null;
  const search = query.trim().toLocaleLowerCase();
  const filteredSkills = skills.filter((skill) =>
    [skill.name, skill.description, skill.content].some((value) =>
      value.toLocaleLowerCase().includes(search),
    ),
  );

  const save = async (): Promise<void> => {
    if (
      !editor ||
      !dirty ||
      disabled ||
      confirmation ||
      mutationInFlight.current
    )
      return;
    mutationInFlight.current = true;
    setPending("save");
    setError(null);
    try {
      const saved = await saveSkill({
        ...editor.draft,
        ...(editor.original
          ? { expectedFingerprint: editor.original.fingerprint }
          : {}),
      });
      setSkills((current) =>
        [...current.filter((skill) => skill.name !== saved.name), saved].sort(
          (left, right) => left.name.localeCompare(right.name),
        ),
      );
      setEditor(editSkill(saved));
      setQuery("");
    } catch (cause) {
      setError(errorMessage(cause, "Could not save the skill. Try again."));
    } finally {
      mutationInFlight.current = false;
      setPending(null);
    }
  };

  const remove = async (skill: ManagedSkill): Promise<void> => {
    if (mutationInFlight.current) return;
    mutationInFlight.current = true;
    setPending("delete");
    setError(null);
    try {
      await deleteSkill(skill.name, skill.fingerprint);
      const remaining = skills.filter((entry) => entry.name !== skill.name);
      setSkills(remaining);
      setEditor(editSkill(remaining[0] ?? null));
    } catch (cause) {
      setError(errorMessage(cause, "Could not delete the skill. Try again."));
    } finally {
      mutationInFlight.current = false;
      setPending(null);
    }
  };

  const runAction = (action: SkillAction): void => {
    setError(null);
    if (action.type === "select") {
      setEditor(editSkill(action.skill));
      if (!action.skill) setQuery("");
    } else if (action.type === "reload") {
      preferredName.current = editor?.original?.name;
      setEditor(null);
      setReloadVersion((version) => version + 1);
    } else {
      void remove(action.skill);
    }
  };

  const requestAction = (action: SkillAction): void => {
    if (busy || confirmation || mutationInFlight.current) return;
    if (
      action.type === "select" &&
      action.skill !== null &&
      action.skill.name === editor?.original?.name
    )
      return;
    if (action.type === "delete" || dirty) {
      setConfirmation(action);
    } else {
      runAction(action);
    }
  };

  const updateDraft = (value: Partial<SkillDraft>): void => {
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, ...value } } : current,
    );
  };

  return (
    <section className="m-skills-library" aria-labelledby={id + "-title"}>
      <header
        className="m-memory-dialog-header"
        style={{ flexWrap: "wrap", gap: 12 }}
      >
        <h2 id={id + "-title"}>Skills</h2>
        <div className="m-memory-dialog-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => requestAction({ type: "reload" })}
          >
            Reload
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => requestAction({ type: "select", skill: null })}
          >
            New skill
          </button>
        </div>
      </header>
      {loadError || error ? <p role="alert">{loadError ?? error}</p> : null}
      {loading ? <p role="status">Loading skills…</p> : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit, minmax(min(100%, 20rem), 1fr))",
          gap: 24,
          alignItems: "start",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <input
            type="search"
            aria-label="Search skills"
            placeholder="Search"
            value={query}
            disabled={disabled}
            onChange={(event) => setQuery(event.target.value)}
            style={{ ...fieldStyle, marginBottom: 12 }}
          />
          {!loading && !loadError && filteredSkills.length === 0 ? (
            <p className="m-memory-empty">
              {skills.length === 0 ? "No skills." : "No matching skills."}
            </p>
          ) : null}
          <ul
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: 8,
            }}
          >
            {filteredSkills.map((skill) => (
              <li key={skill.name}>
                <button
                  type="button"
                  aria-label={skill.name}
                  aria-pressed={editor?.original?.name === skill.name}
                  disabled={disabled}
                  onClick={() => requestAction({ type: "select", skill })}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    display: "grid",
                    gap: 4,
                    padding: 12,
                    border:
                      "1px solid color-mix(in srgb, currentColor 20%, transparent)",
                    borderRadius: 8,
                    background:
                      editor?.original?.name === skill.name
                        ? "color-mix(in srgb, currentColor 8%, transparent)"
                        : "transparent",
                    overflowWrap: "anywhere",
                    fontWeight:
                      editor?.original?.name === skill.name ? 600 : 400,
                  }}
                >
                  <span>{skill.name}</span>
                  <span style={{ fontWeight: 400 }}>{skill.description}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {editor ? (
          <form
            aria-label={editor.original ? "Edit skill" : "New skill"}
            aria-busy={pending !== null}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
            style={{ display: "grid", gap: 16, minWidth: 0 }}
          >
            <label style={{ display: "grid", gap: 6 }}>
              Name
              <input
                style={fieldStyle}
                value={editor.draft.name}
                disabled={disabled || editor.original !== null}
                required
                maxLength={64}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                onInvalid={(event) => {
                  if (event.currentTarget.validity.patternMismatch) {
                    event.currentTarget.setCustomValidity(
                      "Use lowercase letters, numbers, and single hyphens.",
                    );
                  }
                }}
                onChange={(event) => {
                  event.currentTarget.setCustomValidity("");
                  updateDraft({ name: event.target.value });
                }}
              />
            </label>
            <div style={{ display: "grid", gap: 6 }}>
              <label htmlFor={id + "-description"}>Description</label>
              <textarea
                id={id + "-description"}
                value={editor.draft.description}
                disabled={disabled}
                required
                maxLength={1024}
                rows={3}
                onChange={(event) =>
                  updateDraft({ description: event.target.value })
                }
                style={{ ...fieldStyle, resize: "vertical" }}
              />
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              <label htmlFor={id + "-content"}>Content</label>
              <textarea
                id={id + "-content"}
                value={editor.draft.content}
                disabled={disabled}
                required
                rows={12}
                onChange={(event) =>
                  updateDraft({ content: event.target.value })
                }
                style={{
                  ...fieldStyle,
                  resize: "vertical",
                  fontFamily: "monospace",
                }}
              />
            </div>
            <div className="m-memory-dialog-actions">
              <span id={id + "-enabled"}>Enabled</span>
              <button
                type="button"
                role="switch"
                aria-labelledby={id + "-enabled"}
                aria-checked={editor.draft.enabled}
                data-checked={editor.draft.enabled}
                className="m-memory-switch"
                disabled={disabled}
                onClick={() => updateDraft({ enabled: !editor.draft.enabled })}
              >
                <span />
              </button>
            </div>
            <div className="m-memory-dialog-actions">
              <button type="submit" disabled={disabled || !dirty}>
                {pending === "save" ? "Saving…" : "Save"}
              </button>
              {editor.original ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (editor.original) {
                      requestAction({ type: "delete", skill: editor.original });
                    }
                  }}
                >
                  {pending === "delete" ? "Deleting…" : "Delete"}
                </button>
              ) : null}
            </div>
          </form>
        ) : null}
      </div>
      {confirmation ? (
        <SkillConfirmation
          action={confirmation}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            setConfirmation(null);
            runAction(confirmation);
          }}
        />
      ) : null}
    </section>
  );
}
