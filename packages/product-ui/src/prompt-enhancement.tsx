import { LoaderCircle, WandSparkles, X } from "lucide-react";

export function PromptEnhancementIndicator({
  className,
  onCancel,
}: {
  className?: string;
  onCancel?: () => void;
}): React.ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
      className={["m-prompt-enhancement", className].filter(Boolean).join(" ")}
    >
      <span className="m-prompt-enhancement-icon" aria-hidden="true">
        <WandSparkles />
      </span>
      <span className="m-prompt-enhancement-label">Enhancing prompt</span>
      <LoaderCircle
        className="m-prompt-enhancement-spinner"
        aria-hidden="true"
      />
      {onCancel ? (
        <button
          type="button"
          className="m-prompt-enhancement-cancel"
          aria-label="Cancel enhancement"
          title="Cancel enhancement"
          onClick={onCancel}
        >
          <X aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
