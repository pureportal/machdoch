"use client";

import { Check, Copy, Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function RecoveryCodeList({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const text = `${codes.join("\n")}\n`;
  return (
    <div className="grid gap-3">
      <ol className="cloud-recovery-codes" aria-label="Recovery codes">
        {codes.map((code) => (
          <li key={code}>{code}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setError("");
            void Promise.resolve()
              .then(() => navigator.clipboard.writeText(text))
              .then(() => setCopied(true))
              .catch(() => setError("Copy failed. Select and copy the codes."));
          }}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          Copy
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            const link = document.createElement("a");
            const url = URL.createObjectURL(
              new Blob([text], { type: "text/plain" }),
            );
            link.href = url;
            link.download = "machdoch-cloud-recovery-codes.txt";
            document.body.append(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
          }}
        >
          <Download aria-hidden="true" />
          Download
        </Button>
      </div>
      <span role="status" className="sr-only">
        {copied ? "Recovery codes copied." : ""}
      </span>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
