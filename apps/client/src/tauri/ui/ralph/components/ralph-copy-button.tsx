import { Check, Copy } from "lucide-react";
import { useEffect, useState, type JSX } from "react";

import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";

interface RalphCopyButtonProps {
  value: string;
  label: string;
  className?: string;
}

type CopyState = "idle" | "copied" | "failed";

export const RalphCopyButton = ({
  value,
  label,
  className,
}: RalphCopyButtonProps): JSX.Element => {
  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timeout = window.setTimeout(() => setCopyState("idle"), 1_600);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const copyValue = async (): Promise<void> => {
    if (!navigator.clipboard) {
      setCopyState("failed");
      return;
    }

    try {
      await navigator.clipboard.writeText(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  const accessibleLabel =
    copyState === "copied"
      ? `${label} copied`
      : copyState === "failed"
        ? `Copy ${label} failed`
        : `Copy ${label}`;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={accessibleLabel}
      title={accessibleLabel}
      onClick={() => void copyValue()}
      className={cn(
        "h-7 w-7 rounded-md text-slate-500 hover:bg-slate-800 hover:text-white",
        copyState === "copied" && "text-emerald-300",
        copyState === "failed" && "text-rose-300",
        className,
      )}
    >
      {copyState === "copied" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
};
