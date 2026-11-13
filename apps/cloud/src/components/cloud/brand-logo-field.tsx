"use client";

import { ImageUp, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { brandLogoTypes, rasterizeBrandLogo } from "./brand-logo-image";

export function BrandLogoField({
  logo,
  onChange,
}: {
  logo: string | null;
  onChange: (logo: string | null) => void;
}) {
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
    <div className="grid gap-2">
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
        <span className="cloud-brand-dropzone-preview">
          {logo ? <img src={logo} alt="Logo" /> : <ImageUp size={20} />}
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
              aria-label="Remove image"
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
          aria-label="Logo image"
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
