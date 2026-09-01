import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

export interface MemoryManagementEntry {
  id: string;
  content: string;
  createdAt: number;
  sourceLabel?: string;
}

export interface MemoryManagementTableProps {
  entries: readonly MemoryManagementEntry[];
  emptyLabel?: string;
  disabled?: boolean;
  onForget: (id: string) => Promise<unknown> | unknown;
}

const memoryTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formatMemoryTimestamp = (timestamp: number): string =>
  memoryTimestampFormatter.format(new Date(timestamp));

export function MemoryManagementTable({
  entries,
  emptyLabel = "No saved memory.",
  disabled = false,
  onForget,
}: MemoryManagementTableProps): React.ReactElement {
  if (entries.length === 0) {
    return <p className="m-memory-empty">{emptyLabel}</p>;
  }

  const showSource = entries.some((entry) => entry.sourceLabel);

  return (
    <div className="m-memory-table-scroll">
      <table className="m-memory-table">
        <thead>
          <tr>
            <th>Memory</th>
            {showSource ? <th>Chat</th> : null}
            <th>Created</th>
            <th>
              <span className="m-visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const createdAt = formatMemoryTimestamp(entry.createdAt);

            return (
              <tr key={entry.id}>
                <td className="m-memory-content">{entry.content}</td>
                {showSource ? (
                  <td className="m-memory-source">
                    {entry.sourceLabel ?? <span aria-hidden="true">—</span>}
                  </td>
                ) : null}
                <td className="m-memory-created">
                  <time dateTime={new Date(entry.createdAt).toISOString()}>
                    {createdAt}
                  </time>
                </td>
                <td className="m-memory-action">
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => void onForget(entry.id)}
                  >
                    Forget
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export interface SessionMemoryDialogProps extends MemoryManagementTableProps {
  open: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => Promise<unknown> | unknown;
  onClose: () => void;
}

export function SessionMemoryDialog({
  open,
  enabled,
  entries,
  emptyLabel,
  disabled = false,
  onEnabledChange,
  onForget,
  onClose,
}: SessionMemoryDialogProps): React.ReactElement | null {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="m-memory-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="m-memory-dialog"
      >
        <header className="m-memory-dialog-header">
          <h2 id={titleId}>Session memory</h2>
          <div className="m-memory-dialog-actions">
            <span>Enabled</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label="Session memory"
              data-checked={enabled}
              disabled={disabled}
              className="m-memory-switch"
              onClick={() => void onEnabledChange(!enabled)}
            >
              <span />
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              aria-label="Close session memory"
              className="m-memory-dialog-close"
              onClick={onClose}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>
        <MemoryManagementTable
          entries={entries}
          {...(emptyLabel ? { emptyLabel } : {})}
          disabled={disabled}
          onForget={onForget}
        />
      </section>
    </div>
  );
}
