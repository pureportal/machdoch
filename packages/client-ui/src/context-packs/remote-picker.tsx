import { useCallback, useEffect, useState } from "react";
import {
  contextPackDocumentsSchema,
  contextPackExportSchema,
} from "@machdoch/fleet-protocol/context-pack-contract";
import { modelProviderSchema } from "@machdoch/fleet-protocol/runtime-options";
import type { ProductCommand } from "@machdoch/fleet-protocol";
import type {
  FleetOperationTransport,
  RemoteComposerProps,
} from "@machdoch/product-ui";
import type { FleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import { SmartContextPackPicker } from "./picker";
import {
  createSmartContextPackExportPayload,
  filterSmartContextPacksByScope,
} from "./helpers";
import { loadRalphContextPackUsage } from "./ralph-usage";
import type { SmartContextPack, SmartContextPackScopeFilter } from "./model";
import { toContextAttachment } from "../composer/remote-attachments";

export interface RemoteContextPackPickerProps extends RemoteComposerProps {
  activeDraft: string;
  workspaceTransport: FleetOperationTransport;
  ralphTransport: FleetOperationTransport;
  mediaTransport: FleetMediaTransport;
}

export function RemoteContextPackPicker({
  session,
  composer,
  contextPacks,
  drafts,
  activeDraft,
  pending,
  workspaceTransport,
  ralphTransport,
  mediaTransport,
  onCommand,
}: RemoteContextPackPickerProps): React.ReactElement {
  const [packs, setPacks] = useState<SmartContextPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const revision = JSON.stringify(contextPacks);
  const provider = modelProviderSchema.safeParse(composer.provider);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    void workspaceTransport
      .invoke<unknown>("get_context_pack_documents", { sessionId: session.id })
      .then((result) => {
        const documents = contextPackDocumentsSchema.parse(result);
        if (current) setPacks(documents);
      })
      .catch((reason: unknown) => {
        if (current)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [workspaceTransport, session.id, session.workspace, revision, reload]);

  const loadUsage = useCallback(
    (workspaceRoot: string) =>
      loadRalphContextPackUsage(
        workspaceRoot,
        (root) =>
          ralphTransport.invoke("run_ralph_command", {
            request: { workspaceRoot: root, arguments: ["list"] },
          }),
        (root, flowId) =>
          ralphTransport.invoke("run_ralph_command", {
            request: { workspaceRoot: root, arguments: ["show", flowId] },
          }),
      ),
    [ralphTransport],
  );

  const execute = async (command: ProductCommand): Promise<void> => {
    if (pending || loading || error)
      throw new Error(
        "Wait for context packs to finish loading, then try again.",
      );
    const entry = drafts.sessions.get(session.id);
    const draftRevision = entry?.revision;
    if (command.kind === "apply-context-pack") {
      await entry?.pending;
      if (
        drafts.sessions.get(session.id) !== entry ||
        entry?.revision !== draftRevision
      )
        throw new Error("The draft changed. Apply the context pack again.");
    }
    if (!(await onCommand(command)))
      throw new Error("The context-pack change failed. Try again.");
    if (
      command.kind === "apply-context-pack" &&
      drafts.sessions.get(session.id) === entry &&
      entry?.revision === draftRevision
    ) {
      drafts.sessions.delete(session.id);
      drafts.changed();
    }
    setReload((value) => value + 1);
  };

  const exportPacks = (scope: SmartContextPackScopeFilter): void => {
    const payload = createSmartContextPackExportPayload(
      filterSmartContextPacksByScope(packs, scope),
    );
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `machdoch-context-packs-${scope}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  if (!provider.success)
    return (
      <span role="alert" className="m-product-inline-error">
        Choose a configured model to use context packs.
      </span>
    );

  return (
    <>
      <SmartContextPackPicker
        disabled={pending || loading || error !== null}
        loadRalphPackUsage={loadUsage}
        contextPacks={packs}
        workspaceRoot={session.workspace ?? null}
        workspaceLabel={
          session.workspace?.split(/[\\/]/u).filter(Boolean).pop() ??
          "Workspace"
        }
        activeDraft={activeDraft}
        activeProvider={provider.data}
        activeModel={composer.model}
        activeRunMode={composer.mode}
        activeReasoning={composer.reasoning}
        activePromptEnhancementMode={composer.promptEnhancementMode}
        activeInterviewEnabled={composer.interviewEnabled}
        activeSessionMemoryEnabled={composer.sessionMemoryEnabled}
        activeUseGlobalMemory={composer.globalMemoryEnabled}
        activeUiControlEnabled={composer.uiControlEnabled}
        contextAttachments={composer.attachments.map(toContextAttachment)}
        matchedContextPackIds={composer.matchedContextPackIds}
        imageInputSupported={composer.imageInputSupported === true}
        onSaveContextPack={(contextPack) =>
          execute({
            kind: "save-context-pack",
            sessionId: session.id,
            contextPack,
          })
        }
        onApplyContextPack={(contextPackId, variableValues) =>
          execute({
            kind: "apply-context-pack",
            sessionId: session.id,
            contextPackId,
            ...(variableValues ? { variableValues } : {}),
          })
        }
        onDeleteContextPack={(contextPackId) =>
          execute({ kind: "delete-context-pack", contextPackId })
        }
        onExportContextPacks={exportPacks}
        onImportContextPacks={async (file, scope) => {
          if (file.size > 64 * 1024 * 1024)
            throw new Error(
              "The context-pack file exceeds the 64 MiB import limit.",
            );
          let payload: unknown;
          try {
            payload = JSON.parse(await file.text());
          } catch {
            throw new Error(
              "The context-pack file is not valid JSON. Choose a Machdoch export.",
            );
          }
          if (!contextPackExportSchema.safeParse(payload).success)
            throw new Error(
              "The context-pack file is invalid. Choose a Machdoch export.",
            );
          const path = await mediaTransport.upload(file, file.name);
          try {
            await execute({
              kind: "import-context-packs",
              sessionId: session.id,
              scope,
              paths: [path],
            });
          } finally {
            await mediaTransport.release(path);
          }
        }}
      />
      {error ? (
        <span role="alert" className="m-product-inline-error">
          {error}{" "}
          <button type="button" onClick={() => setReload((value) => value + 1)}>
            Retry
          </button>
        </span>
      ) : null}
    </>
  );
}
