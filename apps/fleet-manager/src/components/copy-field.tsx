"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function CopyField({
  label,
  value,
  monospace = false,
}: {
  label: string;
  value: string;
  monospace?: boolean;
}): React.ReactElement {
  const id = useId();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setCopied(false);
    setError("");
  }, [value]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={value}
          readOnly
          className={monospace ? "font-mono text-xs" : undefined}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() => {
            setError("");
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(value))
              .then(() => setCopied(true))
              .catch(() => setError("Copy failed. Select and copy the value."));
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
      <span role="status" className="sr-only">
        {copied ? `${label} copied.` : ""}
      </span>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
