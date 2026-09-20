import { ArrowUp } from "lucide-react";
import type { JSX } from "react";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { cn } from "@machdoch/media-studio/tauri/ui/lib/utils.js";

export interface ScrollToTopButtonProps {
  visible: boolean;
  onClick: () => void;
  className?: string;
}

export const ScrollToTopButton = ({
  visible,
  onClick,
  className,
}: ScrollToTopButtonProps): JSX.Element | null => {
  if (!visible) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Scroll to top"
      tooltip="Scroll to top"
      onClick={onClick}
      className={cn(
        "absolute z-20 h-10 w-10 rounded-full border-sky-400/30 bg-slate-950/90 text-sky-100 shadow-lg shadow-slate-950/35 backdrop-blur-xl hover:bg-slate-900 hover:text-white",
        className,
      )}
    >
      <ArrowUp className="h-4 w-4" />
    </Button>
  );
};
