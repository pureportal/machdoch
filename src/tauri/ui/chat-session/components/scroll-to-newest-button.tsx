import { ArrowDown } from "lucide-react";
import type { JSX } from "react";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

export interface ScrollToNewestButtonProps {
  visible: boolean;
  onClick: () => void;
  className?: string;
}

export const ScrollToNewestButton = ({
  visible,
  onClick,
  className,
}: ScrollToNewestButtonProps): JSX.Element | null => {
  if (!visible) {
    return null;
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      aria-label="Scroll to newest message"
      title="Scroll to newest message"
      onClick={onClick}
      className={cn(
        "absolute z-20 h-10 w-10 rounded-full border-sky-400/30 bg-slate-950/90 text-sky-100 shadow-lg shadow-slate-950/35 backdrop-blur-xl hover:bg-slate-900 hover:text-white",
        className,
      )}
    >
      <ArrowDown className="h-4 w-4" />
    </Button>
  );
};
