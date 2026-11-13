"use client";

import { ImageUp, Trash2 } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { BrandTheme } from "@/lib/organization-brand";
import { brandLogoTypes, rasterizeBrandLogo } from "./brand-logo-image";

export function BrandLogoField({
  label,
  theme,
  logo,
  onChange,
}: {
  label: string;
  theme: BrandTheme;
  logo: string | null;
  onChange: (logo: string | null) => void;
}) {
  const labelId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const accept = (file: File | undefined) => {
    if (!file) return;
    setProcessing(true);
    setError("");
    void rasterizeBrandLogo(file)
      .then(onChange)
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : "Upload failed."),
      )
      .finally(() => setProcessing(false));
  };
  return (
    <div className="grid gap-2" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="text-xs text-muted-foreground">
        {label}
      </span>
      <div
        className="cloud-brand-dropzone"
        data-dragging={dragging ? "" : undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(event.dataTransfer.files[0]);
        }}
      >
        <span className="cloud-brand-dropzone-preview" data-logo-theme={theme}>
          {logo ? <img src={logo} alt={label} /> : <ImageUp size={20} />}
        </span>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={processing}
            onClick={() => input.current?.click()}
          >
            {processing
              ? "Processing…"
              : logo
                ? "Replace image"
                : "Upload image"}
          </Button>
          {logo && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Remove ${label} image`}
              onClick={() => onChange(null)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
        <input
          ref={input}
          type="file"
          hidden
          aria-label={`${label} image`}
          accept={brandLogoTypes.join(",")}
          onChange={(event) => {
            accept(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
