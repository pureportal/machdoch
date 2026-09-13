"use client";

import { useRef, useState } from "react";
import type { RunSnapshot } from "@machdoch/fleet-protocol";
import { ConfirmButton } from "@/components/confirm-button";
import { Button } from "@/components/ui/button";

export function RunConfiguration({
  snapshot,
  pending,
  blocked,
  servicesRunning,
  error,
  onSave,
  onReload,
  onEditingChange,
  onClearError,
}: {
  snapshot: RunSnapshot;
  pending: boolean;
  blocked: boolean;
  servicesRunning: boolean;
  error: string | null;
  onSave: (document: unknown, revision: string) => Promise<boolean>;
  onReload: () => Promise<RunSnapshot>;
  onEditingChange: (editing: boolean) => void;
  onClearError: () => void;
}): React.ReactElement {
  const [editor, setEditor] = useState<string | null>(null);
  const [revision, setRevision] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const reloaded = useRef(false);
  const changed = editor !== null && revision !== snapshot.revision;
  const visibleError = validationError ?? (changed ? null : error);
  const open = (nextSnapshot: RunSnapshot): void => {
    setEditor(JSON.stringify(nextSnapshot.document, null, 2));
    setRevision(nextSnapshot.revision);
    setValidationError(null);
    onClearError();
    onEditingChange(true);
  };
  const close = (): void => {
    setEditor(null);
    setValidationError(null);
    onClearError();
    onEditingChange(false);
  };

  return (
    <section className="min-w-0 rounded-xl border bg-card p-4 sm:p-5">
      <h2 className="font-medium">Run configuration</h2>
      {editor === null ? (
        <Button
          className="mt-2 min-h-11"
          variant="outline"
          disabled={blocked}
          onClick={() => open(snapshot)}
        >
          Edit run.json
        </Button>
      ) : (
        <form
          className="mt-2 grid gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (blocked || changed) return;
            setValidationError(null);
            let document: unknown;
            try {
              document = JSON.parse(editor);
            } catch {
              setValidationError("Enter valid JSON.");
              return;
            }
            void onSave(document, revision).then((saved) => {
              if (saved) close();
            });
          }}
        >
          <label className="grid gap-2 text-sm">
            run.json
            <textarea
              ref={editorRef}
              className="min-h-80 w-full min-w-0 rounded-md border bg-background px-3 py-2 font-mono text-sm"
              spellCheck={false}
              autoFocus
              readOnly={pending}
              value={editor}
              onChange={(event) => setEditor(event.target.value)}
            />
          </label>
          <p className="text-sm text-muted-foreground">
            Stored environment values are redacted and preserved when unchanged.
          </p>
          {visibleError ? (
            <p
              role="alert"
              className="text-sm text-destructive [overflow-wrap:anywhere]"
            >
              {visibleError}
            </p>
          ) : null}
          {changed ? (
            <p role="status" className="text-sm">
              Configuration changed. Reload it before saving.
            </p>
          ) : null}
          {servicesRunning && !pending ? (
            <p className="text-sm">
              Stop project services to change their configuration.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11"
              disabled={blocked || changed}
              type="submit"
            >
              Save configuration
            </Button>
            {changed ? (
              <ConfirmButton
                trigger={
                  <Button
                    type="button"
                    className="min-h-11"
                    variant="outline"
                    disabled={pending}
                  >
                    Reload configuration
                  </Button>
                }
                title="Reload configuration?"
                description="Your unsaved changes will be discarded."
                actionLabel="Reload configuration"
                destructive={false}
                onConfirm={async () => {
                  const latest = await onReload();
                  reloaded.current = true;
                  open(latest);
                }}
                onCloseAutoFocus={(event) => {
                  if (!reloaded.current) return;
                  event.preventDefault();
                  editorRef.current?.focus();
                  reloaded.current = false;
                }}
              />
            ) : null}
            <Button
              className="min-h-11"
              variant="outline"
              disabled={pending}
              onClick={close}
              type="button"
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
