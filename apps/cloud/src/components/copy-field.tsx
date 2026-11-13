"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

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
    <div className="grid min-w-0 gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex h-9 min-w-0 items-center overflow-hidden rounded-md border border-input bg-card focus-within:border-primary focus-within:ring-3 focus-within:ring-ring/15">
        <Input
          id={id}
          value={value}
          readOnly
          className={`h-full border-0 bg-transparent shadow-none focus-visible:ring-0 ${monospace ? "font-mono text-xs sm:text-xs" : ""}`}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Copy ${label.toLowerCase()}`}
          className="mr-0.5 size-8 rounded-sm text-muted-foreground"
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
