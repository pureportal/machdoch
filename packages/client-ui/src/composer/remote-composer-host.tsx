import { useEffect, useRef, useState } from "react";
import type {
  FleetOperationTransport,
  RemoteComposerProps,
} from "@machdoch/product-ui";
import { useRemoteFilePreview } from "../file-preview/use-remote-file-preview";
import type { FleetMediaTransport } from "@machdoch/media-studio/fleet-transport.js";
import type { WorkspaceDirectoryPage } from "@machdoch/fleet-protocol/workspace-contract";
import {
  RemoteAttachmentDialog,
  type AttachmentActivity,
} from "./remote-attachment-dialog";
import { RemoteComposer } from "./remote-composer";
import { LiveVoiceControl } from "../voice/live-voice-control";
import { useRemoteComposerHistory } from "./use-remote-composer-history";
import { RemoteContextPackPicker } from "../context-packs/remote-picker";
import type {
  AttachmentSelectionKind,
  ChatSessionContextAttachment,
} from "./model";

interface Selection {
  kind: AttachmentSelectionKind;
  sessionId: string;
  workspace: string | null;
  messageId?: string;
}

export interface RemoteComposerHostProps extends RemoteComposerProps {
  workspaceTransport: FleetOperationTransport;
  ralphTransport: FleetOperationTransport;
  mediaTransport: FleetMediaTransport;
}

