"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { encode } from "uqr";
import { Button } from "@/components/ui/button";
import type { AuthenticatorSetup } from "@/lib/cloud-two-factor-contract";

export function AuthenticatorQr({ setup }: { setup: AuthenticatorSetup }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const modules = encode(setup.uri, { ecc: "M", border: 4 }).data;
  const path = modules
    .flatMap((row, y) =>
      row.flatMap((dark, x) => (dark ? [`M${x} ${y}h1v1h-1z`] : [])),
    )
    .join("");
  return (
    <div className="cloud-authenticator">
      <svg
        role="img"
        aria-label="QR code"
        viewBox={`0 0 ${modules.length} ${modules.length}`}
        shapeRendering="crispEdges"
      >
        <rect width={modules.length} height={modules.length} fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
      <div className="grid gap-2">
        <span id="setup-key-label" className="text-sm font-medium">
          Setup key
        </span>
        <div className="flex min-w-0 items-center gap-1 rounded-xl border border-input bg-card py-1 pr-0.5 pl-3">
          <code
            aria-labelledby="setup-key-label"
            className="min-w-0 flex-1 font-mono text-[13px] tracking-wide break-words select-all"
          >
            {setup.secret.match(/.{1,4}/g)!.join(" ")}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-lg text-muted-foreground"
            aria-label="Copy setup key"
            onClick={() => {
              setError("");
              void Promise.resolve()
                .then(() => navigator.clipboard.writeText(setup.secret))
                .then(() => setCopied(true))
                .catch(() => setError("Copy failed. Select and copy the key."));
            }}
          >
            {copied ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
          </Button>
        </div>
        <span role="status" className="sr-only">
          {copied ? "Setup key copied." : ""}
        </span>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
