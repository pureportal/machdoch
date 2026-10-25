import { useEffect, useState } from "react";
import {
  contextWindowCapabilities,
  contextWindowTokens,
  CONTEXT_WINDOW_LABELS,
  DEFAULT_CONTEXT_WINDOW,
  type ContextWindow,
  type ContextWindowModelCapabilities,
} from "@machdoch/fleet-protocol/context-window";
import { ContextWindowIcon } from "@machdoch/product-ui";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";
import { ContextWindowForm } from "./context-window-form";
import "./context-window-picker.css";

export function ContextWindowPicker({
  provider,
  model,
  value,
  onChange,
  capabilities,
  inheritedValue = DEFAULT_CONTEXT_WINDOW,
  inheritLabel = "Workspace Default",
  presentation = "icon",
}: {
  provider: string | undefined;
  model: string | undefined;
  value: ContextWindow | undefined;
  onChange: (value: ContextWindow | undefined) => void;
  capabilities?: ContextWindowModelCapabilities;
  inheritedValue?: ContextWindow;
  inheritLabel?: string;
  presentation?: "icon" | "field";
}): React.ReactElement {
  const supported = contextWindowCapabilities(provider, model, capabilities);
  const [open, setOpen] = useState(false);
  const disabled = supported.kind === "fixed";
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const tokens = contextWindowTokens(value ?? inheritedValue, supported);
  const current =
    value === undefined ? inheritLabel : CONTEXT_WINDOW_LABELS[value];
  const resultingValue =
    tokens === null ? "" : ` (${tokens.toLocaleString()} tokens)`;
  const label = disabled
    ? "Context size: unavailable for this model"
    : `Context size: ${current}${resultingValue}`;

  return (
    <Dialog open={open && !disabled} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={presentation === "field" ? "default" : "icon-sm"}
          className={
            presentation === "field"
              ? "app-context-window-trigger app-context-window-field"
              : "app-context-window-trigger app-composer-toolbar-icon-button app-composer-toolbar-control rounded-full shadow-none"
          }
          aria-label={label}
          aria-disabled={disabled}
          disabled={disabled}
          data-active={!disabled}
          tooltip={
            disabled
              ? "This provider does not allow changing context size for this model."
              : label
          }
        >
          <ContextWindowIcon mode={value ?? "workspace"} />
          {presentation === "field" && (
            <span>{disabled ? "Unavailable" : current}</span>
          )}
        </Button>
      </DialogTrigger>
      {supported.kind !== "fixed" && (
        <DialogContent
          className="app-context-window-dialog"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            const selected = (
              event.target as HTMLElement
            ).querySelector<HTMLInputElement>('input[type="radio"]:checked');
            if (selected) {
              event.preventDefault();
              selected.focus();
            }
          }}
        >
          <DialogTitle>Context size</DialogTitle>
          <ContextWindowForm
            key={`${provider}:${model}:${JSON.stringify(supported)}:${value}:${inheritedValue}`}
            supported={supported}
            value={value}
            inheritedValue={inheritedValue}
            inheritLabel={inheritLabel}
            onApply={(nextValue) => {
              onChange(nextValue);
              setOpen(false);
            }}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}