export function RemoteComposerHost(
  source: RemoteComposerHostProps,
): React.ReactElement {
  const history = useRemoteComposerHistory(source);
  const props = {
    ...source,
    composer: history.composer,
    onCommand: history.execute,
  };
  const { session, workspaceTransport, mediaTransport, onCommand } = props;
  const [selection, setSelection] = useState<Selection | null>(null);
  const [liveVoiceActive, setLiveVoiceActive] = useState(false);
  const [directory, setDirectory] = useState<WorkspaceDirectoryPage | null>(
    null,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [activity, setActivity] = useState<AttachmentActivity>(null);
  const [browsing, setBrowsing] = useState(false);
  const busy = activity !== null;
  const [error, setError] = useState<string | null>(null);
  const filePreview = useRemoteFilePreview({
    sessionId: session.id,
    workspace: session.workspace,
    workspaceTransport,
    mediaTransport,
  });
  const requestVersion = useRef(0);
  useEffect(() => {
    requestVersion.current++;
    setSelection(null);
    setDirectory(null);
    setSelected([]);
    setError(null);
    setActivity(null);
    setBrowsing(false);
  }, [session.id, session.workspace]);

  const report = (reason: unknown): void =>
    setError(reason instanceof Error ? reason.message : String(reason));
  const attach = async (target: Selection, paths: string[]): Promise<void> => {
    if (!paths.length) return;
    const succeeded = await onCommand({
      kind: "add-context-attachments",
      sessionId: target.sessionId,
      paths,
      ...(target.messageId ? { messageId: target.messageId } : {}),
    });
    if (!succeeded)
      throw new Error("The attachments could not be added. Try again.");
  };
  const upload = async (files: File[], messageId?: string): Promise<void> => {
    if (!files.length) return;
    const version = ++requestVersion.current;
    const target: Selection = {
      sessionId: session.id,
      workspace: session.workspace ?? null,
      kind: "files",
      ...(messageId ? { messageId } : {}),
    };
    setError(null);
    setActivity("upload");
    try {
      for (const file of files) {
        const transferPath = await mediaTransport.upload(file, file.name);
        try {
          const imported = await workspaceTransport.invoke<{ path: string }>(
            "import_context_attachment",
            { path: transferPath, name: file.name },
          );
          await attach(target, [imported.path]);
        } finally {
          await mediaTransport.release(transferPath);
        }
      }
      if (version === requestVersion.current) setSelection(null);
    } catch (reason) {
      if (version === requestVersion.current) report(reason);
    } finally {
      if (version === requestVersion.current) setActivity(null);
    }
  };
  const browse = async (
    target: Selection,
    relativePath = ".",
    offset = 0,
  ): Promise<void> => {
    if (!target.workspace) {
      setError("Choose a workspace before browsing files.");
      return;
    }
    const version = ++requestVersion.current;
    setActivity("browse");
    setBrowsing(true);
    setError(null);
    try {
      const page = await workspaceTransport.invoke<WorkspaceDirectoryPage>(
        "list_workspace_directory",
        {
          workspaceRoot: target.workspace,
          relativePath: relativePath || ".",
          offset,
        },
      );
      if (version === requestVersion.current)
        setDirectory((current) =>
          offset && current?.path === page.path
            ? { ...page, entries: [...current.entries, ...page.entries] }
            : page,
        );
    } catch (reason) {
      if (version === requestVersion.current) report(reason);
    } finally {
      if (version === requestVersion.current) setActivity(null);
    }
  };
  const select = async (
    kind: AttachmentSelectionKind,
    messageId?: string,
  ): Promise<void> => {
    const target: Selection = {
      kind,
      sessionId: session.id,
      workspace: session.workspace ?? null,
      ...(messageId ? { messageId } : {}),
    };
    setSelection(target);
    setBrowsing(kind === "folders");
    setDirectory(null);
    setSelected([]);
    setError(null);
    if (kind === "folders") await browse(target);
  };
  const open = (attachment: ChatSessionContextAttachment): void => {
    if (
      attachment.source === "path" &&
      /^(?:https?:|mailto:|ftp:)/iu.test(attachment.path)
    ) {
      window.open(attachment.path, "_blank", "noopener,noreferrer");
      return;
    }
    if (attachment.source === "path" && attachment.kind === "directory") {
      const target: Selection = {
        kind: "folders",
        sessionId: session.id,
        workspace: session.workspace ?? null,
      };
      setSelection(target);
      setBrowsing(true);
      setDirectory(null);
      setSelected([]);
      setError(null);
      const workspace = target.workspace?.replace(/[\\/]+$/u, "");
      const relative =
        workspace &&
        attachment.path
          .replaceAll("\\", "/")
          .toLowerCase()
          .startsWith(`${workspace.replaceAll("\\", "/").toLowerCase()}/`)
          ? attachment.path.slice(workspace.length + 1).replaceAll("\\", "/")
          : ".";
      void browse(target, relative);
      return;
    }
    filePreview.open(attachment);
  };
  const selectedPaths = selected.map(
    (relative) => `${selection?.workspace?.replace(/[\\/]$/u, "")}/${relative}`,
  );

  return (
    <>
      {session.workspace && session.specialKind !== "pose" ? <LiveVoiceControl
        key={session.id}
        identity={session.id}
        workspaceRoot={session.workspace}
        disabled={props.pending}
        onActiveChange={setLiveVoiceActive}
        browserReply={props.latestReply ?? null}
        invoke={(input) => workspaceTransport.invoke("run_live_voice_command", { workspaceRoot: session.workspace, input })}
        onSpeechStart={() => { if (props.voice?.speakingMessageId) void onCommand({ kind: "stop-speaking" }); }}
        onTranscript={async (prompt) => {
          const sent = await onCommand({ kind: "submit-message", sessionId: session.id, prompt, promptEnhancementMode: "off", interviewEnabled: false, runningAction: "stop-and-send" });
          if (!sent) throw new Error("The voice message could not be sent. Retry the text below.");
        }}
      /> : null}
      <RemoteComposer
        liveVoiceActive={liveVoiceActive}
        {...props}
        onHistoryKeyDown={history.handleKeyDown}
        pending={props.pending || busy}
        attachments={{ select, upload, open }}
        renderContextPackPicker={(activeDraft) => (
          <RemoteContextPackPicker
            key={session.id}
            {...props}
            activeDraft={activeDraft}
            pending={props.pending || busy}
          />
        )}
      />
      {error && !selection ? (
        <p role="alert" className="m-product-inline-error">
          {error}
        </p>
      ) : null}
      {selection ? (
        <RemoteAttachmentDialog
          kind={selection.kind}
          workspace={selection.workspace}
          browsing={browsing}
          directory={directory}
          selected={selected}
          activity={activity}
          error={error}
          onClose={() => {
            requestVersion.current++;
            setSelection(null);
          }}
          onBack={() => {
            setBrowsing(false);
            setDirectory(null);
            setSelected([]);
            setError(null);
          }}
          onBrowse={(path, offset) => void browse(selection, path, offset)}
          onUpload={(files) => void upload(files, selection.messageId)}
          onSelect={(path, checked) =>
            setSelected((current) =>
              checked
                ? [...current, path]
                : current.filter((item) => item !== path),
            )
          }
          onAttach={() => {
            const version = ++requestVersion.current;
            setActivity("attach");
            setError(null);
            void attach(selection, selectedPaths)
              .then(() => {
                if (version === requestVersion.current) setSelection(null);
              })
              .catch((reason: unknown) => {
                if (version === requestVersion.current) report(reason);
              })
              .finally(() => {
                if (version === requestVersion.current) setActivity(null);
              });
          }}
        />
      ) : null}
      {filePreview.error ? (
        <p role="alert" className="m-product-inline-error">
          {filePreview.error}
        </p>
      ) : null}
      {filePreview.dialog}
    </>
  );
}
