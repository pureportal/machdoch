import { useId, type JSX } from "react";
import { Textarea } from "@machdoch/media-studio/tauri/ui/components/ui/textarea.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";
import type { McpServerEditor } from "./use-mcp-server-editor";

export const McpConfigJsonEditor = ({
  editor,
  className,
}: {
  editor: McpServerEditor;
  className?: string;
}): JSX.Element => {
  const errorId = useId();
  const { setup, parsed } = editor;

  return (
    <div className={cn("grid min-h-0 gap-2", className)}>
      {parsed.error ? (
        <p
          id={errorId}
          role="alert"
          className="rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
        >
          {parsed.error}
        </p>
      ) : null}
      <Textarea
        aria-label="MCP configuration JSON"
        aria-invalid={parsed.error ? true : undefined}
        aria-describedby={parsed.error ? errorId : undefined}
        value={setup.draft}
        disabled={setup.loading || setup.saving}
        spellCheck={false}
        onChange={(event) => setup.onDraftChange(event.target.value)}
        className="min-h-[24rem] flex-1 resize-y rounded-lg border-slate-800 bg-slate-950 font-mono text-xs leading-5 text-slate-200"
      />
    </div>
  );
};
