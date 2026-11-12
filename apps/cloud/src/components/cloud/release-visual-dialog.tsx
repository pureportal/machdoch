"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  visualFormatKeys,
  visualFormats,
  visualTemplates,
  type VisualInput,
} from "@/lib/cloud-release-media-contract";
import { cloudRequest, csrfToken } from "./api-client";
import { mediaUrl } from "./release-display";
import type { StudioContext } from "./release-studio";
import { useToast } from "./toast";

const templateLabels: Record<VisualInput["template"], string> = {
  announcement: "Announcement",
  spotlight: "Feature spotlight",
  highlights: "Highlights",
  quote: "Quote",
};
const previewDelayMs = 450;

export function ReleaseVisualDialog({
  context,
  recipe,
  onClose,
}: {
  context: StudioContext;
  recipe?: VisualInput;
  onClose: () => void;
}) {
  const { release, media } = context;
  const toast = useToast();
  const screenshots = media.filter(
    (entry) => entry.kind === "image" && entry.role !== "visual",
  );
  const [input, setInput] = useState<VisualInput>(() =>
    recipe
      ? {
          ...recipe,
          mediaId: screenshots.some((entry) => entry.id === recipe.mediaId)
            ? recipe.mediaId
            : null,
        }
      : {
          template: "announcement",
          format: "landscape",
          eyebrow: "",
          headline:
            release.name ||
            release.highlights[0]?.title ||
            `${context.product.name} ${release.version}`,
          subline: release.summary,
          items: release.highlights
            .slice(0, 5)
            .map((entry) => entry.title.slice(0, 90)),
          mediaId: screenshots[0]?.id ?? null,
          theme: "brand",
        },
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<VisualInput>) =>
    setInput((current) => ({ ...current, ...patch }));
  const valid =
    input.headline.trim() && (input.template !== "spotlight" || input.mediaId);
  useEffect(() => {
    if (!valid) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      setRendering(true);
      fetch(`/api/v1/releases/${release.id}/visuals/preview`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-machdoch-cloud-csrf": csrfToken(),
        },
        body: JSON.stringify({
          ...input,
          items:
            input.template === "highlights" ? input.items.filter(Boolean) : [],
        }),
        signal: abort.signal,
      })
        .then(async (response) => {
          if (!response.ok)
            throw new Error(
              ((await response.json()) as { error?: string }).error ??
                "Preview failed.",
            );
          const url = URL.createObjectURL(await response.blob());
          setPreview((current) => {
            if (current) URL.revokeObjectURL(current);
            return url;
          });
          setError("");
        })
        .catch((reason: Error) => {
          if (!abort.signal.aborted) setError(reason.message);
        })
        .finally(() => {
          if (!abort.signal.aborted) setRendering(false);
        });
    }, previewDelayMs);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [input, release.id, valid]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const size = visualFormats[input.format];
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="cloud-release-visual-dialog"
        aria-describedby={undefined}
      >
        <DialogTitle>{recipe ? "Edit visual" : "Create visual"}</DialogTitle>
        <div className="cloud-release-visual-layout">
          <div className="cloud-automation-editor">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Template" htmlFor="visual-template">
                <Select
                  id="visual-template"
                  value={input.template}
                  onChange={(event) =>
                    update({
                      template: event.target.value as VisualInput["template"],
                    })
                  }
                >
                  {visualTemplates.map((template) => (
                    <option key={template} value={template}>
                      {templateLabels[template]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Format" htmlFor="visual-format">
                <Select
                  id="visual-format"
                  value={input.format}
                  onChange={(event) =>
                    update({
                      format: event.target.value as VisualInput["format"],
                    })
                  }
                >
                  {visualFormatKeys.map((format) => (
                    <option key={format} value={format}>
                      {visualFormats[format].label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {input.template !== "quote" && (
              <Field label="Label" htmlFor="visual-eyebrow">
                <Input
                  id="visual-eyebrow"
                  value={input.eyebrow}
                  maxLength={60}
                  placeholder={`New in ${release.version}`}
                  onChange={(event) => update({ eyebrow: event.target.value })}
                />
              </Field>
            )}
            <Field
              label={input.template === "quote" ? "Quote" : "Headline"}
              htmlFor="visual-headline"
            >
              <Textarea
                id="visual-headline"
                rows={2}
                value={input.headline}
                maxLength={140}
                onChange={(event) => update({ headline: event.target.value })}
              />
            </Field>
            <Field
              label={input.template === "quote" ? "Attribution" : "Subline"}
              htmlFor="visual-subline"
            >
              <Textarea
                id="visual-subline"
                rows={2}
                value={input.subline}
                maxLength={240}
                onChange={(event) => update({ subline: event.target.value })}
              />
            </Field>
            {input.template === "highlights" && (
              <Field label="Items" htmlFor="visual-items">
                <Textarea
                  id="visual-items"
                  rows={5}
                  value={input.items.join("\n")}
                  onChange={(event) =>
                    update({
                      items: event.target.value
                        .split("\n")
                        .slice(0, 5)
                        .map((line) => line.slice(0, 90)),
                    })
                  }
                />
              </Field>
            )}
            {input.template === "spotlight" && (
              <div className="grid gap-2">
                <span className="text-xs font-medium">Screenshot</span>
                {screenshots.length ? (
                  <div
                    className="cloud-release-picker"
                    role="radiogroup"
                    aria-label="Screenshot"
                  >
                    {screenshots.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        role="radio"
                        aria-checked={input.mediaId === entry.id}
                        aria-label={entry.caption || entry.name}
                        onClick={() => update({ mediaId: entry.id })}
                      >
                        <img src={mediaUrl(entry.id)} alt="" />
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="cloud-automation-muted">
                    Upload or capture a screenshot first.
                  </p>
                )}
              </div>
            )}
            <Field label="Theme" htmlFor="visual-theme">
              <Select
                id="visual-theme"
                value={input.theme}
                onChange={(event) =>
                  update({ theme: event.target.value as VisualInput["theme"] })
                }
              >
                <option value="brand">Brand</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </Select>
            </Field>
          </div>
          <div
            className="cloud-release-preview"
            style={{ aspectRatio: `${size.width} / ${size.height}` }}
            aria-busy={rendering}
          >
            {preview && <img src={preview} alt="Visual preview" />}
            {rendering && (
              <LoaderCircle className="cloud-spin" aria-label="Rendering" />
            )}
            {error && <p role="alert">{error}</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await cloudRequest(`releases/${release.id}/visuals`, {
                  method: "POST",
                  body: {
                    ...input,
                    items:
                      input.template === "highlights"
                        ? input.items.filter(Boolean)
                        : [],
                  },
                });
                await context.refresh();
                toast("Visual added");
                onClose();
              } catch (reason) {
                toast(
                  reason instanceof Error ? reason.message : "Try again.",
                  "error",
                );
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Add to media"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
