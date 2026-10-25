import { useId, useState } from "react";
import {
  CONTEXT_WINDOW_LABELS,
  contextWindowSchema,
  contextWindowTokens,
  type ContextWindow,
  type ContextWindowCapabilities,
} from "@machdoch/fleet-protocol/context-window";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { DialogClose } from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";

export function ContextWindowForm({
  supported,
  value,
  inheritedValue,
  inheritLabel,
  onApply,
}: {
  supported: ContextWindowCapabilities;
  value: ContextWindow | undefined;
  inheritedValue: ContextWindow;
  inheritLabel: string;
  onApply: (value: ContextWindow | undefined) => void;
}): React.ReactElement {
  const id = useId();
  const [selection, setSelection] = useState<ContextWindow | "inherit">(
    value ?? "inherit",
  );
  const options = [
    {
      value: "inherit" as const,
      label: inheritLabel,
      tokens: contextWindowTokens(inheritedValue, supported),
    },
    ...contextWindowSchema.options.map((mode) => ({
      value: mode,
      label: CONTEXT_WINDOW_LABELS[mode],
      tokens: contextWindowTokens(mode, supported),
    })),
  ];

  return (
    <form
      className="app-context-window-form"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onApply(selection === "inherit" ? undefined : selection);
      }}
    >
      <div className="app-context-window-fields">
        <fieldset className="app-context-window-options">
          <legend className="sr-only">Context size</legend>
          {options.map((option) => (
            <label key={option.value} className="app-context-window-option">
              <input
                type="radio"
                name={`${id}-mode`}
                value={option.value}
                checked={selection === option.value}
                onChange={() => setSelection(option.value)}
              />
              <span>{option.label}</span>
              {option.tokens !== null && (
                <span className="app-context-window-token-count">
                  {option.tokens.toLocaleString()} tokens
                </span>
              )}
            </label>
          ))}
        </fieldset>
      </div>
      <div className="app-context-window-actions">
        <DialogClose asChild>
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit">Apply</Button>
      </div>
    </form>
  );
}
