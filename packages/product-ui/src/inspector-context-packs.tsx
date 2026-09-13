import type { ProductShell } from "@machdoch/fleet-protocol";
import { useState } from "react";
import { ProductModal } from "./product-modal";
import type { ProductCommandHandler } from "./product-runtime";

export function InspectorContextPacks({
  shell,
  activeSessionId,
  pending,
  onCommand,
}: {
  shell: ProductShell;
  activeSessionId: string | undefined;
  pending: boolean;
  onCommand: ProductCommandHandler;
}): React.ReactElement {
  const [target, setTarget] = useState<
    ProductShell["contextPacks"][number] | null
  >(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="m-product-card-list">
      {shell.contextPacks.length === 0 ? (
        <p className="m-product-empty-small">No context packs</p>
      ) : null}
      {shell.contextPacks.map((pack) => (
        <article
          key={pack.id}
          className="m-product-card"
          aria-label={pack.name}
        >
          <div className="m-product-card-heading">
            <strong>{pack.name}</strong>
            {pack.scopeLabel ? <span>{pack.scopeLabel}</span> : null}
          </div>
          {pack.instructionsPreview || pack.promptPreview ? (
            <p>{pack.instructionsPreview || pack.promptPreview}</p>
          ) : null}
          <div className="m-product-card-actions">
            {activeSessionId ? (
              <button
                type="button"
                disabled={pending || pack.matched}
                onClick={() =>
                  void onCommand({
                    kind: "apply-context-pack",
                    sessionId: activeSessionId,
                    contextPackId: pack.id,
                  })
                }
              >
                {pack.matched ? "Applied" : "Apply"}
              </button>
            ) : null}
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null);
                setTarget(pack);
              }}
            >
              Delete
            </button>
          </div>
        </article>
      ))}
      {target ? (
        <ProductModal
          title={`Delete ${target.name}?`}
          dismissible={!deleting}
          onClose={() => setTarget(null)}
        >
          {error ? (
            <p role="alert" className="m-product-inline-error">
              {error}
            </p>
          ) : null}
          <div>
            <button
              type="button"
              className="m-product-secondary-button"
              disabled={deleting}
              onClick={() => setTarget(null)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="m-product-secondary-button m-product-danger-button"
              disabled={pending || deleting}
              onClick={() => {
                setDeleting(true);
                setError(null);
                void onCommand({
                  kind: "delete-context-pack",
                  contextPackId: target.id,
                }).then((deleted) => {
                  setDeleting(false);
                  if (deleted) setTarget(null);
                  else
                    setError("Context pack could not be deleted. Try again.");
                });
              }}
            >
              Delete context pack
            </button>
          </div>
        </ProductModal>
      ) : null}
    </div>
  );
}
