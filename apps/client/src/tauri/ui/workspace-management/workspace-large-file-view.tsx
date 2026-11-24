import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { useEffect, useRef, useState, type JSX } from "react";
import { formatWorkspaceFileSize } from "./workspace-tools-model";
import { readWorkspaceFileRange } from "./workspace-tools-runtime";

const CHUNK_BYTES = 1024 * 1024;
const MAX_STREAMED_BYTES = 64 * 1024 * 1024;

export const WorkspaceLargeFileView = ({
  workspaceRoot,
  path,
}: {
  workspaceRoot: string;
  path: string;
}): JSX.Element => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState<{
    loaded: number;
    total: number;
    done: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "",
        extensions: [
          lineNumbers(),
          oneDark,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.theme({ "&": { height: "100%" } }),
        ],
      }),
    });
    let active = true;
    const stream = async (): Promise<void> => {
      let offset = 0;
      for (;;) {
        const range = await readWorkspaceFileRange(
          workspaceRoot,
          path,
          offset,
          CHUNK_BYTES,
        );
        if (!active) return;
        view.dispatch({
          changes: { from: view.state.doc.length, insert: range.text },
        });
        offset += range.bytesRead;
        const done =
          range.done || range.bytesRead === 0 || offset >= MAX_STREAMED_BYTES;
        setProgress({ loaded: offset, total: range.totalBytes, done });
        if (done) return;
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }
    };
    setError(null);
    setProgress(null);
    void stream().catch((streamError: unknown) => {
      if (active) {
        setError(
          streamError instanceof Error
            ? streamError.message
            : String(streamError),
        );
      }
    });
    return () => {
      active = false;
      view.destroy();
    };
  }, [path, workspaceRoot]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-slate-800/80 px-3 py-1 text-[11px] text-slate-500">
        {error ? (
          <span role="alert" className="text-red-300">
            {error}
          </span>
        ) : progress ? (
          `Read-only · ${formatWorkspaceFileSize(progress.loaded)} of ${formatWorkspaceFileSize(progress.total)}${progress.done ? "" : "…"}`
        ) : (
          "Read-only"
        )}
      </div>
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden text-[13px]"
      />
    </div>
  );
};
