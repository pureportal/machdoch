import { useId, useState, type CSSProperties } from "react";
import type {
  ContextWindow,
  ContextWindowCapabilities,
} from "@machdoch/fleet-protocol/context-window";
import { Button } from "@machdoch/media-studio/tauri/ui/components/ui/button.js";
import { DialogClose } from "@machdoch/media-studio/tauri/ui/components/ui/dialog.js";

type Selection = "inherit" | "default" | "highest" | "custom";

export function ContextWindowForm({
  supported,
  value,
  inheritLabel,
  onApply,
}: {
  supported: Exclude<ContextWindowCapabilities, { kind: "fixed" }>;
  value: ContextWindow | undefined;
  inheritLabel: string;
  onApply: (value: ContextWindow | undefined) => void;
}): React.ReactElement {
  const id = useId();
  const range = supported.kind === "range" ? supported : null;
  const highest = supported.kind === "range" ? supported.maximum : "long";
  const highestTokens =
    supported.kind === "range" ? supported.maximum : supported.longTokens;
  const [selection, setSelection] = useState<Selection>(
    value === undefined
      ? "inherit"
      : value === highest
        ? "highest"
        : typeof value === "number" && range
          ? "custom"
          : "default",
  );
  const [tokens, setTokens] = useState(
    String(
      typeof value === "number"
        ? value
        : (supported.defaultTokens ?? highestTokens),
    ),
  );
  const tokenCount = Number(tokens);
  const valid =
    range !== null &&
    tokens.trim() !== "" &&
    Number.isSafeInteger(tokenCount) &&
    tokenCount >= range.minimum &&
    tokenCount <= range.maximum;
  const error =
    selection === "custom" && !valid && range
      ? `Enter a whole number from ${range.minimum.toLocaleString()} to ${range.maximum.toLocaleString()}.`
      : null;
  const sliderValue = valid ? tokenCount : (range?.minimum ?? 1);
  const options: { value: Selection; label: string; tokens?: number | null }[] =
    [
      { value: "inherit", label: inheritLabel },
      {
        value: "default",
        label: "Provider default",
        tokens: supported.defaultTokens,
      },
      { value: "highest", label: "Highest", tokens: highestTokens },
      ...(range ? [{ value: "custom" as const, label: "Custom" }] : []),
    ];

  return (
    <form
      className="app-context-window-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (error) return;
        onApply(
          selection === "inherit"
            ? undefined
            : selection === "highest"
              ? highest
              : selection === "custom"
                ? tokenCount
                : "default",
        );
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
              {option.tokens != null && (
                <span className="app-context-window-token-count">
                  {option.tokens.toLocaleString()} tokens
                </span>
              )}
            </label>
          ))}
        </fieldset>
        {selection === "custom" && range && (
          <div className="app-context-window-custom">
            <div className="app-context-window-input-row">
              <label htmlFor={`${id}-tokens`}>Tokens</label>
              <input
                id={`${id}-tokens`}
                type="number"
                inputMode="numeric"
                min={range.minimum}
                max={range.maximum}
                step={range.step}
                value={tokens}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? `${id}-error` : undefined}
                onChange={(event) => setTokens(event.target.value)}
              />
            </div>
            <input
              className="app-context-window-slider"
              type="range"
              aria-label="Context size tokens"
              aria-valuetext={`${sliderValue.toLocaleString()} tokens`}
              min={range.minimum}
              max={range.maximum}
              step={range.step}
              value={sliderValue}
              style={
                {
                  "--context-progress": `${(100 * (sliderValue - range.minimum)) / Math.max(1, range.maximum - range.minimum)}%`,
                } as CSSProperties
              }
              onChange={(event) => setTokens(event.target.value)}
            />
            <div className="app-context-window-range" aria-hidden="true">
              <span>{range.minimum.toLocaleString()}</span>
              <span>{range.maximum.toLocaleString()}</span>
            </div>
            {error && (
              <p
                id={`${id}-error`}
                role="alert"
                className="app-context-window-error"
              >
                {error}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="app-context-window-actions">
        <DialogClose asChild>
          <Button type="button" variant="ghost">
            Cancel
          </Button>
        </DialogClose>
        <Button type="submit" disabled={Boolean(error)}>
          Apply
        </Button>
      </div>
    </form>
  );
}
