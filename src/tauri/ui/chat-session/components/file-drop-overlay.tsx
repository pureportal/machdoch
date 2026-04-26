import { Paperclip } from "lucide-react";
import type { JSX } from "react";
import { cn } from "../../lib/utils";

export interface FileDropOverlayProps {
  active: boolean;
  label: string;
  compact?: boolean;
}

export const FileDropOverlay = ({
  active,
  label,
  compact = false,
}: FileDropOverlayProps): JSX.Element | null => {
  if (!active) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-slate-950/72 backdrop-blur-sm">
      <div
        className={cn(
          "flex items-center gap-3 rounded-[1.35rem] border border-sky-400/35 bg-slate-950/95 text-sky-100 shadow-[0_24px_80px_rgba(14,165,233,0.18)]",
          compact ? "px-4 py-3 text-sm" : "px-5 py-4 text-base",
        )}
      >
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-sky-400/10">
          <Paperclip className="h-5 w-5" />
        </span>
        <span className="font-semibold">{label}</span>
      </div>
    </div>
  );
};
