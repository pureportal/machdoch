import { CornerUpLeft } from "lucide-react";
import type { JSX } from "react";

export const MessageReferenceLink = ({
  title,
  onOpen,
}: {
  title: string;
  onOpen: () => void;
}): JSX.Element => (
  <button
    type="button"
    aria-label={`Open original message in ${title}`}
    title={title}
    onClick={onOpen}
    className="app-message-reference inline-flex h-6 max-w-[88%] min-w-0 items-center gap-1 rounded-full border border-slate-800 bg-slate-950/70 px-2 text-[11px] text-slate-400 transition-colors hover:border-slate-700 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/40"
  >
    <CornerUpLeft aria-hidden="true" className="size-3 shrink-0 text-sky-300" />
    <span className="truncate">{title}</span>
  </button>
);
