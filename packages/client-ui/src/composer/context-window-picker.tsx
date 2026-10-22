import { useEffect, useState } from "react";
import {
  contextWindowCapabilities,
  type ContextWindow,
} from "@machdoch/fleet-protocol/context-window";

export function ContextWindowPicker({
  provider,
  model,
  value,
  onChange,
  capabilities,
  inheritLabel = "Workspace default",
}: {
  provider: string | undefined;
  model: string | undefined;
  value: ContextWindow | undefined;
  onChange: (value: ContextWindow | undefined) => void;
  capabilities?: {
    contextWindowTokens?: number | null;
    longContextWindowTokens?: number | null;
  };
  inheritLabel?: string;
}): React.ReactElement | null {
  const supported = contextWindowCapabilities(provider, model, capabilities);
  const [tokens, setTokens] = useState(
    typeof value === "number" ? String(value) : "",
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTokens(typeof value === "number" ? String(value) : "");
    setError(null);
  }, [value, provider, model]);
  if (!supported.long && !supported.numericMaximum) return null;
  const selection = typeof value === "number" ? "custom" : (value ?? "inherit");
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-2">
        Context size
        <select
          aria-label="Context size"
          className="rounded-md border border-current/20 bg-transparent px-2 py-1.5"
          value={selection}
          onChange={(event) => {
            const selected = event.target.value;
            setError(null);
            onChange(
              selected === "inherit"
                ? undefined
                : selected === "custom"
                  ? supported.numericMaximum!
                  : (selected as ContextWindow),
            );
          }}
        >
          <option value="inherit">{inheritLabel}</option>
          <option value="default">Provider default</option>
          {supported.long && (
            <option value="long">
              {(
                capabilities?.longContextWindowTokens ?? 1_000_000
              ).toLocaleString()}{" "}
              tokens
            </option>
          )}
          {supported.numericMaximum && <option value="custom">Custom</option>}
        </select>
      </label>
      {selection === "custom" && supported.numericMaximum && (
        <input
          aria-label="Context size tokens"
          aria-invalid={Boolean(error)}
          className="w-32 rounded-md border border-current/20 bg-transparent px-2 py-1.5"
          type="number"
          min={1}
          max={supported.numericMaximum}
          step={1}
          value={tokens}
          onChange={(event) => {
            setTokens(event.target.value);
            setError(null);
          }}
          onBlur={(event) => {
            if (
              event.target.validity.valid &&
              Number.isInteger(Number(tokens)) &&
              Number(tokens) > 0
            ) {
              setError(null);
              onChange(Number(tokens));
            } else
              setError(
                `Enter a whole number from 1 to ${supported.numericMaximum!.toLocaleString()}.`,
              );
          }}
        />
      )}
      {error ? (
        <span role="alert" className="text-red-500">
          {error}
        </span>
      ) : null}
    </div>
  );
}
