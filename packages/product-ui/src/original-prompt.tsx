import { History } from "lucide-react";
import type { ReactNode } from "react";

export function getOriginalPromptContent(
  visibleContent: string,
  originalContent: string | undefined,
): string | null {
  const original = originalContent?.trim();
  return original && original !== visibleContent.trim() ? original : null;
}

export function OriginalPromptToggle({
  expanded,
  panelId,
  onToggle,
}: {
  expanded: boolean;
  panelId: string;
  onToggle: () => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={expanded ? "Hide original prompt" : "View original prompt"}
      aria-expanded={expanded}
      aria-controls={panelId}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className="app-message-original-prompt-button absolute top-3 right-3 inline-flex h-7 w-7 items-center justify-center rounded-full border border-emerald-500/25 bg-slate-950/55 text-emerald-100 hover:bg-slate-900 hover:text-white"
    >
      <History aria-hidden="true" className="h-3.5 w-3.5" />
    </button>
  );
}

export function OriginalPromptPanel({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}): React.ReactElement {
  return (
    <div
      id={id}
      className="app-original-prompt-panel max-w-[90%] min-w-0 rounded-2xl border border-emerald-500/20 bg-slate-950/80 px-4 py-3 text-sm leading-6 text-slate-300 shadow-lg shadow-slate-950/20 wrap-break-word"
    >
      <div className="mb-2 text-[0.65rem] font-semibold uppercase tracking-[0.14em] text-emerald-200/80">
        Original prompt
      </div>
      {children}
    </div>
  );
}
